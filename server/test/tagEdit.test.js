// Manual tag editing. Three contracts are worth pinning down here, because each
// one is a thing this path does that no other write path in the app does:
//   - values come from the request, so validateTagEdit is the trust boundary;
//   - it overwrites, so it has to be exact about what it names;
//   - it cannot REMOVE a tag, whatever the request says.
// Plus one that is specific to album scope: renaming an album re-keys the very
// group being edited, so the worklist has to be settled before any write lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-tagedit-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

let writes = [];
let reindexed = [];
let counter = 0;

// `writeTags` is an option so the failure-isolation test can make one file throw
// while the others succeed. The default records the call and reports every named
// field as changed, which is what a real overwrite of differing values does.
async function freshTagEdit({ writeTags } = {}) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();
  writes = [];
  reindexed = [];

  mock.module('../src/services/tags.js', {
    namedExports: {
      readTags: async () => ({ hasCoverArt: false }),
      readCoverArt: async () => null,
      plannedFills: () => [],
      writeTags: writeTags ?? (async (filePath, desired, options) => {
        writes.push({ filePath, desired, options });
        return { filledFields: Object.keys(desired) };
      }),
    },
  });

  mock.module('../src/services/libraryScanner.js', {
    namedExports: {
      reindexFile: async (filePath) => { reindexed.push(filePath); },
      rescanDirs: async () => ({}),
      scanLibrary: async () => ({}),
      stopScan: () => {},
      runScanOnce: async () => ({}),
      rowFor: () => ({}),
      changeKeyFor: () => '',
    },
  });

  return import(`../src/services/tagEdit.js?fresh=${counter}`);
}

function seedAlbum(db, { artist, album, files }) {
  for (const file of files) {
    const filePath = path.join(musicDir, ...file.rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'audio');
    repo.upsertLocalTrack(db, {
      path: filePath,
      artist,
      album,
      title: file.title ?? path.basename(filePath, path.extname(filePath)),
      trackNumber: file.trackNumber ?? null,
      durationMs: 1000,
      changeKey: `${filePath}:1`,
    });
  }
  repo.recomputeStats(db);
}

function albumIds(db, { artist, album }) {
  return repo.getAlbumTracksForRepair(db, { artist, album }).map((t) => t.id);
}

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

// ---------- validateTagEdit ----------

test('validateTagEdit trims text and coerces numeric strings', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.deepEqual(
    validateTagEdit({ title: '  Idioteque  ', year: '2000', trackNumber: 5 }),
    { title: 'Idioteque', year: 2000, trackNumber: 5 },
  );
});

// A form sends strings. Leaving them as strings would make every numeric field
// compare unequal to what writeTags read off the file, so the file would be
// rewritten on every save and the report would claim a change that didn't happen.
test('validateTagEdit returns numbers, not numeric strings', async () => {
  const { validateTagEdit } = await freshTagEdit();
  const patch = validateTagEdit({ year: '1997', disc: '2', trackNumber: '11' });
  for (const key of ['year', 'disc', 'trackNumber']) {
    assert.equal(typeof patch[key], 'number', `${key} should be coerced`);
  }
});

test('validateTagEdit strips control characters, including a NUL', async () => {
  const { validateTagEdit } = await freshTagEdit();
  const patch = validateTagEdit({
    title: `Idio${String.fromCharCode(0)}teque${String.fromCharCode(10)}`,
  });
  assert.equal(patch.title, 'Idioteque');
});

// The no-clear rule's only enforcement point, so it is asserted field by field
// rather than on a representative one.
test('validateTagEdit drops blanks and nulls for every editable field', async () => {
  const { validateTagEdit, EDITABLE_FIELDS } = await freshTagEdit();
  for (const field of EDITABLE_FIELDS) {
    for (const blank of [null, undefined, '', '   ']) {
      assert.throws(
        () => validateTagEdit({ [field]: blank }),
        /no fields to change/,
        `${field} = ${JSON.stringify(blank)} should be dropped, leaving nothing to do`,
      );
    }
  }
});

test('validateTagEdit keeps the fields that do carry a value alongside dropped ones', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.deepEqual(
    validateTagEdit({ artist: '', title: 'Kept', year: null }),
    { title: 'Kept' },
    'a blank sibling must not take the real edit down with it',
  );
});

test('validateTagEdit rejects out-of-range numbers and names the range', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.throws(() => validateTagEdit({ year: 3000 }), /between 1 and 2999/);
  assert.throws(() => validateTagEdit({ year: 0 }), /between 1 and 2999/);
  assert.throws(() => validateTagEdit({ trackNumber: 1000 }), /between 1 and 999/);
  assert.throws(() => validateTagEdit({ trackNumber: 0 }), /between 1 and 999/);
  assert.throws(() => validateTagEdit({ disc: 100 }), /between 1 and 99/);
});

test('validateTagEdit rejects a fractional number', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.throws(() => validateTagEdit({ trackNumber: 1.5 }), /whole number/);
  assert.throws(() => validateTagEdit({ trackNumber: 'five' }), /whole number/);
});

