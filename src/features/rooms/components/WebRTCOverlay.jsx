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

/** localStorage key for the overlay's last drag position. */
const OVERLAY_POS_KEY = 'cowatch:av-overlay-pos';

/**
 * Floating, draggable picture-in-picture overlay carrying the P2P voice/video
 * mesh. Server only signals; media is peer-to-peer (see useWebRTCConnection).
 *
 * It is freely draggable anywhere on screen by its title bar — on touchscreens
 * too (`touch-none` on the handle stops the browser hijacking the gesture as a
 * scroll). The drop position is remembered across reloads.
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
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  /** Keep a position fully inside the viewport (so it never strands off-screen). */
  const clampPos = useCallback((p) => {
    if (typeof window === 'undefined') return p;
    const el = panelRef.current;
    const w = el ? el.offsetWidth : 180;
    const h = el ? el.offsetHeight : 140;
    return {
      x: Math.min(Math.max(8, window.innerWidth - w - 8), Math.max(8, p.x)),
      y: Math.min(Math.max(8, window.innerHeight - h - 8), Math.max(8, p.y)),
    };
  }, []);

  // On mount: restore the last position the user dropped it at; collapse on
  // phones only when there is no saved position yet.
  useEffect(() => {
    let restored = null;
    try {
      const raw = window.localStorage.getItem(OVERLAY_POS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) restored = saved;
      }
    } catch { /* ignore corrupt value */ }
    if (restored) setPos(clampPos(restored));
    else if (window.innerWidth < 640) setCollapsed(true);
  }, [clampPos]);

  // Re-clamp on window resize / orientation change.
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPos]);

  const onPointerDown = useCallback((e) => {
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: posRef.current.x,
      originY: posRef.current.y,
    };
    setDragging(true);
    // Pointer capture keeps move/up events flowing even if the finger/cursor
    // slips off the small handle mid-drag.
    if (dragRef.current) {
      try { dragRef.current.setPointerCapture(e.pointerId); } catch { /* noop */ }
    }
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setPos(clampPos({
      x: dragState.current.originX + dx,
      y: dragState.current.originY + dy,
    }));
  }, [clampPos]);

  const onPointerUp = useCallback((e) => {
    if (!dragState.current) return;
    dragState.current = null;
    setDragging(false);
    if (dragRef.current && dragRef.current.hasPointerCapture(e.pointerId)) {
      try { dragRef.current.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    // Remember where the user dropped it.
    try {
      window.localStorage.setItem(OVERLAY_POS_KEY, JSON.stringify(posRef.current));
    } catch { /* storage unavailable */ }
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
      <div
        ref={panelRef}
        className={cn(
          'w-fit rounded-xl border bg-panel/95 shadow-2xl backdrop-blur transition-shadow',
          dragging ? 'border-accent2 ring-2 ring-accent2/40' : 'border-edge',
        )}
      >
        {/* drag handle — touch-none lets it be dragged on touchscreens */}
        <div
          ref={dragRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          title="Drag to move"
          className={cn(
            'flex touch-none items-center justify-between gap-2 rounded-t-xl px-2 py-1.5',
            dragging ? 'cursor-grabbing bg-white/5' : 'cursor-grab',
          )}
        >
          <span className="flex items-center gap-1 text-[11px] font-medium text-white/70">
            <span aria-hidden="true" className="text-sm leading-none text-white/40">⠿</span>
            Voice &amp; Video
          </span>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand video overlay' : 'Collapse video overlay'}
            className="rounded px-1.5 text-white/60 hover:bg-white/10"
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
