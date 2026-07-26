import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
// Most tests in this file exercise the automatic AcoustID-matching path via
// mocked fpcalc/acoustid modules, so a key must be configured for those mocks
// to actually be reached; the "ACOUSTID_API_KEY unset" tests below flip
// config.acoustidApiKey off per-test (mirroring withIngestDir's mutate/restore).
process.env.ACOUSTID_API_KEY = 'test-acoustid-key';

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

async function withoutAcoustidKey(fn) {
  const original = configModule.config.acoustidApiKey;
  configModule.config.acoustidApiKey = null;
  try {
    await fn();
  } finally {
    configModule.config.acoustidApiKey = original;
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

// The Docker image sets INGEST_DIR=/data/ingest unconditionally, so a user who
// mounts nothing there has the feature enabled but the directory absent. Treat
// that as "nothing to ingest" rather than surfacing an ENOENT 500 on the page.
test('scanIngestDir reports no items when INGEST_DIR does not exist', async () => {
  const original = configModule.config.ingest.ingestDir;
  configModule.config.ingest.ingestDir = path.join(__dirname, '.tmp-ingest-does-not-exist');
  try {
    const { items } = await scanIngestDir();
    assert.deepEqual(items, []);
  } finally {
    configModule.config.ingest.ingestDir = original;
  }
});

test('processIngest tags a confirmed loose file, moves it into the library, and reports it matched', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
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
    assert.equal(result.matched[0].recordingMbid, '77777777-7777-4777-8777-777777777777');
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
        writeTags: async (filePath, desired) => {
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeTags: async () => ({ filledFields: [] }),
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
      exports: { lookup: async () => [{ recordingMbid: '88888888-8888-4888-8888-888888888888', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '88888888-8888-4888-8888-888888888888', title: 'Wrong Length Track', lengthMs: 400000, artist: 'A', releaseGroups: [], date: null,
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

// Without a key, identification falls back to services/tagMatch.js (unit-tested
// in tag-match.test.js); these tests cover the wiring: the fallback's verdict
// drives the same tag/move/report pipeline, and fpcalc/AcoustID stay untouched.
test('processIngest matches a loose file from its tags when ACOUSTID_API_KEY is unset', async (t) => {
  await withIngestDir(async (dir) => {
    await withoutAcoustidKey(async () => {
      await fs.writeFile(path.join(dir, 'unconfigured.mp3'), 'fake-audio');

      const fingerprintCalls = [];
      const lookupCalls = [];
      t.mock.module('../src/services/fpcalc.js', {
        exports: { fingerprint: async (...args) => { fingerprintCalls.push(args); return { durationSeconds: 1, fingerprint: 'x' }; } },
      });
      t.mock.module('../src/services/acoustid.js', {
        exports: { lookup: async (...args) => { lookupCalls.push(args); return []; } },
      });
      t.mock.module('../src/services/tagMatch.js', {
        exports: {
          identifyFileFromTags: async () => ({
            confirmed: {
              mbid: 'rec-tag', title: 'Tagged Title', lengthMs: 200000, artist: 'Tagged Artist',
              releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Tagged Album' }], date: '2019-01-01',
            },
            reason: null,
          }),
          albumCandidatesFromTags: async () => ({ reason: 'not exercised here' }),
          candidatesFromTags: async () => ({ candidates: [] }),
        },
      });
      t.mock.module('../src/services/tags.js', {
        exports: {
          readTags: async () => ({
            artist: 'Tagged Artist', title: 'Tagged Title', album: null, trackNumber: null,
            disc: null, year: null, genre: null, durationMs: 200000, hasCoverArt: false,
          }),
          writeTags: async () => ({ filledFields: ['album'] }),
        },
      });
      t.mock.module('../src/services/coverArt.js', { exports: { getFrontCoverImage: async () => null } });
      t.mock.module('../src/services/organize.js', {
        exports: {
          moveIntoLibrary: async () => ({ movedTo: '/music/Tagged Artist/Tagged Album/Tagged Title.mp3', duplicate: false }),
        },
      });

      const processIngestFresh = await freshProcessIngest();
      const result = await processIngestFresh();

      assert.equal(fingerprintCalls.length, 0, 'fpcalc should never be invoked without a key');
      assert.equal(lookupCalls.length, 0, 'AcoustID should never be called without a key');
      assert.equal(result.needsReview.length, 0);
      assert.equal(result.matched.length, 1);
      assert.equal(result.matched[0].recordingMbid, 'rec-tag');
      assert.equal(result.matched[0].movedTo, '/music/Tagged Artist/Tagged Album/Tagged Title.mp3');
    });
  });
});

test('a loose file the tag fallback cannot confirm still lands in needsReview', async (t) => {
  await withIngestDir(async (dir) => {
    await withoutAcoustidKey(async () => {
      await fs.writeFile(path.join(dir, 'untagged.mp3'), 'fake-audio');

      t.mock.module('../src/services/tagMatch.js', {
        exports: {
          identifyFileFromTags: async () => ({ confirmed: null, reason: 'no artist/title tags to match on' }),
          albumCandidatesFromTags: async () => ({ reason: 'not exercised here' }),
          candidatesFromTags: async () => ({ candidates: [] }),
        },
      });

      const processIngestFresh = await freshProcessIngest();
      const result = await processIngestFresh();

      assert.equal(result.matched.length, 0);
      assert.equal(result.needsReview.length, 1);
      assert.equal(result.needsReview[0].code, 'no_match');
      assert.match(result.needsReview[0].reason, /no artist\/title tags/i);
    });
  });
});

test('an album folder is matched from its tags when ACOUSTID_API_KEY is unset', async (t) => {
  await withIngestDir(async (dir) => {
    await withoutAcoustidKey(async () => {
      await fs.mkdir(path.join(dir, 'An Album'));
      await fs.writeFile(path.join(dir, 'An Album', 'b-side.flac'), 'fake-audio');
      await fs.writeFile(path.join(dir, 'An Album', 'a-side.flac'), 'fake-audio');

      const fingerprintCalls = [];
      t.mock.module('../src/services/fpcalc.js', {
        exports: { fingerprint: async (...args) => { fingerprintCalls.push(args); return { durationSeconds: 1, fingerprint: 'x' }; } },
      });
      t.mock.module('../src/services/acoustid.js', {
        exports: { lookup: async () => { throw new Error('AcoustID should not be called without a key'); } },
      });
      // Track-number tags put "b-side" first, ahead of filename order — the
      // matched files must follow the tracklist, not the directory listing.
      t.mock.module('../src/services/tagMatch.js', {
        exports: {
          identifyFileFromTags: async () => ({ confirmed: null, reason: 'not exercised here' }),
          albumCandidatesFromTags: async (files) => ({
            perFile: [
              { filePath: files.find((f) => f.endsWith('b-side.flac')), durationMs: 180000, recMbids: [] },
              { filePath: files.find((f) => f.endsWith('a-side.flac')), durationMs: 200000, recMbids: [] },
            ],
            releaseGroupMbids: ['11111111-1111-4111-8111-111111111111'],
          }),
          candidatesFromTags: async () => ({ candidates: [] }),
        },
      });
      t.mock.module('../src/services/musicbrainz.js', {
        exports: {
          getRecording: async () => { throw new Error('getRecording should not be needed on the tag path'); },
          resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
          getReleaseWithTracks: async () => ({
            release: { mbid: '55555555-5555-4555-8555-555555555555', title: 'An Album', artist: 'The Band', discCount: 1 },
            tracks: [
              { position: 1, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Opener', lengthMs: 180000 },
              { position: 2, discNumber: 1, recordingMbid: '88888888-8888-4888-8888-888888888888', title: 'Closer', lengthMs: 200000 },
            ],
          }),
        },
      });
      t.mock.module('../src/services/tags.js', {
        exports: {
          readTags: async () => ({
            artist: null, title: null, album: 'An Album', trackNumber: null,
            disc: null, year: null, genre: null, durationMs: 180000, hasCoverArt: false,
          }),
          writeTags: async () => ({ filledFields: ['title'] }),
        },
      });
      t.mock.module('../src/services/coverArt.js', { exports: { getFrontCoverImage: async () => null } });
      const moved = [];
      t.mock.module('../src/services/organize.js', {
        exports: {
          moveIntoLibrary: async (srcPath, meta) => {
            moved.push({ srcPath, meta });
            return { movedTo: `/music/The Band/An Album/${meta.title}.flac`, duplicate: false };
          },
        },
      });

      const processIngestFresh = await freshProcessIngest();
      const result = await processIngestFresh();

      assert.equal(fingerprintCalls.length, 0, 'fpcalc should never be invoked without a key');
      assert.equal(result.needsReview.length, 0);
      assert.equal(result.matched.length, 2);
      assert.match(moved[0].srcPath, /b-side\.flac$/);
      assert.equal(moved[0].meta.title, 'Opener');
      assert.match(moved[1].srcPath, /a-side\.flac$/);
      assert.equal(moved[1].meta.title, 'Closer');
    });
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
          fp === 'FP1' ? [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] : [{ recordingMbid: '88888888-8888-4888-8888-888888888888', score: 0.9 }],
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
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'An Album' }], date: '2005-01-01',
        }),
        resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
        getReleaseWithTracks: async () => ({
          release: { mbid: '55555555-5555-4555-8555-555555555555', title: 'An Album', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Opener', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: '88888888-8888-4888-8888-888888888888', title: 'Closer', lengthMs: 200000 },
          ],
        }),
      },
    });
    const written = [];
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({}),
        writeTags: async (filePath, desired) => {
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
          releaseGroups: [{ mbid: '44444444-4444-4444-8444-444444444444', title: 'Double' }], date: '2005-01-01',
        }),
        resolvePrimaryReleaseForGroup: async () => '66666666-6666-4666-8666-666666666666',
        getReleaseWithTracks: async () => ({
          release: { mbid: '66666666-6666-4666-8666-666666666666', title: 'Double', artist: 'The Band', discCount: 2 },
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
        writeTags: async (filePath, desired) => {
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    let moveCalled = false;
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'x', lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: 'rg-3', title: 'Messy' }], date: null,
        }),
        resolvePrimaryReleaseForGroup: async () => 'release-3',
        // Release has 3 tracks but the folder has only 2 → incoherent.
        getReleaseWithTracks: async () => ({
          release: { mbid: 'release-3', title: 'Messy', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'A', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: '88888888-8888-4888-8888-888888888888', title: 'B', lengthMs: 180000 },
            { position: 3, discNumber: 1, recordingMbid: '99999999-9999-4999-8999-999999999999', title: 'C', lengthMs: 180000 },
          ],
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: { readTags: async () => ({}), writeTags: async () => ({ filledFields: [] }) },
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'Preview Title', lengthMs: 200000, artist: 'Preview Artist',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Preview Album' }], date: '2020-01-01',
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
        writeTags: async () => {
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'x', lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Album' }], date: null,
        }),
        resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
        getReleaseWithTracks: async () => ({
          release: { mbid: '55555555-5555-4555-8555-555555555555', title: 'Album', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 1, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'One', lengthMs: 180000 },
            { position: 2, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Two', lengthMs: 180000 },
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
        writeTags: async () => {
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'T', lengthMs: 200000, artist: 'A',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Alb' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        plannedFills: () => [],
        writeTags: async () => ({ filledFields: ['artist'] }),
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
      exports: { lookup: async () => [{ recordingMbid: '77777777-7777-4777-8777-777777777777', score: 0.9 }] },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        // Stubs so ingest.js can link all three named imports; tests that
        // exercise the album path override these with real values below.
        resolvePrimaryReleaseForGroup: async () => null,
        getReleaseWithTracks: async () => ({ release: {}, tracks: [] }),
        getRecording: async () => ({
          mbid: '77777777-7777-4777-8777-777777777777', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
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

// The mapping from an AcoustID lookup to picker rows lives in
// fingerprintMatch.js and is covered by fingerprintMatch.test.js. What ingest
// still owns is the choice of source and the path validation, so that's what
// these two pin down. (Mocking fpcalc/acoustid here would no longer reach the
// extracted module: freshIngestExports only busts ingest.js's own cache, so
// anything it statically imports keeps the dependencies it first resolved.)
test('findCandidatesForFile asks the fingerprint matcher when an AcoustID key is configured', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    let fingerprintedPath = null;
    t.mock.module('../src/services/fingerprintMatch.js', {
      exports: {
        candidatesFromFingerprint: async (p) => {
          fingerprintedPath = p;
          return { candidates: [{ recordingMbid: 'rec-hi', score: 0.4 }] };
        },
      },
    });

    const { findCandidatesForFile } = await freshIngestExports();
    const result = await findCandidatesForFile(filePath);

    assert.equal(fingerprintedPath, await fs.realpath(filePath), 'the resolved path is what gets fingerprinted');
    assert.deepEqual(result.candidates, [{ recordingMbid: 'rec-hi', score: 0.4 }]);
  });
});

test('findCandidatesForFile falls back to the tag matcher with no AcoustID key', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/fingerprintMatch.js', {
      exports: {
        candidatesFromFingerprint: async () => assert.fail('no key means no fingerprinting'),
      },
    });
    t.mock.module('../src/services/tagMatch.js', {
      exports: { candidatesFromTags: async () => ({ candidates: [{ recordingMbid: 'from-tags', score: 0.9 }] }) },
    });

    const { findCandidatesForFile } = await freshIngestExports();
    await withoutAcoustidKey(async () => {
      const result = await findCandidatesForFile(filePath);
      assert.deepEqual(result.candidates, [{ recordingMbid: 'from-tags', score: 0.9 }]);
    });
  });
});

test('findCandidatesForFile falls back to tag-derived candidates when ACOUSTID_API_KEY is unset', async (t) => {
  await withIngestDir(async (dir) => {
    await withoutAcoustidKey(async () => {
      const filePath = path.join(dir, 'unconfigured.mp3');
      await fs.writeFile(filePath, 'fake-audio');

      const fingerprintCalls = [];
      t.mock.module('../src/services/fpcalc.js', {
        exports: { fingerprint: async (...args) => { fingerprintCalls.push(args); return { durationSeconds: 1, fingerprint: 'x' }; } },
      });
      t.mock.module('../src/services/acoustid.js', {
        exports: { lookup: async () => { throw new Error('AcoustID should not be called without a key'); } },
      });
      t.mock.module('../src/services/tagMatch.js', {
        exports: {
          identifyFileFromTags: async () => ({ confirmed: null, reason: 'not exercised here' }),
          albumCandidatesFromTags: async () => ({ reason: 'not exercised here' }),
          candidatesFromTags: async () => ({
            candidates: [{ recordingMbid: 'rec-tag', title: 'From Tags', artist: 'A', lengthMs: 200000, score: 0.99, releaseGroupTitle: 'An Album' }],
          }),
        },
      });

      const { findCandidatesForFile } = await freshIngestExports();
      const result = await findCandidatesForFile(filePath);

      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].recordingMbid, 'rec-tag');
      assert.equal(fingerprintCalls.length, 0, 'fpcalc should never be invoked without a key');
    });
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
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Chosen Album' }],
          date: '2021-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
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
      () => resolveLooseFileOverride({ filePath: '/etc/passwd', name: 'x', recordingMbid: '77777777-7777-4777-8777-777777777777', dryRun: false }),
      (err) => err instanceof BadRequestError
    );
  });
});

