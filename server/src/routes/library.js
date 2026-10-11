import { Router } from 'express';
import { dirname } from 'node:path';
import { libraryEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  getStats, listArtists, listAlbums, listTracks, getAlbumTracks, getTrackById,
  findIncompleteAlbums, findHealthIssues, findDuplicateGroups, listHealthTracks,
  isHealthIssue, listTrackPaths,
} from '../services/libraryRepo.js';
import {
  getArtistDiscography, saveArtistLink, deleteArtistLink, checkAlbumAgainstMusicBrainz,
  resolveMissingTrack,
} from '../services/libraryDiscography.js';
import { getFixCandidates, getFingerprintCandidates, applyFix } from '../services/libraryFix.js';
import { previewBulkFix, applyBulkFix, MAX_BULK_FIX } from '../services/libraryBulkFix.js';
import { editTrackTags, editAlbumTags } from '../services/tagEdit.js';
import { trashDuplicate, restoreDuplicate } from '../services/duplicateTrash.js';
import {
  getSimilarArtists, getRecommendations, reconstructPlaylist,
} from '../services/libraryDiscovery.js';
import { checkOwned } from '../services/libraryOwned.js';
import { readCoverArt } from '../services/tags.js';
import { readSidecarCover } from '../services/coverArt.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { scanLibrary, rescanDirs } from '../services/libraryScanner.js';
import { detectAlbumGaps } from '../services/libraryGaps.js';
import { sweepArtistMissing } from '../services/libraryArtistGaps.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { assertMbid, isMbid } from '../lib/mbid.js';
import { TTLCache } from '../lib/cache.js';
import { MAX_TRACK_NUMBER, MAX_DISC_NUMBER } from '../lib/tagLimits.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';

export const libraryRouter = Router();

libraryRouter.use((req, res, next) => {
  if (!libraryEnabled()) return next(new NotFoundError('The library feature is not configured'));
  next();
});

libraryRouter.get('/stats', (req, res) => {
  res.json(getStats(getDb()));
});

const MAX_PAGE_SIZE = 200;
const MAX_PLAYLIST_LINES = 500;

function str(value) {
  return value ? String(value) : undefined;
}

// The floor matters: SQLite reads a negative LIMIT as unbounded.
function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function paging(req, defaultLimit) {
  const offset = Number(req.query.offset);
  return {
    limit: positiveInt(req.query.limit, defaultLimit, MAX_PAGE_SIZE),
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}

libraryRouter.get('/artists', (req, res) => {
  const { limit, offset } = paging(req, 50);
  const { artists, total } = listArtists(getDb(), {
    sort: str(req.query.sort), q: str(req.query.q), limit, offset,
  });
  res.json({ artists, total, limit, offset });
});

libraryRouter.get('/albums', (req, res) => {
  const { limit, offset } = paging(req, 24);
  const { albums, total } = listAlbums(getDb(), {
    artist: str(req.query.artist), sort: str(req.query.sort), q: str(req.query.q), limit, offset,
  });
  res.json({ albums, total, limit, offset });
});

libraryRouter.get('/tracks', (req, res) => {
  const { limit, offset } = paging(req, 100);
  const { tracks, total } = listTracks(getDb(), {
    artist: str(req.query.artist),
    album: str(req.query.album),
    q: str(req.query.q),
    sort: str(req.query.sort),
    limit,
    offset,
  });
  res.json({ tracks, total, limit, offset });
});

libraryRouter.get('/album-tracks', (req, res, next) => {
  try {
    const artist = str(req.query.artist);
    const album = str(req.query.album);
    if (!album) throw new BadRequestError('album is required');
    res.json({ tracks: getAlbumTracks(getDb(), { artist, album }) });
  } catch (err) {
    next(err);
  }
});

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);

// Cold taglib parses are synchronous and serialize a grid's covers. Byte-bounded; null (no art) is cached too.
const coverCache = new TTLCache({
  maxEntries: 512,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: (value) => value?.bytes?.length ?? 0,
});
const COVER_TTL_MS = 60 * 60 * 1000;

