// src/features/rooms/components/VideoController.jsx
'use client';

import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '@/components/ui/Button';
import { formatTime } from '@/lib/utils';
import { PLAYER_STATE } from '@/features/rooms/room-types';

/**
 * Playback control bar — play/pause + scrubber — wired to the sync engine.
 * Every control routes through the sync `request*` functions: the host acts
 * directly, a guest sends a CONTROL_REQUEST. The UI itself is identical for
 * both; authority is resolved inside useVideoSync.
 */
export default function VideoController({
  controllerRef,
  playbackState,
  onPlay,
  onPause,
  onSeek,
  isHost,
  onToggleFullscreen,
  isFullscreen,
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const pollRef = useRef(null);

  // Poll the controller a few times a second for the time display + scrubber.
  // This is display-only and does NOT drive sync (the heartbeat does that).
  useEffect(() => {
    pollRef.current = setInterval(() => {
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      if (!scrubbing) setCurrentTime(ctrl.getCurrentTime());
      setDuration(ctrl.getDuration());
    }, 250);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [controllerRef, scrubbing]);

  const isPlaying = playbackState === PLAYER_STATE.PLAYING;
  const displayTime = scrubbing ? scrubValue : currentTime;
  const max = duration > 0 ? duration : 0;

  return (
    <div className="flex items-center gap-1.5 border-t border-edge bg-panel px-2 py-2 sm:gap-3 sm:px-3">
      <Button
        size="icon"
        variant="ghost"
        aria-label={isPlaying ? 'Pause' : 'Play'}
        onClick={isPlaying ? onPause : onPlay}
        className="text-xl"
      >
        <span aria-hidden="true">{isPlaying ? '⏸' : '▶'}</span>
      </Button>

      <span className="w-9 text-right text-[11px] tabular-nums text-white/70 sm:w-12 sm:text-xs">
        {formatTime(displayTime)}
      </span>

      <input
        type="range"
        min={0}
        max={max || 1}
        step="0.1"
        value={Math.min(displayTime, max || 1)}
        aria-label="Seek"
        disabled={max === 0}
        onChange={(e) => {
          setScrubbing(true);
          setScrubValue(Number(e.target.value));
        }}
        onPointerUp={() => {
          if (scrubbing) {
            onSeek(scrubValue);
            setScrubbing(false);
          }
        }}
        onKeyUp={(e) => {
          if (scrubbing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            onSeek(scrubValue);
            setScrubbing(false);
          }
        }}
        className="h-1.5 flex-1 cursor-pointer accent-accent"
      />

      <span className="w-9 text-[11px] tabular-nums text-white/50 sm:w-12 sm:text-xs">
        {formatTime(max)}
      </span>

      {!isHost ? (
        <span
          className="hidden rounded bg-edge px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/50 sm:inline"
          title="Your controls are sent to the host, who applies them for everyone."
        >
          guest
        </span>
      ) : null}

      <Button
        size="icon"
        variant="ghost"
        aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
        onClick={onToggleFullscreen}
      >
        <span aria-hidden="true">{isFullscreen ? '🗗' : '⛶'}</span>
      </Button>
    </div>
  );
}

VideoController.propTypes = {
  controllerRef: PropTypes.shape({ current: PropTypes.object }).isRequired,
  playbackState: PropTypes.string.isRequired,
  onPlay: PropTypes.func.isRequired,
  onPause: PropTypes.func.isRequired,
  onSeek: PropTypes.func.isRequired,
  isHost: PropTypes.bool.isRequired,
  onToggleFullscreen: PropTypes.func.isRequired,
  isFullscreen: PropTypes.bool.isRequired,
};
