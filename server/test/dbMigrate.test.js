// Upgrade path from the v1 schema. The risk being covered here is data loss:
// added_at must be seeded from the old updated_at BEFORE the forced re-tag
// rewrites updated_at, or every track's "added" date collapses to the upgrade
// timestamp with nothing left to recover it from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');

// The exact local_tracks shape that shipped before this change.
const V1_SCHEMA = `
CREATE TABLE local_tracks (
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
CREATE TABLE collection_stats (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  total_tracks  INTEGER,
  total_albums  INTEGER,
  total_artists INTEGER,
  last_scan_at  INTEGER
);
CREATE TABLE verified_tracks (
  local_track_id  INTEGER PRIMARY KEY REFERENCES local_tracks(id) ON DELETE CASCADE,
  mb_recording_id TEXT NOT NULL,
  youtube_url     TEXT,
  confidence      REAL,
  verified_at     INTEGER NOT NULL
);
`;

const OLD_TIMESTAMP = 1_700_000_000_000;

function withV1Db(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-migrate-'));
  const dbPath = path.join(dir, 'library.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(V1_SCHEMA);
  seed.prepare(
    'INSERT INTO local_tracks (path, artist, album, title, duration_ms, change_key, removed, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('/m/A/Al/01.mp3', 'A', 'Al', 'One', null, '10:1', 0, OLD_TIMESTAMP);
  seed.close();
  try {
    fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('opening a v1 database adds the new columns without losing rows', () => {
  withV1Db((dbPath) => {
    const db = openDb(dbPath);
    const cols = new Set(db.prepare('PRAGMA table_info(local_tracks)').all().map((c) => c.name));
    for (const name of [
      'track_number', 'disc', 'year', 'genre', 'has_cover_art',
      'ext', 'size_bytes', 'mtime_ms', 'added_at',
    ]) {
      assert.ok(cols.has(name), `expected column ${name}`);
    }
    const row = db.prepare('SELECT * FROM local_tracks').get();
    assert.equal(row.title, 'One');
    db.close();
  });
});

test('added_at is seeded from the pre-migration updated_at, not the upgrade time', () => {
  withV1Db((dbPath) => {
    const db = openDb(dbPath);
    const row = db.prepare('SELECT added_at FROM local_tracks').get();
    assert.equal(row.added_at, OLD_TIMESTAMP);
    db.close();
  });
});

test('change_key is cleared so the next scan re-reads tags exactly once', () => {
  withV1Db((dbPath) => {
    const db = openDb(dbPath);
    assert.equal(db.prepare('SELECT change_key FROM local_tracks').get().change_key, '');
    db.close();

    // Simulate the scan having repopulated the key, then reopen: the migration
    // is version-stamped, so it must not wipe the key a second time.
    const again = openDb(dbPath);
    again.prepare("UPDATE local_tracks SET change_key = '10:1'").run();
    again.close();

    const third = openDb(dbPath);
    assert.equal(third.prepare('SELECT change_key FROM local_tracks').get().change_key, '10:1');
    third.close();
  });
});

test('a fresh database is created at the current version with no migration work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-fresh-'));
  const db = openDb(path.join(dir, 'library.db'));
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(version.value, '3');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the unused verified_tracks table is dropped on upgrade', () => {
  withV1Db((dbPath) => {
    const db = openDb(dbPath);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(!names.includes('verified_tracks'));
    db.close();
  });
});

test('upgrading from v2 to v3 does not trigger another full re-tag', () => {
  // The v2 step clears change_key to force one re-read of every file. A later
  // version bump must not re-run it, or every upgrade costs a full rescan.
  withV1Db((dbPath) => {
    const first = openDb(dbPath);
    first.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    first.prepare("UPDATE local_tracks SET change_key = '10:1'").run();
    first.close();

    const second = openDb(dbPath);
    assert.equal(second.prepare('SELECT change_key FROM local_tracks').get().change_key, '10:1');
    assert.equal(
      second.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      '3',
    );
    second.close();
  });
});
