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
// A pasted playlist is matched entirely offline, but it still allocates a query
// per line, so it gets a ceiling like every other list this API accepts.
const MAX_PLAYLIST_LINES = 500;

function str(value) {
  return value ? String(value) : undefined;
}

// Paging helpers shared by every list endpoint, so "limit" means the same thing
// and is capped the same way everywhere.
//
// The floor matters as much as the ceiling. `Math.min(Number(limit) || default,
// MAX)` looks like a cap and isn't one: -1 is truthy, so it survived `||`, and
// Math.min then happily chose it — and SQLite reads a negative LIMIT as "no
// upper bound". `?limit=-1` returned every row in the table from every list
// endpoint, which is the exact thing MAX_PAGE_SIZE exists to prevent. Anything
// that isn't a positive finite number now falls back to the default.
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

// The only Content-Types the cover endpoint will emit. Anything else a file
// claims is served as an opaque download.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);

// Extracted art, keyed on the file identity the ETag is already built from.
//
// The ETag alone only helps a client that has seen the image before. A first
// paint of a 24-card album grid is 24 cold requests, and each one ran a
// synchronous taglib parse of a whole audio file on the main thread — they do
// not overlap, they queue, so the grid's covers arrive serialized behind each
// other while every other request waits its turn too.
//
// Bounded by bytes rather than entries, for the same reason the cover-art
// download cache is: these values are Buffers of wildly different sizes. A null
// is cached too — "this track has no art" costs a tag parse *and* a directory
// scan to rediscover, which is the most wasteful miss of the three.
const coverCache = new TTLCache({
  maxEntries: 512,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: (value) => value?.bytes?.length ?? 0,
});
const COVER_TTL_MS = 60 * 60 * 1000;

