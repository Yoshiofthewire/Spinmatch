# Collection Manager (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Spinmatch a persistent index of the user's `MUSIC_DIR`, a library dashboard, and album gap detection (which tracks of an album you own vs. are missing, with YouTube links for the gaps).

**Architecture:** A synchronous SQLite index (built-in `node:sqlite`) is populated by a directory scanner that reads existing file tags. A sync layer runs the scan at startup, on an adaptive interval, and on filesystem changes. Read-only routes expose the index to a React dashboard; a gap-detection service compares a MusicBrainz release's tracklist against the index and reuses the existing `verifyTrack` service for missing-track YouTube links.

**Tech Stack:** Node 24 (ESM), Express 4, built-in `node:sqlite` (`DatabaseSync`), `node-taglib-sharp` (already a dep), React 18 + Vite, Node built-in test runner.

## Scope

This plan covers **Foundation + Phase 1 (MVP)** of `docs/superpowers/specs/2026-07-23-collection-manager-design.md`:
library index, adaptive sync, dashboard, album gap detection. **Phase 2 (artist similarity,
track recommendations, playlist reconstruction) is a separate follow-up plan** and is out of scope
here. MeTube remains untouched/out of scope. Navidrome is a future note only.

## Global Constraints

- **Node ≥ 24**, ESM only (`"type": "module"`). Native `fetch`, no `node-fetch`.
- **SQLite via built-in `node:sqlite` `DatabaseSync`** — no new npm dependency, no native build. It emits an `ExperimentalWarning` on import; that is expected and acceptable (project already runs with `--experimental-test-module-mocks`).
- **Tests:** Node built-in runner, run with `npm test -w server` (which is `node --experimental-test-module-mocks --test test/`). Never run bare `npm test` per project memory.
- **MusicBrainz calls** only ever go through `server/src/services/musicbrainz.js` (shared 1 req/sec rate limiter + 1h cache). Never call MusicBrainz or YouTube directly from new code.
- **Feature gating:** the library feature is enabled iff `MUSIC_DIR` is set — mirror the existing `ingestEnabled()` pattern with a new `libraryEnabled()`.
- **App name in User-Agent etc. stays "Spinmatch".**
- New client network calls go through `client/src/api/client.js` (`get`/`post`) — same-origin `/api/*` only.

## File Structure

**Backend (create):**
- `server/src/lib/db.js` — opens a `DatabaseSync` handle, applies the schema DDL, returns a singleton (overridable for tests). Only responsibility: connection + schema.
- `server/src/services/libraryRepo.js` — all SQL. Prepared-statement CRUD over `local_tracks`, `verified_tracks`, `collection_stats`. No filesystem or network.
- `server/src/services/libraryScanner.js` — walks `MUSIC_DIR`, reconciles disk → index using a cheap change key, reads tags only for new/changed files.
- `server/src/services/librarySync.js` — when to scan: startup trigger, adaptive interval, debounced `fs.watch`.
- `server/src/services/libraryGaps.js` — compares a MusicBrainz release tracklist to the index; returns owned/missing with YouTube links.
- `server/src/routes/library.js` — Express routes under `/api/library`.

**Backend (modify):**
- `server/src/config.js` — add `config.library` + `libraryEnabled()`.
- `server/src/routes/config.js` — expose `libraryEnabled()` to the client.
- `server/src/app.js` — register `libraryRouter`.
- `server/src/index.js` — start the sync loop at boot when enabled.

**Frontend (create):**
- `client/src/api/library.js` — typed wrappers over the new endpoints.
- `client/src/pages/LibraryPage.jsx` — dashboard (stats + artist/album/track browse + gap panel).
- `client/src/components/GapDetectionPanel.jsx` — album search → owned/missing display.

**Frontend (modify):**
- `client/src/pages/*` router registration + nav link (wherever routes/nav live — see Task 10).

**Deployment/docs (modify):**
- `.env.example`, `docker-compose.yml`, `unraid-template.xml`, `README.md`.

### Data model

`local_tracks` — one row per audio file currently or previously seen on disk:
`id INTEGER PK`, `path TEXT UNIQUE NOT NULL`, `artist TEXT`, `album TEXT`, `title TEXT`,
`duration_ms INTEGER`, `change_key TEXT NOT NULL`, `removed INTEGER NOT NULL DEFAULT 0`,
`updated_at INTEGER NOT NULL`.

> **Deviation from spec, intentional:** the spec named a `file_hash` column. We store a
> `change_key` of `"<size>:<mtimeMs>"` instead of a content hash. Content-hashing every file on
> every scan is exactly the CPU spike the spec's resilience section warns against for 10k+ track
> libraries; size+mtime is the standard cheap change signal. The column keeps the same role
> (detect "has this file changed since we indexed it").

`verified_tracks` — one row per local track confirmed against MusicBrainz + YouTube:
`local_track_id INTEGER PK REFERENCES local_tracks(id) ON DELETE CASCADE`,
`mb_recording_id TEXT NOT NULL`, `youtube_url TEXT`, `confidence REAL`, `verified_at INTEGER NOT NULL`.

`collection_stats` — a single cached summary row (`id INTEGER PK CHECK (id = 1)`):
`total_tracks INTEGER`, `total_albums INTEGER`, `total_artists INTEGER`, `last_scan_at INTEGER`.

---

### Task 1: SQLite connection + schema (`lib/db.js`)

**Files:**
- Create: `server/src/lib/db.js`
- Test: `server/test/db.test.js`

**Interfaces:**
- Produces:
  - `openDb(dbPath: string): DatabaseSync` — opens the file (or `':memory:'`), enables `foreign_keys`, applies schema, returns the handle.
  - `getDb(): DatabaseSync` — process-wide singleton opened at `config.library.dbPath`, created on first call.
  - `setDbForTest(db: DatabaseSync | null): void` — override/reset the singleton in tests.

- [ ] **Step 1: Write the failing test**

