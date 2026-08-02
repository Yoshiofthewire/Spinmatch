import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-music-'));
const dropoffDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-drop-'));

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = musicDir;
process.env.DROPOFF_DIR = dropoffDir;

const { writeM3u, inspectDropoff, exportToDropoff } = await import('../src/services/playlistExport.js');
const { wasWrittenByUs, clearRecentWrites } = await import('../src/lib/recentWrites.js');
const { assertInsideDropoffDir } = await import('../src/lib/paths.js');
const { config: liveConfig } = await import('../src/config.js');

async function seedFile(rel, bytes = 16) {
  const full = path.join(musicDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  return full;
}

function item(artist, title, filePath, extra = {}) {
  return {
    artist, title, album: 'Al',
    track: filePath
      ? { path: filePath, artist, title, durationMs: 200_000, sizeBytes: 16, ext: path.extname(filePath) }
      : null,
    ...extra,
  };
}

test.after(async () => {
  await fs.rm(musicDir, { recursive: true, force: true });
  await fs.rm(dropoffDir, { recursive: true, force: true });
});

test('the m3u uses paths relative to the music root', async () => {
  const a = await seedFile('Portishead/Dummy/01 Mysterons.flac');
  const { path: written } = await writeM3u({
    name: 'Road Trip', items: [item('Portishead', 'Mysterons', a)],
  });
  assert.equal(written, path.join(musicDir, 'Road Trip.m3u'));
  const text = await fs.readFile(written, 'utf8');
  assert.match(text, /^#EXTM3U\n/);
  assert.match(text, /#EXTINF:200,Portishead - Mysterons\n/);
  assert.match(text, /^Portishead\/Dummy\/01 Mysterons\.flac$/m);
  assert.doesNotMatch(text, new RegExp(musicDir), 'absolute paths do not survive a different mount');
});

test('a gap becomes a comment, not a missing line', async () => {
  const a = await seedFile('A/B/one.mp3');
  const { path: written, skipped } = await writeM3u({
    name: 'Gappy',
    items: [item('A', 'One', a), item('Tricky', 'Aftermath', null)],
  });
  const text = await fs.readFile(written, 'utf8');
  assert.match(text, /^# missing: Tricky - Aftermath$/m);
  assert.equal(skipped, 1);
});

test('the m3u write is announced so the watcher does not rescan the library', async () => {
  clearRecentWrites();
  const a = await seedFile('A/B/two.mp3');
  await writeM3u({ name: 'Quiet', items: [item('A', 'Two', a)] });
  assert.equal(wasWrittenByUs('Quiet.m3u'), true);
});

test('drop-off numbering pads to the width of the track count', async () => {
  const items = [];
  for (let i = 1; i <= 10; i += 1) {
    items.push(item('A', `T${i}`, await seedFile(`A/B/t${i}.mp3`)));
  }
  const { dir, copied } = await exportToDropoff({ name: 'Ten', items });
  assert.equal(copied, 10);
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files[0], '01 - A - T1.mp3');
  assert.equal(files[9], '10 - A - T10.mp3');
});

test('an existing folder is reported rather than overwritten', async () => {
  const a = await seedFile('A/B/three.mp3');
  await exportToDropoff({ name: 'Existing', items: [item('A', 'Three', a)] });
  const info = await inspectDropoff('Existing');
  assert.equal(info.exists, true);
  assert.equal(info.fileCount, 1);
});

test('replacing wipes the folder rather than merging into it', async () => {
  const a = await seedFile('A/B/four.mp3');
  const b = await seedFile('A/B/five.mp3');
  await exportToDropoff({ name: 'Replaced', items: [item('A', 'Four', a), item('A', 'Five', b)] });
  const { dir, copied } = await exportToDropoff({ name: 'Replaced', items: [item('A', 'Four', a)] });
  assert.equal(copied, 1);
  assert.deepEqual(await fs.readdir(dir), ['1 - A - Four.mp3']);
});

test('progress is reported per file', async () => {
  const a = await seedFile('A/B/six.mp3');
  const seen = [];
  await exportToDropoff({
    name: 'Progress', items: [item('A', 'Six', a)],
    onProgress: (p) => seen.push(p),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].index, 1);
  assert.equal(seen[0].total, 1);
});

test('a name that looks like a traversal becomes a literal segment inside the root', async () => {
  const a = await seedFile('A/B/seven.mp3');
  const { dir } = await exportToDropoff({ name: '../escape', items: [item('A', 'Seven', a)] });
  // sanitizeSegment strips the separator, so for THIS input the result is one
  // literal folder name with no '/' left in it. That is not a general
  // guarantee that no name can escape — sanitizeSegment(' . ') collapses to
  // '.', and path.join(root, '.') is root itself, which is a real escape of
  // the "inside a playlist subfolder" property (see the '.' test below). The
  // actual safety property is enforced by assertInsideDropoffDir's strict
  // descendant check, not by sanitizeSegment.
  assert.equal(dir, path.join(dropoffDir, '..escape'));
  assert.ok(dir.startsWith(dropoffDir + path.sep));
});

test('the containment check refuses a path outside the drop-off root', async () => {
  await assert.rejects(() => assertInsideDropoffDir('/etc/passwd'), /outside/i);
});

test('a name that sanitizes to the bare root is refused, not treated as the root itself', async () => {
  // sanitizeSegment(' . ') === '.' (the trailing-dot strip is anchored at the
  // end and the string ends in a space; .trim() then removes the padding),
  // and path.join(DROPOFF_DIR, '.') collapses back to DROPOFF_DIR itself. If
  // the containment check let the bare root through, exportToDropoff's
  // fs.rm(dir, { recursive: true, force: true }) would delete everything in
  // DROPOFF_DIR, not just one playlist's folder.
  const a = await seedFile('A/B/eight.mp3');
  await assert.rejects(
    () => exportToDropoff({ name: ' . ', items: [item('A', 'Eight', a)] }),
    /outside/i,
  );
});

test('the containment check refuses an unconfigured drop-off folder', async () => {
  const original = liveConfig.playlist.dropoffDir;
  liveConfig.playlist.dropoffDir = null;
  try {
    await assert.rejects(
      () => assertInsideDropoffDir(path.join(dropoffDir, 'Whatever')),
      /no drop-off folder is configured/i,
    );
  } finally {
    liveConfig.playlist.dropoffDir = original;
  }
});

test('the containment check refuses a drop-off folder that resolves to the music folder', async () => {
  const original = liveConfig.playlist.dropoffDir;
  liveConfig.playlist.dropoffDir = musicDir;
  try {
    await assert.rejects(
      () => assertInsideDropoffDir(path.join(musicDir, 'Whatever')),
      /outside the music folder/i,
    );
  } finally {
    liveConfig.playlist.dropoffDir = original;
  }
});

test('the containment check refuses a drop-off folder that resolves to a parent of the music folder', async () => {
  // This is the one that matters most: it is what stops the wipe-and-rewrite
  // step in exportToDropoff from ever pointing at the music library.
  const original = liveConfig.playlist.dropoffDir;
  liveConfig.playlist.dropoffDir = path.dirname(musicDir);
  try {
    await assert.rejects(
      () => assertInsideDropoffDir(path.join(path.dirname(musicDir), 'Whatever')),
      /outside the music folder/i,
    );
  } finally {
    liveConfig.playlist.dropoffDir = original;
  }
});

test('a failed space check happens before the wipe, so a rejected export leaves the previous export intact', async () => {
  const a = await seedFile('A/B/nine.mp3');
  await exportToDropoff({ name: 'Guarded', items: [item('A', 'Nine', a)] });
  const before = await fs.readdir(path.join(dropoffDir, 'Guarded'));
  assert.deepEqual(before, ['1 - A - Nine.mp3']);

  // An absurd sizeBytes is the cheapest way to force the space check to fail
  // without actually filling the test filesystem.
  const huge = item('A', 'Huge', a, {
    track: { path: a, artist: 'A', title: 'Huge', durationMs: 1000, sizeBytes: Number.MAX_SAFE_INTEGER, ext: '.mp3' },
  });
  await assert.rejects(
    () => exportToDropoff({ name: 'Guarded', items: [huge] }),
    /not enough room/i,
  );

  // The rejection must have happened before fs.rm ran — the previous export's
  // file is still there, untouched.
  const after = await fs.readdir(path.join(dropoffDir, 'Guarded'));
  assert.deepEqual(after, ['1 - A - Nine.mp3']);
});

test('a missing size_bytes falls back to a real fs.stat rather than being treated as zero', async () => {
  // Regression for the bug where `sizeBytes ?? 0` let an all-NULL-size
  // playlist sail through the free-space check no matter how large the files
  // actually were. sizeBytes is deliberately omitted here (not just left
  // undefined on an existing key) to match what a NULL size_bytes column
  // produces once it comes back through playlistRepo.
  const a = await seedFile('A/B/ten.mp3', 4096);
  const noSize = {
    artist: 'A', title: 'Ten', album: 'Al',
    track: { path: a, artist: 'A', title: 'Ten', durationMs: 1000, ext: '.mp3' },
  };
  const { copied, bytes } = await exportToDropoff({ name: 'Unsized', items: [noSize] });
  assert.equal(copied, 1);
  assert.equal(bytes, 4096);
});