test('validateTagEdit rejects over-long text rather than truncating it', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.throws(() => validateTagEdit({ title: 'x'.repeat(501) }), /500 characters or fewer/);
  assert.equal(validateTagEdit({ title: 'x'.repeat(500) }).title.length, 500);
});

test('validateTagEdit rejects unknown keys and non-scalar values', async () => {
  const { validateTagEdit } = await freshTagEdit();
  assert.throws(() => validateTagEdit({ albumArtist: 'X' }), /cannot be set here/);
  assert.throws(() => validateTagEdit({ title: ['a'] }), /must be text/);
  assert.throws(() => validateTagEdit({ title: { a: 1 } }), /must be text/);
  assert.throws(() => validateTagEdit({ year: true }), /must be a number/);
  assert.throws(() => validateTagEdit({}), /no fields to change/);
  assert.throws(() => validateTagEdit(null), /must be an object/);
});

test('validateTagEdit restricts album-wide fields to the ones that make sense', async () => {
  const { validateTagEdit, ALBUM_WIDE_FIELDS } = await freshTagEdit();
  assert.throws(
    () => validateTagEdit({ title: 'One title for all' }, { allow: ALBUM_WIDE_FIELDS }),
    /cannot be set here/,
  );
  assert.throws(
    () => validateTagEdit({ trackNumber: 3 }, { allow: ALBUM_WIDE_FIELDS }),
    /cannot be set here/,
  );
  assert.deepEqual(
    validateTagEdit({ album: 'Kid A', year: 2000 }, { allow: ALBUM_WIDE_FIELDS }),
    { album: 'Kid A', year: 2000 },
  );
});

// ---------- editTrackTags ----------

test('editTrackTags writes the patch with overwrite and re-indexes the file', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', '01 - Everything.flac'] }],
  });
  const [id] = albumIds(db, { artist: 'Radiohead', album: 'Kid A' });

  const { editTrackTags } = await freshTagEdit();
  const result = await editTrackTags({ trackId: id, fields: { title: 'Idioteque', year: '2000' }, db });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].desired, { title: 'Idioteque', year: 2000 });
  assert.equal(writes[0].options.overwrite, true, 'a manual edit must overwrite');
  assert.equal(reindexed.length, 1);
  assert.deepEqual(result.changedFields, ['title', 'year']);
  assert.ok(result.track, 'the refreshed row comes back');
  db.close();
});

// Object.hasOwn, not != null: a `{title: undefined}` key would reach taglib as a
// silent no-op, so a looser assertion would pass while the bug shipped.
test('editTrackTags leaves dropped fields genuinely absent from the patch', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Amnesiac',
    files: [{ rel: ['Radiohead', 'Amnesiac', '01 - Packt.flac'] }],
  });
  const [id] = albumIds(db, { artist: 'Radiohead', album: 'Amnesiac' });

  const { editTrackTags } = await freshTagEdit();
  await editTrackTags({ trackId: id, fields: { title: 'Packt', artist: '', genre: null }, db });

  const { desired } = writes[0];
  assert.equal(Object.hasOwn(desired, 'artist'), false, 'a blanked field must not be sent at all');
  assert.equal(Object.hasOwn(desired, 'genre'), false, 'a nulled field must not be sent at all');
  assert.deepEqual(Object.keys(desired), ['title']);
  db.close();
});

test('editTrackTags rejects an unknown track', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { editTrackTags } = await freshTagEdit();
  await assert.rejects(
    () => editTrackTags({ trackId: 9999, fields: { title: 'X' }, db }),
    /Track not found/,
  );
  db.close();
});

// ---------- editAlbumTags ----------

test('editAlbumTags renames every file in the album', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [
      { rel: ['Radiohead', 'Kid A', '01 - a.flac'] },
      { rel: ['Radiohead', 'Kid A', '02 - b.flac'] },
      { rel: ['Radiohead', 'Kid A', '03 - c.flac'] },
    ],
  });

  const { editAlbumTags } = await freshTagEdit();
  const result = await editAlbumTags({
    artist: 'Radiohead', album: 'Kid A', fields: { album: 'Kid A (Remastered)' }, db,
  });

  // The point of the test: the loop settled its worklist before writing, so
  // re-keying the group partway through didn't lose the rest of the album.
  assert.equal(result.applied.length, 3);
  assert.equal(writes.length, 3);
  assert.deepEqual(result.renamed, { artist: 'Radiohead', album: 'Kid A (Remastered)' });
  db.close();
});

test('editAlbumTags reports renamed only when the identity moved', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead', album: 'The Bends', files: [{ rel: ['Radiohead', 'The Bends', '01 - a.flac'] }],
  });

  const { editAlbumTags } = await freshTagEdit();
  const result = await editAlbumTags({
    artist: 'Radiohead', album: 'The Bends', fields: { year: 1995 }, db,
  });
  assert.equal(result.renamed, null);
  db.close();
});