```js
// server/test/db.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');

test('openDb creates the three collection tables', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes('local_tracks'), 'local_tracks exists');
  assert.ok(names.includes('verified_tracks'), 'verified_tracks exists');
  assert.ok(names.includes('collection_stats'), 'collection_stats exists');
  db.close();
});

test('openDb enforces the single-row constraint on collection_stats', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (1, 0)').run();
  assert.throws(
    () => db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (2, 0)').run(),
    /CHECK/i
  );
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='openDb'`
Expected: FAIL — `Cannot find module '../src/lib/db.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/lib/db.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_tracks (
  id          INTEGER PRIMARY KEY,
  path        TEXT UNIQUE NOT NULL,
  artist      TEXT,
  album       TEXT,
  title       TEXT,
  duration_ms INTEGER,
  change_key  TEXT NOT NULL,
  removed     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_tracks_artist ON local_tracks(artist);
CREATE INDEX IF NOT EXISTS idx_local_tracks_album  ON local_tracks(album);

CREATE TABLE IF NOT EXISTS verified_tracks (
  local_track_id  INTEGER PRIMARY KEY REFERENCES local_tracks(id) ON DELETE CASCADE,
  mb_recording_id TEXT NOT NULL,
  youtube_url     TEXT,
  confidence      REAL,
  verified_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_stats (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  total_tracks  INTEGER,
  total_albums  INTEGER,
  total_artists INTEGER,
  last_scan_at  INTEGER
);
`;

export function openDb(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

let singleton = null;

export function getDb() {
  if (!singleton) singleton = openDb(config.library.dbPath);
  return singleton;
}

export function setDbForTest(db) {
  singleton = db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='openDb'`
Expected: PASS (both tests). An `ExperimentalWarning` about `node:sqlite` on stderr is expected.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/db.js server/test/db.test.js
git commit -m "feat(library): add SQLite schema and connection module"
```

---

### Task 2: Library repository (`services/libraryRepo.js`)

**Files:**
- Create: `server/src/services/libraryRepo.js`
- Test: `server/test/libraryRepo.test.js`

**Interfaces:**
- Consumes: a `DatabaseSync` handle (from `lib/db.js`).
- Produces (all take `db` as first arg so tests can pass an in-memory handle):
  - `upsertLocalTrack(db, { path, artist, album, title, durationMs, changeKey }): number` — inserts or updates by `path`, clears `removed`, returns the row id.
  - `getChangeKeys(db): Map<string, string>` — `path → change_key` for all non-removed rows (lets the scanner skip unchanged files).
  - `markRemoved(db, keepPaths: Set<string>): void` — sets `removed = 1` on any non-removed row whose `path` is not in `keepPaths`.
  - `recomputeStats(db): void` — recomputes `collection_stats` (id 1) from non-removed rows and stamps `last_scan_at`.
  - `getStats(db): { totalTracks, totalAlbums, totalArtists, lastScanAt }`.
  - `listArtists(db): Array<{ artist, trackCount }>` — non-removed, non-null artist, sorted.
  - `listAlbums(db, artist?): Array<{ artist, album, trackCount }>`.
  - `listTracks(db, { artist?, album? }): Array<{ id, artist, album, title, durationMs, path }>`.
  - `hasRecording(db, { artist, title }): boolean` — case-insensitive match of a non-removed track by artist+title (used by gap detection).

- [ ] **Step 1: Write the failing test**

```js
// server/test/libraryRepo.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

function seeded() {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One', durationMs: 1000, changeKey: '10:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Album/02.mp3', artist: 'A', album: 'Album', title: 'Two', durationMs: 2000, changeKey: '20:1' });
  repo.upsertLocalTrack(db, { path: '/m/B/Other/01.mp3', artist: 'B', album: 'Other', title: 'Solo', durationMs: 3000, changeKey: '30:1' });
  repo.recomputeStats(db);
  return db;
}

test('stats reflect distinct artists and albums', () => {
  const db = seeded();
  assert.deepEqual(repo.getStats(db), {
    totalTracks: 3, totalAlbums: 2, totalArtists: 2, lastScanAt: repo.getStats(db).lastScanAt,
  });
  assert.ok(repo.getStats(db).lastScanAt > 0);
  db.close();
});

test('upsert on the same path updates rather than duplicates', () => {
  const db = seeded();
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One (remaster)', durationMs: 1100, changeKey: '11:2' });
  repo.recomputeStats(db);
  assert.equal(repo.getStats(db).totalTracks, 3);
  const [t] = repo.listTracks(db, { artist: 'A', album: 'Album' }).filter((r) => r.path.endsWith('01.mp3'));
  assert.equal(t.title, 'One (remaster)');
  db.close();
});

test('markRemoved drops rows absent from the keep set and stats update', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3', '/m/A/Album/02.mp3']));
  repo.recomputeStats(db);
  const stats = repo.getStats(db);
  assert.equal(stats.totalTracks, 2);
  assert.equal(stats.totalArtists, 1);
  db.close();
});

test('hasRecording matches artist+title case-insensitively, ignoring removed rows', () => {
  const db = seeded();
  assert.equal(repo.hasRecording(db, { artist: 'a', title: 'one' }), true);
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Nope' }), false);
  repo.markRemoved(db, new Set(['/m/A/Album/02.mp3', '/m/B/Other/01.mp3']));
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Two' }), false);
  db.close();
});

test('getChangeKeys returns path->key for live rows only', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3']));
  const keys = repo.getChangeKeys(db);
  assert.equal(keys.get('/m/A/Album/01.mp3'), '10:1');
  assert.equal(keys.has('/m/B/Other/01.mp3'), false);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='stats reflect'`
Expected: FAIL — `Cannot find module '../src/services/libraryRepo.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/services/libraryRepo.js
export function upsertLocalTrack(db, { path, artist, album, title, durationMs, changeKey }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO local_tracks (path, artist, album, title, duration_ms, change_key, removed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(path) DO UPDATE SET
      artist = excluded.artist,
      album = excluded.album,
      title = excluded.title,
      duration_ms = excluded.duration_ms,
      change_key = excluded.change_key,
      removed = 0,
      updated_at = excluded.updated_at
  `).run(path, artist, album, title, durationMs, changeKey, now);
  const { id } = db.prepare('SELECT id FROM local_tracks WHERE path = ?').get(path);
  return id;
}

export function getChangeKeys(db) {
  const rows = db.prepare('SELECT path, change_key FROM local_tracks WHERE removed = 0').all();
  return new Map(rows.map((r) => [r.path, r.change_key]));
}

