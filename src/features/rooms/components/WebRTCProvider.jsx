// src/features/rooms/components/WebRTCProvider.jsx
'use client';

import { createContext, useContext } from 'react';
import PropTypes from 'prop-types';
import { useWebRTCConnection } from '@/features/rooms/hooks/useWebRTCConnection';

/**
 * Shares ONE WebRTC mesh across the room UI.
 *
 * `useWebRTCConnection` owns peer connections, the local camera/mic stream and
 * the screen-share stream — it must be instantiated exactly once. Both the
 * floating A/V overlay and the watch theater need that single instance, so it
 * lives here in a context rather than being called per-component (calling the
 * hook twice would build two independent, conflicting meshes).
 *
 * Unlike the high-frequency room store, WebRTC state changes are rare (stream
 * start/stop, peer join/leave, a toggle), so a context is cheap here.
 */
const WebRTCContext = createContext(null);

export function WebRTCProvider({ children }) {
  const rtc = useWebRTCConnection();
  return <WebRTCContext.Provider value={rtc}>{children}</WebRTCContext.Provider>;
}

WebRTCProvider.propTypes = {
  children: PropTypes.node,
};

/** Access the shared WebRTC mesh. Must be called inside <WebRTCProvider>. */
export function useWebRTC() {
  const ctx = useContext(WebRTCContext);
  if (!ctx) {
    throw new Error('useWebRTC must be used within a <WebRTCProvider>');
  }
  return ctx;
}
