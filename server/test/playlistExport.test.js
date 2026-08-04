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

test('drop-off numbering does not pad to two digits below ten', async () => {
  // The 10-track test above can't distinguish padStart(2) from
  // padStart(width): both agree for 1..10. Nine tracks is the smallest count
  // that tells them apart — width is 1, so the first file must be named "1 -
  // ...", not "01 - ...".
  const items = [];
  for (let i = 1; i <= 9; i += 1) {
    items.push(item('A', `Nine${i}`, await seedFile(`A/B/nine${i}.mp3`)));
  }
  const { dir, copied } = await exportToDropoff({ name: 'NineTracks', items });
  assert.equal(copied, 9);
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files[0], '1 - A - Nine1.mp3');
  assert.equal(files[8], '9 - A - Nine9.mp3');
});

test('drop-off numbering pads to three digits at a hundred tracks', async () => {
  const items = [];
  for (let i = 1; i <= 100; i += 1) {
    items.push(item('A', `Hundred${i}`, await seedFile(`A/B/hundred${i}.mp3`)));
  }
  const { dir, copied } = await exportToDropoff({ name: 'HundredTracks', items });
  assert.equal(copied, 100);
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files[0], '001 - A - Hundred1.mp3');
  assert.equal(files[99], '100 - A - Hundred100.mp3');
});

test('two concurrent exports of one playlist serialize, leaving a coherent folder', async () => {
  // Both calls target the same drop-off directory (same playlist name), with
  // deliberately distinct item sets so an interleaved wipe-and-copy would be
  // visible as a mix of both sets' filenames rather than either one cleanly.
  // withFileLock is what has to prevent that: exportToDropoff computes `dir`
  // and locks on `dropoff:${dir}`, so the second call's wipe-and-copy can only
  // begin once the first has fully finished.
  const alphaFiles = await Promise.all(
    [1, 2, 3].map((i) => seedFile(`A/B/alpha${i}.mp3`))
  );
  const betaFiles = await Promise.all(
    [1, 2].map((i) => seedFile(`A/B/beta${i}.mp3`))
  );
  const alphaItems = alphaFiles.map((f, i) => item('A', `Alpha${i + 1}`, f));
  const betaItems = betaFiles.map((f, i) => item('B', `Beta${i + 1}`, f));

  const [alphaResult, betaResult] = await Promise.all([
    exportToDropoff({ name: 'Concurrent', items: alphaItems }),
    exportToDropoff({ name: 'Concurrent', items: betaItems }),
  ]);
  assert.equal(alphaResult.dir, betaResult.dir);

  const files = (await fs.readdir(alphaResult.dir)).sort();
  const alphaNames = ['1 - A - Alpha1.mp3', '2 - A - Alpha2.mp3', '3 - A - Alpha3.mp3'].sort();
  const betaNames = ['1 - B - Beta1.mp3', '2 - B - Beta2.mp3'].sort();
  const isCoherentAlpha = JSON.stringify(files) === JSON.stringify(alphaNames);
  const isCoherentBeta = JSON.stringify(files) === JSON.stringify(betaNames);
  assert.ok(
    isCoherentAlpha || isCoherentBeta,
    `expected exactly one export's files, got a mix: ${JSON.stringify(files)}`,
  );
});

test('an existing folder is reported rather than overwritten', async () => {
  const a = await seedFile('A/B/three.mp3');
  await exportToDropoff({ name: 'Existing', items: [item('A', 'Three', a)] });
  const info = await inspectDropoff('Existing');
  assert.equal(info.exists, true);
  assert.equal(info.fileCount, 1);
  assert.equal(info.bytes, 16, 'the size of what is there, so the caller can say how much is at stake');
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

test('the containment check refuses a drop-off folder inside the music folder', async () => {
  // The inverse of the parent case, and the one .env.example and the README
  // only ever documented: fs.rm would delete inside the music root, the
  // MUSIC_DIR watcher would rescan the whole library on every export, and the
  // copies would be indexed as duplicates of their own sources.
  const original = liveConfig.playlist.dropoffDir;
  const inside = path.join(musicDir, 'Player');
  await fs.mkdir(inside, { recursive: true });
  liveConfig.playlist.dropoffDir = inside;
  try {
    await assert.rejects(
      () => assertInsideDropoffDir(path.join(inside, 'Whatever')),
      /outside the music folder/i,
    );
  } finally {
    liveConfig.playlist.dropoffDir = original;
    await fs.rm(inside, { recursive: true, force: true });
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

test('an unreadable source fails before the wipe, so a dropped mount cannot empty the last export', async () => {
  // The NAS case. size_bytes is a column, so every row still resolves after the
  // volume goes away — a pre-flight that only read the index therefore touched
  // no source file at all, deleted the previous export, and then threw ENOENT
  // on the first copy.
  const a = await seedFile('A/B/mounted.mp3');
  await exportToDropoff({ name: 'Mounted', items: [item('A', 'Mounted', a)] });
  assert.deepEqual(await fs.readdir(path.join(dropoffDir, 'Mounted')), ['1 - A - Mounted.mp3']);

  await fs.rm(a);
  await assert.rejects(
    () => exportToDropoff({ name: 'Mounted', items: [item('A', 'Mounted', a)] }),
    /no longer readable/i,
  );
  assert.deepEqual(
    await fs.readdir(path.join(dropoffDir, 'Mounted')),
    ['1 - A - Mounted.mp3'],
    'the previous export is untouched',
  );
});

test('a playlist with nothing behind it is refused rather than exported as an empty folder', async () => {
  const a = await seedFile('A/B/allgaps.mp3');
  await exportToDropoff({ name: 'AllGaps', items: [item('A', 'Real', a)] });

  await assert.rejects(
    () => exportToDropoff({ name: 'AllGaps', items: [item('Tricky', 'Aftermath', null)] }),
    /nothing to export/i,
  );
  assert.deepEqual(
    await fs.readdir(path.join(dropoffDir, 'AllGaps')),
    ['1 - A - Real.mp3'],
    'the previous export survives an all-gap replace',
  );
});

test('the space check counts the room that replacing the existing folder frees', async () => {
  // Re-exporting an unchanged playlist onto a device sized for it is the most
  // common export there is, and it used to be the one that failed: `available`
  // was measured while the previous copy still occupied the space.
  const a = await seedFile('A/B/reclaim.mp3', 4096);
  const sized = item('A', 'Reclaim', a, {
    track: { path: a, artist: 'A', title: 'Reclaim', durationMs: 1000, sizeBytes: 4096, ext: '.mp3' },
  });
  await exportToDropoff({ name: 'Reclaimed', items: [sized] });

  const huge = item('A', 'Huge', a, {
    track: { path: a, artist: 'A', title: 'Huge', durationMs: 1000, sizeBytes: Number.MAX_SAFE_INTEGER, ext: '.mp3' },
  });
  await assert.rejects(
    () => exportToDropoff({ name: 'Reclaimed', items: [huge] }),
    /including 4096 reclaimed/,
  );
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
