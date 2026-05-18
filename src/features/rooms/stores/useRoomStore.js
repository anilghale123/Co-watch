// src/features/rooms/stores/useRoomStore.js
/**
 * Single Zustand store for ALL room state (spec §2.3).
 *
 * Design rules baked in here:
 *   - One store, no React Context. Sync events fire many times per second;
 *     Context would cascade re-renders across the whole tree and tank
 *     input/playback responsiveness.
 *   - FLAT shape. Every field a consumer might subscribe to is top-level, so a
 *     narrow selector (`useRoomStore(s => s.connectionStatus)`) re-renders only
 *     the components that actually depend on that slice.
 *   - The chat buffer is capped at CHAT_BUFFER_LIMIT to bound memory on long
 *     sessions.
 *   - This store MIRRORS playback state for UI display only. It is NOT the sync
 *     engine — the authoritative drift correction lives in useVideoSync (refs).
 */
'use client';

import { create } from 'zustand';
import {
  CHAT_BUFFER_LIMIT,
  PLAYER_STATE,
} from '@/features/rooms/room-types';

/** @typedef {'idle'|'connecting'|'connected'|'reconnecting'|'disconnected'} ConnectionStatus */
/** @typedef {'unknown'|'prompt'|'granted'|'denied'} MediaPermission */

/** The store's resettable initial state. */
const initialState = {
  /* ---- connection ---- */
  /** @type {ConnectionStatus} */
  connectionStatus: 'idle',
  /** @type {{code:string, where?:string}|null} */
  socketError: null,
  /** True when the room rejected this socket for being full. */
  roomFull: false,

  /* ---- identity / presence ---- */
  roomId: null,
  selfId: null,
  hostId: null,
  displayName: '',
  /** @type {Array<import('@/features/rooms/room-types').Peer>} */
  peers: [],

  /* ---- playback mirror (display only) ---- */
  /** @type {string} */
  playbackState: PLAYER_STATE.UNSTARTED,
  playbackTime: 0,
  /** @type {import('@/features/rooms/room-types').VideoSource|null} */
  source: null,
  /** Remote peer is buffering -> UI shows a "waiting for…" hint. */
  remoteBuffering: false,

  /* ---- chat ---- */
  /** @type {Array<import('@/features/rooms/room-types').ChatPayload>} */
  chat: [],
  /** Map socketId -> displayName for peers currently typing. */
  typingPeers: {},
  /** Message currently being replied to, or null. */
  replyTarget: null,

  /* ---- clock skew (spec §3 gap #6) ---- */
  /** serverTime - localTime, in ms. Added to Date.now() to get server time. */
  clockOffset: 0,

  /* ---- WebRTC media permission (spec §3 gap #8) ---- */
  /** @type {MediaPermission} */
  mediaPermission: 'unknown',

  /* ---- screen sharing ---- */
  /**
   * Who (if anyone) is screen-sharing into the theater. `streamId` is the
   * MediaStream id used to pick the screen stream out of the WebRTC mesh.
   * @type {{sharing:boolean, streamId:string|null, sharerId:string|null}}
   */
  screenShare: { sharing: false, streamId: null, sharerId: null },
};

