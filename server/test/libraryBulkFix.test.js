// Album-scoped bulk tag repair. The contracts worth pinning down are that a
// preview reports what the *file* is missing rather than what the index shows,
// that apply is confined to the album it named, and that the never-overwrite
// rule the single-track repair makes still holds when a hundred files go through
// at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-bulk-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

const unexpected = (name) => async () => {
  throw new Error(`${name} should not have been called`);
};

const DEFAULT_MB = {
  searchArtists: unexpected('searchArtists'),
  searchReleaseGroups: unexpected('searchReleaseGroups'),
  searchRecordings: unexpected('searchRecordings'),
  searchAll: unexpected('searchAll'),
  getArtist: unexpected('getArtist'),
  browseReleaseGroupsByArtist: unexpected('browseReleaseGroupsByArtist'),
  resolvePrimaryReleaseForGroup: unexpected('resolvePrimaryReleaseForGroup'),
  getReleaseWithTracks: unexpected('getReleaseWithTracks'),
  getRecording: unexpected('getRecording'),
};

// What each file "carries on disk", keyed by path, so the tags mock can answer
// per file the way readTags does — the index deliberately holds different values.
let onDisk = {};
let writes = [];
let reindexed = [];
let counter = 0;

// `resolveAlbum` is mocked rather than driven through a searchReleaseGroups
// stub: libraryBulkFix imports libraryDiscography without a cache-busting
// suffix, so the cached copy stays bound to whichever musicbrainz mock was
// registered first. How an album resolves to a release group is
// libraryDiscography's own contract and is tested there.
// `writeTags` is an explicit option rather than part of the rest spread,
// which goes to the musicbrainz mock — the failure-isolation test needs one file
// to fail to write while the others succeed.
async function freshBulkFix({ resolveAlbum, writeTags, ...mbMocks } = {}) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();

  mock.module('../src/services/musicbrainz.js', {
    namedExports: { ...DEFAULT_MB, ...mbMocks },
  });

  mock.module('../src/services/libraryDiscography.js', {
    namedExports: {
      resolveAlbum: resolveAlbum ?? unexpected('resolveAlbum'),
    },
  });

  mock.module('../src/services/tags.js', {
    namedExports: {
      readTags: async (filePath) => {
        if (onDisk[filePath] === undefined) throw new Error('unreadable');
        return { hasCoverArt: false, ...onDisk[filePath] };
      },
      readCoverArt: async () => null,
      plannedFills: (current, desired) => Object.keys(desired)
        .filter((k) => desired[k] != null && current[k] == null),
      writeTags: writeTags ?? (async (filePath, desired) => {
        const current = onDisk[filePath] ?? {};
        const filledFields = Object.keys(desired)
          .filter((k) => desired[k] != null && current[k] == null);
        writes.push({ filePath, desired, filledFields });
        return { filledFields };
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

  return import(`../src/services/libraryBulkFix.js?fresh=${counter}`);
}

// Seeds an album on disk and in the index. `indexed` mirrors what the scanner
// would have written (album falling back to the folder name, title to the
// filename); `disk` is what the file's tags actually say.
function seedAlbum(db, { artist, album, files }) {
  onDisk = {};
  for (const file of files) {
    const filePath = path.join(musicDir, ...file.rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'audio');
    onDisk[filePath] = file.disk;
    repo.upsertLocalTrack(db, {
      path: filePath,
      artist,
      album,
      title: file.indexedTitle ?? path.basename(filePath, path.extname(filePath)),
      trackNumber: file.indexedTrackNumber ?? null,
      durationMs: 1000,
      changeKey: `${filePath}:1`,
    });
  }
  repo.recomputeStats(db);
}

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

test('a preview reports what the file is missing, not what the index shows', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  // The index carries an album and title (the scanner falls back to the folder
  // and filename), but the file itself carries neither.
  seedAlbum(db, {
    artist: null,
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', '05 - Idioteque.flac'], disk: { artist: null, album: null, title: null, trackNumber: null, disc: null, year: null } }],
  });

  const { previewBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: null, album: 'Kid A', source: 'path', db });

  assert.equal(preview.tracks.length, 1, 'a NULL-artist album is still found');
  const [track] = preview.tracks;
  assert.equal(track.proposed.artist, 'Radiohead');
  assert.equal(track.proposed.album, 'Kid A');
  assert.equal(track.proposed.title, 'Idioteque');
  assert.equal(track.proposed.trackNumber, 5);
  assert.deepEqual(track.fills.sort(), ['album', 'artist', 'title', 'trackNumber']);
  db.close();
});

test('a preview writes nothing', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null,
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', '05 - Idioteque.flac'], disk: { artist: null, album: null, title: null } }],
  });
  writes = [];

  const { previewBulkFix } = await freshBulkFix();
  await previewBulkFix({ artist: null, album: 'Kid A', source: 'path', db });

  assert.deepEqual(writes, []);
  db.close();
});

