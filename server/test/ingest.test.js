import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const configModule = await import('../src/config.js');
const { scanIngestDir, processIngest } = await import('../src/services/ingest.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withIngestDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
  const original = configModule.config.ingest.ingestDir;
  configModule.config.ingest.ingestDir = dir;
  try {
    await fn(dir);
  } finally {
    configModule.config.ingest.ingestDir = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// `services/ingest.js` imports its five leaf services (fpcalc, acoustid,
// musicbrainz, tags, coverArt) as plain named ES module exports. Real ESM
// module-namespace bindings are non-configurable, so `t.mock.method` on an
// `await import(...)`-ed module object (the technique used elsewhere in this
// repo for the `child_process` *builtin*, whose namespace Node deliberately
// keeps configurable) cannot redefine them — confirmed empirically: it throws
// `TypeError: Cannot redefine property`. The supported way to mock a real,
// user-authored ESM module's exports is `t.mock.module(specifier, { exports })`,
// which works by intercepting *future* resolutions of that specifier — so the
// consuming module (`ingest.js`) must be (re-)imported *after* the mock is
// registered. We do that with a cache-busting query string per test so each
// test gets its own freshly-linked copy of `ingest.js` wired to that test's
// mocks, while `config.js` (imported without a cache-busting suffix) stays the
// same singleton `withIngestDir` mutates. Requires the
// `--experimental-test-module-mocks` CLI flag (see package.json's test script).
let importCounter = 0;
async function freshProcessIngest() {
  importCounter += 1;
  const mod = await import(`../src/services/ingest.js?fresh=${importCounter}`);
  return mod.processIngest;
}

async function freshIngestExports() {
  importCounter += 1;
  return import(`../src/services/ingest.js?fresh=${importCounter}`);
}

test('scanIngestDir distinguishes loose files from album folders and ignores junk', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'loose-track.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, '.DS_Store'), 'junk');
    await fs.mkdir(path.join(dir, 'Some Album'));
    await fs.writeFile(path.join(dir, 'Some Album', 'track1.flac'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Some Album', 'track2.flac'), 'fake-audio');

    const { items } = await scanIngestDir();
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(items.length, 2, 'junk file should be ignored');
    assert.equal(byName['loose-track.mp3'].type, 'file');
    assert.equal(byName['Some Album'].type, 'album');
    assert.equal(byName['Some Album'].trackCount, 2);
  });
});

test('processIngest tags a confirmed loose file, moves it into the library, and reports it matched', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    let moveArgs;
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async (srcPath, meta, ext) => {
          moveArgs = { srcPath, meta, ext };
          return { movedTo: '/music/Track Artist/Track Album/Track Title.mp3', duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].recordingMbid, 'rec-1');
    assert.equal(result.matched[0].movedTo, '/music/Track Artist/Track Album/Track Title.mp3');
    assert.equal(result.needsReview.length, 0);
    assert.equal(moveArgs.meta.album, 'Track Album');
    assert.equal(moveArgs.ext, '.mp3');
  });
});

test('a confirmed loose file with no release group is filed under Singles with no album tag', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'single.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-s', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-s', title: 'Lonely Single', lengthMs: 200000, artist: 'Solo Artist',
          releaseGroups: [], date: '2019-01-01',
        }),
      },
    });
    let writtenDesired;
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async (filePath, desired) => {
          writtenDesired = desired;
          return { filledFields: ['artist', 'title'] };
        },
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    let moveMeta;
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async (srcPath, meta) => {
          moveMeta = meta;
          return { movedTo: '/music/Solo Artist/Singles/Lonely Single.mp3', duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 1);
    assert.equal(moveMeta.album, 'Singles', 'a track with no release group is filed under Singles');
    assert.equal(writtenDesired.album, null, 'the album tag itself must stay empty, not "Singles"');
  });
});

test('a confirmed loose file whose move fails is reported as tagged-but-not-moved', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: 'rg-1', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async () => {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /tagged in place, but could not be moved/i);
    assert.equal(result.needsReview[0].code, 'move_failed');
  });
});

test('a byte-identical duplicate is left in place and reported as needsReview', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'dup.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: 'rg-1', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: [] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: { moveIntoLibrary: async () => ({ movedTo: null, duplicate: true }) },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /identical file already exists/i);
    assert.equal(result.needsReview[0].code, 'duplicate');
  });
});

test('processIngest reports needsReview when AcoustID finds no candidates', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'unknown.mp3'), 'fake-audio');
    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [] },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /no.*candidate/i);
    assert.equal(result.needsReview[0].code, 'no_match');
  });
});

