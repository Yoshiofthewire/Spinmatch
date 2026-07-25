// Path-derived tags. The contract worth pinning down is that it reads the
// layouts people actually use and returns null rather than guessing for anything
// else — a wrong tag written into a file is worse than a missing one.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const musicDir = '/music';
process.env.MUSIC_DIR = musicDir;

const { tagsFromPath } = await import('../src/services/libraryPathTags.js');

function at(...segments) {
  return tagsFromPath(path.join(musicDir, ...segments));
}

test('reads artist, album, track number and title from the standard layout', () => {
  const tags = at('Radiohead', 'Kid A', '05 - Idioteque.flac');
  assert.equal(tags.artist, 'Radiohead');
  assert.equal(tags.album, 'Kid A');
  assert.equal(tags.trackNumber, 5);
  assert.equal(tags.title, 'Idioteque');
});

test('accepts the separators people actually use between number and title', () => {
  for (const name of ['05 - Idioteque.flac', '05. Idioteque.flac', '05_Idioteque.flac', '05 Idioteque.flac']) {
    const tags = at('Radiohead', 'Kid A', name);
    assert.equal(tags.trackNumber, 5, name);
    assert.equal(tags.title, 'Idioteque', name);
  }
});

test('takes the year out of the album folder rather than leaving it in the title', () => {
  for (const dir of ['2000 - Kid A', '(2000) Kid A', '[2000] Kid A', 'Kid A (2000)']) {
    const tags = at('Radiohead', dir, '05 Idioteque.flac');
    assert.equal(tags.album, 'Kid A', dir);
    assert.equal(tags.year, 2000, dir);
  }
});

test('steps over a disc folder so it is not mistaken for the album', () => {
  const tags = at('The Beatles', 'The Beatles', 'CD2', '03 Birthday.mp3');
  assert.equal(tags.artist, 'The Beatles');
  assert.equal(tags.album, 'The Beatles');
  assert.equal(tags.disc, 2);
  assert.equal(tags.trackNumber, 3);
  assert.equal(tags.title, 'Birthday');
});

test('recognises the disc folder spellings', () => {
  for (const dir of ['CD1', 'CD 1', 'Disc 1', 'Disk-1', 'disc1']) {
    const tags = at('Artist', 'Album', dir, '03 Song.mp3');
    assert.equal(tags.album, 'Album', dir);
    assert.equal(tags.disc, 1, dir);
  }
});

test('reads a disc-qualified track number out of the filename', () => {
  const tags = at('Artist', 'Album', '2-05 Song.mp3');
  assert.equal(tags.disc, 2);
  assert.equal(tags.trackNumber, 5);
  assert.equal(tags.title, 'Song');
});

test('a filename disc number wins over the folder it sits in', () => {
  // If the file says disc 2 and the folder says disc 1, the more specific of the
  // two is the file — the folder may just be where it was dropped.
  const tags = at('Artist', 'Album', 'CD1', '2-05 Song.mp3');
  assert.equal(tags.disc, 2);
});

test('returns no artist or album when the file is not two folders deep', () => {
  const shallow = at('Album', '05 Song.mp3');
  assert.equal(shallow.artist, null);
  assert.equal(shallow.album, null);
  // The filename is still unambiguous, so it is still read.
  assert.equal(shallow.trackNumber, 5);
  assert.equal(shallow.title, 'Song');

  const root = at('05 Song.mp3');
  assert.equal(root.artist, null);
  assert.equal(root.album, null);
  assert.equal(root.title, 'Song');
});

test('a filename with no leading number yields a title and no track number', () => {
  const tags = at('Radiohead', 'Kid A', 'Idioteque.flac');
  assert.equal(tags.trackNumber, null);
  assert.equal(tags.title, 'Idioteque');
});

test('returns nothing for a path outside MUSIC_DIR', () => {
  const tags = tagsFromPath('/etc/passwd');
  assert.deepEqual(tags, {
    artist: null, album: null, title: null, trackNumber: null, disc: null, year: null,
  });
});

test('normalises underscores and stray whitespace out of every segment', () => {
  const tags = at('The_Beatles', 'Abbey_Road', '01_Come_Together.flac');
  assert.equal(tags.artist, 'The Beatles');
  assert.equal(tags.album, 'Abbey Road');
  assert.equal(tags.title, 'Come Together');
});

// The known ambiguity, pinned so a future change to TRACK_PREFIX has to decide
// about it deliberately: a title that opens with a number is indistinguishable
// from a track number by filename alone. Bulk repair resolves this with a
// folder-level coherence check, and every proposal is previewed before writing.
test('a title starting with a number is read as a track number', () => {
  const tags = at('Jay-Z', 'The Black Album', '99 Problems.mp3');
  assert.equal(tags.trackNumber, 99);
  assert.equal(tags.title, 'Problems');
});
