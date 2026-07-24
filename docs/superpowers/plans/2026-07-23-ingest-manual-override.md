# Ingest Manual Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user manually resolve a loose ingest file that AcoustID couldn't confidently auto-match, by picking either an AcoustID near-miss or a MusicBrainz text-search result, so it gets tagged and moved into the library the same way an auto-confirmed match would be.

**Architecture:** Backend: tag `needsReview` entries with a `code` so the client can tell which are override-eligible; extract the existing "tag + move a confirmed recording" logic out of `processLooseFile` into a standalone function so both the automatic path and a new manual-resolve path share it; add two new `/api/ingest/file/*` endpoints (list near-miss candidates, resolve to a chosen recording). Frontend: a new inline picker component wired into the existing needs-review table in `IngestPanel`.

**Tech Stack:** Express (backend routes/services), `node:test` + `undici` MockAgent + `t.mock.module` (backend tests), React (frontend), existing `client/src/api/client.js` fetch wrapper.

## Global Constraints

- Scope is loose files only — album-folder review items (`code: 'album_incoherent'`) are not overridable in this feature (see spec).
- `path` values are client-supplied on the two new endpoints and MUST be validated to resolve inside `INGEST_DIR` before any filesystem/service call, mirroring `organize.js`'s `assertInsideMusicDir` pattern.
- `POST /api/ingest/file/resolve` mutates the filesystem, so it MUST use the existing `sameOriginOnly` CSRF guard, same as `/ingest/process`.
- No live network calls in backend tests — mock `fpcalc`/`acoustid`/`musicbrainz` via `t.mock.module`, following the cache-busting fresh-import pattern already used in `server/test/ingest.test.js`.
- Frontend tests for the new picker component are explicitly out of scope for this plan (deferred to the separate frontend-test-infrastructure project).

---

### Task 1: Tag `needsReview` entries with a `code`

**Files:**
- Modify: `server/src/services/ingest.js`
- Test: `server/test/ingest.test.js`

**Interfaces:**
- Produces: every `needsReview` object now has a `code` field, one of `'no_match' | 'duplicate' | 'move_failed' | 'album_incoherent'`, alongside the existing `path`, `name`, `reason`.

- [ ] **Step 1: Add failing assertions to existing tests**

In `server/test/ingest.test.js`, add one `assert.equal(..., 'code', ...)` line to each of these six existing tests, right after their existing `needsReview[0].reason` assertion:

```js
// in 'a confirmed loose file whose move fails is reported as tagged-but-not-moved'
assert.equal(result.needsReview[0].code, 'move_failed');

// in 'a byte-identical duplicate is left in place and reported as needsReview'
assert.equal(result.needsReview[0].code, 'duplicate');

// in 'processIngest reports needsReview when AcoustID finds no candidates'
assert.equal(result.needsReview[0].code, 'no_match');

// in 'processIngest reports needsReview when no AcoustID candidate meets the confidence threshold'
assert.equal(result.needsReview[0].code, 'no_match');

// in 'processIngest reports needsReview when duration/score confirmation fails'
assert.equal(result.needsReview[0].code, 'no_match');

// in 'an incoherent album folder (track count mismatch) is left untouched and reported as needsReview'
assert.equal(result.needsReview[0].code, 'album_incoherent');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: the six modified tests FAIL with `AssertionError` (`undefined` !== the expected code string).

- [ ] **Step 3: Add the `code` field in `ingest.js`**

In `processLooseFile`, change:

```js
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, reason } };
  }
```

to:

```js
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, code: 'no_match', reason } };
  }
```

In `moveFileSafely`, change:

```js
  } catch (err) {
    return {
      needsReview: {
        path: filePath,
        name,
        reason: `tagged in place, but could not be moved into the library: ${err.message}`,
      },
    };
  }
  if (result.duplicate) {
    return {
      needsReview: {
        path: filePath,
        name,
        reason: 'an identical file already exists in the library; left in place for review',
      },
    };
  }
```

to:

```js
  } catch (err) {
    return {
      needsReview: {
        path: filePath,
        name,
        code: 'move_failed',
        reason: `tagged in place, but could not be moved into the library: ${err.message}`,
      },
    };
  }
  if (result.duplicate) {
    return {
      needsReview: {
        path: filePath,
        name,
        code: 'duplicate',
        reason: 'an identical file already exists in the library; left in place for review',
      },
    };
  }
