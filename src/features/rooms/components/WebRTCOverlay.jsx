// src/features/rooms/components/WebRTCOverlay.jsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useWebRTC } from '@/features/rooms/components/WebRTCProvider';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/** Tile sizing — width in px; height keeps a ~4:3 ratio. */
const TILE_MIN = 96;
const TILE_MAX = 360;
const TILE_DEFAULT = 128;
const TILE_RATIO = 0.75;

/**
 * One <video> tile. Attaching a MediaStream must happen via the `srcObject`
 * DOM property — it cannot be expressed in JSX — so this isolates that effect.
 */
function VideoTile({ stream, label, muted, mirrored, audioOn, videoOn, width }) {
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
    <div
      className="relative overflow-hidden rounded-lg bg-black"
      style={{ width, height: Math.round(width * TILE_RATIO) }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={cn(
          'h-full w-full object-cover',
          mirrored && '[transform:scaleX(-1)]',
        )}
      />
      {videoOn === false ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-[11px] font-semibold uppercase tracking-wide text-white">
          Camera off
        </div>
      ) : null}
      {audioOn === false ? (
        <span className="absolute right-1 top-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
          Mic off
        </span>
      ) : null}
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
  audioOn: PropTypes.bool,
  videoOn: PropTypes.bool,
  width: PropTypes.number.isRequired,
};

/** localStorage key for the overlay's last drag position. */
const OVERLAY_POS_KEY = 'cowatch:av-overlay-pos';
/** localStorage key for the user's chosen tile size. */
const OVERLAY_SIZE_KEY = 'cowatch:av-overlay-size';

/**
 * Floating, draggable picture-in-picture overlay carrying the P2P voice/video
 * mesh. Server only signals; media is peer-to-peer (see useWebRTCConnection).
 *
 * Voice & video start OFF — nothing requests the camera/mic until the user
 * presses "Start". The panel is draggable by its title bar and resizable from
 * its bottom-right corner; both position and size persist across reloads.
 */