export function markRemoved(db, keepPaths) {
  const rows = db.prepare('SELECT id, path FROM local_tracks WHERE removed = 0').all();
  const stmt = db.prepare('UPDATE local_tracks SET removed = 1, updated_at = ? WHERE id = ?');
  const now = Date.now();
  for (const row of rows) {
    if (!keepPaths.has(row.path)) stmt.run(now, row.id);
  }
}

export function recomputeStats(db) {
  const { c: totalTracks } = db.prepare('SELECT COUNT(*) c FROM local_tracks WHERE removed = 0').get();
  const { c: totalAlbums } = db.prepare(
    "SELECT COUNT(DISTINCT artist || '\\u0000' || album) c FROM local_tracks WHERE removed = 0 AND album IS NOT NULL"
  ).get();
  const { c: totalArtists } = db.prepare(
    'SELECT COUNT(DISTINCT artist) c FROM local_tracks WHERE removed = 0 AND artist IS NOT NULL'
  ).get();
  db.prepare(`
    INSERT INTO collection_stats (id, total_tracks, total_albums, total_artists, last_scan_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total_tracks = excluded.total_tracks,
      total_albums = excluded.total_albums,
      total_artists = excluded.total_artists,
      last_scan_at = excluded.last_scan_at
  `).run(totalTracks, totalAlbums, totalArtists, Date.now());
}

export function getStats(db) {
  const row = db.prepare(
    'SELECT total_tracks, total_albums, total_artists, last_scan_at FROM collection_stats WHERE id = 1'
  ).get();
  return {
    totalTracks: row?.total_tracks ?? 0,
    totalAlbums: row?.total_albums ?? 0,
    totalArtists: row?.total_artists ?? 0,
    lastScanAt: row?.last_scan_at ?? 0,
  };
}

export function listArtists(db) {
  return db.prepare(`
    SELECT artist, COUNT(*) AS trackCount
    FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL
    GROUP BY artist ORDER BY artist COLLATE NOCASE
  `).all().map((r) => ({ artist: r.artist, trackCount: r.trackCount }));
}

export function listAlbums(db, artist) {
  const where = artist ? 'AND artist = ?' : '';
  const stmt = db.prepare(`
    SELECT artist, album, COUNT(*) AS trackCount
    FROM local_tracks
    WHERE removed = 0 AND album IS NOT NULL ${where}
    GROUP BY artist, album ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE
  `);
  const rows = artist ? stmt.all(artist) : stmt.all();
  return rows.map((r) => ({ artist: r.artist, album: r.album, trackCount: r.trackCount }));
}

export function listTracks(db, { artist, album } = {}) {
  const clauses = ['removed = 0'];
  const params = [];
  if (artist) { clauses.push('artist = ?'); params.push(artist); }
  if (album) { clauses.push('album = ?'); params.push(album); }
  return db.prepare(`
    SELECT id, artist, album, title, duration_ms AS durationMs, path
    FROM local_tracks WHERE ${clauses.join(' AND ')}
    ORDER BY album COLLATE NOCASE, title COLLATE NOCASE
  `).all(...params);
}

export function hasRecording(db, { artist, title }) {
  const row = db.prepare(`
    SELECT 1 FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE
    LIMIT 1
  `).get(artist, title);
  return Boolean(row);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='stats reflect|upsert on the same|markRemoved drops|hasRecording matches|getChangeKeys returns'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/libraryRepo.js server/test/libraryRepo.test.js
git commit -m "feat(library): add repository layer over the SQLite index"
```

---

### Task 3: Config + gating (`config.js`, `routes/config.js`)

**Files:**
- Modify: `server/src/config.js`
- Modify: `server/src/routes/config.js`
- Test: `server/test/routes/config.test.js` (add cases)

**Interfaces:**
- Produces:
  - `config.library.dbPath: string` — from `LIBRARY_DB`, default `/data/library.db`.
  - `libraryEnabled(): boolean` — `Boolean(config.ingest.musicDir)`.
  - `GET /api/config` now also returns `libraryEnabled: boolean`.

- [ ] **Step 1: Write the failing test** — add to `server/test/routes/config.test.js`:

```js
test('GET /api/config reports libraryEnabled: false when MUSIC_DIR is unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  const body = await res.json();
  assert.equal(body.libraryEnabled, false);
});

test('libraryEnabled() is true when MUSIC_DIR is set', async () => {
  process.env.MUSIC_DIR = '/tmp/music';
  const { libraryEnabled } = await import('../../src/config.js?variant=library-enabled');
  assert.equal(libraryEnabled(), true);
  delete process.env.MUSIC_DIR;
});

