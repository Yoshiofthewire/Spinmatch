import { getDb } from '../lib/db.js';
import { verifyTrack } from './verifyTrack.js';

// Persistent memory of "which YouTube video is this MusicBrainz recording".
//
// verifyTrack already caches in memory, but that cache is 2000 entries with a
// one-hour TTL and dies with the process. Sweeping an artist's missing
// discography is one rate-limited yt-dlp call per track at roughly 1/sec, so a
// prolific artist is a run of many minutes — restarting the server halfway
// through, or coming back the next day, would otherwise redo all of it.
//
// Keyed on the recording rather than on an artist/title/album string because
// that's the identity the gap flow actually has: detectAlbumGaps produces
// MusicBrainz tracks, and the same recording reached via a different release
// shouldn't be looked up twice.

// How long a remembered answer stands before it's checked again. Long, because
// the answer rarely changes and the cost of being wrong is one stale link the
// user can re-verify; short enough that a video taken down doesn't haunt the
// collection forever.
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Negatives expire sooner: "YouTube doesn't have this" is much more likely to
// stop being true than "this is the video" is.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getVerifiedLink(db, recordingMbid) {
  if (!recordingMbid) return null;
  const row = db.prepare(`
    SELECT video_id AS videoId, video_title AS videoTitle,
           video_duration_ms AS videoDurationMs, checked_at AS checkedAt
    FROM verified_links WHERE recording_mbid = ?
  `).get(recordingMbid);
  if (!row) return null;

  const ttl = row.videoId ? FOUND_TTL_MS : MISS_TTL_MS;
  if (Date.now() - row.checkedAt > ttl) return null;
  return row;
}

export function saveVerifiedLink(db, { recordingMbid, artist, title, video }) {
  if (!recordingMbid) return;
  db.prepare(`
    INSERT INTO verified_links
      (recording_mbid, video_id, video_title, video_duration_ms, artist, title, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recording_mbid) DO UPDATE SET
      video_id = excluded.video_id,
      video_title = excluded.video_title,
      video_duration_ms = excluded.video_duration_ms,
      artist = excluded.artist,
      title = excluded.title,
      checked_at = excluded.checked_at
  `).run(
    recordingMbid,
    video?.id ?? null,
    video?.title ?? null,
    video?.durationMs ?? null,
    artist ?? null,
    title ?? null,
    Date.now(),
  );
}

// Rebuilds a verifyTrack-shaped result from a remembered row, so a cached answer
// and a fresh one are indistinguishable to every caller.
export function resultFromLink(row) {
  if (!row.videoId) return { status: 'no_results', video: null, deltaSeconds: null, cached: true };
  return {
    status: 'confirmed',
    video: {
      id: row.videoId,
      title: row.videoTitle,
      durationMs: row.videoDurationMs,
      url: `https://www.youtube.com/watch?v=${row.videoId}`,
    },
    deltaSeconds: null,
    cached: true,
  };
}

// Convenience wrappers for callers that don't hold a db handle.
export function lookup(recordingMbid) {
  return getVerifiedLink(getDb(), recordingMbid);
}

export function remember(entry) {
  return saveVerifiedLink(getDb(), entry);
}

/**
 * verifyTrack, but remembered across restarts when the caller knows which
 * MusicBrainz recording it is asking about.
 *
 * Only settled answers are stored. 'unverified' means a video was found whose
 * duration disagrees with MusicBrainz — a weak guess worth re-making later,
 * not a fact worth keeping for a month.
 */
export async function verifyRecording({ recordingMbid, artist, title, album, lengthMs }) {
  const remembered = lookup(recordingMbid);
  if (remembered) return { ...resultFromLink(remembered), candidatesConsidered: null };

  const result = await verifyTrack({ artist, title, album, lengthMs });
  if (recordingMbid && (result.status === 'confirmed' || result.status === 'no_results')) {
    remember({ recordingMbid, artist, title, video: result.video });
  }
  return result;
}
