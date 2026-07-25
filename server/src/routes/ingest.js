import { Router } from 'express';
import { ingestEnabled } from '../config.js';
import { scanIngestDir, processIngest, findCandidatesForFile, resolveLooseFileOverride } from '../services/ingest.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { assertMbid } from '../lib/mbid.js';

export const ingestRouter = Router();

ingestRouter.use((req, res, next) => {
  if (!ingestEnabled()) return next(new NotFoundError('The ingest feature is not configured'));
  next();
});

ingestRouter.get('/scan', async (req, res, next) => {
  try {
    const result = await scanIngestDir();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ingestRouter.get('/file/candidates', async (req, res, next) => {
  try {
    const filePath = String(req.query.path || '');
    if (!filePath) throw new BadRequestError('path is required');
    const result = await findCandidatesForFile(filePath);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ingestRouter.post('/process', async (req, res, next) => {
  try {
    const { dryRun = false } = req.body || {};
    const result = await processIngest({ dryRun: Boolean(dryRun) });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ingestRouter.post('/file/resolve', async (req, res, next) => {
  try {
    const { path: filePath, name, recordingMbid, dryRun = false } = req.body || {};
    if (!filePath || !name) throw new BadRequestError('path and name are required');
    assertMbid(recordingMbid, 'recordingMbid');
    const result = await resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun: Boolean(dryRun) });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Streaming variant: emits one `item` event per file as it finishes, then a
// terminal `done` (or `error`). GET so the browser's EventSource can consume it;
// dryRun is a query flag (?dryRun=1) since EventSource can't send a body.
ingestRouter.get('/process-stream', sameOriginOnly, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Abort the (potentially minutes-long) ingest as soon as the client goes away
  // so we stop fingerprinting/moving files into a dead connection.
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const result = await processIngest({ dryRun, onItem: (item) => send('item', item), signal: ac.signal });
    if (!result.aborted) {
      send('done', {
        matched: result.matched.length,
        needsReview: result.needsReview.length,
        dryRun: result.dryRun,
        error: result.error,
      });
    }
  } catch (err) {
    if (!ac.signal.aborted) send('error', { message: err.message, code: err.code });
  } finally {
    res.end();
  }
});
