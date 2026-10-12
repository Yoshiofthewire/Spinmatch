import { Router } from 'express';
import { verifyRecording } from '../services/verifiedLinks.js';
import { recordHistory } from '../services/verifyHistory.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { BadRequestError } from '../lib/httpErrors.js';
import { assertMbid, requireMbidParam } from '../lib/mbid.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';
import { MAX_TAG_TEXT } from '../lib/tagLimits.js';

export const verifyRouter = Router();

// Type- and size-checked: values become a yt-dlp search argv element and a cache key.
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

// NaN/Infinity/negatives silently break duration ranking. Rounded: it's part of the cache key.
function requireLengthMs(value) {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LENGTH_MS) {
    throw new BadRequestError(`lengthMs must be a duration in milliseconds between 1 and ${MAX_LENGTH_MS}`);
  }
  return Math.round(n);
}

// With recordingMbid the result persists in the DB (verifiedLinks); without, 1h in memory.
verifyRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const artist = requireText(body.artist, 'artist');
    const title = requireText(body.title, 'title');
    const album = optionalText(body.album, 'album');
    const lengthMs = requireLengthMs(body.lengthMs);
    const recordingMbid = body.recordingMbid ? assertMbid(String(body.recordingMbid), 'recordingMbid') : null;

    const result = await verifyRecording({ recordingMbid, artist, title, album, lengthMs });
    recordHistory({
      recordingMbid, artist, title, album, action: 'verified', status: result.status, videoId: result.video?.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Album verify over SSE, one `result` per track. GET for EventSource; sameOriginOnly
// because GET skips the CSRF guard and this spawns a subprocess per track.
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
        // No length to compare against, so no lookup; still a result worth keeping.
        recordHistory({
          recordingMbid: track.recordingMbid, artist: release.artist, title: track.title, album: release.title,
          action: 'verified', status: 'no_results',
        });
        send('result', { position: track.position, title: track.title, status: 'no_results', video: null, deltaSeconds: null });
        continue;
      }
      // A RateLimitedError propagates: sseStream sends `rate_limited`, no `done`, and ends.
      const verified = await verifyRecording({
        recordingMbid: track.recordingMbid,
        artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs,
      });
      recordHistory({
        recordingMbid: track.recordingMbid, artist: release.artist, title: track.title, album: release.title,
        action: 'verified', status: verified.status, videoId: verified.video?.id,
      });
      send('result', { position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
    }
    return undefined;
  }
));
