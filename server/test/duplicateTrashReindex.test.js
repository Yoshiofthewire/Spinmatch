// A reindex that throws after a successful move must not leave the moved file's row live.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
const musicDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-trash-reindex-'));
process.env.MUSIC_DIR = musicDir;

mock.module('../src/services/libraryScanner.js', {
  namedExports: { reindexFile: async () => { throw new Error('taglib exploded'); } },
});

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const { trashDuplicate } = await import('../src/services/duplicateTrash.js');

test.after(async () => {
  setDbForTest(null);
  await fs.rm(musicDir, { recursive: true, force: true });
});

test('a failed reindex after the move still marks the row removed and reports success', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  for (const [i, name] of ['a.flac', 'b.mp3'].entries()) {
    const full = path.join(musicDir, 'A', 'Al', name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `bytes-${i}`);
    repo.upsertLocalTrack(db, {
      path: full, artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: `${i}:1`,
    });
  }
  repo.recomputeStats(db);
  const first = db.prepare('SELECT id, path FROM local_tracks ORDER BY path').get();

  const result = await trashDuplicate({ trackId: first.id, db });

  assert.ok(fsSync.existsSync(result.trashedPath), 'the move happened');
  assert.equal(repo.getTrackById(db, first.id), null, 'the row left the live index');
  assert.ok(repo.getRemovedTrackById(db, first.id));
  assert.equal(repo.getStats(db).totalTracks, 1, 'stats were recomputed');
});
