# Moving a duplicate aside — Implementation Plan

> **Superseded in part.** Mid-flight, the human ruled that a trash-path collision refuses with a 409
> instead of suffixing onto `" (2)"` — see the spec's "The trash mirrors the library layout" decision
> and `duplicateTrash.js`'s `trashLockedCopy`. This plan predates that ruling and still specifies the
> opposite: **Task 1**'s `claimFreeName` deliverable (its Interfaces list and Steps 1, 3–5), the
> `claimFreeName` tests in its Step 1 code block, and **Task 3**'s "a name already taken in the trash
> is suffixed, never overwritten" test in its Step 1 code block all describe or test the suffixing
> behaviour the ruling removed. What was actually built instead: both `trashDuplicate` and
> `restoreDuplicate` claim their destination exactly with a plain `fs.open(dest, 'wx')` and throw
> `ConflictError` on `EEXIST`; `claimFreeName` and its suffixing tests were never added.
> `withSuffix`/`MAX_COLLISION_SUFFIX` did land in `lib/moveFile.js` as shown, but unused by the trash
> flow — `organize.js`'s `claimDestination` is their only caller. Re-executing this plan as written
> would rebuild the exact hazard the ruling exists to remove: a suffixed trash path breaks the
> trash/restore symmetry Undo depends on (see the spec's "Restore recomputes the mirrored path fresh"
> paragraph). This plan is left otherwise unedited as a historical record of how the work was
> sequenced; treat the spec as authoritative wherever the two disagree.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Duplicates view a per-copy **Move aside** button that relocates a redundant file
into `MUSIC_DIR/.spinmatch-trash`, mirroring the library layout, with an Undo — and no deletion
anywhere.

**Architecture:** The move primitive already exists inside `organize.js` (claim a name with an
exclusive create, `rename()`, fall back to copy+unlink on `EXDEV`). It is extracted to
`server/src/lib/moveFile.js` so ingest and the new trash flow share one implementation. A new
`server/src/services/duplicateTrash.js` composes it with the existing containment guards, the
per-path file lock, and `reindexFile` — which already knows how to mark a row removed when the file
it stats is gone. Two thin POST routes and a per-row button in `DuplicatesTab.jsx` sit on top.

**Tech Stack:** Node 22+ ESM, Express, `node:sqlite` via `lib/db.js`, `node:test` with
`--experimental-test-module-mocks`, React 18 + Vite (no client test runner).

**Spec:** `docs/superpowers/specs/2026-07-27-duplicate-trash-design.md`

## Global Constraints

- **Server is ESM.** `server/package.json` sets `"type": "module"`. Use `import`, never `require`.
- **No new dependencies.** Not for the server, not for the client. Nothing here needs one.
- **Server tests:** `npm test` from the repo root (delegates to `npm run test -w server`, which runs
  `node --experimental-test-module-mocks --test "test/**/*.test.js"`). Tests use `node:test` and
  `node:assert/strict`, and open an in-memory DB with `openDb(':memory:')`.
- **The client has no test runner.** No vitest, no jest, no React Testing Library, and this change
  does not add one. Client changes are verified with `npm run build` plus a described visual check.
  Do not invent a client test harness.
- **Spinmatch never deletes a file.** Nothing in this plan may call `fs.unlink`, `fs.rm`, or
  `fs.rmdir` on a file in the user's library. The only `unlink` calls permitted are the ones inside
  `moveFile.js` that remove *its own* zero-byte placeholder and `.partial` temp file on a failed
  move, and the `unlink` of the source after a successful cross-device copy.
- **No "Empty trash".** Not a route, not a button, not a helper. Emptying the trash is the user's
  job, performed outside Spinmatch.
- **The trash folder is `.spinmatch-trash`,** dot-prefixed, directly under `MUSIC_DIR`. The dot is
  load-bearing — `walk()` in `libraryScanner.js:50` skips dot-prefixed entries, which is the only
  reason the trash stays out of the index. Do not add a scanner exclusion list.
- **No configuration.** No new environment variable, nothing added to `.env.example`.

---

### Task 1: Extract the move primitive into `lib/moveFile.js`

`organize.js:113-140` holds the only correct file-move implementation in the codebase, and the trash
flow needs it verbatim. It moves to its own module, with `organize.js` refactored to call it. This
task is pure refactoring plus its own unit tests — no new product behaviour — so the proof it worked
is `organize.test.js` passing unchanged.

**Files:**
- Create: `server/src/lib/moveFile.js`
- Modify: `server/src/services/organize.js` (delete local `withSuffix` at 56-60,
  `MAX_COLLISION_SUFFIX` at 65, and the rename/`EXDEV` block at 113-140)
- Test: `server/test/moveFile.test.js` (new); `server/test/organize.test.js` must pass unchanged

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `claimFreeName(destPath: string): Promise<string>` — creates an empty file at `destPath`, or at
    `destPath` with a ` (2)`, ` (3)`… suffix inserted before the extension if taken. Returns the
    path actually created. Throws on any error other than `EEXIST`.
  - `moveOnto(src: string, claimedDest: string): Promise<string>` — moves `src` onto an
    already-claimed `claimedDest`, returns `claimedDest`. On failure, removes its own placeholder
    and any `.partial` temp file, then rethrows.
  - `withSuffix(destPath: string, n: number): string` — `'/a/b/T.mp3', 2` → `'/a/b/T (2).mp3'`.
  - `MAX_COLLISION_SUFFIX: number` — `999`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/moveFile.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx node --experimental-test-module-mocks --test test/moveFile.test.js`
Expected: FAIL — `Cannot find module '.../src/lib/moveFile.js'`.

- [ ] **Step 3: Create `server/src/lib/moveFile.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

// The one place a file is moved from A to B.
//
// Extracted from organize.js, which had the only correct implementation of this
// and needed it for ingest; the duplicate-trash flow needs exactly the same
// thing. Two copies would mean a future fix landing in only one of them.

