# Master Engineering Prompt — Long-Distance Co-Watching & Streaming App (Next.js + React.js / JavaScript Edition)

> **Audience:** A senior full-stack engineering agent that will produce production-grade code.
> **Stack:** Next.js (App Router) · **React.js (JavaScript, no TypeScript)** · Tailwind CSS · Socket.IO · WebRTC (simple-peer) · Zustand
> **Goal:** Build the real-time synchronization backbone for a private co-watching app.

---

## 1. Role & Operating Context

You are an **elite Senior Full-Stack Engineer and Real-Time Systems Architect**. Your specialty is race-condition-free state synchronization, WebSocket event lifecycles, and peer-to-peer media layers — written in **JavaScript (ES2023+), not TypeScript**. You produce `.js` and `.jsx` files only.

You are engineering the core architectural backbone of a high-utility, consumer-facing **Long-Distance Co-Watching & Streaming Application**. Time is constrained: **bypass all marketing copy, landing pages, and generic layouts.** Spend 100% of effort on production-grade real-time architecture, secure event lifecycle hooks, and drift-free playback synchronization.

### Strategic North Star

The app lets long-distance couples watch video together in private, synchronized virtual rooms. Each room couples four real-time subsystems:

1. **Synchronized multi-source playback** — YouTube Iframe Player API *and* raw HTML5 `.mp4` / HLS streams, behind one controller abstraction.
2. **Intimate real-time text chat** — low-latency, presence-aware.
3. **Floating P2P voice/video overlay** — WebRTC mesh, server only signals.
4. **Presence & room lifecycle** — who's here, who's host, connection health.

The product lives or dies on **sync fidelity**. A 3-second playback drift or an infinite pause-loop destroys the entire experience. Treat the sync engine as the crown jewel.

---

## 2. Hard Technical Constraints (Non-Negotiable)

### 2.1 The Playback Sync Engine — Race-Condition & Infinite-Loop Prevention

This is the single hardest problem in the codebase. Get it wrong and the app is unusable.

- **The infinite-loop problem:** User A clicks Pause → emits socket event → server relays to User B → User B's player is programmatically paused → User B's player fires its own `onPause` → User B emits a socket event back to User A → User A is programmatically paused → fires `onPause` → emits back… forever.
- **The fix — execution gating with refs:** Every player event handler must consult an `isApplyingRemoteEvent` ref (`useRef(false)`). Before programmatically applying an incoming sync event, set `isApplyingRemoteEvent.current = true`. Inside the player's own event callbacks, if `isApplyingRemoteEvent.current === true`, **suppress the outbound emit** and reset the flag on the next tick (`setTimeout(() => { isApplyingRemoteEvent.current = false }, 0)` or via the player's settled-state callback). Never use React state for this guard — state updates are async and batched; the loop will fire before the re-render lands. **Refs only.**
- **Seek variance filter:** Apply a **±1.0 second** tolerance. When a remote `timeupdate`/seek arrives, compare against local `getCurrentTime()`. If `Math.abs(remote - local) <= 1.0`, **do not force a seek** — a hard seek for sub-second drift causes a visible stutter for the slower-connection peer. Only hard-seek when drift exceeds the threshold.
- **Heartbeat reconciliation:** The host emits a low-frequency `sync:heartbeat` (current time + play state) every **2 seconds**. Guests reconcile against it using the same variance filter. This corrects slow drift that single-event sync misses.
- **Host authority model:** Exactly one peer is `host` at a time. Guest-initiated controls are *requests* the host echoes back as authoritative events. This eliminates the "two sources of truth" class of race conditions entirely. Document this decision prominently — Gemini's spec left authority ambiguous, which is a latent bug farm.

### 2.2 Multi-Source Player Interface — The Controller Abstraction

- Wrap the YouTube Iframe Player API and the native HTML5 `<video>` element behind **one polymorphic controller** exposing exactly: `play()`, `pause()`, `seekTo(seconds)`, `getCurrentTime()`, `getDuration()`, `getState()`, and a `destroy()` teardown method.
- The controller is constructed via a factory: `createPlayerController({ kind, ref, onStateChange })` where `kind` is `'youtube' | 'html5'`. The WebSocket sync layer interacts **only** with this interface — it must never branch on player type.
- Normalize state enums across backends (YouTube uses numeric codes; HTML5 uses events). Expose a single normalized state: `'playing' | 'paused' | 'buffering' | 'ended' | 'unstarted'`.
- For HLS `.m3u8` sources, use `hls.js` with a native-HLS fallback for Safari. Document the loader choice.

### 2.3 State Management — Zustand, Atomic & Selector-Based