```

In `processAlbumFolder`, change:

```js
  const identified = await identifyAlbum(files);
  if (identified.reason) {
    return { needsReview: [{ path: item.path, name: item.name, reason: identified.reason }] };
  }
```

to:

```js
  const identified = await identifyAlbum(files);
  if (identified.reason) {
    return { needsReview: [{ path: item.path, name: item.name, code: 'album_incoherent', reason: identified.reason }] };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ingest.js server/test/ingest.test.js
git commit -m "Tag ingest needsReview entries with a code"
```

---

### Task 2: Extract `finalizeLooseFile` from `processLooseFile`

**Files:**
- Modify: `server/src/services/ingest.js`

**Interfaces:**
- Consumes: nothing new — pure refactor of existing logic already covered by Task 1's passing tests.
- Produces: `async function finalizeLooseFile(filePath, name, confirmed, { dryRun })` — given an already-resolved MusicBrainz recording object (the shape returned by `getRecording`: `{ mbid, title, lengthMs, artist, releaseGroups, date }`), tags and moves the file. Returns `{ matched: {...} }` or `{ needsReview: {...} }`, same shape `processLooseFile` returns today. Later tasks (3, 4) call this directly.

- [ ] **Step 1: Replace `processLooseFile` with `processLooseFile` + `finalizeLooseFile`**

Change:

```js
async function processLooseFile(item, { dryRun }) {
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, code: 'no_match', reason } };
  }

  const current = await tags.readTags(item.path);
  const releaseGroup = confirmed.releaseGroups[0];
  const coverImage = releaseGroup ? await getFrontCoverImage(releaseGroup.mbid) : null;

  // A track with no release group has no real album — leave the album *tag*
  // empty (don't fabricate one), but file it under a "Singles" folder.
  const albumTitle = releaseGroup?.title ?? null;
  const desired = {
    artist: confirmed.artist,
    title: confirmed.title,
    album: albumTitle,
    year: confirmed.date ? Number(confirmed.date.slice(0, 4)) : null,
  };
  const { filledFields } = await applyOrPreviewTags(item.path, current, desired, coverImage, dryRun);

  const moved = await moveOrPreview(item.path, item.name, {
    artist: confirmed.artist,
    album: albumTitle ?? 'Singles',
    title: confirmed.title,
  }, dryRun);
  if (moved.needsReview) return { needsReview: moved.needsReview };

  return {
    matched: {
      path: item.path,
      name: item.name,
      recordingMbid: confirmed.mbid,
      title: confirmed.title,
      artist: confirmed.artist,
      album: albumTitle,
      filledFields,
      current,
      movedTo: moved.movedTo,
    },
  };
}
```

to:

```js
async function processLooseFile(item, { dryRun }) {
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, code: 'no_match', reason } };
  }
  return finalizeLooseFile(item.path, item.name, confirmed, { dryRun });
}

// Tags and moves a loose file given an already-resolved MusicBrainz recording
// (the shape `getRecording` returns). Shared by the automatic identify-then-finalize
// path above and the manual-override resolve path (see resolveLooseFileOverride).
async function finalizeLooseFile(filePath, name, confirmed, { dryRun }) {
  const current = await tags.readTags(filePath);
  const releaseGroup = confirmed.releaseGroups[0];
  const coverImage = releaseGroup ? await getFrontCoverImage(releaseGroup.mbid) : null;

  // A track with no release group has no real album — leave the album *tag*
  // empty (don't fabricate one), but file it under a "Singles" folder.
  const albumTitle = releaseGroup?.title ?? null;
  const desired = {
    artist: confirmed.artist,
    title: confirmed.title,
    album: albumTitle,
    year: confirmed.date ? Number(confirmed.date.slice(0, 4)) : null,
  };
  const { filledFields } = await applyOrPreviewTags(filePath, current, desired, coverImage, dryRun);

  const moved = await moveOrPreview(filePath, name, {
    artist: confirmed.artist,
    album: albumTitle ?? 'Singles',
    title: confirmed.title,
  }, dryRun);
  if (moved.needsReview) return { needsReview: moved.needsReview };

  return {
    matched: {
      path: filePath,
      name,
      recordingMbid: confirmed.mbid,
      title: confirmed.title,
      artist: confirmed.artist,
      album: albumTitle,
      filledFields,
      current,
      movedTo: moved.movedTo,
    },
  };
}
```

- [ ] **Step 2: Run the full test suite to verify the refactor is behavior-preserving**

Run: `cd server && npm test`
Expected: all tests PASS (this is a pure extraction — no behavior change, so every existing `ingest.test.js` assertion should still hold).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/ingest.js
git commit -m "Extract finalizeLooseFile from processLooseFile"
```

