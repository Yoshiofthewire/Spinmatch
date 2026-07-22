import { Router } from 'express';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { NotFoundError } from '../lib/httpErrors.js';

export const releasesRouter = Router();

releasesRouter.get('/:mbid/tracks', async (req, res, next) => {
  try {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) throw new NotFoundError('No release found for this release group');

    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    res.json({ release, tracks });
  } catch (err) {
    next(err);
  }
});