test('a file that already has a tag has nothing proposed for that field', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'My Own Spelling',
    album: 'Kid A',
    files: [{
      rel: ['Radiohead', 'Kid A', '05 - Idioteque.flac'],
      disk: { artist: 'My Own Spelling', album: null, title: 'Idioteque', trackNumber: null },
    }],
  });

  const { previewBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: 'My Own Spelling', album: 'Kid A', source: 'path', db });

  assert.ok(!preview.tracks[0].fills.includes('artist'), 'an existing artist tag is left alone');
  assert.ok(!preview.tracks[0].fills.includes('title'), 'an existing title tag is left alone');
  assert.ok(preview.tracks[0].fills.includes('album'));
  db.close();
});

// "99 Problems.mp3" reads as track 99. A real position is bounded by the size of
// the album, so a number well past that is a title, not a position.
test('an implausible track number is dropped from the proposal', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null,
    album: 'The Black Album',
    files: [{
      rel: ['Jay-Z', 'The Black Album', '99 Problems.mp3'],
      disk: { artist: null, album: null, title: null, trackNumber: null },
    }],
  });

  const { previewBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: null, album: 'The Black Album', source: 'path', db });

  assert.equal(preview.tracks[0].proposed.trackNumber, null, '99 is not a position on a 1-track folder');
  assert.equal(preview.tracks[0].proposed.title, 'Problems', 'the title is still proposed');
  db.close();
});

test('an ordinary track number on a partial album is kept', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  // Owning tracks 1 and 12 of a record is normal here — gap detection is the
  // point of the app — and is not evidence that 12 was mis-read.
  seedAlbum(db, {
    artist: null,
    album: 'Album',
    files: [
      { rel: ['Band', 'Album', '01 First.mp3'], disk: { artist: null, title: null, album: null } },
      { rel: ['Band', 'Album', '12 Last.mp3'], disk: { artist: null, title: null, album: null } },
    ],
  });

  const { previewBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: null, album: 'Album', source: 'path', db });

  const numbers = preview.tracks.map((t) => t.proposed.trackNumber).sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 12]);
  db.close();
});

test('apply writes only the chosen tracks and re-indexes each one', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null,
    album: 'Album',
    files: [
      { rel: ['Band', 'Album', '01 First.mp3'], disk: { artist: null, title: null, album: null } },
      { rel: ['Band', 'Album', '02 Second.mp3'], disk: { artist: null, title: null, album: null } },
    ],
  });
  writes = [];
  reindexed = [];

  const { previewBulkFix, applyBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: null, album: 'Album', source: 'path', db });
  const chosen = preview.tracks[0].trackId;
  const result = await applyBulkFix({ artist: null, album: 'Album', source: 'path', trackIds: [chosen], db });

  assert.equal(writes.length, 1, 'only the chosen track was written');
  assert.equal(result.applied.length, 1);
  assert.equal(reindexed.length, 1, 'the written file was re-indexed');
  assert.equal(reindexed[0], writes[0].filePath);
  db.close();
});

// The album named in the request is the boundary: an id from somewhere else in
// the library is not in this album's preview and is dropped, so this endpoint
// can't be used to repair arbitrary tracks by listing their ids.
test('apply ignores track ids that are not in the named album', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null,
    album: 'Album',
    files: [{ rel: ['Band', 'Album', '01 First.mp3'], disk: { artist: null, title: null, album: null } }],
  });
  // A track in a different album entirely.
  const otherPath = path.join(musicDir, 'Other', 'Other Album', '01 Other.mp3');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.writeFileSync(otherPath, 'audio');
  onDisk[otherPath] = { artist: null, title: null, album: null };
  repo.upsertLocalTrack(db, {
    path: otherPath, artist: null, album: 'Other Album', title: '01 Other',
    durationMs: 1000, changeKey: 'other:1',
  });
  const outsider = repo.listTracks(db, { album: 'Other Album' }).tracks[0];
  writes = [];

  const { applyBulkFix } = await freshBulkFix();
  const result = await applyBulkFix({
    artist: null, album: 'Album', source: 'path', trackIds: [outsider.id], db,
  });

  assert.deepEqual(writes, [], 'nothing outside the named album was written');
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped, 1);
  db.close();
});

