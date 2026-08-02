# Spinmatch Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent playlists built from the collection and from discovery, exportable as an m3u at the music root or as a folder of copied files for an MP3 player.

**Architecture:** Playlist items are identified by normalized text and resolved against `local_tracks` at read time, so they survive the file moves the app performs on itself and so gaps fill themselves in once a file lands. Discovery neighbour accumulation is refactored so the owned-artist filter becomes the caller's policy. The sampler is a pure function taking a candidate pool and returning picks, so the cap arithmetic and byte budget are testable without mocks.

**Tech Stack:** Node 22+ (`node:sqlite` `DatabaseSync`, `node:test`), Express 4, React 18 + Vite, `node-taglib-sharp`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-02-playlists-design.md`

## Global Constraints

- **No new npm dependencies.** Everything here uses the standard library or what is already installed.
- **ES modules throughout.** `import`/`export`, `"type": "module"` is already set.
- **Tests run with `cd server && npm test`** — `node --experimental-test-module-mocks --test "test/**/*.test.js"`.
- **Every upstream failure returns `null` and is never cached.** This is the existing convention in `services/listenBrainz.js`; an outage must never be remembered as "no results".
- **Duration filter defaults:** minimum `60_000` ms, maximum `720_000` ms, NULL duration excluded. Auto-fill only, never applied to a manually added track.
- **Per-artist cap:** `Math.ceil(target / poolArtists) + 5`, where `poolArtists` counts artists remaining after the duration filter.
- **`normalizeTitle` from `server/src/lib/normalize.js` is the only title-folding function.** Do not write a second one.
- **Folding happens in JS, never in SQL.** SQLite's `LOWER()` is ASCII-only; `libraryRepo.js` documents why this matters.
- **Commit after every task.** Conventional commit subject, imperative, under 72 characters.

---

## Upstream status: the Popularity API is disabled

Verified against the live service on 2026-08-02:

```
GET https://api.listenbrainz.org/1/popularity/top-recordings-for-artist/<mbid>
→ 500 {"code":500,"error":"Popularity API currently disabled due to high load on the server. Please try again later."}
```

Confirmed for three different artist MBIDs, and for the sibling `top-release-groups-for-artist`. `POST /1/popularity/recording` *does* work, but it takes recording MBIDs, which `local_tracks` does not store.

**This does not change the design.** The spec already requires that a null popularity response degrade rather than fail, so the code is written exactly as specified and the degrade path is simply live from day one. When MetaBrainz re-enables the API, Popular starts working with no code change.

Two consequences the tasks below implement:

1. **Tests stub `fetch`** — as `listenBrainz.test.js` already does — so the suite is unaffected by upstream availability.
2. **Popular needs a real fallback ordering,** or it is Chance wearing a different label. When an artist has no popularity data, its tracks are ordered by **album year, then track number** — a chronological walk of what you own by them. Deterministic, useful, and honestly not a popularity claim. The UI reports which artists ranked by popularity and which fell back.

---

## File structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `server/src/services/playlistRepo.js` | CRUD over the two tables; batched text→track resolution. Pure SQL. |
| `server/src/services/playlistFill.js` | Duration filter and sampler. Pure functions, injected RNG. |
| `server/src/services/playlistDiscovery.js` | Seed → neighbours → owned tracks → ranked candidate pool. Network + DB glue. |
| `server/src/services/playlistExport.js` | m3u writing and drop-off copying. Filesystem only. |
| `server/src/routes/playlists.js` | HTTP surface. |
| `server/test/playlistRepo.test.js` | |
| `server/test/playlistFill.test.js` | |
| `server/test/playlistExport.test.js` | |
| `server/test/routes/playlists.test.js` | |
| `client/src/api/playlists.js` | |
| `client/src/pages/PlaylistsPage.jsx` | List view + routing to detail. |
| `client/src/components/playlist/PlaylistDetail.jsx` | Ordered rows, reorder, export actions. |
| `client/src/components/playlist/AddTracksPanel.jsx` | The three add sources. |
| `client/src/components/playlist/SuggestPanel.jsx` | Discovery seed/method form + review list. |
| `client/src/components/AddToPlaylistButton.jsx` | Reusable picker for library/search rows. |

**Modify:**

| Path | Change |
| --- | --- |
| `server/src/lib/normalize.js` | Add `makeMatchKey`, `makeTitleKey`, `KEY_SEPARATOR`. |
| `server/src/lib/db.js` | `SCHEMA_VERSION` 6→7; two columns, two tables, three indexes; v7 migration. |
| `server/src/lib/paths.js` | Add `assertInsideDropoffDir`. |
| `server/src/services/libraryRepo.js` | `upsertLocalTrack` writes the two keys. |
| `server/src/services/listenBrainz.js` | Add `getTopRecordings`; amend the header. |
| `server/src/services/libraryDiscovery.js` | Neighbour accumulation takes `excludeOwned` and a seed list. |
| `server/src/config.js` | `dropoffDir`, `playlistExportEnabled()`. |
| `server/src/app.js` | Mount `playlistsRouter`. |
| `server/src/routes/config.js` | Expose `playlistExportEnabled` to the client. |
| `client/src/App.jsx` | `/playlists` route and nav link. |
| `client/src/pages/LibraryPage.jsx` | Remove the Rebuild-a-playlist panel from Discover. |
| `client/src/components/library/DiscoveryPanel.jsx` | Same. |
| `README.md` | Playlists section; `DROPOFF_DIR`; the download/copy line. |
| `.env.example` | `DROPOFF_DIR`. |

---

## Task 1: Key columns and the v7 migration

**Files:**
- Modify: `server/src/lib/normalize.js`
- Modify: `server/src/lib/db.js`
- Modify: `server/src/services/libraryRepo.js:7-50`
- Test: `server/test/dbMigrate.test.js` (add cases), `server/test/libraryRepo.test.js` (add cases)

**Interfaces:**
- Produces: `makeMatchKey(artist, title) -> string`, `makeTitleKey(title) -> string`, `KEY_SEPARATOR` from `lib/normalize.js`. `local_tracks.match_key` and `local_tracks.title_key`, populated on every write and backfilled on upgrade. `SCHEMA_VERSION === 7`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/libraryRepo.test.js`:

```js
test('upsert stores the normalized match and title keys', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/R/Kid A/01.flac', artist: 'Radiohead', album: 'Kid A',
    title: 'Everything In Its Right Place (Remastered 2011)',
    durationMs: 251000, changeKey: '1:1',
  });
  const row = db.prepare('SELECT match_key AS matchKey, title_key AS titleKey FROM local_tracks').get();
  assert.equal(row.matchKey, 'radiohead\u001feverything in its right place');
  assert.equal(row.titleKey, 'everything in its right place');
  db.close();
});

test('a null artist still yields a usable title key', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/x.mp3', artist: null, album: null, title: 'Idioteque',
    durationMs: 1000, changeKey: '2:1',
  });
  const row = db.prepare('SELECT match_key AS matchKey, title_key AS titleKey FROM local_tracks').get();
  assert.equal(row.matchKey, '\u001fidioteque');
  assert.equal(row.titleKey, 'idioteque');
  db.close();
});
```

Add to `server/test/dbMigrate.test.js`:

```js
test('v7 backfills match_key and title_key without re-reading files', () => {
  const db = openDb(':memory:');
  // Simulate a v6 install: drop the new columns' values and rewind the version.
  db.exec("UPDATE local_tracks SET match_key = NULL, title_key = NULL");
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6') "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
  db.prepare(`INSERT INTO local_tracks (path, artist, album, title, change_key, updated_at)
              VALUES ('/m/a.mp3', 'Portishead', 'Dummy', 'Roads [Live]', 'k', 1)`).run();

  assert.equal(migrate(db), 7);

  const row = db.prepare("SELECT match_key AS m, title_key AS t, change_key AS c FROM local_tracks WHERE path = '/m/a.mp3'").get();
  assert.equal(row.m, 'portishead\u001froads');
  assert.equal(row.t, 'roads');
  // The keys derive from columns already in the table, so no rescan is forced.
  assert.equal(row.c, 'k', 'change_key must not be cleared — this backfill reads no files');
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --experimental-test-module-mocks --test test/libraryRepo.test.js test/dbMigrate.test.js`
Expected: FAIL — `no such column: match_key`.

- [ ] **Step 3: Add the key builders**

Append to `server/src/lib/normalize.js`:

```js
// Unit separator, matching the one libraryRepo's dup_key uses. A control
// character can't occur in a folded key, whose alphabet normalizeTitle has
// already reduced to letters, digits and single spaces.
export const KEY_SEPARATOR = '\u001f';

// The identity a playlist item is stored under, and the one local_tracks is
// indexed on. Folded in JS, once, for the reason libraryRepo.js documents at
// foldKey: SQLite's LOWER() is ASCII-only and JavaScript's toLowerCase() is not,
// so a key built one way and queried the other disagrees the moment an artist is
// called "Ärzte".
//
// Distinct from dup_key, which is a plain lowercase join and therefore will not
// match "Kid A (Remastered)" to "Kid A". Playlist resolution has to, so it folds
// through normalizeTitle instead.
export function makeMatchKey(artist, title) {
  return `${normalizeTitle(artist)}${KEY_SEPARATOR}${normalizeTitle(title)}`;
}

export function makeTitleKey(title) {
  return normalizeTitle(title);
}
```

- [ ] **Step 4: Add the schema**

In `server/src/lib/db.js`, bump the version:

```js
const SCHEMA_VERSION = 7;
```

Add to the `local_tracks` column list in `SCHEMA`, directly after `dup_key`:

```sql
  -- Folded "artist␟title" and "title", computed in JS on write (see
  -- libraryRepo.upsertLocalTrack). Distinct from dup_key above: these fold
  -- through normalizeTitle, so they match "Kid A (Remastered)" to "Kid A",
  -- which is what a playlist item has to do. dup_key must not, because two
  -- different masterings are genuinely two files.
  match_key     TEXT,
  title_key     TEXT,
```

Add the two tables to `SCHEMA`, after `library_similar_cache`:

```sql
CREATE TABLE IF NOT EXISTS playlists (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  -- Lowercased in JS, like every other grouping key here, so "Road Trip" and
  -- "road trip" cannot both exist.
  name_key         TEXT UNIQUE NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_exported_at INTEGER,
  last_export_dir  TEXT
);

-- A row is an entry in a playlist, not a reference to a file. local_tracks is
-- keyed on path, so ingest, duplicate-trash and album repair each turn a moved
-- file into a NEW row — an id here would rot every time the rest of the app was
-- used. Text resolved at read time survives that, and makes a gap fill itself in
-- the moment the file lands in the library.
CREATE TABLE IF NOT EXISTS playlist_items (
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  artist      TEXT,
  title       TEXT NOT NULL,
  album       TEXT,
  match_key   TEXT NOT NULL,
  title_key   TEXT NOT NULL,
  -- manual | popular | random | paste. 'random' is what the UI labels "Chance".
  source      TEXT NOT NULL,
  seed_artist TEXT,
  added_at    INTEGER NOT NULL
);
```

