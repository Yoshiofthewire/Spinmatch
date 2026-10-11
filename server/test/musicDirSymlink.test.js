// MUSIC_DIR as a symlink (/music -> /mnt/nas/music). The scanner and the write
// side (tag edit, fix, bulk fix) must agree on one spelling of every path, or a
// reindex after a tag write lands on a second row for the same file.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-symroot-')));
const real = path.join(base, 'real');
const link = path.join(base, 'link');
fs.mkdirSync(path.join(real, 'A', 'Al'), { recursive: true });
fs.writeFileSync(path.join(real, 'A', 'Al', '01.mp3'), 'x');
fs.symlinkSync(real, link);

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = link;

mock.module('../src/services/tags.js', {
  namedExports: { readTags: async () => ({ artist: 'A', album: 'Al', title: 'One' }) },
});

const { config } = await import('../src/config.js');
const { openDb, setDbForTest } = await import('../src/lib/db.js');
const { runScanOnce, reindexFile } = await import('../src/services/libraryScanner.js');
const { assertReadableInsideMusicDir } = await import('../src/lib/paths.js');

test.after(() => {
  setDbForTest(null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('MUSIC_DIR is resolved through its symlink at startup', () => {
  assert.equal(config.ingest.musicDir, real);
});

test('a reindex after a write updates the scanned row instead of adding one', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  await runScanOnce();
  const [row] = db.prepare('SELECT path FROM local_tracks WHERE removed = 0').all();

  // What tagEdit/libraryFix/libraryBulkFix do around writeTags.
  await reindexFile(await assertReadableInsideMusicDir(row.path));

  const live = db.prepare('SELECT path FROM local_tracks WHERE removed = 0').all().map((r) => r.path);
  assert.deepEqual(live, [path.join(real, 'A', 'Al', '01.mp3')]);
});
