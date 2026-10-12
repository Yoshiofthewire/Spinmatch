import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { makeDupKey, makeMatchKey, makeTitleKey } from './normalize.js';

// Bump with a matching step in migrate().
const SCHEMA_VERSION = 9;

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
  -- Folded "artist␟title" and "title", computed in JS on write (see
  -- libraryRepo.upsertLocalTrack). Distinct from dup_key above: these fold
  -- through normalizeTitle, so they match "Kid A (Remastered)" to "Kid A",
  -- which is what a playlist item has to do. dup_key must not, because two
  -- different masterings are genuinely two files.
  match_key     TEXT,
  title_key     TEXT,
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

-- Undo journal: one batch per user action (kind: edit | album-edit | fix | bulk-fix).
CREATE TABLE IF NOT EXISTS tag_batches (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at  INTEGER
);

-- before/after are JSON {field: value|null}; a coverArt key means art was written.
CREATE TABLE IF NOT EXISTS tag_writes (
  id                INTEGER PRIMARY KEY,
  batch_id          INTEGER NOT NULL REFERENCES tag_batches(id) ON DELETE CASCADE,
  track_id          INTEGER,
  path              TEXT NOT NULL,
  before            TEXT NOT NULL,
  after             TEXT NOT NULL,
  cover_before      BLOB,
  cover_before_mime TEXT,
  after_mtime_ms    INTEGER,
  undone_at         INTEGER
);
`;

// After migrate(): upgraded installs lack these columns until it runs.
// Partial on `removed = 0` because every read filters on it.
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
CREATE INDEX IF NOT EXISTS idx_lt_live_match_key ON local_tracks(match_key) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_title_key ON local_tracks(title_key) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_pi_playlist ON playlist_items(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_tw_batch ON tag_writes(batch_id);

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

// Post-v1 columns for upgraded installs; keep in sync with SCHEMA.
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

const V6_TRACK_COLUMNS = [
  ['album_synthesized', 'INTEGER NOT NULL DEFAULT 0'],
  ['title_synthesized', 'INTEGER NOT NULL DEFAULT 0'],
  ['dup_key', 'TEXT'],
];

const V7_TRACK_COLUMNS = [
  ['match_key', 'TEXT'],
  ['title_key', 'TEXT'],
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

    // Seed added_at before the rescan below rewrites updated_at.
    db.exec('UPDATE local_tracks SET added_at = updated_at WHERE added_at IS NULL');

    // Clearing change_key forces one tag re-read to fill the new columns.
    db.exec("UPDATE local_tracks SET change_key = '' WHERE removed = 0");
  }

  if (current < 3) {
    // Unused table.
    db.exec('DROP TABLE IF EXISTS verified_tracks');
  }

  if (current < 4) {
    addMissingColumns(db, 'app_auth', [['token_epoch', 'INTEGER NOT NULL DEFAULT 0']]);
    // Start existing installs at 1 so pre-epoch tokens (read as 0) are revoked.
    if (current > 0) db.exec('UPDATE app_auth SET token_epoch = 1 WHERE token_epoch = 0');
  }

  // v5: new tables only, created by SCHEMA; nothing to backfill.

  if (current < 6) {
    addMissingColumns(db, 'local_tracks', V6_TRACK_COLUMNS);
    // Synthesized flags need a tag re-read (change_key cleared below). Out-of-range
    // numbers are nulled now so the Library page is safe before that rescan.
    db.exec(`UPDATE local_tracks SET track_number = NULL
             WHERE track_number IS NOT NULL AND (track_number < 1 OR track_number > 999)`);
    db.exec(`UPDATE local_tracks SET disc = NULL
             WHERE disc IS NOT NULL AND (disc < 1 OR disc > 99)`);
    db.exec(`UPDATE local_tracks SET year = NULL
             WHERE year IS NOT NULL AND (year < 1 OR year > 2999)`);
    db.exec("UPDATE local_tracks SET change_key = '' WHERE removed = 0");
  }

  if (current < 7) {
    addMissingColumns(db, 'local_tracks', V7_TRACK_COLUMNS);
    // Derived from stored columns, so no rescan.
    const rows = db.prepare('SELECT id, artist, title FROM local_tracks').all();
    const update = db.prepare('UPDATE local_tracks SET match_key = ?, title_key = ? WHERE id = ?');
    for (const row of rows) {
      update.run(makeMatchKey(row.artist, row.title), makeTitleKey(row.title), row.id);
    }
  }

  if (current < 8) {
    // Keys now fold NFC first. Pure functions of stored columns, so no rescan.
    const tracks = db.prepare('SELECT id, artist, album, title FROM local_tracks').all();
    const updateTrack = db.prepare(
      'UPDATE local_tracks SET dup_key = ?, match_key = ?, title_key = ? WHERE id = ?'
    );
    for (const r of tracks) {
      updateTrack.run(
        makeDupKey(r.artist, r.album, r.title), makeMatchKey(r.artist, r.title), makeTitleKey(r.title), r.id,
      );
    }
    const items = db.prepare('SELECT id, artist, title FROM playlist_items').all();
    const updateItem = db.prepare('UPDATE playlist_items SET match_key = ?, title_key = ? WHERE id = ?');
    for (const r of items) {
      updateItem.run(makeMatchKey(r.artist, r.title), makeTitleKey(r.title), r.id);
    }
  }

  // v9: tag_batches/tag_writes, new tables only, created by SCHEMA.

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
  // First: the scan worker's WAL checkpoint on close can lock the file.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  // WAL: reads don't block behind a scan.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // IMMEDIATE: a second connection waits, then sees the finished migration.
  withTransaction(db, () => migrate(db), 'IMMEDIATE');
  db.exec(INDEXES);
  return db;
}

// node:sqlite has no db.transaction() helper.
export function withTransaction(db, fn, mode = 'DEFERRED') {
  db.exec(`BEGIN ${mode}`);
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
