import { Router } from 'express';
import { searchAll } from '../services/musicbrainz.js';
import { BadRequestError } from '../lib/httpErrors.js';

export const searchRouter = Router();

searchRouter.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) throw new BadRequestError('Query parameter "q" is required');
    const results = await searchAll(q);
    res.json(results);
  } catch (err) {
    next(err);
  }
});
