// The one place a file is moved from A to B, shared by ingest and the
// duplicate-trash flow. The contracts worth pinning down are that a claimed
// name is never silently overwritten, that a cross-device move still works,
// and that a failure leaves no debris behind — a zero-byte placeholder has an
// audio extension, so the scanner would happily index it as a track.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { claimFreeName, moveOnto, withSuffix } = await import('../src/lib/moveFile.js');

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-move-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('withSuffix inserts the number before the extension', () => {
  assert.equal(withSuffix('/a/b/Title.mp3', 2), '/a/b/Title (2).mp3');
  assert.equal(withSuffix('/a/b/No-extension', 3), '/a/b/No-extension (3)');
});

test('claimFreeName creates the file at the requested path when it is free', async () => {
  await withTmpDir(async (dir) => {
    const dest = path.join(dir, 'Title.mp3');
    assert.equal(await claimFreeName(dest), dest);
    assert.equal((await fs.stat(dest)).size, 0);
  });
});

test('claimFreeName counts up past every taken name', async () => {
  await withTmpDir(async (dir) => {
    const dest = path.join(dir, 'Title.mp3');
    await fs.writeFile(dest, 'existing');
    await fs.writeFile(path.join(dir, 'Title (2).mp3'), 'also existing');
    assert.equal(await claimFreeName(dest), path.join(dir, 'Title (3).mp3'));
    assert.equal(await fs.readFile(dest, 'utf8'), 'existing', 'the original is untouched');
  });
});

test('moveOnto replaces the claimed placeholder with the source file', async () => {
  await withTmpDir(async (dir) => {
    const src = path.join(dir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');
    const dest = await claimFreeName(path.join(dir, 'dest.mp3'));

    assert.equal(await moveOnto(src, dest), dest);
    assert.equal(await fs.readFile(dest, 'utf8'), 'audio-bytes');
    assert.ok(!fsSync.existsSync(src), 'the source is gone');
  });
});

test('moveOnto falls back to copy+unlink on a cross-device rename', async (t) => {
  await withTmpDir(async (dir) => {
    const src = path.join(dir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');
    const dest = await claimFreeName(path.join(dir, 'dest.mp3'));

    // Mocked on the default fs/promises export — the same object moveFile.js
    // imports. Mocking the namespace's named export fails with "Cannot redefine
    // property" because those bindings are non-configurable.
    let calls = 0;
    const realRename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('cross-device link');
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    });

    assert.equal(await moveOnto(src, dest), dest);
    assert.equal(await fs.readFile(dest, 'utf8'), 'audio-bytes');
    assert.ok(!fsSync.existsSync(src), 'the source is gone');
  });
});

test('a failed moveOnto leaves no placeholder and no .partial behind', async () => {
  await withTmpDir(async (dir) => {
    // A source that does not exist is the cheapest way to fail the rename.
    const dest = await claimFreeName(path.join(dir, 'dest.mp3'));
    await assert.rejects(moveOnto(path.join(dir, 'ghost.mp3'), dest));
    assert.deepEqual(await fs.readdir(dir), [], 'nothing left in the directory');
  });
});

test('a failed cross-device moveOnto cleans up its .partial too', async (t) => {
  await withTmpDir(async (dir) => {
    const src = path.join(dir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');
    const dest = await claimFreeName(path.join(dir, 'dest.mp3'));

    t.mock.method(fs, 'rename', async () => {
      const err = new Error('cross-device link');
      err.code = 'EXDEV';
      throw err;
    });

    await assert.rejects(moveOnto(src, dest));
    assert.deepEqual(await fs.readdir(dir), ['source.mp3'], 'only the untouched source remains');
  });
});
