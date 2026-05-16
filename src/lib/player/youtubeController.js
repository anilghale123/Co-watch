// src/lib/player/youtubeController.js
/**
 * YouTube Iframe Player API, wrapped behind the polymorphic controller
 * interface (spec §2.2). The sync layer never sees `window.YT` — only the
 * normalized `play / pause / seekTo / getCurrentTime / getDuration / getState /
 * destroy` surface.
 */
'use client';

import { PLAYER_STATE, youtubeCodeToState } from '@/features/rooms/room-types';

/** Module-level promise so the API script loads at most once per tab. */
let apiPromise = null;

/**
 * Load (once) the YouTube Iframe API and resolve when `window.YT.Player` is
 * usable.
 * @returns {Promise<void>}
 */
function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    // The API calls this global exactly once when it finishes loading.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve();
    };
    if (!document.getElementById('yt-iframe-api')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  });
  return apiPromise;
}

/**
 * @param {Object}   opts
 * @param {HTMLElement} opts.container Element the iframe is mounted into.
 * @param {import('@/features/rooms/room-types').VideoSource} opts.source
 * @param {(s:{state:string})=>void} opts.onStateChange
 * @param {()=>void} [opts.onReady]
 * @param {(e:any)=>void} [opts.onError]
 * @returns {import('./createPlayerController').PlayerController}
 */
export function createYouTubeController({ container, source, onStateChange, onReady, onError }) {
  /** @type {any} */
  let player = null;
  let ready = false;
  let destroyed = false;
  /** Commands issued before the player is ready, replayed on ready. */
  const queue = [];
  let lastState = PLAYER_STATE.UNSTARTED;

  // Dedicated child node — YT replaces it wholesale with an <iframe>.
  const mountNode = document.createElement('div');
  mountNode.style.width = '100%';
  mountNode.style.height = '100%';
  container.appendChild(mountNode);

  function flushQueue() {
    while (queue.length) {
      const fn = queue.shift();
      try { fn(); } catch (err) { /* eslint-disable-line no-console */ console.error('[yt] queued cmd failed', err); }
    }
  }

  /** Run now if ready, else defer until onReady. */
  function whenReady(fn) {
    if (ready && player) fn();
    else queue.push(fn);
  }

  loadYouTubeApi().then(() => {
    if (destroyed) return;
    player = new window.YT.Player(mountNode, {
      videoId: source.videoId,
      playerVars: {
        autoplay: 0,
        controls: 0, // our own VideoController drives playback
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          if (destroyed) return;
          ready = true;
          flushQueue();
          if (onReady) onReady();
        },
        onStateChange: (e) => {
          if (destroyed) return;
          const normalized = youtubeCodeToState(e.data);
          lastState = normalized;
          onStateChange({ state: normalized });
        },
        onError: (e) => {
          if (onError) onError(e);
        },
      },
    });
  });

  return {
    kind: 'youtube',
    play() {
      whenReady(() => player.playVideo());
    },
    pause() {
      whenReady(() => player.pauseVideo());
    },
    seekTo(seconds) {
      whenReady(() => player.seekTo(Math.max(0, seconds), true));
    },
    getCurrentTime() {
      try { return player && ready ? player.getCurrentTime() || 0 : 0; }
      catch { return 0; }
    },
    getDuration() {
      try { return player && ready ? player.getDuration() || 0 : 0; }
      catch { return 0; }
    },
    getState() {
      if (!player || !ready) return PLAYER_STATE.UNSTARTED;
      try { return youtubeCodeToState(player.getPlayerState()); }
      catch { return lastState; }
    },
    isReady() {
      return ready;
    },
    destroy() {
      // Full teardown — leaked YT iframe APIs are a graded fail (spec §4).
      destroyed = true;
      ready = false;
      queue.length = 0;
      try { if (player && player.destroy) player.destroy(); }
      catch (err) { /* eslint-disable-line no-console */ console.error('[yt] destroy failed', err); }
      player = null;
      try { if (mountNode.parentNode) mountNode.parentNode.removeChild(mountNode); }
      catch { /* node already gone */ }
    },
  };
}