// How many " (n)" suffixes to try before giving up. Bounded because the loop
// that finds a free name is otherwise unbounded, and a directory that somehow
// contains thousands of collisions is a fault to report, not to grind through.
export const MAX_COLLISION_SUFFIX = 999;

export function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// Reserves a name at (or beside) destPath by creating an empty file at it, and
// returns the path actually claimed.
//
// Creating the file is the whole point. A check-then-rename leaves a window in
// which something else can take the name — a concurrent ingest, a file manager,
// a sync client — and rename() overwrites silently, so whatever arrived in that
// window is destroyed with no error. `wx` fails if the path exists, which turns
// the race into an EEXIST to retry rather than a deleted track.
//
// organize.js deliberately does NOT use this: ingest wants to compare a
// colliding file's bytes and report a re-ingest, which is an ingest policy
// rather than a property of claiming a name.
export async function claimFreeName(destPath) {
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
    const candidate = n === 1 ? destPath : withSuffix(destPath, n);
    let handle;
    try {
      handle = await fs.open(candidate, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      continue;
    }
    await handle.close();
    return candidate;
  }
  throw new Error(`could not find a free filename for ${path.basename(destPath)} after ${MAX_COLLISION_SUFFIX} attempts`);
}

// Moves src onto claimedDest, which the caller has already reserved. The rename
// therefore overwrites our own placeholder, and nothing else can have taken the
// name in the meantime, because we are holding it.
export async function moveOnto(src, claimedDest) {
  try {
    await fs.rename(src, claimedDest);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      // Don't leave the placeholder behind as a 0-byte "track" for the scanner
      // to index (it has an audio extension, so it would be indexed).
      await fs.unlink(claimedDest).catch(() => {});
      throw err;
    }
    // Cross-device: copy through a temp name in the destination directory, then
    // rename over the placeholder. The temp file is cleaned up on failure —
    // previously a copy that died part-way (a full disk, which is the common
    // cause of a cross-device copy failing) left a `.partial` file behind
    // forever, invisible to the scanner and accumulating on every retry.
    const partial = `${claimedDest}.partial`;
    try {
      await fs.copyFile(src, partial);
      await fs.rename(partial, claimedDest);
      await fs.unlink(src);
    } catch (copyErr) {
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(claimedDest).catch(() => {});
      throw copyErr;
    }
  }
  return claimedDest;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx node --experimental-test-module-mocks --test test/moveFile.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Refactor `organize.js` to use the shared module**

In `server/src/services/organize.js`, add to the imports at the top:

```js
import { withSuffix, MAX_COLLISION_SUFFIX, moveOnto } from '../lib/moveFile.js';
```

Delete the local `withSuffix` function (lines 56-60) and the local `MAX_COLLISION_SUFFIX` constant
with its comment (lines 62-65). Leave `claimDestination` in place — its byte-comparison branch is an
ingest policy — but it now uses the imported `withSuffix` and `MAX_COLLISION_SUFFIX`, which requires
no edit to its body.

Replace the whole `try`/`catch` block in `moveIntoLibrary` (lines 113-140) with:

```js
  await moveOnto(srcPath, dest);
```

so the function ends:

```js
  const dest = await claimDestination(srcPath, initialDest);
  if (dest === null) {
    return { movedTo: null, duplicate: true };
  }

  await moveOnto(srcPath, dest);

  return { movedTo: dest, duplicate: false };
}
```

Also update the comment above `claimDestination` (lines 69-76) so it points at the new home of the
race explanation rather than repeating it — keep the first paragraph, and replace the "The claim is
what makes this safe…" paragraph with:

```js
// The claim is what makes this safe; lib/moveFile.js explains the race it
// closes. What is specific to ingest is the branch below: a colliding file with
// identical bytes is a re-ingest of something the library already has, so the
// source is left alone for review rather than filed a second time.
```

- [ ] **Step 6: Run the full server suite**

Run: `npm test` (from the repo root)
Expected: PASS. `organize.test.js` in particular must pass **unchanged** — that is the regression
proof for touching the ingest write path. Its `EXDEV` test mocks `fs.rename` on the default
`node:fs/promises` export, which is the same module object `moveFile.js` imports, so the mock still
reaches the moved code.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/moveFile.js server/src/services/organize.js server/test/moveFile.test.js
git commit -m "Give ingest's file move its own home so the trash can share it"
```

---

### Task 2: Repository helpers for the guard and for Undo

Two small queries. `getTrackById` filters `removed = 0` (`libraryRepo.js:364-368`), so Undo cannot
use it to find a row it has just marked removed; and `TRACK_COLUMNS` (line 270) does not include
`dup_key`, so the last-copy guard cannot read it off a track either.

**Files:**
- Modify: `server/src/services/libraryRepo.js` (add both functions after `getTrackById`, ~line 368)
- Test: `server/test/libraryRepo.test.js`

**Interfaces:**
- Consumes: `withSuffix` etc. from Task 1 — not used here.
- Produces:
  - `getRemovedTrackById(db, id): object | null` — the same row shape `getTrackById` returns
    (including `path`), but matching `removed = 1` instead of `removed = 0`.
  - `liveCopyCountForTrack(db, id): number` — how many live rows share this track's `dup_key`,
    counting the track itself. `0` for an unknown id, and `0` for a row whose `dup_key` is null.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/libraryRepo.test.js`:

