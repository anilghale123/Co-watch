// src/features/rooms/components/ChatSidebar.jsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import { SOCKET_EVENTS, MAX_CHAT_LENGTH } from '@/features/rooms/room-types';
import { generateMessageId } from '@/lib/utils';
import Button from '@/components/ui/Button';

/** Stable color per display name — purely cosmetic. */
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 72%)`;
}

/**
 * Presence list + intimate real-time text chat. The message list is an ARIA
 * live region so screen readers announce new messages.
 */
export default function ChatSidebar() {
  const chat = useRoomStore((s) => s.chat);
  const peers = useRoomStore((s) => s.peers);
  const selfId = useRoomStore((s) => s.selfId);
  const hostId = useRoomStore((s) => s.hostId);
  const typingPeers = useRoomStore((s) => s.typingPeers);

  const [draft, setDraft] = useState('');
  const listRef = useRef(null);
  const typingTimer = useRef(null);
  const isTypingRef = useRef(false);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // Stop broadcasting "typing" when this component unmounts.
  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (isTypingRef.current) {
      const socket = getSocket();
      if (socket && socket.connected) socket.emit(SOCKET_EVENTS.CHAT_TYPING, { typing: false });
    }
  }, []);

  function emitTyping(typing) {
    if (isTypingRef.current === typing) return;
    isTypingRef.current = typing;
    const socket = getSocket();
    if (socket && socket.connected) socket.emit(SOCKET_EVENTS.CHAT_TYPING, { typing });
  }

  function handleDraftChange(e) {
    setDraft(e.target.value);
    emitTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => emitTyping(false), 1500);
  }

  function sendMessage(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const socket = getSocket();
    if (!socket || !socket.connected) return;
    // Server stamps identity + time and echoes to everyone (incl. us); the
    // store dedupes by id, so we never double-render our own message.
    socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { id: generateMessageId(), text });
    setDraft('');
    emitTyping(false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }

  const typingNames = useMemo(
    () => Object.keys(typingPeers).filter((id) => id !== selfId).map((id) => typingPeers[id]),
    [typingPeers, selfId],
  );

  return (
    <div className="flex h-full flex-col">
      {/* presence */}
      <section aria-label="People in this room" className="border-b border-edge px-3 py-2">
        <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-white/40">
          In the room · {peers.length}
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          {peers.map((p) => (
            <li
              key={p.socketId}
              className="flex items-center gap-1 rounded-full bg-edge px-2 py-0.5 text-xs text-white/80"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-green-400"
                aria-hidden="true"
              />
              {p.displayName}
              {p.socketId === selfId ? ' (you)' : ''}
              {p.socketId === hostId ? (
                <span className="rounded bg-accent2/30 px-1 text-[10px] text-accent2">host</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* messages */}
      <ul
        ref={listRef}
        aria-live="polite"
        aria-label="Chat messages"
        className="flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {chat.length === 0 ? (
          <li className="text-sm text-white/30">No messages yet — say hi 👋</li>
        ) : null}
        {chat.map((m) => {
          const isSystem = m.socketId === 'system';
          const isSelf = m.socketId === selfId;
          if (isSystem) {
            return (
              <li key={m.id} className="text-center text-[11px] italic text-white/35">
                {m.text}
              </li>
            );
          }
          return (
            <li key={m.id} className={isSelf ? 'text-right' : 'text-left'}>
              <span
                className="block text-[11px] font-medium"
                style={{ color: nameColor(m.displayName || '?') }}
              >
                {isSelf ? 'You' : m.displayName}
              </span>
              <span
                className={[
                  'mt-0.5 inline-block max-w-[85%] break-words rounded-2xl px-3 py-1.5 text-sm',
                  isSelf ? 'bg-accent text-white' : 'bg-edge text-white/90',
                ].join(' ')}
              >
                {m.text}
              </span>
            </li>
          );
        })}
      </ul>

      {/* typing indicator */}
      <div className="h-5 px-3 text-[11px] text-white/40" aria-live="polite">
        {typingNames.length === 1 ? `${typingNames[0]} is typing…` : null}
        {typingNames.length > 1 ? `${typingNames.length} people are typing…` : null}
      </div>

      {/* composer */}
      <form onSubmit={sendMessage} className="flex gap-2 border-t border-edge p-3">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          onChange={handleDraftChange}
          maxLength={MAX_CHAT_LENGTH}
          autoComplete="off"
          placeholder="Message…"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-base text-white placeholder:text-white/30 focus:border-accent2 focus:outline-none sm:text-sm"
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
