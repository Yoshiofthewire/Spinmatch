// The tag-repair path. The behaviour worth pinning down is that it repairs in
// place: it must fill only the empty fields, must never move or rename the file,
// and must refresh the index afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
// The fingerprint path is only offered when a key is configured; the
// "unconfigured" test flips this off on the config singleton per-test.
process.env.ACOUSTID_API_KEY = 'test-acoustid-key';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-fix-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const configModule = await import('../src/config.js');

const RECORDING = {
  mbid: '77777777-7777-4777-8777-777777777777',
  title: 'Idioteque',
  artist: 'Radiohead',
  lengthMs: 300_000,
  releaseGroups: [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'Kid A' }],
  date: '2000-10-02',
};

// Tracks what the fix flow asked to be written, so the "only empty fields" and
// "never moves the file" contracts can be asserted without a real audio file.
let written;
let counter = 0;
// Every query candidatesFromTags sent upstream, so the path-derived fallback can
// be asserted on what was actually searched for.
let searched = [];
// Every file handed to the fingerprint matcher, so "the audio is only read when
// asked for" can be asserted.
let fingerprinted = [];

async function freshFix({ current, recording = RECORDING, coverImage = null, fingerprintCandidates = [] } = {}) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();

  mock.module('../src/services/musicbrainz.js', {
    namedExports: {
      getRecording: async () => recording,
      resolvePrimaryReleaseForGroup: async () => '55555555-5555-4555-8555-555555555555',
      getReleaseWithTracks: async () => ({
        release: { mbid: '55555555-5555-4555-8555-555555555555', title: 'Kid A', artist: 'Radiohead' },
        tracks: [{ position: 7, discNumber: 1, recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Idioteque', lengthMs: 300_000 }],
      }),
      searchRecordings: async (query) => { searched.push(query); return []; },
      searchArtists: async () => [],
      searchReleaseGroups: async () => [],
      searchAll: async () => ({}),
      getArtist: async () => ({}),
      browseReleaseGroupsByArtist: async () => ({ artist: {}, albums: [] }),
    },
  });

  mock.module('../src/services/tags.js', {
    namedExports: {
      readTags: async () => ({ ...current, hasCoverArt: false }),
      readCoverArt: async () => null,
      // Mirrors the real writeMissingTags contract: fills what's empty, or with
      // overwrite, whatever disagrees with what's wanted.
      writeMissingTags: async (filePath, desired, opts) => {
        const filledFields = Object.keys(desired).filter((k) => (
          desired[k] != null && (opts?.overwrite ? current[k] !== desired[k] : current[k] == null)
        ));
        written = {
          filePath, desired, filledFields,
          coverImage: opts?.coverImage ?? null,
          overwrite: opts?.overwrite ?? false,
          replaceCoverArt: opts?.replaceCoverArt ?? false,
        };
        return { filledFields };
      },
      plannedFills: () => [],
    },
  });

  mock.module('../src/services/fingerprintMatch.js', {
    namedExports: {
      candidatesFromFingerprint: async (filePath) => {
        fingerprinted.push(filePath);
        return { candidates: fingerprintCandidates };
      },
    },
  });

  mock.module('../src/services/coverArt.js', {
    namedExports: {
      getFrontCoverImage: async () => coverImage,
      getFrontCoverUrl: async () => null,
      readSidecarCover: async () => null,
    },
  });

  return import(`../src/services/libraryFix.js?fresh=${counter}`);
}

function seedTrack(db, overrides = {}, relPath = 'track.mp3') {
  const filePath = path.join(musicDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'audio');
  repo.upsertLocalTrack(db, {
    path: filePath, artist: null, album: null, title: null,
    durationMs: 1000, changeKey: '5:1', ...overrides,
  });
  repo.recomputeStats(db);
  // getTrackById rather than listTracks: browse listings deliberately don't
  // carry the absolute path, and this helper's callers assert on it.
  return repo.getTrackById(db, repo.listTracks(db, {}).tracks[0].id);
}

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  fs.rmSync(musicDir, { recursive: true, force: true });
});

test('a fix fills the empty tags and leaves the file where it is', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db);
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
  });
  const result = await applyFix({ trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });

  assert.equal(written.filePath, track.path, 'the file is written in place, not moved');
  assert.equal(written.desired.artist, 'Radiohead');
  assert.equal(written.desired.album, 'Kid A');
  assert.equal(written.desired.year, 2000);
  assert.equal(written.desired.trackNumber, 7, 'the position comes from the release tracklist');
  assert.ok(result.filledFields.includes('artist'));
  assert.ok(fs.existsSync(track.path), 'the original path still exists');
  db.close();
});