test('a request over the cap is refused rather than truncated', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { applyBulkFix, MAX_BULK_FIX } = await freshBulkFix();
  await assert.rejects(
    () => applyBulkFix({
      album: 'Album', source: 'path', db,
      trackIds: Array.from({ length: MAX_BULK_FIX + 1 }, (_, i) => i + 1),
    }),
    /too many tracks/i,
  );
  db.close();
});

test('the musicbrainz source aligns local files to the upstream tracklist by position', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [
      { rel: ['Radiohead', 'Kid A', 'a.flac'], indexedTrackNumber: 1, disk: { artist: 'Radiohead', album: 'Kid A', title: null, trackNumber: 1 } },
      { rel: ['Radiohead', 'Kid A', 'b.flac'], indexedTrackNumber: 2, disk: { artist: 'Radiohead', album: 'Kid A', title: null, trackNumber: 2 } },
    ],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }),
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Kid A', artist: 'Radiohead', date: '2000-10-02' },
      tracks: [
        { position: 1, discNumber: 1, recordingMbid: 'r1', title: 'Everything In Its Right Place', lengthMs: 1 },
        { position: 2, discNumber: 1, recordingMbid: 'r2', title: 'Kid A', lengthMs: 1 },
      ],
    }),
  });
  const preview = await previewBulkFix({ artist: 'Radiohead', album: 'Kid A', source: 'musicbrainz', db });

  assert.equal(preview.tracks[0].proposed.title, 'Everything In Its Right Place');
  assert.equal(preview.tracks[1].proposed.title, 'Kid A');
  assert.equal(preview.tracks[0].proposed.year, 2000, 'the year comes from the release date');
  db.close();
});

// Aligning an unnumbered 1-file folder against a 2-track release by index would
// put track 1's title on whichever file happened to sort first.
test('the musicbrainz source refuses to align unnumbered files of a different count', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', 'only.flac'], disk: { artist: 'Radiohead', album: 'Kid A', title: null } }],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }),
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Kid A', artist: 'Radiohead', date: '2000-10-02' },
      tracks: [
        { position: 1, discNumber: 1, recordingMbid: 'r1', title: 'Everything In Its Right Place', lengthMs: 1 },
        { position: 2, discNumber: 1, recordingMbid: 'r2', title: 'Kid A', lengthMs: 1 },
      ],
    }),
  });
  const preview = await previewBulkFix({ artist: 'Radiohead', album: 'Kid A', source: 'musicbrainz', db });

  assert.equal(preview.tracks[0].proposed, null, 'no guess is made about which track this is');
  assert.deepEqual(preview.tracks[0].fills, []);
  db.close();
});

test('an album MusicBrainz cannot resolve is reported rather than guessed at', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Nobody',
    album: 'Unknown Record',
    files: [{ rel: ['Nobody', 'Unknown Record', '01 A.mp3'], disk: { artist: 'Nobody', album: null, title: null } }],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: null }),
  });
  const preview = await previewBulkFix({ artist: 'Nobody', album: 'Unknown Record', source: 'musicbrainz', db });

  assert.equal(preview.unresolved, true);
  assert.deepEqual(preview.tracks, []);
  db.close();
});

test('an unknown source is refused', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { previewBulkFix } = await freshBulkFix();
  await assert.rejects(
    () => previewBulkFix({ album: 'Album', source: 'whatever', db }),
    /source must be/i,
  );
  db.close();
});

