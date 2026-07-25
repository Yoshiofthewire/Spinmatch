# Album-Scoped Duplicate Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reporting a song as a duplicate when it appears on two different albums, by folding album into the duplicate grouping key.

**Architecture:** Duplicate detection lives in one function — `duplicateGroups()` in `server/src/services/libraryRepo.js`. It pulls every live track in one query and groups them in JavaScript using a shared `foldKey()` helper. The entire behavioural change is adding `album` to that key. Everything downstream (the `/api/library/duplicates` route, the Health tab count, the Overview chip) reads from that one function, so they follow automatically. The rest of the work is correcting tests that encode the old behaviour, and correcting UI and README copy that now says the opposite of what the code does.

**Tech Stack:** Node 22+ ESM, `node:sqlite` (synchronous), Express 4, `node:test` + `node:assert/strict` for server tests, React 18 + Vite for the client.

**Spec:** `docs/superpowers/specs/2026-07-25-album-scoped-duplicates-design.md`

## Global Constraints

- **Server is ESM.** `server/package.json` sets `"type": "module"`. Use `import`, never `require`.
- **No new dependencies.** Not for the server, not for the client. Nothing in this change needs one.
- **Server tests:** run with `npm test` from the repo root (delegates to `npm run test -w server`, which runs `node --experimental-test-module-mocks --test "test/**/*.test.js"`). Tests use `node:test` and `node:assert/strict`, and open an in-memory DB with `openDb(':memory:')`.
- **The client has no test runner.** There is no vitest, no jest, no React Testing Library, and this change does not add one. Client changes are verified with `npm run build` (which type-free-compiles the JSX through Vite and fails on syntax errors) plus a described visual check. Do not invent a client test harness.
- **Album matching is exact**, case-folded only. Do not add remaster/deluxe suffix normalisation.
- **A null album folds to `''`** and buckets with other null albums. This is existing `foldKey` behaviour; do not special-case it.
- **Spinmatch never deletes a file.** The Duplicates view stays read-only. Do not add a delete button.
- **Do not change** `server/src/routes/library.js`. The route passes the new shape through unmodified.

---

### Task 1: Album-scoped grouping in the repository layer

This is the behavioural change and its tests. Note that steps 5–7 are a deliberate red phase on *existing* tests: three of them assert the old cross-album behaviour directly, so they must fail before they are corrected. Do not "fix" them by reverting the implementation.

**Files:**
- Modify: `server/src/services/libraryRepo.js` (`duplicateGroups` ~line 453-472, `findDuplicateGroups` ~line 474-484)
- Test: `server/test/libraryRepo.test.js`

**Interfaces:**
- Consumes: `foldKey(...parts)` (module-private, `libraryRepo.js:143`) — lowercases each part, maps null/undefined to `''`, joins with ASCII 31. `upsertLocalTrack(db, {path, artist, album, title, durationMs, changeKey, ...})`. `openDb(':memory:')` from `../src/lib/db.js`.
- Produces: `findDuplicateGroups(db, { limit = 200 })` returns `Array<{ artist: string, album: string | null, title: string, copies: Track[] }>` — the `album` property is new and Task 2 and Task 3 both rely on it. `findHealthIssues(db).duplicateCount` keeps its `number` type and its existing meaning of "number of groups".

- [ ] **Step 1: Write the three failing tests**

Add to `server/test/libraryRepo.test.js`, immediately after the existing test `findDuplicateGroups finds the copies for non-ASCII artists and titles`:

