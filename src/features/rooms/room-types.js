// src/features/rooms/room-types.js
/**
 * Authoritative real-time contract for the co-watching app.
 *
 * This is the JavaScript replacement for the spec's `room-types.ts`. Because we
 * have no compiler to enforce shapes, this module provides three things:
 *
 *   1. JSDoc `@typedef` blocks — the documented shape of every socket payload.
 *   2. `Object.freeze`d constant objects — runtime-safe replacements for TS
 *      enums (event names, player states, source kinds).
 *   3. Runtime validators — small pure functions that guard EVERY inbound
 *      socket event. Untrusted payloads are the #1 crash vector without a type
 *      system; validate at the boundary, reject + log anything malformed.
 *
 * IMPORTANT: this file is authored as CommonJS so it can be `require()`d by the
 * custom Node server (server.js -> socketServer.js) AND `import`ed by client
 * React code (Next.js handles the CJS->ESM named-export interop). Keep it
 * dependency-free and side-effect-free.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Frozen constants (replace TypeScript enums)
 * ------------------------------------------------------------------ */

/**
 * Every socket event name, in one place. Freezing prevents accidental
 * mutation and makes typos throw `undefined` loudly instead of silently
 * sending the wrong string.
 */
const SOCKET_EVENTS = Object.freeze({
  // --- room lifecycle (client -> server) ---
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  // --- room lifecycle (server -> client) ---
  ROOM_JOINED: 'room:joined',
  ROOM_FULL: 'room:full',
  ROOM_ERROR: 'room:error',
  PRESENCE_UPDATE: 'presence:update',
  HOST_CHANGED: 'host:changed',

  // --- playback sync (host is authoritative) ---
  SYNC_PLAY: 'sync:play',
  SYNC_PAUSE: 'sync:pause',
  SYNC_SEEK: 'sync:seek',
  SYNC_HEARTBEAT: 'sync:heartbeat',
  SYNC_BUFFERING: 'sync:buffering',
  SYNC_REQUEST: 'sync:request', // guest asks host for a fresh snapshot
  SOURCE_CHANGE: 'source:change', // host swaps the loaded video
  CONTROL_REQUEST: 'control:request', // guest -> host: "please do X"

  // --- chat ---
  CHAT_MESSAGE: 'chat:message',
  CHAT_TYPING: 'chat:typing',

  // --- WebRTC signaling (server only relays, never touches media) ---
  RTC_SIGNAL: 'rtc:signal',
  RTC_PEER_JOINED: 'rtc:peer-joined',
  RTC_PEER_LEFT: 'rtc:peer-left',

  // --- clock skew ---
  TIME_SYNC: 'time:sync',
});

/**
 * Normalized player state. Both the YouTube Iframe API (numeric codes) and the
 * HTML5 `<video>` element (events) are mapped onto exactly these five values.
 */
const PLAYER_STATE = Object.freeze({
  UNSTARTED: 'unstarted',
  PLAYING: 'playing',
  PAUSED: 'paused',
  BUFFERING: 'buffering',
  ENDED: 'ended',
});

/** Supported video backends behind the polymorphic controller. */
const SOURCE_KIND = Object.freeze({
  YOUTUBE: 'youtube',
  HTML5: 'html5', // direct .mp4 / .webm / HLS .m3u8
});

/** Reason codes sent with ROOM_ERROR so the client can render specific copy. */
const ROOM_ERROR_CODE = Object.freeze({
  ROOM_FULL: 'ROOM_FULL',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
});

/* ------------------------------------------------------------------ *
 * Tunable constants
 * ------------------------------------------------------------------ */

/**
 * Max peers per room.
 *
 * NOTE / DEFENSIBLE DEVIATION: the source spec hard-caps rooms at 2 ("it's a
 * couples app"). The product owner explicitly asked to also support small
 * groups of friends. We therefore expose this as a single tunable constant and
 * default it to 8 — the practical ceiling for an unrelayed WebRTC mesh
 * (n*(n-1) connections). Set to 2 here to restore strict couples-only mode.
 */
const MAX_ROOM_OCCUPANCY = 8;

/** Chat buffer cap — bounds memory on long sessions (spec §2.3). */
const CHAT_BUFFER_LIMIT = 200;

/** Seek variance filter: drift <= this (seconds) does NOT trigger a hard seek. */
const SEEK_TOLERANCE_SECONDS = 1.0;

