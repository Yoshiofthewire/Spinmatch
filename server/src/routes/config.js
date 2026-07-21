import { Router } from 'express';
import { config } from '../config.js';

export const configRouter = Router();

configRouter.get('/', (req, res) => {
  res.json({ metubeUrl: config.metubeUrl });
});