---

### Task 3: Add `findCandidatesForFile` (near-miss AcoustID candidates)

**Files:**
- Modify: `server/src/services/ingest.js`
- Test: `server/test/ingest.test.js`

**Interfaces:**
- Consumes: `fingerprint` (from `fpcalc.js`), `lookup` (from `acoustid.js`), `getRecording` (from `musicbrainz.js`) — all already imported in `ingest.js`.
- Produces: `export async function findCandidatesForFile(filePath)` → `Promise<{ candidates: Array<{ recordingMbid, title, artist, lengthMs, score, releaseGroupTitle }> }>`. Throws `BadRequestError` if `filePath` resolves outside `config.ingest.ingestDir`. Used by Task 5's new route.

- [ ] **Step 1: Write the failing tests**

Add this helper immediately after the existing `freshProcessIngest` function definition near the top of `server/test/ingest.test.js` (same file, same `importCounter` counter — it just returns the whole fresh module instead of only `processIngest`):

```js
async function freshIngestExports() {
  importCounter += 1;
  return import(`../src/services/ingest.js?fresh=${importCounter}`);
}
```

Then add these three tests anywhere after the existing tests:

```js
test('findCandidatesForFile returns every AcoustID candidate with recording details, sorted by score', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', {
      exports: {
        lookup: async () => [
          { recordingMbid: 'rec-hi', score: 0.4 },
          { recordingMbid: 'rec-lo', score: 0.1 },
        ],
      },
    });
    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        getRecording: async (mbid) => ({
          mbid,
          title: mbid === 'rec-hi' ? 'High Score Track' : 'Low Score Track',
          lengthMs: 200000,
          artist: 'Some Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Some Album' }],
          date: '2020-01-01',
        }),
      },
    });

    const { findCandidatesForFile } = await freshIngestExports();
    const result = await findCandidatesForFile(filePath);

    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].recordingMbid, 'rec-hi');
    assert.equal(result.candidates[0].score, 0.4);
    assert.equal(result.candidates[0].title, 'High Score Track');
    assert.equal(result.candidates[0].releaseGroupTitle, 'Some Album');
    assert.equal(result.candidates[1].recordingMbid, 'rec-lo');
  });
});

test('findCandidatesForFile returns an empty list when AcoustID finds nothing', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'unknown.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/fpcalc.js', {
      exports: { fingerprint: async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }) },
    });
    t.mock.module('../src/services/acoustid.js', { exports: { lookup: async () => [] } });

    const { findCandidatesForFile } = await freshIngestExports();
    const result = await findCandidatesForFile(filePath);

    assert.deepEqual(result.candidates, []);
  });
});

test('findCandidatesForFile rejects a path outside INGEST_DIR', async (t) => {
  await withIngestDir(async (dir) => {
    const { findCandidatesForFile } = await freshIngestExports();
    const { BadRequestError } = await import('../src/lib/httpErrors.js');
    await assert.rejects(
      () => findCandidatesForFile('/etc/passwd'),
      (err) => err instanceof BadRequestError
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `findCandidatesForFile is not a function` (not yet exported).

- [ ] **Step 3: Implement `findCandidatesForFile` and `assertInsideIngestDir`**

Add the `BadRequestError` import at the top of `server/src/services/ingest.js` (it currently only imports `RateLimitedError`):

```js
import { RateLimitedError, BadRequestError } from '../lib/httpErrors.js';
```

Add this near the top of the file, after the existing constants (`SCORE_THRESHOLD`, `DURATION_TOLERANCE_MS`):

```js
// Defense-in-depth: paths reaching this module from the manual-override
// routes are client-supplied, so verify they resolve inside INGEST_DIR
// before any fingerprint/tag/move work touches the filesystem.
function assertInsideIngestDir(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.ingest.ingestDir);
  if (!resolved.startsWith(root + path.sep)) {
    throw new BadRequestError(`Refusing to operate outside INGEST_DIR: ${filePath}`);
  }
}
```

Add this exported function (near `processIngest`, at the bottom of the file):

```js
// Re-fingerprints filePath and re-runs the AcoustID lookup, this time keeping
// every candidate (not just ones scoring above SCORE_THRESHOLD) so a human can
// pick from AcoustID's near-misses when auto-matching failed.
export async function findCandidatesForFile(filePath) {
  assertInsideIngestDir(filePath);
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const acoustidCandidates = await lookup({ fingerprint: fp, durationSeconds });
  const top = acoustidCandidates.slice(0, 10);
  const recordings = await Promise.all(top.map((c) => getRecording(c.recordingMbid)));

  const candidates = recordings.map((rec, i) => ({
    recordingMbid: rec.mbid,
    title: rec.title,
    artist: rec.artist,
    lengthMs: rec.lengthMs,
    score: top[i].score,
    releaseGroupTitle: rec.releaseGroups[0]?.title ?? null,
  }));

  return { candidates };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ingest.js server/test/ingest.test.js
git commit -m "Add findCandidatesForFile for ingest manual override"
```

---

### Task 4: Add `resolveLooseFileOverride`

**Files:**
- Modify: `server/src/services/ingest.js`
- Test: `server/test/ingest.test.js`

**Interfaces:**
- Consumes: `finalizeLooseFile` (Task 2), `assertInsideIngestDir` (Task 3), `getRecording` (already imported).
- Produces: `export async function resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun = false })` → same return shape as `finalizeLooseFile` (`{ matched }` or `{ needsReview }`). Used by Task 5's new route.

- [ ] **Step 1: Write the failing test**

Add to `server/test/ingest.test.js`:

```js
test('resolveLooseFileOverride tags and moves the file using the chosen recording', async (t) => {
  await withIngestDir(async (dir) => {
    const filePath = path.join(dir, 'track.mp3');
    await fs.writeFile(filePath, 'fake-audio');

    t.mock.module('../src/services/musicbrainz.js', {
      exports: {
        getRecording: async (mbid) => ({
          mbid,
          title: 'Chosen Title',
          lengthMs: 200000,
          artist: 'Chosen Artist',
          releaseGroups: [{ mbid: 'rg-1', title: 'Chosen Album' }],
          date: '2021-01-01',
        }),
      },
    });
    t.mock.module('../src/services/tags.js', {
      exports: {
        readTags: async () => ({
          artist: null, title: null, album: null, trackNumber: null, disc: null, year: null, genre: null, hasCoverArt: false,
        }),
        writeMissingTags: async () => ({ filledFields: ['artist', 'title', 'album'] }),
      },
    });
    t.mock.module('../src/services/coverArt.js', { exports: { getFrontCoverImage: async () => null } });
    t.mock.module('../src/services/organize.js', {
      exports: {
        moveIntoLibrary: async () => ({ movedTo: '/music/Chosen Artist/Chosen Album/Chosen Title.mp3', duplicate: false }),
      },
    });

    const { resolveLooseFileOverride } = await freshIngestExports();
    const result = await resolveLooseFileOverride({ filePath, name: 'track.mp3', recordingMbid: 'rec-chosen', dryRun: false });

    assert.equal(result.matched.recordingMbid, 'rec-chosen');
    assert.equal(result.matched.title, 'Chosen Title');
    assert.equal(result.matched.movedTo, '/music/Chosen Artist/Chosen Album/Chosen Title.mp3');
  });
});