```js
// The requirement, stated directly: "Hey Jude" on the album, on 1967-1970 and
// on 1 is three records that happen to share a recording, and a collector who
// owns all three wants to keep all three.
test('a song on two different albums is not a duplicate', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'The Beatles', album: 'Hey Jude', title: 'Hey Jude', durationMs: 431000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'The Beatles', album: '1967-1970', title: 'Hey Jude', durationMs: 431000, changeKey: '2:1' });

  assert.deepEqual(repo.findDuplicateGroups(db), []);
  // And the Health tab must agree with the view it links to.
  assert.equal(repo.findHealthIssues(db).duplicateCount, 0);
  db.close();
});

// A null album folds to the empty string, so album-less tracks share one bucket
// rather than each becoming a group of one. Rare in a scanned library —
// libraryScanner substitutes the containing directory name for a missing album
// tag — but it keeps two loose copies of the same song reported.
test('two copies with no album at all still group as a duplicate', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'A', album: null, title: 'Loose', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'A', album: null, title: 'loose', durationMs: 1000, changeKey: '2:1' });

  const groups = repo.findDuplicateGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies.length, 2);
  assert.equal(groups[0].album, null);
  db.close();
});

// The album is now a property of the group, not of each copy, because every
// copy in a group shares it by construction. The Duplicates tab renders it from
// here, so it has to be in the payload.
test('a duplicate group carries the album it belongs to', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.flac', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '1:1', ext: 'flac' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '2:1', ext: 'mp3' });

  const [group] = repo.findDuplicateGroups(db);
  assert.equal(group.album, 'Al');
  db.close();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test 2>&1 | grep -A5 "not a duplicate\|no album at all\|carries the album"`

Expected: `a song on two different albums is not a duplicate` FAILS (it finds one group where it expects none, and `duplicateCount` is 1 not 0). `a duplicate group carries the album it belongs to` FAILS (`group.album` is `undefined`). `two copies with no album at all still group as a duplicate` fails only on its `groups[0].album` assertion — the grouping half already passes today, which is expected and fine.

- [ ] **Step 3: Add album to the grouping key**

In `server/src/services/libraryRepo.js`, replace the whole `duplicateGroups` function (comment block included) with:

```js
// Groups every live track by folded (artist, album, title) and keeps the groups
// with more than one member. Album is in the key because a song on two different
// releases is not a duplicate — an album track that also lands on a greatest-hits
// set is two records sharing a recording, and both are worth keeping. What's left
// is the case worth acting on: the same track from the same release at more than
// one path.
//
// One query, one folding function, one place — rather than grouping in SQL with
// LOWER() and then re-querying each group with JavaScript's toLowerCase(), which
// disagreed for any non-ASCII name and returned groups with no copies in them at
// all.
function duplicateGroups(db) {
  const rows = db.prepare(`
    SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL AND title IS NOT NULL
    ORDER BY album COLLATE NOCASE, path
  `).all();

  const byKey = new Map();
  for (const row of rows) {
    // foldKey maps a null album to '', so tracks with no album tag share one
    // bucket instead of each becoming a group of one.
    const key = foldKey(row.artist, row.album, row.title);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return [...byKey.values()].filter((copies) => copies.length > 1);
}
```

- [ ] **Step 4: Add album to the returned group and the sort**

In the same file, replace the whole `findDuplicateGroups` function (comment block included) with:

```js
// Every copy of each duplicated artist/album/title, so they can be compared
// field by field. findHealthIssues only counts them; deciding which copy to keep
// needs the paths, formats, sizes and durations side by side.
export function findDuplicateGroups(db, { limit = 200 } = {}) {
  return duplicateGroups(db)
    .sort((a, b) => b.length - a.length
      || String(a[0].artist).localeCompare(String(b[0].artist))
      || String(a[0].album ?? '').localeCompare(String(b[0].album ?? ''))
      || String(a[0].title).localeCompare(String(b[0].title)))
    .slice(0, limit)
    .map((copies) => ({
      artist: copies[0].artist,
      album: copies[0].album,
      title: copies[0].title,
      copies,
    }));
}
```

- [ ] **Step 5: Run the suite — new tests pass, three old ones now fail**

Run: `npm test`

Expected: the three tests from Step 1 PASS. Exactly three tests now FAIL, all in `server/test/libraryRepo.test.js`, all because they pair `album: 'Al'` with `album: 'Other'` and expect a group:
- `findHealthIssues counts missing tags and duplicate recordings` — `duplicateCount` is 0, expected 1
- `findDuplicateGroups returns every copy so they can be compared` — `groups.length` is 0, expected 1
- `findDuplicateGroups finds the copies for non-ASCII artists and titles` — `groups.length` is 0, expected 1

