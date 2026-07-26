import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configModule = await import('../src/config.js');
const { sanitizeSegment, targetPathFor, moveIntoLibrary } = await import('../src/services/organize.js');

async function withMusicDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-music-'));
  const original = configModule.config.ingest.musicDir;
  configModule.config.ingest.musicDir = dir;
  try {
    await fn(dir);
  } finally {
    configModule.config.ingest.musicDir = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('sanitizeSegment strips unsafe characters and trims', () => {
  assert.equal(sanitizeSegment('AC/DC'), 'ACDC');
  assert.equal(sanitizeSegment('  Weird: Title?  '), 'Weird Title');
  assert.equal(sanitizeSegment(''), 'Unknown');
});

test('sanitizeSegment neutralizes path-traversal attempts', () => {
  assert.equal(sanitizeSegment('..'), 'Unknown');
  assert.equal(sanitizeSegment('.'), 'Unknown');
  const traversal = sanitizeSegment('../../etc/passwd');
  assert.ok(!traversal.includes('/') && !traversal.includes('\\'), `got: ${traversal}`);
});

test('targetPathFor builds Artist/Album/NN - Title.ext with a track number', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor({ artist: 'The Band', album: 'The Album', trackNumber: 3, title: 'The Song' }, '.mp3');
    assert.equal(p, path.join(dir, 'The Band', 'The Album', '03 - The Song.mp3'));
  });
});

test('targetPathFor omits the track-number prefix when absent', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor({ artist: 'The Band', album: 'The Album', title: 'The Song' }, '.mp3');
    assert.equal(p, path.join(dir, 'The Band', 'The Album', 'The Song.mp3'));
  });
});

test('targetPathFor normalizes the extension to lowercase', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor({ artist: 'A', album: 'B', title: 'C' }, '.MP3');
    assert.equal(p, path.join(dir, 'A', 'B', 'C.mp3'));
  });
});

test('targetPathFor disc-prefixes every track of a multi-disc release (incl. disc 1)', async () => {
  await withMusicDir(async (dir) => {
    // The caller sets discNumber ONLY for multi-disc releases, so disc 1 is prefixed too.
    const disc2 = targetPathFor(
      { artist: 'The Band', album: 'The Album', discNumber: 2, trackNumber: 4, title: 'The Song' },
      '.flac'
    );
    assert.equal(disc2, path.join(dir, 'The Band', 'The Album', '2-04 - The Song.flac'));

    const disc1 = targetPathFor(
      { artist: 'The Band', album: 'The Album', discNumber: 1, trackNumber: 4, title: 'The Song' },
      '.flac'
    );
    assert.equal(disc1, path.join(dir, 'The Band', 'The Album', '1-04 - The Song.flac'));
  });
});

test('targetPathFor omits the disc prefix when discNumber is absent (single-disc)', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor(
      { artist: 'The Band', album: 'The Album', trackNumber: 4, title: 'The Song' },
      '.flac'
    );
    assert.equal(p, path.join(dir, 'The Band', 'The Album', '04 - The Song.flac'));
  });
});

test('moveIntoLibrary renames the file into the computed destination', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');

    const { movedTo, duplicate } = await moveIntoLibrary(src, { artist: 'A', album: 'B', title: 'C' }, '.mp3');
    assert.equal(duplicate, false);
    assert.ok(fsSync.existsSync(movedTo));
    assert.ok(!fsSync.existsSync(src));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary falls back to copy+unlink on a simulated EXDEV', async (t) => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');

    // Mock rename on the default fs/promises export (the same object
    // organize.js imports) — mocking the namespace's named export fails with
    // "Cannot redefine property" because those bindings are non-configurable.
    let renameCalls = 0;
    const realRename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('cross-device link');
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    });

    const { movedTo } = await moveIntoLibrary(src, { artist: 'A', album: 'B', title: 'C' }, '.mp3');
    assert.ok(fsSync.existsSync(movedTo));
    assert.ok(!fsSync.existsSync(src));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary appends (2), (3)... when the destination exists with different content', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const meta = { artist: 'A', album: 'B', title: 'C' };
    const dest = targetPathFor(meta, '.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'different-existing-content-longer');

    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'new-bytes');
    const { movedTo } = await moveIntoLibrary(src, meta, '.mp3');
    assert.equal(movedTo, dest.replace('.mp3', ' (2).mp3'));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary reports a duplicate and leaves the source in place when content is byte-identical', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const meta = { artist: 'A', album: 'B', title: 'C' };
    const dest = targetPathFor(meta, '.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'identical-content');

    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'identical-content');
    const { movedTo, duplicate } = await moveIntoLibrary(src, meta, '.mp3');
    assert.equal(duplicate, true);
    assert.equal(movedTo, null);
    assert.ok(fsSync.existsSync(src), 'source should be left in place for a duplicate');
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