test('tags the file already has are not overwritten', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db, { artist: 'My Own Spelling', title: 'My Title', trackNumber: 3 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'My Own Spelling', title: 'My Title', album: null, trackNumber: 3, disc: null, year: null },
  });
  const result = await applyFix({ trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });

  assert.ok(!result.filledFields.includes('artist'), 'an existing artist tag is left alone');
  assert.ok(!result.filledFields.includes('title'));
  assert.ok(result.filledFields.includes('album'), 'the empty album is still filled');
  db.close();
});

test('the release tracklist is only fetched when the track number is missing', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db, { artist: 'Radiohead', trackNumber: 7 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Radiohead', title: null, album: null, trackNumber: 7, disc: null, year: null },
  });
  await applyFix({ trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });

  // No position was requested, so nothing was sent for trackNumber/disc.
  assert.equal(written.desired.trackNumber, null);
  assert.equal(written.desired.disc, null);
  db.close();
});

test('cover art is fetched only for a track that has none', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const bare = seedTrack(db);
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
    coverImage: { bytes: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  await applyFix({ trackId: bare.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });
  assert.ok(written.coverImage, 'art is embedded when the file has none');

  const arted = seedTrack(db, { hasCoverArt: 1 });
  written = null;
  await applyFix({ trackId: arted.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });
  assert.equal(written.coverImage, null, 'an already-arted file costs no cover lookup');
  db.close();
});

// The Health tab's rows are files whose tags are missing, so searching
// MusicBrainz for "this file's tags" finds nothing for exactly the files that
// need repairing. getFixCandidates reads the path instead and hands it to
// candidatesFromTags as a fallback — the precedence rules for that merge are
// pinned in tag-match.test.js, where the tags mock reaches the module under test.
test('getFixCandidates reads the tags implied by the file path', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db, {}, path.join('Radiohead', 'Kid A', '05 - Idioteque.mp3'));
  searched = [];

  const { getFixCandidates } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
  });
  const result = await getFixCandidates(track.id);

  assert.equal(result.pathTags.artist, 'Radiohead');
  assert.equal(result.pathTags.album, 'Kid A');
  assert.equal(result.pathTags.title, 'Idioteque');
  assert.equal(result.pathTags.trackNumber, 5);
  assert.equal(searched.length, 1, 'the empty tags did not short-circuit the search');
  db.close();
});

test('getFixCandidates commits to nothing for a file with no usable path', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  // Directly under MUSIC_DIR: no artist or album folder to read.
  const track = seedTrack(db, {}, 'unknown.mp3');

  const { getFixCandidates } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
  });
  const result = await getFixCandidates(track.id);

  assert.equal(result.pathTags.artist, null);
  assert.equal(result.pathTags.album, null);
  assert.equal(result.pathTags.title, 'unknown');
  db.close();
});

// The fingerprint is the one signal that doesn't depend on the metadata being
// repaired, so it's what the panel offers when the tag/path search comes back
// with nothing useful. It costs an fpcalc subprocess, hence on demand only.
test('getFingerprintCandidates identifies the file by its audio', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db);
  fingerprinted = [];

  const { getFingerprintCandidates } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
    fingerprintCandidates: [
      { recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Idioteque', artist: 'Radiohead', lengthMs: 300_000, score: 0.92, releaseGroupTitle: 'Kid A' },
    ],
  });
  const result = await getFingerprintCandidates(track.id);

  assert.deepEqual(fingerprinted, [track.path], 'the indexed file itself is what gets fingerprinted');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score, 0.92);
  assert.equal(result.track.id, track.id);
  db.close();
});

test('getFingerprintCandidates does not fall back to a tag search when the audio is unknown', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db);
  searched = [];

  const { getFingerprintCandidates } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
    fingerprintCandidates: [],
  });
  const result = await getFingerprintCandidates(track.id);

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(searched, [], 'the caller already has the tag candidates on screen');
  db.close();
});

test('getFingerprintCandidates is refused when no AcoustID key is configured', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db);

  const { getFingerprintCandidates } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
  });
  const original = configModule.config.acoustidApiKey;
  configModule.config.acoustidApiKey = null;
  try {
    await assert.rejects(() => getFingerprintCandidates(track.id), /acoustid/i);
  } finally {
    configModule.config.acoustidApiKey = original;
  }
  db.close();
});