export const useRoomStore = create((set, get) => ({
  ...initialState,

  /* ---------------- connection actions ---------------- */

  /** @param {ConnectionStatus} status */
  setConnectionStatus: (status) => set({ connectionStatus: status }),

  /** @param {{code:string, where?:string}|null} err */
  setSocketError: (err) => set({ socketError: err }),

  /** @param {boolean} full */
  setRoomFull: (full) => set({ roomFull: full }),

  /* ---------------- identity / presence ---------------- */

  /** @param {string} roomId @param {string} displayName */
  initRoom: (roomId, displayName) => set({ roomId, displayName }),

  /**
   * Apply a full RoomSnapshot (ROOM_JOINED / SYNC_REQUEST reply). This is the
   * authoritative resync path used on join and on reconnect. Chat history from
   * the snapshot is MERGED with any local messages (deduped by id) so a refresh
   * restores the conversation without dropping in-flight optimistic messages.
   * @param {import('@/features/rooms/room-types').RoomSnapshot} snap
   */
  applyRoomSnapshot: (snap) =>
    set((s) => {
      let chat = s.chat;
      if (Array.isArray(snap.messages) && snap.messages.length) {
        const byId = new Map();
        s.chat.forEach((m) => byId.set(m.id, m));
        snap.messages.forEach((m) => {
          const existing = byId.get(m.id);
          byId.set(m.id, existing ? { ...existing, ...m } : m);
        });
        chat = Array.from(byId.values()).sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
        if (chat.length > CHAT_BUFFER_LIMIT) chat = chat.slice(chat.length - CHAT_BUFFER_LIMIT);
      }
      return {
        selfId: snap.selfId,
        hostId: snap.hostId,
        peers: Array.isArray(snap.peers) ? snap.peers : [],
        source: snap.source || null,
        screenShare: snap.screen && snap.screen.sharing
          ? {
            sharing: true,
            streamId: snap.screen.streamId || null,
            sharerId: snap.screen.sharerId || null,
          }
          : { sharing: false, streamId: null, sharerId: null },
        playbackState: snap.playback ? snap.playback.state : PLAYER_STATE.UNSTARTED,
        playbackTime: snap.playback ? snap.playback.currentTime : 0,
        chat,
        roomFull: false,
        socketError: null,
      };
    }),

  /** @param {{hostId:string, peers:Array}} p */
  setPresence: (p) =>
    set({
      hostId: p.hostId,
      peers: Array.isArray(p.peers) ? p.peers : [],
    }),

  /** @param {string} hostId */
  setHost: (hostId) => set({ hostId }),

  /* ---------------- playback mirror ---------------- */

  /** @param {{state?:string, currentTime?:number}} p */
  setPlaybackMirror: (p) =>
    set((s) => ({
      playbackState: p.state !== undefined ? p.state : s.playbackState,
      playbackTime: p.currentTime !== undefined ? p.currentTime : s.playbackTime,
    })),

  /** @param {import('@/features/rooms/room-types').VideoSource|null} source */
  setSource: (source) =>
    set({
      source,
      playbackState: PLAYER_STATE.UNSTARTED,
      playbackTime: 0,
    }),

  /** @param {boolean} buffering */
  setRemoteBuffering: (buffering) => set({ remoteBuffering: buffering }),

  /* ---------------- chat ---------------- */

  /**
   * Insert OR merge a chat message (upsert), keeping the last CHAT_BUFFER_LIMIT
   * and ordered by sentAt. Merging by id means a server echo updates the
   * matching local optimistic message in place (no duplicate, no flicker).
   * @param {import('@/features/rooms/room-types').ChatPayload} msg
   */
  addChatMessage: (msg) =>
    set((s) => {
      const idx = s.chat.findIndex((m) => m.id === msg.id);
      let next = s.chat.slice();
      if (idx !== -1) {
        next[idx] = { ...next[idx], ...msg };
      } else {
        next.push(msg);
        if (next.length > CHAT_BUFFER_LIMIT) next = next.slice(next.length - CHAT_BUFFER_LIMIT);
      }
      next.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
      return { chat: next };
    }),

  /**
   * Set the sender-local delivery status of one message.
   * @param {string} id
   * @param {string} status one of MESSAGE_STATUS
   */
  setMessageStatus: (id, status) =>
    set((s) => {
      const idx = s.chat.findIndex((m) => m.id === id);
      if (idx === -1) return s;
      const next = s.chat.slice();
      next[idx] = { ...next[idx], status };
      return { chat: next };
    }),

  /**
   * Apply a read receipt: mark every message up to (and including) `messageId`
   * as seen by `seerId`. The UI derives a "Seen" status from a non-empty
   * `seenBy`.
   * @param {string} seerId
   * @param {string} messageId
   */
  markSeenUpTo: (seerId, messageId) =>
    set((s) => {
      const idx = s.chat.findIndex((m) => m.id === messageId);
      if (idx === -1) return s;
      const next = s.chat.slice();
      for (let i = 0; i <= idx; i += 1) {
        const m = next[i];
        const seenBy = Array.isArray(m.seenBy) ? m.seenBy : [];
        if (m.socketId !== seerId && seenBy.indexOf(seerId) === -1) {
          next[i] = { ...m, seenBy: seenBy.concat(seerId) };
        }
      }
      return { chat: next };
    }),

  /** @param {import('@/features/rooms/room-types').ChatPayload|null} msg */
  setReplyTarget: (msg) => set({ replyTarget: msg }),

  /** Append a local-only system notice to the chat stream. */
  addSystemMessage: (text) =>
    get().addChatMessage({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      socketId: 'system',
      displayName: 'System',
      text,
      sentAt: Date.now(),
    }),

  /** @param {string} socketId @param {string} displayName @param {boolean} typing */
  setTyping: (socketId, displayName, typing) =>
    set((s) => {
      const next = { ...s.typingPeers };
      if (typing) next[socketId] = displayName;
      else delete next[socketId];
      return { typingPeers: next };
    }),

  /* ---------------- clock skew ---------------- */

  /** @param {number} offsetMs serverTime - localTime */
  setClockOffset: (offsetMs) => set({ clockOffset: offsetMs }),

  /* ---------------- media permission ---------------- */

  /** @param {MediaPermission} perm */
  setMediaPermission: (perm) => set({ mediaPermission: perm }),

  /* ---------------- screen sharing ---------------- */

  /** @param {{sharing:boolean, streamId:string|null, sharerId:string|null}} s */
  setScreenShare: (s) => set({ screenShare: s }),

  /* ---------------- teardown ---------------- */

  /** Full reset — call on room exit so a re-join starts clean. */
  reset: () => set({ ...initialState }),
}));

/* ------------------------------------------------------------------ *
 * Derived selectors — import and pass directly to useRoomStore(...).
 * Keeping derivations here (not inline) keeps consumer components terse.
 * ------------------------------------------------------------------ */

/** @returns {(s:any)=>boolean} true when this client is the authoritative host. */
export const selectIsHost = (s) => !!s.selfId && s.selfId === s.hostId;

/** @returns {(s:any)=>number} occupant count. */
export const selectPeerCount = (s) => s.peers.length;
