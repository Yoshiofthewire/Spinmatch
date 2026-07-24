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
