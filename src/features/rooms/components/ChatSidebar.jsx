// src/features/rooms/components/ChatSidebar.jsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import { SOCKET_EVENTS, MAX_CHAT_LENGTH, MESSAGE_STATUS } from '@/features/rooms/room-types';
import { generateMessageId } from '@/lib/utils';
import Button from '@/components/ui/Button';

/** Stable color per display name — purely cosmetic. */
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 72%)`;
}

/** Derive the Messenger-style delivery status of one of MY messages. */
function ownStatus(m) {
  if (Array.isArray(m.seenBy) && m.seenBy.length > 0) return MESSAGE_STATUS.SEEN;
  if (m.status === MESSAGE_STATUS.SENDING) return MESSAGE_STATUS.SENDING;
  return MESSAGE_STATUS.DELIVERED;
}

/** Small receipt line shown beneath my own messages. */
function Receipt({ message }) {
  const status = ownStatus(message);
  if (status === MESSAGE_STATUS.SENDING) {
    return <span className="text-[10px] text-white/35">🕓 Sending…</span>;
  }
  if (status === MESSAGE_STATUS.SEEN) {
    const n = Array.isArray(message.seenBy) ? message.seenBy.length : 0;
    return (
      <span className="text-[10px] font-medium text-accent">
        ✓✓ {n > 1 ? `Seen by ${n}` : 'Seen'}
      </span>
    );
  }
  return <span className="text-[10px] text-white/40">✓✓ Delivered</span>;
}

/**
 * Presence list + intimate real-time text chat with Messenger-style replies and
 * read receipts (sent / delivered / seen). The message list is an ARIA live
 * region so screen readers announce new messages.
 */
export default function ChatSidebar() {
  const chat = useRoomStore((s) => s.chat);
  const peers = useRoomStore((s) => s.peers);
  const selfId = useRoomStore((s) => s.selfId);
  const hostId = useRoomStore((s) => s.hostId);
  const displayName = useRoomStore((s) => s.displayName);
  const typingPeers = useRoomStore((s) => s.typingPeers);
  const replyTarget = useRoomStore((s) => s.replyTarget);
  const setReplyTarget = useRoomStore((s) => s.setReplyTarget);

  const [draft, setDraft] = useState('');
  const listRef = useRef(null);
  const typingTimer = useRef(null);
  const isTypingRef = useRef(false);
  const lastSeenSent = useRef(null);
  const inputRef = useRef(null);

  // Is the chat actually on-screen? (false when collapsed on desktop or on the
  // Watch tab on mobile — a display:none element does not intersect.)
  const [listVisible, setListVisible] = useState(true);
  const [docVisible, setDocVisible] = useState(true);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // Track whether the message list is visible on screen.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(
      (entries) => setListVisible(entries[0] ? entries[0].isIntersecting : true),
      { threshold: 0.02 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Track tab/app visibility.
  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Emit a read receipt when the newest message from someone else is on screen.
  useEffect(() => {
    if (!listVisible || !docVisible) return;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const m = chat[i];
      if (m.socketId !== selfId && m.socketId !== 'system') {
        if (lastSeenSent.current !== m.id) {
          lastSeenSent.current = m.id;
          const socket = getSocket();
          if (socket && socket.connected) {
            socket.emit(SOCKET_EVENTS.CHAT_SEEN, { messageId: m.id });
          }
        }
        break;
      }
    }
  }, [chat, listVisible, docVisible, selfId]);

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

  function startReply(message) {
    setReplyTarget({
      id: message.id,
      displayName: message.socketId === selfId ? 'You' : message.displayName,
      text: message.text,
    });
    if (inputRef.current) inputRef.current.focus();
  }

  function sendMessage(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const socket = getSocket();
    if (!socket || !socket.connected) return;

    const id = generateMessageId();
    const replyTo = replyTarget
      ? {
          id: replyTarget.id,
          displayName: replyTarget.displayName,
          text: String(replyTarget.text || '').slice(0, 160),
        }
      : undefined;

    // Optimistic insert — the message shows immediately as "Sending…"; the
    // server echo upgrades it to "Delivered", a peer receipt to "Seen".
    useRoomStore.getState().addChatMessage({
      id,
      socketId: selfId,
      displayName,
      text,
      sentAt: Date.now(),
      status: MESSAGE_STATUS.SENDING,
      seenBy: [],
      replyTo,
    });
    socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { id, text, replyTo });

    setDraft('');
    setReplyTarget(null);
    emitTyping(false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }

  const typingNames = useMemo(
    () => Object.keys(typingPeers).filter((id) => id !== selfId).map((id) => typingPeers[id]),
    [typingPeers, selfId],
  );

  // Index of my last message — the receipt is shown only there (Messenger-style).
  const lastOwnIndex = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      if (chat[i].socketId === selfId) return i;
    }
    return -1;
  }, [chat, selfId]);

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
        className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3"
      >
        {chat.length === 0 ? (
          <li className="text-sm text-white/30">No messages yet — say hi 👋</li>
        ) : null}
        {chat.map((m, i) => {
          const isSystem = m.socketId === 'system';
          const isSelf = m.socketId === selfId;
          if (isSystem) {
            return (
              <li key={m.id} className="py-0.5 text-center text-[11px] italic text-white/35">
                {m.text}
              </li>
            );
          }
          return (
            <li key={m.id} className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
              <span
                className="text-[11px] font-medium"
                style={{ color: nameColor(m.displayName || '?') }}
              >
                {isSelf ? 'You' : m.displayName}
              </span>

              <div className={`flex max-w-[88%] items-center gap-1 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
                <div
                  className={[
                    'mt-0.5 inline-block break-words rounded-2xl px-3 py-1.5 text-sm',
                    isSelf ? 'bg-accent text-white' : 'bg-edge text-white/90',
                  ].join(' ')}
                >
                  {/* quoted reply */}
                  {m.replyTo ? (
                    <div
                      className={[
                        'mb-1 rounded-lg border-l-2 px-2 py-1 text-[11px]',
                        isSelf ? 'border-white/60 bg-black/15' : 'border-accent2 bg-black/25',
                      ].join(' ')}
                    >
                      <span className="block font-semibold opacity-80">
                        {m.replyTo.displayName}
                      </span>
                      <span className="block truncate opacity-70">{m.replyTo.text}</span>
                    </div>
                  ) : null}
                  {m.text}
                </div>

                {/* reply action */}
                <button
                  type="button"
                  onClick={() => startReply(m)}
                  aria-label={`Reply to ${isSelf ? 'your' : `${m.displayName}'s`} message`}
                  className="shrink-0 rounded p-1 text-xs text-white/35 hover:bg-white/10 hover:text-white/80"
                >
                  ↩
                </button>
              </div>

              {/* receipt — only under my latest message */}
              {isSelf && i === lastOwnIndex ? (
                <span className="mt-0.5">
                  <Receipt message={m} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* typing indicator */}
      <div className="h-5 px-3 text-[11px] text-white/40" aria-live="polite">
        {typingNames.length === 1 ? `${typingNames[0]} is typing…` : null}
        {typingNames.length > 1 ? `${typingNames.length} people are typing…` : null}
      </div>

      {/* reply preview bar */}
      {replyTarget ? (
        <div className="flex items-center gap-2 border-t border-edge bg-ink/60 px-3 py-1.5">
          <div className="min-w-0 flex-1 border-l-2 border-accent2 pl-2">
            <span className="block text-[11px] font-semibold text-accent2">
              Replying to {replyTarget.displayName}
            </span>
            <span className="block truncate text-[11px] text-white/50">{replyTarget.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setReplyTarget(null)}
            aria-label="Cancel reply"
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* composer */}
      <form onSubmit={sendMessage} className="flex gap-2 border-t border-edge p-3">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          ref={inputRef}
          type="text"
          value={draft}
          onChange={handleDraftChange}
          maxLength={MAX_CHAT_LENGTH}
          autoComplete="off"
          placeholder={replyTarget ? 'Write a reply…' : 'Message…'}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-base text-white placeholder:text-white/30 focus:border-accent2 focus:outline-none sm:text-sm"
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
