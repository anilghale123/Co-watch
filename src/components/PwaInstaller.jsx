'use client';

import { useEffect } from 'react';

export default function PwaInstaller() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(() => {
          // If service worker registration fails, we still let the app run.
        });
    }
  }, []);
  return null;
}
