// src/lib/socket/socketServer.js
/**
 * Server-side Socket.IO singleton + all room / signaling handlers.
 *
 * Responsibilities (spec §3 step-1 file 2):
 *   - join / leave with MAX_ROOM_OCCUPANCY enforcement
 *   - host assignment + host migration on disconnect
 *   - authoritative playback sync relay (sender-excluded — no self-echo)
 *   - WebRTC signaling relay scoped strictly to joined rooms
 *   - presence broadcast + disconnect cleanup
 *   - server-time stamping for client clock-skew correction
 *
 * Authored as CommonJS — `server.js` `require()`s this at the real HTTP layer.
 * All room state is in-memory (single-node MVP). A multi-node deployment would
 * swap the `rooms` Map for a Redis adapter; that is out of scope here.
 */
'use strict';

const { Server } = require('socket.io');
const T = require('../../features/rooms/room-types.js');

/**
 * In-memory room registry.
 * @type {Map<string, {
 *   peers: Map<string, import('../../features/rooms/room-types.js').Peer>,
 *   hostId: string|null,
 *   playback: import('../../features/rooms/room-types.js').PlaybackState,
 *   source: import('../../features/rooms/room-types.js').VideoSource|null
 * }>}
 */
const rooms = new Map();

/** Singleton guard — never attach two io instances to one HTTP server. */
let io = null;

/* ------------------------------------------------------------------ *
 * Room helpers
 * ------------------------------------------------------------------ */

function createRoom() {
  return {
    peers: new Map(),
    hostId: null,
    playback: { state: T.PLAYER_STATE.UNSTARTED, currentTime: 0, updatedAt: Date.now() },
    source: null,
    /** @type {Array<import('../../features/rooms/room-types.js').ChatPayload>} */
    messages: [], // recent chat history — survives a refresh / brief absence
    /** @type {NodeJS.Timeout|null} */
    emptyTimer: null, // grace-period deletion timer (see leaveRoom)
  };
}

/** @returns {Array<import('../../features/rooms/room-types.js').Peer>} */
function serializePeers(room) {
  return Array.from(room.peers.values()).map((p) => ({
    socketId: p.socketId,
    displayName: p.displayName,
    isHost: p.socketId === room.hostId,
    joinedAt: p.joinedAt,
  }));
}

/** Broadcast the full presence list + host id to everyone in the room. */
function broadcastPresence(roomId, room) {
  io.to(roomId).emit(T.SOCKET_EVENTS.PRESENCE_UPDATE, {
    roomId,
    hostId: room.hostId,
    peers: serializePeers(room),
  });
}

/** Build the full resync snapshot for one receiving socket. */
function buildSnapshot(roomId, room, selfId) {
  return {
    roomId,
    hostId: room.hostId,
    peers: serializePeers(room),
    playback: room.playback,
    source: room.source,
    messages: room.messages, // resync chat history on join / reconnect
    serverTime: Date.now(),
    selfId,
  };
}

/**
 * Promote a new host when the current one leaves: the oldest remaining peer
 * (smallest joinedAt) wins — deterministic, no election race (spec §3 gap #4).
 */
function migrateHost(roomId, room) {
  let oldest = null;
  room.peers.forEach((p) => {
    if (!oldest || p.joinedAt < oldest.joinedAt) oldest = p;
  });
  room.hostId = oldest ? oldest.socketId : null;
  if (room.hostId) {
    io.to(roomId).emit(T.SOCKET_EVENTS.HOST_CHANGED, { hostId: room.hostId });
  }
}

/* ------------------------------------------------------------------ *
 * Per-connection wiring
 * ------------------------------------------------------------------ */

