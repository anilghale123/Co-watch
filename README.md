# CoWatch — Long-Distance Co-Watching & Streaming App

Private, synchronized virtual rooms where long-distance couples and small
groups of friends watch videos **together** — drift-free playback sync,
intimate real-time chat, and a floating P2P voice/video overlay.

Built with **Next.js (App Router) · React (plain JavaScript, no TypeScript) ·
Tailwind CSS · Socket.IO · WebRTC (simple-peer) · Zustand**.

---

## Quick start

```bash
# 1. install
npm install

# 2. configure (optional for local dev — defaults work as-is)
cp .env.local.example .env.local

# 3. run (custom server hosts Next.js + Socket.IO on one port)
npm run dev          # http://localhost:3000

# production
npm run build
npm start
```

Open two browser windows (or two devices), create a room in one, click **Copy
invite link**, and open it in the other. Paste a YouTube or direct-video link
and press play.

> **Why `npm run dev` runs `server.js`:** Socket.IO needs a long-lived handle on
> the Node HTTP server, which App Router route handlers cannot provide. A thin
> custom server (`server.js`) co-hosts Next.js and Socket.IO on one port. The
> live signaling endpoint is `/api/socketio`.

---

## Deploying to Railway

This app needs a **long-running Node process** (for the persistent Socket.IO
server), so it deploys to Railway — not to serverless platforms like Vercel,
which cannot host a custom server or a persistent WebSocket `io` instance.

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub
   repo** and pick this repo.
3. Railway reads [`railway.json`](railway.json) and runs `npm run build` then
   `npm start` automatically.
4. **Settings → Networking → Generate Domain** to get a public URL.

### Environment variables on Railway

For a single-service Railway deploy you do **not** need to set any environment
variables — the defaults are correct:

| Variable | Set it? | Why |
|---|---|---|
| `PORT` | **No** — Railway injects it | `server.js` already reads `process.env.PORT`. |
| `NODE_ENV` | **No** — Railway sets `production` | The `npm start` script also sets it. |
| `NEXT_PUBLIC_SOCKET_URL` | **Leave empty / unset** | The client connects same-origin. Setting this is only for a split frontend/backend deploy. |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Optional | Only if you stand up a TURN server (see below). |

> **Important — `NEXT_PUBLIC_*` are baked at build time.** If you ever add a
> `NEXT_PUBLIC_` variable (e.g. a public TURN URL), you must **redeploy** so the
> client bundle is rebuilt with the new value. Server-only vars (`TURN_URL`
> etc.) take effect on restart without a rebuild.

That's it — no env setup is required to go live.

---

## What you can watch

| Source | Supported | Notes |
|---|---|---|
| YouTube (any URL form) | ✅ | YouTube Iframe Player API |
| Direct `.mp4` / `.webm` files | ✅ | Native HTML5 `<video>` |
| HLS `.m3u8` streams | ✅ | `hls.js`, with native HLS fallback for Safari |
| Netflix / Disney+ / Prime / Hotstar / Max | ❌ | **DRM-protected — cannot be embedded or synced.** Their players forbid iframing and encrypt the stream. The app rejects these links with a clear message. |

This is a technical/legal hard limit, not a missing feature: no co-watching app
can sync a DRM service's actual video stream. To watch with friends, use a
YouTube link or a directly-hosted video file.

---

## Host-authority model

Exactly **one peer is the host** at any time (the room creator; on host
disconnect the oldest remaining peer is promoted automatically).

- Only the host emits **authoritative** `sync:play` / `sync:pause` / `sync:seek`
  events.
- A **guest's** play/pause/seek is sent as a `control:request`. The host
  applies it to its own player, which then emits the authoritative event back
  out to everyone — including the requester.

This deliberately eliminates the "two sources of truth" race-condition class:
there is always exactly one writer of playback state. The cost is a ~one-RTT
delay on guest-initiated controls (~250 ms), which is imperceptible next to the
correctness it buys. The host also emits a low-frequency `sync:heartbeat` every
2 seconds so slow drift that single events miss is continuously reconciled.

---

## Infinite-loop prevention (the hardest problem in the codebase)

The naive failure mode: User A pauses → emits a socket event → the server
relays it to User B → User B's player is paused **programmatically** → User B's
player fires its *own* `onPause` callback → User B emits a pause event back to
A → A is paused programmatically → A fires `onPause` → emits again → … forever.
The same loop applies to play and seek.

The fix is **execution gating with a React ref**, in
[`useVideoSync.js`](src/features/rooms/hooks/useVideoSync.js). Before applying
any incoming sync event to the local player, the hook raises an
`isApplyingRemoteEvent` ref. The player's own state-change callback checks that
ref *first*: if it is set, the change is just the echo of our own programmatic
action, so the **outbound emit is suppressed entirely**. The guard is released
when the player settles into the expected normalized state, with a hard timeout
fallback so it can never get stuck. The flag is a `useRef` and never React
state — `setState` is async and batched, so a state-based guard would still be
`false` when the echo callback fires synchronously, and the loop would run
before the re-render landed. Refs update synchronously; that is the whole trick.

