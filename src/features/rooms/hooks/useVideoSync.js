// src/features/rooms/hooks/useVideoSync.js
/**
 * THE SYNC ENGINE (spec §2.1) — the crown jewel.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Infinite-loop prevention (read this before touching anything):
 *
 *   A pauses -> emit -> server -> B's player is paused PROGRAMMATICALLY ->
 *   B's player fires its own onPause -> B emits -> A is paused programmatically
 *   -> A fires onPause -> emits -> ... forever.
 *
 *   The fix is execution gating with a REF, never React state (state updates
 *   are async + batched; the loop fires before the re-render lands):
 *
 *     - `isApplyingRemoteEvent` (useRef<boolean>) is raised before we apply an
 *       incoming sync event to the local player.
 *     - The player's own state-change callback checks the ref FIRST. If set,
 *       the outbound emit is SUPPRESSED — that callback is just the echo of our
 *       own programmatic change.
 *     - The guard is cleared when the player settles into the expected state,
 *       with a hard timeout fallback so we can never get stuck suppressed.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Host-authority model: exactly one peer is host. Only the host emits
 * authoritative SYNC_PLAY / SYNC_PAUSE / SYNC_SEEK. Guest controls are
 * CONTROL_REQUESTs the host applies to its own player; the resulting
 * authoritative event then fans back out. This kills the two-sources-of-truth
 * race class entirely.
 */
'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getSocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import {
  SOCKET_EVENTS,
  PLAYER_STATE,
  SEEK_TOLERANCE_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isValidSyncPayload,
  isValidSeekPayload,
  isValidHeartbeatPayload,
  isValidBufferingPayload,
} from '@/features/rooms/room-types';

/**
 * @param {{ current: import('@/lib/player/createPlayerController').PlayerController|null }} controllerRef
 * @returns {{
 *   onPlayerStateChange: (s:{state:string})=>void,
 *   onPlayerReady: ()=>void,
 *   requestPlay: ()=>void,
 *   requestPause: ()=>void,
 *   requestSeek: (seconds:number)=>void,
 * }}
 */