test('processIngest reports needsReview when no AcoustID candidate meets the confidence threshold', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'low-confidence.mp3'), 'fake-audio');
    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-low', score: 0.2 }] },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /confidence|threshold/i);
    assert.equal(result.needsReview[0].code, 'no_match');
  });
});

test('processIngest reports needsReview when duration/score confirmation fails', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'mismatch.mp3'), 'fake-audio');
    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 100, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-2', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-2', title: 'Wrong Length Track', lengthMs: 400000, artist: 'A', releaseGroups: [], date: null,
        }),
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.equal(result.needsReview[0].code, 'no_match');
  });
});

test('a coherent single-disc album folder tags and moves every track', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'An Album'));
    await fs.writeFile(path.join(dir, 'An Album', '1.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'An Album', '2.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: {
        fingerprint: async (filePath) =>
          filePath.endsWith('1.mp3')
            ? { durationSeconds: 180, fingerprint: 'FP1' }
            : { durationSeconds: 200, fingerprint: 'FP2' },
      },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: {
        lookup: async ({ fingerprint: fp }) =>
          fp === 'FP1' ? [{ recordingMbid: 'rec-1', score: 0.9 }] : [{ recordingMbid: 'rec-2', score: 0.9 }],
      },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async (mbid) => ({
          mbid, title: mbid, lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: 'rg-1', title: 'An Album' }], date: '2005-01-01',
        }),
        resolvePrimaryReleaseForGroup: async () => 'release-1',
        getReleaseWithTracks: async () => ({
          release: { mbid: 'release-1', title: 'An Album', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'Opener', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: 'rec-2', title: 'Closer', lengthMs: 200000 },
          ],
        }),
      },
    });
    const written = [];
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({}),
        writeMissingTags: async (filePath, desired) => {
          written.push(desired);
          return { filledFields: ['artist', 'title', 'album', 'trackNumber'] };
        },
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => ({ bytes: Buffer.from([1]), mimeType: 'image/jpeg' }) },
    });
    const moves = [];
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async (srcPath, meta, ext) => {
          moves.push(meta);
          return { movedTo: `/music/${meta.artist}/${meta.album}/${meta.trackNumber}${ext}`, duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 2);
    assert.equal(result.needsReview.length, 0);
    // Single-disc release: no disc number written or passed to the mover.
    assert.equal(written[0].disc, null);
    assert.equal(moves[0].discNumber, null);
    assert.deepEqual(moves.map((m) => m.trackNumber), [1, 2]);
    assert.deepEqual(moves.map((m) => m.title), ['Opener', 'Closer']);
  });
});

test('a coherent two-disc album folder writes disc numbers and disc-aware move metadata', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'Double'));
    await fs.writeFile(path.join(dir, 'Double', 'a.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Double', 'b.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Double', 'c.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 180, fingerprint: 'FP' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-x', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-x', title: 'x', lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: 'rg-2', title: 'Double' }], date: '2005-01-01',
        }),
        resolvePrimaryReleaseForGroup: async () => 'release-2',
        getReleaseWithTracks: async () => ({
          release: { mbid: 'release-2', title: 'Double', artist: 'The Band', discCount: 2 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: null, title: 'D1T1', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: null, title: 'D1T2', lengthMs: 180000 },
            { position: 1, discNumber: 2, recordingMbid: null, title: 'D2T1', lengthMs: 180000 },
          ],
        }),
      },
    });
    const written = [];
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({}),
        writeMissingTags: async (filePath, desired) => {
          written.push(desired);
          return { filledFields: ['artist', 'title', 'album', 'trackNumber', 'disc'] };
        },
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    const moves = [];
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async (srcPath, meta) => {
          moves.push(meta);
          return { movedTo: `/music/${meta.discNumber}-${meta.trackNumber}`, duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 3);
    assert.deepEqual(written.map((w) => w.disc), [1, 1, 2]);
    assert.deepEqual(moves.map((m) => ({ disc: m.discNumber, track: m.trackNumber })), [
      { disc: 1, track: 1 },
      { disc: 1, track: 2 },
      { disc: 2, track: 1 },
    ]);
  });
});