export default function WebRTCOverlay() {
  const {
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
  } = useWebRTC();

  const peers = useRoomStore((s) => s.peers);

  // --- dragging ---
  const [pos, setPos] = useState({ x: 16, y: 16 });
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  const panelRef = useRef(null);
  const dragState = useRef(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  // --- resizing (tile width drives the whole panel size) ---
  const [tileW, setTileW] = useState(TILE_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const tileWRef = useRef(tileW);
  tileWRef.current = tileW;
  const resizeState = useRef(null);

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

  // On mount: restore the last position the user dropped it at and the saved
  // tile size; collapse on phones only when there is no saved position yet.
  useEffect(() => {
    let restored = null;
    try {
      const raw = window.localStorage.getItem(OVERLAY_POS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) restored = saved;
      }
    } catch { /* ignore corrupt value */ }
    try {
      const size = Number(window.localStorage.getItem(OVERLAY_SIZE_KEY));
      if (Number.isFinite(size) && size >= TILE_MIN && size <= TILE_MAX) {
        setTileW(size);
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

  /* ---- corner resize handle ---- */

  const persistSize = useCallback(() => {
    try {
      window.localStorage.setItem(OVERLAY_SIZE_KEY, String(tileWRef.current));
    } catch { /* storage unavailable */ }
  }, []);

  const onResizeDown = useCallback((e) => {
    e.stopPropagation();
    resizeState.current = { startX: e.clientX, originW: tileWRef.current };
    setResizing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);

  const onResizeMove = useCallback((e) => {
    if (!resizeState.current) return;
    const dx = e.clientX - resizeState.current.startX;
    const next = Math.min(TILE_MAX, Math.max(TILE_MIN, resizeState.current.originW + dx));
    setTileW(next);
    // Resizing can push the panel off-screen — keep it clamped.
    setPos((p) => clampPos(p));
  }, [clampPos]);

  const onResizeUp = useCallback((e) => {
    if (!resizeState.current) return;
    resizeState.current = null;
    setResizing(false);
    if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    persistSize();
  }, [persistSize]);

  /** Step the size with the +/- buttons. */
  const bumpSize = useCallback((delta) => {
    setTileW((w) => {
      const next = Math.min(TILE_MAX, Math.max(TILE_MIN, w + delta));
      tileWRef.current = next;
      return next;
    });
    setPos((p) => clampPos(p));
    persistSize();
  }, [clampPos, persistSize]);

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
          'relative w-fit rounded-xl border bg-panel/95 shadow-2xl backdrop-blur transition-shadow',
          dragging || resizing ? 'border-accent2 ring-2 ring-accent2/40' : 'border-edge',
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
          <div className="flex items-center gap-0.5">
            {/* size steppers — only meaningful once tiles are visible */}
            {mediaStarted && !collapsed ? (
              <>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => bumpSize(-32)}
                  disabled={tileW <= TILE_MIN}
                  aria-label="Make video smaller"
                  className="rounded px-1.5 text-white/60 hover:bg-white/10 disabled:opacity-30"
                >
                  −
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => bumpSize(32)}
                  disabled={tileW >= TILE_MAX}
                  aria-label="Make video bigger"
                  className="rounded px-1.5 text-white/60 hover:bg-white/10 disabled:opacity-30"
                >
                  +
                </button>
              </>
            ) : null}
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
        </div>

        {!collapsed ? (
          <div className="px-2 pb-2">
            {/* not started yet — voice/video is off until the user opts in */}
            {!mediaStarted ? (
              <div className="w-44 rounded-lg bg-ink p-3 text-center">
                <p className="text-[11px] text-white/60">
                  Voice &amp; video are off. Turn them on to talk and see others.
                </p>
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-2 w-full"
                  onClick={startMedia}
                >
                  🎥 Start voice &amp; video
                </Button>
              </div>
            ) : null}

            {/* permission denied -> graceful text-chat-only degradation */}
            {mediaStarted && mediaPermission === 'denied' ? (
              <div className="w-40 rounded-lg bg-ink p-2 text-center">
                <p className="text-[11px] text-white/60">
                  Camera / mic unavailable. You can still watch and chat.
                </p>
                <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={retryMedia}>
                  Enable camera
                </Button>
              </div>
            ) : null}

            {mediaStarted && mediaPermission === 'prompt' ? (
              <p className="w-40 p-2 text-center text-[11px] text-white/50">
                Requesting camera &amp; mic…
              </p>
            ) : null}

            {mediaStarted ? (
              <div className="flex flex-wrap gap-1.5">
                {localStream ? (
                  <VideoTile
                    stream={localStream}
                    label="You"
                    muted
                    mirrored
                    audioOn={audioEnabled}
                    videoOn={videoEnabled}
                    width={tileW}
                  />
                ) : null}
                {remoteIds.map((id) => (
                  <VideoTile
                    key={id}
                    stream={remoteStreams[id]}
                    label={nameOf(id)}
                    width={tileW}
                  />
                ))}
                {remoteIds.length === 0 && mediaPermission !== 'denied' ? (
                  <div
                    className="flex items-center justify-center rounded-lg bg-ink text-center text-[10px] text-white/40"
                    style={{ width: tileW, height: Math.round(tileW * TILE_RATIO) }}
                  >
                    Waiting for others to join…
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* controls */}
            {mediaStarted && mediaPermission === 'granted' ? (
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

            {/* stop — fully release the camera/mic */}
            {mediaStarted ? (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1.5 w-full"
                onClick={stopMedia}
              >
                ⏹ Turn off voice &amp; video
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* corner resize handle — only while tiles are visible */}
        {mediaStarted && !collapsed ? (
          <div
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title="Drag to resize"
            aria-hidden="true"
            className={cn(
              'absolute bottom-0 right-0 h-4 w-4 touch-none rounded-br-xl',
              'cursor-se-resize',
              'after:absolute after:bottom-1 after:right-1 after:h-2 after:w-2',
              'after:border-b-2 after:border-r-2 after:border-white/40',
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
