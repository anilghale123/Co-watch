// src/app/rooms/[roomId]/page.jsx
'use client';

import { useState } from 'react';
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
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.text}
    </span>
  );
}

/**
 * The private room — orchestrates the four real-time subsystems behind one
 * connection lifecycle.
 */
export default function RoomPage({ params, searchParams }) {
  const roomId = decodeURIComponent(params.roomId);
  const initialName = (searchParams && searchParams.name) || '';

  const [displayName, setDisplayName] = useState(initialName);
  const [nameDraft, setNameDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const roomFull = useRoomStore((s) => s.roomFull);

  // Owns the connection lifecycle. No-ops while displayName is empty.
  useRoomSocket(roomId, displayName);

  function copyInvite() {
    const url = `${window.location.origin}/rooms/${encodeURIComponent(roomId)}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    }
  }

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
            className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm focus:border-accent2 focus:outline-none"
          />
          <Button type="submit" variant="primary" className="w-full" disabled={!nameDraft.trim()}>
            Join room
          </Button>
        </form>
      </Modal>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-2">
        <Link href="/" className="text-sm font-bold">
          Co<span className="text-accent">Watch</span>
        </Link>
        <ConnectionPill />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={copyInvite}>
            {copied ? 'Link copied!' : 'Copy invite link'}
          </Button>
          <Link href="/">
            <Button size="sm" variant="ghost" aria-label="Leave room">
              Leave
            </Button>
          </Link>
        </div>
      </header>

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <ErrorBoundary>
          <WatchTheater />
        </ErrorBoundary>
        <ErrorBoundary>
          <FloatingSidebar title="Room chat">
            <ChatSidebar />
          </FloatingSidebar>
        </ErrorBoundary>
      </div>

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