// Album art, read on demand rather than extracted to disk during the scan. Only
// the covers actually on screen are ever read, so a 2,000-album grid costs one
// tag read per visible card. Cached hard: the art can only change if the file
// does, and a changed file gets a new id-independent mtime anyway.
libraryRouter.get('/cover/:trackId', async (req, res, next) => {
  try {
    const track = getTrackById(getDb(), Number(req.params.trackId));
    if (!track) throw new NotFoundError('Track not found');

    // The validator is set — and answered — before anything touches the disk.
    // Art can only change if the file does, and a changed file has a new mtime,
    // so the indexed row alone is enough to answer a conditional request. Doing
    // this up front is what makes the ETag worth having: it skips both the tag
    // parse and the sidecar directory scan below, rather than skipping neither.
    //
    // It used to be set on the way out, and on the no-art path that was purely
    // decorative: the comment promised a 304 on re-visit, but res.end() does no
    // freshness checking (only res.send() does), so every repeat request
    // re-parsed the file and re-scanned its folder to rediscover that there is
    // still no cover.
    const identity = `${track.mtimeMs ?? 0}-${track.sizeBytes ?? 0}`;
    res.set('ETag', `"${identity}"`);
    res.set('Cache-Control', 'private, max-age=86400');
    if (req.fresh) {
      res.status(304).end();
      return;
    }

    // Keyed on the same identity as the ETag: art can only change if the file
    // does, and a changed file has a new mtime, so a hit here is never stale.
    const cacheKey = `${track.id}:${identity}`;
    let cover = coverCache.get(cacheKey);
    if (cover === undefined) {
      const real = await assertReadableInsideMusicDir(track.path);
      // Embedded art first, then a cover/folder/front image beside the audio —
      // plenty of libraries store art that way and would otherwise show nothing.
      // A file taglib can't parse (truncated, corrupt, or mislabelled) throws
      // rather than returning null. That must not fail the request: art is
      // best-effort, and a broken file is exactly the case where the cover image
      // beside it is the only art available. The Health tab is where unreadable
      // files get reported.
      const embedded = await readCoverArt(real).catch(() => null);
      cover = embedded ?? (await readSidecarCover(dirname(real)));
      coverCache.set(cacheKey, cover, COVER_TTL_MS);
    }
    if (!cover) {
      // 204 rather than 404: "this album has no art" is a normal answer, not an
      // error. The client's <img> falls back to the placeholder either way, but
      // a 204 is cacheable and doesn't log a console error for every artless
      // album in the grid — and sidecar art can't be ruled out without looking,
      // so an artless album is always one wasted request.
      res.status(204).end();
      return;
    }
    // The mime type of embedded art comes out of the file's own tag, i.e. from a
    // file the user downloaded from who-knows-where, and it is an arbitrary
    // string. Serving it verbatim let any track in the library decide the
    // Content-Type of a response on this origin — `text/html` or
    // `image/svg+xml` being the interesting choices. Whitelist it the same way
    // the sidecar reader already does.
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

// Streams a local file for the preview player. The path is read back out of the
// index by id and never accepted from the client, then re-validated through
// realpath so a symlink planted inside MUSIC_DIR can't be used to read
// arbitrary files.
//
// res.sendFile, not createReadStream().pipe(res): pipe() does not forward the
// source's errors, and an unhandled 'error' on a ReadStream is an uncaught
// exception that takes the whole process down. A file that vanishes between the
// containment check and the open — or a read error part-way through, which is
// routine on the network mounts music libraries live on — must be a failed
// request, not an outage. sendFile also brings Range (206/416), ETag and
// Last-Modified, which the hand-rolled version had to reimplement.
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
      // The client hung up (seeked, skipped, closed the tab) — normal, and the
      // response is already gone, so there is nothing to report.
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

// Streaming counterpart to /missing?verify=1: emits one `result` per missing
// track as its ~1/sec YouTube lookup lands. Same shape as
// /api/verify/album/:mbid/stream so the client reuses one panel, but scoped to
// the tracks you don't already own instead of the whole tracklist. GET for
// EventSource; no `album` event because the caller already knows the count from
// the unverified pass it just rendered.
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

// Every track of every album this artist has that you don't, looked up on
// YouTube in one run. The album-scoped stream above does one record; this walks
// the whole discography gap, which is minutes of 1-req/s lookups — hence the
// same streaming shape, and hence verified_links, so a restart doesn't discard
// the run so far.
libraryRouter.get('/artist-missing/stream', sameOriginOnly, sseStream(async ({ req, send, signal }) => {
  const artist = str(req.query.artist);
  if (!artist) {
    send('error', { code: 'BAD_REQUEST', message: 'an artist is required' });
    return STREAM_HANDLED;
  }
  // The summary becomes the `done` payload — this stream has totals to report,
  // where the album-scoped one above just signals completion.
  return sweepArtistMissing(artist, {
    signal,
    onEvent: (event, data) => send(event, data),
  });
}));

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
    const { limit, offset } = paging(req, 50);
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

// Names the track at one (disc, position) of an album, so a gap row in the local
// tracklist can be looked up. Resolve only — the YouTube half is POST /api/verify,
// which the client already drives from VerifyButton.
//
// Two endpoints rather than one on purpose: the two halves sit behind separate
// 1-req/s limiters, so combining them would make one request wait on both and
// fail for two unrelated reasons. Cheap to call per row because mbFetch caches on
// the request URL for an hour — the second and third gap row of the same album
// cost no upstream call at all.
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

// Tag repair for a file already in the library. MusicBrainz-backed, so opt-in
// per track like the panels above.
libraryRouter.get('/fix-candidates/:trackId', async (req, res, next) => {
  try {
    res.json(await getFixCandidates(Number(req.params.trackId)));
  } catch (err) {
    next(err);
  }
});

// The same repair, identified by the file's audio instead of its metadata.
// Separate from the route above rather than a flag on it, because this one
// spawns fpcalc and spends an AcoustID call — the client asks for it by button,
// not on every panel it opens.
libraryRouter.get('/fingerprint-candidates/:trackId', async (req, res, next) => {
  try {
    res.json(await getFingerprintCandidates(Number(req.params.trackId)));
  } catch (err) {
    next(err);
  }
});

// Writes tags to a file in place. Never moves or renames it, and by default only
// fills fields that are currently empty. `overwrite` opts into replacing tags
// that disagree with the chosen recording, and `replaceCoverArt` does the same
// for the embedded picture — separately, since they're separate decisions.
// See libraryFix.js.
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

// Tag values a person typed, which makes these the two endpoints where the
// browser does dictate what gets written — the deliberate exception to the rule
// stated above /bulk-fix/apply below. services/tagEdit.validateTagEdit is the
// whole of the control, and it lives inside the service rather than here so a
// future caller can't arrive and skip it.
//
// PATCH because this is a partial update: a field absent from `fields` is left
// alone. A blank field is also left alone — editing cannot remove a tag.
libraryRouter.patch('/track/:id/tags', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await editTrackTags({ trackId, fields: req.body?.fields }));
  } catch (err) {
    next(err);
  }
});

