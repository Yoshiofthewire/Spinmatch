import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readTags, readCoverArt, writeTags, plannedFills } = await import('../src/services/tags.js');

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

// The tag-based ingest fallback duration-confirms its matches with this value,
// so it has to come off a real file without fpcalc/Chromaprint involved.
test('readTags reports the decoded duration', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const tags = await readTags(file);
    assert.ok(tags.durationMs > 0, `expected a positive duration, got ${tags.durationMs}`);
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

test('writeTags fills blank fields on an untagged fixture', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const { filledFields } = await writeTags(file, {
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

test('plannedFills lists only fields that are missing now and provided by desired', () => {
  const current = { artist: 'Have Artist', title: null, album: null, trackNumber: null, disc: null, year: null, genre: null };
  const desired = { artist: 'New Artist', title: 'New Title', album: null, trackNumber: 5, disc: 2 };
  // artist already present → skipped; album desired is null → skipped; the rest fill.
  assert.deepEqual(new Set(plannedFills(current, desired)), new Set(['title', 'trackNumber', 'disc']));
});

test('plannedFills returns nothing when every desired field is already present', () => {
  const current = { artist: 'A', title: 'T', album: 'B' };
  const desired = { artist: 'X', title: 'Y', album: 'Z' };
  assert.deepEqual(plannedFills(current, desired), []);
});

test('writeTags fills a blank disc number and reads it back', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const before = await readTags(file);
    assert.equal(before.disc, null);

    const { filledFields } = await writeTags(file, { artist: 'A', title: 'T', album: 'B', disc: 2 });
    assert.ok(filledFields.includes('disc'));

    const after = await readTags(file);
    assert.equal(after.disc, 2);
  });
});

test('writeTags never overwrites an existing disc number', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    await writeTags(file, { artist: 'A', title: 'T', album: 'B', disc: 1 });
    const { filledFields } = await writeTags(file, { artist: 'A', title: 'T', album: 'B', disc: 2 });
    assert.ok(!filledFields.includes('disc'));

    const after = await readTags(file);
    assert.equal(after.disc, 1);
  });
});

test('writeTags never overwrites a field that already has a value', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const { filledFields } = await writeTags(file, {
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

// The overwrite mode exists for one case: a fingerprint has identified the file
// as a different recording than its tags claim, so the existing values are the
// thing that's wrong. Off by default — see libraryFix.js.
test('writeTags with overwrite replaces a field that already has a value', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const { filledFields } = await writeTags(file, {
      artist: 'Corrected Artist',
      title: 'Corrected Title',
    }, { overwrite: true });
    assert.ok(filledFields.includes('artist'));
    assert.ok(filledFields.includes('title'));

    const after = await readTags(file);
    assert.equal(after.artist, 'Corrected Artist');
    assert.equal(after.title, 'Corrected Title');
  });
});

// So that applying a match the file already agrees with reports "no changes
// needed" instead of claiming a write it didn't make.
test('writeTags with overwrite does not report a field that already matches', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const { filledFields } = await writeTags(file, {
      artist: 'Existing Artist',
      title: 'Corrected Title',
    }, { overwrite: true });
    assert.ok(!filledFields.includes('artist'), 'an already-correct field is not rewritten');
    assert.ok(filledFields.includes('title'), 'a field that differs still is');
  });
});

// Art is its own opt-in: correcting the text tags and swapping the picture are
// different decisions, and either is useful without the other.
test('writeTags with overwrite leaves existing cover art alone', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    await writeTags(file, { artist: 'A' }, { coverImage });

    const secondCover = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeTags(file, { artist: 'B' }, { coverImage: secondCover, overwrite: true });
    assert.ok(filledFields.includes('artist'), 'the tag is still corrected');
    assert.ok(!filledFields.includes('coverArt'), 'overwriting tags does not imply replacing art');
  });
});

test('writeTags with replaceCoverArt swaps art that is already present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    await writeTags(file, { artist: 'A' }, { coverImage });

    const secondCover = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeTags(file, {}, { coverImage: secondCover, replaceCoverArt: true });
    assert.ok(filledFields.includes('coverArt'));

    const after = await readCoverArt(file);
    assert.deepEqual(Buffer.from(after.bytes), secondCover.bytes, 'the new picture is the one on the file');
  });
});

test('writeTags replaces art without touching tags that are already set', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeTags(file, { artist: 'Should Not Overwrite' }, { coverImage, replaceCoverArt: true });

    assert.ok(!filledFields.includes('artist'), 'replacing art does not imply overwriting tags');
    assert.ok(filledFields.includes('coverArt'));
    assert.equal((await readTags(file)).artist, 'Existing Artist');
  });
});

test('writeTags with replaceCoverArt and no art to write leaves the file as it was', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    await writeTags(file, { artist: 'A' }, { coverImage });

    const { filledFields } = await writeTags(file, {}, { coverImage: null, replaceCoverArt: true });
    assert.ok(!filledFields.includes('coverArt'), 'nothing to put there means nothing is removed');
    assert.equal((await readTags(file)).hasCoverArt, true);
  });
});

test('writeTags embeds cover art only when none is present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeTags(file, { artist: 'A', title: 'T', album: 'B' }, { coverImage });
    assert.ok(filledFields.includes('coverArt'));

    const after = await readTags(file);
    assert.equal(after.hasCoverArt, true);
  });
});

test('writeTags does not overwrite cover art that is already present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    await writeTags(file, { artist: 'A', title: 'T', album: 'B' }, { coverImage });

    const secondCover = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeTags(file, {}, { coverImage: secondCover });
    assert.ok(!filledFields.includes('coverArt'));
  });
});

test('writeTags writes a genre when none is present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const { filledFields } = await writeTags(file, { genre: 'Electronic' });
    assert.ok(filledFields.includes('genre'));

    const after = await readTags(file);
    assert.equal(after.genre, 'Electronic');
  });
});

test('readTags/writeTags work across MP3, FLAC, M4A, and OGG', async () => {
  for (const name of ['silence.mp3', 'silence.flac', 'silence.m4a', 'silence.ogg']) {
    await withCopiedFixture(name, async (file) => {
      const before = await readTags(file);
      assert.equal(before.title, null, `${name} should start untagged`);
      assert.equal(before.hasCoverArt, false, `${name} should start without cover art`);

      const desired = { artist: 'A', title: 'T', album: 'B', trackNumber: 5, year: 1999, genre: 'Rock' };
      const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
      const { filledFields } = await writeTags(file, desired, { coverImage });
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