test('resolveLooseFileOverride rejects a path outside INGEST_DIR', async (t) => {
  await withIngestDir(async () => {
    const { resolveLooseFileOverride } = await freshIngestExports();
    const { BadRequestError } = await import('../src/lib/httpErrors.js');
    await assert.rejects(
      () => resolveLooseFileOverride({ filePath: '/etc/passwd', name: 'x', recordingMbid: 'rec-1', dryRun: false }),
      (err) => err instanceof BadRequestError
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `resolveLooseFileOverride is not a function`.

- [ ] **Step 3: Implement `resolveLooseFileOverride`**

Add this exported function in `server/src/services/ingest.js`, next to `findCandidatesForFile`:

```js
// Manual-override counterpart to the automatic identify-then-finalize flow:
// the recording is already chosen (by the user, via findCandidatesForFile's
// near-misses or a text search), so just resolve it and finalize.
export async function resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun = false }) {
  assertInsideIngestDir(filePath);
  const confirmed = await getRecording(recordingMbid);
  return finalizeLooseFile(filePath, name, confirmed, { dryRun });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ingest.js server/test/ingest.test.js
git commit -m "Add resolveLooseFileOverride for ingest manual override"
```

---

### Task 5: Add `GET /file/candidates` and `POST /file/resolve` routes

**Files:**
- Modify: `server/src/routes/ingest.js`
- Test: `server/test/routes/ingest.test.js`

**Interfaces:**
- Consumes: `findCandidatesForFile`, `resolveLooseFileOverride` (Tasks 3–4); existing `sameOriginOnly` middleware and `BadRequestError`.
- Produces: `GET /api/ingest/file/candidates?path=<path>` → `{ candidates: [...] }`; `POST /api/ingest/file/resolve` (CSRF-guarded) with body `{ path, name, recordingMbid, dryRun }` → `{ matched }` or `{ needsReview }`.

- [ ] **Step 1: Write the failing route tests**

Add to `server/test/routes/ingest.test.js` (before the final CSRF test, reusing the existing `baseUrl`/`tmpDir` setup — these only exercise input validation, since a full mocked happy-path is already covered at the service-unit level in Tasks 3–4 and mocking through the route layer's `createApp` import would require the same module-mocking machinery `ingest.test.js` uses, which isn't worth the fragility for pure routing/validation checks):

```js
test('GET /api/ingest/file/candidates requires a path query param', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/candidates`);
  assert.equal(res.status, 400);
});

test('GET /api/ingest/file/candidates rejects a path outside INGEST_DIR', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/candidates?path=${encodeURIComponent('/etc/passwd')}`);
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve requires path, name, and recordingMbid', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve rejects cross-site requests (CSRF guard)', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ path: path.join(tmpDir, 'x.mp3'), name: 'x.mp3', recordingMbid: 'rec-1' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingest/file/resolve rejects a path outside INGEST_DIR', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/file/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/etc/passwd', name: 'passwd', recordingMbid: 'rec-1' }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Implement the routes**

In `server/src/routes/ingest.js`, change the import line:

```js
import { scanIngestDir, processIngest } from '../services/ingest.js';
```

to:

```js
import { scanIngestDir, processIngest, findCandidatesForFile, resolveLooseFileOverride } from '../services/ingest.js';
```

Add these two routes, after the existing `ingestRouter.get('/scan', ...)` block and before `ingestRouter.post('/process', ...)`:

```js
ingestRouter.get('/file/candidates', async (req, res, next) => {
  try {
    const filePath = String(req.query.path || '');
    if (!filePath) throw new BadRequestError('path is required');
    const result = await findCandidatesForFile(filePath);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

Add this after the existing `ingestRouter.post('/process', ...)` block:

```js
ingestRouter.post('/file/resolve', sameOriginOnly, async (req, res, next) => {
  try {
    const { path: filePath, name, recordingMbid, dryRun = false } = req.body || {};
    if (!filePath || !name || !recordingMbid) {
      throw new BadRequestError('path, name, and recordingMbid are required');
    }
    const result = await resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun: Boolean(dryRun) });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ingest.js server/test/routes/ingest.test.js
git commit -m "Add ingest manual-override routes"
```

---

### Task 6: `IngestMatchPicker` component

**Files:**
- Create: `client/src/components/IngestMatchPicker.jsx`
- Modify: `client/src/styles/index.css`

**Interfaces:**
- Consumes: `get`/`post` from `client/src/api/client.js`; `formatDuration` from `client/src/lib/format.js`; `EqualizerLoader`.
- Produces: `export default function IngestMatchPicker({ item, onResolved, onCancel })` — `item` is a needsReview entry (`{ path, name, code, reason }`); calls `onResolved(result)` with the raw `{ matched }` or `{ needsReview }` response from `POST /ingest/file/resolve` once the user picks a match; calls `onCancel()` when the user cancels. Used by Task 7's `IngestPanel` wiring.

There's no backend to fake here beyond what already exists, and no automated frontend test infrastructure yet (deferred, see Global Constraints) — verify this component visually in Task 7's manual browser check once it's wired in.

- [ ] **Step 1: Create the component**

```jsx
import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import { formatDuration } from '../lib/format.js';
import EqualizerLoader from './EqualizerLoader.jsx';

function CandidateRow({ candidate, mbid, title, artist, releaseGroupTitle, lengthMs, score, busy, onUse }) {
  return (
    <li className="ingest-candidate-row">
      <span>
        {title} — {artist}
        {releaseGroupTitle ? ` (${releaseGroupTitle})` : ''} · {formatDuration(lengthMs)}
        {score != null && ` · score ${score.toFixed(2)}`}
      </span>
      <button type="button" onClick={() => onUse(mbid)} disabled={busy}>
        {busy ? 'Applying…' : 'Use this'}
      </button>
    </li>
  );
}

export default function IngestMatchPicker({ item, onResolved, onCancel }) {
  const [candidates, setCandidates] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [applyingMbid, setApplyingMbid] = useState(null);
  const [applyError, setApplyError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setLoadError(null);
    get(`/ingest/file/candidates?path=${encodeURIComponent(item.path)}`)
      .then((data) => {
        if (!cancelled) setCandidates(data.candidates);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setApplyError(null);
    try {
      const data = await get(`/search?q=${encodeURIComponent(query.trim())}`);
      setSearchResults(data.recordings);
    } catch (err) {
      setApplyError(err);
    } finally {
      setSearching(false);
    }
  }

  async function handleUse(recordingMbid) {
    setApplyingMbid(recordingMbid);
    setApplyError(null);
    try {
      const result = await post('/ingest/file/resolve', {
        path: item.path,
        name: item.name,
        recordingMbid,
        dryRun: false,
      });
      onResolved(result);
    } catch (err) {
      setApplyError(err);
      setApplyingMbid(null);
    }
  }

  return (
    <div className="ingest-match-picker">
      {loadError && <p className="banner banner-error">{loadError.message}</p>}
      {candidates === null && !loadError && <EqualizerLoader label="Looking for near-misses…" />}
      {candidates && candidates.length === 0 && (
        <p className="muted">AcoustID found no other candidates for this file.</p>
      )}
      {candidates && candidates.length > 0 && (
        <ul className="ingest-candidate-list">
          {candidates.map((c) => (
            <CandidateRow
              key={c.recordingMbid}
              mbid={c.recordingMbid}
              title={c.title}
              artist={c.artist}
              releaseGroupTitle={c.releaseGroupTitle}
              lengthMs={c.lengthMs}
              score={c.score}
              busy={applyingMbid === c.recordingMbid}
              onUse={handleUse}
            />
          ))}
        </ul>
      )}

      <form className="ingest-candidate-search" onSubmit={handleSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search MusicBrainz by artist / title"
        />
        <button type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchResults && searchResults.length === 0 && <p className="muted">No matches found.</p>}
      {searchResults && searchResults.length > 0 && (
        <ul className="ingest-candidate-list">
          {searchResults.map((r) => (
            <CandidateRow
              key={r.mbid}
              mbid={r.mbid}
              title={r.title}
              artist={r.artist}
              releaseGroupTitle={r.releaseGroupTitle}
              lengthMs={r.lengthMs}
              score={null}
              busy={applyingMbid === r.mbid}
              onUse={handleUse}
            />
          ))}
        </ul>
      )}

      {applyError && <p className="banner banner-error">{applyError.message}</p>}

      <button type="button" className="ingest-picker-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `client/src/styles/index.css`, after the existing `/* ---------- Verify result inline ---------- */` block:

```css
/* ---------- Ingest match picker ---------- */

.ingest-match-picker {
  margin-top: 0.5rem;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.ingest-candidate-list {
  list-style: none;
  margin: 0 0 0.85rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ingest-candidate-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.9rem;
}

.ingest-candidate-search {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.ingest-candidate-search input {
  flex: 1;
}

.ingest-picker-cancel {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/IngestMatchPicker.jsx client/src/styles/index.css
git commit -m "Add IngestMatchPicker component"
```

---

### Task 7: Wire the picker into `IngestPanel`

**Files:**
- Modify: `client/src/components/IngestPanel.jsx`

**Interfaces:**
- Consumes: `IngestMatchPicker` (Task 6).

- [ ] **Step 1: Update imports and add expand/resolve state**

At the top of `client/src/components/IngestPanel.jsx`, change:

```js
import { useRef, useState } from 'react';
import { get, post } from '../api/client.js';
import { addEntry } from '../lib/history.js';
import EqualizerLoader from './EqualizerLoader.jsx';
```

to:

```js
import { Fragment, useRef, useState } from 'react';
import { get, post } from '../api/client.js';
import { addEntry } from '../lib/history.js';
import EqualizerLoader from './EqualizerLoader.jsx';
import IngestMatchPicker from './IngestMatchPicker.jsx';
```

Inside `IngestPanel()`, after the existing `const doneRef = useRef(false);` line, add:

```js
  const [expandedPath, setExpandedPath] = useState(null);

  function handleResolved(oldItem, resolution) {
    setResult((prev) => {
      const needsReview = prev.needsReview.filter((r) => r.path !== oldItem.path);
      const matched = [...prev.matched];
      if (resolution.matched) {
        matched.push(resolution.matched);
        addEntry({
          track: resolution.matched.title,
          artist: resolution.matched.artist,
          album: resolution.matched.album,
          action: 'ingested',
        });
      } else if (resolution.needsReview) {
        needsReview.push(resolution.needsReview);
      }
      return { ...prev, matched, needsReview };
    });
    setExpandedPath(null);
  }
```

- [ ] **Step 2: Add an Action column and wire the picker into the needs-review table**

Change:

```jsx
          <h2>Needs review ({result.needsReview.length})</h2>
          {result.needsReview.length === 0 ? (
            <p className="muted">Nothing needs review this run.</p>
          ) : (
            <table>
              <thead>
                <tr><th>File</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {result.needsReview.map((r) => (
                  <tr key={r.path}>
                    <td>{r.name}</td>
                    <td className="muted">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
```

to:

```jsx
          <h2>Needs review ({result.needsReview.length})</h2>
          {result.needsReview.length === 0 ? (
            <p className="muted">Nothing needs review this run.</p>
          ) : (
            <table>
              <thead>
                <tr><th>File</th><th>Reason</th><th>Action</th></tr>
              </thead>
              <tbody>
                {result.needsReview.map((r) => (
                  <Fragment key={r.path}>
                    <tr>
                      <td>{r.name}</td>
                      <td className="muted">{r.reason}</td>
                      <td>
                        {r.code === 'no_match' && (
                          <button
                            type="button"
                            onClick={() => setExpandedPath(expandedPath === r.path ? null : r.path)}
                          >
                            {expandedPath === r.path ? 'Cancel' : 'Find a match'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedPath === r.path && (
                      <tr>
                        <td colSpan={3}>
                          <IngestMatchPicker
                            item={r}
                            onResolved={(resolution) => handleResolved(r, resolution)}
                            onCancel={() => setExpandedPath(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
```

Note this only applies once `isPreview` is false and `state === 'done'` with real (non-dry-run) results — since a dry-run's needsReview entries describe a hypothetical run and the user hasn't actually processed the folder yet, resolving one there would tag/move a file the rest of the preview hasn't committed to. The `no_match` action button only needs to be hidden during an active preview; since `IngestMatchPicker` always calls the real (non-dryRun) resolve endpoint, gate the button on `!isPreview` too:

```jsx
                        {r.code === 'no_match' && !isPreview && (
```

- [ ] **Step 3: Manually verify in the browser**

Run: `npm run dev` (from repo root)

With `ACOUSTID_API_KEY`, `INGEST_DIR`, and `MUSIC_DIR` configured in `.env`:

1. Drop an audio file into `INGEST_DIR` that AcoustID won't confidently match (e.g. a short silent/test clip).
2. Open the Ingest page, scan, and process (non-preview).
3. Confirm the file appears under "Needs review" with a "Find a match" button.
4. Click it — confirm the near-miss/search picker expands, and MusicBrainz search returns results for a manually typed artist/title.
5. Click "Use this" on a result — confirm the row disappears from "Needs review" and a new row appears under "Matched & tagged" with the right title/artist and moved-to path, and check `MUSIC_DIR` on disk to confirm the file actually moved there.
6. Confirm a History entry was logged for the manually-resolved track.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/IngestPanel.jsx
git commit -m "Wire manual match picker into the ingest needs-review table"
```
