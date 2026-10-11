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
// The real exports too, so the route test can load the whole app.
const realTags = await import('../src/services/tags.js');
mock.module('../src/services/tags.js', {
  namedExports: {
    ...realTags,
    readTags: async () => ({ artist: 'A', album: 'Al', title: 'One', durationMs: 1000 }),
    readCoverArt: async () => null,
    writeTags: async () => ({ filledFields: [] }),
  },
});

const {
  trashDuplicate, restoreDuplicate, trashPathFor, TRASH_DIR_NAME, listTrash, restoreFromTrash,
} = await import('../src/services/duplicateTrash.js');

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

// A single ".." is exactly what a symlinked MUSIC_DIR produces whenever it
// shares a parent with its target (/data/music -> /data/music-real) or the
// root is one path component (/music -> /mnt/music) — both ordinary
// self-hosted setups. path.join would otherwise normalize that ".." straight
// back inside the root: path.join('/data/music', '.spinmatch-trash',
// '../music-real/A/x.flac') === '/data/music/music-real/A/x.flac', which
// passes assertInsideMusicDir and lands the file inside the library with no
// dot prefix instead of in the trash. trashPathFor has to refuse before the
// join, not rely on the caller's containment check to catch it after.
test('trashPathFor refuses a path that resolves outside the lexical root, rather than folding it back inside', () => {
  configModule.config.ingest.musicDir = musicDir;
  const sibling = path.join(path.dirname(musicDir), 'music-real', 'A', 'x.flac');
  assert.throws(() => trashPathFor(sibling), (err) => err.status === 400);
});

test('moves the file to its mirrored path and marks the row removed', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);

  const result = await trashDuplicate({ trackId: first.id, db });

  assert.equal(result.trashedPath, path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac'));
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

test('refuses when the only other indexed copy is gone from disk', async () => {
  const db = freshDb();
  const [first, second] = await seedTwoCopies(db);
  await fs.unlink(second.path); // deleted outside the app; the index hasn't noticed

  await assert.rejects(
    trashDuplicate({ trackId: first.id, db }),
    (err) => err.status === 409 && /on disk/.test(err.message),
  );
  assert.ok(fsSync.existsSync(first.path), 'the real last copy is untouched');
  assert.ok(repo.getTrackById(db, first.id));
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

// Trash used to suffix onto "a (2).flac" here, but restore recomputes the
// *canonical* mirror path rather than remembering which suffix was claimed —
// so a later Undo would silently move whatever unrelated file was sitting at
// the canonical path into the library, and leave the genuine trashed copy
// unreachable under its suffix forever. Refusing keeps trash and restore
// exact inverses.
test('refuses when the trash already holds a file at the mirrored path', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const taken = path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac');
  await fs.mkdir(path.dirname(taken), { recursive: true });
  await fs.writeFile(taken, 'an older trashed file');

  await assert.rejects(
    trashDuplicate({ trackId: first.id, db }),
    (err) => err.status === 409,
  );
  assert.ok(fsSync.existsSync(first.path), 'the file stays in the library');
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
  assert.ok(fsSync.existsSync(first.path), 'and the file is still in the library');
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

test('undo puts the file back where it was and returns it to the live index', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });

  const result = await restoreDuplicate({ trackId: first.id, db });

  assert.equal(result.restoredPath, first.path);
  assert.ok(fsSync.existsSync(first.path), 'the file is back in the library');
  assert.ok(!fsSync.existsSync(trashedPath), 'and gone from the trash');
  assert.ok(repo.getTrackById(db, first.id), 'the row is live again');
});

// The property the refuse-don't-suffix ruling exists to guarantee: what comes
// back out is what went in, not some other file that happened to be sitting
// at the mirrored path.
test('undo returns the exact bytes that were trashed', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const original = await fs.readFile(first.path, 'utf8');

  await trashDuplicate({ trackId: first.id, db });
  await restoreDuplicate({ trackId: first.id, db });

  assert.equal(await fs.readFile(first.path, 'utf8'), original);
});

