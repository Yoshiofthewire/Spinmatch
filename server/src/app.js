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
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `auth` defaults to true so the real server and the auth tests run the full
// session gate. Feature-route tests that aren't exercising auth pass
// `{ auth: false }` to swap the gate for a pass-through — it never affects
// production, which always calls createApp() with no arguments.
export function createApp({ auth = true } = {}) {
  const app = express();
  app.use(express.json());
  const gate = auth ? requireAuth : (req, res, next) => next();
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
