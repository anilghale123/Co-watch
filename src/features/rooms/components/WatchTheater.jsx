// src/features/rooms/components/WatchTheater.jsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { getSocket } from '@/lib/socket/socketClient';
import { createPlayerController } from '@/lib/player/createPlayerController';
import { useRoomStore, selectIsHost } from '@/features/rooms/stores/useRoomStore';
import { useVideoSync } from '@/features/rooms/hooks/useVideoSync';
import { useWebRTC } from '@/features/rooms/components/WebRTCProvider';
import { SOCKET_EVENTS, PLAYER_STATE } from '@/features/rooms/room-types';
import { parseVideoSource } from '@/lib/utils';
import VideoController from '@/features/rooms/components/VideoController';
import Button from '@/components/ui/Button';

/**
 * Full-bleed <video> for a live screen-share stream. Like the A/V tiles, the
 * MediaStream is attached via the `srcObject` DOM property (not expressible in
 * JSX). `object-contain` keeps the shared screen uncropped at any aspect ratio.
 */
function ScreenShareVideo({ stream, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && stream && el.srcObject !== stream) el.srcObject = stream;
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className="h-full w-full bg-black object-contain"
    />
  );
}

ScreenShareVideo.propTypes = {
  stream: PropTypes.object,
  muted: PropTypes.bool,
};

/**
 * Hosts the active player + its polymorphic controller, and wires the sync
 * engine. The controller is rebuilt whenever the room's video source changes;
 * the OLD controller is fully destroyed first (no leaked iframe / media).
 */