This is the intended red phase. If any *other* test fails, stop and investigate before continuing.

- [ ] **Step 6: Correct the three tests to same-album fixtures**

These tests were never about cross-album matching — that was incidental to the fixtures. Each keeps its original point, with the album brought into the same release so the fixture matches the rule. Note that the album strings now also differ in case, which extends each test's case-folding assertion to cover the new key component.

In `server/test/libraryRepo.test.js`, replace `findHealthIssues counts missing tags and duplicate recordings` with:

```js
test('findHealthIssues counts missing tags and duplicate recordings', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'a', album: 'al', title: 'dup', durationMs: 1000, changeKey: '2:1' });
  repo.upsertLocalTrack(db, { path: '/m/3.mp3', artist: null, album: null, title: 'Orphan', durationMs: null, changeKey: '3:1' });
  const health = repo.findHealthIssues(db);
  assert.equal(health.missingArtist, 1);
  assert.equal(health.missingAlbum, 1);
  assert.equal(health.missingDuration, 1);
  assert.equal(health.missingTrackNumber, 3);
  // Case-insensitive grouping catches "A/Al/Dup" vs "a/al/dup" across all three
  // key components.
  assert.equal(health.duplicateCount, 1);
  db.close();
});
```

Replace `findDuplicateGroups returns every copy so they can be compared` with:

```js
test('findDuplicateGroups returns every copy so they can be compared', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.flac', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '1:1', ext: 'flac', sizeBytes: 900 });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'a', album: 'al', title: 'dup', durationMs: 1000, changeKey: '2:1', ext: 'mp3', sizeBytes: 100 });
  repo.upsertLocalTrack(db, { path: '/m/3.mp3', artist: 'A', album: 'Al', title: 'Unique', durationMs: 1000, changeKey: '3:1' });

  const groups = repo.findDuplicateGroups(db);
  assert.equal(groups.length, 1, 'only the duplicated title is a group');
  assert.equal(groups[0].copies.length, 2);
  // The formats and sizes are the point: they're how you tell which copy to keep.
  assert.deepEqual(groups[0].copies.map((c) => c.ext).sort(), ['flac', 'mp3']);
  assert.ok(groups[0].copies.every((c) => c.path));
  db.close();
});
```

Replace the two `upsertLocalTrack` lines inside `findDuplicateGroups finds the copies for non-ASCII artists and titles` — leave that test's comment block and every assertion untouched:

```js
  repo.upsertLocalTrack(db, { path: '/m/1.flac', artist: 'ÄRZTE', album: 'ÜBER', title: 'Über', durationMs: 1000, changeKey: '1:1', ext: 'flac', sizeBytes: 900 });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'ärzte', album: 'über', title: 'über', durationMs: 1000, changeKey: '2:1', ext: 'mp3', sizeBytes: 100 });
```

- [ ] **Step 7: Run the full suite to verify everything passes**

Run: `npm test`

Expected: PASS, zero failures, across every file in `server/test/`.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/libraryRepo.js server/test/libraryRepo.test.js
git commit -m "Scope duplicate detection to the album

Grouping by artist and title alone reported every song that appears on
more than one release as a duplicate, which is most of what a library
with any compilations in it contains. Fold album into the key so only
copies of the same track from the same release are reported.

A null album folds to the empty string, so album-less tracks still share
a bucket rather than each becoming a group of one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Cover the duplicates endpoint's response shape

The route test currently seeds two tracks with *different* titles and asserts an empty result, so it never exercised a real group and passes either way. It is extended to prove the endpoint's actual contract, including the new `album` field.

The fixture in this file is shared by ~35 tests, several of which assert exact track and artist counts. So the extra track is added inside this test and marked removed at the end, leaving the fixture as it was found.

**Files:**
- Modify: `server/test/routes/library.test.js` (module-scope `let` declarations ~line 10-11, `test.before` ~line 13, the duplicates test ~line 91-96)

**Interfaces:**
- Consumes: `findDuplicateGroups`'s `{ artist, album, title, copies }` shape from Task 1. `repo.markRemovedByPath(db, filePath)` (`libraryRepo.js:53`) — sets `removed = 1` for one path, which excludes it from every query in the module.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Hoist the test database handle to module scope**