/** Host heartbeat cadence (spec §2.1). */
const HEARTBEAT_INTERVAL_MS = 2000;

/** Max chat message length accepted by the validator. */
const MAX_CHAT_LENGTH = 1000;

/* ------------------------------------------------------------------ *
 * Typedefs — the documented payload contract
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} Peer
 * @property {string}  socketId    Unique per connection.
 * @property {string}  displayName Human label shown in presence/chat.
 * @property {boolean} isHost      Exactly one peer in a room is host.
 * @property {number}  joinedAt    Server epoch ms — used for host migration.
 */

/**
 * @typedef {Object} VideoSource
 * @property {'youtube'|'html5'} kind
 * @property {string}  url       Original URL the user pasted.
 * @property {string=} videoId  YouTube 11-char id (youtube kind only).
 * @property {string=} title    Optional human label.
 */

/**
 * @typedef {Object} PlaybackState
 * @property {'unstarted'|'playing'|'paused'|'buffering'|'ended'} state
 * @property {number} currentTime Seconds into the video.
 * @property {number} updatedAt   Server epoch ms when this was last set.
 */

/**
 * @typedef {Object} RoomSnapshot
 * Sent on ROOM_JOINED and SYNC_REQUEST replies — the full resync payload.
 * @property {string}            roomId
 * @property {string}            hostId   socketId of the current host.
 * @property {Peer[]}            peers
 * @property {PlaybackState}     playback
 * @property {VideoSource|null}  source
 * @property {number}            serverTime Server epoch ms (clock-skew anchor).
 * @property {string}            selfId   The receiving socket's own id.
 */

/**
 * @typedef {Object} JoinPayload
 * @property {string} roomId
 * @property {string} displayName
 */

/**
 * @typedef {Object} SyncPayload
 * play / pause authoritative event from the host.
 * @property {'playing'|'paused'} state
 * @property {number} currentTime Seconds — where playback should be.
 * @property {number} serverTime  Server epoch ms the event was stamped.
 * @property {string} originId    socketId that originated the action.
 */

/**
 * @typedef {Object} SeekPayload
 * @property {number} currentTime Target seconds.
 * @property {number} serverTime  Server epoch ms stamp.
 * @property {string} originId
 */

/**
 * @typedef {Object} HeartbeatPayload
 * Low-frequency reconciliation tick from the host (every HEARTBEAT_INTERVAL_MS).
 * @property {'unstarted'|'playing'|'paused'|'buffering'|'ended'} state
 * @property {number} currentTime
 * @property {number} serverTime
 */

/**
 * @typedef {Object} BufferingPayload
 * @property {boolean} buffering true => peers auto-pause; false => resume.
 * @property {string}  originId
 */

/**
 * @typedef {Object} ChatPayload
 * @property {string} id          Client-generated message id.
 * @property {string} socketId    Sender.
 * @property {string} displayName Sender label.
 * @property {string} text        Message body (<= MAX_CHAT_LENGTH).
 * @property {number} sentAt      Server epoch ms (server overwrites).
 */

/**
 * @typedef {Object} TypingPayload
 * @property {string}  socketId
 * @property {string}  displayName
 * @property {boolean} typing
 */

/**
 * @typedef {Object} RtcSignalPayload
 * Opaque SDP / ICE blob relayed peer-to-peer. The server NEVER inspects
 * `signal` — it only checks routing fields and room membership.
 * @property {string} targetId socketId of the intended recipient.
 * @property {*}      signal   simple-peer signal data (offer/answer/candidate).
 */

/* ------------------------------------------------------------------ *
 * Primitive guards
 * ------------------------------------------------------------------ */

/** @returns {boolean} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @returns {boolean} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** @returns {boolean} A real, finite number (rejects NaN / Infinity). */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @returns {boolean} Finite and >= 0 — valid for time positions. */
function isNonNegativeNumber(v) {
  return isFiniteNumber(v) && v >= 0;
}

/** @returns {boolean} */
function isOneOf(v, frozenObj) {
  return Object.values(frozenObj).indexOf(v) !== -1;
}

/* ------------------------------------------------------------------ *
 * Inbound payload validators — guard every socket event
 * ------------------------------------------------------------------ */

/**
 * @param {*} p
 * @returns {boolean}
 */
