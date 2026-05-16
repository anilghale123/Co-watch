// src/features/rooms/hooks/useWebRTCConnection.js
/**
 * P2P WebRTC mesh (spec §2.4).
 *
 *   - Live audio/video runs client-to-client over `simple-peer`. The Socket.IO
 *     server is a PURE signaling channel — it relays SDP/ICE during handshake
 *     and then steps fully out; no media bytes ever transit the server.
 *   - Glare-free initiator rule: for any pair, the peer with the
 *     lexicographically smaller socketId is the initiator. Deterministic on
 *     both sides => exactly one offer per pair.
 *   - Full lifecycle: getUserMedia (incl. denial), connect/disconnect,
 *     and COMPLETE teardown — stop every track, destroy every peer, remove
 *     every listener (spec §4 grading: a live mic after room exit is a fail).
 *   - Denied mic/cam degrades gracefully: peers are still created without a
 *     local stream so this client can still receive others, and text chat is
 *     unaffected (spec §3 gap #8).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket/socketClient';
import { useRoomStore } from '@/features/rooms/stores/useRoomStore';
import { SOCKET_EVENTS } from '@/features/rooms/room-types';

/** ICE servers. Google public STUN covers most NATs. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  /*
   * TURN PLACEHOLDER — required for the ~10-15% of real-world NAT setups
   * (symmetric NAT / strict firewalls) that STUN cannot traverse. TURN relays
   * media, so it is post-MVP infrastructure. In production, mint SHORT-LIVED
   * TURN credentials server-side and hand them to the client; do NOT ship a
   * static long-lived credential. See README "TURN" section.
   *
   * {
   *   urls: process.env.NEXT_PUBLIC_TURN_URL,
   *   username: process.env.NEXT_PUBLIC_TURN_USERNAME,
   *   credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
   * },
   */
];

/**
 * @returns {{
 *   localStream: MediaStream|null,
 *   remoteStreams: Record<string, MediaStream>,
 *   mediaPermission: string,
 *   audioEnabled: boolean,
 *   videoEnabled: boolean,
 *   toggleAudio: ()=>void,
 *   toggleVideo: ()=>void,
 *   retryMedia: ()=>void,
 * }}
 */