Add to the index block:

```sql
CREATE INDEX IF NOT EXISTS idx_lt_live_match_key ON local_tracks(match_key) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_title_key ON local_tracks(title_key) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_pi_playlist ON playlist_items(playlist_id, position);
```

- [ ] **Step 5: Add the v7 migration**

Import at the top of `db.js`:

```js
import { makeMatchKey, makeTitleKey } from './normalize.js';
```

Add the column list beside `V6_TRACK_COLUMNS`:

```js
// v7: the keys playlist items resolve through. See the note on them in SCHEMA.
const V7_TRACK_COLUMNS = [
  ['match_key', 'TEXT'],
  ['title_key', 'TEXT'],
];
```

Add inside `migrate()`, after the `current < 6` block:

```js
  if (current < 7) {
    addMissingColumns(db, 'local_tracks', V7_TRACK_COLUMNS);
    // Unlike the v2 and v6 backfills, this one reads no files: both keys are a
    // pure function of artist and title, which are already in the table. So
    // change_key is deliberately NOT cleared — forcing a full rescan of a large
    // library to compute something already derivable would be pure waste.
    const rows = db.prepare('SELECT id, artist, title FROM local_tracks').all();
    const update = db.prepare('UPDATE local_tracks SET match_key = ?, title_key = ? WHERE id = ?');
    for (const row of rows) {
      update.run(makeMatchKey(row.artist, row.title), makeTitleKey(row.title), row.id);
    }
  }
```

- [ ] **Step 6: Write the keys on upsert**

In `server/src/services/libraryRepo.js`, add to the imports:

```js
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';
```

Inside `upsertLocalTrack`, beside the existing `dupKey` line:

```js
  // Computed here for the same reason dupKey is: so every writer gets them and
  // none can drift from the columns they fold.
  const matchKey = makeMatchKey(artist, title);
  const titleKey = makeTitleKey(title);
```

Add `match_key, title_key` to the INSERT column list, two more `?` to VALUES, `matchKey, titleKey` to the `.run(...)` arguments in the same positions, and to the `DO UPDATE SET` clause:

```sql
      match_key = excluded.match_key,
      title_key = excluded.title_key,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, including the pre-existing suites — `dbMigrate`, `libraryRepo`, `db`, `dbPreflight` all touch this file.

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/normalize.js server/src/lib/db.js server/src/services/libraryRepo.js server/test/
git commit -m "Index the folded keys a playlist item resolves through"
```

---

## Task 2: playlistRepo

**Files:**
- Create: `server/src/services/playlistRepo.js`
- Test: `server/test/playlistRepo.test.js`

**Interfaces:**
- Consumes: `makeMatchKey`, `makeTitleKey` (Task 1); `local_tracks.match_key`, `local_tracks.title_key`.
- Produces:
  - `createPlaylist(db, { name }) -> { id, name, createdAt }`
  - `listPlaylists(db) -> [{ id, name, itemCount, gapCount, totalBytes, lastExportedAt }]`
  - `getPlaylist(db, id) -> { id, name, lastExportedAt, items: [{ id, position, artist, title, album, source, seedArtist, track|null }] }`
  - `renamePlaylist(db, id, name)`, `deletePlaylist(db, id)`
  - `addItems(db, playlistId, items) -> { added }` where an item is `{ artist, title, album, source, seedArtist }`
  - `removeItem(db, playlistId, itemId)`, `reorderItems(db, playlistId, itemIds)`
  - `noteExport(db, id, dir)`
  - A resolved `track` is `{ id, path, artist, album, title, durationMs, sizeBytes, ext, year, trackNumber }`.

- [ ] **Step 1: Write the failing test**

Create `server/test/playlistRepo.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');
const pl = await import('../src/services/playlistRepo.js');

function seeded() {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/P/Dummy/01.flac', artist: 'Portishead', album: 'Dummy', title: 'Mysterons', durationMs: 305000, sizeBytes: 30, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/P/Dummy/02.flac', artist: 'Portishead', album: 'Dummy', title: 'Roads (Remastered)', durationMs: 302000, sizeBytes: 40, changeKey: '2:1' });
  repo.upsertLocalTrack(db, { path: '/m/P/Best/09.mp3', artist: 'Portishead', album: 'Best Of', title: 'Roads', durationMs: 302000, sizeBytes: 10, changeKey: '3:1' });
  return db;
}

test('an item resolves to a track through the normalized key', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'Road Trip' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Mysterons', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items.length, 1);
  assert.equal(items[0].track.path, '/m/P/Dummy/01.flac');
  db.close();
});

test('a bracketed suffix on disk still matches a plain title', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Roads', album: 'Dummy', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.path, '/m/P/Dummy/02.flac', 'the album should break the tie');
  db.close();
});

test('with no album to break the tie the largest file wins', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Roads', source: 'manual' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.sizeBytes, 40);
  db.close();
});

test('an artist that disagrees still resolves on title alone', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead Feat Nobody', title: 'Mysterons', source: 'paste' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track.title, 'Mysterons');
  db.close();
});

test('an unmatched item is a gap, not an error', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Tricky', title: 'Aftermath', source: 'paste' }]);
  const { items } = pl.getPlaylist(db, id);
  assert.equal(items[0].track, null);
  assert.equal(items[0].title, 'Aftermath');
  db.close();
});

test('the same track may appear twice', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
  ]);
  assert.equal(pl.getPlaylist(db, id).items.length, 2);
  db.close();
});

test('names are unique case-insensitively', () => {
  const db = seeded();
  pl.createPlaylist(db, { name: 'Road Trip' });
  assert.throws(() => pl.createPlaylist(db, { name: 'road trip' }));
  db.close();
});

test('reorder renumbers positions contiguously', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Portishead', title: 'Roads', source: 'manual' },
  ]);
  const before = pl.getPlaylist(db, id).items;
  pl.reorderItems(db, id, [before[1].id, before[0].id]);
  const after = pl.getPlaylist(db, id).items;
  assert.deepEqual(after.map((i) => i.position), [0, 1]);
  assert.equal(after[0].id, before[1].id);
  db.close();
});

test('deleting a playlist takes its items with it', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [{ artist: 'Portishead', title: 'Mysterons', source: 'manual' }]);
  pl.deletePlaylist(db, id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get().n, 0);
  db.close();
});

test('the summary counts gaps and sums only what resolved', () => {
  const db = seeded();
  const { id } = pl.createPlaylist(db, { name: 'x' });
  pl.addItems(db, id, [
    { artist: 'Portishead', title: 'Mysterons', source: 'manual' },
    { artist: 'Tricky', title: 'Aftermath', source: 'paste' },
  ]);
  const [row] = pl.listPlaylists(db);
  assert.equal(row.itemCount, 2);
  assert.equal(row.gapCount, 1);
  assert.equal(row.totalBytes, 30);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistRepo.test.js`
Expected: FAIL — cannot find module `playlistRepo.js`.

- [ ] **Step 3: Implement**

Create `server/src/services/playlistRepo.js`:

```js
import { getDb } from '../lib/db.js';
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';

// Playlists, and the resolution of their items to files on disk.
//
// The only module that knows the playlist schema, the way libraryRepo is the
// only thing that knows local_tracks.
//
// An item stores text, not a track id. See the comment on the table in db.js for
// why. The consequence for this file is that every read resolves, and that
// resolution is deliberately two indexed queries for the whole playlist rather
// than one per row — the version of this that shipped inside reconstructPlaylist
// ran a LIKE query per line and capped it at 25 candidates, which is both slow
// and lossy for a common title.

const TRACK_COLUMNS = `
  id, path, artist, album, title,
  duration_ms AS durationMs, size_bytes AS sizeBytes, ext, year,
  track_number AS trackNumber, match_key AS matchKey, title_key AS titleKey
`;

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// Of several live files answering to one key, prefer the one whose album the
// item actually named, then the biggest file — a guess, but one that only ever
// decides which of two copies you already own reaches the player.
function preferBest(candidates, album) {
  const wanted = album ? makeTitleKey(album) : null;
  const byAlbum = wanted
    ? candidates.filter((t) => makeTitleKey(t.album) === wanted)
    : [];
  const pool = byAlbum.length ? byAlbum : candidates;
  return pool.reduce((best, t) => (
    (t.sizeBytes ?? 0) > (best.sizeBytes ?? 0) ? t : best
  ), pool[0]);
}

/**
 * Attach a resolved local track to each item, or null where none exists.
 *
 * Two passes, both indexed. The second runs on *misses* rather than only on
 * artist-less items, which is what lets a playlist whose artist tag disagrees
 * with the file's ("The Beatles" against "Beatles") still resolve on title —
 * the same forgiveness the paste panel has always had.
 */
export function resolveItems(db, items) {
  if (!items.length) return items.map((item) => ({ ...item, track: null }));

  const matchKeys = [...new Set(items.map((i) => i.matchKey))];
  const byMatch = new Map();
  for (const row of db.prepare(
    `SELECT ${TRACK_COLUMNS} FROM local_tracks
     WHERE removed = 0 AND match_key IN (${placeholders(matchKeys.length)})`
  ).all(...matchKeys)) {
    if (!byMatch.has(row.matchKey)) byMatch.set(row.matchKey, []);
    byMatch.get(row.matchKey).push(row);
  }

  const missedTitleKeys = [...new Set(
    items.filter((i) => !byMatch.has(i.matchKey)).map((i) => i.titleKey)
  )];
  const byTitle = new Map();
  if (missedTitleKeys.length) {
    for (const row of db.prepare(
      `SELECT ${TRACK_COLUMNS} FROM local_tracks
       WHERE removed = 0 AND title_key IN (${placeholders(missedTitleKeys.length)})`
    ).all(...missedTitleKeys)) {
      if (!byTitle.has(row.titleKey)) byTitle.set(row.titleKey, []);
      byTitle.get(row.titleKey).push(row);
    }
  }

  return items.map((item) => {
    const candidates = byMatch.get(item.matchKey) ?? byTitle.get(item.titleKey) ?? [];
    return { ...item, track: candidates.length ? preferBest(candidates, item.album) : null };
  });
}

export function createPlaylist(db = getDb(), { name }) {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO playlists (name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(name, name.toLowerCase(), now, now);
  return { id: Number(info.lastInsertRowid), name, createdAt: now };
}

const ITEM_COLUMNS = `
  id, position, artist, title, album,
  match_key AS matchKey, title_key AS titleKey,
  source, seed_artist AS seedArtist
