import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readTags, writeMissingTags } = await import('../src/services/tags.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function withCopiedFixture(name, fn) {
  const src = path.join(FIXTURES_DIR, name);
  const tmp = path.join(await fs.mkdtemp(path.join(FIXTURES_DIR, '.tmp-')), name);
  await fs.copyFile(src, tmp);
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true });
  }
}

test('readTags reads existing title/artist from a tagged fixture', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const tags = await readTags(file);
    assert.equal(tags.title, 'Existing Title');
    assert.equal(tags.artist, 'Existing Artist');
    assert.equal(tags.hasCoverArt, false);
  });
});

test('readTags reports empty fields on an untagged fixture', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const tags = await readTags(file);
    assert.equal(tags.title, null);
    assert.equal(tags.artist, null);
    assert.equal(tags.album, null);
  });
});

test('writeMissingTags fills blank fields on an untagged fixture', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const { filledFields } = await writeMissingTags(file, {
      artist: 'New Artist',
      title: 'New Title',
      album: 'New Album',
      trackNumber: 3,
      year: 2020,
      genre: null,
    });
    assert.deepEqual(new Set(filledFields), new Set(['artist', 'title', 'album', 'trackNumber', 'year']));

    const after = await readTags(file);
    assert.equal(after.artist, 'New Artist');
    assert.equal(after.title, 'New Title');
    assert.equal(after.album, 'New Album');
    assert.equal(after.trackNumber, 3);
    assert.equal(after.year, 2020);
  });
});

test('writeMissingTags fills a blank disc number and reads it back', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const before = await readTags(file);
    assert.equal(before.disc, null);

    const { filledFields } = await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B', disc: 2 });
    assert.ok(filledFields.includes('disc'));

    const after = await readTags(file);
    assert.equal(after.disc, 2);
  });
});

test('writeMissingTags never overwrites an existing disc number', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B', disc: 1 });
    const { filledFields } = await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B', disc: 2 });
    assert.ok(!filledFields.includes('disc'));

    const after = await readTags(file);
    assert.equal(after.disc, 1);
  });
});

test('writeMissingTags never overwrites a field that already has a value', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const { filledFields } = await writeMissingTags(file, {
      artist: 'Should Not Overwrite',
      title: 'Should Not Overwrite',
      album: 'Should Fill This In',
    });
    assert.ok(!filledFields.includes('artist'));
    assert.ok(!filledFields.includes('title'));
    assert.ok(filledFields.includes('album'));

    const after = await readTags(file);
    assert.equal(after.artist, 'Existing Artist');
    assert.equal(after.title, 'Existing Title');
    assert.equal(after.album, 'Should Fill This In');
  });
});

test('writeMissingTags embeds cover art only when none is present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B' }, { coverImage });
    assert.ok(filledFields.includes('coverArt'));

    const after = await readTags(file);
    assert.equal(after.hasCoverArt, true);
  });
});

test('writeMissingTags does not overwrite cover art that is already present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B' }, { coverImage });

    const secondCover = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeMissingTags(file, {}, { coverImage: secondCover });
    assert.ok(!filledFields.includes('coverArt'));
  });
});

test('writeMissingTags writes a genre when none is present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const { filledFields } = await writeMissingTags(file, { genre: 'Electronic' });
    assert.ok(filledFields.includes('genre'));

    const after = await readTags(file);
    assert.equal(after.genre, 'Electronic');
  });
});

test('readTags/writeMissingTags work across MP3, FLAC, M4A, and OGG', async () => {
  for (const name of ['silence.mp3', 'silence.flac', 'silence.m4a', 'silence.ogg']) {
    await withCopiedFixture(name, async (file) => {
      const before = await readTags(file);
      assert.equal(before.title, null, `${name} should start untagged`);
      assert.equal(before.hasCoverArt, false, `${name} should start without cover art`);

      const desired = { artist: 'A', title: 'T', album: 'B', trackNumber: 5, year: 1999, genre: 'Rock' };
      const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
      const { filledFields } = await writeMissingTags(file, desired, { coverImage });
      assert.deepEqual(
        new Set(filledFields),
        new Set(['artist', 'title', 'album', 'trackNumber', 'year', 'genre', 'coverArt']),
        `${name} should fill every field including cover art`
      );

      const after = await readTags(file);
      assert.equal(after.title, 'T', `${name} should have title written`);
      assert.equal(after.artist, 'A', `${name} should have artist written`);
      assert.equal(after.album, 'B', `${name} should have album written`);
      assert.equal(after.trackNumber, 5, `${name} should have trackNumber written`);
      assert.equal(after.year, 1999, `${name} should have year written`);
      assert.equal(after.genre, 'Rock', `${name} should have genre written`);
      assert.equal(after.hasCoverArt, true, `${name} should have cover art embedded`);
    });
  }
});