libraryRouter.get('/cover/:trackId', async (req, res, next) => {
  try {
    const track = getTrackById(getDb(), Number(req.params.trackId));
    if (!track) throw new NotFoundError('Track not found');

    // Answered before touching disk: art only changes with mtime/size. res.end() won't 304 by itself.
    const identity = `${track.mtimeMs ?? 0}-${track.sizeBytes ?? 0}`;
    res.set('ETag', `"${identity}"`);
    res.set('Cache-Control', 'private, max-age=86400');
    if (req.fresh) {
      res.status(304).end();
      return;
    }

    const cacheKey = `${track.id}:${identity}`;
    let cover = coverCache.get(cacheKey);
    if (cover === undefined) {
      const real = await assertReadableInsideMusicDir(track.path);
      // An unparseable file falls through to sidecar art rather than failing.
      const embedded = await readCoverArt(real).catch(() => null);
      cover = embedded ?? (await readSidecarCover(dirname(real)));
      coverCache.set(cacheKey, cover, COVER_TTL_MS);
    }
    if (!cover) {
      // 204: no art is a normal answer, and doesn't log a console error per card.
      res.status(204).end();
      return;
    }
    // Embedded mime type is file-controlled (text/html, image/svg+xml): whitelist it.
    res.set('Content-Type', IMAGE_TYPES.has(cover.mimeType) ? cover.mimeType : 'application/octet-stream');
    res.send(cover.bytes);
  } catch (err) {
    next(err);
  }
});

const CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
};