export function useWebRTCConnection() {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [mediaAttempt, setMediaAttempt] = useState(0); // bump to retry getUserMedia

  /** @type {{current: Map<string, any>}} socketId -> simple-peer instance */
  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const SimplePeerRef = useRef(null); // lazily-loaded simple-peer constructor
  const mountedRef = useRef(true);

  const setPermission = (p) => useRoomStore.getState().setMediaPermission(p);

  /* ------------------------------------------------------------------ *
   * Peer teardown helpers
   * ------------------------------------------------------------------ */

  const destroyPeer = useCallback((peerId) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      try { peer.removeAllListeners(); } catch { /* noop */ }
      try { peer.destroy(); } catch { /* noop */ }
      peersRef.current.delete(peerId);
    }
    setRemoteStreams((prev) => {
      if (!prev[peerId]) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const destroyAllPeers = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach((id) => destroyPeer(id));
  }, [destroyPeer]);

  /* ------------------------------------------------------------------ *
   * Create a peer connection
   * ------------------------------------------------------------------ */

  const createPeer = useCallback((peerId, initiator) => {
    if (peersRef.current.has(peerId)) return peersRef.current.get(peerId);
    const SimplePeer = SimplePeerRef.current;
    if (!SimplePeer) return null;

    const socket = getSocket();
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: localStreamRef.current || undefined,
      config: { iceServers: ICE_SERVERS },
    });

    peer.on('signal', (signal) => {
      // Relay handshake data through the server, scoped to this room.
      socket.emit(SOCKET_EVENTS.RTC_SIGNAL, { targetId: peerId, signal });
    });

    peer.on('stream', (stream) => {
      if (!mountedRef.current) return;
      setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
    });

    peer.on('connect', () => {
      // Media path is now direct P2P — server is out of the loop.
    });

    peer.on('close', () => destroyPeer(peerId));
    peer.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[webrtc] peer ${peerId} error`, err && err.message);
      destroyPeer(peerId);
    });

    peersRef.current.set(peerId, peer);
    return peer;
  }, [destroyPeer]);

  /* ------------------------------------------------------------------ *
   * getUserMedia — with explicit denial handling
   * ------------------------------------------------------------------ */

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function acquireMedia() {
      setPermission('prompt');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setPermission('denied');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setAudioEnabled(true);
        setVideoEnabled(true);
        setPermission('granted');
        // Attach the freshly-acquired stream to any peers created before media
        // resolved (e.g. permission prompt outlived the first peer joining).
        peersRef.current.forEach((peer) => {
          try { peer.addStream(stream); } catch { /* already has a stream */ }
        });
      } catch (err) {
        // Denied, dismissed, or no device — degrade to text-chat-only.
        // eslint-disable-next-line no-console
        console.warn('[webrtc] getUserMedia failed', err && err.name);
        setPermission('denied');
      }
    }

    acquireMedia();

    return () => {
      cancelled = true;
    };
  }, [mediaAttempt]);

  /* ------------------------------------------------------------------ *
   * Signaling lifecycle
   * ------------------------------------------------------------------ */

  useEffect(() => {
    mountedRef.current = true;
    const socket = getSocket();
    let disposed = false;

    // Lazy-load simple-peer (browser-only; keeps it out of any SSR path).
    import('simple-peer').then((mod) => {
      if (disposed) return;
      SimplePeerRef.current = mod.default || mod;

      // Connect to peers ALREADY in the room when we arrive. Existing peers also
      // receive RTC_PEER_JOINED for us — the id rule ensures one initiator.
      const { selfId, peers } = useRoomStore.getState();
      if (selfId) {
        peers.forEach((p) => {
          if (p.socketId !== selfId) {
            createPeer(p.socketId, selfId < p.socketId);
          }
        });
      }
    });

    /* ---- handlers (kept by reference for cleanup) ---- */

    const onPeerJoined = ({ socketId }) => {
      const { selfId } = useRoomStore.getState();
      if (!selfId || socketId === selfId || !SimplePeerRef.current) return;
      // We initiate iff our id sorts first — deterministic, no glare.
      createPeer(socketId, selfId < socketId);
    };

    const onPeerLeft = ({ socketId }) => {
      destroyPeer(socketId);
    };

    const onSignal = ({ fromId, signal }) => {
      if (!SimplePeerRef.current || !fromId) return;
      let peer = peersRef.current.get(fromId);
      if (!peer) {
        // First contact and we are NOT the initiator — build the answering peer.
        peer = createPeer(fromId, false);
      }
      if (peer) {
        try { peer.signal(signal); }
        catch (err) { /* eslint-disable-line no-console */ console.warn('[webrtc] signal apply failed', err); }
      }
    };

    socket.on(SOCKET_EVENTS.RTC_PEER_JOINED, onPeerJoined);
    socket.on(SOCKET_EVENTS.RTC_PEER_LEFT, onPeerLeft);
    socket.on(SOCKET_EVENTS.RTC_SIGNAL, onSignal);

    /* ---- COMPLETE teardown ---- */
    return () => {
      disposed = true;
      mountedRef.current = false;
      socket.off(SOCKET_EVENTS.RTC_PEER_JOINED, onPeerJoined);
      socket.off(SOCKET_EVENTS.RTC_PEER_LEFT, onPeerLeft);
      socket.off(SOCKET_EVENTS.RTC_SIGNAL, onSignal);
      destroyAllPeers();
      // Stop every local media track — the mic/cam indicator MUST go off.
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [createPeer, destroyAllPeers, destroyPeer]);

  /* ------------------------------------------------------------------ *
   * Track toggles — flip `enabled`; no renegotiation needed.
   * ------------------------------------------------------------------ */

  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !audioEnabled;
    stream.getAudioTracks().forEach((t) => { t.enabled = next; });
    setAudioEnabled(next);
  }, [audioEnabled]);

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoEnabled;
    stream.getVideoTracks().forEach((t) => { t.enabled = next; });
    setVideoEnabled(next);
  }, [videoEnabled]);

  /** Re-attempt getUserMedia after the user fixed a denied permission. */
  const retryMedia = useCallback(() => {
    setMediaAttempt((n) => n + 1);
  }, []);

  const mediaPermission = useRoomStore((s) => s.mediaPermission);

  return {
    localStream,
    remoteStreams,
    mediaPermission,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
    retryMedia,
  };
}
