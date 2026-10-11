import fs from 'node:fs/promises';
import { getDb, withTransaction } from '../lib/db.js';
import { readTags, writeTags } from './tags.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { yieldToEventLoop, describeFailure } from '../lib/writeLoop.js';
import { NotFoundError, ConflictError } from '../lib/httpErrors.js';

// Undo journal for library tag writes. Ingest is not journaled; undo is not either (no redo).

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const KEEP_BATCHES = 500;

function prune(db, now) {
  db.prepare('DELETE FROM tag_batches WHERE created_at < ?').run(now - KEEP_MS);
  db.prepare(
    'DELETE FROM tag_batches WHERE id NOT IN (SELECT id FROM tag_batches ORDER BY id DESC LIMIT ?)'
  ).run(KEEP_BATCHES);
}

// The journaled fields as they read on disk now; coverArt as presence.
function snapshot(tags, fields) {
  return Object.fromEntries(fields.map((f) => [f, f === 'coverArt' ? tags.hasCoverArt : tags[f]]));
}

// One per user action. The batch row is created on the first write, so a no-op leaves none.
// record() takes writeTags' result and must run inside the file's lock.
export function openJournal(db, kind, label) {
  let batchId = null;
  return {
    get batchId() { return batchId; },
    async record({ trackId, real }, { filledFields, before }) {
      if (!filledFields.length) return;
      // Read back from disk, so undo compares like with like.
      const after = snapshot(await readTags(real), filledFields);
      const afterMtimeMs = Math.trunc((await fs.stat(real)).mtimeMs);
      const { coverArt, ...fields } = before;
      // Assigned after commit, so a rolled-back first insert can't leave a dangling id.
      batchId = withTransaction(db, () => {
        let id = batchId;
        if (id == null) {
          const now = Date.now();
          id = Number(db.prepare(
            'INSERT INTO tag_batches (kind, label, created_at) VALUES (?, ?, ?)'
          ).run(kind, label, now).lastInsertRowid);
          prune(db, now);
        }
        db.prepare(`
          INSERT INTO tag_writes
            (batch_id, track_id, path, before, after, cover_before, cover_before_mime, after_mtime_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, trackId ?? null, real,
          JSON.stringify('coverArt' in before ? { ...fields, coverArt: coverArt != null } : fields),
          JSON.stringify(after),
          coverArt?.bytes ?? null, coverArt?.mimeType ?? null, afterMtimeMs,
        );
        return id;
      });
    },
  };
}

export function listChanges(db = getDb(), { limit = 50, offset = 0 } = {}) {
  const changes = db.prepare(`
    SELECT b.id, b.kind, b.label, b.created_at AS createdAt, b.undone_at AS undoneAt,
      (SELECT COUNT(*) FROM tag_writes w WHERE w.batch_id = b.id) AS files
    FROM tag_batches b ORDER BY b.id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM tag_batches').get();
  return { changes, total };
}

// Restores one file unless anything touched it since our write; returns a conflict reason or null.
async function undoWrite(w) {
  let real;
  try {
    real = await assertReadableInsideMusicDir(w.path);
  } catch {
    return 'The file is no longer there.';
  }
  return withFileLock(real, async () => {
    const before = JSON.parse(w.before);
    const after = JSON.parse(w.after);
    const { mtimeMs } = await fs.stat(real);
    const current = snapshot(await readTags(real), Object.keys(after));
    if (Math.trunc(mtimeMs) !== w.after_mtime_ms
      || Object.keys(after).some((f) => current[f] !== after[f])) {
      return 'The file changed after this edit, so it was left alone.';
    }
    const { coverArt, ...fields } = before;
    // '' clears: the field was empty before the edit.
    const desired = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, v ?? '']));
    const cover = w.cover_before ? { bytes: Buffer.from(w.cover_before), mimeType: w.cover_before_mime } : null;
    await writeTags(real, desired, {
      overwrite: true,
      coverImage: cover,
      replaceCoverArt: Boolean(cover),
      removeCoverArt: coverArt === false,
    });
    await reindexFile(real);
    return null;
  });
}

export async function undoBatch(batchId, { db = getDb() } = {}) {
  const batch = db.prepare('SELECT id, undone_at FROM tag_batches WHERE id = ?').get(batchId);
  if (!batch) throw new NotFoundError('That change is no longer in the history');
  // Claim before writing, so two clicks can't both run it.
  const claimed = db.prepare(
    'UPDATE tag_batches SET undone_at = ? WHERE id = ? AND undone_at IS NULL'
  ).run(Date.now(), batchId).changes;
  if (!claimed) throw new ConflictError('This change has already been undone');

  const writes = db.prepare('SELECT * FROM tag_writes WHERE batch_id = ? ORDER BY id DESC').all(batchId);
  let undone = 0;
  const conflicts = [];
  const failed = [];
  for (const w of writes) {
    await yieldToEventLoop();
    try {
      const reason = await undoWrite(w);
      if (reason) conflicts.push({ path: w.path, reason });
      else undone += 1;
    } catch (err) {
      console.warn(`tagJournal: undo of ${w.path} failed: ${err?.message}`);
      failed.push({ path: w.path, ...describeFailure(err) });
    }
  }
  return { undone, conflicts, failed };
}
