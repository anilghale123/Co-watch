// src/features/rooms/hooks/useRoomSocket.js
/**
 * Owns the socket CONNECTION LIFECYCLE for a room (spec §3 gaps #3, #4, #9):
 *   - connect -> join room -> apply snapshot
 *   - presence / host-migration updates into the Zustand store
 *   - reconnection: on reconnect, re-join and request a fresh resync
 *   - clock-skew measurement (server-time offset)
 *   - chat receive + typing indicators
 *   - tab-close teardown (`beforeunload`) so the room slot frees promptly
 *   - on unmount: ROOM_LEAVE, remove EVERY listener by reference, destroy socket
 *
 * Playback sync and WebRTC each own their own hook; this hook is purely the
 * connection + presence + chat backbone.
 */
'use client';

import { useEffect } from 'react';
import { getSocket, destroySocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import { SOCKET_EVENTS, MESSAGE_STATUS } from '@/features/rooms/room-types';

/**
 * @param {string} roomId
 * @param {string} displayName
 */
export function useRoomSocket(roomId, displayName) {
  useEffect(() => {
    if (!roomId || !displayName) return undefined;

    const socket = getSocket();
    const store = useRoomStore.getState();
    store.initRoom(roomId, displayName);
    store.setConnectionStatus('connecting');

    /** Measure server clock offset so variance math isn't poisoned by skew. */
    function measureClockOffset() {
      const t0 = Date.now();
      socket.emit(SOCKET_EVENTS.TIME_SYNC, {}, (res) => {
        if (!res || typeof res.serverTime !== 'number') return;
        const rtt = Date.now() - t0;
        // Best estimate: server stamped the reply ~rtt/2 ago.
        const offset = res.serverTime - (Date.now() - rtt / 2);
        useRoomStore.getState().setClockOffset(offset);
      });
    }

    /** (Re)join the room — used on first connect AND on every reconnect. */
    function joinRoom() {
      socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName });
    }

    /* ----------------- handlers (kept by reference for cleanup) -------------- */

    const onConnect = () => {
      useRoomStore.getState().setConnectionStatus('connected');
      useRoomStore.getState().setSocketError(null);
      joinRoom();
      measureClockOffset();
    };

    const onDisconnect = (reason) => {
      const s = useRoomStore.getState();
      // 'io client disconnect' is our own intentional teardown — not an error.
      if (reason === 'io client disconnect') return;
      s.setConnectionStatus('disconnected');
    };

    const onReconnectAttempt = () => {
      useRoomStore.getState().setConnectionStatus('reconnecting');
    };

    const onReconnect = () => {
      // Fresh connect handler will fire too, but make resync explicit.
      const s = useRoomStore.getState();
      s.setConnectionStatus('connected');
      joinRoom();
      socket.emit(SOCKET_EVENTS.SYNC_REQUEST);
      measureClockOffset();
      s.addSystemMessage('Reconnected — resynced with the room.');
    };

    const onConnectError = () => {
      useRoomStore.getState().setConnectionStatus('reconnecting');
    };

    const onRoomJoined = (snapshot) => {
      const s = useRoomStore.getState();
      s.applyRoomSnapshot(snapshot);
      if (typeof snapshot.serverTime === 'number') {
        // Coarse offset refresh from the snapshot stamp.
        s.setClockOffset(snapshot.serverTime - Date.now());
      }
    };

    const onPresenceUpdate = (p) => {
      useRoomStore.getState().setPresence(p);
    };

    const onHostChanged = ({ hostId }) => {
      const s = useRoomStore.getState();
      s.setHost(hostId);
      if (s.selfId === hostId) {
        s.addSystemMessage('You are now the host — playback controls are yours.');
      } else {
        const p = s.peers.find((x) => x.socketId === hostId);
        s.addSystemMessage(`${p ? p.displayName : 'Someone'} is now the host.`);
      }
    };

    const onRoomFull = (p) => {
      const s = useRoomStore.getState();
      s.setRoomFull(true);
      s.setConnectionStatus('disconnected');
      s.setSocketError({ code: p && p.code ? p.code : 'ROOM_FULL', where: 'room:join' });
    };

    const onRoomError = (err) => {
      // Validation rejections etc. — surface but don't kill the room.
      useRoomStore.getState().setSocketError(err || { code: 'UNKNOWN' });
    };

    const onChatMessage = (msg) => {
      const s = useRoomStore.getState();
      s.addChatMessage(msg);
      // Our own message echoed back by the server => it was delivered.
      if (msg.socketId === s.selfId) {
        const merged = useRoomStore.getState().chat.find((m) => m.id === msg.id);
        const seen = merged && Array.isArray(merged.seenBy) && merged.seenBy.length > 0;
        if (!seen) s.setMessageStatus(msg.id, MESSAGE_STATUS.DELIVERED);
      }
    };

    const onChatTyping = (p) => {
      useRoomStore.getState().setTyping(p.socketId, p.displayName, p.typing);
    };

    const onChatSeen = (p) => {
      if (!p || !p.socketId || !p.messageId) return;
      useRoomStore.getState().markSeenUpTo(p.socketId, p.messageId);
    };

    /* ----------------- register ----------------- */

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.io.on('reconnect', onReconnect);

    socket.on(SOCKET_EVENTS.ROOM_JOINED, onRoomJoined);
    socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
    socket.on(SOCKET_EVENTS.HOST_CHANGED, onHostChanged);
    socket.on(SOCKET_EVENTS.ROOM_FULL, onRoomFull);
    socket.on(SOCKET_EVENTS.ROOM_ERROR, onRoomError);
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
    socket.on(SOCKET_EVENTS.CHAT_TYPING, onChatTyping);
    socket.on(SOCKET_EVENTS.CHAT_SEEN, onChatSeen);

    if (socket.connected) onConnect();
    else socket.connect();

    /* ----------------- tab-close teardown (spec §3 gap #9) ----------------- */
    const onBeforeUnload = (event) => {
      try {
        socket.emit(SOCKET_EVENTS.ROOM_LEAVE);
      } catch { /* page is going away anyway */ }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    /* ----------------- cleanup ----------------- */
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      try { socket.emit(SOCKET_EVENTS.ROOM_LEAVE); } catch { /* not connected */ }

      // Remove EVERY listener by reference (never removeAllListeners — that
      // would also nuke listeners other hooks registered on the singleton).
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect', onReconnect);
      socket.off(SOCKET_EVENTS.ROOM_JOINED, onRoomJoined);
      socket.off(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
      socket.off(SOCKET_EVENTS.HOST_CHANGED, onHostChanged);
      socket.off(SOCKET_EVENTS.ROOM_FULL, onRoomFull);
      socket.off(SOCKET_EVENTS.ROOM_ERROR, onRoomError);
      socket.off(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
      socket.off(SOCKET_EVENTS.CHAT_TYPING, onChatTyping);
      socket.off(SOCKET_EVENTS.CHAT_SEEN, onChatSeen);

      destroySocket();
      useRoomStore.getState().reset();
    };
  }, [roomId, displayName]);
}