The db is currently a `const` local to `test.before`, so the test body can't reach it. In `server/test/routes/library.test.js`, change:

```js
let server;
let baseUrl;

test.before(async () => {
  const db = openDb(':memory:');
```

to:

```js
let server;
let baseUrl;
let db;

test.before(async () => {
  db = openDb(':memory:');
```

Leave the rest of `test.before` exactly as it is.

- [ ] **Step 2: Write the extended failing test**

Replace the whole `GET /api/library/duplicates returns each copy of a duplicated title` test with:

```js
test('GET /api/library/duplicates returns each copy of a duplicated title', async () => {
  const empty = await fetch(`${baseUrl}/api/library/duplicates`);
  assert.equal(empty.status, 200);
  // The two seeded tracks have different titles, so there is nothing to report.
  assert.deepEqual((await empty.json()).groups, []);

  // A second file of the same track from the same release — the case this view
  // exists for. Marked removed again at the end, because the ~35 other tests in
  // this file assert against the shared fixture's exact counts.
  repo.upsertLocalTrack(db, { path: '/m/A/Al/01.flac', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '3:1', ext: 'flac' });
  try {
    const res = await fetch(`${baseUrl}/api/library/duplicates`);
    assert.equal(res.status, 200);
    const { groups } = await res.json();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].artist, 'A');
    assert.equal(groups[0].album, 'Al');
    assert.equal(groups[0].title, 'One');
    assert.deepEqual(
      groups[0].copies.map((c) => c.path).sort(),
      ['/m/A/Al/01.flac', '/m/A/Al/01.mp3'],
    );
  } finally {
    repo.markRemovedByPath(db, '/m/A/Al/01.flac');
  }
});
```

No `recomputeStats` call is needed in the cleanup: the aggregate table is only rewritten when `recomputeStats` runs, and this test never runs it, so the stats the other tests read were never affected by the extra row.

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test 2>&1 | grep -B2 -A8 "duplicates returns each copy"`

Expected: PASS. (This test is written against the Task 1 implementation, which is already in place, so it goes green immediately — its value is locking the contract, including `album`, against future regressions.)

- [ ] **Step 4: Run the full suite to verify the fixture was restored**

Run: `npm test`

Expected: PASS, zero failures. In particular `GET /api/library/stats returns the collection summary` must still report `totalTracks: 2` and `GET /api/library/artists lists artists with counts` must still report `trackCount: 2` — if either now reports 3, the cleanup in the `finally` block did not run or did not work.

- [ ] **Step 5: Commit**

```bash
git add server/test/routes/library.test.js
git commit -m "Cover the duplicates endpoint with an actual duplicate

The test seeded two tracks with different titles and asserted an empty
result, so it passed whatever the grouping rule was. Seed a real
same-release duplicate and assert the response shape, including the album
the group belongs to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Correct the Duplicates tab and the README

The tab's help text currently tells the user that compilation overlap is the expected case — which is exactly what no longer appears — so it now says the opposite of what the code does. The Album column also becomes dead weight: every copy in a group shares one album by construction, so as a column it repeats the same value on every row.

**Files:**
- Modify: `client/src/components/library/DuplicatesTab.jsx` (whole file)
- Modify: `README.md` (the **Duplicates** bullet, ~line 175-179)

**Interfaces:**
- Consumes: `getDuplicates()` from `../../api/library.js`, resolving to `{ groups: Array<{ artist, album, title, copies }> }` — the `album` property comes from Task 1.
- Produces: nothing other tasks depend on.

No CSS changes are needed. `.duplicate-group h3` (`client/src/styles/index.css:1258`) is already `display: flex` with `gap` and `flex-wrap: wrap`, so it absorbs the extra header content as-is.

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `client/src/components/library/DuplicatesTab.jsx` with:

