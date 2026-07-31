import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');

test('openDb creates the collection tables', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes('local_tracks'), 'local_tracks exists');
  assert.ok(names.includes('collection_stats'), 'collection_stats exists');
  assert.ok(!names.includes('verified_tracks'), 'verified_tracks is gone');
  db.close();
});

// Holds a real exclusive lock on `dbPath` from another thread, releases it after
// `holdMs`, and resolves once the lock is actually held. A separate thread is the
// only way to do this: openDb is synchronous, so a lock released from a timer on
// this thread could never fire while openDb was blocked waiting for it.
function holdExclusiveLock(dbPath, holdMs) {
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const { workerData, parentPort } = require('node:worker_threads');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS lock_probe (a INTEGER)');
    db.exec('PRAGMA locking_mode = EXCLUSIVE;');
    db.exec('BEGIN IMMEDIATE');
    db.exec('INSERT INTO lock_probe VALUES (1)');
    db.exec('COMMIT');
    parentPort.postMessage('locked');
    setTimeout(() => db.close(), workerData.holdMs);
  `;
  const worker = new Worker(source, { eval: true, workerData: { dbPath, holdMs } });
  return new Promise((resolve, reject) => {
    worker.once('message', () => resolve(worker));
    worker.once('error', reject);
  });
}

// The scan runs in a worker thread with its own connection to the same file, and
// that connection checkpoints the WAL as the thread tears down — briefly taking
// an exclusive lock that any connection opening at that moment collides with.
// openDb allows 5s for exactly this, but only if busy_timeout is in force before
// the first statement that touches the file; otherwise the collision is an
// instant "database is locked" and a scan is enough to break an unrelated read.
test('openDb waits out a lock another connection is holding', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-db-lock-'));
  const dbPath = path.join(dir, 'library.db');
  const holder = await holdExclusiveLock(dbPath, 250);
  try {
    const db = openDb(dbPath);
    db.close();
  } finally {
    await holder.terminate();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openDb enforces the single-row constraint on collection_stats', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (1, 0)').run();
  assert.throws(
    () => db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (2, 0)').run(),
    /CHECK/i
  );
  db.close();
});
