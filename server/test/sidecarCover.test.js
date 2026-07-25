import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { readSidecarCover } = await import('../src/services/coverArt.js');

function dirWith(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-cover-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
  return dir;
}

test('a cover image beside the audio is found', async () => {
  const dir = dirWith(['01.mp3', 'cover.jpg']);
  const cover = await readSidecarCover(dir);
  assert.equal(cover.mimeType, 'image/jpeg');
  assert.equal(cover.bytes.toString(), 'cover.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the basename match is case-insensitive', async () => {
  const dir = dirWith(['Folder.PNG']);
  const cover = await readSidecarCover(dir);
  assert.equal(cover.mimeType, 'image/png');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cover wins over folder when both are present', async () => {
  // Order matters: "cover" is the more deliberate name, "folder.jpg" is often
  // whatever a media player dropped there.
  const dir = dirWith(['folder.jpg', 'cover.jpg']);
  const cover = await readSidecarCover(dir);
  assert.equal(cover.bytes.toString(), 'cover.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrelated image is not treated as cover art', async () => {
  const dir = dirWith(['band-photo.jpg', 'scan001.png']);
  assert.equal(await readSidecarCover(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a directory with no images, and a missing directory, both return null', async () => {
  const dir = dirWith(['01.mp3']);
  assert.equal(await readSidecarCover(dir), null);
  assert.equal(await readSidecarCover(path.join(dir, 'nope')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