test('an incoherent album folder (track count mismatch) is left untouched and reported as needsReview', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'Messy'));
    await fs.writeFile(path.join(dir, 'Messy', '1.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Messy', '2.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 180, fingerprint: 'FP' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    let moveCalled = false;
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'x', lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: 'rg-3', title: 'Messy' }], date: null,
        }),
        resolvePrimaryReleaseForGroup: async () => 'release-3',
        // Release has 3 tracks but the folder has only 2 → incoherent.
        getReleaseWithTracks: async () => ({
          release: { mbid: 'release-3', title: 'Messy', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'A', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: 'rec-2', title: 'B', lengthMs: 180000 },
            { position: 3, discNumber: 1, recordingMbid: 'rec-3', title: 'C', lengthMs: 180000 },
          ],
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: { readTags: async () => ({}), writeMissingTags: async () => ({ filledFields: [] }) },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async () => {
          moveCalled = true;
          return { movedTo: '/music/x', duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.equal(result.needsReview[0].name, 'Messy');
    assert.match(result.needsReview[0].reason, /coherently matched/i);
    assert.equal(result.needsReview[0].code, 'album_incoherent');
    assert.equal(moveCalled, false, 'nothing in an incoherent folder should be moved');
  });
});

test('a dry-run previews planned tags and target path without writing or moving a loose file', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'Preview Title', lengthMs: 200000, artist: 'Preview Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Preview Album' }], date: '2020-01-01',
        }),
      },
    });
    let wrote = false;
    let moved = false;
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        plannedFills: (current, desired) => Object.keys(desired).filter((k) => desired[k] != null && current[k] == null),
        writeMissingTags: async () => {
          wrote = true;
          return { filledFields: [] };
        },
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: {
        targetPathFor: (meta, ext) => `/music/${meta.artist}/${meta.album}/${meta.title}${ext}`,
        moveIntoLibrary: async () => {
          moved = true;
          return { movedTo: '/nope', duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh({ dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].movedTo, '/music/Preview Artist/Preview Album/Preview Title.mp3');
    assert.deepEqual(new Set(result.matched[0].filledFields), new Set(['artist', 'title', 'album', 'year']));
    assert.equal(wrote, false, 'a dry-run must not write tags');
    assert.equal(moved, false, 'a dry-run must not move files');
  });
});

test('a dry-run previews an album without writing or moving any track', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'Album'));
    await fs.writeFile(path.join(dir, 'Album', '1.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Album', '2.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 180, fingerprint: 'FP' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        getRecording: async () => ({
          mbid: 'rec-1', title: 'x', lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: 'rg-1', title: 'Album' }], date: null,
        }),
        resolvePrimaryReleaseForGroup: async () => 'release-1',
        getReleaseWithTracks: async () => ({
          release: { mbid: 'release-1', title: 'Album', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: 'rec-1', title: 'One', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: 'rec-1', title: 'Two', lengthMs: 180000 },
          ],
        }),
      },
    });
    let wrote = false;
    let moved = false;
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        plannedFills: (current, desired) => Object.keys(desired).filter((k) => desired[k] != null && current[k] == null),
        writeMissingTags: async () => {
          wrote = true;
          return { filledFields: [] };
        },
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: {
        targetPathFor: (meta, ext) => `/music/${meta.artist}/${meta.album}/${meta.trackNumber} - ${meta.title}${ext}`,
        moveIntoLibrary: async () => {
          moved = true;
          return { movedTo: '/nope', duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh({ dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.matched.length, 2);
    assert.equal(result.matched[0].movedTo, '/music/The Band/Album/1 - One.mp3');
    assert.equal(wrote, false, 'a dry-run must not write album tags');
    assert.equal(moved, false, 'a dry-run must not move album tracks');
  });
});

test('processIngest calls onItem once per completed item, in order', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'b.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'FP' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: 'rg-1', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        plannedFills: () => [],
        writeMissingTags: async () => ({ filledFields: ['artist'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: {
        targetPathFor: () => '/music/x',
        moveIntoLibrary: async (srcPath) => ({ movedTo: `/music/${path.basename(srcPath)}`, duplicate: false }),
      },
    });

    const events = [];
    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh({ onItem: (e) => events.push(e) });

    assert.deepEqual(events.map((e) => e.kind), ['matched', 'matched']);
    assert.deepEqual(events.map((e) => e.name), ['a.mp3', 'b.mp3']);
    assert.equal(result.matched.length, 2);
  });
});