test('resolveLooseFileOverride rejects a symlink inside INGEST_DIR that targets an outside file', async (t) => {
  await withIngestDir(async (dir) => {
    // A link whose *name* is inside INGEST_DIR but whose target escapes it.
    const outside = path.join(__dirname, '.tmp-outside-secret');
    await fs.writeFile(outside, 'secret');
    const link = path.join(dir, 'sneaky.mp3');
    await fs.symlink(outside, link);

    const { resolveLooseFileOverride } = await freshIngestExports();
    const { BadRequestError } = await import('../src/lib/httpErrors.js');
    await assert.rejects(
      () => resolveLooseFileOverride({ filePath: link, name: 'sneaky.mp3', recordingMbid: '77777777-7777-4777-8777-777777777777', dryRun: false }),
      (err) => err instanceof BadRequestError,
      'a symlink escaping INGEST_DIR must be refused before any tag/move work',
    );
    await fs.rm(outside, { force: true });
  });
});

test('scanIngestDir ignores a symlinked audio file', async (t) => {
  await withIngestDir(async (dir) => {
    const outside = path.join(__dirname, '.tmp-outside-audio.mp3');
    await fs.writeFile(outside, 'audio');
    await fs.symlink(outside, path.join(dir, 'linked.mp3'));
    await fs.writeFile(path.join(dir, 'real.mp3'), 'audio');

    const { scanIngestDir } = await freshIngestExports();
    const { items } = await scanIngestDir();
    assert.deepEqual(items.map((i) => i.name), ['real.mp3'], 'only the real file, not the symlink');
    await fs.rm(outside, { force: true });
  });
});