// The move used to check "does dest exist?" and then rename() two awaits later.
// rename() overwrites silently, so anything that appeared at that path in the
// gap — a second drop folder, a file manager, a sync client — was destroyed with
// no error. The destination is now claimed with an exclusive create first.
test('a file that appears at the destination between check and move is not overwritten', async () => {
  await withMusicDir(async (dir) => {
    const src = path.join(dir, 'incoming.mp3');
    await fs.writeFile(src, 'new content');

    const dest = path.join(dir, 'Artist', 'Album', 'Title.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'PRE-EXISTING AND DIFFERENT');

    const result = await moveIntoLibrary(src, { artist: 'Artist', album: 'Album', title: 'Title' }, '.mp3');

    assert.equal(await fs.readFile(dest, 'utf8'), 'PRE-EXISTING AND DIFFERENT', 'the existing file survived');
    assert.equal(result.duplicate, false);
    assert.equal(result.movedTo, path.join(dir, 'Artist', 'Album', 'Title (2).mp3'));
    assert.equal(await fs.readFile(result.movedTo, 'utf8'), 'new content');
  });
});

test('a byte-identical file already in place is reported as a duplicate and the source is left alone', async () => {
  await withMusicDir(async (dir) => {
    const src = path.join(dir, 'incoming.mp3');
    await fs.writeFile(src, 'same bytes');
    const dest = path.join(dir, 'Artist', 'Album', 'Title.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'same bytes');

    const result = await moveIntoLibrary(src, { artist: 'Artist', album: 'Album', title: 'Title' }, '.mp3');
    assert.equal(result.duplicate, true);
    assert.equal(result.movedTo, null);
    assert.ok(fsSync.existsSync(src), 'the source is left in place for review');
  });
});

test('successive collisions keep counting up rather than reusing a suffix', async () => {
  await withMusicDir(async (dir) => {
    const meta = { artist: 'Artist', album: 'Album', title: 'Title' };
    const moved = [];
    for (let i = 0; i < 3; i += 1) {
      const src = path.join(dir, `in-${i}.mp3`);
      await fs.writeFile(src, `content ${i}`);
      moved.push((await moveIntoLibrary(src, meta, '.mp3')).movedTo);
    }
    assert.deepEqual(moved.map((p) => path.basename(p)), ['Title.mp3', 'Title (2).mp3', 'Title (3).mp3']);
  });
});

test('a failed move leaves no placeholder or .partial file behind', async () => {
  await withMusicDir(async (dir) => {
    // A source that vanishes after the destination has been claimed is the
    // cheapest way to fail the rename; a half-finished cross-device copy used to
    // leave a .partial sitting in the library forever, invisible to the scanner
    // because it has no audio extension.
    const src = path.join(dir, 'ghost.mp3');
    await assert.rejects(
      moveIntoLibrary(src, { artist: 'Artist', album: 'Album', title: 'Title' }, '.mp3'),
    );
    const albumDir = path.join(dir, 'Artist', 'Album');
    const left = fsSync.existsSync(albumDir) ? await fs.readdir(albumDir) : [];
    assert.deepEqual(left, [], 'no zero-byte placeholder and no .partial remain');
  });
});