function isValidJoinPayload(p) {
  return (
    isObject(p) &&
    isNonEmptyString(p.roomId) &&
    p.roomId.length <= 128 &&
    isNonEmptyString(p.displayName) &&
    p.displayName.length <= 40
  );
}

/**
 * Guards SYNC_PLAY / SYNC_PAUSE / CONTROL_REQUEST(play|pause).
 * @param {*} p
 * @returns {boolean}
 */
function isValidSyncPayload(p) {
  return (
    isObject(p) &&
    (p.state === PLAYER_STATE.PLAYING || p.state === PLAYER_STATE.PAUSED) &&
    isNonNegativeNumber(p.currentTime)
  );
}

/**
 * Guards SYNC_SEEK / CONTROL_REQUEST(seek).
 * @param {*} p
 * @returns {boolean}
 */
function isValidSeekPayload(p) {
  return isObject(p) && isNonNegativeNumber(p.currentTime);
}

/**
 * @param {*} p
 * @returns {boolean}
 */
function isValidHeartbeatPayload(p) {
  return (
    isObject(p) &&
    isOneOf(p.state, PLAYER_STATE) &&
    isNonNegativeNumber(p.currentTime)
  );
}

/**
 * @param {*} p
 * @returns {boolean}
 */
function isValidBufferingPayload(p) {
  return isObject(p) && typeof p.buffering === 'boolean';
}

/**
 * @param {*} p
 * @returns {boolean}
 */
function isValidSourcePayload(p) {
  if (!isObject(p)) return false;
  if (!isOneOf(p.kind, SOURCE_KIND)) return false;
  if (!isNonEmptyString(p.url) || p.url.length > 2048) return false;
  if (p.kind === SOURCE_KIND.YOUTUBE && !isNonEmptyString(p.videoId)) return false;
  return true;
}

/**
 * Guards inbound CHAT_MESSAGE. Note `sentAt` is intentionally NOT trusted —
 * the server stamps it. We only require a usable text body + id.
 * @param {*} p
 * @returns {boolean}
 */
function isValidChatPayload(p) {
  return (
    isObject(p) &&
    isNonEmptyString(p.id) &&
    p.id.length <= 64 &&
    isNonEmptyString(p.text) &&
    p.text.length <= MAX_CHAT_LENGTH
  );
}

/**
 * @param {*} p
 * @returns {boolean}
 */
function isValidTypingPayload(p) {
  return isObject(p) && typeof p.typing === 'boolean';
}

/**
 * Guards RTC_SIGNAL. We validate routing only; `signal` is an opaque blob the
 * server must never interpret. `targetId` is checked again server-side against
 * actual room membership to prevent cross-room WebRTC hijack (spec §3 gap #7).
 * @param {*} p
 * @returns {boolean}
 */
function isValidRtcSignalPayload(p) {
  return (
    isObject(p) &&
    isNonEmptyString(p.targetId) &&
    p.signal !== undefined &&
    p.signal !== null
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Map a YouTube numeric player-state code to our normalized PLAYER_STATE.
 * YT codes: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
 * @param {number} code
 * @returns {string}
 */
function youtubeCodeToState(code) {
  switch (code) {
    case 1: return PLAYER_STATE.PLAYING;
    case 2: return PLAYER_STATE.PAUSED;
    case 3: return PLAYER_STATE.BUFFERING;
    case 0: return PLAYER_STATE.ENDED;
    default: return PLAYER_STATE.UNSTARTED; // -1 and 5 (cued)
  }
}

/* ------------------------------------------------------------------ *
 * Exports (CommonJS — see file header for the why)
 * ------------------------------------------------------------------ */

module.exports = {
  SOCKET_EVENTS,
  PLAYER_STATE,
  SOURCE_KIND,
  ROOM_ERROR_CODE,
  MAX_ROOM_OCCUPANCY,
  CHAT_BUFFER_LIMIT,
  SEEK_TOLERANCE_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  MAX_CHAT_LENGTH,
  // primitive guards
  isObject,
  isNonEmptyString,
  isFiniteNumber,
  isNonNegativeNumber,
  isOneOf,
  // payload validators
  isValidJoinPayload,
  isValidSyncPayload,
  isValidSeekPayload,
  isValidHeartbeatPayload,
  isValidBufferingPayload,
  isValidSourcePayload,
  isValidChatPayload,
  isValidTypingPayload,
  isValidRtcSignalPayload,
  // helpers
  youtubeCodeToState,
};
