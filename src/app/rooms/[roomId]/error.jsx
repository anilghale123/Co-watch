// src/app/rooms/[roomId]/error.jsx
'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import Button from '@/components/ui/Button';

/**
 * Route-level error boundary for the room (spec §3 / §4). Next.js renders this
 * automatically if anything in the room subtree throws during render.
 */
export default function RoomError({ error, reset }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[room route error]', error);
  }, [error]);

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">This room hit a snag</h1>
      <p className="max-w-sm text-sm text-white/60">
        {error && error.message ? error.message : 'An unexpected error occurred.'}
      </p>
      <div className="flex gap-3">
        <Button variant="primary" onClick={() => reset()}>
          Try again
        </Button>
        <Link href="/">
          <Button variant="secondary">Back to lobby</Button>
        </Link>
      </div>
    </main>
  );
}
