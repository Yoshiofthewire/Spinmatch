// The tag-repair path. The behaviour worth pinning down is that it repairs in
// place: it must fill only the empty fields, must never move or rename the file,
// and must refresh the index afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-fix-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

const RECORDING = {
  mbid: 'rec-1',
  title: 'Idioteque',
  artist: 'Radiohead',
  lengthMs: 300_000,
  releaseGroups: [{ mbid: 'rg-1', title: 'Kid A' }],
  date: '2000-10-02',
};

// Tracks what the fix flow asked to be written, so the "only empty fields" and
// "never moves the file" contracts can be asserted without a real audio file.
let written;
let counter = 0;

async function freshFix({ current, recording = RECORDING, coverImage = null } = {}) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();

  mock.module('../src/services/musicbrainz.js', {
    namedExports: {
      getRecording: async () => recording,
      resolvePrimaryReleaseForGroup: async () => 'release-1',
      getReleaseWithTracks: async () => ({
        release: { mbid: 'release-1', title: 'Kid A', artist: 'Radiohead' },
        tracks: [{ position: 7, discNumber: 1, recordingMbid: 'rec-1', title: 'Idioteque', lengthMs: 300_000 }],
      }),
      searchRecordings: async () => [],
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
      // Mirrors the real writeMissingTags contract: only fills what's empty.
      writeMissingTags: async (filePath, desired, opts) => {
        const filledFields = Object.keys(desired)
          .filter((k) => desired[k] != null && current[k] == null);
        written = { filePath, desired, filledFields, coverImage: opts?.coverImage ?? null };
        return { filledFields };
      },
      plannedFills: () => [],
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

function seedTrack(db, overrides = {}) {
  const filePath = path.join(musicDir, 'track.mp3');
  fs.writeFileSync(filePath, 'audio');
  repo.upsertLocalTrack(db, {
    path: filePath, artist: null, album: null, title: null,
    durationMs: 1000, changeKey: '5:1', ...overrides,
  });
  repo.recomputeStats(db);
  return repo.listTracks(db, {}).tracks[0];
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
  const result = await applyFix({ trackId: track.id, recordingMbid: 'rec-1' });

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
  const result = await applyFix({ trackId: track.id, recordingMbid: 'rec-1' });

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
  await applyFix({ trackId: track.id, recordingMbid: 'rec-1' });

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
  await applyFix({ trackId: bare.id, recordingMbid: 'rec-1' });
  assert.ok(written.coverImage, 'art is embedded when the file has none');

  const arted = seedTrack(db, { hasCoverArt: 1 });
  written = null;
  await applyFix({ trackId: arted.id, recordingMbid: 'rec-1' });
  assert.equal(written.coverImage, null, 'an already-arted file costs no cover lookup');
  db.close();
});

test('fixing an unknown track is a 404, not a crash', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { applyFix } = await freshFix({ current: {} });
  await assert.rejects(() => applyFix({ trackId: 99999, recordingMbid: 'rec-1' }), /not found/i);
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
  const track = repo.listTracks(db, {}).tracks.find((t) => t.path === outside);

  const { applyFix } = await freshFix({ current: {} });
  await assert.rejects(
    () => applyFix({ trackId: track.id, recordingMbid: 'rec-1' }),
    /outside MUSIC_DIR|not readable/i,
  );
  fs.rmSync(outside, { force: true });
  db.close();
});