test('an album folder is track-ordered by natural sort, not lexicographically', async (t) => {
  await withIngestDir(async (dir) => {
    // Lexicographic sort would order these ["10 - a", "2 - b"]; natural sort
    // (and the release tracklist) puts track 2 before track 10.
    await fs.mkdir(path.join(dir, 'Numbered'));
    await fs.writeFile(path.join(dir, 'Numbered', '10 - a.mp3'), 'audio');
    await fs.writeFile(path.join(dir, 'Numbered', '2 - b.mp3'), 'audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: {
        fingerprint: async (filePath) =>
          filePath.endsWith('2 - b.mp3')
            ? { durationSeconds: 180, fingerprint: 'FP-b' }
            : { durationSeconds: 200, fingerprint: 'FP-a' },
      },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: {
        lookup: async ({ fingerprint: fp }) =>
          fp === 'FP-b' ? [{ recordingMbid: 'rec-b', score: 0.9 }] : [{ recordingMbid: 'rec-a', score: 0.9 }],
      },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        getRecording: async (mbid) => ({
          mbid, title: mbid, lengthMs: 0, artist: 'The Band',
          releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Numbered' }], date: '2005-01-01',
        }),
        resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
        getReleaseWithTracks: async () => ({
          release: { mbid: '55555555-5555-4555-8555-555555555555', title: 'Numbered', artist: 'The Band', discCount: 1 },
          tracks: [
            { position: 2, discNumber: 1, recordingMbid: 'rec-b', title: 'Bee', lengthMs: 180000 },
            { position: 10, discNumber: 1, recordingMbid: 'rec-a', title: 'Ay', lengthMs: 200000 },
          ],
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: { readTags: async () => ({}), writeTags: async () => ({ filledFields: [] }) },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });
    const moves = [];
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async (srcPath, meta) => {
          moves.push({ title: meta.title, track: meta.trackNumber });
          return { movedTo: `/music/${meta.trackNumber}`, duplicate: false };
        },
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 2, 'the folder is coherent only when files are naturally sorted');
    assert.deepEqual(moves.map((m) => m.title), ['Bee', 'Ay']);
    assert.deepEqual(moves.map((m) => m.track), [2, 10]);
  });
});