test('config.library.dbPath defaults to /data/library.db', async () => {
  const { config } = await import('../../src/config.js?variant=db-default');
  assert.equal(config.library.dbPath, '/data/library.db');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='libraryEnabled|library.dbPath'`
Expected: FAIL — `libraryEnabled` undefined / `body.libraryEnabled` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/config.js`, add to the exported `config` object (after the `ingest` block):

```js
  library: {
    dbPath: process.env.LIBRARY_DB || '/data/library.db',
  },
```

And add, next to `ingestEnabled`:

```js
export function libraryEnabled() {
  return Boolean(config.ingest.musicDir);
}
```

In `server/src/routes/config.js`, replace the handler body:

```js
import { Router } from 'express';
import { config, ingestEnabled, libraryEnabled } from '../config.js';

export const configRouter = Router();

configRouter.get('/', (req, res) => {
  res.json({
    metubeUrl: config.metubeUrl,
    ingestEnabled: ingestEnabled(),
    libraryEnabled: libraryEnabled(),
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='libraryEnabled|library.dbPath|config'`
Expected: PASS (new + existing config tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/config.js server/src/routes/config.js server/test/routes/config.test.js
git commit -m "feat(library): add library config and enable-gating"
```

---

### Task 4: Directory scanner (`services/libraryScanner.js`)

**Files:**
- Create: `server/src/services/libraryScanner.js`
- Test: `server/test/libraryScanner.test.js`

**Interfaces:**
- Consumes: `libraryRepo.*`, `tags.readTags`, `config.ingest.musicDir`, a `DatabaseSync` handle from `getDb()`.
- Produces:
  - `scanLibrary(): Promise<{ scanned, added, updated, removed }>` — walks `config.ingest.musicDir` recursively, upserts new/changed audio files (reading tags only for those), marks vanished files removed, recomputes stats. Uses `getDb()`.
  - `changeKeyFor(stat): string` — `"<size>:<mtimeMs>"` (exported for the sync layer/tests).

Notes:
- Reuse the audio-extension notion from ingest: `.mp3 .flac .m4a .aac .ogg`.
- Fall back to the filename/parent-dir for `title`/`album` when a tag is missing, and skip files whose tags can't be read (log + continue) so one bad file can't abort the scan (spec resilience requirement).

- [ ] **Step 1: Write the failing test**

```js
// server/test/libraryScanner.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { openDb, setDbForTest } = await import('../src/lib/db.js');
const configModule = await import('../src/config.js');

// scanLibrary reads real tags via node-taglib-sharp; mock it so the test can use
// cheap placeholder files. Register the mock BEFORE importing the scanner, then
// import the scanner with a cache-busting suffix (same technique as ingest.test.js).
let counter = 0;
async function freshScanner(readTagsImpl) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.module('../src/services/tags.js', {
    namedExports: { readTags: readTagsImpl },
  });
  return import(`../src/services/libraryScanner.js?fresh=${counter}`);
}

async function withMusicDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-music-'));
  const original = configModule.config.ingest.musicDir;
  configModule.config.ingest.musicDir = dir;
  const db = openDb(':memory:');
  setDbForTest(db);
  try {
    await fn(dir, db);
  } finally {
    configModule.config.ingest.musicDir = original;
    setDbForTest(null);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('scanLibrary indexes audio files with their tags and ignores non-audio', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.mkdir(path.join(dir, 'Artist', 'Album'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Artist', 'Album', '01.mp3'), 'x');
    await fs.writeFile(path.join(dir, 'Artist', 'Album', 'cover.jpg'), 'x');
    const { scanLibrary } = await freshScanner(async () => ({
      artist: 'Artist', album: 'Album', title: 'Song One', /* other fields */ genre: null,
    }));
    const summary = await scanLibrary();
    assert.equal(summary.scanned, 1);
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    assert.equal(repo.hasRecording(db, { artist: 'Artist', title: 'Song One' }), true);
  });
});

test('a second scan with no changes re-reads no tags (all skipped)', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'x');
    let reads = 0;
    const read = async () => { reads += 1; return { artist: 'A', album: 'B', title: 'T' }; };
    const { scanLibrary } = await freshScanner(read);
    await scanLibrary();
    assert.equal(reads, 1);
    await scanLibrary(); // unchanged file -> skipped, no re-read
    assert.equal(reads, 1);
  });
});

test('a deleted file is marked removed on the next scan', async () => {
  await withMusicDir(async (dir, db) => {
    const p = path.join(dir, 'track.mp3');
    await fs.writeFile(p, 'x');
    const { scanLibrary } = await freshScanner(async () => ({ artist: 'A', album: 'B', title: 'T' }));
    await scanLibrary();
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
    await fs.rm(p);
    await scanLibrary();
    assert.equal(repo.getStats(db).totalTracks, 0);
  });
});

