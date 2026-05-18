// src/features/rooms/hooks/useWebRTCConnection.js
/**
 * P2P WebRTC mesh (spec §2.4).
 *
 *   - Live audio/video runs client-to-client over `simple-peer`. The Socket.IO
 *     server is a PURE signaling channel — it relays SDP/ICE during handshake
 *     and then steps fully out; no media bytes ever transit the server.
 *   - Glare-free initiator rule: for any pair, the peer with the
 *     lexicographically smaller socketId is the initiator. Deterministic on
 *     both sides => exactly one offer per pair.
 *   - Full lifecycle: getUserMedia (incl. denial), connect/disconnect,
 *     and COMPLETE teardown — stop every track, destroy every peer, remove
 *     every listener (spec §4 grading: a live mic after room exit is a fail).
 *   - Denied mic/cam degrades gracefully: peers are still created without a
 *     local stream so this client can still receive others, and text chat is
 *     unaffected (spec §3 gap #8).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import { SOCKET_EVENTS } from '@/features/rooms/room-types';

/** ICE servers. Google public STUN covers most NATs. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  /*
   * TURN PLACEHOLDER — required for the ~10-15% of real-world NAT setups
   * (symmetric NAT / strict firewalls) that STUN cannot traverse. TURN relays
   * media, so it is post-MVP infrastructure. In production, mint SHORT-LIVED
   * TURN credentials server-side and hand them to the client; do NOT ship a
   * static long-lived credential. See README "TURN" section.
   *
   * {
   *   urls: process.env.NEXT_PUBLIC_TURN_URL,
   *   username: process.env.NEXT_PUBLIC_TURN_USERNAME,
   *   credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
   * },
   */
];

/**
 * @returns {{
 *   localStream: MediaStream|null,
 *   remoteStreams: Record<string, MediaStream>,
 *   mediaPermission: string,
 *   audioEnabled: boolean,
 *   videoEnabled: boolean,
 *   mediaStarted: boolean,
 *   toggleAudio: ()=>void,
 *   toggleVideo: ()=>void,
 *   startMedia: ()=>void,
 *   stopMedia: ()=>void,
 *   retryMedia: ()=>void,
 *   screenShare: {sharing:boolean, streamId:string|null, sharerId:string|null},
 *   screenStream: MediaStream|null,
 *   remoteScreenStream: MediaStream|null,
 *   startScreenShare: ()=>Promise<{ok:boolean, error?:string}>,
 *   stopScreenShare: ()=>void,
 * }}
 */
