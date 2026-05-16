// server.js
/**
 * Custom Node server.
 *
 * Why a custom server instead of `src/app/api/socket/route.js`:
 * Socket.IO needs a long-lived reference to the underlying Node HTTP server to
 * attach its WebSocket upgrade handler. Next.js App Router route handlers are
 * request-scoped and serverless-shaped — they cannot own a persistent io
 * instance. A thin custom server is the defensible, production-standard way to
 * co-host Next.js and Socket.IO on one port. The `route.js` attach-point in the
 * spec is therefore implemented here, at the real HTTP layer.
 */
'use strict';

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  // Attach the Socket.IO singleton + all room/signaling handlers.
  // Loaded with the .js extension explicitly; this file is CommonJS.
  const { attachSocketServer } = require('./src/lib/socket/socketServer.js');
  attachSocketServer(httpServer);

  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[cowatch] ready on http://localhost:${port}  (dev=${dev})`);
  });
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cowatch] failed to start', err);
  process.exit(1);
});
