import { Router } from 'express';
import { verifyTrack } from '../services/verifyTrack.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { BadRequestError } from '../lib/httpErrors.js';
import { requireMbidParam } from '../lib/mbid.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';

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
