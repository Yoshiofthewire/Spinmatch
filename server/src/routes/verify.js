import { Router } from 'express';
import { verifyTrack } from '../services/verifyTrack.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { BadRequestError, RateLimitedError, NotFoundError } from '../lib/httpErrors.js';
import { requireMbidParam } from '../lib/mbid.js';

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

verifyRouter.post('/album/:mbid', requireMbidParam(), async (req, res, next) => {
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
        if (err instanceof RateLimitedError) {
          return res.json({
            album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
            results,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }

    res.json({
      album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
      results,
    });
  } catch (err) {
    next(err);
  }
});

// Streaming variant of the album verify above: emits one `result` event per
// track as its (rate-limited, ~1/sec) YouTube lookup finishes, so the client
// shows incremental progress and no single HTTP request is held open for the
// minutes a large album takes — which reverse proxies would otherwise time out.
// GET so the browser's EventSource can consume it.
verifyRouter.get('/album/:mbid/stream', sameOriginOnly, requireMbidParam(), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) {
      send('error', { code: 'NOT_FOUND', message: 'No release found for this release group' });
      return res.end();
    }
    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    send('album', { mbid: req.params.mbid, title: release.title, artist: release.artist, total: tracks.length });

    for (const track of tracks) {
      if (ac.signal.aborted) return res.end();
      if (track.lengthMs == null) {
        send('result', { position: track.position, title: track.title, status: 'no_results', video: null, deltaSeconds: null });
        continue;
      }
      try {
        const verified = await verifyTrack({
          artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs,
        });
        send('result', { position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
      } catch (err) {
        if (err instanceof RateLimitedError) {
          send('rate_limited', { code: err.code, message: err.message });
          return res.end();
        }
        throw err;
      }
    }
    send('done', {});
  } catch (err) {
    if (!ac.signal.aborted) send('error', { code: err.code || 'INTERNAL', message: err.message });
  } finally {
    res.end();
  }
});