// A file tagged as the wrong song can't be repaired by filling blanks — there
// aren't any. Only offered for fingerprint matches, and only on an explicit
// opt-in, because there's no undo.
test('an overwriting fix replaces tags that disagree with the recording', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db, { artist: 'Wrong Band', title: 'Wrong Song' });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Wrong Band', title: 'Wrong Song', album: null, trackNumber: null, disc: null, year: null },
  });
  const result = await applyFix({
    trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777', overwrite: true,
  });

  assert.equal(written.overwrite, true);
  assert.ok(result.filledFields.includes('artist'), 'the wrong artist is corrected');
  assert.ok(result.filledFields.includes('title'));
  assert.equal(result.overwritten, true, 'the caller can tell "replaced" from "filled"');
  db.close();
});

test('an overwriting fix corrects a track number that disagrees with the tracklist', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db, { artist: 'Radiohead', trackNumber: 2 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Radiohead', title: null, album: null, trackNumber: 2, disc: null, year: null },
  });
  await applyFix({
    trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777', overwrite: true,
  });

  // The default path skips the tracklist lookup entirely for a file that
  // already has a number; overwriting has to fetch it to correct a wrong one.
  assert.equal(written.desired.trackNumber, 7, 'the position comes from the release tracklist');
  db.close();
});

test('a fix that is not overwriting still reports itself as such', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const track = seedTrack(db);
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: null, title: null, album: null, trackNumber: null, disc: null, year: null },
  });
  const result = await applyFix({ trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777' });

  assert.equal(written.overwrite, false, 'fill-only stays the default');
  assert.equal(result.overwritten, false);
  db.close();
});

test('an overwriting fix leaves existing cover art alone unless asked otherwise', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const arted = seedTrack(db, { artist: 'Wrong Band', hasCoverArt: 1 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Wrong Band', title: null, album: null, trackNumber: null, disc: null, year: null },
    coverImage: { bytes: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  await applyFix({
    trackId: arted.id, recordingMbid: '77777777-7777-4777-8777-777777777777', overwrite: true,
  });

  assert.equal(written.coverImage, null, 'correcting tags does not fetch replacement art');
  assert.equal(written.replaceCoverArt, false);
  db.close();
});

// Art is its own opt-in. A file tagged as the wrong song usually carries that
// song's sleeve too, but the two are separate decisions — and the cover lookup
// is a Cover Art Archive request that shouldn't be spent unless asked for.
test('replacing cover art fetches art even for a file that already has some', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const arted = seedTrack(db, { artist: 'Wrong Band', hasCoverArt: 1 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Wrong Band', title: null, album: null, trackNumber: null, disc: null, year: null },
    coverImage: { bytes: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  await applyFix({
    trackId: arted.id,
    recordingMbid: '77777777-7777-4777-8777-777777777777',
    replaceCoverArt: true,
  });

  assert.ok(written.coverImage, 'the replacement is fetched despite the file having art');
  assert.equal(written.replaceCoverArt, true);
  db.close();
});

test('cover art can be replaced without overwriting any tags', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const arted = seedTrack(db, { artist: 'Wrong Band', hasCoverArt: 1 });
  written = null;

  const { applyFix } = await freshFix({
    current: { artist: 'Wrong Band', title: null, album: null, trackNumber: null, disc: null, year: null },
    coverImage: { bytes: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  const result = await applyFix({
    trackId: arted.id,
    recordingMbid: '77777777-7777-4777-8777-777777777777',
    replaceCoverArt: true,
  });

  assert.equal(written.overwrite, false, 'the two opt-ins are independent');
  assert.equal(result.overwritten, false);
  assert.ok(!result.filledFields.includes('artist'), 'the wrong artist tag is left as it was');
  db.close();
});

test('fixing an unknown track is a 404, not a crash', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { applyFix } = await freshFix({ current: {} });
  await assert.rejects(() => applyFix({ trackId: 99999, recordingMbid: '77777777-7777-4777-8777-777777777777' }), /not found/i);
  db.close();
});

test('a track whose row points outside MUSIC_DIR is refused', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const outside = path.join(os.tmpdir(), `spinmatch-outside-${process.pid}.mp3`);
  fs.writeFileSync(outside, 'audio');
  repo.upsertLocalTrack(db, {
    path: outside, artist: null, album: null, title: null,
    durationMs: 1000, changeKey: '5:1',
  });
  const track = repo.getTrackById(db, repo.listTracks(db, {}).tracks[0].id);
  assert.equal(track.path, outside);

  const { applyFix } = await freshFix({ current: {} });
  await assert.rejects(
    () => applyFix({ trackId: track.id, recordingMbid: '77777777-7777-4777-8777-777777777777' }),
    /outside the music folder|not readable/i,
  );
  fs.rmSync(outside, { force: true });
  db.close();
});
