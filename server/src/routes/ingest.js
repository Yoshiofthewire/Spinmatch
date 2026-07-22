import { Router } from 'express';
import { ingestEnabled } from '../config.js';
import { scanIngestDir, processIngest } from '../services/ingest.js';
import { NotFoundError } from '../lib/httpErrors.js';

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

ingestRouter.post('/process', async (req, res, next) => {
  try {
    const result = await processIngest();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