test('a file whose tags throw is skipped without aborting the scan', async () => {
  await withMusicDir(async (dir, db) => {
    await fs.writeFile(path.join(dir, 'good.mp3'), 'x');
    await fs.writeFile(path.join(dir, 'bad.mp3'), 'x');
    const read = async (fp) => {
      if (fp.endsWith('bad.mp3')) throw new Error('corrupt');
      return { artist: 'A', album: 'B', title: 'Good' };
    };
    const { scanLibrary } = await freshScanner(read);
    const summary = await scanLibrary();
    assert.equal(summary.added, 1);
    const repo = await import('../src/services/libraryRepo.js');
    assert.equal(repo.getStats(db).totalTracks, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='scanLibrary indexes'`
Expected: FAIL — `Cannot find module '../src/services/libraryScanner.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/services/libraryScanner.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { readTags } from './tags.js';
import { getDb } from '../lib/db.js';
import {
  upsertLocalTrack, getChangeKeys, markRemoved, recomputeStats,
} from './libraryRepo.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function changeKeyFor(stat) {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir -> skip subtree
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      yield full;
    }
  }
}

export async function scanLibrary() {
  const root = config.ingest.musicDir;
  const db = getDb();
  const known = getChangeKeys(db);
  const seen = new Set();
  let scanned = 0;
  let added = 0;
  let updated = 0;

  for await (const filePath of walk(root)) {
    scanned += 1;
    seen.add(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const changeKey = changeKeyFor(stat);
    if (known.get(filePath) === changeKey) continue; // unchanged -> no tag read

    let meta;
    try {
      meta = await readTags(filePath);
    } catch (err) {
      console.warn(`libraryScanner: skipping unreadable file ${filePath}: ${err.message}`);
      seen.delete(filePath); // don't let a skipped file mark a prior good row removed... it stays as-is
      continue;
    }

    const isNew = !known.has(filePath);
    upsertLocalTrack(db, {
      path: filePath,
      artist: meta.artist ?? null,
      album: meta.album ?? path.basename(path.dirname(filePath)),
      title: meta.title ?? path.basename(filePath, path.extname(filePath)),
      durationMs: null,
      changeKey,
    });
    if (isNew) added += 1; else updated += 1;
  }

  markRemoved(db, seen);
  recomputeStats(db);
  const removed = known.size - [...known.keys()].filter((p) => seen.has(p)).length;
  return { scanned, added, updated, removed };
}
```

> Note on the skip-vs-remove edge: when `readTags` throws for a file that is *already indexed*,
> we `seen.delete(filePath)` above so the reconciliation doesn't touch it — but that would also
> let a brand-new unreadable file be absent from `seen` (correct: it was never indexed, nothing to
> remove). A previously-good row for a now-unreadable file will be marked removed, which is the
> safe choice (we can no longer verify it). This matches the test `a file whose tags throw is
> skipped without aborting the scan`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='scanLibrary indexes|second scan|deleted file|tags throw'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/libraryScanner.js server/test/libraryScanner.test.js
git commit -m "feat(library): add MUSIC_DIR scanner with incremental reconciliation"
```

---

### Task 5: Sync orchestration (`services/librarySync.js`)

**Files:**
- Create: `server/src/services/librarySync.js`
- Test: `server/test/librarySync.test.js`

**Interfaces:**
- Consumes: `scanLibrary` (injectable), `getStats`, `getDb`, `config.ingest.musicDir`.
- Produces:
  - `intervalForSize(trackCount: number): number` — ms between background scans: `<1000 → 30*60_000`, `1000–10000 → 2*60*60_000`, `>10000 → 4*60*60_000`.
  - `startLibrarySync({ scan = scanLibrary, watch = true } = {}): { stop(): void }` — runs an initial scan (awaited internally, errors logged not thrown), schedules the next scan via `setTimeout` recomputed from current stats after each run, and (when `watch`) sets a debounced recursive `fs.watch` on `MUSIC_DIR` that triggers a scan ~2s after the last event. Returns a handle whose `stop()` clears the timer and closes the watcher.

- [ ] **Step 1: Write the failing test**

```js
// server/test/librarySync.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { intervalForSize, startLibrarySync } = await import('../src/services/librarySync.js');

test('intervalForSize scales with collection size', () => {
  assert.equal(intervalForSize(0), 30 * 60_000);
  assert.equal(intervalForSize(999), 30 * 60_000);
  assert.equal(intervalForSize(5000), 2 * 60 * 60_000);
  assert.equal(intervalForSize(50000), 4 * 60 * 60_000);
});

test('startLibrarySync runs an initial scan and stop() is clean', async () => {
  let calls = 0;
  const scan = async () => { calls += 1; return { scanned: 0, added: 0, updated: 0, removed: 0 }; };
  const handle = startLibrarySync({ scan, watch: false });
  // initial scan is kicked off synchronously; let its microtasks settle
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  handle.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='intervalForSize|initial scan'`
Expected: FAIL — `Cannot find module '../src/services/librarySync.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/services/librarySync.js
import fs from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { getStats } from './libraryRepo.js';
import { scanLibrary } from './libraryScanner.js';

const HALF_HOUR = 30 * 60_000;
const TWO_HOURS = 2 * 60 * 60_000;
const FOUR_HOURS = 4 * 60 * 60_000;
const WATCH_DEBOUNCE_MS = 2000;

export function intervalForSize(trackCount) {
  if (trackCount < 1000) return HALF_HOUR;
  if (trackCount <= 10000) return TWO_HOURS;
  return FOUR_HOURS;
}

export function startLibrarySync({ scan = scanLibrary, watch = true } = {}) {
  let timer = null;
  let watcher = null;
  let debounce = null;
  let stopped = false;

  const runScan = async () => {
    try {
      await scan();
    } catch (err) {
      console.warn(`librarySync: scan failed: ${err.message}`);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    let count = 0;
    try { count = getStats(getDb()).totalTracks; } catch { count = 0; }
    timer = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, intervalForSize(count));
    timer.unref?.();
  };

  // Kick off the initial scan, then schedule the recurring one.
  runScan().then(scheduleNext);

  if (watch && config.ingest.musicDir) {
    try {
      watcher = fs.watch(config.ingest.musicDir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(runScan, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
    } catch (err) {
      console.warn(`librarySync: could not watch MUSIC_DIR: ${err.message}`);
    }
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (debounce) clearTimeout(debounce);
      if (watcher) watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='intervalForSize|initial scan'`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/librarySync.js server/test/librarySync.test.js
git commit -m "feat(library): add adaptive sync scheduler and fs watcher"
```

---

### Task 6: Read routes + app wiring (`routes/library.js`, `app.js`)

**Files:**
- Create: `server/src/routes/library.js`
- Modify: `server/src/app.js`
- Test: `server/test/routes/library.test.js`

**Interfaces:**
- Produces these endpoints, all guarded by `libraryEnabled()` (404 when disabled), reading via `getDb()`:
  - `GET /api/library/stats` → `{ totalTracks, totalAlbums, totalArtists, lastScanAt }`
  - `GET /api/library/artists` → `{ artists: [{ artist, trackCount }] }`
  - `GET /api/library/albums?artist=` → `{ albums: [{ artist, album, trackCount }] }`
  - `GET /api/library/tracks?artist=&album=` → `{ tracks: [{ id, artist, album, title, durationMs, path }] }`
  - `POST /api/library/scan` → runs `scanLibrary()`, returns its summary. Same-origin-guarded (reuse the ingest `sameOriginOnly` idea — see note).

Note: `sameOriginOnly` currently lives inside `routes/ingest.js`. Copying the small guard into
`library.js` is fine for this plan (it is ~15 lines and the two routers are independent); a later
refactor could hoist it to `middleware/`. Do not import it from `ingest.js` (that router is behind
`ingestEnabled()` and unrelated).

- [ ] **Step 1: Write the failing test**

```js
// server/test/routes/library.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = '/tmp/spinmatch-lib-test';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;

test.before(async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Al/01.mp3', artist: 'A', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Al/02.mp3', artist: 'A', album: 'Al', title: 'Two', durationMs: 2000, changeKey: '2:1' });
  repo.recomputeStats(db);
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  setDbForTest(null);
  delete process.env.MUSIC_DIR;
  server.close();
});

test('GET /api/library/stats returns the collection summary', async () => {
  const res = await fetch(`${baseUrl}/api/library/stats`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalTracks, 2);
  assert.equal(body.totalArtists, 1);
  assert.equal(body.totalAlbums, 1);
});

test('GET /api/library/tracks filters by album', async () => {
  const res = await fetch(`${baseUrl}/api/library/tracks?artist=A&album=Al`);
  const body = await res.json();
  assert.equal(body.tracks.length, 2);
  assert.equal(body.tracks[0].title, 'One');
});