// The highest-blast-radius version of the no-clear rule: one blank box must not
// empty a field across an entire record.
test('editAlbumTags does not clear a field across the album when it is blanked', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'OK Computer',
    files: [
      { rel: ['Radiohead', 'OK Computer', '01 - a.flac'] },
      { rel: ['Radiohead', 'OK Computer', '02 - b.flac'] },
    ],
  });

  const { editAlbumTags } = await freshTagEdit();
  await assert.rejects(
    () => editAlbumTags({
      artist: 'Radiohead', album: 'OK Computer', fields: { genre: '', artist: null }, db,
    }),
    /no fields to change/,
  );
  assert.equal(writes.length, 0, 'nothing may be written for an all-blank patch');
  db.close();
});

test('editAlbumTags lets a per-track value win over the album-wide one', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'In Rainbows',
    files: [
      { rel: ['Radiohead', 'In Rainbows', '01 - a.flac'] },
      { rel: ['Radiohead', 'In Rainbows', '02 - b.flac'] },
    ],
  });
  const ids = albumIds(db, { artist: 'Radiohead', album: 'In Rainbows' });

  const { editAlbumTags } = await freshTagEdit();
  await editAlbumTags({
    artist: 'Radiohead',
    album: 'In Rainbows',
    fields: { year: 2007 },
    perTrack: [{ trackId: ids[0], fields: { title: 'Nude', trackNumber: 3 } }],
    db,
  });

  const byPath = Object.fromEntries(writes.map((w) => [path.basename(w.filePath), w.desired]));
  assert.deepEqual(byPath['01 - a.flac'], { year: 2007, title: 'Nude', trackNumber: 3 });
  assert.deepEqual(byPath['02 - b.flac'], { year: 2007 });
  db.close();
});

test('editAlbumTags ignores a track id from another album', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead', album: 'Kid A', files: [{ rel: ['Radiohead', 'Kid A', '01 - a.flac'] }],
  });
  seedAlbum(db, {
    artist: 'Portishead', album: 'Dummy', files: [{ rel: ['Portishead', 'Dummy', '01 - z.flac'] }],
  });
  const [outsider] = albumIds(db, { artist: 'Portishead', album: 'Dummy' });

  const { editAlbumTags } = await freshTagEdit();
  const result = await editAlbumTags({
    artist: 'Radiohead', album: 'Kid A', fields: { year: 2000 }, trackIds: [outsider], db,
  });

  assert.equal(result.applied.length, 0);
  assert.equal(writes.length, 0, 'an id this album did not produce is not editable through it');
  db.close();
});

test('editAlbumTags finds and edits an album whose files carry no artist tag', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null, album: 'Untitled', files: [{ rel: ['Unknown', 'Untitled', '01 - a.flac'] }],
  });

  const { editAlbumTags } = await freshTagEdit();
  const result = await editAlbumTags({
    artist: null, album: 'Untitled', fields: { artist: 'Aphex Twin' }, db,
  });

  assert.equal(result.applied.length, 1, 'a NULL-artist album must still be reachable');
  assert.deepEqual(result.renamed, { artist: 'Aphex Twin', album: 'Untitled' });
  db.close();
});

// One read-only file in an album must not abandon the rest of it, and the reason
// it failed must not carry the server's directory layout out to the browser.
test('editAlbumTags isolates a failing file and leaks no path in the message', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Hail to the Thief',
    files: [
      { rel: ['Radiohead', 'Hail', '01 - ok.flac'] },
      { rel: ['Radiohead', 'Hail', '02 - bad.flac'] },
      { rel: ['Radiohead', 'Hail', '03 - ok.flac'] },
    ],
  });

  const { editAlbumTags } = await freshTagEdit({
    writeTags: async (filePath, desired) => {
      if (filePath.includes('bad')) {
        const err = new Error(`EACCES: permission denied, open '${filePath}'`);
        err.code = 'EACCES';
        throw err;
      }
      writes.push({ filePath, desired });
      return { filledFields: Object.keys(desired) };
    },
  });

  const result = await editAlbumTags({
    artist: 'Radiohead', album: 'Hail to the Thief', fields: { year: 2003 }, db,
  });

  assert.equal(result.applied.length, 2, 'the run continues past the failure');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'unwritable');
  assert.ok(
    !result.failed[0].message.includes(musicDir),
    `the failure message leaked a path: ${result.failed[0].message}`,
  );
  db.close();
});

test('editAlbumTags refuses a request over the bulk ceiling', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { editAlbumTags } = await freshTagEdit();
  const { MAX_BULK_FIX } = await import('../src/services/libraryBulkFix.js');

  await assert.rejects(
    () => editAlbumTags({
      album: 'Kid A',
      fields: { year: 2000 },
      perTrack: Array.from({ length: MAX_BULK_FIX + 1 }, (_, i) => ({
        trackId: i + 1, fields: { title: 'x' },
      })),
      db,
    }),
    /at most/,
  );
  db.close();
});

test('editAlbumTags requires an album', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { editAlbumTags } = await freshTagEdit();
  await assert.rejects(
    () => editAlbumTags({ album: '', fields: { year: 2000 }, db }),
    /album is required/,
  );
  db.close();
});