`;

export function getPlaylist(db, id) {
  const row = db.prepare(
    'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, '
    + 'last_exported_at AS lastExportedAt, last_export_dir AS lastExportDir '
    + 'FROM playlists WHERE id = ?'
  ).get(id);
  if (!row) return null;
  const items = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM playlist_items WHERE playlist_id = ? ORDER BY position`
  ).all(id);
  return { ...row, items: resolveItems(db, items) };
}

export function listPlaylists(db) {
  const rows = db.prepare(
    'SELECT id, name, last_exported_at AS lastExportedAt FROM playlists ORDER BY updated_at DESC'
  ).all();
  // Resolved per playlist rather than in one sweep: the counts have to reflect
  // what actually resolves right now, and a JOIN on match_key would double-count
  // a title you own two copies of.
  return rows.map((row) => {
    const items = db.prepare(
      `SELECT ${ITEM_COLUMNS} FROM playlist_items WHERE playlist_id = ? ORDER BY position`
    ).all(row.id);
    const resolved = resolveItems(db, items);
    return {
      ...row,
      itemCount: resolved.length,
      gapCount: resolved.filter((i) => !i.track).length,
      totalBytes: resolved.reduce((sum, i) => sum + (i.track?.sizeBytes ?? 0), 0),
    };
  });
}

