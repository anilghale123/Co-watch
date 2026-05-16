// src/features/rooms/components/WebRTCOverlay.jsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useWebRTCConnection } from '@/features/rooms/hooks/useWebRTCConnection';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * One <video> tile. Attaching a MediaStream must happen via the `srcObject`
 * DOM property — it cannot be expressed in JSX — so this isolates that effect.
 */
function VideoTile({ stream, label, muted, mirrored }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
    }
    return () => {
      // Detach so a destroyed stream is not held by the element.
      if (el) el.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="relative overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={cn(
          'h-20 w-28 object-cover sm:h-24 sm:w-32',
          mirrored && '[transform:scaleX(-1)]',
        )}
      />
      <span className="absolute bottom-0.5 left-1 text-[10px] text-white/80 drop-shadow">
        {label}
      </span>
    </div>
  );
}

VideoTile.propTypes = {
  stream: PropTypes.object,
  label: PropTypes.string.isRequired,
  muted: PropTypes.bool,
  mirrored: PropTypes.bool,
};

/**
 * Floating, draggable picture-in-picture overlay carrying the P2P voice/video
 * mesh. Server only signals; media is peer-to-peer (see useWebRTCConnection).
 */
export default function WebRTCOverlay() {
  const {
    localStream,
    remoteStreams,
    mediaPermission,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
    retryMedia,
  } = useWebRTCConnection();

  const peers = useRoomStore((s) => s.peers);
  const selfId = useRoomStore((s) => s.selfId);

  // --- dragging ---
  const [pos, setPos] = useState({ x: 16, y: 16 });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef(null);
  const dragState = useRef(null);

  // On phones the overlay starts collapsed so it does not cover the video.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) {
      setCollapsed(true);
    }
  }, []);

  const onPointerDown = useCallback((e) => {
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    if (dragRef.current) dragRef.current.setPointerCapture(e.pointerId);
  }, [pos]);

  const onPointerMove = useCallback((e) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const el = dragRef.current ? dragRef.current.parentElement : null;
    const w = el ? el.offsetWidth : 160;
    const h = el ? el.offsetHeight : 120;
    // Clamp inside the viewport so the overlay can't be dragged off-screen.
    const maxX = Math.max(8, window.innerWidth - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    setPos({
      x: Math.min(maxX, Math.max(8, dragState.current.originX + dx)),
      y: Math.min(maxY, Math.max(8, dragState.current.originY + dy)),
    });
  }, []);

  const onPointerUp = useCallback((e) => {
    dragState.current = null;
    if (dragRef.current && dragRef.current.hasPointerCapture(e.pointerId)) {
      dragRef.current.releasePointerCapture(e.pointerId);
    }
  }, []);

  /** displayName lookup by socketId. */
  const nameOf = (id) => {
    const p = peers.find((x) => x.socketId === id);
    return p ? p.displayName : 'Peer';
  };

  const remoteIds = Object.keys(remoteStreams);

  return (
    <div
      className="fixed z-40 select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="w-fit rounded-xl border border-edge bg-panel/95 shadow-2xl backdrop-blur">
        {/* drag handle */}
        <div
          ref={dragRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="flex cursor-grab items-center justify-between gap-2 px-2 py-1 active:cursor-grabbing"
        >
          <span className="text-[11px] font-medium text-white/70">Voice &amp; Video</span>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand video overlay' : 'Collapse video overlay'}
            className="rounded px-1 text-white/60 hover:bg-white/10"
          >
            {collapsed ? '▢' : '—'}
          </button>
        </div>

        {!collapsed ? (
          <div className="px-2 pb-2">
            {/* permission denied -> graceful text-chat-only degradation */}
            {mediaPermission === 'denied' ? (
              <div className="w-40 rounded-lg bg-ink p-2 text-center">
                <p className="text-[11px] text-white/60">
                  Camera / mic unavailable. You can still watch and chat.
                </p>
                <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={retryMedia}>
                  Enable camera
                </Button>
              </div>
            ) : null}

            {mediaPermission === 'prompt' ? (
              <p className="w-40 p-2 text-center text-[11px] text-white/50">
                Requesting camera &amp; mic…
              </p>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {localStream ? (
                <VideoTile stream={localStream} label="You" muted mirrored />
              ) : null}
              {remoteIds.map((id) => (
                <VideoTile key={id} stream={remoteStreams[id]} label={nameOf(id)} />
              ))}
              {remoteIds.length === 0 && mediaPermission !== 'denied' ? (
                <div className="flex h-20 w-28 items-center justify-center rounded-lg bg-ink text-center text-[10px] text-white/40 sm:h-24 sm:w-32">
                  Waiting for others to join…
                </div>
              ) : null}
            </div>

            {/* controls */}
            {mediaPermission === 'granted' ? (
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  variant={audioEnabled ? 'secondary' : 'danger'}
                  className="flex-1"
                  onClick={toggleAudio}
                  aria-pressed={!audioEnabled}
                >
                  {audioEnabled ? '🎙 Mute' : '🔇 Unmute'}
                </Button>
                <Button
                  size="sm"
                  variant={videoEnabled ? 'secondary' : 'danger'}
                  className="flex-1"
                  onClick={toggleVideo}
                  aria-pressed={!videoEnabled}
                >
                  {videoEnabled ? '📷 Off' : '🚫 On'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
