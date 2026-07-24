import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { openDb, setDbForTest } = await import('../src/lib/db.js');
const configModule = await import('../src/config.js');

// scanLibrary reads real tags via node-taglib-sharp; mock it so the test can use
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

test('scanLibrary indexes audio files with their tags and ignores non-audio', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.mkdir(path.join(dir, 'Artist', 'Album'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Artist', 'Album', '01.mp3'), 'x');
    await fs.writeFile(path.join(dir, 'Artist', 'Album', 'cover.jpg'), 'x');
    const { scanLibrary } = await freshScanner(async () => ({
      artist: 'Artist', album: 'Album', title: 'Song One', /* other fields */ genre: null,
    }));
    const summary = await scanLibrary();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    assert.equal(repo.hasRecording(db, { artist: 'Artist', title: 'Song One' }), true);
  });
});

test('a second scan with no changes re-reads no tags (all skipped)', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'x');
    let reads = 0;
    const read = async () => { reads += 1; return { artist: 'A', album: 'B', title: 'T' }; };
    const { scanLibrary } = await freshScanner(read);
    await scanLibrary();
    assert.equal(reads, 1);
    await scanLibrary(); // unchanged file -> skipped, no re-read
    assert.equal(reads, 1);
  });
});

test('a deleted file is marked removed on the next scan', async () => {
  await withMusicDir(async (dir, db) => {
    const p = path.join(dir, 'track.mp3');
    await fs.writeFile(p, 'x');
    const { scanLibrary } = await freshScanner(async () => ({ artist: 'A', album: 'B', title: 'T' }));
    await scanLibrary();
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    await fs.rm(p);
    await scanLibrary();
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
    const { scanLibrary } = await freshScanner(read);
    const summary = await scanLibrary();
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
  });
});
