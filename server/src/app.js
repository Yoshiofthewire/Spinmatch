import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searchRouter } from './routes/search.js';
import { artistsRouter } from './routes/artists.js';
import { releasesRouter } from './routes/releases.js';
import { verifyRouter } from './routes/verify.js';
import { coverRouter } from './routes/cover.js';
import { configRouter } from './routes/config.js';
import { ingestRouter } from './routes/ingest.js';
import { libraryRouter } from './routes/library.js';
import { playlistsRouter } from './routes/playlists.js';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { sameOriginOnly } from './middleware/sameOriginOnly.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `gate` is the session check, injected so feature-route tests that aren't
// exercising auth can pass a pass-through. It is a dependency rather than an
// `auth: false` flag on purpose: a boolean that switches off a security control
// is a bypass switch shipping in production code, and this way the default is
// the only thing production can get.
export function createApp({ gate = requireAuth } = {}) {
  const app = express();
  // Off unless configured. See config.trustProxy — this governs both req.ip
  // (which the login rate limiter keys on) and req.secure (which decides whether
  // the session cookie is marked Secure).
  //
  // `!= null` rather than a truthiness check: 0 and false are both meaningful
  // values here ("trust nothing"), and silently skipping them would be the same
  // class of bug as the string/number mix-up parseTrustProxy exists to fix.
  if (config.trustProxy != null) {
    try {
      app.set('trust proxy', config.trustProxy);
    } catch (err) {
      // proxy-addr throws on anything it can't read as an IP or subnet. Failing
      // loudly but comprehensibly beats a raw TypeError stack at boot, and
      // beats starting up with the setting quietly inert.
      console.error(
        `Invalid TRUST_PROXY value ${JSON.stringify(String(config.trustProxy))}: ${err.message}`
      );
      console.error('Expected a hop count (e.g. 1), a subnet (10.0.0.0/8), or a preset (loopback).');
      throw err;
    }
  }
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));

  // CSRF guard for the whole API, in one place. Applying it per-route meant two
  // POST /api/verify endpoints never got it — each spawning a rate-limited
  // yt-dlp subprocess per track. Safe methods are exempt; the GET endpoints that
  // still need it (the SSE streams, which do real work) opt in individually.
  app.use('/api', (req, res, next) => (
    req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
      ? next()
      : sameOriginOnly(req, res, next)
  ));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Public routes: liveness, feature-flag config, and the auth flow itself.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/config', configRouter);
  app.use('/api/auth', authRouter);

  // Everything else requires a valid session (SETUP_REQUIRED until an admin
  // is created on first run, then UNAUTHENTICATED until login).
  app.use('/api/search', gate, searchRouter);
  app.use('/api/artists', gate, artistsRouter);
  app.use('/api/releases', gate, releasesRouter);
  app.use('/api/verify', gate, verifyRouter);
  app.use('/api/cover', gate, coverRouter);
  app.use('/api/ingest', gate, ingestRouter);
  app.use('/api/library', gate, libraryRouter);
  app.use('/api/playlists', gate, playlistsRouter);

  // In production, the client is pre-built by Vite; serve it and fall back to
  // index.html for client-side routing on any non-API path.
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    const indexHtml = path.join(clientDist, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).send('Client build not found. Run `npm run build` first.');
    }
  });

  app.use(errorHandler);
  return app;
}
