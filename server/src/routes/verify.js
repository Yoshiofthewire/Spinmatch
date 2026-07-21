import { Router } from 'express';
import { verifyTrack } from '../services/verifyTrack.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { BadRequestError, QuotaExceededError, NotFoundError } from '../lib/httpErrors.js';

export const verifyRouter = Router();

verifyRouter.post('/', async (req, res, next) => {
  try {
    const { artist, title, album, lengthMs } = req.body || {};
    if (!artist || !title || !lengthMs) {
      throw new BadRequestError('artist, title, and lengthMs are required');
    }
    const result = await verifyTrack({ artist, title, album, lengthMs });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

verifyRouter.post('/album/:mbid', async (req, res, next) => {
  try {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) throw new NotFoundError('No release found for this release group');

    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    const results = [];

    for (const track of tracks) {
      if (track.lengthMs == null) {
        results.push({ position: track.position, title: track.title, status: 'no_results', video: null, deltaSeconds: null });
        continue;
      }
      try {
        const verified = await verifyTrack({
          artist: release.artist,
          title: track.title,
          album: release.title,
          lengthMs: track.lengthMs,
        });
        results.push({ position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          return res.json({
            album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
            estimatedQuotaUnits: tracks.length * 101,
            results,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }

    res.json({
      album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
      estimatedQuotaUnits: tracks.length * 101,
      results,
    });
  } catch (err) {
    next(err);
  }
});