```js
// The last-copy guard and Undo both need to ask questions the rest of the app
// never asks: how many live copies share this key, and where did a row that has
// been marked removed used to live.
test('liveCopyCountForTrack counts every live copy sharing the key, itself included', () => {
  const db = openDb(':memory:');
  upsertLocalTrack(db, { path: '/m/a.flac', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  upsertLocalTrack(db, { path: '/m/b.mp3', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '2:1' });
  const [a, b] = db.prepare('SELECT id FROM local_tracks ORDER BY path').all();

  assert.equal(liveCopyCountForTrack(db, a.id), 2);
  assert.equal(liveCopyCountForTrack(db, b.id), 2);
});

test('liveCopyCountForTrack stops counting a copy once it is marked removed', () => {
  const db = openDb(':memory:');
  upsertLocalTrack(db, { path: '/m/a.flac', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  upsertLocalTrack(db, { path: '/m/b.mp3', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '2:1' });
  const [a] = db.prepare('SELECT id FROM local_tracks ORDER BY path').all();

  markRemovedByPath(db, '/m/b.mp3');
  assert.equal(liveCopyCountForTrack(db, a.id), 1);
});

test('liveCopyCountForTrack returns 0 for an unknown id', () => {
  const db = openDb(':memory:');
  assert.equal(liveCopyCountForTrack(db, 999), 0);
});

test('getRemovedTrackById finds a row the rest of the app is right to hide', () => {
  const db = openDb(':memory:');
  upsertLocalTrack(db, { path: '/m/a.flac', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  const { id } = db.prepare('SELECT id FROM local_tracks').get();

  assert.equal(getRemovedTrackById(db, id), null, 'a live row is not in the trash');

  markRemovedByPath(db, '/m/a.flac');
  assert.equal(getTrackById(db, id), null, 'and the live lookup no longer finds it');
  assert.equal(getRemovedTrackById(db, id).path, '/m/a.flac');
});
```

Add `getRemovedTrackById`, `liveCopyCountForTrack`, `markRemovedByPath` and `getTrackById` to that
file's existing import list from `../src/services/libraryRepo.js` if they are not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx node --experimental-test-module-mocks --test test/libraryRepo.test.js`
Expected: FAIL — `liveCopyCountForTrack is not a function`.

- [ ] **Step 3: Add both functions to `libraryRepo.js`**

Insert directly after `getTrackById` (which ends at line 368):

```js
// The removed = 1 sibling of getTrackById. Undoing a move-aside has to find a
// row that every other reader in the app is right to hide, so this is a separate
// function rather than a flag on that one — no caller should be able to get a
// removed track back by accident.
export function getRemovedTrackById(db, id) {
  return db.prepare(
    `SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks WHERE id = ? AND removed = 1`
  ).get(id) ?? null;
}

// How many live copies share this track's dup_key, counting the track itself.
//
// Counted over the same dup_key findDuplicateGroups groups by, so the last-copy
// guard and the list the user is looking at can never disagree about what a
// group contains. A row with no dup_key (no artist, or no title) counts 0 rather
// than 1: it is not part of any group, and the guard reads that as "refuse".
export function liveCopyCountForTrack(db, id) {
  return db.prepare(`
    SELECT COUNT(*) c FROM local_tracks
    WHERE removed = 0 AND dup_key IS NOT NULL
      AND dup_key = (SELECT dup_key FROM local_tracks WHERE id = ?)
  `).get(id).c;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx node --experimental-test-module-mocks --test test/libraryRepo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/libraryRepo.js server/test/libraryRepo.test.js
git commit -m "Ask the index two questions only the trash needs answered"
```

---

### Task 3: The move-aside service

The feature's core. Includes `ConflictError`, which has no independent deliverable and belongs to
the first thing that throws it.

**Files:**
- Create: `server/src/services/duplicateTrash.js`
- Modify: `server/src/lib/httpErrors.js` (add `ConflictError`)
- Test: `server/test/duplicateTrash.test.js` (new)

**Interfaces:**
- Consumes: `claimFreeName`, `moveOnto` (Task 1); `liveCopyCountForTrack` (Task 2);
  `getTrackById`, `markRemovedByPath` (existing); `reindexFile(filePath): Promise<{indexed: boolean}>`
  (existing, `libraryScanner.js:243`); `assertInsideMusicDir(p): string` and
  `assertReadableInsideMusicDir(p): Promise<string>` (existing, `lib/paths.js`);
  `withFileLock(path, fn)` (existing); `noteWrite(path)` (existing, `lib/recentWrites.js`).
- Produces:
  - `TRASH_DIR_NAME: string` — `'.spinmatch-trash'`.
  - `trashPathFor(filePath: string): string` — pure and synchronous.
  - `trashDuplicate({ trackId, db? }): Promise<{trackId: number, trashedPath: string, remainingCopies: number}>`
  - `ConflictError` in `httpErrors.js` — `status: 409`, `code: 'CONFLICT'`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/duplicateTrash.test.js`:

```js
// Moving a duplicate aside. Three contracts matter here, and each of them is a
// way this feature could lose someone's music rather than merely misbehave:
// the file must end up somewhere findable, the last live copy of a track must
// never be movable, and a failed move must leave the index exactly as it was —
// a row marked removed while its file is still in the library is a track that
// has silently vanished from the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const musicDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-trash-'));
process.env.MUSIC_DIR = musicDir;

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const configModule = await import('../src/config.js');

// The scanner re-reads tags on the restore path; no real audio file is involved
// in these tests, so readTags is mocked the way libraryFix.test.js does it.
const { mock } = await import('node:test');
mock.module('../src/services/tags.js', {
  namedExports: {
    readTags: async () => ({ artist: 'A', album: 'Al', title: 'One', durationMs: 1000 }),
    readCoverArt: async () => null,
    writeTags: async () => ({ filledFields: [] }),
  },
});

const { trashDuplicate, trashPathFor, TRASH_DIR_NAME } = await import('../src/services/duplicateTrash.js');

// Two copies of one track, both as real (empty) files, both indexed. Returns
// their ids in path order.
async function seedTwoCopies(db, { names = ['a.flac', 'b.mp3'] } = {}) {
  const ids = [];
  for (const [i, name] of names.entries()) {
    const full = path.join(musicDir, 'A', 'Al', name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `bytes-${i}`);
    repo.upsertLocalTrack(db, {
      path: full, artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: `${i}:1`,
    });
  }
  for (const row of db.prepare('SELECT id, path FROM local_tracks ORDER BY path').all()) ids.push(row);
  return ids;
}