export function renamePlaylist(db, id, name) {
  db.prepare('UPDATE playlists SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
    .run(name, name.toLowerCase(), Date.now(), id);
}

export function deletePlaylist(db, id) {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
}

export function noteExport(db, id, dir) {
  db.prepare('UPDATE playlists SET last_exported_at = ?, last_export_dir = ? WHERE id = ?')
    .run(Date.now(), dir, id);
}

export function addItems(db, playlistId, items) {
  const now = Date.now();
  const next = db.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM playlist_items WHERE playlist_id = ?'
  ).get(playlistId).next;

  const insert = db.prepare(`
    INSERT INTO playlist_items
      (playlist_id, position, artist, title, album, match_key, title_key, source, seed_artist, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    items.forEach((item, i) => {
      insert.run(
        playlistId, next + i, item.artist ?? null, item.title, item.album ?? null,
        makeMatchKey(item.artist, item.title), makeTitleKey(item.title),
        item.source, item.seedArtist ?? null, now,
      );
    });
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added: items.length };
}

export function removeItem(db, playlistId, itemId) {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?').run(playlistId, itemId);
  renumber(db, playlistId);
}

// Positions are contiguous and rewritten wholesale. A playlist is hundreds of
// rows, so this is milliseconds — and it removes the entire class of bug that
// sparse gap-insertion schemes have when the gaps run out.
function renumber(db, playlistId) {
  const ids = db.prepare(
    'SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position'
  ).all(playlistId).map((r) => r.id);
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => update.run(i, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function reorderItems(db, playlistId, itemIds) {
  const owned = new Set(db.prepare(
    'SELECT id FROM playlist_items WHERE playlist_id = ?'
  ).all(playlistId).map((r) => r.id));
  // Anything the caller didn't mention keeps its relative order at the end, so a
  // stale client can't silently drop rows it hadn't loaded.
  const ordered = itemIds.filter((id) => owned.has(id));
  const rest = [...owned].filter((id) => !ordered.includes(id));
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    [...ordered, ...rest].forEach((id, i) => update.run(i, id));
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistRepo.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/playlistRepo.js server/test/playlistRepo.test.js
git commit -m "Resolve playlist items to files in two indexed queries"
```

---

## Task 3: The pure sampler

**Files:**
- Create: `server/src/services/playlistFill.js`
- Test: `server/test/playlistFill.test.js`

**Interfaces:**
- Produces:
  - `MIN_DURATION_MS = 60_000`, `MAX_DURATION_MS = 720_000`
  - `filterByDuration(tracks, { minMs, maxMs }) -> tracks[]`
  - `perArtistCap(target, artistCount) -> number`
  - `fillPlaylist({ pool, target, byteBudget, method, preferPopular, rng }) -> { picked, cap, stopped }` where `stopped` is `'target' | 'budget' | 'exhausted' | 'cap'`
  - A pool candidate is `{ artist, title, album, matchKey, durationMs, sizeBytes, year, trackNumber, popularityRank, signalScore }`. `popularityRank` is `null` when unavailable.

- [ ] **Step 1: Write the failing test**

Create `server/test/playlistFill.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  filterByDuration, perArtistCap, fillPlaylist,
  MIN_DURATION_MS, MAX_DURATION_MS,
} = await import('../src/services/playlistFill.js');

// A deterministic stand-in for Math.random: cycles a fixed sequence so a
// shuffle is reproducible and an assertion can name an exact result.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function track(artist, n, extra = {}) {
  return {
    artist, title: `${artist} ${n}`, album: 'Al', matchKey: `${artist}-${n}`,
    durationMs: 200_000, sizeBytes: 1_000_000, year: 2000, trackNumber: n,
    popularityRank: null, signalScore: 1, ...extra,
  };
}

function poolOf(artists, per) {
  return artists.flatMap((a) => Array.from({ length: per }, (_, i) => track(a, i + 1)));
}

test('the duration filter drops interludes, epics and undecodable files', () => {
  const tracks = [
    track('A', 1, { durationMs: 30_000 }),
    track('A', 2, { durationMs: 200_000 }),
    track('A', 3, { durationMs: 900_000 }),
    track('A', 4, { durationMs: null }),
  ];
  const kept = filterByDuration(tracks, { minMs: MIN_DURATION_MS, maxMs: MAX_DURATION_MS });
  assert.deepEqual(kept.map((t) => t.trackNumber), [2]);
});

test('the cap is the documented formula', () => {
  assert.equal(perArtistCap(100, 10), 15);
  assert.equal(perArtistCap(200, 40), 10);
  assert.equal(perArtistCap(100, 4), 30);
  assert.equal(perArtistCap(20, 10), 7);
});

test('a single artist is effectively uncapped', () => {
  assert.equal(perArtistCap(30, 1), 35);
});

test('no artist exceeds the cap', () => {
  const pool = poolOf(['A', 'B', 'C'], 50);
  const { picked, cap } = fillPlaylist({
    pool, target: 30, method: 'random', rng: seqRng([0.1, 0.5, 0.9]),
  });
  const counts = {};
  for (const p of picked) counts[p.artist] = (counts[p.artist] ?? 0) + 1;
  for (const n of Object.values(counts)) assert.ok(n <= cap, `${n} exceeds cap ${cap}`);
});

test('picks spread across artists instead of draining the biggest', () => {
  // 100 tracks by A, 3 each by B and C. Naive uniform sampling would return
  // almost nothing but A.
  const pool = [...poolOf(['A'], 100), ...poolOf(['B', 'C'], 3)];
  const { picked } = fillPlaylist({
    pool, target: 9, method: 'random', rng: seqRng([0.2, 0.7, 0.4]),
  });
  const artists = new Set(picked.map((p) => p.artist));
  assert.equal(artists.size, 3, 'every artist with tracks should be represented');
});

test('popular orders by rank, and falls back to year then track number', () => {
  const pool = [
    track('A', 1, { popularityRank: 2 }),
    track('A', 2, { popularityRank: 0 }),
    track('B', 1, { popularityRank: null, year: 1995, trackNumber: 5 }),
    track('B', 2, { popularityRank: null, year: 1990, trackNumber: 1 }),
  ];
  const { picked } = fillPlaylist({ pool, target: 4, method: 'popular' });
  const a = picked.filter((p) => p.artist === 'A').map((p) => p.trackNumber);
  const b = picked.filter((p) => p.artist === 'B').map((p) => p.trackNumber);
  assert.deepEqual(a, [2, 1], 'ranked tracks come out in rank order');
  assert.deepEqual(b, [1, 5], 'unranked tracks fall back to year then track number');
});

test('the byte budget skips an oversized track rather than stopping', () => {
  const pool = [
    track('A', 1, { sizeBytes: 180_000_000 }),
    track('A', 2, { sizeBytes: 1_000_000 }),
    track('A', 3, { sizeBytes: 1_000_000 }),
  ];
  const { picked, stopped } = fillPlaylist({
    pool, target: 10, byteBudget: 5_000_000, method: 'popular',
  });
  assert.equal(picked.length, 2, 'the two small files fit; the huge one is skipped');
  assert.equal(stopped, 'budget');
});

test('reports stopping at the target', () => {
  const { stopped, picked } = fillPlaylist({ pool: poolOf(['A', 'B'], 20), target: 6, method: 'popular' });
  assert.equal(picked.length, 6);
  assert.equal(stopped, 'target');
});

test('reports running out of pool', () => {
  const { stopped, picked } = fillPlaylist({ pool: poolOf(['A', 'B'], 2), target: 50, method: 'popular' });
  assert.equal(picked.length, 4);
  assert.equal(stopped, 'exhausted');
});

test('reports the cap holding the fill back', () => {
  // 200 tracks by one artist, target 50 → cap 55, so the cap can't bite.
  // Two artists, one with 100 tracks and one with 1: cap is 30, so the fill
  // stops at 31 with pool left over.
  const pool = [...poolOf(['A'], 100), ...poolOf(['B'], 1)];
  const { stopped, picked } = fillPlaylist({ pool, target: 50, method: 'popular' });
  assert.equal(picked.length, 31);
  assert.equal(stopped, 'cap');
});

test('prefer-popular narrows the draw to the top slice', () => {
  const pool = Array.from({ length: 40 }, (_, i) => track('A', i + 1, { popularityRank: i }));
  const { picked, cap } = fillPlaylist({
    pool, target: 5, method: 'random', preferPopular: true, rng: seqRng([0.1, 0.4, 0.8, 0.2, 0.6]),
  });
  for (const p of picked) {
    assert.ok(p.popularityRank < 2 * cap, `rank ${p.popularityRank} came from outside the top slice`);
  }
});

test('prefer-popular is a no-op for an artist with no popularity data', () => {
  const pool = poolOf(['A'], 20);
  const { picked } = fillPlaylist({
    pool, target: 5, method: 'random', preferPopular: true, rng: seqRng([0.3, 0.7]),
  });
  assert.equal(picked.length, 5);
});

test('an already-present key is never picked again', () => {
  const pool = poolOf(['A'], 5);
  const { picked } = fillPlaylist({
    pool, target: 5, method: 'popular', existingKeys: new Set(['A-1', 'A-2']),
  });
  assert.equal(picked.length, 3);
  assert.ok(!picked.some((p) => p.matchKey === 'A-1'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistFill.test.js`
Expected: FAIL — cannot find module `playlistFill.js`.

- [ ] **Step 3: Implement**

Create `server/src/services/playlistFill.js`:

```js
// The samplers, as pure functions.
//
// No database, no network, no clock, and randomness only through an injected
// rng. That is deliberate: the cap arithmetic, the round-robin spread, the
// greedy byte fill and the four stop conditions are where the subtle bugs in
// this feature live, and this shape lets every one of them be tested against a
// literal array with no mocking at all.

// Auto-fill only. A track added by hand is the user's call, not the sampler's.
//
// 60s rather than 90s: plenty of punk and hardcore is legitimately 45-90
// seconds, and silently eating a genre is worse than admitting the occasional
// interlude. 12 minutes keeps most prog and post-rock while dropping DJ mixes
// and hidden-track outros — it does exclude "Echoes", which is the honest cost
// of a single number.
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 720_000;

/**
 * A null duration is excluded, not kept. The Health tab already establishes what
 * it means: the scanner could not decode the audio stream, so the file is
 * damaged — it would not play on the target device either.
 */
export function filterByDuration(tracks, { minMs = MIN_DURATION_MS, maxMs = MAX_DURATION_MS } = {}) {
  return tracks.filter((t) => t.durationMs != null && t.durationMs >= minMs && t.durationMs <= maxMs);
}

/**
 * How many tracks one artist may contribute.
 *
 * Slack below ~50 tracks, where the +5 dominates the average — on a 20-track
 * playlist one artist can still take a third. Left as-is rather than corrected
 * with a second rule, and surfaced in the UI so the number is visible when it
 * behaves oddly.
 */
export function perArtistCap(target, artistCount) {
  return Math.ceil(target / Math.max(1, artistCount)) + 5;
}

function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Ranked first, in rank order; then everything else chronologically.
//
// That second half is doing real work right now. The ListenBrainz popularity
// API is disabled upstream, so popularityRank is null for every track until it
// returns — and without a fallback ordering "Popular" would just be Chance under
// another name. Album year then track number is a chronological walk of what you
// own by an artist: deterministic, useful, and not pretending to be a popularity
// claim.
function byPopularity(tracks) {
  const ranked = tracks.filter((t) => t.popularityRank != null)
    .sort((a, b) => a.popularityRank - b.popularityRank);
  const rest = tracks.filter((t) => t.popularityRank == null)
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0)
      || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
  return [...ranked, ...rest];
}

function orderFor(tracks, { method, preferPopular, rng, cap }) {
  if (method === 'popular') return byPopularity(tracks);

  // Chance. prefer-popular narrows the draw to the artist's top 2*cap by
  // popularity before shuffling — enough headroom that a reshuffle still varies,
  // while staying out of the deep cuts. An artist with no popularity data has
  // nothing to narrow to, so the toggle is a no-op there rather than an empty
  // list.
  const ranked = tracks.filter((t) => t.popularityRank != null);
  const slice = preferPopular && ranked.length
    ? byPopularity(ranked).slice(0, 2 * cap)
    : tracks;
  return shuffle(slice, rng);
}

/**
 * @returns {{picked: object[], cap: number, stopped: 'target'|'budget'|'exhausted'|'cap'}}
 */
export function fillPlaylist({
  pool,
  target,
  byteBudget = null,
  method = 'popular',
  preferPopular = false,
  rng = Math.random,
  existingKeys = new Set(),
}) {
  const available = pool.filter((t) => !existingKeys.has(t.matchKey));

  const byArtist = new Map();
  for (const t of available) {
    if (!byArtist.has(t.artist)) byArtist.set(t.artist, []);
    byArtist.get(t.artist).push(t);
  }

  const cap = perArtistCap(target, byArtist.size);

  // Artists in descending signal strength, so when the target is small the
  // strongest neighbours are the ones represented.
  const queues = [...byArtist.entries()]
    .sort((a, b) => (b[1][0].signalScore ?? 0) - (a[1][0].signalScore ?? 0))
    .map(([artist, tracks]) => ({
      artist,
      taken: 0,
      remaining: orderFor(tracks, { method, preferPopular, rng, cap }),
    }));

  const picked = [];
  let bytes = 0;
  let cappedOut = false;
  let budgetBlocked = false;

  // Round-robin rather than one artist at a time, so the cap is rarely what
  // stops the fill and the result is spread rather than proportional to how much
  // of each artist you happen to own.
  let progressed = true;
  while (picked.length < target && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= target) break;
      if (queue.taken >= cap) { cappedOut = true; continue; }

      while (queue.remaining.length) {
        const candidate = queue.remaining.shift();
        // An oversized track is skipped, not fatal: one 180MB lossless file must
        // not end a fill with 400MB still free.
        if (byteBudget != null && bytes + (candidate.sizeBytes ?? 0) > byteBudget) {
          budgetBlocked = true;
          continue;
        }
        picked.push(candidate);
        bytes += candidate.sizeBytes ?? 0;
        queue.taken += 1;
        progressed = true;
        break;
      }
    }
  }

  let stopped = 'exhausted';
  if (picked.length >= target) stopped = 'target';
  else if (budgetBlocked) stopped = 'budget';
  else if (cappedOut) stopped = 'cap';

  return { picked, cap, stopped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistFill.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/playlistFill.js server/test/playlistFill.test.js
git commit -m "Sample a playlist from a pool without letting one artist swamp it"
```

---

## Task 4: ListenBrainz popularity

**Files:**
- Modify: `server/src/services/listenBrainz.js`
- Test: `server/test/listenBrainz.test.js` (add cases)

**Interfaces:**
- Produces: `getTopRecordings(artistMbid) -> Promise<Array<{name, recordingMbid, listenCount}>|null>`, `resetPopularityCacheForTest()`.

- [ ] **Step 1: Write the failing test**

Add to `server/test/listenBrainz.test.js` (extend the existing import):

```js
const { getTopRecordings, resetPopularityCacheForTest } = await import('../src/services/listenBrainz.js');

test('maps top recordings onto the shape the sampler expects', async () => {
  resetPopularityCacheForTest();
  stubFetch(() => jsonResponse([
    { recording_name: 'Roads', recording_mbid: OTHER, total_listen_count: 900 },
    { recording_name: 'Glory Box', recording_mbid: MBID, total_listen_count: 700 },
  ]));
  const result = await getTopRecordings(MBID);
  assert.deepEqual(result, [
    { name: 'Roads', recordingMbid: OTHER, listenCount: 900 },
    { name: 'Glory Box', recordingMbid: MBID, listenCount: 700 },
  ]);
});

test('uses the main API host, not the experimental labs one', async () => {
  resetPopularityCacheForTest();
  stubFetch(() => jsonResponse([]));
  await getTopRecordings(MBID);
  assert.match(calls[0], /^https:\/\/api\.listenbrainz\.org\/1\/popularity\/top-recordings-for-artist\//);
  assert.doesNotMatch(calls[0], /labs\./);
});

// The live service currently answers this endpoint with a 500 ("Popularity API
// currently disabled due to high load"). That has to degrade, not throw, and
// must never be cached as "this artist has no popular tracks".
test('a disabled upstream yields null and is not cached', async () => {
  resetPopularityCacheForTest();
  let hits = 0;
  stubFetch(() => { hits += 1; return { ok: false, status: 500, json: async () => ({ code: 500 }) }; });
  assert.equal(await getTopRecordings(MBID), null);
  assert.equal(await getTopRecordings(MBID), null);
  assert.equal(hits, 2, 'an outage must be retried, not remembered');
});

test('an empty list is a real answer and is cached', async () => {
  resetPopularityCacheForTest();
  let hits = 0;
  stubFetch(() => { hits += 1; return jsonResponse([]); });
  assert.deepEqual(await getTopRecordings(MBID), []);
  assert.deepEqual(await getTopRecordings(MBID), []);
  assert.equal(hits, 1);
});

test('a shape change degrades to null rather than throwing', async () => {
  resetPopularityCacheForTest();
  stubFetch(() => jsonResponse({ unexpected: true }));
  assert.equal(await getTopRecordings(MBID), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/listenBrainz.test.js`
Expected: FAIL — `getTopRecordings is not a function`.

- [ ] **Step 3: Amend the module header**

The header currently declares the whole module experimental. Replace the `IMPORTANT:` paragraph in `server/src/services/listenBrainz.js` with:

```js
// This module talks to two ListenBrainz hosts with different stability
// guarantees, and the difference matters:
//
//   labs.api.listenbrainz.org  - similar artists. Explicitly EXPERIMENTAL. The
//     algorithm parameter is a long opaque string that could change or vanish,
//     and the service advertises no rate-limit headers.
//   api.listenbrainz.org       - popularity. The main, documented API.
//
// Sturdier is not sturdy: as of 2026-08-02 the popularity endpoints answer 500
// with "Popularity API currently disabled due to high load on the server". So
// the contract is the same for both halves — every failure returns null, callers
// degrade rather than break, and null is never cached. Playlist fill treats a
// null here as "rank this artist chronologically instead".
```

- [ ] **Step 4: Implement**

Add to `server/src/services/listenBrainz.js`:

```js
const API_BASE_URL = 'https://api.listenbrainz.org';

// Popularity shifts slowly and the endpoint is expensive enough upstream to be
// switched off under load, so this is cached for a day rather than an hour.
const POPULARITY_TTL_MS = 24 * 60 * 60 * 1000;

const popularityCache = new TTLCache({ maxEntries: 1000 });

/**
 * An artist's most-listened recordings, most listened first.
 *
 * @param {string} artistMbid
 * @returns {Promise<Array<{name, recordingMbid, listenCount}>|null>}
 *   an array (possibly empty — a real "nothing recorded") on success, or `null`
 *   when the service could not be reached or is disabled. Same distinction the
 *   similar-artist half makes: an empty result is worth caching, an outage is
 *   not.
 */
export async function getTopRecordings(artistMbid) {
  if (!artistMbid) return null;

  const cached = popularityCache.get(artistMbid);
  if (cached !== undefined) return cached;

  const url = new URL(`/1/popularity/top-recordings-for-artist/${artistMbid}`, API_BASE_URL);

  const result = await rateLimiter.schedule(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    // 500 is the current steady state of this endpoint, not an exceptional
    // event. It takes the same path as any other failure.
    if (!response.ok) return null;
    try {
      const json = await response.json();
      if (!Array.isArray(json)) return null;
      return json
        .filter((r) => r?.recording_name)
        .map((r) => ({
          name: r.recording_name,
          recordingMbid: r.recording_mbid ?? null,
          listenCount: r.total_listen_count ?? 0,
        }));
    } catch {
      return null;
    }
  });

  if (result !== null) popularityCache.set(artistMbid, result, POPULARITY_TTL_MS);
  return result;
}

// Test seam, matching resetSimilarCacheForTest above.
export function resetPopularityCacheForTest() {
  popularityCache.store.clear();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && node --experimental-test-module-mocks --test test/listenBrainz.test.js`
Expected: PASS — the five new tests plus every pre-existing one.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/listenBrainz.js server/test/listenBrainz.test.js
git commit -m "Ask ListenBrainz which of an artist's recordings get played"
```

---

## Task 5: Let discovery keep the artists you own

**Files:**
- Modify: `server/src/services/libraryDiscovery.js:160-230`
- Test: `server/test/libraryDiscovery.test.js` (add cases; existing ones are the regression guard)

**Interfaces:**
- Produces: `collectNeighbours(db, { seeds, excludeOwned }) -> Promise<{artists, listenBrainz}>`. `getSimilarArtists` keeps its current signature and results exactly.

- [ ] **Step 1: Write the failing test**

Add to `server/test/libraryDiscovery.test.js`:

```js
test('excludeOwned false keeps neighbours already in the library', async () => {
  // Seeded so that a neighbour of the seed is itself an owned artist.
  const db = seededLibrary();          // existing helper in this file
  stubSignals({ related: [{ mbid: 'nb-1', name: 'Massive Attack' }], similar: [] });

  const excluded = await collectNeighbours(db, {
    seeds: [{ artist: 'Portishead', mbArtistId: 'seed-1' }], excludeOwned: true,
  });
  assert.equal(excluded.artists.find((a) => a.name === 'Massive Attack'), undefined);

  const included = await collectNeighbours(db, {
    seeds: [{ artist: 'Portishead', mbArtistId: 'seed-1' }], excludeOwned: false,
  });
  assert.ok(included.artists.find((a) => a.name === 'Massive Attack'),
    'a playlist needs exactly the neighbours the Discover tab throws away');
  db.close();
});

test('the Discover tab still excludes owned artists by default', async () => {
  const db = seededLibrary();
  stubSignals({ related: [{ mbid: 'nb-1', name: 'Massive Attack' }], similar: [] });
  const { artists } = await getSimilarArtists({ db, limit: 30 });
  assert.equal(artists.find((a) => a.name === 'Massive Attack'), undefined);
  db.close();
});
```

Read the existing test file first and reuse its helpers for seeding and for stubbing `getRelatedArtists` / `getSimilarArtists`. If it has no `seededLibrary`/`stubSignals` helper, extract one from the existing setup rather than writing a parallel one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/libraryDiscovery.test.js`
Expected: FAIL — `collectNeighbours is not exported`.

- [ ] **Step 3: Extract the accumulator**

In `server/src/services/libraryDiscovery.js`, replace the body of `computeSimilarArtists` with a call to a new exported function. The `note()` closure moves inside it, and its opening owned-check becomes conditional:

```js
/**
 * Walk both signals for a list of seeds and rank what they point at.
 *
 * `excludeOwned` is the CALLER'S policy, not this function's behaviour, and that
 * is the whole point of the split. The Discover tab wants music you don't have,
 * so it passes true. A playlist wants the opposite — the neighbours you own are
 * exactly the ones it can put on a device — so it passes false. One walk of the
 * signals, one cache, two meanings.
 *
 * @returns {Promise<{artists: object[], listenBrainz: 'ok'|'unavailable'|'disabled'}>}
 */
export async function collectNeighbours(db, { seeds, excludeOwned = true, limit = 30 }) {
  const owned = excludeOwned ? new Set(listArtistNames(db).map(artistKey)) : null;

  const found = new Map();
  let listenBrainzAnswered = false;

  function note(candidate, seed, kind, rank) {
    if (owned && owned.has(artistKey(candidate.name))) return;
    const existing = found.get(candidate.mbid);
    if (existing) {
      existing.score += 1;
      existing.kinds.add(kind);
      existing.bestRank = Math.min(existing.bestRank, rank);
      if (kind === 'related' && !existing.relation) existing.relation = candidate.relation;
      if (!existing.via.includes(seed.artist)) existing.via.push(seed.artist);
      return;
    }
    found.set(candidate.mbid, {
      mbid: candidate.mbid,
      name: candidate.name,
      relation: kind === 'related' ? candidate.relation : null,
      comment: candidate.comment ?? null,
      kinds: new Set([kind]),
      bestRank: rank,
      via: [seed.artist],
      score: 1,
    });
  }

  for (const seed of seeds) {
    const { related, similar } = await signalsFor(db, seed.mbArtistId);
    if (similar.length) listenBrainzAnswered = true;
    related.forEach((a, i) => note(a, seed, 'related', i));
    similar.slice(0, SIMILAR_PER_SEED).forEach((a, i) => note(a, seed, 'similar', i));
  }

  const artists = [...found.values()]
    .map(({ kinds, ...rest }) => ({ ...rest, kind: kinds.size > 1 ? 'both' : [...kinds][0] }))
    .sort((a, b) => (
      b.score - a.score || a.bestRank - b.bestRank || a.name.localeCompare(b.name)
    ))
    .slice(0, limit);

  return {
    artists,
    listenBrainz: config.discovery.listenBrainzEnabled
      ? (listenBrainzAnswered ? 'ok' : 'unavailable')
      : 'disabled',
  };
}

async function computeSimilarArtists({ db, limit }) {
  const seeds = await seedArtists(db, SEED_ARTISTS);
  const { artists, listenBrainz } = await collectNeighbours(db, { seeds, excludeOwned: true, limit });
  return {
    seeds: seeds.map((s) => ({ artist: s.artist, trackCount: s.trackCount })),
    artists,
    listenBrainz,
  };
}
```

Also export `resolveArtist`-backed seeding for reuse:

```js
// Exported so playlistDiscovery can seed from an artist the user names rather
// than from the top of the collection.
export async function resolveSeedArtists(db, names) {
  const seeds = [];
  for (const artist of names) {
    const { mbArtistId } = await resolveArtist(artist, { db });
    if (mbArtistId) seeds.push({ artist, mbArtistId });
  }
  return seeds;
}
```

- [ ] **Step 4: Run the whole discovery suite**

Run: `cd server && node --experimental-test-module-mocks --test test/libraryDiscovery.test.js`
Expected: PASS — **including every pre-existing test unchanged**. This is working code being reshaped; if any existing assertion had to be edited, the refactor changed behaviour and is wrong.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/libraryDiscovery.js server/test/libraryDiscovery.test.js
git commit -m "Make the owned-artist filter discovery's caller's decision"
```

---

## Task 6: The candidate pool

**Files:**
- Create: `server/src/services/playlistDiscovery.js`
- Test: `server/test/playlistDiscovery.test.js`

**Interfaces:**
- Consumes: `collectNeighbours`, `resolveSeedArtists` (Task 5); `getTopRecordings` (Task 4); `filterByDuration`, `fillPlaylist` (Task 3); `listTracks` from `libraryRepo`.
- Produces: `suggestTracks(db, { seedArtists, method, target, byteBudget, preferPopular, minMs, maxMs, existingKeys }) -> Promise<{ picked, cap, stopped, neighbours, popularity, listenBrainz }>` where `popularity` is `'ok' | 'unavailable'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/playlistDiscovery.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

test('builds a pool from owned neighbours and reports popularity being down', async (t) => {
  const db = openDb(':memory:');
  for (let i = 1; i <= 4; i += 1) {
    repo.upsertLocalTrack(db, {
      path: `/m/MA/Mez/0${i}.flac`, artist: 'Massive Attack', album: 'Mezzanine',
      title: `T${i}`, durationMs: 200_000, sizeBytes: 1000, year: 1998,
      trackNumber: i, changeKey: `${i}:1`,
    });
  }
  // A track that must not survive the duration filter.
  repo.upsertLocalTrack(db, {
    path: '/m/MA/Mez/99.flac', artist: 'Massive Attack', album: 'Mezzanine',
    title: 'Silence', durationMs: 900_000, sizeBytes: 1000, changeKey: '99:1',
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    namedExports: {
      resolveSeedArtists: async () => [{ artist: 'Portishead', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 2, via: ['Portishead'], kind: 'both' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    namedExports: { getTopRecordings: async () => null },  // the live 500
  });

  const { suggestTracks } = await import('../src/services/playlistDiscovery.js');
  const result = await suggestTracks(db, { seedArtists: ['Portishead'], method: 'popular', target: 3 });

  assert.equal(result.picked.length, 3);
  assert.ok(result.picked.every((p) => p.artist === 'Massive Attack'));
  assert.ok(!result.picked.some((p) => p.title === 'Silence'), 'the 15-minute track is filtered out');
  assert.equal(result.popularity, 'unavailable');
  // With no ranks, popular falls back to year then track number.
  assert.deepEqual(result.picked.map((p) => p.title), ['T1', 'T2', 'T3']);
  db.close();
});

test('ranks owned tracks by the popularity list when it answers', async (t) => {
  const db = openDb(':memory:');
  ['Alpha', 'Beta', 'Gamma'].forEach((title, i) => {
    repo.upsertLocalTrack(db, {
      path: `/m/MA/${title}.flac`, artist: 'Massive Attack', album: 'Mezzanine',
      title, durationMs: 200_000, sizeBytes: 1000, year: 1998, trackNumber: i + 1,
      changeKey: `${i}:1`,
    });
  });

  t.mock.module('../src/services/libraryDiscovery.js', {
    namedExports: {
      resolveSeedArtists: async () => [{ artist: 'P', mbArtistId: 'seed-1' }],
      collectNeighbours: async () => ({
        artists: [{ mbid: 'nb-1', name: 'Massive Attack', score: 1, via: ['P'], kind: 'similar' }],
        listenBrainz: 'ok',
      }),
    },
  });
  t.mock.module('../src/services/listenBrainz.js', {
    namedExports: {
      getTopRecordings: async () => [
        { name: 'Gamma', recordingMbid: null, listenCount: 900 },
        { name: 'Alpha', recordingMbid: null, listenCount: 100 },
      ],
    },
  });

  const { suggestTracks } = await import('../src/services/playlistDiscovery.js');
  const result = await suggestTracks(db, { seedArtists: ['P'], method: 'popular', target: 3 });

  assert.deepEqual(result.picked.map((p) => p.title), ['Gamma', 'Alpha', 'Beta']);
  assert.equal(result.popularity, 'ok');
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistDiscovery.test.js`
Expected: FAIL — cannot find module `playlistDiscovery.js`.

- [ ] **Step 3: Implement**

Create `server/src/services/playlistDiscovery.js`:

```js
import { getDb } from '../lib/db.js';
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';
import { listTracks } from './libraryRepo.js';
import { collectNeighbours, resolveSeedArtists } from './libraryDiscovery.js';
import { getTopRecordings } from './listenBrainz.js';
import { filterByDuration, fillPlaylist, MIN_DURATION_MS, MAX_DURATION_MS } from './playlistFill.js';

// Turns "music like this" into "tracks you own like this".
//
// The glue, and the only place in the playlist feature that does both network
// and database work — which is precisely why playlistFill does neither.

// How many neighbours to pull tracks from. Each one costs a popularity lookup
// through the shared rate limiter, so this is the knob that decides whether a
// suggestion takes a second or half a minute.
const MAX_NEIGHBOURS = 12;

function ownedTracksFor(db, artist) {
  const { tracks } = listTracks(db, { artist, limit: 500 });
  return tracks;
}

// Match a popularity entry to a file by the same folded title the rest of the
// feature resolves on, so "Teardrop (Remastered)" on disk still finds "Teardrop"
// in the list.
function rankTracks(tracks, topRecordings) {
  if (!topRecordings) return tracks.map((t) => ({ ...t, popularityRank: null }));
  const rankByTitle = new Map();
  topRecordings.forEach((rec, i) => {
    const key = makeTitleKey(rec.name);
    if (!rankByTitle.has(key)) rankByTitle.set(key, i);
  });
  return tracks.map((t) => ({
    ...t,
    popularityRank: rankByTitle.get(makeTitleKey(t.title)) ?? null,
  }));
}

/**
 * Propose tracks for a playlist. Writes nothing — that is the review step.
 */
export async function suggestTracks(db = getDb(), {
  seedArtists,
  method = 'popular',
  target = 50,
  byteBudget = null,
  preferPopular = false,
  minMs = MIN_DURATION_MS,
  maxMs = MAX_DURATION_MS,
  existingKeys = new Set(),
} = {}) {
  const seeds = await resolveSeedArtists(db, seedArtists);
  const { artists: neighbours, listenBrainz } = await collectNeighbours(db, {
    seeds, excludeOwned: false, limit: MAX_NEIGHBOURS,
  });

  let anyPopularity = false;
  let pool = [];

  for (const neighbour of neighbours) {
    const owned = filterByDuration(ownedTracksFor(db, neighbour.name), { minMs, maxMs });
    if (!owned.length) continue;

    // Null here is the live steady state: the popularity API is disabled
    // upstream. It degrades to a chronological ordering inside playlistFill
    // rather than failing the suggestion.
    const top = await getTopRecordings(neighbour.mbid);
    if (top !== null) anyPopularity = true;

    pool = pool.concat(rankTracks(owned, top).map((t) => ({
      ...t,
      matchKey: makeMatchKey(t.artist, t.title),
      signalScore: neighbour.score,
      seedArtist: neighbour.via[0] ?? null,
    })));
  }

  const { picked, cap, stopped } = fillPlaylist({
    pool, target, byteBudget, method, preferPopular, existingKeys,
  });

  return {
    picked,
    cap,
    stopped,
    // Reported so the UI can say the fill ran on a thinner signal than usual,
    // the way the Discover tab already does for ListenBrainz.
    neighbours: neighbours.map((n) => ({ name: n.name, via: n.via, kind: n.kind })),
    popularity: anyPopularity ? 'ok' : 'unavailable',
    listenBrainz,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistDiscovery.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/playlistDiscovery.js server/test/playlistDiscovery.test.js
git commit -m "Propose owned tracks from the artists next to a seed"
```

---

## Task 7: Export

**Files:**
- Modify: `server/src/config.js`
- Modify: `server/src/lib/paths.js`
- Create: `server/src/services/playlistExport.js`
- Test: `server/test/playlistExport.test.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: resolved items from `playlistRepo.getPlaylist` (Task 2).
- Produces:
  - `config.playlist.dropoffDir`, `playlistExportEnabled()`
  - `assertInsideDropoffDir(destPath) -> string`
  - `writeM3u({ name, items }) -> Promise<{ path, written, skipped }>`
  - `inspectDropoff(name) -> Promise<{ exists, fileCount, exportedAt }|null>`
  - `exportToDropoff({ name, items, onProgress, signal }) -> Promise<{ dir, copied, skipped, bytes }>`

- [ ] **Step 1: Write the failing test**

Create `server/test/playlistExport.test.js`:

```js
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

test('a name that tries to escape the drop-off root is refused', async () => {
  const a = await seedFile('A/B/seven.mp3');
  await assert.rejects(
    () => exportToDropoff({ name: '../escape', items: [item('A', 'Seven', a)] }),
    /outside/i,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistExport.test.js`
Expected: FAIL — cannot find module `playlistExport.js`.

- [ ] **Step 3: Add config and the containment guard**

In `server/src/config.js`, add after the `library` block:

```js
  playlist: {
    // Where "export to player" copies files. Opt-in, like INGEST_DIR: unset
    // means the feature is hidden. Deliberately not a folder inside MUSIC_DIR —
    // the copies would sit on the music volume (which is often a network share
    // when the player is USB) and the scanner would index every one of them as a
    // duplicate.
    dropoffDir: process.env.DROPOFF_DIR || null,
  },
```

and at the bottom:

```js
export function playlistExportEnabled() {
  return Boolean(config.ingest.musicDir && config.playlist.dropoffDir);
}
```

In `server/src/lib/paths.js`:

```js
// The write-side containment check for the drop-off folder, and the guard on the
// one path in this app that deletes files it did not create. Stricter than the
// MUSIC_DIR equivalent because of that: the root is resolved through realpath so
// a symlinked DROPOFF_DIR can't point the delete at the music library, and a
// root that resolves to MUSIC_DIR, to a parent of it, or to the filesystem root
// is refused outright.
export async function assertInsideDropoffDir(destPath) {
  const configured = config.playlist.dropoffDir;
  if (!configured) throw new BadRequestError('No drop-off folder is configured');

  let root;
  try {
    root = await fs.realpath(path.resolve(configured));
  } catch {
    throw new BadRequestError('The drop-off folder is not readable');
  }

  const musicRoot = path.resolve(config.ingest.musicDir ?? '');
  if (root === path.parse(root).root) {
    throw new BadRequestError('Refusing to use the filesystem root as a drop-off folder');
  }
  if (musicRoot && (root === musicRoot || musicRoot.startsWith(root + path.sep))) {
    throw new BadRequestError('The drop-off folder must be outside the music folder');
  }

  const resolved = path.resolve(destPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.warn(`paths: refusing to write outside DROPOFF_DIR: ${destPath}`);
    throw new BadRequestError('Refusing to write outside the drop-off folder');
  }
  return resolved;
}
```

- [ ] **Step 4: Implement the exporter**

Create `server/src/services/playlistExport.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeSegment } from './organize.js';
import { assertInsideMusicDir, assertInsideDropoffDir } from '../lib/paths.js';
import { noteWrite } from '../lib/recentWrites.js';
import { withFileLock } from '../lib/fileLock.js';
import { BadRequestError } from '../lib/httpErrors.js';

// Writing a playlist out: an m3u at the music root, or a folder of copies bound
// for an MP3 player.

function m3uPathFor(name) {
  return path.join(config.ingest.musicDir, `${sanitizeSegment(name)}.m3u`);
}

/**
 * Extended M3U at MUSIC_DIR/<name>.m3u.
 *
 * Paths are relative to the music root: the file sits at that root, and a
 * relative path is what survives the playlist being read on another machine or
 * under a different mount point.
 */
export async function writeM3u({ name, items }) {
  const target = m3uPathFor(name);
  assertInsideMusicDir(target);

  const lines = ['#EXTM3U'];
  let written = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.track) {
      // A gap can't be a path. Written as a comment so the file stays a complete
      // record of the playlist instead of a silently shortened one — players
      // ignore '#' lines.
      lines.push(`# missing: ${item.artist ? `${item.artist} - ` : ''}${item.title}`);
      skipped += 1;
      continue;
    }
    const seconds = Math.round((item.track.durationMs ?? 0) / 1000);
    const label = `${item.track.artist ?? 'Unknown'} - ${item.track.title}`;
    const relative = path.relative(config.ingest.musicDir, item.track.path).split(path.sep).join('/');
    lines.push(`#EXTINF:${seconds},${label}`);
    lines.push(relative);
    written += 1;
  }

  // Temp-then-rename, so a half-written playlist never exists at the real path.
  const temp = `${target}.partial`;
  await fs.writeFile(temp, `${lines.join('\n')}\n`, 'utf8');
  await fs.rename(temp, target);

  // Without this the MUSIC_DIR watcher sees a new file at the root and debounces
  // into a full scanLibrary() — librarySync.js does not filter by extension, so
  // every export would rescan the whole collection. Both names are noted because
  // the rename fires an event for each.
  noteWrite(temp);
  noteWrite(target);

  return { path: target, written, skipped };
}

function dropoffDirFor(name) {
  const segment = sanitizeSegment(name);
  return path.join(config.playlist.dropoffDir ?? '', segment);
}

/** What is already at the drop-off destination, so the caller can confirm. */
export async function inspectDropoff(name) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  try {
    const [entries, stat] = await Promise.all([fs.readdir(dir), fs.stat(dir)]);
    return { exists: true, dir, fileCount: entries.length, exportedAt: stat.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, dir, fileCount: 0, exportedAt: null };
    throw err;
  }
}

// Zero-padded to the width of the track count, not to two digits. A 100-track
// playlist padded to two sorts as 1, 10, 100, 11 on a device that orders by
// filename — which defeats the entire purpose of numbering it.
function fileNameFor(item, index, total) {
  const width = String(total).length;
  const position = String(index).padStart(width, '0');
  const artist = sanitizeSegment(item.track.artist ?? 'Unknown');
  const title = sanitizeSegment(item.track.title);
  return `${position} - ${artist} - ${title}${item.track.ext ?? path.extname(item.track.path)}`;
}

async function freeBytes(dir) {
  const stat = await fs.statfs(dir);
  return stat.bavail * stat.bsize;
}

/**
 * Copy the playlist's resolved tracks into DROPOFF_DIR/<name>/.
 *
 * Wipe-and-rewrite rather than a sync: the destructive step happens only after
 * the caller has seen inspectDropoff's count and asked for it, and "delete the
 * folder, write it fresh" is a few lines that are easy to get right where a
 * diff-and-renumber has to reason about which files it owns.
 */
export async function exportToDropoff({ name, items, onProgress, signal }) {
  const dir = await assertInsideDropoffDir(dropoffDirFor(name));
  const playable = items.filter((i) => i.track);
  const skipped = items.length - playable.length;
  const totalBytes = playable.reduce((sum, i) => sum + (i.track.sizeBytes ?? 0), 0);

  return withFileLock(`dropoff:${dir}`, async () => {
    // Fail before copying rather than halfway through filling a device.
    const available = await freeBytes(config.playlist.dropoffDir);
    if (totalBytes > available) {
      throw new BadRequestError(
        `Not enough room: the playlist needs ${totalBytes} bytes and ${available} are free`
      );
    }

    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    let copied = 0;
    let bytes = 0;
    for (const [i, item] of playable.entries()) {
      if (signal?.aborted) break;
      const dest = path.join(dir, fileNameFor(item, i + 1, playable.length));
      await assertInsideDropoffDir(dest);
      await fs.copyFile(item.track.path, dest);
      copied += 1;
      bytes += item.track.sizeBytes ?? 0;
      onProgress?.({ index: i + 1, total: playable.length, title: item.track.title, bytes });
    }

    return { dir, copied, skipped, bytes };
  });
}
```

- [ ] **Step 5: Add `DROPOFF_DIR` to `.env.example`**

```bash
# Optional. Where "export to player" copies a playlist's files, ready to be
# moved onto an MP3 player. Unset hides the feature. Keep it outside MUSIC_DIR:
# the copies would otherwise sit on the music volume and be indexed as
# duplicates.
DROPOFF_DIR=
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && node --experimental-test-module-mocks --test test/playlistExport.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/config.js server/src/lib/paths.js server/src/services/playlistExport.js server/test/playlistExport.test.js .env.example
git commit -m "Write a playlist out as an m3u or a folder of copies"
```

---

## Task 8: The HTTP surface

**Files:**
- Create: `server/src/routes/playlists.js`
- Modify: `server/src/app.js`
- Modify: `server/src/routes/config.js`
- Test: `server/test/routes/playlists.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2, 6 and 7.
- Produces: the endpoints listed below. `GET /api/config` gains `playlistExportEnabled`.

**Deviation from the spec, and why:** the spec lists the drop-off export as `POST`. It has to be `GET`, because the browser's `EventSource` only issues GET requests, and every SSE stream in this codebase is a GET that opts into `sameOriginOnly` individually (see the comment in `app.js`). The m3u export stays `POST` — it is fast and does not stream.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes/playlists.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rm-'));
const dropoffDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rd-'));

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = musicDir;
process.env.DROPOFF_DIR = dropoffDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;
let db;

test.before(async () => {
  await fs.mkdir(path.join(musicDir, 'A', 'Al'), { recursive: true });
  await fs.writeFile(path.join(musicDir, 'A', 'Al', '01.mp3'), Buffer.alloc(16, 1));

  db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: path.join(musicDir, 'A', 'Al', '01.mp3'), artist: 'A', album: 'Al',
    title: 'One', durationMs: 200_000, sizeBytes: 16, ext: '.mp3', changeKey: '1:1',
  });
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  setDbForTest(null);
  server.close();
  await fs.rm(musicDir, { recursive: true, force: true });
  await fs.rm(dropoffDir, { recursive: true, force: true });
});

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  body: JSON.stringify(body),
});

