import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { libraryEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  getStats, listArtists, listAlbums, listTracks, getAlbumTracks, getTrackById,
  findIncompleteAlbums, findHealthIssues, findDuplicateGroups, listHealthTracks,
  isHealthIssue, listTrackPaths,
} from '../services/libraryRepo.js';
import {
  getArtistDiscography, saveArtistLink, checkAlbumAgainstMusicBrainz,
} from '../services/libraryDiscography.js';
import { getFixCandidates, applyFix } from '../services/libraryFix.js';
import { checkOwned } from '../services/libraryOwned.js';
import { readCoverArt } from '../services/tags.js';
import { readSidecarCover } from '../services/coverArt.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { scanLibrary, rescanDirs } from '../services/libraryScanner.js';
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

const MAX_PAGE_SIZE = 200;

function str(value) {
  return value ? String(value) : undefined;
}

libraryRouter.get('/artists', (req, res) => {
  res.json({ artists: listArtists(getDb(), { sort: str(req.query.sort) }) });
});

libraryRouter.get('/albums', (req, res) => {
  res.json({
    albums: listAlbums(getDb(), {
      artist: str(req.query.artist),
      sort: str(req.query.sort),
    }),
  });
});

libraryRouter.get('/tracks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, MAX_PAGE_SIZE);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
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

// Album art, read on demand rather than extracted to disk during the scan. Only
// the covers actually on screen are ever read, so a 2,000-album grid costs one
// tag read per visible card. Cached hard: the art can only change if the file
// does, and a changed file gets a new id-independent mtime anyway.
libraryRouter.get('/cover/:trackId', async (req, res, next) => {
  try {
    const track = getTrackById(getDb(), Number(req.params.trackId));
    if (!track) throw new NotFoundError('Track not found');
    const real = await assertReadableInsideMusicDir(track.path);
    // Embedded art first, then a cover/folder/front image beside the audio —
    // plenty of libraries store art that way and would otherwise show nothing.
    // A file taglib can't parse (truncated, corrupt, or mislabelled) throws
    // rather than returning null. That must not fail the request: art is
    // best-effort, and a broken file is exactly the case where the cover image
    // beside it is the only art available. The Health tab is where unreadable
    // files get reported.
    const embedded = await readCoverArt(real).catch(() => null);
    const cover = embedded ?? (await readSidecarCover(dirname(real)));
    if (!cover) {
      // 204 rather than 404: "this album has no art" is a normal answer, not an
      // error. The client's <img> falls back to the placeholder either way, but
      // a 204 is cacheable and doesn't log a console error for every artless
      // album in the grid — and sidecar art can't be ruled out without looking,
      // so an artless album is always one wasted request.
      res.set('Cache-Control', 'private, max-age=86400');
      res.status(204).end();
      return;
    }
    res.set('Content-Type', cover.mimeType);
    res.set('Cache-Control', 'private, max-age=86400');
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

// Streams a local file for the preview player. The path is read back out of the
// index by id and never accepted from the client, then re-validated through
// realpath so a symlink planted inside MUSIC_DIR can't be used to read
// arbitrary files. Range support is what makes seeking work.
libraryRouter.get('/stream/:trackId', async (req, res, next) => {
  try {
    const track = getTrackById(getDb(), Number(req.params.trackId));
    if (!track) throw new NotFoundError('Track not found');
    const real = await assertReadableInsideMusicDir(track.path);
    const { size } = await stat(real);

    res.set('Content-Type', CONTENT_TYPES[track.ext] || 'application/octet-stream');
    res.set('Accept-Ranges', 'bytes');

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!range) {
      res.set('Content-Length', String(size));
      createReadStream(real).pipe(res);
      return;
    }

    // A suffix range ("bytes=-500") means the last N bytes.
    const hasStart = range[1] !== '';
    const start = hasStart ? Number(range[1]) : Math.max(size - Number(range[2] || 0), 0);
    const end = hasStart && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.set('Content-Range', `bytes */${size}`);
      res.status(416).end();
      return;
    }

    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    res.set('Content-Length', String(end - start + 1));
    createReadStream(real, { start, end }).pipe(res);
  } catch (err) {
    next(err);
  }
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
    // Opt in to the slow yt-dlp pass with ?verify=1; default is the fast path.
    res.json(await detectAlbumGaps(releaseGroup, { verify: req.query.verify === '1' }));
  } catch (err) {
    next(err);
  }
});

// Streaming counterpart to /missing?verify=1: emits one `result` per missing
// track as its ~1/sec YouTube lookup lands. Same shape as
// /api/verify/album/:mbid/stream so the client reuses one panel, but scoped to
// the tracks you don't already own instead of the whole tracklist. GET for
// EventSource; no `album` event because the caller already knows the count from
// the unverified pass it just rendered.
libraryRouter.get('/missing/stream', sameOriginOnly, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const releaseGroup = str(req.query.releaseGroup);
    if (!releaseGroup) {
      send('error', { code: 'BAD_REQUEST', message: 'releaseGroup is required' });
      return res.end();
    }
    await detectAlbumGaps(releaseGroup, {
      verify: true,
      signal: ac.signal,
      onMissing: (entry) => send('result', entry),
    });
    if (!ac.signal.aborted) send('done', {});
  } catch (err) {
    if (ac.signal.aborted) return res.end();
    if (err.code === 'RATE_LIMITED') send('rate_limited', { code: err.code, message: err.message });
    else send('error', { code: err.code || 'INTERNAL', message: err.message });
  } finally {
    res.end();
  }
});