function freshDb() {
  const db = openDb(':memory:');
  setDbForTest(db);
  return db;
}

test.beforeEach(async () => {
  configModule.config.ingest.musicDir = musicDir;
  await fs.rm(path.join(musicDir, 'A'), { recursive: true, force: true });
  await fs.rm(path.join(musicDir, TRASH_DIR_NAME), { recursive: true, force: true });
});

test.after(async () => {
  setDbForTest(null);
  await fs.rm(musicDir, { recursive: true, force: true });
});

test('trashPathFor mirrors the library layout under the trash folder', () => {
  configModule.config.ingest.musicDir = musicDir;
  assert.equal(
    trashPathFor(path.join(musicDir, 'Nick Cave', 'Tender Prey', '01 - The Mercy Seat.flac')),
    path.join(musicDir, TRASH_DIR_NAME, 'Nick Cave', 'Tender Prey', '01 - The Mercy Seat.flac'),
  );
});

test('moves the file to its mirrored path and marks the row removed', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);

  const result = await trashDuplicate({ trackId: first.id, db });

  assert.equal(result.trashedPath, path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac'));
  assert.equal(result.remainingCopies, 1);
  assert.ok(fsSync.existsSync(result.trashedPath), 'the file is in the trash');
  assert.ok(!fsSync.existsSync(first.path), 'and no longer in the library');
  assert.equal(repo.getTrackById(db, first.id), null, 'the row has left the live index');
  assert.equal(repo.getRemovedTrackById(db, first.id).path, first.path);
});

// The requirement, stated directly. This is the whole reason the guard is on the
// server: a page left open since yesterday is exactly the case where the
// browser's count of copies is the thing that is wrong.
test('refuses the last live copy and leaves the file where it is', async () => {
  const db = freshDb();
  const [first, second] = await seedTwoCopies(db);
  await trashDuplicate({ trackId: first.id, db });

  await assert.rejects(
    trashDuplicate({ trackId: second.id, db }),
    (err) => err.status === 409,
  );
  assert.ok(fsSync.existsSync(second.path), 'the only remaining copy is untouched');
});

test('refuses a track whose path is outside MUSIC_DIR', async () => {
  const db = freshDb();
  await seedTwoCopies(db);
  const outside = path.join(os.tmpdir(), 'spinmatch-outside.flac');
  await fs.writeFile(outside, 'bytes');
  repo.upsertLocalTrack(db, {
    path: outside, artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '9:1',
  });
  const { id } = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(outside);

  await assert.rejects(trashDuplicate({ trackId: id, db }), (err) => err.status === 400);
  assert.ok(fsSync.existsSync(outside), 'the file outside the library is untouched');
  await fs.rm(outside, { force: true });
});

test('refuses an unknown track id', async () => {
  const db = freshDb();
  await assert.rejects(trashDuplicate({ trackId: 4242, db }), (err) => err.status === 404);
});

test('a name already taken in the trash is suffixed, never overwritten', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const taken = path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a.flac');
  await fs.mkdir(path.dirname(taken), { recursive: true });
  await fs.writeFile(taken, 'an older trashed file');

  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });

  assert.equal(trashedPath, path.join(musicDir, TRASH_DIR_NAME, 'A', 'Al', 'a (2).flac'));
  assert.equal(await fs.readFile(taken, 'utf8'), 'an older trashed file', 'the older one survived');
});

// A row marked removed while its file is still sitting in the library is a
// track that has silently disappeared from the app, so the index must not be
// touched until the move has actually succeeded.
test('a failed move leaves the index untouched', async (t) => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);

  t.mock.method(fs, 'rename', async () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  });

  await assert.rejects(trashDuplicate({ trackId: first.id, db }));
  assert.ok(repo.getTrackById(db, first.id), 'the row is still live');
  assert.equal(repo.getRemovedTrackById(db, first.id), null);
});