test('creates a playlist and adds an item that resolves', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Trip' })).json();
  assert.ok(created.id);

  const added = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  assert.equal(added.status, 200);

  const body = await (await fetch(`${baseUrl}/api/playlists/${created.id}`)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].track.title, 'One');
});

test('rejects a blank name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: '   ' });
  assert.equal(res.status, 400);
});

test('rejects a duplicate name with a 409', async () => {
  await postJson(`${baseUrl}/api/playlists`, { name: 'Dupe' });
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'dupe' });
  assert.equal(res.status, 409);
});

test('rejects an over-long name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'x'.repeat(300) });
  assert.equal(res.status, 400);
});

test('rejects more items than the cap allows', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Big' })).json();
  const items = Array.from({ length: 5001 }, (_, i) => ({ title: `t${i}`, source: 'manual' }));
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, { items });
  assert.equal(res.status, 400);
});

test('404s an unknown playlist', async () => {
  const res = await fetch(`${baseUrl}/api/playlists/99999`);
  assert.equal(res.status, 404);
});

test('exports an m3u to the music root', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'M3U Test' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(res.status, 200);
  const text = await fs.readFile(path.join(musicDir, 'M3U Test.m3u'), 'utf8');
  assert.match(text, /A\/Al\/01\.mp3/);
});