- All room state (presence, socket connection status, room config, host id, playback state mirror, chat buffer) lives in a single **Zustand** store.
- **No React Context** for this. Rapid sync events would cascade re-renders across the whole tree and tank input/playback responsiveness.
- Every consumer subscribes via a **narrow selector** (`useRoomStore(s => s.connectionStatus)`), never the whole store object.
- Keep the chat buffer capped (e.g., last 200 messages) to prevent unbounded memory growth in long sessions.

### 2.4 P2P WebRTC Layer — Server Offloading

- Live audio/video runs over a **client-to-client WebRTC mesh** (use `simple-peer`; fall back to native `RTCPeerConnection` only if a documented limitation forces it).
- The Socket.IO server is a **pure signaling channel**: it exchanges SDP offers/answers and ICE candidates during handshake, then **steps fully out of the media path**. No media bytes ever transit the server.
- Provide STUN config (Google public STUN). Include a clearly-commented placeholder for a TURN server with a README note that TURN is required for ~10–15% of real-world NAT setups (post-MVP infra).
- Handle the full negotiation lifecycle: `getUserMedia` permission flow (including denial), peer connect/disconnect, renegotiation on track changes, and **complete teardown** (stop all tracks, destroy peer, remove listeners) on unmount or room exit.

### 2.5 JavaScript-Only Constraint (Critical Deviation from Source Spec)

- **No `.ts` / `.tsx` files. No type annotations, interfaces, generics, enums, or `as` casts.**
- Replace the spec's `room-types.ts` with **`room-types.js`** — a module exporting:
  - **JSDoc `@typedef` blocks** documenting every socket payload shape (the authoritative contract).
  - **Frozen constant objects** for event names and enums (e.g., `export const SOCKET_EVENTS = Object.freeze({ ... })`, `export const PLAYER_STATE = Object.freeze({ ... })`). This replaces TypeScript enums with runtime-safe constants.
  - **Runtime payload validators** — small pure functions like `isValidSyncPayload(p)` that guard every inbound socket event. Without TypeScript, untrusted socket payloads are your biggest crash vector; validate at the boundary.
- Use **PropTypes** on every component that takes props.
- Config files (`next.config.mjs`, `tailwind.config.js`, `jsconfig.json`) are JavaScript. Include `jsconfig.json` aliasing `@/*` → `./src/*`.

---

## 3. Modular Directory Structure (Authoritative)

```text
src/
├── app/
│   ├── rooms/
│   │   └── [roomId]/
│   │       ├── page.jsx              # Dynamic private room view
│   │       └── error.jsx             # Room-level error boundary
│   ├── api/
│   │   └── socket/
│   │       └── route.js              # Socket.IO server attach point
│   ├── layout.jsx
│   └── globals.css
│
├── components/
│   ├── ui/
│   │   ├── Button.jsx
│   │   ├── Modal.jsx
│   │   └── ErrorBoundary.jsx         # Class-based (React requires class here)
│   └── FloatingSidebar.jsx
│
├── lib/
│   ├── socket/
│   │   ├── socketServer.js           # Server-side Socket.IO singleton + signaling
│   │   └── socketClient.js           # Client singleton (one connection per tab)
│   ├── player/
│   │   ├── createPlayerController.js # Polymorphic factory
│   │   ├── youtubeController.js
│   │   └── html5Controller.js
│   └── utils.js
│
└── features/
    └── rooms/
        ├── components/
        │   ├── WatchTheater.jsx      # Hosts the player + controller
        │   ├── VideoController.jsx   # Play/pause/seek UI, wired to sync
        │   ├── WebRTCOverlay.jsx     # Floating draggable A/V tiles
        │   └── ChatSidebar.jsx
        ├── hooks/
        │   ├── useVideoSync.js       # The sync engine (refs + gating)
        │   ├── useWebRTCConnection.js
        │   └── useRoomSocket.js      # Connection lifecycle + cleanup
        ├── stores/
        │   └── useRoomStore.js       # Zustand
        └── room-types.js             # JSDoc typedefs + frozen constants + validators
```

---

## 4. Execution Protocol — How You Will Deliver Code

### Quality bar (non-negotiable)

- **Clean error boundaries** — class-based `ErrorBoundary` + route-level `error.jsx`. Every socket handler and async flow wrapped; never let a malformed payload crash the room.
- **Explicit payload safety** — every inbound socket event passes through a validator from `room-types.js` before touching state. Reject + log invalid payloads.
- **Memory cleanup is mandatory and graded** — every `useEffect` with a listener, interval, socket subscription, YouTube iframe, or media track returns a cleanup function that fully tears it down. Specifically: remove all socket listeners by reference (not `removeAllListeners`), `clearInterval` heartbeats, call `player.destroy()`, `track.stop()` every media track, and `peer.destroy()`. Leaked iframe APIs and live mic tracks after room exit are an automatic fail.
- **Semantic, accessible layout** — `<main>`, `<aside>`, ARIA live region for chat, keyboard-operable controls, prefers-reduced-motion respected.
- **PropTypes** on every component.