export default function WatchTheater() {
  const source = useRoomStore((s) => s.source);
  const playbackState = useRoomStore((s) => s.playbackState);
  const remoteBuffering = useRoomStore((s) => s.remoteBuffering);
  const isHost = useRoomStore(selectIsHost);
  const selfId = useRoomStore((s) => s.selfId);
  const peers = useRoomStore((s) => s.peers);
  const screenShare = useRoomStore((s) => s.screenShare);

  const {
    screenStream,
    remoteScreenStream,
    startScreenShare,
    stopScreenShare,
  } = useWebRTC();

  const containerRef = useRef(null);
  const theaterRef = useRef(null);
  const controllerRef = useRef(null);
  const [playerError, setPlayerError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState('');
  const [screenError, setScreenError] = useState('');

  // While a screen share runs it takes over the theater. Pick the right
  // stream: our own local capture if WE are sharing, otherwise the peer's.
  const sharingBySelf = screenShare.sharing && screenShare.sharerId === selfId;
  const screenViewStream = sharingBySelf ? screenStream : remoteScreenStream;
  const sharerName = sharingBySelf
    ? 'You'
    : (peers.find((p) => p.socketId === screenShare.sharerId) || {}).displayName || 'A peer';

  const handleToggleScreenShare = useCallback(async () => {
    if (sharingBySelf) {
      stopScreenShare();
      return;
    }
    setScreenError('');
    const res = await startScreenShare();
    if (!res.ok && res.error && res.error !== 'cancelled') {
      setScreenError(res.error);
    }
  }, [sharingBySelf, startScreenShare, stopScreenShare]);

  // The sync engine — controllerRef is mutated by the effect below.
  const sync = useVideoSync(controllerRef);

  /* ---- build / tear down the controller on source change ---- */
  useEffect(() => {
    if (!source || !containerRef.current) return undefined;
    setPlayerError('');
    let ctrl;
    try {
      ctrl = createPlayerController({
        container: containerRef.current,
        source,
        onStateChange: sync.onPlayerStateChange,
        onReady: sync.onPlayerReady,
        onError: () => setPlayerError('This video failed to load. Check the link and try again.'),
      });
      controllerRef.current = ctrl;
    } catch (err) {
      setPlayerError(err && err.message ? err.message : 'Could not start the player.');
    }
    return () => {
      // Full teardown — destroy() removes the iframe / media element.
      if (ctrl) ctrl.destroy();
      controllerRef.current = null;
    };
    // Rebuild only when the actual video changes — NOT when sync callbacks
    // re-create (they are stable useCallbacks anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source && source.url, source && source.kind]);

  /* ---- fullscreen ---- */
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /* ---- repaint + re-sync when the player becomes visible again ----
     A hidden player (Chat tab on mobile, or a backgrounded tab) keeps audio
     and the clock running but stops painting frames, so seeks applied while it
     was hidden leave a frozen picture. Snap it back when it reappears. */
  const resync = sync.resync;
  useEffect(() => {
    const el = theaterRef.current;
    if (!el) return undefined;
    let wasVisible = true;
    let io;

    const fire = () => {
      // Small delay lets the player backend settle after becoming visible.
      setTimeout(() => resync(), 150);
    };

    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          const visible = entries[0] ? entries[0].isIntersecting : true;
          if (visible && !wasVisible) fire(); // hidden -> visible
          wasVisible = visible;
        },
        { threshold: 0.05 },
      );
      io.observe(el);
    }

    const onDocVis = () => {
      if (document.visibilityState === 'visible') fire();
    };
    document.addEventListener('visibilitychange', onDocVis);

    return () => {
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', onDocVis);
    };
  }, [resync]);

  const toggleFullscreen = useCallback(() => {
    const el = theaterRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  /* ---- host: load / change the video ---- */
  const submitLink = useCallback(
    (e) => {
      e.preventDefault();
      setLinkError('');
      const result = parseVideoSource(linkInput);
      if (!result.ok) {
        setLinkError(result.error);
        return;
      }
      // Optimistically set locally + broadcast to the room.
      useRoomStore.getState().setSource(result.source);
      const socket = getSocket();
      if (socket && socket.connected) {
        socket.emit(SOCKET_EVENTS.SOURCE_CHANGE, result.source);
      }
      setLinkInput('');
    },
    [linkInput],
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink" aria-label="Video theater">
      <div ref={theaterRef} className="relative flex flex-1 flex-col bg-black">
        {/* host-only screen-share toggle — works in fullscreen too */}
        {isHost ? (
          <button
            type="button"
            onClick={handleToggleScreenShare}
            className="absolute right-2 top-2 z-30 rounded-lg bg-black/70 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur hover:bg-black/90"
          >
            {sharingBySelf ? '⏹ Stop sharing' : '🖥 Share screen'}
          </button>
        ) : null}

        {/* player mount point */}
        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="absolute inset-0 h-full w-full" />

          {/* screen share takes over the theater while it is active */}
          {screenShare.sharing ? (
            <div className="absolute inset-0 z-20 bg-black">
              {screenViewStream ? (
                <ScreenShareVideo stream={screenViewStream} muted={sharingBySelf} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white/60">
                  Connecting to {sharerName === 'You' ? 'your' : `${sharerName}'s`} screen share…
                </div>
              )}
              <span className="absolute left-2 top-2 rounded-full bg-black/75 px-3 py-1 text-xs font-medium text-white/90">
                🖥 {sharingBySelf ? 'You are sharing your screen' : `${sharerName}'s screen`}
              </span>
            </div>
          ) : null}

          {!source && !screenShare.sharing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-lg font-semibold text-white">No video loaded yet</p>
              <p className="max-w-sm text-sm text-white/60">
                {isHost
                  ? 'Paste a YouTube or direct video link below, or share your screen, to start watching together.'
                  : 'Waiting for the host to pick something to watch…'}
              </p>
            </div>
          ) : null}

          {playerError ? (
            <div
              role="alert"
              className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-lg bg-red-600/90 px-4 py-2 text-sm text-white"
            >
              {playerError}
            </div>
          ) : null}

          {remoteBuffering ? (
            <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white/80 animate-pulse2">
              Waiting for a peer to buffer…
            </div>
          ) : null}
        </div>

        {/* control bar */}
        {source ? (
          <VideoController
            controllerRef={controllerRef}
            playbackState={playbackState || PLAYER_STATE.UNSTARTED}
            onPlay={sync.requestPlay}
            onPause={sync.requestPause}
            onSeek={sync.requestSeek}
            isHost={isHost}
            onToggleFullscreen={toggleFullscreen}
            isFullscreen={isFullscreen}
          />
        ) : null}
      </div>

      {/* host link loader */}
      {isHost ? (
        <form
          onSubmit={submitLink}
          className="flex flex-col gap-2 border-t border-edge bg-panel p-3 sm:flex-row"
        >
          <input
            type="url"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            placeholder="Paste a YouTube or .mp4 / .m3u8 link…"
            aria-label="Video link"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-base text-white placeholder:text-white/30 focus:border-accent2 focus:outline-none sm:text-sm"
          />
          <Button type="submit" variant="primary">
            {source ? 'Change video' : 'Load video'}
          </Button>
        </form>
      ) : null}
      {linkError ? (
        <p role="alert" className="bg-panel px-3 pb-2 text-xs text-red-400">
          {linkError}
        </p>
      ) : null}
      {screenError ? (
        <p role="alert" className="bg-panel px-3 pb-2 text-xs text-red-400">
          {screenError}
        </p>
      ) : null}
    </main>
  );
}
