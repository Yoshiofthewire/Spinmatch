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

const { openDb, migrate } = await import('../src/lib/db.js');

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
  assert.equal(version.value, '7');
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

test('a forced re-tag happens once per version that needs one, not on every upgrade', () => {
  // Two version steps clear change_key to force a re-read of every file: v2
  // (which added columns) and v6 (which records whether album/title came from a
  // tag or from the path, and which stores the folded duplicate key — neither
  // recoverable from an existing row). Each must fire exactly once. A bump that
  // needs no re-read must not cost a full rescan, which is what this guards.
  withV1Db((dbPath) => {
    const first = openDb(dbPath);
    first.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    first.prepare("UPDATE local_tracks SET change_key = '10:1'").run();
    first.close();

    // v2 -> current crosses v6, so this one re-tag is expected.
    const second = openDb(dbPath);
    assert.equal(second.prepare('SELECT change_key FROM local_tracks').get().change_key, '');
    assert.equal(
      second.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      '7',
    );
    second.prepare("UPDATE local_tracks SET change_key = '20:2'").run();
    second.close();

    // Already at current: no further migration work, so the key survives.
    const third = openDb(dbPath);
    assert.equal(third.prepare('SELECT change_key FROM local_tracks').get().change_key, '20:2');
    third.close();
  });
});

test('v6 clears out-of-range numeric tags that predate the clamp', () => {
  // A track number stored before rowFor clamped it is the value that turned
  // findIncompleteAlbums into a RangeError. The rescan v6 forces would fix it
  // eventually, but the Library page has to survive being opened before that
  // scan finishes — so the existing rows are corrected by the migration itself.
  withV1Db((dbPath) => {
    const first = openDb(dbPath);
    first.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    first.prepare('UPDATE local_tracks SET track_number = 2000000000, disc = 500, year = 99999').run();
    first.close();

    const second = openDb(dbPath);
    const row = second.prepare('SELECT track_number, disc, year FROM local_tracks').get();
    assert.equal(row.track_number, null);
    assert.equal(row.disc, null);
    assert.equal(row.year, null);
    second.close();
  });
});

// v5 introduces verified_links and library_similar_cache. Both are created by
// SCHEMA, which runs before migrate(), so the point of these is that an
// *upgraded* install ends up with them too — not just a fresh one.
test('upgrading to v5 creates the cache tables', () => {
  withV1Db((dbPath) => {
    const db = openDb(dbPath);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(names.includes('verified_links'), 'verified_links exists after upgrade');
    assert.ok(names.includes('library_similar_cache'), 'library_similar_cache exists after upgrade');
    db.close();
  });
});

test('re-opening a v5 database leaves remembered links alone', () => {
  withV1Db((dbPath) => {
    const first = openDb(dbPath);
    first.prepare(
      'INSERT INTO verified_links (recording_mbid, video_id, checked_at) VALUES (?, ?, ?)'
    ).run('77777777-7777-4777-8777-777777777777', 'abc123', Date.now());
    first.close();

    // A cache that got wiped on every restart would be no better than the
    // in-memory one it exists to outlast.
    const second = openDb(dbPath);
    const row = second.prepare('SELECT video_id FROM verified_links').get();
    assert.equal(row.video_id, 'abc123');
    second.close();
  });
});

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
