import { Router } from 'express';
import { getFrontCoverUrl } from '../services/coverArt.js';

export const coverRouter = Router();

coverRouter.get('/release-group/:mbid', async (req, res, next) => {
  try {
    const url = await getFrontCoverUrl(req.params.mbid);
    res.redirect(302, url || '/placeholder-cover.svg');
  } catch (err) {
    next(err);
  }
});
