// src/app/rooms/[roomId]/page.jsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import FloatingSidebar from '@/components/FloatingSidebar';
import { useRoomSocket } from '@/features/rooms/hooks/useRoomSocket';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import WatchTheater from '@/features/rooms/components/WatchTheater';
import ChatSidebar from '@/features/rooms/components/ChatSidebar';
import WebRTCOverlay from '@/features/rooms/components/WebRTCOverlay';
import { cn } from '@/lib/utils';

/** Small connection-status pill driven by the Zustand store. */
function ConnectionPill() {
  const status = useRoomStore((s) => s.connectionStatus);
  const map = {
    idle: { text: 'Idle', cls: 'bg-edge text-white/60' },
    connecting: { text: 'Connecting…', cls: 'bg-yellow-600/30 text-yellow-300' },
    connected: { text: 'Connected', cls: 'bg-green-600/30 text-green-300' },
    reconnecting: { text: 'Reconnecting…', cls: 'bg-yellow-600/30 text-yellow-300 animate-pulse2' },
    disconnected: { text: 'Disconnected', cls: 'bg-red-600/30 text-red-300' },
  };
  const s = map[status] || map.idle;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium sm:text-[11px] ${s.cls}`}>
      {s.text}
    </span>
  );
}

/**
 * Prominent invite strip — shown while you are the only person in the room so
 * you always have a shareable link in front of you, not just a header button.
 */
function InviteBanner({ roomId }) {
  const peerCount = useRoomStore((s) => s.peers.length);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(`${window.location.origin}/rooms/${encodeURIComponent(roomId)}`);
  }, [roomId]);

  // Once someone else joins, the banner is no longer needed.
  if (dismissed || peerCount > 1) return null;

  function copy() {
    if (navigator.clipboard && url) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-edge bg-accent2/10 px-3 py-2 sm:flex-row sm:items-center sm:px-4">
      <p className="text-xs text-white/80">
        <span aria-hidden="true">🔗 </span>
        You&apos;re the only one here — share this link to watch together:
      </p>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Room invite link"
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-2 py-1.5 text-xs text-white/70"
        />
        <Button size="sm" variant="primary" onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss invite banner"
          className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * The private room — orchestrates the four real-time subsystems behind one
 * connection lifecycle.
 *
 * Responsive strategy: WatchTheater and ChatSidebar are mounted ONCE (mounting
 * twice would create two player controllers / two chat instances). On phones a
 * bottom tab bar toggles which one is *visible* via CSS; the hidden one keeps
 * running, so playback sync and chat never drop when you switch tabs.
 */
export default function RoomPage({ params, searchParams }) {
  const roomId = decodeURIComponent(params.roomId);
  const initialName = (searchParams && searchParams.name) || '';

  const [displayName, setDisplayName] = useState(initialName);
  const [nameDraft, setNameDraft] = useState('');
  const [copied, setCopied] = useState(false);
  /** Mobile-only view toggle: 'watch' | 'chat'. Ignored at >= sm. */
  const [mobileTab, setMobileTab] = useState('watch');
  const [seenChatCount, setSeenChatCount] = useState(0);
  /** Gate render until we've checked storage for a saved name (avoids a flash). */
  const [nameResolved, setNameResolved] = useState(false);

  const roomFull = useRoomStore((s) => s.roomFull);
  const chatCount = useRoomStore((s) => s.chat.length);

  // Owns the connection lifecycle. No-ops while displayName is empty.
  useRoomSocket(roomId, displayName);

  // On first mount: if the URL carried no ?name= (e.g. joined via an invite
  // link), recover the display name saved from a previous visit. This is what
  // makes a REFRESH keep you in the room instead of re-prompting / kicking you
  // back to the name screen.
  useEffect(() => {
    if (!displayName) {
      try {
        const saved = window.localStorage.getItem('cowatch:displayName');
        if (saved) setDisplayName(saved);
      } catch { /* storage unavailable */ }
    }
    setNameResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the name whenever it is set, so the next refresh restores it.
  useEffect(() => {
    if (displayName) {
      try {
        window.localStorage.setItem('cowatch:displayName', displayName);
      } catch { /* storage unavailable */ }
    }
  }, [displayName]);

  // Track unread messages while the Chat tab is not the active mobile view.
  useEffect(() => {
    if (mobileTab === 'chat') setSeenChatCount(chatCount);
  }, [mobileTab, chatCount]);
  const unread = Math.max(0, chatCount - seenChatCount);

  function copyInvite() {
    const url = `${window.location.origin}/rooms/${encodeURIComponent(roomId)}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    }
  }

  // Don't render anything (not even the name modal) until storage is checked —
  // prevents a one-frame flash of the name prompt on every refresh.
  if (!nameResolved) return null;

  /* ---- name gate: must have a display name before joining ---- */
  if (!displayName) {
    return (
      <Modal open title="What should we call you?" dismissable={false}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (nameDraft.trim()) setDisplayName(nameDraft.trim());
          }}
          className="space-y-3"
        >
          <input
            type="text"
            autoFocus
            maxLength={40}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Your display name"
            className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-base focus:border-accent2 focus:outline-none"
          />
          <Button type="submit" variant="primary" className="w-full" disabled={!nameDraft.trim()}>
            Join room
          </Button>
        </form>
      </Modal>
    );
  }

  return (
    // 100dvh keeps the layout correct under mobile browser chrome.
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      {/* header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-2 sm:px-4">
        <Link href="/" className="text-sm font-bold">
          Co<span className="text-accent">Watch</span>
        </Link>
        <ConnectionPill />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={copyInvite}>
            <span className="hidden sm:inline">{copied ? 'Link copied!' : 'Copy invite link'}</span>
            <span className="sm:hidden">{copied ? 'Copied!' : 'Invite'}</span>
          </Button>
          <Link href="/">
            <Button size="sm" variant="ghost" aria-label="Leave room">
              Leave
            </Button>
          </Link>
        </div>
      </header>

      {/* invite strip — visible while you are alone */}
      <InviteBanner roomId={roomId} />

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-row">
        {/* theater — full screen on mobile when the Watch tab is active */}
        <div
          className={cn(
            'min-w-0 flex-1 flex-col',
            mobileTab === 'watch' ? 'flex' : 'hidden',
            'sm:flex',
          )}
        >
          <ErrorBoundary>
            <WatchTheater />
          </ErrorBoundary>
        </div>

        {/* chat — full screen on mobile when the Chat tab is active */}
        <div
          className={cn(
            'min-h-0 w-full flex-col sm:w-auto',
            mobileTab === 'chat' ? 'flex' : 'hidden',
            'sm:flex',
          )}
        >
          <ErrorBoundary>
            <FloatingSidebar title="Room chat">
              <ChatSidebar />
            </FloatingSidebar>
          </ErrorBoundary>
        </div>
      </div>

      {/* mobile-only bottom tab bar */}
      <nav
        className="flex shrink-0 border-t border-edge bg-panel sm:hidden"
        aria-label="Switch between video and chat"
      >
        <button
          type="button"
          onClick={() => setMobileTab('watch')}
          aria-current={mobileTab === 'watch'}
          className={cn(
            'flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium',
            mobileTab === 'watch' ? 'text-accent' : 'text-white/55',
          )}
        >
          <span aria-hidden="true">▶</span> Watch
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('chat')}
          aria-current={mobileTab === 'chat'}
          className={cn(
            'relative flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium',
            mobileTab === 'chat' ? 'text-accent' : 'text-white/55',
          )}
        >
          <span aria-hidden="true">💬</span> Chat
          {unread > 0 && mobileTab !== 'chat' ? (
            <span className="absolute right-1/4 top-1 rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </button>
      </nav>

      {/* floating P2P A/V mesh */}
      <ErrorBoundary fallback={null}>
        <WebRTCOverlay />
      </ErrorBoundary>

      {/* room-full rejection (spec §3 gap #4 / acceptance criteria) */}
      <Modal open={roomFull} title="This room is full" dismissable={false}>
        <p className="text-sm text-white/70">
          This room has reached its maximum number of people. Ask the group to
          start a new room, or try again once someone leaves.
        </p>
        <Link href="/">
          <Button variant="primary" className="mt-4 w-full">
            Back to lobby
          </Button>
        </Link>
      </Modal>
    </div>
  );
}