// Multi-disc rips are normally laid out as "Album/CD1", "Album/Disc 2" and so on.
// Only the top level of an album folder was read, so those folders looked empty
// and never appeared for ingest at all.
test('an album folder with disc subfolders is found, and its files are ordered across discs', async (t) => {
  await withIngestDir(async (dir) => {
    const album = path.join(dir, 'Big Album');
    await fs.mkdir(path.join(album, 'CD1'), { recursive: true });
    await fs.mkdir(path.join(album, 'CD2'), { recursive: true });
    await fs.writeFile(path.join(album, 'CD1', '1 - a.mp3'), 'fake-audio');
    await fs.writeFile(path.join(album, 'CD1', '10 - b.mp3'), 'fake-audio');
    await fs.writeFile(path.join(album, 'CD1', '2 - c.mp3'), 'fake-audio');
    await fs.writeFile(path.join(album, 'CD2', '1 - d.mp3'), 'fake-audio');

    const { items } = await scanIngestDir();
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'album');
    assert.equal(items[0].trackCount, 4, 'every disc counts toward the folder');

    // The order the coherence check depends on: disc, then natural filename order
    // within it (so "10 - b" follows "2 - c", not "1 - a").
    const seen = [];
    t.mock.module('../src/services/fpcalc.js', {
      exports: {
        fingerprint: async (f) => { seen.push(path.relative(album, f)); return { durationSeconds: 1, fingerprint: 'x' }; },
      },
    });
    t.mock.module('../src/services/acoustid.js', { exports: { lookup: async () => [] } });
    const processIngestFresh = await freshProcessIngest();
    await processIngestFresh({ dryRun: true });

    assert.deepEqual(seen, [
      path.join('CD1', '1 - a.mp3'),
      path.join('CD1', '2 - c.mp3'),
      path.join('CD1', '10 - b.mp3'),
      path.join('CD2', '1 - d.mp3'),
    ]);
  });
});

// Two ingest runs at once walk the same folder and reach the same file: two
// taglib writers racing on one save() and two moves racing on one rename. A
// double-clicked button or an EventSource retry was enough to cause it.
test('a second concurrent ingest run is refused rather than racing the first', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => { await gate; return { durationSeconds: 1, fingerprint: 'x' }; } },
    });
    t.mock.module('../src/services/acoustid.js', { exports: { lookup: async () => [] } });

    const mod = await freshIngestExports();
    const first = mod.processIngest({ dryRun: true });
    assert.equal(mod.ingestInProgress(), true);
    assert.throws(() => mod.processIngest({ dryRun: true }), /already in progress/);

    release();
    await first;
    // Once it has finished, a new run is allowed again.
    assert.equal(mod.ingestInProgress(), false);
    await mod.processIngest({ dryRun: true });
  });
});