test('reports an existing drop-off folder instead of overwriting it', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Drop' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  await fs.mkdir(path.join(dropoffDir, 'Drop'), { recursive: true });
  await fs.writeFile(path.join(dropoffDir, 'Drop', 'stale.mp3'), 'x');

  const res = await fetch(`${baseUrl}/api/playlists/${created.id}/export/dropoff`);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.existing.fileCount, 1);
});

test('config advertises whether export to player is available', async () => {
  const body = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(body.playlistExportEnabled, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --experimental-test-module-mocks --test test/routes/playlists.test.js`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Implement the router**

Create `server/src/routes/playlists.js`:

```js
import { Router } from 'express';
import { libraryEnabled, playlistExportEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  createPlaylist, listPlaylists, getPlaylist, renamePlaylist, deletePlaylist,
  addItems, removeItem, reorderItems, noteExport,
} from '../services/playlistRepo.js';
import { suggestTracks } from '../services/playlistDiscovery.js';
import { writeM3u, inspectDropoff, exportToDropoff } from '../services/playlistExport.js';
import { MIN_DURATION_MS, MAX_DURATION_MS } from '../services/playlistFill.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { sseStream, STREAM_HANDLED } from '../lib/sse.js';

export const playlistsRouter = Router();

// Bounds, in the spirit of the ones the rest of the app already applies. A
// request is clamped or refused here rather than trusted downstream.
const MAX_NAME_LENGTH = 200;
const MAX_ITEMS_PER_REQUEST = 5000;
const MAX_TARGET = 1000;
const MAX_BYTE_BUDGET = 2 ** 40; // 1 TiB — a sanity ceiling, not a real limit.

playlistsRouter.use((req, res, next) => {
  if (!libraryEnabled()) return next(new NotFoundError('The library feature is not configured'));
  next();
});

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new BadRequestError('A playlist needs a name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(`A playlist name is at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) throw new BadRequestError('items must be an array');
  if (raw.length > MAX_ITEMS_PER_REQUEST) {
    throw new BadRequestError(`At most ${MAX_ITEMS_PER_REQUEST} items in one request`);
  }
  return raw.map((item) => {
    const title = String(item?.title ?? '').trim();
    if (!title) throw new BadRequestError('Every item needs a title');
    return {
      title: title.slice(0, MAX_NAME_LENGTH),
      artist: item.artist ? String(item.artist).trim().slice(0, MAX_NAME_LENGTH) : null,
      album: item.album ? String(item.album).trim().slice(0, MAX_NAME_LENGTH) : null,
      source: ['manual', 'popular', 'random', 'paste'].includes(item.source) ? item.source : 'manual',
      seedArtist: item.seedArtist ? String(item.seedArtist).slice(0, MAX_NAME_LENGTH) : null,
    };
  });
}

function loadPlaylist(id) {
  const playlist = getPlaylist(getDb(), Number(id));
  if (!playlist) throw new NotFoundError('No such playlist');
  return playlist;
}

playlistsRouter.get('/', (req, res) => {
  res.json({ playlists: listPlaylists(getDb()) });
});

playlistsRouter.post('/', (req, res) => {
  const name = cleanName(req.body?.name);
  try {
    res.json(createPlaylist(getDb(), { name }));
  } catch (err) {
    // The UNIQUE index on name_key is what enforces this; catching it here
    // rather than pre-checking avoids a check-then-act race.
    if (String(err.message).includes('UNIQUE')) {
      res.status(409).json({ error: { code: 'DUPLICATE_NAME', message: 'A playlist with that name already exists' } });
      return;
    }
    throw err;
  }
});

playlistsRouter.get('/:id', (req, res) => {
  res.json(loadPlaylist(req.params.id));
});

playlistsRouter.patch('/:id', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  renamePlaylist(getDb(), playlist.id, cleanName(req.body?.name));
  res.json({ ok: true });
});

playlistsRouter.delete('/:id', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  deletePlaylist(getDb(), playlist.id);
  res.json({ ok: true });
});

playlistsRouter.post('/:id/items', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  res.json(addItems(getDb(), playlist.id, cleanItems(req.body?.items)));
});

