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
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/search', searchRouter);
  app.use('/api/artists', artistsRouter);
  app.use('/api/releases', releasesRouter);
  app.use('/api/verify', verifyRouter);
  app.use('/api/cover', coverRouter);
  app.use('/api/config', configRouter);
  app.use('/api/ingest', ingestRouter);

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