test('GET /api/library/artists lists artists with counts', async () => {
  const res = await fetch(`${baseUrl}/api/library/artists`);
  const body = await res.json();
  assert.deepEqual(body.artists, [{ artist: 'A', trackCount: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='library/stats'`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/routes/library.js
import { Router } from 'express';
import { libraryEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import { getStats, listArtists, listAlbums, listTracks } from '../services/libraryRepo.js';
import { scanLibrary } from '../services/libraryScanner.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';

export const libraryRouter = Router();

function sameOriginOnly(req, res, next) {
  const site = req.get('Sec-Fetch-Site');
  if (site) {
    if (site !== 'same-origin' && site !== 'none') {
      return next(new BadRequestError('Cross-site requests are not allowed for this endpoint'));
    }
    return next();
  }
  const origin = req.get('Origin');
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return next(new BadRequestError('Invalid Origin header')); }
    if (originHost !== req.get('Host')) {
      return next(new BadRequestError('Cross-origin requests are not allowed for this endpoint'));
    }
  }
  next();
}

libraryRouter.use((req, res, next) => {
  if (!libraryEnabled()) return next(new NotFoundError('The library feature is not configured'));
  next();
});

libraryRouter.get('/stats', (req, res) => {
  res.json(getStats(getDb()));
});

libraryRouter.get('/artists', (req, res) => {
  res.json({ artists: listArtists(getDb()) });
});

libraryRouter.get('/albums', (req, res) => {
  const artist = req.query.artist ? String(req.query.artist) : undefined;
  res.json({ albums: listAlbums(getDb(), artist) });
});

libraryRouter.get('/tracks', (req, res) => {
  const artist = req.query.artist ? String(req.query.artist) : undefined;
  const album = req.query.album ? String(req.query.album) : undefined;
  res.json({ tracks: listTracks(getDb(), { artist, album }) });
});

libraryRouter.post('/scan', sameOriginOnly, async (req, res, next) => {
  try {
    const summary = await scanLibrary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});
```

In `server/src/app.js`, add the import and registration alongside the others:

```js
import { libraryRouter } from './routes/library.js';
// ...
  app.use('/api/library', libraryRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='library/stats|library/tracks|library/artists'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/library.js server/src/app.js server/test/routes/library.test.js
git commit -m "feat(library): expose read routes and manual scan endpoint"
```

---

### Task 7: Boot the sync loop (`index.js`)

**Files:**
- Modify: `server/src/index.js`

**Interfaces:**
- Consumes: `libraryEnabled`, `startLibrarySync`.
- Produces: on server start, when `libraryEnabled()`, the sync loop runs (initial scan + scheduler + watcher). No new exports.

This wiring is verified manually (Task 11 verification), not by an automated test — starting a
real listener + watcher in unit tests is out of proportion to a four-line change.

- [ ] **Step 1: Edit `server/src/index.js`**

```js
import { config, libraryEnabled } from './config.js';
import { createApp } from './app.js';
import { startLibrarySync } from './services/librarySync.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Spinmatch server listening on port ${config.port}`);
  if (libraryEnabled()) {
    startLibrarySync();
    console.log('Library sync started');
  }
});
```

- [ ] **Step 2: Verify the full backend suite still passes**

Run: `npm test -w server`
Expected: PASS — all suites, including the new library ones. `ExperimentalWarning: SQLite` on stderr is expected.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.js
git commit -m "feat(library): start the sync loop at server boot when enabled"
```

---

### Task 8: Album gap detection (`services/libraryGaps.js` + route)

**Files:**
- Create: `server/src/services/libraryGaps.js`
- Modify: `server/src/routes/library.js` (add `GET /missing`)
- Test: `server/test/libraryGaps.test.js`

**Interfaces:**
- Consumes: `resolvePrimaryReleaseForGroup`, `getReleaseWithTracks` (musicbrainz), `verifyTrack`, `hasRecording`, `getDb`.
- Produces:
  - `detectAlbumGaps(releaseGroupMbid: string): Promise<{ album: { mbid, title, artist }, owned: Track[], missing: MissingTrack[] }>` where `Track = { position, title }` and `MissingTrack = { position, title, lengthMs, video, status, deltaSeconds }`. For each release track, `hasRecording(db, { artist: release.artist, title: track.title })` decides owned vs. missing; each missing track is passed through `verifyTrack` for a YouTube link (skipped with `status:'no_length'` when `track.lengthMs == null`).
  - `GET /api/library/missing?releaseGroup=<mbid>` → the same object. `400` when `releaseGroup` is absent, `404` when no release resolves.

- [ ] **Step 1: Write the failing test**

```js
// server/test/libraryGaps.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

let counter = 0;
async function freshGaps(mbMocks, verifyMock) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.module('../src/services/musicbrainz.js', { namedExports: mbMocks });
  mock.module('../src/services/verifyTrack.js', { namedExports: { verifyTrack: verifyMock } });
  return import(`../src/services/libraryGaps.js?fresh=${counter}`);
}

test('detectAlbumGaps splits owned vs missing and looks up links for gaps', async () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/Band/Rec/01.mp3', artist: 'Band', album: 'Rec', title: 'Kept', durationMs: 180000, changeKey: '1:1' });
  repo.recomputeStats(db);
  setDbForTest(db);

  const mb = {
    resolvePrimaryReleaseForGroup: async () => 'release-1',
    getReleaseWithTracks: async () => ({
      release: { title: 'Rec', artist: 'Band' },
      tracks: [
        { position: 1, title: 'Kept', lengthMs: 180000 },
        { position: 2, title: 'Gone', lengthMs: 200000 },
      ],
    }),
  };
  let verifyCalls = 0;
  const verify = async ({ title }) => { verifyCalls += 1; return { status: 'verified', video: { url: `yt:${title}` }, deltaSeconds: 1 }; };

  const { detectAlbumGaps } = await freshGaps(mb, verify);
  const result = await detectAlbumGaps('rg-1');

  assert.equal(result.owned.length, 1);
  assert.equal(result.owned[0].title, 'Kept');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].title, 'Gone');
  assert.equal(result.missing[0].video.url, 'yt:Gone');
  assert.equal(verifyCalls, 1); // only the missing track is looked up
  setDbForTest(null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- --test-name-pattern='detectAlbumGaps splits'`
Expected: FAIL — `Cannot find module '../src/services/libraryGaps.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/services/libraryGaps.js
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { verifyTrack } from './verifyTrack.js';
import { getDb } from '../lib/db.js';
import { hasRecording } from './libraryRepo.js';
import { NotFoundError } from '../lib/httpErrors.js';

export async function detectAlbumGaps(releaseGroupMbid) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) throw new NotFoundError('No release found for this release group');

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  const db = getDb();
  const owned = [];
  const missing = [];

  for (const track of tracks) {
    if (hasRecording(db, { artist: release.artist, title: track.title })) {
      owned.push({ position: track.position, title: track.title });
      continue;
    }
    if (track.lengthMs == null) {
      missing.push({ position: track.position, title: track.title, lengthMs: null, status: 'no_length', video: null, deltaSeconds: null });
      continue;
    }
    const verified = await verifyTrack({ artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs });
    missing.push({ position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
  }

  return {
    album: { mbid: releaseGroupMbid, title: release.title, artist: release.artist },
    owned,
    missing,
  };
}
```

Add to `server/src/routes/library.js` (import `detectAlbumGaps`, then a route). Note that
`RateLimitedError` from `verifyTrack`/MusicBrainz propagates to the shared `errorHandler`, matching
the rest of the app:

```js
import { detectAlbumGaps } from '../services/libraryGaps.js';
// ...
libraryRouter.get('/missing', async (req, res, next) => {
  try {
    const releaseGroup = req.query.releaseGroup ? String(req.query.releaseGroup) : '';
    if (!releaseGroup) throw new BadRequestError('releaseGroup is required');
    res.json(await detectAlbumGaps(releaseGroup));
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- --test-name-pattern='detectAlbumGaps splits'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/libraryGaps.js server/src/routes/library.js server/test/libraryGaps.test.js
git commit -m "feat(library): add album gap detection with YouTube links for gaps"
```

---

### Task 9: Client API wrappers (`api/library.js`)

**Files:**
- Create: `client/src/api/library.js`

**Interfaces:**
- Consumes: `get`, `post` from `client/src/api/client.js`.
- Produces: `getLibraryStats()`, `getLibraryArtists()`, `getLibraryAlbums(artist?)`, `getLibraryTracks({ artist, album })`, `scanLibrary()`, `getAlbumGaps(releaseGroupMbid)`.

This is a thin, well-understood mapping with no branching logic; it is verified by the UI tasks
that consume it (Task 10) and the manual end-to-end check (Task 11), consistent with how the repo
treats `client/src/api/client.js` (no client unit tests exist).

- [ ] **Step 1: Create the file**

```js
// client/src/api/library.js
import { get, post } from './client.js';

export function getLibraryStats() {
  return get('/library/stats');
}

export function getLibraryArtists() {
  return get('/library/artists');
}

export function getLibraryAlbums(artist) {
  const q = artist ? `?artist=${encodeURIComponent(artist)}` : '';
  return get(`/library/albums${q}`);
}

export function getLibraryTracks({ artist, album } = {}) {
  const params = new URLSearchParams();
  if (artist) params.set('artist', artist);
  if (album) params.set('album', album);
  const q = params.toString();
  return get(`/library/tracks${q ? `?${q}` : ''}`);
}

export function scanLibrary() {
  return post('/library/scan', {});
}

export function getAlbumGaps(releaseGroupMbid) {
  return get(`/library/missing?releaseGroup=${encodeURIComponent(releaseGroupMbid)}`);
}
```

- [ ] **Step 2: Lint/build check**

Run: `npm run build`
Expected: Vite build succeeds (no import errors).

- [ ] **Step 3: Commit**

```bash
git add client/src/api/library.js
git commit -m "feat(library): add client API wrappers for library endpoints"
```

---

### Task 10: Library dashboard + gap panel UI

**Files:**
- Create: `client/src/pages/LibraryPage.jsx`
- Create: `client/src/components/GapDetectionPanel.jsx`
- Modify: the client router + nav (see Step 1 — locate them first).

**Interfaces:**
- Consumes: `client/src/api/library.js`, existing `ConfigContext` (for `libraryEnabled`), existing search API for album lookup (reuse the same call `SearchPage`/`AlbumPage` use to get a release-group mbid — inspect those files).

Because the frontend has no automated tests in this repo, this task is validated by the manual
end-to-end check in Task 11. Keep components small and presentational.

- [ ] **Step 1: Locate routing + nav + config context**

Run (read-only inspection, no edits yet):
```bash
grep -rn "createBrowserRouter\|<Routes>\|<Route\|BrowserRouter" client/src
grep -rn "IngestPage\|ingestEnabled\|libraryEnabled" client/src
grep -rn "ConfigContext\|useConfig" client/src/*.jsx client/src/**/*.jsx
```
Expected: reveals where pages are registered (e.g. `client/src/App.jsx` or `main.jsx`) and how
`IngestPage` is conditionally shown based on `ingestEnabled`. Mirror that pattern exactly for
`LibraryPage` gated on `libraryEnabled`.

- [ ] **Step 2: Create `client/src/components/GapDetectionPanel.jsx`**

```jsx
import { useState } from 'react';
import { getAlbumGaps } from '../api/library.js';

// releaseGroupMbid comes from an album the user picked in search results.
export default function GapDetectionPanel({ releaseGroupMbid, albumTitle }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  async function run() {
    setState({ status: 'loading', data: null, error: null });
    try {
      const data = await getAlbumGaps(releaseGroupMbid);
      setState({ status: 'done', data, error: null });
    } catch (err) {
      setState({ status: 'error', data: null, error: err.message });
    }
  }

  return (
    <div className="gap-panel">
      <button onClick={run} disabled={state.status === 'loading'}>
        {state.status === 'loading' ? 'Checking…' : `Find missing tracks in ${albumTitle}`}
      </button>

      {state.status === 'error' && <p className="error">{state.error}</p>}

      {state.status === 'done' && state.data && (
        <div>
          <p>{state.data.owned.length} owned · {state.data.missing.length} missing</p>
          <ul className="missing-list">
            {state.data.missing.map((t) => (
              <li key={`${t.position}-${t.title}`}>
                <span>{t.position}. {t.title}</span>{' '}
                {t.video?.url
                  ? <a href={t.video.url} target="_blank" rel="noreferrer">YouTube</a>
                  : <em>no match found</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `client/src/pages/LibraryPage.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { getLibraryStats, getLibraryArtists, scanLibrary } from '../api/library.js';

export default function LibraryPage() {
  const [stats, setStats] = useState(null);
  const [artists, setArtists] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const [s, a] = await Promise.all([getLibraryStats(), getLibraryArtists()]);
      setStats(s);
      setArtists(a.artists);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function rescan() {
    setScanning(true);
    setError(null);
    try {
      await scanLibrary();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="library-page">
      <h1>Your Library</h1>
      {error && <p className="error">{error}</p>}
      {stats && (
        <div className="stats-row">
          <span>{stats.totalTracks} tracks</span>
          <span>{stats.totalAlbums} albums</span>
          <span>{stats.totalArtists} artists</span>
          {stats.lastScanAt > 0 && <span>last scan {new Date(stats.lastScanAt).toLocaleString()}</span>}
        </div>
      )}
      <button onClick={rescan} disabled={scanning}>{scanning ? 'Scanning…' : 'Rescan library'}</button>
      <ul className="artist-list">
        {artists.map((a) => <li key={a.artist}>{a.artist} ({a.trackCount})</li>)}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Register the route + nav (mirroring the IngestPage pattern found in Step 1)**

Add `LibraryPage` to the router and a nav link shown only when `libraryEnabled` is true in
`ConfigContext`. Integrate `GapDetectionPanel` where an album/release-group is displayed (e.g.
`client/src/pages/AlbumPage.jsx`), passing that page's release-group mbid and title. Follow the
exact conditional-rendering pattern that `IngestPage`/`SendToMeTubeButton` already use.

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/LibraryPage.jsx client/src/components/GapDetectionPanel.jsx client/src
git commit -m "feat(library): add library dashboard and album gap-detection UI"
```

---

### Task 11: Deployment config, docs, and end-to-end verification

**Files:**
- Modify: `.env.example`, `docker-compose.yml`, `unraid-template.xml`, `README.md`

**Interfaces:** none (configuration + docs).

- [ ] **Step 1: Add `LIBRARY_DB` and a DB volume**

In `.env.example`, after the ingest block, add:

```bash
# Optional: path to the SQLite library index. Enabled whenever MUSIC_DIR is set.
# In Docker this should live on a mounted volume so it survives container rebuilds.
LIBRARY_DB=/data/db/library.db
# Docker Compose only: host-side folder bind-mounted to hold library.db.
DB_HOST_DIR=./db
```

In `docker-compose.yml`, add the DB bind mount under `volumes:`:

```yaml
      - ${DB_HOST_DIR:-./db}:/data/db
```

In `unraid-template.xml`, add a path mapping for `/data/db` (mirror the existing `/data/music`
mapping's structure) and a variable for `LIBRARY_DB` defaulting to `/data/db/library.db`.

- [ ] **Step 2: Document the feature in `README.md`**

Add a "Library / Collection Manager" section: what it does (indexes `MUSIC_DIR`, dashboard, album
gap detection), that it is enabled automatically when `MUSIC_DIR` is set, the `LIBRARY_DB` /
`DB_HOST_DIR` settings, and that the DB must be on a mounted volume in Docker. Note the built-in
`node:sqlite` `ExperimentalWarning` is expected.

- [ ] **Step 3: Full backend test suite**

Run: `npm test -w server`
Expected: PASS — every suite.

- [ ] **Step 4: Manual end-to-end check**

```bash
# From repo root, with a throwaway library:
mkdir -p /tmp/sm-music/"Some Artist"/"Some Album"
# copy any two real audio files in as 01.mp3 / 02.mp3 (tags optional)
LIBRARY_DB=/tmp/sm-lib.db MUSIC_DIR=/tmp/sm-music MB_CONTACT_EMAIL=you@example.com \
  npm start -w server
```
Then in another shell:
```bash
curl -s localhost:3000/api/config          # -> libraryEnabled: true
curl -s localhost:3000/api/library/stats   # -> totalTracks reflects the files
curl -s "localhost:3000/api/library/missing?releaseGroup=<a-real-release-group-mbid>"
```
Expected: stats show the indexed tracks; `/missing` returns owned/missing split with YouTube links
for the gaps. In the browser at `localhost:3000`, the "Your Library" page shows stats + artists,
"Rescan library" works, and the gap panel on an album lists missing tracks.

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml unraid-template.xml README.md
git commit -m "docs(library): document collection manager and add DB volume config"
```

---

## Self-Review

**Spec coverage (Foundation + Phase 1 of the design):**
- Persistent SQLite index mounted outside the container → Tasks 1–2, 11 (volume). ✓
- Startup scan + adaptive background refresh + fs change detection → Tasks 4, 5, 7. ✓
- Library dashboard (stats, browse by artist/album, verification status) → Tasks 6, 10. (Verification-status *display* is minimal in MVP — the `verified_tracks` table and schema exist from Task 1; populating it on YouTube verification and surfacing per-track badges is Phase 2, noted below.)
- Album gap detection (owned vs. missing + YouTube links) → Task 8, 10. ✓
- MeTube dropped / untouched → confirmed, no MeTube code changed. ✓
- Navidrome → future note only, no task. ✓
- Deployment (music read-only, DB volume, env) → Task 11. ✓

**Deferred to the Phase 2 plan (explicitly out of scope here):** artist similarity, track
recommendations, playlist reconstruction, writing `verified_tracks` from the verify flow, and
"in your collection" badges on search results. The `verified_tracks` schema is created now so
Phase 2 needs no migration.

**Placeholder scan:** no TBD/TODO; every code step contains complete code. Frontend router/nav
wiring (Task 10 Step 4) is described against a pattern the implementer first locates in Step 1
rather than shown verbatim, because the exact router file/shape must be read from the repo — this
is a deliberate "locate then mirror," not a placeholder.

**Type consistency:** `changeKey`/`change_key`, `getDb`/`setDbForTest`, `hasRecording({ artist,
title })`, `detectAlbumGaps` return shape, and the repo function signatures are used identically
across tasks. `scanLibrary()` summary shape `{ scanned, added, updated, removed }` is consistent
in Tasks 4/5/6.
