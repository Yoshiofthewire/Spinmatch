import { Router } from 'express';
import { verifyTrack } from '../services/verifyTrack.js';
import { verifyRecording } from '../services/verifiedLinks.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { BadRequestError } from '../lib/httpErrors.js';
import { assertMbid, requireMbidParam } from '../lib/mbid.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';
import { MAX_TAG_TEXT } from '../lib/tagLimits.js';

export const verifyRouter = Router();

// Nothing on this route is a tag, but the values are the same kind of thing —
// an artist and a title someone is asking about — so they get the same ceiling
// rather than a second number meaning the same thing.
//
// A truthiness check was the whole of the validation here, and truthiness says
// nothing about type or size: an array, an object, or a megabyte of pasted text
// all passed and went on to become a yt-dlp search argument (a single argv
// element, never a shell string — see ytdlp.js — so the risk was the size of the
// argument and the junk in the cache key, not injection).
function requireText(value, field) {
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestError(`${field} is required`);
  if (trimmed.length > MAX_TAG_TEXT) {
    throw new BadRequestError(`${field} must be ${MAX_TAG_TEXT} characters or fewer`);
  }
  return trimmed;
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireText(value, field);
}

// Long enough for a Grateful Dead show, short enough that it is still a track.
const MAX_LENGTH_MS = 24 * 60 * 60 * 1000;

// lengthMs is arithmetic, not text: durationMatch subtracts it from every
// candidate's duration to rank them. NaN (from a string, an object, a boolean)
// makes every comparison false, so the ranking silently returns nothing rather
// than failing; Infinity and negatives are worse in the same quiet way. Rounded
// because it also forms part of the result cache key, where 3000 and 3000.4
// would otherwise be two entries for one track.
function requireLengthMs(value) {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LENGTH_MS) {
    throw new BadRequestError(`lengthMs must be a duration in milliseconds between 1 and ${MAX_LENGTH_MS}`);
  }
  return Math.round(n);
}

// `recordingMbid` is optional, and what it buys is persistence. Without it the
// answer is cached in memory for an hour and lost on restart; with it the lookup
// goes through verifiedLinks, which remembers hits for 30 days and misses for 7 in
// the database — the same memory the multi-minute artist sweep relies on. Callers
// that know which MusicBrainz recording they are asking about (the gap rows) pass
// it; a free-text search result has no recording to key on and doesn't.
verifyRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const artist = requireText(body.artist, 'artist');
    const title = requireText(body.title, 'title');
    const album = optionalText(body.album, 'album');
    const lengthMs = requireLengthMs(body.lengthMs);
    const { recordingMbid } = body;

    const result = recordingMbid
      ? await verifyRecording({
        recordingMbid: assertMbid(String(recordingMbid), 'recordingMbid'),
        artist,
        title,
        album,
        lengthMs,
      })
      : await verifyTrack({ artist, title, album, lengthMs });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Album verify, streamed: one `result` event per track as its (rate-limited,
// ~1/sec) YouTube lookup finishes. GET so the browser's EventSource can consume
// it, sameOriginOnly because GET requests skip the app-wide CSRF guard and this
// one spawns a subprocess per track.
//
// There used to be a non-streaming POST /album/:mbid beside this doing the same
// loop in one request. It is gone. The comment on this route already explained
// why that shape is wrong — a large album holds the request open for minutes and
// reverse proxies time it out — and keeping the version known to be broken as a
// "fallback for environments without EventSource" was fiction: EventSource has
// been in every browser for a decade, and one that lacked it would not run the
// React client either. What it actually provided was an authenticated way to pin
// a request open for the length of a box set.
verifyRouter.get('/album/:mbid/stream', sameOriginOnly, requireMbidParam(), sseStream(
  async ({ req, send, signal }) => {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) {
      send('error', { code: 'NOT_FOUND', message: 'No release found for this release group' });
      return STREAM_HANDLED;
    }
    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    send('album', { mbid: req.params.mbid, title: release.title, artist: release.artist, total: tracks.length });

    for (const track of tracks) {
      if (signal.aborted) return STREAM_HANDLED;
      if (track.lengthMs == null) {
        send('result', { position: track.position, title: track.title, status: 'no_results', video: null, deltaSeconds: null });
        continue;
      }
      // A rate limit ends the run — the next track hits the same wall — but it
      // is a terminal event of its own, not an error, so the wrapper is told the
      // stream is finished rather than left to append a `done`.
      const verified = await verifyTrack({
        artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs,
      });
      send('result', { position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
    }
    return undefined;
  }
));
