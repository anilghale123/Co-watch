// src/app/layout.jsx
import './globals.css';
import PwaInstaller from '@/components/PwaInstaller';

export const metadata = {
  title: 'CoWatch — Watch together, anywhere',
  description:
    'Private synchronized co-watching rooms for long-distance couples and friends — synced playback, chat, and P2P voice/video.',
};

export const viewport = {
  themeColor: '#0b0b12',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Root layout. Intentionally minimal — no marketing chrome (spec §1: spend
 * effort on the real-time architecture, not generic layout).
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon.svg" />
        <link rel="apple-touch-icon" href="/icon.svg" />
        <meta name="theme-color" content="#0b0b12" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PwaInstaller />
        {children}
      </body>
    </html>
  );
}
