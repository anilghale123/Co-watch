// src/lib/player/html5Controller.js
/**
 * Native HTML5 `<video>` controller — direct `.mp4` / `.webm` files and HLS
 * `.m3u8` streams — wrapped behind the same polymorphic interface as the
 * YouTube controller (spec §2.2).
 *
 * HLS strategy (spec §2.2 / §3 gap #10): if the browser can natively play
 * `application/vnd.apple.mpegurl` (Safari, iOS) we just set `video.src`.
 * Otherwise we lazy-load `hls.js` and attach it. The lazy import keeps hls.js
 * out of the bundle for the common non-HLS case.
 */
'use client';

import { PLAYER_STATE } from '@/features/rooms/room-types';
import { isHlsUrl } from '@/lib/utils';

/**
 * @param {Object}   opts
 * @param {HTMLElement} opts.container
 * @param {import('@/features/rooms/room-types').VideoSource} opts.source
 * @param {(s:{state:string})=>void} opts.onStateChange
 * @param {()=>void} [opts.onReady]
 * @param {(e:any)=>void} [opts.onError]
 * @returns {import('./createPlayerController').PlayerController}
 */
export function createHtml5Controller({ container, source, onStateChange, onReady, onError }) {
  let destroyed = false;
  let ready = false;
  /** @type {any} hls.js instance, if used. */
  let hls = null;

  const video = document.createElement('video');
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.background = '#000';
  video.playsInline = true;
  video.controls = false; // our own VideoController drives playback
  video.preload = 'auto';
  container.appendChild(video);

  /** Emit a normalized state to the sync layer. */
  function emit(state) {
    if (!destroyed) onStateChange({ state });
  }

  // --- DOM event listeners (kept by reference so destroy() can remove them) ---
  const listeners = {
    playing: () => emit(PLAYER_STATE.PLAYING),
    play: () => emit(PLAYER_STATE.PLAYING),
    pause: () => {
      // A pause at the very end is really "ended"; let the ended handler win.
      if (!video.ended) emit(PLAYER_STATE.PAUSED);
    },
    waiting: () => emit(PLAYER_STATE.BUFFERING),
    ended: () => emit(PLAYER_STATE.ENDED),
    loadedmetadata: () => {
      ready = true;
      if (onReady) onReady();
    },
    error: () => {
      if (onError) onError(video.error || new Error('HTML5 video error'));
    },
  };
  Object.keys(listeners).forEach((evt) => video.addEventListener(evt, listeners[evt]));

  // --- source attach ---
  if (isHlsUrl(source.url)) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari / iOS) — no library needed.
      video.src = source.url;
    } else {
      // Lazy-load hls.js for everyone else.
      import('hls.js')
        .then(({ default: Hls }) => {
          if (destroyed) return;
          if (Hls.isSupported()) {
            hls = new Hls({ enableWorker: true });
            hls.loadSource(source.url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (data && data.fatal && onError) onError(data);
            });
          } else {
            // Last-resort attempt; may fail, error listener will report it.
            video.src = source.url;
          }
        })
        .catch((err) => { if (onError) onError(err); });
    }
  } else {
    video.src = source.url;
  }

  return {
    kind: 'html5',
    play() {
      // Browsers reject play() with a promise rejection if not allowed; swallow
      // it — the user can retry via the controls.
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    },
    pause() {
      video.pause();
    },
    seekTo(seconds) {
      try { video.currentTime = Math.max(0, seconds); }
      catch { /* not seekable yet */ }
    },
    getCurrentTime() {
      return Number.isFinite(video.currentTime) ? video.currentTime : 0;
    },
    getDuration() {
      return Number.isFinite(video.duration) ? video.duration : 0;
    },
    getState() {
      if (video.ended) return PLAYER_STATE.ENDED;
      if (video.readyState < 3 && !video.paused) return PLAYER_STATE.BUFFERING;
      if (!ready) return PLAYER_STATE.UNSTARTED;
      return video.paused ? PLAYER_STATE.PAUSED : PLAYER_STATE.PLAYING;
    },
    isReady() {
      return ready;
    },
    destroy() {
      // Full teardown — remove every listener by reference, detach hls.js,
      // release the media element (spec §4 memory-cleanup grading).
      destroyed = true;
      ready = false;
      Object.keys(listeners).forEach((evt) => video.removeEventListener(evt, listeners[evt]));
      try {
        if (hls) {
          hls.destroy();
          hls = null;
        }
      } catch (err) { /* eslint-disable-line no-console */ console.error('[html5] hls destroy failed', err); }
      try {
        video.pause();
        video.removeAttribute('src');
        video.load(); // forces the browser to drop the buffered stream
      } catch { /* element already detached */ }
      try { if (video.parentNode) video.parentNode.removeChild(video); }
      catch { /* already removed */ }
    },
  };
}