// The dot prefix is the only thing keeping the trash out of the index, so this
// is a dependency of the feature rather than a happy accident.
test('the trash folder is invisible to a library scan', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  await trashDuplicate({ trackId: first.id, db });

  const { runScanOnce } = await import('../src/services/libraryScanner.js');
  await runScanOnce();

  const paths = db.prepare('SELECT path FROM local_tracks WHERE removed = 0').all().map((r) => r.path);
  assert.ok(
    !paths.some((p) => p.includes(TRASH_DIR_NAME)),
    `a trashed file was indexed: ${paths.join(', ')}`,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx node --experimental-test-module-mocks --test test/duplicateTrash.test.js`
Expected: FAIL — `Cannot find module '.../src/services/duplicateTrash.js'`.

- [ ] **Step 3: Add `ConflictError` to `httpErrors.js`**

Append to `server/src/lib/httpErrors.js`:

```js
// The request was understood and refused because of the state of things, not
// because of anything wrong with the request. Used by the duplicate trash to
// refuse moving aside a track's last live copy.
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.status = 409;
  }
}
```

`middleware/errorHandler.js` maps on `err.status` and passes the message through for anything that
is not a 500, so no other change is needed.

- [ ] **Step 4: Create `server/src/services/duplicateTrash.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { getTrackById, liveCopyCountForTrack } from './libraryRepo.js';
import { reindexFile } from './libraryScanner.js';
import { assertInsideMusicDir, assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { claimFreeName, moveOnto } from '../lib/moveFile.js';
import { noteWrite } from '../lib/recentWrites.js';
import { NotFoundError, BadRequestError, ConflictError } from '../lib/httpErrors.js';

// Moving a duplicate aside.
//
// Spinmatch never deletes a file, and this does not change that: a copy is
// relocated into MUSIC_DIR/.spinmatch-trash, which mirrors the library layout,
// and every byte the user had they still have. Reclaiming the space is a
// deliberate act performed outside this app — there is no "empty trash" here,
// now or later, because that is deletion with one indirection.
//
// The dot prefix is load-bearing. walk() in libraryScanner.js skips dot-prefixed
// entries, which is the only reason a trashed file leaves the index and stays
// out of it; there is no exclusion list to keep in sync.
export const TRASH_DIR_NAME = '.spinmatch-trash';

/**
 * Where a library file goes when it is moved aside. Pure: no db, no filesystem.
 *
 * Resolved lexically rather than through realpath, matching assertInsideMusicDir
 * and reindexFile — the two functions this flow actually calls — rather than
 * assertReadableInsideMusicDir. If MUSIC_DIR ever is a symlink, the relative
 * part below starts with "..", the result escapes the root, and the caller's
 * assertInsideMusicDir turns that into a 400 instead of a write outside the
 * library.
 */
export function trashPathFor(filePath) {
  const root = path.resolve(config.ingest.musicDir);
  return path.join(root, TRASH_DIR_NAME, path.relative(root, filePath));
}

// The filesystem failures worth naming for the person who clicked the button.
// writeLoop's describeFailure does this for tag writes and is worded for one
// ("could not be written to"); a move needs different verbs throughout, and it
// has a failure a tag write cannot have — ENOSPC, from the cross-device copy.
const MOVE_FAILURES = {
  ENOENT: 'The file is no longer there.',
  EACCES: 'The music folder is not writable.',
  EPERM: 'The music folder is not writable.',
  EROFS: 'The music folder is not writable.',
  ENOSPC: 'There is not enough room to move the file.',
  EIO: 'The storage holding this file stopped responding.',
  ESTALE: 'The storage holding this file stopped responding.',
  ENOTCONN: 'The storage holding this file stopped responding.',
};

// Errors that already carry a status were written for the browser and pass
// through. A known filesystem code becomes a message with no path in it (the
// path goes to the log). Anything else is left alone, so it reaches the error
// handler as a 500 with the full error logged.
function asMoveError(err, filePath) {
  if (err?.status) return err;
  const known = MOVE_FAILURES[err?.code];
  if (!known) return err;
  console.warn(`duplicateTrash: ${filePath} failed: ${err.code} ${err.message}`);
  return new BadRequestError(known);
}

/**
 * Moves one copy of a duplicated track into the trash folder.
 *
 * @returns {Promise<{trackId: number, trashedPath: string, remainingCopies: number}>}
 */
export async function trashDuplicate({ trackId, db = getDb() }) {
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');

  // Checked here rather than in the browser, and before anything touches the
  // disk. A page left open since yesterday is precisely the case where the
  // client's idea of how many copies exist is the thing that is out of date.
  const copies = liveCopyCountForTrack(db, trackId);
  if (copies < 2) {
    throw new ConflictError('This is the only copy of this track, so it cannot be moved aside.');
  }

  // The path comes from our own index and is still re-validated before the file
  // is touched — the same guard the cover, stream and tag-edit routes use.
  const real = await assertReadableInsideMusicDir(track.path);
  const dest = assertInsideMusicDir(trashPathFor(real));

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const claimed = await claimFreeName(dest);

    // Locked on the resolved path, so this queues behind (and ahead of) a tag
    // write to the same file rather than racing it — see lib/fileLock.js.
    await withFileLock(real, () => moveOnto(real, claimed));

    // Both ends of the move, so the recursive MUSIC_DIR watcher doesn't debounce
    // a full library rescan out of work the app just did itself. recentWrites is
    // keyed on basename, so these usually collapse into one entry.
    noteWrite(real);
    noteWrite(claimed);

    // Stats the (now absent) file, marks the row removed and recomputes stats,
    // all in one transaction — libraryScanner.js:249 was written for exactly
    // this case. Deliberately after the move: a failure above must leave the
    // index untouched, or the app shows a track as gone while it is still there.
    await reindexFile(real);

    return { trackId, trashedPath: claimed, remainingCopies: copies - 1 };
  } catch (err) {
    throw asMoveError(err, real);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx node --experimental-test-module-mocks --test test/duplicateTrash.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/duplicateTrash.js server/src/lib/httpErrors.js server/test/duplicateTrash.test.js
git commit -m "Move a duplicate aside instead of asking the user to go find it"
```

---

### Task 4: Undo

The mirror image, with one deliberate asymmetry: the original path is claimed **exactly**. Restoring
to `Title (2).flac` because something now occupies the original name would quietly manufacture a new
duplicate, which is a comic failure mode for this particular feature.

**Files:**
- Modify: `server/src/services/duplicateTrash.js`
- Test: `server/test/duplicateTrash.test.js`

**Interfaces:**
- Consumes: everything from Task 3, plus `getRemovedTrackById` (Task 2).
- Produces: `restoreDuplicate({ trackId, db? }): Promise<{trackId: number, restoredPath: string, track: object}>`

- [ ] **Step 1: Write the failing tests**

Add `restoreDuplicate` to the import from `../src/services/duplicateTrash.js` at the top of
`server/test/duplicateTrash.test.js`, then append:

```js
test('undo puts the file back where it was and returns it to the live index', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });

  const result = await restoreDuplicate({ trackId: first.id, db });

  assert.equal(result.restoredPath, first.path);
  assert.ok(fsSync.existsSync(first.path), 'the file is back in the library');
  assert.ok(!fsSync.existsSync(trashedPath), 'and gone from the trash');
  assert.ok(repo.getTrackById(db, first.id), 'the row is live again');
});

