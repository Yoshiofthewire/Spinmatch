import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { openDb, setDbForTest } = await import('../src/lib/db.js');
const configModule = await import('../src/config.js');

// runScanOnce reads real tags via node-taglib-sharp; mock it so the test can use
// cheap placeholder files. Register the mock BEFORE importing the scanner, then
// import the scanner with a cache-busting suffix (same technique as ingest.test.js).
let counter = 0;
async function freshScanner(readTagsImpl) {
  counter += 1;
  const { mock } = await import('node:test');
  // Each top-level `test()` below calls freshScanner exactly once, but the
  // global `mock` tracker (as opposed to a TestContext-scoped `t.mock`) does
  // not auto-restore module mocks between separate `test()` calls, so a
  // second registration of the same specifier throws
  // `ERR_INVALID_STATE: ... already mocked`. Reset before each registration
  // so successive tests each get a clean mock of tags.js.
  mock.reset();
  mock.module('../src/services/tags.js', {
    namedExports: { readTags: readTagsImpl },
  });
  return import(`../src/services/libraryScanner.js?fresh=${counter}`);
}

async function withMusicDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-music-'));
  const original = configModule.config.ingest.musicDir;
  configModule.config.ingest.musicDir = dir;
  const db = openDb(':memory:');
  setDbForTest(db);
  try {
    await fn(dir, db);
  } finally {
    configModule.config.ingest.musicDir = original;
    setDbForTest(null);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('runScanOnce indexes audio files with their tags and ignores non-audio', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.mkdir(path.join(dir, 'Artist', 'Album'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Artist', 'Album', '01.mp3'), 'x');
    await fs.writeFile(path.join(dir, 'Artist', 'Album', 'cover.jpg'), 'x');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'Artist', album: 'Album', title: 'Song One', /* other fields */ genre: null,
    }));
    const summary = await runScanOnce();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    assert.equal(repo.hasRecording(db, { artist: 'Artist', title: 'Song One' }), true);
  });
});

test('runScanOnce persists the full tag set, not just artist/album/title', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'song.flac'), 'xxxxx');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'A', album: 'Al', title: 'T', durationMs: 245000,
      trackNumber: 4, disc: 2, year: 1999, genre: 'Rock', hasCoverArt: true,
    }));
    await runScanOnce();

    const repo = await import('../src/services/libraryRepo.js');
    const [track] = repo.listTracks(db, {}).tracks;
    assert.equal(track.durationMs, 245000);
    assert.equal(track.trackNumber, 4);
    assert.equal(track.disc, 2);
    assert.equal(track.year, 1999);
    assert.equal(track.genre, 'Rock');
    assert.equal(track.hasCoverArt, 1);
    assert.equal(track.ext, 'flac');
    assert.equal(track.sizeBytes, 5);
    // Aggregate totals depend on duration/size actually landing in the rows.
    assert.equal(repo.getStats(db).totalDurationMs, 245000);
    assert.equal(repo.getStats(db).totalBytes, 5);
  });
});

test('added_at records first indexing and survives a later re-tag', async () => {
  await withMusicDir(async (dir, db) => {
    const p = path.join(dir, 'track.mp3');
    await fs.writeFile(p, 'x');
    const { runScanOnce: first } = await freshScanner(
      async () => ({ artist: 'A', album: 'B', title: 'T' }),
    );
    await first();
    const repo = await import('../src/services/libraryRepo.js');
    const original = repo.listTracks(db, {}).tracks[0].addedAt;
    assert.ok(original > 0);

    // Change the file so the next scan re-reads and re-upserts it.
    const future = new Date(Date.now() + 2000);
    await fs.utimes(p, future, future);
    const { runScanOnce: second } = await freshScanner(
      async () => ({ artist: 'A', album: 'B', title: 'T retagged' }),
    );
    await second();

    const row = repo.listTracks(db, {}).tracks[0];
    assert.equal(row.title, 'T retagged');
    assert.equal(row.addedAt, original, 'added_at must not move on re-scan');
  });
});