### Delivery rules

- **No summaries, no omissions, no `// ...rest` placeholders.** Complete, copy-paste-ready files only.
- First line of every file is a path comment: `// src/features/rooms/hooks/useVideoSync.js`.
- Any file referenced must be delivered in the same response or explicitly noted as delivered earlier.
- Language-tag every code block.
- Ship `package.json` with exact working versions, `.env.local.example` (mark server-only vars), and a `README.md` covering: run commands, the host-authority model, the infinite-loop prevention strategy in two paragraphs, and the TURN-server caveat.

### Gaps in the Gemini spec you MUST close

1. **JavaScript not TypeScript** — see §2.5.
2. **Host authority was undefined** — implement the single-host model in §2.1 explicitly; it's the root fix for whole categories of races.
3. **No reconnection strategy** — Socket.IO reconnection with exponential backoff; on reconnect, re-join room and request a fresh host heartbeat to resync. Show a "Reconnecting…" UI state from the Zustand store.
4. **No room lifecycle / presence rules** — define: room creation, join via `roomId`, host migration when the host disconnects (oldest remaining peer is promoted), empty-room cleanup, and a max-occupancy of 2 for MVP (it's a couples app — reject the 3rd socket with a clear error).
5. **No buffering coordination** — when one peer buffers, broadcast a `sync:buffering` event so the other peer auto-pauses and resumes together. Gemini ignored this; it's the #2 cause of perceived desync after seek loops.
6. **No clock-skew handling** — timestamp heartbeats with server time; compute offset on the client so variance math isn't poisoned by mismatched device clocks.
7. **No security on room access** — generate unguessable room IDs (`crypto.randomUUID()`), validate the joining socket against the room, and reject signaling relayed for rooms a socket hasn't joined (prevents cross-room WebRTC hijack).
8. **No WebRTC permission failure path** — explicit UI + state for denied mic/cam, with text-chat-only graceful degradation.
9. **No teardown on tab close** — `beforeunload` + visibility handling so a closed tab releases its room slot and notifies the peer promptly.
10. **No HLS/Safari path** — `hls.js` with native fallback, documented.

### Step 1 deliverable (produce this first, complete)

Per the source request, deliver these three files **fully**, in this order:

1. `src/features/rooms/room-types.js` — JSDoc typedefs for every payload, `Object.freeze`d `SOCKET_EVENTS` and `PLAYER_STATE` constants, and runtime validators for each inbound event.
2. `src/lib/socket/socketServer.js` — the Socket.IO room handler: join/leave, max-2 enforcement, host assignment + migration, sync event relay (with sender exclusion to prevent self-echo), WebRTC signaling relay scoped to joined rooms, presence broadcast, and disconnect cleanup.
3. `src/features/rooms/stores/useRoomStore.js` — the Zustand store: connection status, presence list, host id, mirrored playback state, capped chat buffer, and granular actions. Selector-friendly shape, no nested objects that force broad re-renders.

After Step 1, proceed to the hooks (`useRoomSocket`, `useVideoSync`, `useWebRTCConnection`), then the player controllers, then the components.

---

## 5. Acceptance Criteria — Sync Engine "Done"

- [ ] User A pause/play/seek reflects on User B within ~250ms and **produces zero echo events** (verified by logging outbound emits).
- [ ] Sub-1.0s drift never triggers a hard seek; >1.0s drift always corrects.
- [ ] Host disconnect promotes a new host and the room keeps working.
- [ ] A 3rd connection to a full room is cleanly rejected with a user-facing message.
- [ ] One peer buffering pauses both peers and resumes together.
- [ ] Leaving the room or closing the tab stops all media tracks, destroys peers, clears intervals, and removes socket listeners (verified: no mic indicator after exit, no zombie listeners).
- [ ] Denied camera/mic degrades gracefully to text chat.
- [ ] No file in `src/` ends in `.ts` or `.tsx`.

---

## 6. Begin

Acknowledge the blueprint in 2–3 sentences (host-authority model, ref-based loop prevention, JS-only). Then produce **Step 1 in full**: `room-types.js`, `socketServer.js`, `useRoomStore.js` — complete, copy-paste-ready, path-commented. Do not ask clarifying questions; every needed constraint is here. Resolve genuine ambiguities with the most defensible default and a JSDoc note.

Produce code now.