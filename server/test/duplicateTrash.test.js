// Moving a duplicate aside. Three contracts matter here, and each of them is a
// way this feature could lose someone's music rather than merely misbehave:
// the file must end up somewhere findable, the last live copy of a track must
// never be movable, and a failed move must leave the index exactly as it was —
// a row marked removed while its file is still in the library is a track that
// has silently vanished from the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-trash-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const configModule = await import('../src/config.js');

// The scanner re-reads tags on the restore path; no real audio file is involved
// in these tests, so readTags is mocked the way libraryFix.test.js does it.
const { mock } = await import('node:test');
mock.module('../src/services/tags.js', {
  namedExports: {
    readTags: async () => ({ artist: 'A', album: 'Al', title: 'One', durationMs: 1000 }),
    readCoverArt: async () => null,
    writeTags: async () => ({ filledFields: [] }),
  },
});

const { trashDuplicate, trashPathFor, TRASH_DIR_NAME } = await import('../src/services/duplicateTrash.js');

// Two copies of one track, both as real (empty) files, both indexed. Returns
// their ids in path order.
async function seedTwoCopies(db, { names = ['a.flac', 'b.mp3'] } = {}) {
  const ids = [];
  for (const [i, name] of names.entries()) {
    const full = path.join(musicDir, 'A', 'Al', name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `bytes-${i}`);
    repo.upsertLocalTrack(db, {
      path: full, artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: `${i}:1`,
    });
  }
  for (const row of db.prepare('SELECT id, path FROM local_tracks ORDER BY path').all()) ids.push(row);
  return ids;
}

function freshDb() {
  const db = openDb(':memory:');
  setDbForTest(db);
  return db;
}

test.beforeEach(async () => {
  configModule.config.ingest.musicDir = musicDir;
  await fs.rm(path.join(musicDir, 'A'), { recursive: true, force: true });
  await fs.rm(path.join(musicDir, TRASH_DIR_NAME), { recursive: true, force: true });
});

test.after(async () => {
  setDbForTest(null);
  await fs.rm(musicDir, { recursive: true, force: true });
});

test('trashPathFor mirrors the library layout under the trash folder', () => {
  configModule.config.ingest.musicDir = musicDir;
  assert.equal(
    trashPathFor(path.join(musicDir, 'Nick Cave', 'Tender Prey', '01 - The Mercy Seat.flac')),
    path.join(musicDir, TRASH_DIR_NAME, 'Nick Cave', 'Tender Prey', '01 - The Mercy Seat.flac'),
  );
});

test('moves the file to its mirrored path and marks the row removed', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);

  const result = await trashDuplicate({ trackId: first.id, db });

  assert.equal(result.trashedPath, path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac'));
  assert.equal(result.remainingCopies, 1);
  assert.ok(fsSync.existsSync(result.trashedPath), 'the file is in the trash');
  assert.ok(!fsSync.existsSync(first.path), 'and no longer in the library');
  assert.equal(repo.getTrackById(db, first.id), null, 'the row has left the live index');
  assert.equal(repo.getRemovedTrackById(db, first.id).path, first.path);
});

// The requirement, stated directly. This is the whole reason the guard is on the
// server: a page left open since yesterday is exactly the case where the
// browser's count of copies is the thing that is wrong.
test('refuses the last live copy and leaves the file where it is', async () => {
  const db = freshDb();
  const [first, second] = await seedTwoCopies(db);
  await trashDuplicate({ trackId: first.id, db });

  await assert.rejects(
    trashDuplicate({ trackId: second.id, db }),
    (err) => err.status === 409,
  );
  assert.ok(fsSync.existsSync(second.path), 'the only remaining copy is untouched');
});

test('refuses a track whose path is outside MUSIC_DIR', async () => {
  const db = freshDb();
  await seedTwoCopies(db);
  const outside = path.join(os.tmpdir(), 'spinmatch-outside.flac');
  await fs.writeFile(outside, 'bytes');
  repo.upsertLocalTrack(db, {
    path: outside, artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '9:1',
  });
  const { id } = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(outside);

  await assert.rejects(trashDuplicate({ trackId: id, db }), (err) => err.status === 400);
  assert.ok(fsSync.existsSync(outside), 'the file outside the library is untouched');
  await fs.rm(outside, { force: true });
});

test('refuses an unknown track id', async () => {
  const db = freshDb();
  await assert.rejects(trashDuplicate({ trackId: 4242, db }), (err) => err.status === 404);
});

// The requirement above, under concurrency. Awaited sequentially, the count
// check is safe by construction — there's nothing racing it. Fired together,
// nothing stops both calls from reading "2 live copies" before either has
// written anything, unless the check+move+reindex sequence is serialized per
// dup_key rather than per file. Without that serialization this test moves
// both copies and leaves zero live rows for the track — the very outcome the
// last-copy guard exists to prevent.
test('two concurrent requests for the two copies of one track: exactly one succeeds', async () => {
  const db = freshDb();
  const [first, second] = await seedTwoCopies(db);

  const [a, b] = await Promise.allSettled([
    trashDuplicate({ trackId: first.id, db }),
    trashDuplicate({ trackId: second.id, db }),
  ]);

  const outcomes = [a, b];
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one of the two racing requests moves a file');
  assert.equal(rejected.length, 1, 'the other is refused, not silently a no-op');
  assert.equal(rejected[0].reason.status, 409, 'refused as a conflict, not some other failure');

  const live = db.prepare('SELECT COUNT(*) c FROM local_tracks WHERE removed = 0 AND dup_key IS NOT NULL').get().c;
  assert.equal(live, 1, 'one live copy remains — the track has not silently lost all of its copies');
});

test('a name already taken in the trash is suffixed, never overwritten', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const taken = path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac');
  await fs.mkdir(path.dirname(taken), { recursive: true });
  await fs.writeFile(taken, 'an older trashed file');

  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });

  assert.equal(trashedPath, path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a (2).flac'));
  assert.equal(await fs.readFile(taken, 'utf8'), 'an older trashed file', 'the older one survived');
});

// A row marked removed while its file is still sitting in the library is a
// track that has silently disappeared from the app, so the index must not be
// touched until the move has actually succeeded.
test('a failed move leaves the index untouched', async (t) => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);

  t.mock.method(fs, 'rename', async () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  });

  await assert.rejects(trashDuplicate({ trackId: first.id, db }));
  assert.ok(repo.getTrackById(db, first.id), 'the row is still live');
  assert.equal(repo.getRemovedTrackById(db, first.id), null);
});

// The dot prefix is the only thing keeping the trash out of the index, so this
// is a dependency of the feature rather than a happy accident.
test('the trash folder is invisible to a library scan', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  await trashDuplicate({ trackId: first.id, db });

  const { runScanOnce } = await import('../src/services/libraryScanner.js');
  await runScanOnce();

  const paths = db.prepare('SELECT path FROM local_tracks WHERE removed = 0').all().map((r) => r.path);
  assert.ok(
    !paths.some((p) => p.includes(TRASH_DIR_NAME)),
    `a trashed file was indexed: ${paths.join(', ')}`,
  );
});