test('undo refuses when something else now occupies the original path', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });
  await fs.writeFile(first.path, 'something else entirely');

  await assert.rejects(
    restoreDuplicate({ trackId: first.id, db }),
    (err) => err.status === 409,
  );
  assert.equal(await fs.readFile(first.path, 'utf8'), 'something else entirely', 'untouched');
  assert.ok(fsSync.existsSync(trashedPath), 'the trashed copy is still in the trash');
});

test('undo refuses a track that is not in the trash', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  await assert.rejects(restoreDuplicate({ trackId: first.id, db }), (err) => err.status === 404);
});

test('undo recreates the album directory if it was cleaned up in the meantime', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db, { names: ['only.flac', 'other.mp3'] });
  await trashDuplicate({ trackId: first.id, db });
  // The user tidied up the now-emptier library by hand.
  await fs.rm(path.dirname(first.path), { recursive: true, force: true });

  await restoreDuplicate({ trackId: first.id, db });
  assert.ok(fsSync.existsSync(first.path));
});

test('undo refuses a removed row whose file is not in the trash, and claims nothing', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  // Removed by a scan (deleted outside the app), never trashed.
  await fs.unlink(first.path);
  repo.markRemovedByPath(db, first.path);

  await assert.rejects(restoreDuplicate({ trackId: first.id, db }), (err) => err.status === 404);
  assert.ok(!fsSync.existsSync(first.path), 'no placeholder was left at the original path');
});

// --- The trash as a folder ---------------------------------------------------

const trashFile = (...parts) => path.join(musicDir, TRASH_DIR_NAME, ...parts);

async function putInTrash(rel, bytes = 'x') {
  const full = trashFile(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);
  return full;
}

test('listTrash is empty when there is no trash folder', async () => {
  assert.deepEqual(await listTrash({ limit: 10, offset: 0 }), {
    entries: [], total: 0, totals: { count: 0, bytes: 0 },
  });
});

test('listTrash walks nested folders, skips symlinks, totals bytes and pages', async () => {
  await putInTrash('A/Al/a.flac', '12345');
  await putInTrash('B/Deep/Er/b.mp3', '123');
  const outside = path.join(os.tmpdir(), 'spinmatch-outside-target.flac');
  await fs.writeFile(outside, 'secret');
  await fs.symlink(outside, trashFile('A', 'Al', 'link.flac'));
  await fs.symlink(path.dirname(outside), trashFile('dirlink'));
  // The original of a.flac is back in the library already.
  await fs.mkdir(path.join(musicDir, 'A', 'Al'), { recursive: true });
  await fs.writeFile(path.join(musicDir, 'A', 'Al', 'a.flac'), 'new');

  const all = await listTrash({ limit: 10, offset: 0 });
  assert.deepEqual(all.entries.map((e) => [e.relPath, e.originalPath, e.size, e.restorable]), [
    ['A/Al/a.flac', 'A/Al/a.flac', 5, false],
    ['B/Deep/Er/b.mp3', 'B/Deep/Er/b.mp3', 3, true],
  ]);
  assert.ok(all.entries[0].mtimeMs > 0);
  assert.deepEqual(all.totals, { count: 2, bytes: 8 });

  const second = await listTrash({ limit: 1, offset: 1 });
  assert.deepEqual(second.entries.map((e) => e.relPath), ['B/Deep/Er/b.mp3']);
  assert.equal(second.total, 2);
  await fs.rm(outside, { force: true });
});

test('a symlinked trash folder is not listed', async () => {
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-elsewhere-'));
  await fs.writeFile(path.join(elsewhere, 'x.flac'), 'x');
  await fs.symlink(elsewhere, trashFile());
  assert.equal((await listTrash({ limit: 10, offset: 0 })).total, 0);
  await assert.rejects(restoreFromTrash({ relPath: 'x.flac' }), (err) => err.status === 400);
  assert.ok(fsSync.existsSync(path.join(elsewhere, 'x.flac')));
  await fs.rm(elsewhere, { recursive: true, force: true });
});