// The same, applied across one album: `fields` on every chosen track, `perTrack`
// for the fields that are per-row. Capped here as well as in the service, so the
// ceiling is visible alongside the other request caps in this file.
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

// The preview an apply will reuse.
//
// Apply used to recompute the preview from scratch: every file's tags read a
// second time, and for the musicbrainz source two more trips through the
// 1-req/s upstream queue to re-resolve an album the user was looking at a moment
// ago. Handing the apply the preview it is applying is both cheaper and more
// honest — what gets written is what was on screen and approved, rather than a
// fresh derivation that upstream may have changed under.
//
// Short TTL and a small ceiling: this is a hand-off between two clicks, not a
// cache. A miss just means the old behaviour of recomputing.
const previewCache = new TTLCache({ maxEntries: 32 });
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function previewKey({ artist, album, source }) {
  return JSON.stringify([artist, album, source]);
}

// What repairing a whole album's tags would write. Read-only: the 'path' source
// makes no upstream call at all, and 'musicbrainz' makes two for the album
// rather than three per track.
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

// Applies a previewed repair to the chosen tracks. The tag values are not taken
// from THIS request — only which tracks to repair — so the server re-derives what
// to write and a caller can't use this endpoint to set arbitrary tags.
//
// That is a property of the repair endpoints, not of the API as a whole: the two
// manual-edit endpoints above do take their values from the request, because
// typing a value is the entire point of them. Their control is
// services/tagEdit.validateTagEdit rather than server-side derivation.
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
    res.json(await applyBulkFix({
      ...args,
      trackIds: trackIds.map(Number).filter(Number.isInteger),
      preview: previewCache.get(previewKey(args)) ?? null,
    }));
  } catch (err) {
    next(err);
  }
});

// Rescans one artist's or album's folders instead of all of MUSIC_DIR, so a
// just-fixed album refreshes without waiting on a full pass.
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

// --- Discovery ---------------------------------------------------------------
//
// The inverse of the gap flows above: music you don't have, reached from music
// you do. All three are opt-in from a button — the first two walk the 1-req/s
// MusicBrainz queue and must never run on page load.

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

// POST rather than GET because a pasted playlist is a body, not a query string —
// it can be hundreds of lines and contains anything.
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

// Records the user's choice when artist resolution was ambiguous, so the
// discography diff can proceed and the answer is remembered.
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

// Forgets a remembered artist resolution, so a wrong match can be corrected from
// the UI instead of by editing the database.
libraryRouter.delete('/artist-link', (req, res, next) => {
  try {
    const artist = str(req.body?.artist) ?? str(req.query.artist);
    if (!artist) throw new BadRequestError('artist is required');
    res.json({ ok: true, cleared: deleteArtistLink(getDb(), artist) });
  } catch (err) {
    next(err);
  }
});
