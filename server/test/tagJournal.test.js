// Undo of library tag writes, against real tagged files: every edit is journaled,
// undo puts back exactly what was there (including "nothing"), and a file that
// changed after the edit is skipped rather than clobbered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
const musicDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-undo-')));
process.env.MUSIC_DIR = musicDir;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const { readTags, readCoverArt, writeTags } = await import('../src/services/tags.js');
const { reindexFile } = await import('../src/services/libraryScanner.js');
const { editTrackTags, editAlbumTags } = await import('../src/services/tagEdit.js');
const { openJournal, listChanges, undoBatch } = await import('../src/services/tagJournal.js');
const repo = await import('../src/services/libraryRepo.js');
const { createApp } = await import('../src/app.js');

let db;
let n = 0;

test.beforeEach(() => {
  db = openDb(':memory:');
  setDbForTest(db);
});

test.after(() => {
  setDbForTest(null);
  fs.rmSync(musicDir, { recursive: true, force: true });
});

// A fixture copied into its own album folder and indexed; returns {real, id}.
async function addTrack(fixture, album = `Album ${++n}`) {
  const dir = path.join(musicDir, 'Artist', album);
  fs.mkdirSync(dir, { recursive: true });
  const real = path.join(dir, `${++n} ${fixture}`);
  fs.copyFileSync(path.join(FIXTURES, fixture), real);
  await reindexFile(real);
  const { id } = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(real);
  return { real, id };
}

const mtime = (file) => Math.trunc(fs.statSync(file).mtimeMs);
const JPEG = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
const PNG = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' };

// Cover writes have no hand-edit path (only MusicBrainz fixes), so journal one directly.
async function journaledCoverWrite(real, opts) {
  const journal = openJournal(db, 'fix', 'cover');
  const written = await writeTags(real, {}, opts);
  await journal.record({ trackId: null, real }, written);
  return journal.batchId;
}

test('undo restores the exact previous values and re-empties a filled field', async () => {
  const { real, id } = await addTrack('tagged.mp3');
  const before = await readTags(real);
  assert.equal(before.year, null);

  const result = await editTrackTags({ trackId: id, fields: { title: 'Typo', artist: 'Someone', year: 1999 } });
  assert.ok(result.batchId);
  assert.equal((await readTags(real)).title, 'Typo');

  assert.deepEqual(await undoBatch(result.batchId), { undone: 1, conflicts: [], failed: [] });
  assert.deepEqual(await readTags(real), before);
  // Re-indexed, so the library shows the restored values.
  assert.equal(repo.getTrackById(db, id).title, before.title);
  assert.equal(repo.getTrackById(db, id).year, null);
});

test('undo restores the original cover bytes after a replace', async () => {
  const { real } = await addTrack('silence.mp3');
  await writeTags(real, {}, { coverImage: JPEG });

  const batchId = await journaledCoverWrite(real, { coverImage: PNG, replaceCoverArt: true });
  assert.deepEqual(await readCoverArt(real), PNG);

  assert.equal((await undoBatch(batchId)).undone, 1);
  assert.deepEqual(await readCoverArt(real), JPEG);
});

test('undo removes a cover that was added where there was none', async () => {
  const { real } = await addTrack('silence.mp3');
  const batchId = await journaledCoverWrite(real, { coverImage: JPEG });
  assert.equal((await readTags(real)).hasCoverArt, true);

  assert.equal((await undoBatch(batchId)).undone, 1);
  assert.equal((await readTags(real)).hasCoverArt, false);
});

test('a file changed after the edit is skipped; the rest are still undone', async () => {
  const album = `Shared ${++n}`;
  const a = await addTrack('silence.mp3', album);
  const b = await addTrack('silence.mp3', album);
  db.prepare('UPDATE local_tracks SET artist = ?, album = ? WHERE id IN (?, ?)').run('X', album, a.id, b.id);

  const result = await editAlbumTags({ artist: 'X', album, fields: { genre: 'Jazz' } });
  assert.equal(result.applied.length, 2);
  // Someone retags b after us.
  await writeTags(b.real, { genre: 'Blues' }, { overwrite: true });

  const undo = await undoBatch(result.batchId);
  assert.equal(undo.undone, 1);
  assert.deepEqual(undo.conflicts.map((c) => c.path), [b.real]);
  assert.equal((await readTags(a.real)).genre, null);
  assert.equal((await readTags(b.real)).genre, 'Blues', 'the later change is not clobbered');
});

