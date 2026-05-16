// src/lib/socket/socketClient.js
/**
 * Client-side Socket.IO singleton — exactly ONE connection per browser tab.
 *
 * Why a singleton: React Strict Mode double-invokes effects in dev, and a room
 * page can mount/remount; without a singleton we'd leak duplicate sockets, each
 * holding a room slot. `getSocket()` always returns the same instance.
 *
 * Reconnection (spec §3 gap #3): Socket.IO's built-in exponential backoff is
 * configured here. The room re-join + fresh-heartbeat resync on reconnect is
 * handled by the useRoomSocket hook, which listens for the 'reconnect' event.
 */
'use client';

import { io } from 'socket.io-client';

/** @type {import('socket.io-client').Socket|null} */
let socket = null;

/**
 * Lazily create (or return) the per-tab socket. Does NOT auto-connect — the
 * caller decides when to `.connect()` so the connection lifecycle is explicit
 * and fully owned by useRoomSocket.
 * @returns {import('socket.io-client').Socket}
 */
export function getSocket() {
  if (socket) return socket;

  const url = process.env.NEXT_PUBLIC_SOCKET_URL || undefined; // undefined => same-origin

  socket = io(url, {
    path: '/api/socketio',
    autoConnect: false,
    transports: ['websocket', 'polling'],
    // Exponential backoff: 0.5s -> 1s -> 2s -> ... capped at 8s, forever.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
    randomizationFactor: 0.5,
    timeout: 10000,
  });

  return socket;
}

/**
 * Fully disconnect and drop the singleton so the next getSocket() builds a
 * clean instance. Call only on hard teardown (not on route changes within the
 * same room flow).
 */
export function destroySocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}
