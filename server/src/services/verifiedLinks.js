import { getDb } from '../lib/db.js';
import { verifyTrack } from './verifyTrack.js';

// Persistent recording MBID -> YouTube video map, so slow rate-limited sweeps
// survive restarts. Keyed on recording so other releases reuse the answer.
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Negatives go stale faster.
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

// Same shape as a fresh verifyTrack result.
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

export function lookup(recordingMbid) {
  return getVerifiedLink(getDb(), recordingMbid);
}

export function remember(entry) {
  return saveVerifiedLink(getDb(), entry);
}

// Persisted verifyTrack. 'unverified' (duration mismatch) is a weak guess, not stored.
export async function verifyRecording({ recordingMbid, artist, title, album, lengthMs }) {
  const remembered = lookup(recordingMbid);
  if (remembered) return { ...resultFromLink(remembered), candidatesConsidered: null };

  const result = await verifyTrack({ artist, title, album, lengthMs });
  if (recordingMbid && (result.status === 'confirmed' || result.status === 'no_results')) {
    remember({ recordingMbid, artist, title, video: result.video });
  }
  return result;
}