```jsx
import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates } from '../../api/library.js';
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
// Deliberately read-only: Spinmatch never deletes a file, so this view shows you
// what you have and leaves the decision (and the deletion) to you.
export default function DuplicatesTab({ onPlay }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const { page, setPage, pageCount, pageItems } = usePagination(groups ?? [], 20);

  useEffect(() => {
    let cancelled = false;
    getDuplicates()
      .then((data) => { if (!cancelled) setGroups(data.groups); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

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
        counted as a duplicate. <strong>Spinmatch never deletes files;</strong> play the copies to
        compare them and remove what you don&apos;t want yourself.
      </p>

      {pageItems.map((group) => (
        <div key={`${group.artist}-${group.album}-${group.title}`} className="duplicate-group">
          <h3>
            {group.title}
            <span className="muted">— {group.artist} · {group.album ?? 'No album'}</span>
            <span className="badge badge-none">{group.copies.length} copies</span>
          </h3>
          <table className="library-table">
            <thead>
              <tr>
                <th aria-label="Play" /><th>#</th><th>Length</th>
                <th>Format</th><th>Size</th><th>Path</th>
              </tr>
            </thead>
            <tbody>
              {group.copies.map((copy) => (
                <tr key={copy.id}>
                  <td>
                    <button
                      type="button"
                      className="play-button"
                      onClick={() => onPlay(copy, group.copies)}
                      // The album no longer tells two copies apart — they share
                      // it — so the format does.
                      aria-label={`Play ${copy.title} from ${group.album ?? 'unknown album'} (${copy.ext ?? 'unknown format'})`}
                    >
                      ▶
                    </button>
                  </td>
                  <td className="mono">{copy.trackNumber ?? '—'}</td>
                  <td className="mono">{formatDuration(copy.durationMs)}</td>
                  <td className="mono">{copy.ext ?? '—'}</td>
                  <td className="mono">{copy.sizeBytes ? formatBytes(copy.sizeBytes) : '—'}</td>
                  <td className="mono duplicate-path">{copy.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
```

- [ ] **Step 2: Verify the client builds**

Run: `npm run build`

Expected: Vite build completes with no errors and writes `client/dist/`. A JSX syntax error or a bad import fails here.

- [ ] **Step 3: Rewrite the README bullet**

In `README.md`, replace the **Duplicates** bullet — currently reading "the same artist and title indexed at more than one path… Often legitimate — an album track that also appears on a compilation." — with:

```markdown
- **Duplicates** — the same artist, album and title indexed at more than one path, with every
  copy's track number, length, format, size and full path side by side, and a play button for each
  so they can be compared. The album is part of the match, so a song that appears on two different
  releases — an album track that's also on a compilation — is not a duplicate and is not listed.
  What's left is genuine redundancy: a FLAC and a 128k MP3 of the same album track, or a folder
  copied twice. **Spinmatch never deletes files;** this view tells you what you have and leaves the
  decision to you.
```

Leave the ingest section's mention of duplicates (~line 100, "If a file identical to one already in your library turns up, it's left in place rather than duplicated") alone — that is content-identity checking during ingest, a different mechanism.

- [ ] **Step 4: Visual check**

Run: `npm run dev`, open the Library page, and go to the Duplicates tab.

Expected:
- Each group header reads `Title — Artist · Album` followed by an `N copies` badge, wrapping cleanly at narrow widths.
- The table has six columns and no Album column.
- If your library has a track that's on both an album and a compilation, it is absent from the list.
- The duplicate count on the Overview and Health tabs matches the number of groups here, and both are lower than before the change.

If you have no local library configured, skip the visual check and note that in the commit — Steps 2 and Task 1's tests are the binding verification.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/library/DuplicatesTab.jsx README.md
git commit -m "Say what the Duplicates tab now does

The help text promised the opposite of the new rule — it told the user
that compilation overlap was the expected case, which is precisely what
no longer appears. Rewrite it, and move the album from a column that
repeated one value on every row into the group header, where it now
belongs. The play button's label leans on the format instead of the
album, which no longer tells two copies apart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification

After all three tasks:

- [ ] `npm test` — passes, zero failures
- [ ] `npm run build` — succeeds
- [ ] `git log --oneline main..HEAD` — shows the spec commit plus three implementation commits