test('a non-rate-limit error on one item is caught, reported as needsReview, and the batch continues', async (t) => {
  await withIngestDir(async (dir) => {
    // 'a-track.mp3' sorts before 'b-track.mp3', so a-track fails first and we
    // can prove the loop continued on to b-track rather than aborting.
    await fs.writeFile(path.join(dir, 'a-track.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'b-track.mp3'), 'fake-audio');
    const { UpstreamUnavailableError } = await import('../src/lib/httpErrors.js');

    t.mock.module('../src/services/fpcalc.js', {
      exports: {
        fingerprint: async (filePath) => {
          if (filePath.endsWith('a-track.mp3')) {
            throw new UpstreamUnavailableError('fpcalc could not process this file');
          }
          return { durationSeconds: 200, fingerprint: 'AQAB...' };
        },
      },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: 'rec-1', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: 'rec-1', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    t.mock.module('../src/services/organize.js', {
      exports: { moveIntoLibrary: async () => ({ movedTo: '/music/b.mp3', duplicate: false }) },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();

    assert.equal(result.error, undefined, 'a per-item error must not surface as a batch-level error');
    assert.equal(result.needsReview.length, 1, 'the failing file should be reported as needsReview');
    assert.equal(result.needsReview[0].name, 'a-track.mp3');
    assert.match(result.needsReview[0].reason, /fpcalc could not process this file/);
    assert.equal(result.matched.length, 1, 'the second file should still have been processed (loop continued)');
    assert.equal(result.matched[0].name, 'b-track.mp3');
  });
});

test('a RateLimitedError mid-run stops processing and returns partial results plus error', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a-track.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'b-track.mp3'), 'fake-audio');
    const { RateLimitedError } = await import('../src/lib/httpErrors.js');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: {
        lookup: async () => {
          throw new RateLimitedError('rate limited');
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 0);
    assert.equal(result.error.code, 'RATE_LIMITED');
  });
});

test('findCandidatesForFile returns every AcoustID candidate with recording details, sorted by score', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: {
        lookup: async () => [
          { recordingMbid: 'rec-hi', score: 0.4 },
          { recordingMbid: 'rec-lo', score: 0.1 },
        ],
      },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async (mbid) => ({
          mbid,
          title: mbid === 'rec-hi' ? 'High Score Track' : 'Low Score Track',
          lengthMs: 200000,
          artist: 'Some Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Some Album' }],
          date: '2020-01-01',
        }),
      },
    });

    const { findCandidatesForFile } = await freshIngestExports();
    const result = await findCandidatesForFile(filePath);

    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].recordingMbid, 'rec-hi');
    assert.equal(result.candidates[0].score, 0.4);
    assert.equal(result.candidates[0].title, 'High Score Track');
    assert.equal(result.candidates[0].releaseGroupTitle, 'Some Album');
    assert.equal(result.candidates[1].recordingMbid, 'rec-lo');
  });
});

test('findCandidatesForFile returns an empty list when AcoustID finds nothing', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'unknown.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', { exports: { lookup: async () => [] } });

    const { findCandidatesForFile } = await freshIngestExports();
    const result = await findCandidatesForFile(filePath);

    assert.deepEqual(result.candidates, []);
  });
});

test('findCandidatesForFile rejects a path outside INGEST_DIR', async (t) => {
  await withIngestDir(async (dir) => {
    const { findCandidatesForFile } = await freshIngestExports();
    const { BadRequestError } = await import('../src/lib/httpErrors.js');
    await assert.rejects(
      () => findCandidatesForFile('/etc/passwd'),
      (err) => err instanceof BadRequestError
    );
  });
});

test('resolveLooseFileOverride tags and moves the file using the chosen recording', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async (mbid) => ({
          mbid,
          title: 'Chosen Title',
          lengthMs: 200000,
          artist: 'Chosen Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Chosen Album' }],
          date: '2021-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', { exports: { getFrontCoverImage: async () => null } });
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async () => ({ movedTo: '/music/Chosen Artist/Chosen Album/Chosen Title.mp3', duplicate: false }),
      },
    });

    const { resolveLooseFileOverride } = await freshIngestExports();
    const result = await resolveLooseFileOverride({ filePath, name: 'track.mp3', recordingMbid: 'rec-chosen', dryRun: false });

    assert.equal(result.matched.recordingMbid, 'rec-chosen');
    assert.equal(result.matched.title, 'Chosen Title');
    assert.equal(result.matched.movedTo, '/music/Chosen Artist/Chosen Album/Chosen Title.mp3');
  });
});

test('resolveLooseFileOverride rejects a path outside INGEST_DIR', async (t) => {
  await withIngestDir(async () => {
    const { resolveLooseFileOverride } = await freshIngestExports();
    const { BadRequestError } = await import('../src/lib/httpErrors.js');
    await assert.rejects(
      () => resolveLooseFileOverride({ filePath: '/etc/passwd', name: 'x', recordingMbid: 'rec-1', dryRun: false }),
      (err) => err instanceof BadRequestError
    );
  });
});