test('a second scan with no changes re-reads no tags (all skipped)', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'x');
    let reads = 0;
    const read = async () => { reads += 1; return { artist: 'A', album: 'B', title: 'T' }; };
    const { runScanOnce } = await freshScanner(read);
    await runScanOnce();
    assert.equal(reads, 1);
    await runScanOnce(); // unchanged file -> skipped, no re-read
    assert.equal(reads, 1);
  });
});

test('a deleted file is marked removed on the next scan', async () => {
  await withMusicDir(async (dir, db) => {
    const p = path.join(dir, 'track.mp3');
    await fs.writeFile(p, 'x');
    const { runScanOnce } = await freshScanner(async () => ({ artist: 'A', album: 'B', title: 'T' }));
    await runScanOnce();
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    await fs.rm(p);
    await runScanOnce();
    assert.equal(repo.getStats(db).totalTracks, 0);
  });
});

test('a file whose tags throw is skipped without aborting the scan', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'good.mp3'), 'x');
    await fs.writeFile(path.join(dir, 'bad.mp3'), 'x');
    const read = async (fp) => {
      if (fp.endsWith('bad.mp3')) throw new Error('corrupt');
      return { artist: 'A', album: 'B', title: 'Good' };
    };
    const { runScanOnce } = await freshScanner(read);
    const summary = await runScanOnce();
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
  });
});

test('a previously-indexed file whose tags later throw is kept, not removed', async () => {
  await withMusicDir(async (dir, db) => {
    const p = path.join(dir, 'track.mp3');
    await fs.writeFile(p, 'x');
    const { runScanOnce: firstScan } = await freshScanner(
      async () => ({ artist: 'A', album: 'B', title: 'Keeper' }),
    );
    await firstScan();
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);

    // Force a change so the second scan actually re-reads tags instead of
    // skipping the unchanged file.
    const future = new Date(Date.now() + 1000);
    await fs.utimes(p, future, future);

    const { runScanOnce: secondScan } = await freshScanner(
      async () => { throw new Error('transient read error'); },
    );
    await secondScan();
    assert.equal(repo.getStats(db).totalTracks, 1);
    assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Keeper' }), true);
  });
});

test('rescanDirs updates one album without touching the rest of the library', async () => {
  // The real hazard: runScanOnce reconciles removals against the WHOLE library,
  // so reusing that logic for a subset would mark every other track removed.
  await withMusicDir(async (dir, db) => {
    const repo = await import('../src/services/libraryRepo.js');
    const one = path.join(dir, 'Artist', 'One');
    const two = path.join(dir, 'Artist', 'Two');
    await fs.mkdir(one, { recursive: true });
    await fs.mkdir(two, { recursive: true });
    await fs.writeFile(path.join(one, '01.mp3'), 'x');
    await fs.writeFile(path.join(two, '01.mp3'), 'x');

    const scanner = await freshScanner(async (filePath) => ({
      artist: 'Artist',
      album: filePath.includes(`${path.sep}One${path.sep}`) ? 'One' : 'Two',
      title: 'Song',
      durationMs: 1000,
    }));
    await scanner.runScanOnce();
    assert.equal(repo.getStats(db).totalTracks, 2);

    // A file appears in One after the full scan; rescanning just that folder
    // should pick it up and leave Two alone.
    await fs.writeFile(path.join(one, '02.mp3'), 'x');
    const summary = await scanner.rescanDirs([one]);
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 0);
    assert.equal(repo.getStats(db).totalTracks, 3);
    assert.equal(repo.listTrackPaths(db, { album: 'Two' }).length, 1, 'Two is untouched');
  });
});

test('rescanDirs marks a deleted file removed, but only within its scope', async () => {
  await withMusicDir(async (dir, db) => {
    const repo = await import('../src/services/libraryRepo.js');
    const one = path.join(dir, 'Artist', 'One');
    const two = path.join(dir, 'Artist', 'Two');
    await fs.mkdir(one, { recursive: true });
    await fs.mkdir(two, { recursive: true });
    await fs.writeFile(path.join(one, '01.mp3'), 'x');
    await fs.writeFile(path.join(two, '01.mp3'), 'x');

    const scanner = await freshScanner(async (filePath) => ({
      artist: 'Artist',
      album: filePath.includes(`${path.sep}One${path.sep}`) ? 'One' : 'Two',
      title: 'Song',
      durationMs: 1000,
    }));
    await scanner.runScanOnce();

    // Delete a file from BOTH folders but rescan only One: One's row goes, and
    // Two's stays, because it wasn't in scope.
    await fs.rm(path.join(one, '01.mp3'));
    await fs.rm(path.join(two, '01.mp3'));
    const summary = await scanner.rescanDirs([one]);
    assert.equal(summary.removed, 1);
    assert.equal(repo.listTrackPaths(db, { album: 'One' }).length, 0);
    assert.equal(repo.listTrackPaths(db, { album: 'Two' }).length, 1, 'out of scope, so still indexed');
  });
});