function handleConnection(socket) {
  /**
   * Reject + log a malformed payload without crashing the room.
   * @param {string} where
   * @param {string} code
   */
  function reject(where, code) {
    // eslint-disable-next-line no-console
    console.warn(`[socket] rejected ${where} from ${socket.id} (${code})`);
    socket.emit(T.SOCKET_EVENTS.ROOM_ERROR, { code, where });
  }

  /** Resolve the room this socket has actually joined, or null. */
  function currentRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }

  /** True only if this socket is the authoritative host of its room. */
  function isHost() {
    const room = currentRoom();
    return !!room && room.hostId === socket.id;
  }

  /* ---- clock-skew anchor ---- */
  // Client emits TIME_SYNC and uses the ack to compute (serverTime - localTime).
  socket.on(T.SOCKET_EVENTS.TIME_SYNC, (_payload, ack) => {
    if (typeof ack === 'function') ack({ serverTime: Date.now() });
  });

  /* ---- ROOM_JOIN ---- */
  socket.on(T.SOCKET_EVENTS.ROOM_JOIN, (payload) => {
    try {
      if (!T.isValidJoinPayload(payload)) {
        reject('room:join', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
        return;
      }
      const { roomId, displayName } = payload;

      // One room per socket — leave any prior room first.
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        leaveRoom();
      }

      let room = rooms.get(roomId);
      if (!room) {
        room = createRoom();
        rooms.set(roomId, room);
      }
      // Someone (re)joined — cancel any pending grace-period deletion so the
      // chat history is kept.
      if (room.emptyTimer) {
        clearTimeout(room.emptyTimer);
        room.emptyTimer = null;
      }

      // Occupancy enforcement — reject the overflow connection cleanly.
      if (!room.peers.has(socket.id) && room.peers.size >= T.MAX_ROOM_OCCUPANCY) {
        socket.emit(T.SOCKET_EVENTS.ROOM_FULL, {
          roomId,
          max: T.MAX_ROOM_OCCUPANCY,
          code: T.ROOM_ERROR_CODE.ROOM_FULL,
        });
        return;
      }

      const peer = {
        socketId: socket.id,
        displayName: displayName.slice(0, 40),
        isHost: false,
        joinedAt: Date.now(),
      };
      room.peers.set(socket.id, peer);
      socket.data.roomId = roomId;
      socket.data.displayName = peer.displayName;
      socket.join(roomId);

      // First peer in the room becomes host.
      if (!room.hostId) room.hostId = socket.id;

      // Snapshot to the joiner (their full resync state).
      socket.emit(T.SOCKET_EVENTS.ROOM_JOINED, buildSnapshot(roomId, room, socket.id));

      // Tell existing peers a new WebRTC peer is available to dial.
      socket.to(roomId).emit(T.SOCKET_EVENTS.RTC_PEER_JOINED, {
        socketId: socket.id,
        displayName: peer.displayName,
      });

      broadcastPresence(roomId, room);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] room:join handler error', err);
      reject('room:join', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
    }
  });

  /* ---- authoritative sync relay (host only) ---- */

  /**
   * Relay an event to the rest of the room, sender excluded (kills self-echo).
   * Only the host may originate authoritative sync. Guests must use
   * CONTROL_REQUEST instead.
   * @param {string} eventName
   * @param {Function} validate
   * @param {Function} onValid receives the sanitized payload; may mutate room.
   */
  function relayFromHost(eventName, validate, onValid) {
    socket.on(eventName, (payload) => {
      try {
        const room = currentRoom();
        if (!room) return reject(eventName, T.ROOM_ERROR_CODE.NOT_IN_ROOM);
        if (room.hostId !== socket.id) {
          // Silently drop — a non-host emitting sync is a client bug, not abuse
          // worth a round-trip error. Guests are expected to use control:request.
          return reject(eventName, T.ROOM_ERROR_CODE.NOT_HOST);
        }
        if (!validate(payload)) {
          return reject(eventName, T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
        }
        const out = onValid(payload, room) || payload;
        out.serverTime = Date.now();
        out.originId = socket.id;
        socket.to(socket.data.roomId).emit(eventName, out);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[socket] ${eventName} handler error`, err);
      }
    });
  }

  relayFromHost(T.SOCKET_EVENTS.SYNC_PLAY, T.isValidSyncPayload, (p, room) => {
    room.playback = { state: T.PLAYER_STATE.PLAYING, currentTime: p.currentTime, updatedAt: Date.now() };
    return { state: T.PLAYER_STATE.PLAYING, currentTime: p.currentTime };
  });

  relayFromHost(T.SOCKET_EVENTS.SYNC_PAUSE, T.isValidSyncPayload, (p, room) => {
    room.playback = { state: T.PLAYER_STATE.PAUSED, currentTime: p.currentTime, updatedAt: Date.now() };
    return { state: T.PLAYER_STATE.PAUSED, currentTime: p.currentTime };
  });

  relayFromHost(T.SOCKET_EVENTS.SYNC_SEEK, T.isValidSeekPayload, (p, room) => {
    room.playback = { ...room.playback, currentTime: p.currentTime, updatedAt: Date.now() };
    return { currentTime: p.currentTime };
  });

  relayFromHost(T.SOCKET_EVENTS.SYNC_HEARTBEAT, T.isValidHeartbeatPayload, (p, room) => {
    room.playback = { state: p.state, currentTime: p.currentTime, updatedAt: Date.now() };
    return { state: p.state, currentTime: p.currentTime };
  });

  // SYNC_BUFFERING is intentionally NOT host-gated: buffering is a network
  // condition, not a control action. ANY peer that stalls must be able to pause
  // the room so everyone waits together (spec §3 gap #5).
  socket.on(T.SOCKET_EVENTS.SYNC_BUFFERING, (payload) => {
    try {
      const room = currentRoom();
      if (!room) return reject('sync:buffering', T.ROOM_ERROR_CODE.NOT_IN_ROOM);
      if (!T.isValidBufferingPayload(payload)) {
        return reject('sync:buffering', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
      }
      socket.to(socket.data.roomId).emit(T.SOCKET_EVENTS.SYNC_BUFFERING, {
        buffering: payload.buffering,
        originId: socket.id,
        serverTime: Date.now(),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] sync:buffering handler error', err);
    }
  });

  relayFromHost(T.SOCKET_EVENTS.SOURCE_CHANGE, T.isValidSourcePayload, (p, room) => {
    room.source = {
      kind: p.kind,
      url: p.url,
      videoId: p.videoId,
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : undefined,
    };
    // A new video resets playback to the start, paused.
    room.playback = { state: T.PLAYER_STATE.UNSTARTED, currentTime: 0, updatedAt: Date.now() };
    return { ...room.source };
  });

  /* ---- CONTROL_REQUEST (guest -> host) ---- */
  socket.on(T.SOCKET_EVENTS.CONTROL_REQUEST, (payload) => {
    try {
      const room = currentRoom();
      if (!room) return reject('control:request', T.ROOM_ERROR_CODE.NOT_IN_ROOM);
      if (!T.isObject(payload) || !T.isNonEmptyString(payload.action)) {
        return reject('control:request', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
      }
      if (!room.hostId) return;
      // Forward verbatim to the host only; host's client decides + echoes back.
      io.to(room.hostId).emit(T.SOCKET_EVENTS.CONTROL_REQUEST, {
        ...payload,
        requesterId: socket.id,
        requesterName: socket.data.displayName,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] control:request handler error', err);
    }
  });

  /* ---- SYNC_REQUEST (guest asks for fresh state, e.g. after reconnect) ---- */
  socket.on(T.SOCKET_EVENTS.SYNC_REQUEST, () => {
    const room = currentRoom();
    if (!room) return;
    socket.emit(T.SOCKET_EVENTS.ROOM_JOINED, buildSnapshot(socket.data.roomId, room, socket.id));
  });

  /* ---- CHAT ---- */
  socket.on(T.SOCKET_EVENTS.CHAT_MESSAGE, (payload) => {
    try {
      const room = currentRoom();
      if (!room) return reject('chat:message', T.ROOM_ERROR_CODE.NOT_IN_ROOM);
      if (!T.isValidChatPayload(payload)) {
        return reject('chat:message', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
      }
      // Server is the single source of truth for identity + timestamp.
      const message = {
        id: payload.id,
        socketId: socket.id,
        displayName: socket.data.displayName,
        text: payload.text.slice(0, T.MAX_CHAT_LENGTH),
        sentAt: Date.now(),
        seenBy: [],
      };
      // Carry a sanitized reply reference if this is a reply.
      if (payload.replyTo && T.isValidReplyRef(payload.replyTo)) {
        message.replyTo = {
          id: payload.replyTo.id,
          displayName: String(payload.replyTo.displayName).slice(0, 40),
          text: String(payload.replyTo.text).slice(0, 160),
        };
      }
      // Persist to the room's history buffer (capped).
      room.messages.push(message);
      if (room.messages.length > T.CHAT_BUFFER_LIMIT) {
        room.messages = room.messages.slice(-T.CHAT_BUFFER_LIMIT);
      }
      io.to(socket.data.roomId).emit(T.SOCKET_EVENTS.CHAT_MESSAGE, message);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] chat:message handler error', err);
    }
  });

  socket.on(T.SOCKET_EVENTS.CHAT_TYPING, (payload) => {
    const room = currentRoom();
    if (!room || !T.isValidTypingPayload(payload)) return;
    socket.to(socket.data.roomId).emit(T.SOCKET_EVENTS.CHAT_TYPING, {
      socketId: socket.id,
      displayName: socket.data.displayName,
      typing: payload.typing,
    });
  });

  /* ---- CHAT_SEEN: read receipts ---- */
  socket.on(T.SOCKET_EVENTS.CHAT_SEEN, (payload) => {
    try {
      const room = currentRoom();
      if (!room || !T.isValidSeenPayload(payload)) return;
      // Mark every message up to (and including) the seen one — from OTHER
      // senders — as seen by this socket, so late joiners get accurate history.
      const idx = room.messages.findIndex((m) => m.id === payload.messageId);
      if (idx !== -1) {
        for (let i = 0; i <= idx; i += 1) {
          const m = room.messages[i];
          if (!Array.isArray(m.seenBy)) m.seenBy = [];
          if (m.socketId !== socket.id && m.seenBy.indexOf(socket.id) === -1) {
            m.seenBy.push(socket.id);
          }
        }
      }
      // Relay to the rest of the room so senders update their receipts live.
      socket.to(socket.data.roomId).emit(T.SOCKET_EVENTS.CHAT_SEEN, {
        socketId: socket.id,
        messageId: payload.messageId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] chat:seen handler error', err);
    }
  });

  /* ---- WebRTC signaling relay (scoped to the joined room) ---- */
  socket.on(T.SOCKET_EVENTS.RTC_SIGNAL, (payload) => {
    try {
      const room = currentRoom();
      if (!room) return reject('rtc:signal', T.ROOM_ERROR_CODE.NOT_IN_ROOM);
      if (!T.isValidRtcSignalPayload(payload)) {
        return reject('rtc:signal', T.ROOM_ERROR_CODE.INVALID_PAYLOAD);
      }
      // SECURITY (spec §3 gap #7): the target MUST be a peer in the SAME room.
      // This blocks relaying SDP/ICE into a room the socket never joined.
      if (!room.peers.has(payload.targetId)) {
        return reject('rtc:signal', T.ROOM_ERROR_CODE.NOT_IN_ROOM);
      }
      io.to(payload.targetId).emit(T.SOCKET_EVENTS.RTC_SIGNAL, {
        fromId: socket.id,
        signal: payload.signal,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[socket] rtc:signal handler error', err);
    }
  });

  /* ---- leave / disconnect ---- */
  function leaveRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    socket.leave(roomId);
    if (!room) return;

    const wasHost = room.hostId === socket.id;
    room.peers.delete(socket.id);

    if (room.peers.size === 0) {
      // Don't discard immediately — keep the room (and its chat history) for a
      // grace period so a solo user can refresh without losing the chat.
      if (room.emptyTimer) clearTimeout(room.emptyTimer);
      room.emptyTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.peers.size === 0) rooms.delete(roomId);
      }, T.ROOM_EMPTY_GRACE_MS);
      return;
    }

    socket.to(roomId).emit(T.SOCKET_EVENTS.RTC_PEER_LEFT, { socketId: socket.id });
    if (wasHost) migrateHost(roomId, room);
    broadcastPresence(roomId, room);
  }

  socket.on(T.SOCKET_EVENTS.ROOM_LEAVE, leaveRoom);
  socket.on('disconnect', leaveRoom);
}

/* ------------------------------------------------------------------ *
 * Public attach point
 * ------------------------------------------------------------------ */

/**
 * Attach the Socket.IO server to a Node HTTP server. Idempotent — returns the
 * existing instance if already attached.
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function attachSocketServer(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    path: '/api/socketio',
    cors: { origin: true, methods: ['GET', 'POST'] },
    // Socket.IO's own reconnection is client-driven; server just needs a sane
    // ping window so a closed tab frees its room slot promptly (spec §3 gap #9).
    pingInterval: 10000,
    pingTimeout: 8000,
  });

  io.on('connection', handleConnection);

  // eslint-disable-next-line no-console
  console.log('[socket] Socket.IO attached on path /api/socketio');
  return io;
}

module.exports = { attachSocketServer };
