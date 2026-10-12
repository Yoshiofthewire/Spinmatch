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
import { historyRouter } from './routes/history.js';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { sameOriginOnly } from './middleware/sameOriginOnly.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `gate` is injectable for tests; not a boolean flag, so prod can't be switched off.
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

export function createApp({ gate = requireAuth, clientDist = CLIENT_DIST } = {}) {
  const app = express();
  // Governs req.ip (login rate limiter) and req.secure (Secure cookie).
  // `!= null`: 0 and false are meaningful ("trust nothing").
  if (config.trustProxy != null) {
    try {
      app.set('trust proxy', config.trustProxy);
    } catch (err) {
      // proxy-addr throws on bad IPs/subnets; explain before rethrowing.
      console.error(
        `Invalid TRUST_PROXY value ${JSON.stringify(String(config.trustProxy))}: ${err.message}`
      );
      console.error('Expected a hop count (e.g. 1), a subnet (10.0.0.0/8), or a preset (loopback).');
      throw err;
    }
  }
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));

  // CSRF guard for all unsafe methods; SSE GETs that do real work opt in per route.
  app.use('/api', (req, res, next) => (
    req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
      ? next()
      : sameOriginOnly(req, res, next)
  ));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Public routes.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/config', configRouter);
  app.use('/api/auth', authRouter);

  // Everything else requires a session.
  app.use('/api/search', gate, searchRouter);
  app.use('/api/artists', gate, artistsRouter);
  app.use('/api/releases', gate, releasesRouter);
  app.use('/api/verify', gate, verifyRouter);
  app.use('/api/cover', gate, coverRouter);
  app.use('/api/ingest', gate, ingestRouter);
  app.use('/api/library', gate, libraryRouter);
  app.use('/api/playlists', gate, playlistsRouter);
  app.use('/api/history', gate, historyRouter);

  // Built client; SPA fallback to index.html for non-API paths.
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    if (fs.existsSync(path.join(clientDist, 'index.html'))) {
      // With `root`, Express 5 applies its dot-file refusal only below clientDist, so an
      // install under a dot directory (~/.local/...) still serves the app.
      res.sendFile('index.html', { root: clientDist });
    } else {
      res.status(404).send('Client build not found. Run `npm run build` first.');
    }
  });

  app.use(errorHandler);
  return app;
}
