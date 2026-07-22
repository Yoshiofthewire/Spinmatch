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

test('processIngest moves nothing yet for a confirmed loose file, tags it, and reports it matched', async (t) => {
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
        getRecording: async () => ({
          mbid: 'rec-1', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].recordingMbid, 'rec-1');
    assert.equal(result.needsReview.length, 0);
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
        getRecording: async () => ({
          mbid: 'rec-2', title: 'Wrong Length Track', lengthMs: 400000, artist: 'A', releaseGroups: [], date: null,
        }),
      },
    });

    const processIngestFresh = await freshProcessIngest();
    const result = await processIngestFresh();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
  });
});

test('a directory entry is reported as needsReview with an "album folders not yet supported" reason', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'An Album'));
    await fs.writeFile(path.join(dir, 'An Album', 'track1.mp3'), 'fake-audio');

    const result = await processIngest();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /album folders/i);
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
        getRecording: async () => ({
          mbid: 'rec-1', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Track Album' }], date: '2020-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', {
      exports: { getFrontCoverImage: async () => null },
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
