// src/app/page.jsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@/components/ui/Button';
import { generateRoomId } from '@/lib/utils';

/**
 * Landing / lobby — deliberately minimal (spec §1: no marketing copy). Create a
 * fresh private room or join an existing one by id.
 */
export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [joinId, setJoinId] = useState('');
  const [error, setError] = useState('');

  // Pre-fill the name from a previous visit (saved on join / in the room).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('cowatch:displayName');
      if (saved) setName(saved);
    } catch { /* storage unavailable */ }
  }, []);

  function go(roomId) {
    const clean = name.trim();
    if (!clean) {
      setError('Pick a display name first.');
      return;
    }
    // Persist so a later refresh inside the room keeps you signed in.
    try {
      window.localStorage.setItem('cowatch:displayName', clean);
    } catch { /* storage unavailable */ }
    router.push(`/rooms/${encodeURIComponent(roomId)}?name=${encodeURIComponent(clean)}`);
  }

  function createRoom() {
    // Unguessable room id (spec §3 gap #7).
    go(generateRoomId());
  }

  function joinRoom(e) {
    e.preventDefault();
    const id = joinId.trim();
    if (!id) {
      setError('Paste a room link or id to join.');
      return;
    }
    // Accept either a raw id or a pasted full URL.
    const match = id.match(/rooms\/([^/?#]+)/);
    go(match ? decodeURIComponent(match[1]) : id);
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-3xl font-bold">
          Co<span className="text-accent">Watch</span>
        </h1>
        <p className="mt-1 text-center text-sm text-white/50">
          Watch videos in sync, together — wherever you are.
        </p>

        <div className="mt-8 space-y-4 rounded-2xl border border-edge bg-panel p-5">
          <div>
            <label htmlFor="name" className="mb-1 block text-xs uppercase tracking-wide text-white/40">
              Display name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              maxLength={40}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g. Alex"
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-base focus:border-accent2 focus:outline-none sm:text-sm"
            />
          </div>

          <Button variant="primary" className="w-full" onClick={createRoom}>
            Create a private room
          </Button>

          <div className="flex items-center gap-3 text-xs text-white/30">
            <span className="h-px flex-1 bg-edge" />
            or join one
            <span className="h-px flex-1 bg-edge" />
          </div>

          <form onSubmit={joinRoom} className="space-y-2">
            <label htmlFor="join" className="sr-only">Room link or id</label>
            <input
              id="join"
              type="text"
              value={joinId}
              onChange={(e) => { setJoinId(e.target.value); setError(''); }}
              placeholder="Paste a room link or id"
              className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-base focus:border-accent2 focus:outline-none sm:text-sm"
            />
            <Button type="submit" variant="secondary" className="w-full">
              Join room
            </Button>
          </form>

          {error ? (
            <p role="alert" className="text-center text-xs text-red-400">{error}</p>
          ) : null}
        </div>

        <p className="mt-4 text-center text-[11px] text-white/30">
          Supports YouTube links and direct video files (.mp4 / .m3u8). DRM
          services like Netflix cannot be embedded or synced.
        </p>
      </div>
    </main>
  );
}
