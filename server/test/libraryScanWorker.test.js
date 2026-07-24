import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'silence.mp3');

// Spawns the REAL worker thread end-to-end (no mocks): a real music dir with a
// real audio file, a real on-disk WAL DB, and the main thread reading the DB
// back through its own connection — proving the off-main-thread scan path works.
test('scanLibrary runs the scan in a worker and the main thread reads the result', async () => {
  const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-worker-music-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-worker-db-'));
  const dbPath = path.join(dbDir, 'library.db');

  await fs.mkdir(path.join(musicDir, 'Artist', 'Album'), { recursive: true });
  await fs.copyFile(FIXTURE, path.join(musicDir, 'Artist', 'Album', '01.mp3'));

  // The worker inherits process.env, so set the paths its config.js will read.
  process.env.MUSIC_DIR = musicDir;
  process.env.LIBRARY_DB = dbPath;

  try {
    const { scanLibrary } = await import('../src/services/libraryScanner.js');
    const summary = await scanLibrary();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.added, 1);

    // Read the DB the worker wrote, from a fresh main-thread connection.
    const { openDb } = await import('../src/lib/db.js');
    const db = openDb(dbPath);
    const { c } = db.prepare('SELECT COUNT(*) c FROM local_tracks WHERE removed = 0').get();
    assert.equal(c, 1);
    db.close();
  } finally {
    delete process.env.MUSIC_DIR;
    delete process.env.LIBRARY_DB;
    await fs.rm(musicDir, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  }
});
