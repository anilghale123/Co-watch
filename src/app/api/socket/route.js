// src/app/api/socket/route.js
/**
 * Socket.IO attach-point — DOCUMENTATION ROUTE.
 *
 * The spec's directory structure places the Socket.IO server here. In practice
 * Socket.IO must bind to the long-lived Node HTTP server, and App Router route
 * handlers are request-scoped and cannot own a persistent `io` instance. The
 * real attach therefore happens in `server.js` ->
 * `src/lib/socket/socketServer.js`, and the live Socket.IO endpoint is
 * `/api/socketio`.
 *
 * This route exists only as a health/info endpoint so the path in the spec is
 * not a dead link.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    service: 'cowatch-signaling',
    status: 'ok',
    socketPath: '/api/socketio',
    note: 'Socket.IO is attached by server.js at the HTTP layer. Connect a Socket.IO client to path /api/socketio.',
  });
}