test('undo refuses when something else now occupies the original path', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  const { trashedPath } = await trashDuplicate({ trackId: first.id, db });
  await fs.writeFile(first.path, 'something else entirely');

  await assert.rejects(
    restoreDuplicate({ trackId: first.id, db }),
    (err) => err.status === 409,
  );
  assert.equal(await fs.readFile(first.path, 'utf8'), 'something else entirely', 'untouched');
  assert.ok(fsSync.existsSync(trashedPath), 'the trashed copy is still in the trash');
});

test('undo refuses a track that is not in the trash', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db);
  await assert.rejects(restoreDuplicate({ trackId: first.id, db }), (err) => err.status === 404);
});

test('undo recreates the album directory if it was cleaned up in the meantime', async () => {
  const db = freshDb();
  const [first] = await seedTwoCopies(db, { names: ['only.flac', 'other.mp3'] });
  await trashDuplicate({ trackId: first.id, db });
  // The user tidied up the now-emptier library by hand.
  await fs.rm(path.dirname(first.path), { recursive: true, force: true });

  await restoreDuplicate({ trackId: first.id, db });
  assert.ok(fsSync.existsSync(first.path));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx node --experimental-test-module-mocks --test test/duplicateTrash.test.js`
Expected: FAIL — `restoreDuplicate is not a function`.

- [ ] **Step 3: Implement `restoreDuplicate`**

Add `getRemovedTrackById` to the `./libraryRepo.js` import at the top of `duplicateTrash.js`, then
append to the file:

```js
/**
 * Puts a moved-aside copy back where it came from.
 *
 * Session-scoped in practice: the Duplicates view fetches live rows only, so a
 * reloaded page has no trashed row to offer an Undo for, and purgeRemoved
 * eventually deletes the row this looks up. Recovering after that is a move in a
 * file manager, which the mirrored layout makes obvious.
 *
 * @returns {Promise<{trackId: number, restoredPath: string, track: object}>}
 */
export async function restoreDuplicate({ trackId, db = getDb() }) {
  const track = getRemovedTrackById(db, trackId);
  if (!track) throw new NotFoundError('That track is not in the trash');

  // Lexical rather than symlink-safe: the file is not at this path any more, so
  // there is nothing to realpath. trashPathFor resolves the same way.
  const original = assertInsideMusicDir(track.path);
  const source = assertInsideMusicDir(trashPathFor(original));

  try {
    // The album directory may have been tidied away while the copy was aside.
    await fs.mkdir(path.dirname(original), { recursive: true });

    // Claimed exactly, unlike the move out: claimFreeName would restore to
    // "Title (2).flac" when something occupies the original name, quietly
    // manufacturing a new duplicate — a comic outcome for this feature. Refusing
    // leaves the copy in the trash, where the user can still get at it.
    let handle;
    try {
      handle = await fs.open(original, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new ConflictError('Something is already at that path, so the copy has been left in the trash.');
      }
      throw err;
    }
    await handle.close();

    await withFileLock(original, () => moveOnto(source, original));
    noteWrite(original);
    noteWrite(source);
    await reindexFile(original);

    return { trackId, restoredPath: original, track: getTrackById(db, trackId) };
  } catch (err) {
    throw asMoveError(err, original);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx node --experimental-test-module-mocks --test test/duplicateTrash.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/duplicateTrash.js server/test/duplicateTrash.test.js
git commit -m "Let a move aside be taken back"
```

---

### Task 5: The two routes

**Files:**
- Modify: `server/src/routes/library.js` (import at ~line 16, routes after the tag-edit routes at
  ~line 487)
- Test: `server/test/routes/library.test.js`

**Interfaces:**
- Consumes: `trashDuplicate`, `restoreDuplicate` (Tasks 3, 4).
- Produces: `POST /api/library/track/:id/trash` and `POST /api/library/track/:id/restore`, both
  returning the service result as JSON. Both already behind the auth `gate` applied to
  `/api/library` in `app.js:78`.

- [ ] **Step 1: Write the failing tests**

The existing `test/routes/library.test.js` seeds tracks at `/m/...` paths that do not exist on disk,
which is fine here: the 404 and 409 cases are decided before any filesystem call. Append:

```js
test('POST /api/library/track/:id/trash refuses an unknown track', async () => {
  const res = await fetch(`${baseUrl}/api/library/track/9999/trash`, { method: 'POST' });
  assert.equal(res.status, 404);
});

// The two seeded tracks have different titles, so neither is part of a
// duplicate group and neither may be moved aside. That is the guard's whole
// job, and asserting it here proves the route reaches it.
test('POST /api/library/track/:id/trash refuses a track with no duplicate', async () => {
  const { id } = db.prepare("SELECT id FROM local_tracks WHERE title = 'One'").get();
  const res = await fetch(`${baseUrl}/api/library/track/${id}/trash`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'CONFLICT');
});

test('POST /api/library/track/:id/restore refuses a track that is not in the trash', async () => {
  const { id } = db.prepare("SELECT id FROM local_tracks WHERE title = 'One'").get();
  const res = await fetch(`${baseUrl}/api/library/track/${id}/restore`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST /api/library/track/:id/trash rejects a non-numeric id', async () => {
  const res = await fetch(`${baseUrl}/api/library/track/abc/trash`, { method: 'POST' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx node --experimental-test-module-mocks --test test/routes/library.test.js`
Expected: FAIL — the routes 404 with the Express default rather than the asserted codes (the
`abc` case will return 404, not 400).

- [ ] **Step 3: Add the routes**

Add the import beside the other service imports in `server/src/routes/library.js`:

```js
import { trashDuplicate, restoreDuplicate } from '../services/duplicateTrash.js';
```

Add after the `POST /album/tags` route (which ends at line 487):

```js
// Moving a duplicate aside, and taking that back. Deliberately not DELETE:
// nothing is deleted, and naming the method after the thing this app refuses to
// do would be the wrong word in the wrong place.
libraryRouter.post('/track/:id/trash', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await trashDuplicate({ trackId }));
  } catch (err) {
    next(err);
  }
});

libraryRouter.post('/track/:id/restore', async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    if (!trackId) throw new BadRequestError('a track id is required');
    res.json(await restoreDuplicate({ trackId }));
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx node --experimental-test-module-mocks --test test/routes/library.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full server suite**

Run: `npm test` (from the repo root)
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/library.js server/test/routes/library.test.js
git commit -m "Put the move-aside behind two endpoints"
```

---

### Task 6: The button

**Files:**
- Modify: `client/src/api/library.js` (add after `getDuplicates`, line 57)
- Modify: `client/src/components/library/DuplicatesTab.jsx` (whole file)
- Modify: `client/src/styles/index.css` (add after `.duplicate-path`, line 1356)

**Interfaces:**
- Consumes: `POST /api/library/track/:id/trash` → `{trackId, trashedPath, remainingCopies}` and
  `POST /api/library/track/:id/restore` → `{trackId, restoredPath, track}` (Task 5).
- Produces: no exports other tasks depend on.

- [ ] **Step 1: Add the two API helpers**

In `client/src/api/library.js`, after `getDuplicates` (line 55-57):

```js
// Moves one copy of a duplicated track into MUSIC_DIR/.spinmatch-trash. Nothing
// is deleted — the file keeps its library layout under the trash folder, and
// restoreDuplicate below moves it back.
export function trashDuplicate(trackId) {
  return post(`/library/track/${trackId}/trash`, {});
}

export function restoreDuplicate(trackId) {
  return post(`/library/track/${trackId}/restore`, {});
}
```

- [ ] **Step 2: Rewrite `DuplicatesTab.jsx`**

Replace the whole file with:

```jsx
import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates, trashDuplicate, restoreDuplicate } from '../../api/library.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// Every copy of the same track from the same release, laid out so they can
// actually be compared — a count alone can't tell you whether you have a FLAC
// and a 128k MP3 of one album track or something you'd rather keep both of.
//
// A song that appears on two different albums never reaches this view: owning a
// track on its album and again on a compilation is owning two records, not two
// copies. Album is part of the match server-side, in libraryRepo's
// duplicateGroups.
//
// "Move aside" relocates a copy into MUSIC_DIR/.spinmatch-trash, which mirrors
// the library layout. Spinmatch still never deletes a file: every byte is still
// there, and reclaiming the space is something the user does themselves, once
// they've had a chance to change their mind.
export default function DuplicatesTab({ onPlay }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  // trackId -> where it was moved to. The whole move-aside UI derives from this:
  // which rows are struck through, what each group's live count is, and which
  // rows can still be moved.
  const [trashed, setTrashed] = useState({});
  // The row with a request in flight, so one click can't be double-fired.
  const [busy, setBusy] = useState(null);
  // Group key -> message. Per group rather than per page, so one group's failure
  // doesn't blank the rest of the list.
  const [groupErrors, setGroupErrors] = useState({});
  const { page, setPage, pageCount, pageItems } = usePagination(groups ?? [], 20);

  useEffect(() => {
    let cancelled = false;
    getDuplicates()
      .then((data) => { if (!cancelled) setGroups(data.groups); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const keyFor = (group) => `${group.artist}-${group.album}-${group.title}`;

  async function run(group, copy, action) {
    setBusy(copy.id);
    setGroupErrors((prev) => ({ ...prev, [keyFor(group)]: null }));
    try {
      await action();
    } catch (err) {
      setGroupErrors((prev) => ({ ...prev, [keyFor(group)]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  const moveAside = (group, copy) => run(group, copy, async () => {
    const { trashedPath } = await trashDuplicate(copy.id);
    setTrashed((prev) => ({ ...prev, [copy.id]: trashedPath }));
  });

  const undo = (group, copy) => run(group, copy, async () => {
    await restoreDuplicate(copy.id);
    setTrashed((prev) => {
      const next = { ...prev };
      delete next[copy.id];
      return next;
    });
  });

  if (error) return <p className="banner banner-error">{error}</p>;
  if (!groups) return <EqualizerLoader label="Finding duplicates…" />;
  if (groups.length === 0) {
    return <p className="muted">No duplicates — no track is indexed at more than one path within the same release.</p>;
  }

  return (
    <>
      <p className="muted">
        {groups.length.toLocaleString()} track{groups.length === 1 ? '' : 's'} indexed at more than
        one path within the same release. A song that also appears on a different album isn&apos;t
        counted as a duplicate. <strong>Spinmatch never deletes files;</strong> moving a copy aside
        puts it in <span className="mono">.spinmatch-trash</span> inside your music folder, where it
        keeps its artist and album layout. Delete that folder yourself when you want the space back.
      </p>

      {pageItems.map((group) => {
        const liveCopies = group.copies.filter((copy) => !trashed[copy.id]).length;
        const groupError = groupErrors[keyFor(group)];
        return (
          <div key={keyFor(group)} className="duplicate-group">
            <h3>
              {group.title}
              <span className="muted">— {group.artist} · {group.album ?? 'No album'}</span>
              {/* Not `group.copies.length` any more: once a copy is moved aside the
                  count has to drop, and it can now legitimately reach 1. */}
              <span className="badge badge-none">
                {liveCopies} {liveCopies === 1 ? 'copy' : 'copies'}
              </span>
            </h3>
            {groupError ? <p className="banner banner-error">{groupError}</p> : null}
            <table className="library-table">
              <thead>
                <tr>
                  <th aria-label="Play" /><th>#</th><th>Length</th>
                  <th>Format</th><th>Size</th><th>Path</th><th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {group.copies.map((copy) => {
                  const trashedPath = trashed[copy.id];
                  return (
                    <tr key={copy.id} className={trashedPath ? 'duplicate-copy-trashed' : undefined}>
                      <td>
                        {/* The album no longer tells two copies apart — they share it — and neither
                            does the format when a folder was simply copied twice. The path does. */}
                        <button
                          type="button"
                          className="play-button"
                          onClick={() => onPlay(copy, group.copies)}
                          disabled={Boolean(trashedPath)}
                          aria-label={`Play ${copy.title} — ${copy.path}`}
                        >
                          ▶
                        </button>
                      </td>
                      <td className="mono">{copy.trackNumber ?? '—'}</td>
                      <td className="mono">{formatDuration(copy.durationMs)}</td>
                      <td className="mono">{copy.ext ?? '—'}</td>
                      <td className="mono">{copy.sizeBytes ? formatBytes(copy.sizeBytes) : '—'}</td>
                      <td className="mono duplicate-path">{trashedPath ?? copy.path}</td>
                      <td>
                        {trashedPath ? (
                          <>
                            <span className="muted">Moved aside. </span>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => undo(group, copy)}
                              disabled={busy === copy.id}
                            >
                              Undo
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="copy-button"
                            onClick={() => moveAside(group, copy)}
                            disabled={busy === copy.id || liveCopies < 2}
                            title={liveCopies < 2
                              ? 'This is the only copy left — Spinmatch will not move it aside.'
                              : 'Move this copy into .spinmatch-trash'}
                          >
                            {busy === copy.id ? 'Moving…' : 'Move aside'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
```

- [ ] **Step 3: Add the style**

In `client/src/styles/index.css`, after the `.duplicate-path` rule (ends line 1356):

```css
/* A copy that has been moved aside stays on screen rather than vanishing: a row
   that disappears the instant it is clicked offers nothing to undo and no
   confirmation of what happened. Dimmed rather than struck through — the path
   in that row is the file's new home, not a dead link, and striking it out
   would say the opposite of what happened. */
.duplicate-copy-trashed {
  opacity: 0.55;
}
```

- [ ] **Step 4: Build the client**

Run: `cd client && npm run build`
Expected: PASS — Vite compiles the JSX and fails on syntax errors, which is the only automated
check this half of the codebase has.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/library.js client/src/components/library/DuplicatesTab.jsx client/src/styles/index.css
git commit -m "Offer to move a duplicate aside from the page that finds it"
```

---

### Task 7: Documentation and final verification

The page and the README both currently tell users that the button added in Task 6 does not exist.

**Files:**
- Modify: `README.md` (the Duplicates bullet, lines 221-227)
- Test: the whole suite, plus a manual check against a running app

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite the README's Duplicates bullet**

Replace lines 221-227 of `README.md` (the bullet beginning `- **Duplicates** —`) with:

```markdown
- **Duplicates** — the same artist, album, and title indexed at more than one path. Spinmatch shows
  the track number, length, format, size, and full path of every copy beside each other. Each copy
  also gets a play button, so you can compare them. The album is part of the match. A song on two
  different releases is therefore not a duplicate, and Spinmatch does not list it. An album track
  that is also on a compilation is the common example. What remains is real redundancy: a FLAC and a 128k MP3
  of the same album track, or a directory copied twice.

  Each copy also gets a **Move aside** button. It moves that file into a `.spinmatch-trash` folder
  inside your music folder, keeping the same artist and album layout, so
  `Music/Nick Cave/Tender Prey/01 - The Mercy Seat.flac` becomes
  `Music/.spinmatch-trash/Nick Cave/Tender Prey/01 - The Mercy Seat.flac`. **Spinmatch never deletes
  a file.** The move frees no space, which is the point: you clean up now, check the folder later,
  and delete it yourself when you are sure. Spinmatch has no button that empties the trash.

  Spinmatch refuses to move aside the last copy of a track, so a group can never be emptied by
  accident. An **Undo** appears next to a copy you have just moved and puts it straight back. Undo
  is there while the page is open; after that, moving the file back by hand is easy, because the
  trash mirrors your library.
```

- [ ] **Step 2: Verify the whole suite passes**

Run: `npm test` (from the repo root)
Expected: PASS, every test, no skips beyond the pre-existing root-user skips in
`dbPreflight.test.js`.

- [ ] **Step 3: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual check against a running app**

With `MUSIC_DIR` pointed at a folder containing two copies of one track (same artist, album and
title — copying a file and renaming it is enough), start the app and open **Your Library →
Duplicates**:

1. The group shows `2 copies` and both rows have a **Move aside** button.
2. Click one. The row goes dim, its path cell now shows the `.spinmatch-trash` location, the header
   reads `1 copy`, and the remaining row's button is disabled with a tooltip explaining why.
3. The file is on disk at `MUSIC_DIR/.spinmatch-trash/<artist>/<album>/<file>`.
4. Click **Undo**. The file returns to its original path, the header reads `2 copies` again, and
   both buttons are live.
5. Reload the page. The group is intact, since nothing was deleted.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Tell people about the button instead of about its absence"
```

---

## Notes for the implementer

**Three places this plan deliberately departs from what the codebase does elsewhere:**

1. `restoreDuplicate` claims the destination *exactly* while `trashDuplicate` claims a free name.
   That asymmetry is intentional and explained in the code comment — do not "fix" it by making both
   use `claimFreeName`.
2. `trashPathFor` resolves lexically, not through `realpath`, even though the path it is handed came
   from `assertReadableInsideMusicDir` (which does use `realpath`). The spec's
   `server/src/services/duplicateTrash.js` section explains why; the short version is that
   `assertInsideMusicDir` and `reindexFile`, the two functions this flow actually calls, both compare
   against the lexically resolved root.
3. `duplicateTrash.js` has its own `MOVE_FAILURES` table rather than reusing `describeFailure` from
   `lib/writeLoop.js`. Do not merge them; the spec's `server/src/lib/writeLoop.js` section covers it.

**The one thing most likely to go wrong:** forgetting that `reindexFile` must be called *after* the
move and never before. A row marked removed while its file is still in the library is a track that
has silently disappeared from the app, and no test outside `duplicateTrash.test.js` would catch it.