test('restoreFromTrash moves the file back and indexes it', async () => {
  const db = freshDb();
  await putInTrash('A/Al/a.flac', 'the bytes');

  const result = await restoreFromTrash({ relPath: 'A/Al/a.flac' });

  const original = path.join(musicDir, 'A', 'Al', 'a.flac');
  assert.equal(result.restoredPath, original);
  assert.equal(await fs.readFile(original, 'utf8'), 'the bytes');
  assert.ok(!fsSync.existsSync(trashFile('A', 'Al', 'a.flac')));
  assert.ok(db.prepare('SELECT 1 FROM local_tracks WHERE path = ? AND removed = 0').get(original));
});

// purgeRemoved drops tombstones after 30 days; the file in the trash outlives them.
test('restoreFromTrash works after the removed row was purged', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  await trashDuplicate({ trackId: first.id, db });
  assert.equal(repo.purgeRemoved(db, { olderThanMs: -1000 }), 1, 'the tombstone is gone');

  await restoreFromTrash({ relPath: 'A/Al/a.flac' });
  const row = db.prepare('SELECT removed FROM local_tracks WHERE path = ?').get(first.path);
  assert.equal(row.removed, 0, 'a fresh live row');
});

test('restoreFromTrash refuses with 409 when the original path is occupied', async () => {
  freshDb();
  const trashed = await putInTrash('A/Al/a.flac', 'trashed');
  const original = path.join(musicDir, 'A', 'Al', 'a.flac');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, 'occupant');

  await assert.rejects(restoreFromTrash({ relPath: 'A/Al/a.flac' }), (err) => err.status === 409);
  assert.equal(await fs.readFile(original, 'utf8'), 'occupant');
  assert.equal(await fs.readFile(trashed, 'utf8'), 'trashed');
});

test('restoreFromTrash rejects traversal, absolute paths, NUL and symlinks with 400', async () => {
  freshDb();
  await putInTrash('A/Al/a.flac');
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-outside-'));
  const outside = path.join(outsideDir, 'x.flac');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, trashFile('A', 'Al', 'out.flac'));
  await fs.symlink(trashFile('A', 'Al', 'a.flac'), trashFile('A', 'Al', 'in.flac'));
  await fs.symlink(outsideDir, trashFile('outdir'));

  for (const relPath of [
    '../A/Al/x.flac', 'A/../../x.flac', outside, '/etc/passwd', 'A/Al/a.flac\0', '', 42,
    'A/Al/out.flac', 'A/Al/in.flac', 'outdir/x.flac', 'A',
  ]) {
    await assert.rejects(
      restoreFromTrash({ relPath }),
      (err) => err.status === 400,
      `accepted ${JSON.stringify(relPath)}`,
    );
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside', 'the outside file is untouched');
  assert.ok(!fsSync.existsSync(path.join(musicDir, 'A', 'Al', 'out.flac')));
  assert.ok(!fsSync.existsSync(path.join(musicDir, 'outdir')));
  await fs.rm(outsideDir, { recursive: true, force: true });
});

test('the trash routes list and restore, and reject traversal with 400', async () => {
  freshDb();
  await putInTrash('A/Al/a.flac');
  const { createApp } = await import('../src/app.js');
  const server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}/api/library`;
  const restore = (relPath) => fetch(`${base}/trash/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ relPath }),
  });
  try {
    const list = await (await fetch(`${base}/trash?limit=5`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.limit, 5);
    assert.equal(list.entries[0].relPath, 'A/Al/a.flac');

    assert.equal((await restore('../../etc/passwd')).status, 400);
    assert.equal((await restore('A/Al/a.flac')).status, 200);
    assert.equal((await restore('A/Al/a.flac')).status, 404, 'already restored');
  } finally {
    server.close();
  }
});