// A release's own artist credit is not every track's artist credit. Using it as
// one tagged every file on a compilation as "Various Artists" — and since the
// repair only fills fields that are already empty, the files it reached were
// precisely the untagged ones this feature exists to fix.
test('a compilation takes each track artist from the track, not the release', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Various Artists',
    album: 'Now 47',
    files: [
      { rel: ['Various Artists', 'Now 47', 'a.mp3'], indexedTrackNumber: 1, disk: { artist: null, album: 'Now 47', title: null, trackNumber: 1 } },
      { rel: ['Various Artists', 'Now 47', 'b.mp3'], indexedTrackNumber: 2, disk: { artist: null, album: 'Now 47', title: null, trackNumber: 2 } },
    ],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }),
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Now 47', artist: 'Various Artists', date: '2000-01-01' },
      tracks: [
        { position: 1, discNumber: 1, recordingMbid: 'r1', title: 'One', artist: 'Blur', lengthMs: 1 },
        { position: 2, discNumber: 1, recordingMbid: 'r2', title: 'Two', artist: 'Pulp', lengthMs: 1 },
      ],
    }),
  });
  const preview = await previewBulkFix({ artist: 'Various Artists', album: 'Now 47', source: 'musicbrainz', db });

  assert.equal(preview.tracks[0].proposed.artist, 'Blur');
  assert.equal(preview.tracks[1].proposed.artist, 'Pulp');
  db.close();
});

test('a track with no credit of its own still falls back to the release credit', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', 'a.flac'], indexedTrackNumber: 1, disk: { artist: null, album: 'Kid A', title: null, trackNumber: 1 } }],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }),
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Kid A', artist: 'Radiohead', date: '2000-10-02' },
      tracks: [{ position: 1, discNumber: 1, recordingMbid: 'r1', title: 'Idioteque', artist: null, lengthMs: 1 }],
    }),
  });
  const preview = await previewBulkFix({ artist: 'Radiohead', album: 'Kid A', source: 'musicbrainz', db });

  assert.equal(preview.tracks[0].proposed.artist, 'Radiohead');
  db.close();
});

// Two files claiming the same position means the numbers on disk don't describe
// this release. Matching each file independently let both be proposed the same
// title; a duplicate rip in one folder is a normal state for a real library,
// which is why there is a whole Duplicates tab.
test('two local files claiming one upstream track abandon the alignment', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [
      { rel: ['Radiohead', 'Kid A', 'a.flac'], indexedTrackNumber: 1, disk: { artist: 'Radiohead', album: 'Kid A', title: null, trackNumber: 1 } },
      { rel: ['Radiohead', 'Kid A', 'a-copy.flac'], indexedTrackNumber: 1, disk: { artist: 'Radiohead', album: 'Kid A', title: null, trackNumber: 1 } },
    ],
  });

  const { previewBulkFix } = await freshBulkFix({
    resolveAlbum: async () => ({ releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }),
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Kid A', artist: 'Radiohead', date: '2000-10-02' },
      tracks: [
        { position: 1, discNumber: 1, recordingMbid: 'r1', title: 'Everything In Its Right Place', artist: 'Radiohead', lengthMs: 1 },
        { position: 2, discNumber: 1, recordingMbid: 'r2', title: 'Kid A', artist: 'Radiohead', lengthMs: 1 },
      ],
    }),
  });
  const preview = await previewBulkFix({ artist: 'Radiohead', album: 'Kid A', source: 'musicbrainz', db });

  assert.equal(preview.unresolved, true, 'a colliding alignment proposes nothing at all');
  assert.deepEqual(preview.tracks, []);
  db.close();
});

// A file that has gone read-only or vanished mid-run used to throw straight out
// of the apply loop, discarding the record of everything already written — the
// user got a 500 and no way to know which of their files had been modified.
test('one unwritable file is reported without abandoning the rest of the album', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: null,
    album: 'Album',
    files: [
      { rel: ['Band', 'Album', '01 First.mp3'], disk: { artist: null, title: null, album: null } },
      { rel: ['Band', 'Album', '02 Second.mp3'], disk: { artist: null, title: null, album: null } },
    ],
  });
  const ids = repo.listTracks(db, { album: 'Album' }).tracks.map((t) => t.id);
  writes = [];

  const { applyBulkFix } = await freshBulkFix({
    writeTags: async (filePath, desired) => {
      if (filePath.endsWith('01 First.mp3')) {
        // Shaped like the real thing: an fs error carries a `code` and a message
        // with the absolute path baked into it.
        const err = new Error(`EACCES: permission denied, open '${filePath}'`);
        err.code = 'EACCES';
        throw err;
      }
      writes.push({ filePath, desired });
      return { filledFields: Object.keys(desired).filter((k) => desired[k] != null) };
    },
  });
  const result = await applyBulkFix({ artist: null, album: 'Album', source: 'path', trackIds: ids, db });

  assert.equal(result.applied.length, 1, 'the readable file was still repaired');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'unwritable');
  // The failure is reported, but not by echoing the errno string: that carries
  // the server's absolute directory layout, and this response is rendered in a
  // page. paths.js refuses to do this in its own errors; so does this.
  assert.doesNotMatch(result.failed[0].message, /EACCES/);
  assert.doesNotMatch(result.failed[0].message, new RegExp(String.raw`[/\\]`));
  assert.equal(result.skipped, 0, 'every requested track is accounted for as applied or failed');
  db.close();
});