// Offline reports. No upstream calls, so these keep working when MusicBrainz
// doesn't — which is the whole point of splitting them out.
libraryRouter.get('/incomplete', (req, res) => {
  res.json({ albums: findIncompleteAlbums(getDb()) });
});

libraryRouter.get('/health', (req, res) => {
  res.json(findHealthIssues(getDb()));
});

// The tracks behind one Health count, so the report can be acted on rather than
// just read. Paged: "no embedded cover art" can match most of a library.
libraryRouter.get('/health-tracks', (req, res, next) => {
  try {
    const issue = str(req.query.issue);
    if (!issue || !isHealthIssue(issue)) throw new BadRequestError('a known issue is required');
    const limit = Math.min(Number(req.query.limit) || 50, MAX_PAGE_SIZE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ ...listHealthTracks(getDb(), { issue, limit, offset }), limit, offset });
  } catch (err) {
    next(err);
  }
});

libraryRouter.get('/duplicates', (req, res) => {
  res.json({ groups: findDuplicateGroups(getDb()) });
});

// Which of the given albums/recordings are already in the library. POST because
// a page asks about a few dozen names at once, which is a body, not a query
// string. Offline, so search results stay badgeable when MusicBrainz is down.
const MAX_OWNED_ITEMS = 500;

libraryRouter.post('/owned', sameOriginOnly, (req, res, next) => {
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

// MusicBrainz-backed. Opt-in per artist (the client only calls this on a button
// press) so a slow or failing upstream never blocks a page render.
libraryRouter.get('/discography', async (req, res, next) => {
  try {
    const artist = str(req.query.artist);
    if (!artist) throw new BadRequestError('artist is required');
    res.json(await getArtistDiscography(artist));
  } catch (err) {
    next(err);
  }
});

// Checks one owned album against its MusicBrainz tracklist. Catches missing
// tracks the offline track-number check can't see, e.g. owning 1..10 of a
// 12-track album. Opt-in per album, same reasoning as /discography.
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

// Tag repair for a file already in the library. MusicBrainz-backed, so opt-in
// per track like the panels above.
libraryRouter.get('/fix-candidates/:trackId', async (req, res, next) => {
  try {
    res.json(await getFixCandidates(Number(req.params.trackId)));
  } catch (err) {
    next(err);
  }
});

// Writes tags to a file in place. Never moves or renames it, and only fills
// fields that are currently empty — see libraryFix.js.
libraryRouter.post('/fix', sameOriginOnly, async (req, res, next) => {
  try {
    const trackId = Number(req.body?.trackId);
    const recordingMbid = str(req.body?.recordingMbid);
    if (!trackId || !recordingMbid) {
      throw new BadRequestError('trackId and recordingMbid are required');
    }
    res.json(await applyFix({ trackId, recordingMbid }));
  } catch (err) {
    next(err);
  }
});

// Rescans one artist's or album's folders instead of all of MUSIC_DIR, so a
// just-fixed album refreshes without waiting on a full pass.
libraryRouter.post('/rescan', sameOriginOnly, async (req, res, next) => {
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

// Records the user's choice when artist resolution was ambiguous, so the
// discography diff can proceed and the answer is remembered.
libraryRouter.post('/artist-link', sameOriginOnly, (req, res, next) => {
  try {
    const artist = str(req.body?.artist);
    const mbArtistId = str(req.body?.mbArtistId);
    if (!artist || !mbArtistId) throw new BadRequestError('artist and mbArtistId are required');
    saveArtistLink(getDb(), { artist, mbArtistId, confirmed: 1 });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
