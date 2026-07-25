import { Router } from 'express';
import { browseReleaseGroupsByArtist } from '../services/musicbrainz.js';
import { requireMbidParam } from '../lib/mbid.js';

export const artistsRouter = Router();

artistsRouter.get('/:mbid/albums', requireMbidParam(), async (req, res, next) => {
  try {
    const result = await browseReleaseGroupsByArtist(req.params.mbid);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