Layered on top is a **±1.0-second seek-variance filter**: an incoming time that
is within one second of local playback never triggers a hard seek, because a
hard seek for sub-second drift causes a visible stutter for the slower-connection
peer. Only drift beyond the threshold is corrected. Combined, these two
mechanisms give zero echo events and no stutter-storms.

---

## Other architectural decisions

- **State** — a single Zustand store
  ([`useRoomStore.js`](src/features/rooms/stores/useRoomStore.js)), flat-shaped,
  consumed only through narrow selectors. No React Context: sync events fire
  many times per second and Context would cascade re-renders across the tree.
  The chat buffer is capped at 200 messages.
- **Player abstraction** — YouTube and HTML5 sit behind one polymorphic
  controller (`play / pause / seekTo / getCurrentTime / getDuration / getState /
  isReady / destroy`). The sync layer never branches on player type.
- **Payload safety** — there is no compiler, so every inbound socket event is
  guarded by a runtime validator from
  [`room-types.js`](src/features/rooms/room-types.js) before it touches state.
- **Reconnection** — Socket.IO exponential backoff (0.5 s → 8 s). On reconnect
  the client re-joins the room and requests a fresh snapshot to resync; a
  "Reconnecting…" pill is shown from the store.
- **Room lifecycle** — unguessable `crypto.randomUUID()` room ids; host
  migration on disconnect; empty-room cleanup; occupancy cap (see below); a
  rejected over-capacity socket gets a clear user-facing message.
- **Clock skew** — heartbeats are stamped with server time; the client computes
  its offset so drift math is not poisoned by mismatched device clocks.
- **Teardown** — every effect tears down fully: socket listeners removed by
  reference, intervals cleared, `player.destroy()`, every media `track.stop()`,
  `peer.destroy()`. `beforeunload` frees the room slot when a tab closes.

### Occupancy cap — note on a deviation from the source spec

The source spec hard-caps rooms at **2** ("it's a couples app"). The product
owner explicitly also wanted small **groups of friends**. The cap is therefore
a single tunable constant, `MAX_ROOM_OCCUPANCY` in
[`room-types.js`](src/features/rooms/room-types.js), defaulting to **8** — the
practical ceiling for an unrelayed WebRTC mesh. Set it back to `2` for strict
couples-only mode.

---

## TURN server caveat (post-MVP infrastructure)

The WebRTC voice/video layer is configured with Google's public **STUN**
servers, which is enough for most networks. However, roughly **10–15 % of
real-world NAT setups** (symmetric NATs, strict corporate firewalls) cannot be
traversed with STUN alone and require a **TURN relay server**.

A clearly-commented TURN placeholder is in
[`useWebRTCConnection.js`](src/features/rooms/hooks/useWebRTCConnection.js) and
the corresponding env vars are in `.env.local.example`. Standing up a TURN
server (e.g. `coturn`) is deliberately left as post-MVP infrastructure work.
In production, mint **short-lived** TURN credentials server-side rather than
shipping a static long-lived secret to the browser.

If two peers cannot establish A/V on a restrictive network, the app still works
fully for synchronized video + text chat — and denied camera/mic permission
degrades gracefully to text-chat-only.

---

## Project structure

```
server.js                         # custom Next.js + Socket.IO host
src/
├── app/
│   ├── page.jsx                   # lobby (create / join)
│   ├── layout.jsx · globals.css
│   ├── rooms/[roomId]/page.jsx    # the room
│   ├── rooms/[roomId]/error.jsx   # route-level error boundary
│   └── api/socket/route.js        # signaling info/health route
├── components/
│   ├── ui/{Button,Modal,ErrorBoundary}.jsx
│   └── FloatingSidebar.jsx
├── lib/
│   ├── socket/{socketServer,socketClient}.js
│   ├── player/{createPlayerController,youtubeController,html5Controller}.js
│   └── utils.js
└── features/rooms/
    ├── components/{WatchTheater,VideoController,WebRTCOverlay,ChatSidebar}.jsx
    ├── hooks/{useRoomSocket,useVideoSync,useWebRTCConnection}.js
    ├── stores/useRoomStore.js
    └── room-types.js              # JSDoc typedefs + frozen constants + validators
```

---

## JavaScript-only

There are no `.ts` / `.tsx` files. Type contracts are expressed with JSDoc
`@typedef` blocks, TypeScript enums are replaced by `Object.freeze`d constants,
and — critically — every untrusted socket payload is checked by a runtime
validator at the boundary. All components declare `PropTypes`.
