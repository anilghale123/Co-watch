// src/app/layout.jsx
import './globals.css';

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
      <body>{children}</body>
    </html>
  );
}