playlistsRouter.delete('/:id/items/:itemId', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  removeItem(getDb(), playlist.id, Number(req.params.itemId));
  res.json({ ok: true });
});

playlistsRouter.patch('/:id/order', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(Number) : null;
  if (!ids) throw new BadRequestError('itemIds must be an array');
  reorderItems(getDb(), playlist.id, ids);
  res.json({ ok: true });
});

// Writes nothing. This IS the review step: the client shows what comes back,
// the user unticks, and what survives goes to POST /items.
playlistsRouter.post('/:id/suggest', async (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  const seedArtists = Array.isArray(req.body?.seedArtists)
    ? req.body.seedArtists.map((a) => String(a).trim()).filter(Boolean).slice(0, 10)
    : [];
  if (!seedArtists.length) throw new BadRequestError('Pick at least one artist to start from');

  const target = Math.min(MAX_TARGET, Math.max(1, Number(req.body?.target) || 50));
  const rawBudget = Number(req.body?.byteBudget);
  const byteBudget = Number.isFinite(rawBudget) && rawBudget > 0
    ? Math.min(MAX_BYTE_BUDGET, rawBudget)
    : null;

  const result = await suggestTracks(getDb(), {
    seedArtists,
    method: req.body?.method === 'random' ? 'random' : 'popular',
    target,
    byteBudget,
    preferPopular: Boolean(req.body?.preferPopular),
    minMs: Number(req.body?.minMs) || MIN_DURATION_MS,
    maxMs: Number(req.body?.maxMs) || MAX_DURATION_MS,
    existingKeys: new Set(playlist.items.map((i) => i.matchKey)),
  });
  res.json(result);
});