test('rescanDirs refuses a directory outside MUSIC_DIR', async () => {
  await withMusicDir(async (dir) => {
    const scanner = await freshScanner(async () => ({}));
    await assert.rejects(
      () => scanner.rescanDirs([path.join(dir, '..', 'elsewhere')]),
      /outside the music folder/i,
    );
  });
});

// --- Hostile tag values, and the health counts that depend on the fallbacks ---

// The bug: rowFor fills album from the folder name and title from the filename
// when the tag is empty, so `album IS NULL` was never true for a scanned row and
// the Health tab's "No album tag"/"No title tag" counts read zero on every
// install. The old test for those counts inserted rows directly with
// `album: null` — a shape production cannot produce — so it stayed green while
// the feature did nothing. This one goes through the scanner.
test('a file with no album or title tag is counted as untagged, not as tagged-from-path', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.mkdir(path.join(dir, 'Band', 'Record'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Band', 'Record', '01 Song.mp3'), 'x');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'Band', album: null, title: null, durationMs: 1000, genre: null,
    }));
    await runScanOnce();

    const repo = await import('../src/services/libraryRepo.js');
    // The columns are still filled, because browse views need something to
    // group and label by...
    const [track] = repo.listTracks(db, {}).tracks;
    assert.equal(track.album, 'Record');
    assert.equal(track.title, '01 Song');
    // ...but the file itself carries neither, and Health says so.
    const health = repo.findHealthIssues(db);
    assert.equal(health.missingAlbum, 1);
    assert.equal(health.missingTitle, 1);
    assert.equal(track.albumSynthesized, 1);
    assert.equal(track.titleSynthesized, 1);
  });
});

test('a fully tagged file is not counted as missing an album or title', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'song.mp3'), 'x');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'A', album: 'Al', title: 'T', durationMs: 1000, genre: null,
    }));
    await runScanOnce();
    const repo = await import('../src/services/libraryRepo.js');
    const health = repo.findHealthIssues(db);
    assert.equal(health.missingAlbum, 0);
    assert.equal(health.missingTitle, 0);
  });
});

// A track number comes out of a binary frame in a file the user downloaded from
// a stranger. findIncompleteAlbums iterates 1..maxTrackNumber, so an absurd one
// was a RangeError on the endpoint the Library page opens with — reachable by
// dropping one crafted file into the library.
test('an absurd track number is discarded rather than indexed', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'song.mp3'), 'x');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'A', album: 'Al', title: 'T', durationMs: 1000, genre: null,
      trackNumber: 2000000000, disc: 999999, year: 1e9,
    }));
    await runScanOnce();

    const repo = await import('../src/services/libraryRepo.js');
    const [track] = repo.listTracks(db, {}).tracks;
    assert.equal(track.trackNumber, null);
    assert.equal(track.disc, null);
    assert.equal(track.year, null);
    // The endpoint that used to blow up now answers.
    assert.doesNotThrow(() => repo.findIncompleteAlbums(db));
  });
});

test('an in-range track number still survives the clamp', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'song.mp3'), 'x');
    const { runScanOnce } = await freshScanner(async () => ({
      artist: 'A', album: 'Al', title: 'T', durationMs: 1000, genre: null,
      trackNumber: 12, disc: 2, year: 1994,
    }));
    await runScanOnce();
    const repo = await import('../src/services/libraryRepo.js');
    const [track] = repo.listTracks(db, {}).tracks;
    assert.equal(track.trackNumber, 12);
    assert.equal(track.disc, 2);
    assert.equal(track.year, 1994);
  });
});