test('a file that is gone is reported as a conflict', async () => {
  const { real, id } = await addTrack('silence.mp3');
  const { batchId } = await editTrackTags({ trackId: id, fields: { title: 'T' } });
  fs.rmSync(real);
  const undo = await undoBatch(batchId);
  assert.equal(undo.undone, 0);
  assert.equal(undo.conflicts.length, 1);
});

test('undoing twice is a 409 and writes nothing', async () => {
  const { real, id } = await addTrack('silence.mp3');
  const { batchId } = await editTrackTags({ trackId: id, fields: { title: 'T' } });
  await undoBatch(batchId);
  const stamp = mtime(real);

  await assert.rejects(undoBatch(batchId), (err) => err.status === 409);
  assert.equal(mtime(real), stamp);
});

test('an edit that changes nothing creates no batch', async () => {
  const { id } = await addTrack('tagged.mp3');
  const result = await editTrackTags({ trackId: id, fields: { title: 'Existing Title' } });
  assert.equal(result.batchId, null);
  assert.equal(listChanges(db).total, 0);
});

test('history lists newest first with a file count, and keeps 90 days / 500 batches', async () => {
  const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO tag_batches (kind, label, created_at) VALUES ('edit', 'ancient', ?)").run(old);
  const insert = db.prepare("INSERT INTO tag_batches (kind, label, created_at) VALUES ('edit', ?, ?)");
  for (let i = 0; i < 505; i += 1) insert.run(`old ${i}`, Date.now());
  const firstOld = db.prepare("SELECT id FROM tag_batches WHERE label = 'old 0'").get().id;
  db.prepare("INSERT INTO tag_writes (batch_id, path, before, after) VALUES (?, '/x', '{}', '{}')").run(firstOld);

  const { id } = await addTrack('silence.mp3');
  const { batchId } = await editTrackTags({ trackId: id, fields: { title: 'Newest' } });

  const { changes, total } = listChanges(db, { limit: 2 });
  assert.equal(total, 500);
  assert.equal(changes[0].id, batchId);
  assert.equal(changes[0].kind, 'edit');
  assert.equal(changes[0].files, 1);
  assert.match(changes[0].label, /^Edited tags: /);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tag_batches WHERE label = 'ancient'").get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tag_writes WHERE batch_id = ?').get(firstOld).c, 0, 'writes cascade');
});

test('a single-track edit refuses a file that changed since it was loaded', async () => {
  const { real, id } = await addTrack('silence.mp3');
  const loaded = repo.getTrackById(db, id).mtimeMs;
  assert.equal(loaded, mtime(real));

  await assert.rejects(
    editTrackTags({ trackId: id, fields: { title: 'T' }, expectedMtimeMs: loaded - 1000 }),
    (err) => err.status === 409,
  );
  assert.equal((await readTags(real)).title, null, 'nothing was written');
  assert.equal(listChanges(db).total, 0);

  const ok = await editTrackTags({ trackId: id, fields: { title: 'T' }, expectedMtimeMs: loaded });
  assert.deepEqual(ok.changedFields, ['title']);
});

test('HTTP: list changes, undo one, and a second undo is 409', async () => {
  const server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}/api/library`;
  const headers = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  try {
    const { real, id } = await addTrack('silence.mp3');
    const stale = await fetch(`${base}/track/${id}/tags`, {
      method: 'PATCH', headers, body: JSON.stringify({ fields: { title: 'T' }, expectedMtimeMs: 1 }),
    });
    assert.equal(stale.status, 409);

    const edit = await fetch(`${base}/track/${id}/tags`, {
      method: 'PATCH', headers, body: JSON.stringify({ fields: { title: 'T' }, expectedMtimeMs: mtime(real) }),
    });
    const { batchId } = await edit.json();
    assert.ok(batchId);

    const list = await (await fetch(`${base}/changes`)).json();
    assert.equal(list.changes[0].id, batchId);

    const undo = await fetch(`${base}/changes/${batchId}/undo`, { method: 'POST', headers });
    assert.deepEqual(await undo.json(), { undone: 1, conflicts: [], failed: [] });
    assert.equal((await readTags(real)).title, null);

    const again = await fetch(`${base}/changes/${batchId}/undo`, { method: 'POST', headers });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /already been undone/);

    const crossSite = await fetch(`${base}/changes/${batchId}/undo`, {
      method: 'POST', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 400, 'behind the CSRF guard');
  } finally {
    server.close();
  }
});