export function useVideoSync(controllerRef) {
  /* --- the loop-prevention guard (refs ONLY — never state) --- */
  const isApplyingRemoteEvent = useRef(false);
  const pendingRemoteState = useRef(null); // normalized state we expect to settle into
  const guardTimer = useRef(null);

  /* --- misc refs --- */
  const heartbeatTimer = useRef(null);
  const localBufferingEmitted = useRef(false);
  const lastAppliedSeek = useRef(0);

  /** Read live store values without resubscribing this hook. */
  const readStore = () => useRoomStore.getState();

  /**
   * Stable identity (useCallback) so the inbound-listener effect does NOT
   * re-register on every render — it still reads fresh store state on call.
   */
  const amHost = useCallback(() => {
    const s = useRoomStore.getState();
    return !!s.selfId && s.selfId === s.hostId;
  }, []);

  /* ------------------------------------------------------------------ *
   * Guard lifecycle
   * ------------------------------------------------------------------ */

  const clearGuard = useCallback(() => {
    isApplyingRemoteEvent.current = false;
    pendingRemoteState.current = null;
    if (guardTimer.current) {
      clearTimeout(guardTimer.current);
      guardTimer.current = null;
    }
  }, []);

  /**
   * Apply something to the LOCAL player programmatically, with the outbound
   * emit suppressed for the echo that follows.
   * @param {()=>void} fn
   * @param {string|null} expectedState state the player should settle into
   */
  const applyRemote = useCallback((fn, expectedState) => {
    isApplyingRemoteEvent.current = true;
    pendingRemoteState.current = expectedState || null;
    if (guardTimer.current) clearTimeout(guardTimer.current);
    // Fallback: a player backend that never reports the expected state must
    // not strand us in "suppressed" forever.
    guardTimer.current = setTimeout(() => {
      isApplyingRemoteEvent.current = false;
      pendingRemoteState.current = null;
      guardTimer.current = null;
    }, 1200);
    try {
      fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sync] applyRemote failed', err);
      clearGuard();
    }
  }, [clearGuard]);

  /* ------------------------------------------------------------------ *
   * Outbound emit helpers
   * ------------------------------------------------------------------ */

  const emit = useCallback((event, payload) => {
    const socket = getSocket();
    if (socket && socket.connected) socket.emit(event, payload);
  }, []);

  /** Server-corrected "now" in ms (clock-skew aware). Stable identity. */
  const serverNow = useCallback(() => Date.now() + useRoomStore.getState().clockOffset, []);

  /* ------------------------------------------------------------------ *
   * Variance-filtered seek (the ±1.0s tolerance, spec §2.1)
   * ------------------------------------------------------------------ */

  /**
   * Hard-seek the local player ONLY if drift exceeds the tolerance. A hard seek
   * for sub-second drift causes a visible stutter for the slower peer.
   * @param {number} targetTime
   * @param {boolean} keepPlaying whether to resume play after correcting
   */
  const reconcileTime = useCallback((targetTime, keepPlaying) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const local = ctrl.getCurrentTime();
    if (Math.abs(targetTime - local) <= SEEK_TOLERANCE_SECONDS) return; // within tolerance — leave it
    lastAppliedSeek.current = targetTime;
    applyRemote(() => {
      ctrl.seekTo(targetTime);
    }, keepPlaying ? PLAYER_STATE.PLAYING : null);
  }, [applyRemote, controllerRef]);

  /* ------------------------------------------------------------------ *
   * The LOCAL player state-change handler — pass this as the controller's
   * onStateChange. This is where the loop is broken.
   * ------------------------------------------------------------------ */

  const onPlayerStateChange = useCallback(({ state }) => {
    const ctrl = controllerRef.current;
    // Mirror into the store for UI (cheap, selector-scoped).
    readStore().setPlaybackMirror({ state });

    // === GATE === if this state change is the echo of a programmatic apply,
    // suppress the outbound emit entirely.
    if (isApplyingRemoteEvent.current) {
      if (!pendingRemoteState.current || state === pendingRemoteState.current) {
        clearGuard(); // player settled — release the guard
      }
      return;
    }

    // --- genuine, user/network-originated state change ---

    // Buffering coordination (any peer may stall) — spec §3 gap #5.
    if (state === PLAYER_STATE.BUFFERING) {
      if (!localBufferingEmitted.current) {
        localBufferingEmitted.current = true;
        emit(SOCKET_EVENTS.SYNC_BUFFERING, { buffering: true });
      }
    } else if (localBufferingEmitted.current && state === PLAYER_STATE.PLAYING) {
      localBufferingEmitted.current = false;
      emit(SOCKET_EVENTS.SYNC_BUFFERING, { buffering: false });
    }

    const currentTime = ctrl ? ctrl.getCurrentTime() : 0;

    if (amHost()) {
      // Host's own player actions ARE authoritative.
      if (state === PLAYER_STATE.PLAYING) {
        emit(SOCKET_EVENTS.SYNC_PLAY, { state: PLAYER_STATE.PLAYING, currentTime });
      } else if (state === PLAYER_STATE.PAUSED) {
        emit(SOCKET_EVENTS.SYNC_PAUSE, { state: PLAYER_STATE.PAUSED, currentTime });
      }
    }
    // Guests: native player controls are disabled, so a genuine guest-side
    // play/pause should not normally occur here. If it does (edge backend
    // behaviour), we deliberately do NOT emit SYNC — guests are never
    // authoritative. The guest UI routes intent through CONTROL_REQUEST.
  }, [amHost, clearGuard, controllerRef, emit]);

  /* ------------------------------------------------------------------ *
   * Controller-ready: a freshly-mounted player must snap to room state.
   * ------------------------------------------------------------------ */

  const onPlayerReady = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const s = readStore();
    // Apply the mirrored room playback so a late joiner starts in sync.
    if (s.playbackTime > 0) {
      applyRemote(() => ctrl.seekTo(s.playbackTime), null);
    }
    if (s.playbackState === PLAYER_STATE.PLAYING) {
      applyRemote(() => ctrl.play(), PLAYER_STATE.PLAYING);
    }
    // Ask the host for an authoritative fresh snapshot regardless.
    emit(SOCKET_EVENTS.SYNC_REQUEST, {});
  }, [applyRemote, controllerRef, emit]);

  /* ------------------------------------------------------------------ *
   * UI control intents — host acts directly, guests send requests.
   * ------------------------------------------------------------------ */

  const requestPlay = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (amHost()) {
      ctrl.play(); // genuine local action -> onStateChange emits SYNC_PLAY
    } else {
      emit(SOCKET_EVENTS.CONTROL_REQUEST, {
        action: 'play',
        currentTime: ctrl.getCurrentTime(),
      });
    }
  }, [amHost, controllerRef, emit]);

  const requestPause = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (amHost()) {
      ctrl.pause();
    } else {
      emit(SOCKET_EVENTS.CONTROL_REQUEST, {
        action: 'pause',
        currentTime: ctrl.getCurrentTime(),
      });
    }
  }, [amHost, controllerRef, emit]);

  const requestSeek = useCallback((seconds) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (amHost()) {
      // Host seeks locally AND emits explicitly — there is no reliable
      // normalized "seeked" state event to drive this off onStateChange.
      lastAppliedSeek.current = seconds;
      ctrl.seekTo(seconds);
      emit(SOCKET_EVENTS.SYNC_SEEK, { currentTime: seconds });
    } else {
      emit(SOCKET_EVENTS.CONTROL_REQUEST, { action: 'seek', currentTime: seconds });
    }
  }, [amHost, controllerRef, emit]);

  /* ------------------------------------------------------------------ *
   * Inbound sync listeners + host heartbeat
   * ------------------------------------------------------------------ */

  useEffect(() => {
    const socket = getSocket();

    /* ---- inbound authoritative events (guests apply; host ignores its echo) ---- */

    const onSyncPlay = (p) => {
      if (!isValidSyncPayload(p)) return;
      readStore().setPlaybackMirror({ state: PLAYER_STATE.PLAYING, currentTime: p.currentTime });
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      reconcileTime(p.currentTime, true);
      applyRemote(() => ctrl.play(), PLAYER_STATE.PLAYING);
    };

    const onSyncPause = (p) => {
      if (!isValidSyncPayload(p)) return;
      readStore().setPlaybackMirror({ state: PLAYER_STATE.PAUSED, currentTime: p.currentTime });
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      applyRemote(() => {
        ctrl.pause();
        ctrl.seekTo(p.currentTime); // align position while paused — no stutter risk
      }, PLAYER_STATE.PAUSED);
    };

    const onSyncSeek = (p) => {
      if (!isValidSeekPayload(p)) return;
      readStore().setPlaybackMirror({ currentTime: p.currentTime });
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      const playing = ctrl.getState() === PLAYER_STATE.PLAYING;
      reconcileTime(p.currentTime, playing);
    };

    const onHeartbeat = (p) => {
      if (!isValidHeartbeatPayload(p)) return;
      if (amHost()) return; // host originated it
      const ctrl = controllerRef.current;
      if (!ctrl) return;

      // Clock-skew-aware: estimate where playback REALLY is now if it's playing.
      let target = p.currentTime;
      if (p.state === PLAYER_STATE.PLAYING && typeof p.serverTime === 'number') {
        const ageSec = Math.max(0, (serverNow() - p.serverTime) / 1000);
        target += ageSec;
      }
      readStore().setPlaybackMirror({ state: p.state, currentTime: target });

      // Reconcile slow drift the single-event sync missed.
      if (p.state === PLAYER_STATE.PLAYING) {
        reconcileTime(target, true);
        if (ctrl.getState() !== PLAYER_STATE.PLAYING) {
          applyRemote(() => ctrl.play(), PLAYER_STATE.PLAYING);
        }
      } else if (p.state === PLAYER_STATE.PAUSED) {
        if (ctrl.getState() === PLAYER_STATE.PLAYING) {
          applyRemote(() => ctrl.pause(), PLAYER_STATE.PAUSED);
        }
      }
    };

    const onBuffering = (p) => {
      if (!isValidBufferingPayload(p)) return;
      const ctrl = controllerRef.current;
      readStore().setRemoteBuffering(p.buffering);
      if (!ctrl) return;
      if (p.buffering) {
        // A peer stalled — everyone waits together.
        if (ctrl.getState() === PLAYER_STATE.PLAYING) {
          applyRemote(() => ctrl.pause(), PLAYER_STATE.PAUSED);
        }
      } else {
        // Peer recovered — resume together if the room state is "playing".
        if (readStore().playbackState === PLAYER_STATE.PLAYING
          && ctrl.getState() !== PLAYER_STATE.PLAYING) {
          applyRemote(() => ctrl.play(), PLAYER_STATE.PLAYING);
        }
      }
    };

    /* ---- CONTROL_REQUEST: only the host acts on these ---- */
    const onControlRequest = (req) => {
      if (!amHost()) return;
      const ctrl = controllerRef.current;
      if (!ctrl || !req || typeof req.action !== 'string') return;
      // The host applies the request to its OWN player as a genuine local
      // action. onStateChange / the explicit seek emit then fans the
      // authoritative event back out to everyone — including the requester.
      if (req.action === 'play') {
        ctrl.play();
      } else if (req.action === 'pause') {
        ctrl.pause();
      } else if (req.action === 'seek' && Number.isFinite(req.currentTime)) {
        lastAppliedSeek.current = req.currentTime;
        ctrl.seekTo(req.currentTime);
        emit(SOCKET_EVENTS.SYNC_SEEK, { currentTime: req.currentTime });
      }
    };

    /* ---- SOURCE_CHANGE: host swapped the video ---- */
    const onSourceChange = (source) => {
      if (!source || !source.kind || !source.url) return;
      // WatchTheater watches store.source and rebuilds the controller.
      readStore().setSource(source);
      readStore().addSystemMessage('The host changed the video.');
    };

    socket.on(SOCKET_EVENTS.SYNC_PLAY, onSyncPlay);
    socket.on(SOCKET_EVENTS.SYNC_PAUSE, onSyncPause);
    socket.on(SOCKET_EVENTS.SYNC_SEEK, onSyncSeek);
    socket.on(SOCKET_EVENTS.SYNC_HEARTBEAT, onHeartbeat);
    socket.on(SOCKET_EVENTS.SYNC_BUFFERING, onBuffering);
    socket.on(SOCKET_EVENTS.CONTROL_REQUEST, onControlRequest);
    socket.on(SOCKET_EVENTS.SOURCE_CHANGE, onSourceChange);

    /* ---- host heartbeat: low-frequency reconciliation tick ---- */
    heartbeatTimer.current = setInterval(() => {
      if (!amHost()) return;
      const ctrl = controllerRef.current;
      if (!ctrl || !ctrl.isReady()) return;
      const state = ctrl.getState();
      if (state !== PLAYER_STATE.PLAYING && state !== PLAYER_STATE.PAUSED) return;
      emit(SOCKET_EVENTS.SYNC_HEARTBEAT, {
        state,
        currentTime: ctrl.getCurrentTime(),
      });
    }, HEARTBEAT_INTERVAL_MS);

    /* ---- cleanup: remove every listener by reference, clear the interval ---- */
    return () => {
      socket.off(SOCKET_EVENTS.SYNC_PLAY, onSyncPlay);
      socket.off(SOCKET_EVENTS.SYNC_PAUSE, onSyncPause);
      socket.off(SOCKET_EVENTS.SYNC_SEEK, onSyncSeek);
      socket.off(SOCKET_EVENTS.SYNC_HEARTBEAT, onHeartbeat);
      socket.off(SOCKET_EVENTS.SYNC_BUFFERING, onBuffering);
      socket.off(SOCKET_EVENTS.CONTROL_REQUEST, onControlRequest);
      socket.off(SOCKET_EVENTS.SOURCE_CHANGE, onSourceChange);
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      if (guardTimer.current) {
        clearTimeout(guardTimer.current);
        guardTimer.current = null;
      }
    };
  }, [amHost, applyRemote, controllerRef, emit, reconcileTime, serverNow]);

  return { onPlayerStateChange, onPlayerReady, requestPlay, requestPause, requestSeek };
}
