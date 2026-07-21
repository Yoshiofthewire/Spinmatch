import { Router } from 'express';
import { browseReleaseGroupsByArtist } from '../services/musicbrainz.js';

export const artistsRouter = Router();

artistsRouter.get('/:mbid/albums', async (req, res, next) => {
  try {
    const result = await browseReleaseGroupsByArtist(req.params.mbid);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