// Apply used to recompute the preview from scratch — every file's tags read a
// second time and, for the musicbrainz source, two more trips through the
// 1-req/s upstream queue to re-resolve an album the client had just been shown.
test('apply reuses a supplied preview instead of resolving the album again', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Radiohead',
    album: 'Kid A',
    files: [{ rel: ['Radiohead', 'Kid A', 'a.flac'], indexedTrackNumber: 1, disk: { artist: null, album: null, title: null, trackNumber: 1 } }],
  });

  let resolveCalls = 0;
  const { previewBulkFix, applyBulkFix } = await freshBulkFix({
    resolveAlbum: async () => { resolveCalls += 1; return { releaseGroupMbid: '11111111-1111-4111-8111-111111111111' }; },
    resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
    getReleaseWithTracks: async () => ({
      release: { mbid: '5', title: 'Kid A', artist: 'Radiohead', date: '2000-10-02' },
      tracks: [{ position: 1, discNumber: 1, recordingMbid: 'r1', title: 'Idioteque', artist: 'Radiohead', lengthMs: 1 }],
    }),
  });

  const preview = await previewBulkFix({ artist: 'Radiohead', album: 'Kid A', source: 'musicbrainz', db });
  assert.equal(resolveCalls, 1);
  writes = [];

  const result = await applyBulkFix({
    artist: 'Radiohead',
    album: 'Kid A',
    source: 'musicbrainz',
    trackIds: preview.tracks.map((t) => t.trackId),
    preview,
    db,
  });

  assert.equal(resolveCalls, 1, 'the upstream album was not resolved a second time');
  assert.equal(result.applied.length, 1);
  db.close();
});

// The route hands an apply the preview it is applying, cached for up to ten
// minutes, on the reasoning that "what gets written is what was on screen and
// approved". That is only true if the file didn't move underneath it — and in
// ten minutes the single-track fix, an external tagger, or a re-rip can all have
// touched it. Nothing checked, so the honest-looking hand-off could write a
// proposal derived from tags that no longer existed.
test('an apply refuses a file that changed after the preview was taken', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Band',
    album: 'Record',
    files: [
      { rel: ['Band', 'Record', '01 First.mp3'], disk: { artist: null, title: null, album: null } },
      { rel: ['Band', 'Record', '02 Second.mp3'], disk: { artist: null, title: null, album: null } },
    ],
  });
  const ids = repo.listTracks(db, { album: 'Record' }).tracks.map((t) => t.id);
  writes = [];

  const { previewBulkFix, applyBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: 'Band', album: 'Record', source: 'path', db });
  assert.equal(preview.tracks.length, 2);
  assert.ok(preview.tracks.every((t) => t.mtimeMs != null), 'the preview records what it previewed');

  // One file is touched between preview and apply.
  const changed = path.join(musicDir, 'Band', 'Record', '01 First.mp3');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(changed, future, future);

  const result = await applyBulkFix({
    artist: 'Band', album: 'Record', source: 'path', trackIds: ids, preview, db,
  });

  assert.equal(result.applied.length, 1, 'the untouched file was still repaired');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'stale');
  assert.ok(!writes.some((w) => w.filePath === changed), 'the changed file was not written');
  db.close();
});

test('an unchanged file applies normally from a cached preview', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  seedAlbum(db, {
    artist: 'Band',
    album: 'Record',
    files: [{ rel: ['Band', 'Record', '01 First.mp3'], disk: { artist: null, title: null, album: null } }],
  });
  const ids = repo.listTracks(db, { album: 'Record' }).tracks.map((t) => t.id);
  writes = [];

  const { previewBulkFix, applyBulkFix } = await freshBulkFix();
  const preview = await previewBulkFix({ artist: 'Band', album: 'Record', source: 'path', db });
  const result = await applyBulkFix({
    artist: 'Band', album: 'Record', source: 'path', trackIds: ids, preview, db,
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(writes.length, 1);
  db.close();
});