// Path comes from the index by id, re-validated via realpath against planted symlinks.
// sendFile, not pipe(): an unhandled ReadStream error under pipe() crashes the process.
libraryRouter.get('/stream/:trackId', async (req, res, next) => {
  try {
    const track = getTrackById(getDb(), Number(req.params.trackId));
    if (!track) throw new NotFoundError('Track not found');
    const real = await assertReadableInsideMusicDir(track.path);

    res.sendFile(real, {
      acceptRanges: true,
      headers: {
        'Content-Type': CONTENT_TYPES[track.ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      },
    }, (err) => {
      if (!err) return;
      // Client hung up; nothing to report.
      if (err.code === 'ECONNABORTED' || res.headersSent) return;
      next(err);
    });
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/scan', async (req, res, next) => {
  try {
    const summary = await scanLibrary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/missing', sameOriginOnly, async (req, res, next) => {
  try {
    const releaseGroup = assertMbid(str(req.query.releaseGroup), 'releaseGroup');
    // Opt in to the slow yt-dlp pass with ?verify=1; default is the fast path.
    res.json(await detectAlbumGaps(releaseGroup, { verify: req.query.verify === '1' }));
  } catch (err) {
    next(err);
  }
});

// Streaming /missing?verify=1; same events as /api/verify/album/:mbid/stream, minus `album`.
libraryRouter.get('/missing/stream', sameOriginOnly, sseStream(async ({ req, send, signal }) => {
  const releaseGroup = str(req.query.releaseGroup);
  if (!isMbid(releaseGroup)) {
    send('error', { code: 'BAD_REQUEST', message: 'a valid releaseGroup is required' });
    return STREAM_HANDLED;
  }
  await detectAlbumGaps(releaseGroup, {
    verify: true,
    signal,
    onMissing: (entry) => send('result', entry),
  });
  return undefined;
}));

// Whole-discography sweep: minutes of 1-req/s lookups, persisted in verified_links across restarts.
libraryRouter.get('/artist-missing/stream', sameOriginOnly, sseStream(async ({ req, send, signal }) => {
  const artist = str(req.query.artist);
  if (!artist) {
    send('error', { code: 'BAD_REQUEST', message: 'an artist is required' });
    return STREAM_HANDLED;
  }
  // The summary becomes the `done` payload.
  return sweepArtistMissing(artist, {
    signal,
    onEvent: (event, data) => send(event, data),
  });
}));

// Offline: no upstream calls, so these survive a MusicBrainz outage.
libraryRouter.get('/incomplete', (req, res) => {
  res.json({ albums: findIncompleteAlbums(getDb()) });
});

libraryRouter.get('/health', (req, res) => {
  res.json(findHealthIssues(getDb()));
});

libraryRouter.get('/health-tracks', (req, res, next) => {
  try {
    const issue = str(req.query.issue);
    if (!issue || !isHealthIssue(issue)) throw new BadRequestError('a known issue is required');
    const { limit, offset } = paging(req, 50);
    res.json({ ...listHealthTracks(getDb(), { issue, limit, offset }), limit, offset });
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/duplicates', (req, res) => {
  res.json({ groups: findDuplicateGroups(getDb()) });
});

const MAX_OWNED_ITEMS = 500;

libraryRouter.post('/owned', (req, res, next) => {
  try {
    const albums = Array.isArray(req.body?.albums) ? req.body.albums : [];
    const recordings = Array.isArray(req.body?.recordings) ? req.body.recordings : [];
    if (albums.length + recordings.length > MAX_OWNED_ITEMS) {
      throw new BadRequestError(`at most ${MAX_OWNED_ITEMS} items per request`);
    }
    res.json(checkOwned({ albums, recordings }));
  } catch (err) {
    next(err);
  }
});

// MusicBrainz-backed: button-triggered only, never on page render.
libraryRouter.get('/discography', async (req, res, next) => {
  try {
    const artist = str(req.query.artist);
    if (!artist) throw new BadRequestError('artist is required');
    res.json(await getArtistDiscography(artist));
  } catch (err) {
    next(err);
  }
});

// Catches what the offline check can't, e.g. owning 1..10 of a 12-track album.
libraryRouter.get('/album-gaps', async (req, res, next) => {
  try {
    const artist = str(req.query.artist);
    const album = str(req.query.album);
    if (!album) throw new BadRequestError('album is required');
    res.json(await checkAlbumAgainstMusicBrainz(artist, album));
  } catch (err) {
    next(err);
  }
});

// Resolve only; the YouTube half is POST /api/verify, behind its own rate limiter.
libraryRouter.get('/missing-track', async (req, res, next) => {
  try {
    const album = str(req.query.album);
    if (!album) throw new BadRequestError('album is required');
    const position = positiveInt(req.query.position, null, MAX_TRACK_NUMBER);
    if (!position) throw new BadRequestError('a positive position is required');
    res.json(await resolveMissingTrack(str(req.query.artist) ?? null, album, {
      disc: positiveInt(req.query.disc, 1, MAX_DISC_NUMBER),
      position,
    }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/fix-candidates/:trackId', async (req, res, next) => {
  try {
    res.json(await getFixCandidates(Number(req.params.trackId)));
  } catch (err) {
    next(err);
  }
});

// Separate route: spawns fpcalc and spends an AcoustID call.
libraryRouter.get('/fingerprint-candidates/:trackId', async (req, res, next) => {
  try {
    res.json(await getFingerprintCandidates(Number(req.params.trackId)));
  } catch (err) {
    next(err);
  }
});

// Fills empty fields only unless `overwrite` / `replaceCoverArt` opt in. Never renames.
libraryRouter.post('/fix', async (req, res, next) => {
  try {
    const trackId = Number(req.body?.trackId);
    if (!trackId) throw new BadRequestError('trackId is required');
    const recordingMbid = assertMbid(str(req.body?.recordingMbid), 'recordingMbid');
    res.json(await applyFix({
      trackId,
      recordingMbid,
      overwrite: Boolean(req.body?.overwrite),
      replaceCoverArt: Boolean(req.body?.replaceCoverArt),
    }));
  } catch (err) {
    next(err);
  }
});

// Client-supplied tag values; validateTagEdit (inside the service, so no caller skips it) is the control.
// Absent or blank fields are left alone: editing cannot remove a tag.
libraryRouter.patch('/track/:id/tags', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await editTrackTags({ trackId, fields: req.body?.fields }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/album/tags', async (req, res, next) => {
  try {
    const album = str(req.body?.album);
    if (!album) throw new BadRequestError('album is required');
    const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
    const perTrack = Array.isArray(req.body?.perTrack) ? req.body.perTrack : [];
    if ((trackIds?.length ?? 0) > MAX_BULK_FIX || perTrack.length > MAX_BULK_FIX) {
      throw new BadRequestError(`at most ${MAX_BULK_FIX} tracks per request`);
    }
    res.json(await editAlbumTags({
      artist: str(req.body?.artist) ?? null,
      album,
      fields: req.body?.fields ?? {},
      perTrack,
      trackIds,
    }));
  } catch (err) {
    next(err);
  }
});

// Not DELETE: nothing is deleted.
libraryRouter.post('/track/:id/trash', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await trashDuplicate({ trackId }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/track/:id/restore', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await restoreDuplicate({ trackId }));
  } catch (err) {
    next(err);
  }
});

// Hand-off so apply writes exactly what was previewed; a miss recomputes.
const previewCache = new TTLCache({ maxEntries: 32 });
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function previewKey({ artist, album, source }) {
  return JSON.stringify([artist, album, source]);
}

libraryRouter.post('/bulk-fix/preview', async (req, res, next) => {
  try {
    const album = str(req.body?.album);
    if (!album) throw new BadRequestError('album is required');
    const args = {
      artist: str(req.body?.artist) ?? null,
      album,
      source: str(req.body?.source) ?? 'path',
    };
    const preview = await previewBulkFix(args);
    previewCache.set(previewKey(args), preview, PREVIEW_TTL_MS);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

// Takes track ids only, never tag values, so it can't set arbitrary tags.
libraryRouter.post('/bulk-fix/apply', async (req, res, next) => {
  try {
    const album = str(req.body?.album);
    if (!album) throw new BadRequestError('album is required');
    const trackIds = req.body?.trackIds;
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      throw new BadRequestError('trackIds is required');
    }
    if (trackIds.length > MAX_BULK_FIX) {
      throw new BadRequestError(`Too many tracks in one request (max ${MAX_BULK_FIX})`);
    }
    const args = {
      artist: str(req.body?.artist) ?? null,
      album,
      source: str(req.body?.source) ?? 'path',
    };
    // Reject, don't filter: a silently dropped id would go unreported.
    const ids = trackIds.map((id) => (typeof id === 'number' || typeof id === 'string' ? Number(id) : NaN));
    if (!ids.every((id) => Number.isInteger(id) && id > 0)) {
      throw new BadRequestError('trackIds must all be positive whole numbers');
    }

    res.json(await applyBulkFix({
      ...args,
      trackIds: ids,
      preview: previewCache.get(previewKey(args)) ?? null,
    }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/rescan', async (req, res, next) => {
  try {
    const artist = str(req.body?.artist);
    const album = str(req.body?.album);
    if (!artist && !album) throw new BadRequestError('artist or album is required');
    const paths = listTrackPaths(getDb(), { artist, album });
    if (paths.length === 0) throw new NotFoundError('No indexed tracks match');
    const dirs = [...new Set(paths.map((p) => dirname(p)))];
    res.json(await rescanDirs(dirs));
  } catch (err) {
    next(err);
  }
});

// --- Discovery: button-triggered only; these walk the 1-req/s MusicBrainz queue.

libraryRouter.get('/similar-artists', async (req, res, next) => {
  try {
    res.json(await getSimilarArtists({ limit: paging(req, 30).limit }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/recommendations', async (req, res, next) => {
  try {
    res.json(await getRecommendations({ limit: paging(req, 24).limit }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/reconstruct-playlist', (req, res, next) => {
  try {
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestError('lines is required');
    }
    if (lines.length > MAX_PLAYLIST_LINES) {
      throw new BadRequestError(`Too many lines in one request (max ${MAX_PLAYLIST_LINES})`);
    }
    res.json(reconstructPlaylist(lines));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/artist-link', (req, res, next) => {
  try {
    const artist = str(req.body?.artist);
    if (!artist) throw new BadRequestError('artist is required');
    const mbArtistId = assertMbid(str(req.body?.mbArtistId), 'mbArtistId');
    saveArtistLink(getDb(), { artist, mbArtistId, confirmed: 1 });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

libraryRouter.delete('/artist-link', (req, res, next) => {
  try {
    const artist = str(req.body?.artist) ?? str(req.query.artist);
    if (!artist) throw new BadRequestError('artist is required');
    res.json({ ok: true, cleared: deleteArtistLink(getDb(), artist) });
  } catch (err) {
    next(err);
  }
});
