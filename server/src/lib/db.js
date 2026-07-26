import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Bumped when local_tracks gains columns that existing rows need backfilled or
// re-read from disk. migrate() below is what actually reacts to the change.
const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS local_tracks (
  id            INTEGER PRIMARY KEY,
  path          TEXT UNIQUE NOT NULL,
  artist        TEXT,
  album         TEXT,
  title         TEXT,
  -- 1 when the value in album/title above was derived from the file's location
  -- (folder name, filename) because the tag itself was empty. The columns are
  -- filled either way so browse views have something to group and label by;
  -- these flags are what the Health tab's "No album tag"/"No title tag" counts
  -- are computed from, since an IS NULL test can never be true for a scanned row.
  album_synthesized INTEGER NOT NULL DEFAULT 0,
  title_synthesized INTEGER NOT NULL DEFAULT 0,
  -- Case-folded "artist␟album␟title", computed in JS on write (see
  -- libraryRepo.upsertLocalTrack). Stored rather than derived at query time
  -- because SQLite's LOWER() folds ASCII only and JavaScript's toLowerCase()
  -- does not, so a group built one way and queried the other disagrees the
  -- moment an artist is called "Ärzte". Storing the folded value lets the
  -- duplicate count be a GROUP BY instead of a full table load into JS.
  dup_key       TEXT,
  duration_ms   INTEGER,
  track_number  INTEGER,
  disc          INTEGER,
  year          INTEGER,
  genre         TEXT,
  has_cover_art INTEGER NOT NULL DEFAULT 0,
  ext           TEXT,
  size_bytes    INTEGER,
  mtime_ms      INTEGER,
  change_key    TEXT NOT NULL,
  removed       INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER,
  updated_at    INTEGER NOT NULL
);
-- Cached resolutions of a local artist/album name to its MusicBrainz id so the
-- discography diff doesn't re-search on every visit. A NULL mbid alongside a
-- checked_at is a remembered negative result ("we looked, nothing matched"),
-- which also keeps an unresolvable artist from being re-searched every visit.
CREATE TABLE IF NOT EXISTS library_artist_links (
  artist       TEXT PRIMARY KEY,
  mb_artist_id TEXT,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  checked_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_album_links (
  artist             TEXT NOT NULL,
  album              TEXT NOT NULL,
  release_group_mbid TEXT,
  confirmed          INTEGER NOT NULL DEFAULT 0,
  checked_at         INTEGER NOT NULL,
  PRIMARY KEY (artist, album)
);

CREATE TABLE IF NOT EXISTS collection_stats (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  total_tracks      INTEGER,
  total_albums      INTEGER,
  total_artists     INTEGER,
  total_duration_ms INTEGER,
  total_bytes       INTEGER,
  last_scan_at      INTEGER
);

-- Single admin credential, created on first run via the setup flow.
-- token_epoch is stamped into every issued session token and compared on every
-- request: bumping it invalidates all outstanding sessions at once, which is
-- what makes a password change (or a forced sign-out) actually revoke access.
CREATE TABLE IF NOT EXISTS app_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  token_epoch   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Persisted HMAC secret used to sign session cookies (survives restarts).
CREATE TABLE IF NOT EXISTS auth_secret (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);

-- YouTube matches for recordings the user does NOT own, keyed on the MusicBrainz
-- recording. This is the table the dropped verified_tracks should have been:
-- that one was keyed on a local file and required a YouTube URL, which describes
-- nothing the app does — verification runs against the gaps, not the collection.
--
-- It exists because sweeping an artist's missing discography is one rate-limited
-- yt-dlp call per track at roughly 1/sec, so a large artist is a run of many
-- minutes. verifyTrack's in-memory cache is 1000 entries with a 1h TTL, so
-- without this a restart mid-sweep throws the whole run away.
--
-- A row with a NULL video_id is a remembered "looked, found nothing", which is
-- what stops a sweep re-querying the tracks YouTube doesn't have every time.
CREATE TABLE IF NOT EXISTS verified_links (
  recording_mbid TEXT PRIMARY KEY,
  video_id       TEXT,
  video_title    TEXT,
  video_duration_ms INTEGER,
  artist         TEXT,
  title          TEXT,
  checked_at     INTEGER NOT NULL
);

-- Artists MusicBrainz relates to one of yours, cached because the lookup is one
-- rate-limited call per seed artist and discovery seeds from many at once.
-- Same remembered-negative convention as library_artist_links: a row with no
-- related artists is a recorded "we looked", not a gap to retry every visit.
CREATE TABLE IF NOT EXISTS library_similar_cache (
  mb_artist_id   TEXT PRIMARY KEY,
  related_json   TEXT NOT NULL,
  checked_at     INTEGER NOT NULL
);
`;

// Applied after migrate(), never as part of SCHEMA: on an upgraded install the
// columns these index don't exist until the migration has added them, and
// CREATE INDEX would fail with "no such column" before it ever ran.
//
// Every read starts `WHERE removed = 0`, so these are partial indexes on that
// predicate: a plain index on (artist) can't serve a query filtered on `removed`
// as well, which left the browse and health queries doing full table scans. The
// health predicates get their own, because those columns being NULL is exactly
// what the Health tab counts and a full scan per counter is what made opening
// the Library page block the event loop.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_lt_live_artist ON local_tracks(artist) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_album  ON local_tracks(album)  WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_artist_album ON local_tracks(artist, album) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_added  ON local_tracks(added_at) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_title  ON local_tracks(title)  WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_no_artist ON local_tracks(id) WHERE removed = 0 AND artist IS NULL;
-- New names, because these match a new predicate and CREATE INDEX IF NOT EXISTS
-- will not rebuild an index that already exists under the old one. The originals
-- tested album/title for NULL — a condition the scanner never produces — so they
-- were empty indexes maintained on every write to serve a count that was always
-- zero. Dropped below.
CREATE INDEX IF NOT EXISTS idx_lt_live_untagged_album ON local_tracks(id) WHERE removed = 0 AND (album IS NULL OR album_synthesized = 1);
CREATE INDEX IF NOT EXISTS idx_lt_live_untagged_title ON local_tracks(id) WHERE removed = 0 AND (title IS NULL OR title_synthesized = 1);
CREATE INDEX IF NOT EXISTS idx_lt_live_no_track_number ON local_tracks(id) WHERE removed = 0 AND track_number IS NULL;
CREATE INDEX IF NOT EXISTS idx_lt_live_no_duration ON local_tracks(id) WHERE removed = 0 AND duration_ms IS NULL;
CREATE INDEX IF NOT EXISTS idx_lt_live_no_cover ON local_tracks(id) WHERE removed = 0 AND has_cover_art = 0;
CREATE INDEX IF NOT EXISTS idx_lt_removed ON local_tracks(removed) WHERE removed = 1;
-- Serves the duplicate GROUP BY, which runs on every Library page load (the
-- Health tab shows the count) and previously pulled every row in the table into
-- JS to compute it.
CREATE INDEX IF NOT EXISTS idx_lt_live_dup_key ON local_tracks(dup_key) WHERE removed = 0 AND dup_key IS NOT NULL;

-- Superseded by the partial indexes above, which SQLite can use for strictly
-- more queries. Dropped so an upgraded install isn't paying to maintain both.
DROP INDEX IF EXISTS idx_local_tracks_artist;
DROP INDEX IF EXISTS idx_local_tracks_album;
DROP INDEX IF EXISTS idx_local_tracks_artist_album;
DROP INDEX IF EXISTS idx_local_tracks_added;

-- Replaced by the untagged_* pair above, whose predicates match what the health
-- queries actually ask.
DROP INDEX IF EXISTS idx_lt_live_no_album;
DROP INDEX IF EXISTS idx_lt_live_no_title;
`;

// Columns added to local_tracks after v1 shipped. CREATE TABLE IF NOT EXISTS
// won't touch a table that already exists, so an upgraded install needs these
// applied by hand. Kept in sync with the SCHEMA definition above.
const V2_TRACK_COLUMNS = [
  ['track_number', 'INTEGER'],
  ['disc', 'INTEGER'],
  ['year', 'INTEGER'],
  ['genre', 'TEXT'],
  ['has_cover_art', 'INTEGER NOT NULL DEFAULT 0'],
  ['ext', 'TEXT'],
  ['size_bytes', 'INTEGER'],
  ['mtime_ms', 'INTEGER'],
  ['added_at', 'INTEGER'],
];

const V2_STATS_COLUMNS = [
  ['total_duration_ms', 'INTEGER'],
  ['total_bytes', 'INTEGER'],
];

// v6: records whether album/title were read from the file or derived from its
// path. See the note on the columns in SCHEMA.
const V6_TRACK_COLUMNS = [
  ['album_synthesized', 'INTEGER NOT NULL DEFAULT 0'],
  ['title_synthesized', 'INTEGER NOT NULL DEFAULT 0'],
  ['dup_key', 'TEXT'],
];

function addMissingColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function migrate(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = Number(row?.value ?? 0);
  if (current >= SCHEMA_VERSION) return current;

  if (current < 2) {
    addMissingColumns(db, 'local_tracks', V2_TRACK_COLUMNS);
    addMissingColumns(db, 'collection_stats', V2_STATS_COLUMNS);

    // Order matters. added_at has to be seeded from the existing updated_at
    // BEFORE the re-tag below rewrites updated_at, or every track's "added"
    // date collapses to the upgrade timestamp with no way to recover it.
    db.exec('UPDATE local_tracks SET added_at = updated_at WHERE added_at IS NULL');

    // The new columns are empty for every existing row, and the scanner skips
    // files whose change_key still matches (libraryScanner.js), so without this
    // they would stay empty forever. Clearing the key forces exactly one
    // full re-read of tags on the next scan; the file contents are untouched.
    db.exec("UPDATE local_tracks SET change_key = '' WHERE removed = 0");
  }

  if (current < 3) {
    // verified_tracks was created by the original MVP schema and never read or
    // written. Its shape (one row per *owned* file, requiring both a MusicBrainz
    // recording id and a YouTube URL) doesn't match any flow the app has:
    // verification runs against tracks you don't own. Dropping it rather than
    // leaving a dead table for a future reader to puzzle over.
    db.exec('DROP TABLE IF EXISTS verified_tracks');
  }

  if (current < 4) {
    addMissingColumns(db, 'app_auth', [['token_epoch', 'INTEGER NOT NULL DEFAULT 0']]);
    // Tokens issued before this column existed carry no epoch, and must not
    // validate against the default of 0 — otherwise the column revokes nothing
    // on the very upgrade that introduces it. Starting an existing install at 1
    // invalidates every token the old code handed out, exactly once.
    if (current > 0) db.exec('UPDATE app_auth SET token_epoch = 1 WHERE token_epoch = 0');
  }

  // v5 adds verified_links and library_similar_cache. Both are created by
  // SCHEMA, which openDb runs before migrate(), so an upgraded install already
  // has them by the time this is reached — and both are caches, so there is
  // nothing to backfill. The bump exists to record that this install is on 5.

  if (current < 6) {
    addMissingColumns(db, 'local_tracks', V6_TRACK_COLUMNS);
    // Whether an existing row's album/title came from a tag or from its path is
    // not recoverable from the row — the scanner wrote the fallback into the
    // same column and kept no record. The only source of truth is the file, so
    // clearing change_key forces exactly one re-read of tags on the next scan,
    // the same one-time cost (and the same mechanism) as the v2 backfill. Until
    // that scan lands the two new counts read zero, which is what they read
    // before this migration anyway.
    //
    // Track numbers are clamped on that same re-read. An existing row can hold
    // the out-of-range value that crashed findIncompleteAlbums, so the ones
    // already stored are cleared here rather than left to the rescan — the
    // Library page has to survive being opened before the scan finishes.
    db.exec(`UPDATE local_tracks SET track_number = NULL
             WHERE track_number IS NOT NULL AND (track_number < 1 OR track_number > 999)`);
    db.exec(`UPDATE local_tracks SET disc = NULL
             WHERE disc IS NOT NULL AND (disc < 1 OR disc > 99)`);
    db.exec(`UPDATE local_tracks SET year = NULL
             WHERE year IS NOT NULL AND (year < 1 OR year > 2999)`);
    db.exec("UPDATE local_tracks SET change_key = '' WHERE removed = 0");
  }

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(String(SCHEMA_VERSION));
  return SCHEMA_VERSION;
}

export function openDb(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  // WAL lets dashboard reads run without blocking behind a long library scan
  // (and vice-versa); NORMAL sync is the standard, safe WAL pairing. Harmless
  // no-op for the in-memory DB used by tests.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // A fresh DB gets every column from SCHEMA, so migrate() finds nothing to
  // alter and just stamps the version. Only an upgraded install does real work.
  withTransaction(db, () => migrate(db));
  db.exec(INDEXES);
  return db;
}

// Runs fn inside a single transaction, rolling back on error. node:sqlite has
// no db.transaction() helper, so this is the manual BEGIN/COMMIT/ROLLBACK.
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

let singleton = null;

export function getDb() {
  if (!singleton) singleton = openDb(config.library.dbPath);
  return singleton;
}

export function setDbForTest(db) {
  singleton = db;
}
