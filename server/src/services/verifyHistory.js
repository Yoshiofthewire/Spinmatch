import { getDb, withTransaction } from '../lib/db.js';
import { BadRequestError } from '../lib/httpErrors.js';
import { MAX_TAG_TEXT } from '../lib/tagLimits.js';

export const MAX_HISTORY = 5000;
// The old localStorage cap, so one legacy import fits in one call.
export const MAX_IMPORT = 200;
const ACTIONS = new Set(['verified', 'ingested']);

// undefined = present but invalid; null = absent.
function text(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_TAG_TEXT) return undefined;
  return value.trim() || null;
}

function insert(db, e) {
  db.prepare(`
    INSERT INTO verify_history
      (recording_mbid, artist, title, album, action, status, video_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.recordingMbid ?? null, e.artist ?? null, e.title, e.album ?? null, e.action,
    e.status ?? null, e.videoId ?? null, e.createdAt);
}

function prune(db) {
  db.prepare(`
    DELETE FROM verify_history WHERE id IN (
      SELECT id FROM verify_history ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
    )
  `).run(MAX_HISTORY);
}

// A log of work already done: a failed write must not fail the verify or move itself.
export function recordHistory({ recordingMbid, artist, title, album, action, status, videoId }) {
  try {
    const db = getDb();
    withTransaction(db, () => {
      insert(db, {
        recordingMbid, artist, title, album, action, status, videoId, createdAt: Date.now(),
      });
      prune(db);
    });
  } catch (err) {
    console.warn(`Could not record ${action} history: ${err.message}`);
  }
}

export function listHistory({ limit, offset }) {
  const db = getDb();
  const entries = db.prepare(`
    SELECT id, recording_mbid AS recordingMbid, artist, title, album, action, status,
           video_id AS videoId, created_at AS createdAt
    FROM verify_history ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM verify_history').get();
  return { entries, total };
}

export function clearHistory() {
  return Number(getDb().prepare('DELETE FROM verify_history').run().changes);
}

// Legacy localStorage entries: {track, artist, album, action, timestamp}. Invalid ones
// are skipped; repeats (a second tab, a retry) are skipped by (action, title, artist, time).
export function importHistory(entries) {
  if (!Array.isArray(entries)) throw new BadRequestError('entries must be an array');
  if (entries.length > MAX_IMPORT) throw new BadRequestError(`At most ${MAX_IMPORT} entries per import`);

  const db = getDb();
  const now = Date.now();
  const exists = db.prepare(`
    SELECT 1 FROM verify_history
    WHERE action = ? AND title = ? AND artist IS ? AND created_at = ?
  `);
  let imported = 0;
  withTransaction(db, () => {
    for (const raw of entries) {
      const title = text(raw?.track);
      const artist = text(raw?.artist);
      const album = text(raw?.album);
      const ts = raw?.timestamp;
      if (!title || artist === undefined || album === undefined || !ACTIONS.has(raw.action)
        || !Number.isSafeInteger(ts) || ts <= 0) continue;
      const createdAt = Math.min(ts, now);
      if (exists.get(raw.action, title, artist, createdAt)) continue;
      insert(db, { artist, title, album, action: raw.action, createdAt });
      imported += 1;
    }
    prune(db);
  });
  return { imported, skipped: entries.length - imported };
}