playlistsRouter.post('/:id/export/m3u', async (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  const result = await writeM3u({ name: playlist.name, items: playlist.items });
  res.json(result);
});

// GET, not POST: EventSource only issues GET requests, which is why every SSE
// stream in this app is a GET that opts into the CSRF guard by hand.
playlistsRouter.get('/:id/export/dropoff', sameOriginOnly, async (req, res, next) => {
  if (!playlistExportEnabled()) {
    return next(new NotFoundError('No drop-off folder is configured'));
  }
  const playlist = loadPlaylist(req.params.id);

  if (req.query.replace !== '1') {
    const existing = await inspectDropoff(playlist.name);
    if (existing.exists) {
      return res.status(409).json({
        error: {
          code: 'DROPOFF_EXISTS',
          message: 'That folder already exists. Confirm to replace it.',
          existing: { fileCount: existing.fileCount, exportedAt: existing.exportedAt },
        },
      });
    }
  }

  return sseStream(async ({ send, signal }) => {
    const result = await exportToDropoff({
      name: playlist.name,
      items: playlist.items,
      onProgress: (p) => send('progress', p),
      signal,
    });
    noteExport(getDb(), playlist.id, result.dir);
    return result;
  })(req, res);
});
```

- [ ] **Step 4: Mount it and advertise the flag**

In `server/src/app.js`, add the import and the mount beside the library one:

```js
import { playlistsRouter } from './routes/playlists.js';
...
  app.use('/api/playlists', gate, playlistsRouter);
```

In `server/src/routes/config.js`, add `playlistExportEnabled` to the payload alongside the existing `ingestEnabled` / `libraryEnabled` flags, importing it from `../config.js`.

- [ ] **Step 5: Run the tests**

Run: `cd server && npm test`
Expected: PASS — the new route suite plus the whole existing suite.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/playlists.js server/src/app.js server/src/routes/config.js server/test/routes/playlists.test.js
git commit -m "Expose playlists over HTTP, streaming the copy to the player"
```

---

## Task 9: The client

**Files:**
- Create: `client/src/api/playlists.js`, `client/src/pages/PlaylistsPage.jsx`, `client/src/components/playlist/PlaylistDetail.jsx`, `client/src/components/playlist/AddTracksPanel.jsx`, `client/src/components/playlist/SuggestPanel.jsx`, `client/src/components/AddToPlaylistButton.jsx`
- Modify: `client/src/App.jsx`, `client/src/components/library/DiscoveryPanel.jsx`, `client/src/pages/LibraryPage.jsx`, `client/src/styles/index.css`
- Move: `client/src/components/library/PlaylistPanel.jsx` → `client/src/components/playlist/PastePanel.jsx`

**Interfaces:**
- Consumes: the endpoints from Task 8.
- Produces: `/playlists` route; `AddToPlaylistButton` usable from any track row.

- [ ] **Step 1: Write the API module**

Create `client/src/api/playlists.js`:

```js
import { get, post, patch, del } from './client.js';

export function listPlaylists() {
  return get('/playlists');
}

export function createPlaylist(name) {
  return post('/playlists', { name });
}

export function getPlaylist(id) {
  return get(`/playlists/${id}`);
}

export function renamePlaylist(id, name) {
  return patch(`/playlists/${id}`, { name });
}

export function deletePlaylist(id) {
  return del(`/playlists/${id}`);
}

export function addPlaylistItems(id, items) {
  return post(`/playlists/${id}/items`, { items });
}

export function removePlaylistItem(id, itemId) {
  return del(`/playlists/${id}/items/${itemId}`);
}

export function reorderPlaylist(id, itemIds) {
  return patch(`/playlists/${id}/order`, { itemIds });
}

// Returns proposals and writes nothing — the review step lives on the client.
export function suggestPlaylistTracks(id, options) {
  return post(`/playlists/${id}/suggest`, options);
}

export function exportM3u(id) {
  return post(`/playlists/${id}/export/m3u`, {});
}

// A GET because EventSource only does GET; the caller opens the stream itself
// via lib/eventStream.js. Exposed as a URL rather than a fetch so the 409
// pre-check and the stream can share one path.
export function dropoffUrl(id, { replace = false } = {}) {
  return `/api/playlists/${id}/export/dropoff${replace ? '?replace=1' : ''}`;
}
```

- [ ] **Step 2: Build the page and components**

Follow the existing conventions exactly: `useServerList`/`usePagination` where they fit, `formatDuration` from `lib/format.js`, the `library-table` / `gap-panel` / `banner banner-error` class names already in `styles/index.css`, and `lib/eventStream.js` for the SSE consumption (copy the pattern from `BulkVerifyPanel.jsx`).

`PlaylistsPage.jsx` — list of playlists with name, `itemCount`, `gapCount`, `totalBytes` (via `formatBytes`), `lastExportedAt`; a create form; click through to detail.

`PlaylistDetail.jsx` — ordered rows with drag-to-reorder calling `reorderPlaylist`, a per-row remove, a play button calling `onPlay(track, queue)`, a provenance badge rendering `source` + `seedArtist`, and gap rows styled apart carrying a **Find on YouTube** button that routes into the existing verify flow with `{ artist, title }`. Header actions: Export m3u, Export to player, Rename, Delete. The Export-to-player button opens the SSE stream, renders per-file progress, and on a 409 shows a Replace confirmation naming `fileCount` and `exportedAt` before re-opening with `replace=1`.

`SuggestPanel.jsx` — seed picker, method radio (Popular / Chance), target, optional size limit in MB, prefer-popular checkbox, duration bounds behind an `<details>` disclosure. On submit, calls `suggestPlaylistTracks` and renders the proposals with tick boxes plus:
- the stop reason, e.g. `stopped === 'cap'` → "Filled 62 of 100; the per-artist cap held the rest back."
- the computed `cap`, as "at most 15 per artist".
- when `popularity === 'unavailable'`, the line "ListenBrainz popularity is unavailable — these are ordered by release date instead." **This will be the normal state until MetaBrainz re-enables the endpoint, so it must read as information rather than as an error.**

`AddTracksPanel.jsx` — tabs over `SuggestPanel`, `PastePanel` and a library search that adds directly.

`PastePanel.jsx` — the moved `PlaylistPanel.jsx`, with its results now feeding `addPlaylistItems` (found rows as `source: 'paste'` with their resolved artist/title, missing rows as `source: 'paste'` with the parsed line).

`AddToPlaylistButton.jsx` — a button opening a playlist picker, calling `addPlaylistItems` with `source: 'manual'`. Wire it into the Tracks tab rows, album pages, artist pages and search results.

- [ ] **Step 3: Route it and remove the old entry point**

In `client/src/App.jsx`, add beside the library entries:

```jsx
{libraryEnabled && <NavLink to="/playlists" className={navLinkClass}>Playlists</NavLink>}
...
{libraryEnabled && <Route path="/playlists" element={<PlaylistsPage />} />}
```

Remove the `PlaylistPanel` import and render from `DiscoveryPanel.jsx` / `LibraryPage.jsx`. Two places that build playlists and only one that saves them would be worse than moving it.

- [ ] **Step 4: Verify in the browser**

Run: `cd server && npm start` (with `MUSIC_DIR` and `DROPOFF_DIR` set) and `cd client && npm run dev`.

Check by hand:
1. Create a playlist, add a track from the Tracks tab, confirm it appears with the file resolved.
2. Paste three lines where one is not in the library; confirm two resolve and one shows as a gap with a working Find on YouTube.
3. Run a suggestion; confirm the cap line, the stop reason, and the popularity-unavailable notice all render.
4. Export an m3u; confirm the file at the music root has relative paths, and that **no library rescan is triggered** (watch the server log).
5. Export to the player; confirm progress streams, then export again and confirm the Replace prompt names the right file count.

- [ ] **Step 5: Commit**

```bash
git add client/src server/src
git commit -m "Give playlists a page of their own"
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Fix the opening claim**

Replace:

> Spinmatch **only finds and verifies YouTube links**. It does not download or copy audio.

with:

> Spinmatch **only finds and verifies YouTube links**. It does not download audio.

The copy clause is dropped: export copies files you already own, when you ask it to.

- [ ] **Step 2: Move the Discovery bullet**

Remove the "Rebuild a playlist" bullet from the Discovery section — it is no longer in that tab. Leave the two discovery signals and their rationale untouched.

- [ ] **Step 3: Add the Playlists section**

Add a `## Playlists` section after "Your library", added to the Contents list, covering: building from the library, from a pasted list, and from discovery; the two selection methods; the per-artist cap and duration filter, stated with their actual defaults; gaps and the verifier handoff; m3u export with relative paths; drop-off export with the numbering scheme and the replace confirmation.

State plainly that ListenBrainz's popularity API is currently disabled upstream and that Popular therefore orders by release date until it returns. Documenting a live degradation is the same honesty the Discovery section already applies to the experimental `labs.` subdomain.

- [ ] **Step 4: Document `DROPOFF_DIR`**

Add it to the Configuration section beside `MUSIC_DIR` and `INGEST_DIR`, noting it is optional, that unset hides the feature, and that it should live outside `MUSIC_DIR`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document playlists, and stop claiming nothing is ever copied"
```

---

## Self-review

**Spec coverage.** Every section maps to a task: data model → 1–2; modules → 2, 3, 4, 6, 7, 8; fill pipeline including the discovery refactor → 3, 5, 6; export → 7; UI → 9; failure modes → spread across 2, 4, 7, 8; testing → each task's own tests; README → 10.

**Deviations from the spec, all deliberate:**

1. **The drop-off export is `GET`, not `POST`** (Task 8). `EventSource` cannot POST, and every SSE stream in this codebase is a GET opting into `sameOriginOnly`.
2. **Popular has a defined fallback ordering** — album year, then track number — rather than the spec's "ranks by nothing". Since the upstream endpoint is disabled, "nothing" would have made Popular indistinguishable from Chance for every user, today.
3. **The v7 migration does not clear `change_key`.** The v2 and v6 backfills did, because they needed files re-read. These keys derive from columns already in the table, so forcing a full rescan would be waste.

**Type consistency.** `matchKey`/`titleKey` are camelCase in JS and `match_key`/`title_key` in SQL throughout. A pool candidate carries `{ artist, title, album, matchKey, durationMs, sizeBytes, year, trackNumber, popularityRank, signalScore }` in Tasks 3 and 6 identically. `fillPlaylist` returns `{ picked, cap, stopped }` in both. `stopped` is one of the same four strings everywhere. `resolveItems` attaches `track`, null for a gap, and Tasks 7 and 8 both read `item.track`.
