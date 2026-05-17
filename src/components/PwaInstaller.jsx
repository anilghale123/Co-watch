'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker and captures the browser's
 * `beforeinstallprompt` event as early as possible.
 *
 * The event fires once per page load and can arrive before any
 * deeper component (the install button) has mounted. We stash it on
 * `window.__deferredInstallPrompt` and broadcast a custom event so the
 * button can pick it up whenever it mounts — no race, no lost event.
 */
export default function PwaInstaller() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(() => {
          // If service worker registration fails, we still let the app run.
        });
    }

    function onBeforeInstall(e) {
      e.preventDefault(); // stop Chrome's mini-infobar so we control the UI
      window.__deferredInstallPrompt = e;
      window.dispatchEvent(new Event('pwa-installable'));
    }
    function onInstalled() {
      window.__deferredInstallPrompt = null;
      window.dispatchEvent(new Event('pwa-installed'));
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  return null;
}
