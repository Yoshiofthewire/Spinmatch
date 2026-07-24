import { Router } from 'express';
import { libraryEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import { getStats, listArtists, listAlbums, listTracks } from '../services/libraryRepo.js';
import { scanLibrary } from '../services/libraryScanner.js';
import { detectAlbumGaps } from '../services/libraryGaps.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';

export const libraryRouter = Router();

libraryRouter.use((req, res, next) => {
  if (!libraryEnabled()) return next(new NotFoundError('The library feature is not configured'));
  next();
});

libraryRouter.get('/stats', (req, res) => {
  res.json(getStats(getDb()));
});

libraryRouter.get('/artists', (req, res) => {
  res.json({ artists: listArtists(getDb()) });
});

libraryRouter.get('/albums', (req, res) => {
  const artist = req.query.artist ? String(req.query.artist) : undefined;
  res.json({ albums: listAlbums(getDb(), artist) });
});

libraryRouter.get('/tracks', (req, res) => {
  const artist = req.query.artist ? String(req.query.artist) : undefined;
  const album = req.query.album ? String(req.query.album) : undefined;
  res.json({ tracks: listTracks(getDb(), { artist, album }) });
});

libraryRouter.post('/scan', sameOriginOnly, async (req, res, next) => {
  try {
    const summary = await scanLibrary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/missing', sameOriginOnly, async (req, res, next) => {
  try {
    const releaseGroup = req.query.releaseGroup ? String(req.query.releaseGroup) : '';
    if (!releaseGroup) throw new BadRequestError('releaseGroup is required');
    res.json(await detectAlbumGaps(releaseGroup));
  } catch (err) {
    next(err);
  }
});
