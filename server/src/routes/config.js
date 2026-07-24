import { Router } from 'express';
import { config, ingestEnabled, libraryEnabled } from '../config.js';

export const configRouter = Router();

configRouter.get('/', (req, res) => {
  res.json({
    metubeUrl: config.metubeUrl,
    ingestEnabled: ingestEnabled(),
    libraryEnabled: libraryEnabled(),
  });
});
