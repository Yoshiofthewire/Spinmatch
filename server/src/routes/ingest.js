import { Router } from 'express';
import { ingestEnabled } from '../config.js';
import { scanIngestDir, processIngest, findCandidatesForFile, resolveLooseFileOverride } from '../services/ingest.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { assertMbid } from '../lib/mbid.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';

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

// Streaming variant: one `item` event per file. GET for EventSource, so dryRun is a query flag.
ingestRouter.get('/process-stream', sameOriginOnly, sseStream(async ({ req, send, signal }) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  // Stop ingesting once the client disconnects.
  const result = await processIngest({ dryRun, onItem: (item) => send('item', item), signal });
  if (result.aborted) return STREAM_HANDLED;
  return {
    matched: result.matched.length,
    needsReview: result.needsReview.length,
    dryRun: result.dryRun,
    error: result.error,
  };
}));