export function useWebRTCConnection() {
  const [localStream, setLocalStream] = useState(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  // Voice/video stays OFF until the user explicitly opts in — no camera/mic
  // permission prompt fires on app open.
  const [mediaStarted, setMediaStarted] = useState(false);
  const [mediaAttempt, setMediaAttempt] = useState(0); // bump to retry getUserMedia
  // Local screen-capture stream when THIS client is the one sharing.
  const [screenStream, setScreenStream] = useState(null);
  // Bumped whenever a peer's set of inbound streams changes — drives recompute.
  const [streamsRev, setStreamsRev] = useState(0);

  /** @type {{current: Map<string, any>}} socketId -> simple-peer instance */
  const peersRef = useRef(new Map());
  /**
   * socketId -> inbound MediaStream[]. A peer can carry more than one stream
   * (e.g. the host sends BOTH a camera stream and a screen-share stream), so
   * each peer's streams are tracked as a list and classified on read.
   * @type {{current: Map<string, MediaStream[]>}}
   */
  const peerStreamsRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const SimplePeerRef = useRef(null); // lazily-loaded simple-peer constructor
  const mountedRef = useRef(true);

  const bumpStreams = useCallback(() => setStreamsRev((n) => n + 1), []);

  const setPermission = (p) => useRoomStore.getState().setMediaPermission(p);

  /* ------------------------------------------------------------------ *
   * Peer teardown helpers
   * ------------------------------------------------------------------ */

  const destroyPeer = useCallback((peerId) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      try { peer.removeAllListeners(); } catch { /* noop */ }
      try { peer.destroy(); } catch { /* noop */ }
      peersRef.current.delete(peerId);
    }
    if (peerStreamsRef.current.delete(peerId)) bumpStreams();
  }, [bumpStreams]);

  const destroyAllPeers = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach((id) => destroyPeer(id));
  }, [destroyPeer]);

  /* ------------------------------------------------------------------ *
   * Create a peer connection
   * ------------------------------------------------------------------ */

  const createPeer = useCallback((peerId, initiator) => {
    if (peersRef.current.has(peerId)) return peersRef.current.get(peerId);
    const SimplePeer = SimplePeerRef.current;
    if (!SimplePeer) return null;

    const socket = getSocket();
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: localStreamRef.current || undefined,
      config: { iceServers: ICE_SERVERS },
    });

    peer.on('signal', (signal) => {
      // Relay handshake data through the server, scoped to this room.
      socket.emit(SOCKET_EVENTS.RTC_SIGNAL, { targetId: peerId, signal });
    });

    peer.on('stream', (stream) => {
      if (!mountedRef.current) return;
      // Append (deduped) — a peer may deliver a camera AND a screen stream.
      const arr = peerStreamsRef.current.get(peerId) || [];
      if (!arr.some((s) => s.id === stream.id)) {
        peerStreamsRef.current.set(peerId, arr.concat(stream));
        bumpStreams();
      }
    });

    peer.on('connect', () => {
      // Media path is now direct P2P — server is out of the loop.
    });

    peer.on('close', () => destroyPeer(peerId));
    peer.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[webrtc] peer ${peerId} error`, err && err.message);
      destroyPeer(peerId);
    });

    peersRef.current.set(peerId, peer);
    // A screen share already in progress must reach this freshly-joined peer.
    if (screenStreamRef.current) {
      try { peer.addStream(screenStreamRef.current); } catch { /* noop */ }
    }
    return peer;
  }, [bumpStreams, destroyPeer]);

  /* ------------------------------------------------------------------ *
   * getUserMedia — with explicit denial handling
   * ------------------------------------------------------------------ */

  useEffect(() => {
    // Only acquire camera/mic once the user has opted in.
    if (!mediaStarted) return undefined;
    mountedRef.current = true;
    let cancelled = false;

    async function acquireMedia() {
      setPermission('prompt');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setPermission('denied');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setAudioEnabled(true);
        setVideoEnabled(true);
        setPermission('granted');
        // Attach the freshly-acquired stream to any peers created before media
        // resolved (e.g. permission prompt outlived the first peer joining).
        peersRef.current.forEach((peer) => {
          try { peer.addStream(stream); } catch { /* already has a stream */ }
        });
      } catch (err) {
        // Denied, dismissed, or no device — degrade to text-chat-only.
        // eslint-disable-next-line no-console
        console.warn('[webrtc] getUserMedia failed', err && err.name);
        setPermission('denied');
      }
    }

    acquireMedia();

    return () => {
      cancelled = true;
    };
  }, [mediaStarted, mediaAttempt]);

  /* ------------------------------------------------------------------ *
   * Signaling lifecycle
   * ------------------------------------------------------------------ */

  useEffect(() => {
    mountedRef.current = true;
    const socket = getSocket();
    let disposed = false;

    // Lazy-load simple-peer (browser-only; keeps it out of any SSR path).
    import('simple-peer').then((mod) => {
      if (disposed) return;
      SimplePeerRef.current = mod.default || mod;

      // Connect to peers ALREADY in the room when we arrive. Existing peers also
      // receive RTC_PEER_JOINED for us — the id rule ensures one initiator.
      const { selfId, peers } = useRoomStore.getState();
      if (selfId) {
        peers.forEach((p) => {
          if (p.socketId !== selfId) {
            createPeer(p.socketId, selfId < p.socketId);
          }
        });
      }
    });

    /* ---- handlers (kept by reference for cleanup) ---- */

    const onPeerJoined = ({ socketId }) => {
      const { selfId } = useRoomStore.getState();
      if (!selfId || socketId === selfId || !SimplePeerRef.current) return;
      // We initiate iff our id sorts first — deterministic, no glare.
      createPeer(socketId, selfId < socketId);
    };

    const onPeerLeft = ({ socketId }) => {
      destroyPeer(socketId);
    };

    const onSignal = ({ fromId, signal }) => {
      if (!SimplePeerRef.current || !fromId) return;
      let peer = peersRef.current.get(fromId);
      if (!peer) {
        // First contact and we are NOT the initiator — build the answering peer.
        peer = createPeer(fromId, false);
      }
      if (peer) {
        try { peer.signal(signal); }
        catch (err) { /* eslint-disable-line no-console */ console.warn('[webrtc] signal apply failed', err); }
      }
    };

    // A peer announced it started / stopped sharing its screen. We only need
    // the announced streamId so the inbound stream can be classified; on stop
    // we drop the now-stale stream so it doesn't resurface as a camera tile.
    const onScreenShare = (payload) => {
      if (!payload || typeof payload.sharing !== 'boolean') return;
      const store = useRoomStore.getState();
      if (payload.sharing) {
        store.setScreenShare({
          sharing: true,
          streamId: payload.streamId || null,
          sharerId: payload.originId || null,
        });
      } else {
        const oldId = store.screenShare.streamId;
        if (oldId) {
          peerStreamsRef.current.forEach((arr, pid) => {
            const next = arr.filter((s) => s.id !== oldId);
            if (next.length !== arr.length) peerStreamsRef.current.set(pid, next);
          });
          bumpStreams();
        }
        store.setScreenShare({ sharing: false, streamId: null, sharerId: null });
      }
    };

    socket.on(SOCKET_EVENTS.RTC_PEER_JOINED, onPeerJoined);
    socket.on(SOCKET_EVENTS.RTC_PEER_LEFT, onPeerLeft);
    socket.on(SOCKET_EVENTS.RTC_SIGNAL, onSignal);
    socket.on(SOCKET_EVENTS.SCREEN_SHARE, onScreenShare);

    /* ---- COMPLETE teardown ---- */
    return () => {
      disposed = true;
      mountedRef.current = false;
      socket.off(SOCKET_EVENTS.RTC_PEER_JOINED, onPeerJoined);
      socket.off(SOCKET_EVENTS.RTC_PEER_LEFT, onPeerLeft);
      socket.off(SOCKET_EVENTS.RTC_SIGNAL, onSignal);
      socket.off(SOCKET_EVENTS.SCREEN_SHARE, onScreenShare);
      destroyAllPeers();
      // Stop every local media track — the mic/cam indicator MUST go off.
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      // Stop screen capture too — the browser "sharing" banner must go away.
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
    };
  }, [bumpStreams, createPeer, destroyAllPeers, destroyPeer]);

  /* ------------------------------------------------------------------ *
   * Track toggles — flip `enabled`; no renegotiation needed.
   * ------------------------------------------------------------------ */

  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !audioEnabled;
    stream.getAudioTracks().forEach((t) => { t.enabled = next; });
    setAudioEnabled(next);
  }, [audioEnabled]);

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoEnabled;
    stream.getVideoTracks().forEach((t) => { t.enabled = next; });
    setVideoEnabled(next);
  }, [videoEnabled]);

  /** Re-attempt getUserMedia after the user fixed a denied permission. */
  const retryMedia = useCallback(() => {
    setMediaAttempt((n) => n + 1);
  }, []);

  /** User opts in: start requesting camera/mic and join the A/V mesh. */
  const startMedia = useCallback(() => {
    setMediaStarted(true);
  }, []);

  /** User opts out: stop the camera/mic and drop the local stream from peers. */
  const stopMedia = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      peersRef.current.forEach((peer) => {
        try { peer.removeStream(stream); } catch { /* noop */ }
      });
      stream.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setAudioEnabled(true);
    setVideoEnabled(true);
    setMediaAttempt(0);
    setMediaStarted(false);
    setPermission('unknown');
  }, []);

  /* ------------------------------------------------------------------ *
   * Screen sharing — broadcast one client's display to the whole room.
   * ------------------------------------------------------------------ */

  /** Stop the screen share: pull the stream from peers and announce the end. */
  const stopScreenShare = useCallback(() => {
    const stream = screenStreamRef.current;
    if (stream) {
      peersRef.current.forEach((peer) => {
        try { peer.removeStream(stream); } catch { /* noop */ }
      });
      stream.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    setScreenStream(null);
    try {
      getSocket().emit(SOCKET_EVENTS.SCREEN_SHARE, { sharing: false });
    } catch { /* not connected */ }
    useRoomStore.getState().setScreenShare({ sharing: false, streamId: null, sharerId: null });
  }, []);

  /**
   * Start sharing this display. Captures via getDisplayMedia, pushes the stream
   * onto every peer connection, and announces it so receivers can identify it.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  const startScreenShare = useCallback(async () => {
    if (screenStreamRef.current) return { ok: true };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return { ok: false, error: 'Screen sharing is not supported in this browser.' };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // The user dismissing the picker is not an error worth surfacing.
      if (err && err.name === 'NotAllowedError') return { ok: false, error: 'cancelled' };
      return { ok: false, error: 'Could not start screen sharing.' };
    }
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: 'cancelled' };
    }
    screenStreamRef.current = stream;
    setScreenStream(stream);
    peersRef.current.forEach((peer) => {
      try { peer.addStream(stream); } catch { /* noop */ }
    });
    getSocket().emit(SOCKET_EVENTS.SCREEN_SHARE, { sharing: true, streamId: stream.id });
    useRoomStore.getState().setScreenShare({
      sharing: true,
      streamId: stream.id,
      sharerId: useRoomStore.getState().selfId,
    });
    // The browser's own "Stop sharing" control ends the track — mirror that.
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => stopScreenShare(), { once: true });
    }
    return { ok: true };
  }, [stopScreenShare]);

  const mediaPermission = useRoomStore((s) => s.mediaPermission);
  const screenShare = useRoomStore((s) => s.screenShare);

  // Classify each peer's inbound streams: the one whose id matches the
  // announced screen share is the shared screen; the rest are camera tiles.
  const remoteStreams = useMemo(() => {
    const out = {};
    peerStreamsRef.current.forEach((arr, peerId) => {
      const cam = arr.find((s) => s.id !== screenShare.streamId);
      if (cam) out[peerId] = cam;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamsRev, screenShare.streamId]);

  const remoteScreenStream = useMemo(() => {
    if (!screenShare.sharing || !screenShare.streamId) return null;
    let found = null;
    peerStreamsRef.current.forEach((arr) => {
      const m = arr.find((s) => s.id === screenShare.streamId);
      if (m) found = m;
    });
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamsRev, screenShare.sharing, screenShare.streamId]);

  return {
    localStream,
    remoteStreams,
    mediaPermission,
    audioEnabled,
    videoEnabled,
    mediaStarted,
    toggleAudio,
    toggleVideo,
    startMedia,
    stopMedia,
    retryMedia,
    // screen sharing
    screenShare,
    screenStream,
    remoteScreenStream,
    startScreenShare,
    stopScreenShare,
  };
}
