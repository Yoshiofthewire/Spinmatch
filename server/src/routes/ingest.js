import { Router } from 'express';
import { ingestEnabled } from '../config.js';
import { scanIngestDir, processIngest, findCandidatesForFile, resolveLooseFileOverride } from '../services/ingest.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';

export const ingestRouter = Router();

// CSRF guard for the state-changing ingest routes (they move/tag real files).
// The app is cookieless and same-origin only, so we reject anything a browser
// marks as cross-site. `Sec-Fetch-Site` is set by the browser on every request
// including EventSource (which, unlike fetch, can't send custom headers), so it
// works for the SSE endpoint too; `Origin` is a fallback. Requests with neither
// header (older browsers, curl, our own tests) are allowed — this is a
// defense against the drive-by <img>/fetch CSRF vector, not an auth control.
function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  if (site) {
    if (site !== 'same-origin' && site !== 'none') {
      return next(new BadRequestError('Cross-site requests are not allowed for this endpoint'));
    }
    return next();
  }
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(new BadRequestError('Invalid Origin header'));
    }
    if (originHost !== req.get('Host')) {
      return next(new BadRequestError('Cross-origin requests are not allowed for this endpoint'));
    }
  }
  next();
}

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

ingestRouter.post('/process', sameOriginOnly, async (req, res, next) => {
  try {
    const { dryRun = false } = req.body || {};
    const result = await processIngest({ dryRun: Boolean(dryRun) });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ingestRouter.post('/file/resolve', sameOriginOnly, async (req, res, next) => {
  try {
    const { path: filePath, name, recordingMbid, dryRun = false } = req.body || {};
    if (!filePath || !name || !recordingMbid) {
      throw new BadRequestError('path, name, and recordingMbid are required');
    }
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

  try {
    const result = await processIngest({ dryRun, onItem: (item) => send('item', item) });
    send('done', {
      matched: result.matched.length,
      needsReview: result.needsReview.length,
      dryRun: result.dryRun,
      error: result.error,
    });
  } catch (err) {
    send('error', { message: err.message, code: err.code });
  } finally {
    res.end();
  }
});
