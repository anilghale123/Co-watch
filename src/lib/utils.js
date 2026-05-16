// src/lib/utils.js
/**
 * Shared, framework-agnostic utilities. Pure functions only — no React, no
 * socket, no side effects — so they are trivially testable.
 */

import { SOURCE_KIND } from '@/features/rooms/room-types';

/**
 * Tiny classnames joiner. Falsy entries are dropped.
 * @param {...(string|false|null|undefined)} parts
 * @returns {string}
 */
export function cn(...parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Clamp a number into [min, max].
 * @param {number} n @param {number} min @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Generate an unguessable room id (spec §3 gap #7). Falls back to a manual
 * v4-ish builder if `crypto.randomUUID` is unavailable (older Safari).
 * @returns {string}
 */
export function generateRoomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: still uses CSPRNG bytes where available.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** Short, readable client message id (not security-sensitive). */
export function generateMessageId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Format seconds as `m:ss` or `h:mm:ss`.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** @param {string} url @returns {boolean} */
export function isHlsUrl(url) {
  return /\.m3u8(\?.*)?$/i.test(url);
}

/**
 * Extract an 11-char YouTube video id from any common URL form.
 * @param {string} url
 * @returns {string|null}
 */
export function extractYouTubeId(url) {
  if (typeof url !== 'string') return null;
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i,
    /(?:youtu\.be\/)([\w-]{11})/i,
    /(?:youtube\.com\/embed\/)([\w-]{11})/i,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/i,
    /(?:youtube\.com\/live\/)([\w-]{11})/i,
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const m = url.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Turn a user-pasted URL into a normalized VideoSource, or return an error.
 *
 * Supported: YouTube (any URL form) and direct video files / HLS streams
 * (`.mp4`, `.webm`, `.ogg`, `.m3u8`). DRM-protected services (Netflix,
 * Disney+, Prime, etc.) CANNOT be embedded or synced — their players forbid
 * iframing and encrypt the stream — so they are rejected with clear copy.
 *
 * @param {string} rawUrl
 * @returns {{ ok:true, source:import('@/features/rooms/room-types').VideoSource }
 *          |{ ok:false, error:string }}
 */
export function parseVideoSource(rawUrl) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return { ok: false, error: 'Please paste a video link.' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) links are supported.' };
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  // --- DRM services we cannot legally or technically sync ---
  const drmHosts = ['netflix.com', 'disneyplus.com', 'hotstar.com', 'primevideo.com', 'hulu.com', 'max.com', 'hbomax.com'];
  if (drmHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return {
      ok: false,
      error:
        'DRM-protected services (Netflix, Disney+, Prime, etc.) cannot be embedded or synced. Use a YouTube link or a direct video file (.mp4 / .m3u8).',
    };
  }

  // --- YouTube ---
  const ytId = extractYouTubeId(url);
  if (ytId) {
    return {
      ok: true,
      source: { kind: SOURCE_KIND.YOUTUBE, url, videoId: ytId, title: 'YouTube video' },
    };
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    return { ok: false, error: 'Could not read a video id from that YouTube link.' };
  }

  // --- Direct media file / HLS stream ---
  if (isHlsUrl(url) || /\.(mp4|webm|ogg|ogv|mov|m4v)(\?.*)?$/i.test(url)) {
    return {
      ok: true,
      source: {
        kind: SOURCE_KIND.HTML5,
        url,
        title: decodeURIComponent(parsed.pathname.split('/').pop() || 'Video'),
      },
    };
  }

  return {
    ok: false,
    error:
      'Unsupported link. Paste a YouTube URL, or a direct video file (.mp4 / .webm) or HLS (.m3u8) stream.',
  };
}

/** No-op used as a safe default callback. */
export function noop() {}
