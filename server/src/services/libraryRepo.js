import path from 'node:path';
import { MAX_TRACK_NUMBER } from '../lib/tagLimits.js';
import { makeDupKey, makeMatchKey, makeTitleKey } from '../lib/normalize.js';

export function upsertLocalTrack(db, {
  path, artist, album, title, durationMs, changeKey,
  trackNumber = null, disc = null, year = null, genre = null,
  hasCoverArt = 0, ext = null, sizeBytes = null, mtimeMs = null,
  albumSynthesized = 0, titleSynthesized = 0,
}) {
  const now = Date.now();
  // Derived keys computed here so no writer can let them drift from their columns.
  const dupKey = makeDupKey(artist, album, title);
  const matchKey = makeMatchKey(artist, title);
  const titleKey = makeTitleKey(title);
  db.prepare(`
    INSERT INTO local_tracks (
      path, artist, album, title, album_synthesized, title_synthesized, dup_key,
      match_key, title_key,
      duration_ms, track_number, disc, year, genre,
      has_cover_art, ext, size_bytes, mtime_ms, change_key, removed, added_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      artist = excluded.artist,
      album = excluded.album,
      title = excluded.title,
      album_synthesized = excluded.album_synthesized,
      title_synthesized = excluded.title_synthesized,
      dup_key = excluded.dup_key,
      match_key = excluded.match_key,
      title_key = excluded.title_key,
      duration_ms = excluded.duration_ms,
      track_number = excluded.track_number,
      disc = excluded.disc,
      year = excluded.year,
      genre = excluded.genre,
      has_cover_art = excluded.has_cover_art,
      ext = excluded.ext,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      change_key = excluded.change_key,
      removed = 0,
      -- added_at is deliberately absent: it records when the track first
      -- entered the library, so a re-tag or a re-scan must not move it.
      updated_at = excluded.updated_at
  `).run(
    path, artist, album, title, albumSynthesized, titleSynthesized, dupKey,
    matchKey, titleKey,
    durationMs, trackNumber, disc, year, genre,
    hasCoverArt, ext, sizeBytes, mtimeMs, changeKey, now, now,
  );
}

export function getChangeKeys(db) {
  const rows = db.prepare('SELECT path, change_key FROM local_tracks WHERE removed = 0').all();
  return new Map(rows.map((r) => [r.path, r.change_key]));
}

export function markRemoved(db, paths) {
  const stmt = db.prepare('UPDATE local_tracks SET removed = 1, updated_at = ? WHERE path = ? AND removed = 0');
  const now = Date.now();
  for (const p of paths) stmt.run(now, p);
}

export function markRemovedByPath(db, filePath) {
  db.prepare('UPDATE local_tracks SET removed = 1, updated_at = ? WHERE path = ?')
    .run(Date.now(), filePath);
}

// Rewrites stored paths to a new root spelling so rows keep ids and added_at. OR IGNORE: existing row wins.
export function rebaseTrackPaths(db, fromRoot, toRoot) {
  if (!fromRoot || !toRoot || fromRoot === toRoot) return 0;
  const from = fromRoot + path.sep;
  return db.prepare(
    'UPDATE OR IGNORE local_tracks SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?'
  ).run(toRoot + path.sep, from.length + 1, from.length, from).changes;
}

// One aggregate pass: runs after every reindex, and node:sqlite blocks the event loop.
export function recomputeStats(db) {
  const t = db.prepare(`
    SELECT COUNT(*) AS totalTracks,
           -- char(31) is the ASCII unit separator — a real control char that
           -- can't occur in a tag value, so "Artist␟Album" pairs collide only on
           -- true duplicates. COUNT(DISTINCT ...) skips NULLs, which is why the
           -- CASE yields NULL for a track with no album.
           COUNT(DISTINCT CASE WHEN album IS NOT NULL
                 THEN COALESCE(artist, '') || char(31) || album END) AS totalAlbums,
           COUNT(DISTINCT artist) AS totalArtists,
           COALESCE(SUM(duration_ms), 0) AS totalDurationMs,
           COALESCE(SUM(size_bytes), 0) AS totalBytes
    FROM local_tracks WHERE removed = 0
  `).get();
  db.prepare(`
    INSERT INTO collection_stats (
      id, total_tracks, total_albums, total_artists, total_duration_ms, total_bytes, last_scan_at
    )
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total_tracks = excluded.total_tracks,
      total_albums = excluded.total_albums,
      total_artists = excluded.total_artists,
      total_duration_ms = excluded.total_duration_ms,
      total_bytes = excluded.total_bytes,
      last_scan_at = excluded.last_scan_at
  `).run(
    t.totalTracks, t.totalAlbums, t.totalArtists, t.totalDurationMs, t.totalBytes, Date.now(),
  );
}

// Tombstones keep a briefly-unavailable file (unmounted volume) from returning as new; purge old ones.
export function purgeRemoved(db, { olderThanMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  return db.prepare('DELETE FROM local_tracks WHERE removed = 1 AND updated_at < ?')
    .run(Date.now() - olderThanMs).changes;
}

export function getStats(db) {
  const row = db.prepare(`
    SELECT total_tracks, total_albums, total_artists, total_duration_ms, total_bytes, last_scan_at
    FROM collection_stats WHERE id = 1
  `).get();
  const formats = db.prepare(`
    SELECT ext, COUNT(*) AS c FROM local_tracks
    WHERE removed = 0 AND ext IS NOT NULL
    GROUP BY ext ORDER BY c DESC
  `).all().map((r) => ({ ext: r.ext, count: r.c }));
  return {
    totalTracks: row?.total_tracks ?? 0,
    totalAlbums: row?.total_albums ?? 0,
    totalArtists: row?.total_artists ?? 0,
    totalDurationMs: row?.total_duration_ms ?? 0,
    totalBytes: row?.total_bytes ?? 0,
    lastScanAt: row?.last_scan_at ?? 0,
    formats,
  };
}

// Whitelist: ?sort= never reaches SQL; unknown keys fall back rather than 500.
function orderBy(map, sort, fallbackKey) {
  return map[sort] ?? map[fallbackKey];
}

// ASCII 31, built at runtime to keep invisible control chars out of the source.
const UNIT_SEPARATOR = String.fromCharCode(31);


const ARTIST_SORTS = {
  name: 'artist COLLATE NOCASE, artist',
  tracks: 'trackCount DESC, artist COLLATE NOCASE, artist',
  albums: 'albumCount DESC, artist COLLATE NOCASE, artist',
  duration: 'totalDurationMs DESC, artist COLLATE NOCASE, artist',
};

export function listArtists(db, { sort = 'name', q, limit = 500, offset = 0 } = {}) {
  const clauses = ['removed = 0', 'artist IS NOT NULL'];
  const params = [];
  if (q) { clauses.push("artist LIKE ? ESCAPE '\\'"); params.push(likeFor(q)); }
  const where = clauses.join(' AND ');
  const { c: total } = db.prepare(
    `SELECT COUNT(DISTINCT artist) c FROM local_tracks WHERE ${where}`
  ).get(...params);
  const artists = db.prepare(`
    SELECT artist,
           COUNT(*) AS trackCount,
           COUNT(DISTINCT album) AS albumCount,
           COALESCE(SUM(duration_ms), 0) AS totalDurationMs
    FROM local_tracks
    WHERE ${where}
    GROUP BY artist ORDER BY ${orderBy(ARTIST_SORTS, sort, 'name')}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { artists, total };
}

export function listArtistNames(db) {
  return db.prepare(
    'SELECT DISTINCT artist FROM local_tracks WHERE removed = 0 AND artist IS NOT NULL'
  ).all().map((r) => r.artist);
}

const ALBUM_SORTS = {
  artist: 'artist COLLATE NOCASE, year, album COLLATE NOCASE, artist, album',
  album: 'album COLLATE NOCASE, artist COLLATE NOCASE, artist, album',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE, artist, album',
  tracks: 'trackCount DESC, artist COLLATE NOCASE, artist, album',
  added: 'addedAt DESC, artist COLLATE NOCASE, artist, album',
};

export function listAlbums(db, { artist, sort = 'artist', q, limit = 500, offset = 0 } = {}) {
  const clauses = ['removed = 0', 'album IS NOT NULL'];
  const params = [];
  if (artist) { clauses.push('artist = ? COLLATE NOCASE'); params.push(artist); }
  if (q) {
    clauses.push("(album LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')");
    params.push(likeFor(q), likeFor(q));
  }
  const where = clauses.join(' AND ');
  const { c: total } = db.prepare(
    `SELECT COUNT(*) c FROM (SELECT 1 FROM local_tracks WHERE ${where} GROUP BY artist, album)`
  ).get(...params);
  const albums = db.prepare(`
    SELECT artist,
           album,
           COUNT(*) AS trackCount,
           MIN(year) AS year,
           COALESCE(SUM(duration_ms), 0) AS totalDurationMs,
           MAX(track_number) AS maxTrackNumber,
           MAX(added_at) AS addedAt,
           -- A track id for the cover endpoint to read art from: one that
           -- carries embedded art if any does, otherwise just the first track,
           -- because the endpoint also looks for a cover image sitting next to
           -- the audio and has_cover_art only tracks the embedded kind.
           COALESCE(MIN(CASE WHEN has_cover_art = 1 THEN id END), MIN(id)) AS coverTrackId
    FROM local_tracks
    WHERE ${where}
    GROUP BY artist, album ORDER BY ${orderBy(ALBUM_SORTS, sort, 'artist')}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { albums, total };
}

// Escapes LIKE wildcards so "50%" isn't match-everything.
function likeFor(q) {
  return `%${String(q).replace(/[%_\\]/g, '\\$&')}%`;
}

const TRACK_SORTS = {
  title: 'title COLLATE NOCASE, id',
  artist: 'artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number, id',
  album: 'album COLLATE NOCASE, disc, track_number, title COLLATE NOCASE, id',
  duration: 'duration_ms IS NULL, duration_ms DESC, id',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE, id',
  added: 'added_at DESC, id',
};

// No path: the server's directory layout stays off browse responses.
const TRACK_COLUMNS = `
  id, artist, album, title, duration_ms AS durationMs, track_number AS trackNumber,
  disc, year, genre, has_cover_art AS hasCoverArt, ext, size_bytes AS sizeBytes,
  added_at AS addedAt, mtime_ms AS mtimeMs,
  album_synthesized AS albumSynthesized, title_synthesized AS titleSynthesized
`;

// Opt-in, for flows that must identify a file on disk (repair, Health, duplicates).
const TRACK_COLUMNS_WITH_PATH = `${TRACK_COLUMNS}, path`;

export function listTracks(db, {
  artist, album, q, sort = 'artist', limit = 100, offset = 0,
} = {}) {
  const clauses = ['removed = 0'];
  const params = [];
  if (artist) { clauses.push('artist = ? COLLATE NOCASE'); params.push(artist); }
  if (album) { clauses.push('album = ? COLLATE NOCASE'); params.push(album); }
  if (q) {
    clauses.push(
      "(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')"
    );
    const like = likeFor(q);
    params.push(like, like, like);
  }
  const where = clauses.join(' AND ');
  const { c: total } = db.prepare(
    `SELECT COUNT(*) c FROM local_tracks WHERE ${where}`
  ).get(...params);
  const tracks = db.prepare(`
    SELECT ${TRACK_COLUMNS}
    FROM local_tracks WHERE ${where}
    ORDER BY ${orderBy(TRACK_SORTS, sort, 'artist')}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { tracks, total };
}

// IS NULL branch: listAlbums groups untagged-artist albums, and `= ?` never matches NULL.
export function getAlbumTracks(db, { artist, album }) {
  const artistClause = artist == null ? 'artist IS NULL' : 'artist = ? COLLATE NOCASE';
  const params = artist == null ? [album] : [artist, album];
  return db.prepare(`
    SELECT ${TRACK_COLUMNS}
    FROM local_tracks
    WHERE removed = 0 AND ${artistClause} AND album = ? COLLATE NOCASE
    ORDER BY disc, track_number, title COLLATE NOCASE
  `).all(...params);
}

// Exact case-folded match, never LIKE: guards credit splitting ("Florence + The Machine").
export function artistExists(db, artist) {
  if (!artist) return false;
  return db.prepare(
    'SELECT 1 FROM local_tracks WHERE removed = 0 AND artist = ? COLLATE NOCASE LIMIT 1'
  ).get(artist) !== undefined;
}

// getAlbumTracks with paths.
export function getAlbumTracksForRepair(db, { artist, album }) {
  const artistClause = artist == null ? 'artist IS NULL' : 'artist = ? COLLATE NOCASE';
  const params = artist == null ? [album] : [artist, album];
  return db.prepare(`
    SELECT ${TRACK_COLUMNS_WITH_PATH}
    FROM local_tracks
    WHERE removed = 0 AND ${artistClause} AND album = ? COLLATE NOCASE
    ORDER BY disc, track_number, title COLLATE NOCASE
  `).all(...params);
}

export function getTrackById(db, id) {
  return db.prepare(
    `SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks WHERE id = ? AND removed = 0`
  ).get(id) ?? null;
}

// Separate function, not a flag, so no caller gets a removed row by accident.
export function getRemovedTrackById(db, id) {
  return db.prepare(
    `SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks WHERE id = ? AND removed = 1`
  ).get(id) ?? null;
}

// Same dup_key as findDuplicateGroups, so the last-copy guard and the UI agree. No dup_key → [].
export function otherLiveCopyPaths(db, id) {
  return db.prepare(`
    SELECT path FROM local_tracks
    WHERE removed = 0 AND dup_key IS NOT NULL AND id != ?
      AND dup_key = (SELECT dup_key FROM local_tracks WHERE id = ?)
  `).all(id, id).map((r) => r.path);
}

// Lock key for duplicateTrash; kept out of TRACK_COLUMNS to stay off every payload.
export function getDupKeyForTrack(db, id) {
  return db.prepare(
    'SELECT dup_key FROM local_tracks WHERE id = ? AND removed = 0'
  ).get(id)?.dup_key ?? null;
}

// Offline incompleteness: gaps (holes in 1..max), single (lone track), unnumbered (unknowable).
// Two queries total, not one per album: node:sqlite is synchronous.
export function findIncompleteAlbums(db) {
  const albums = db.prepare(`
    SELECT artist, album,
           COUNT(*) AS trackCount,
           MAX(track_number) AS maxTrackNumber,
           COUNT(track_number) AS numberedCount,
           MIN(CASE WHEN has_cover_art = 1 THEN id END) AS coverTrackId
    FROM local_tracks
    WHERE removed = 0 AND album IS NOT NULL
    GROUP BY artist, album
  `).all();

  const numbersByAlbum = new Map();
  for (const row of db.prepare(`
    SELECT DISTINCT artist, album, track_number AS n FROM local_tracks
    WHERE removed = 0 AND album IS NOT NULL AND track_number IS NOT NULL
  `).all()) {
    const key = `${row.artist ?? ''}${UNIT_SEPARATOR}${row.album}`;
    if (!numbersByAlbum.has(key)) numbersByAlbum.set(key, new Set());
    numbersByAlbum.get(key).add(row.n);
  }

  const results = [];
  for (const a of albums) {
    if (a.numberedCount === 0) {
      results.push({ ...a, reason: 'unnumbered', missingPositions: [] });
      continue;
    }
    const owned = numbersByAlbum.get(`${a.artist ?? ''}${UNIT_SEPARATOR}${a.album}`) ?? new Set();
    const missingPositions = [];
    // Clamped here too: one bad tag must not allocate a huge array on the main thread.
    const highest = Math.min(a.maxTrackNumber ?? 0, MAX_TRACK_NUMBER);
    for (let n = 1; n <= highest; n += 1) {
      if (!owned.has(n)) missingPositions.push(n);
    }
    if (missingPositions.length) {
      results.push({ ...a, reason: 'gaps', missingPositions });
    } else if (a.trackCount === 1) {
      results.push({ ...a, reason: 'single', missingPositions: [] });
    }
  }

  // Worst first: real numbered holes, then strays, then the unknowable ones.
  const rank = { gaps: 0, single: 1, unnumbered: 2 };
  return results.sort((x, y) => rank[x.reason] - rank[y.reason]
    || y.missingPositions.length - x.missingPositions.length
    || String(x.artist).localeCompare(String(y.artist)));
}

// Shared by counts and drill-down so they agree; client sends a key, never SQL.
// album/title test the synthesized flags because the scanner always fills those columns.
const HEALTH_ISSUES = {
  missingArtist: 'artist IS NULL',
  missingAlbum: '(album IS NULL OR album_synthesized = 1)',
  missingTitle: '(title IS NULL OR title_synthesized = 1)',
  missingTrackNumber: 'track_number IS NULL',
  missingDuration: 'duration_ms IS NULL',
  noCoverArt: 'has_cover_art = 0',
};

// Served by the partial indexes in db.js.
export function findHealthIssues(db) {
  const count = (sql) => db.prepare(`SELECT COUNT(*) c FROM local_tracks WHERE removed = 0 AND ${sql}`).get().c;
  const counts = Object.fromEntries(
    Object.entries(HEALTH_ISSUES).map(([key, sql]) => [key, count(sql)]),
  );
  return { ...counts, duplicateCount: duplicateGroupCount(db) };
}

export function isHealthIssue(issue) {
  return Object.hasOwn(HEALTH_ISSUES, issue);
}

export function listHealthTracks(db, { issue, limit = 50, offset = 0 }) {
  const predicate = HEALTH_ISSUES[issue];
  if (!predicate) return { tracks: [], total: 0 };
  const where = `removed = 0 AND ${predicate}`;
  const { c: total } = db.prepare(`SELECT COUNT(*) c FROM local_tracks WHERE ${where}`).get();
  const tracks = db.prepare(`
    SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks WHERE ${where}
    ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number, path
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { tracks, total };
}

// Album is in the key: the same song on an album and a compilation isn't a duplicate.
// dup_key is folded in JS on write because SQLite LOWER() disagrees with JS on non-ASCII.
const DUPLICATE_KEYS_SQL = `
  SELECT dup_key FROM local_tracks
  WHERE removed = 0 AND dup_key IS NOT NULL
  GROUP BY dup_key HAVING COUNT(*) > 1
`;

function duplicateGroupCount(db) {
  return db.prepare(`SELECT COUNT(*) c FROM (${DUPLICATE_KEYS_SQL})`).get().c;
}

function duplicateGroups(db, { limit = 200 } = {}) {
  const keys = db.prepare(`${DUPLICATE_KEYS_SQL} LIMIT ?`).all(limit).map((r) => r.dup_key);
  if (keys.length === 0) return [];

  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT ${TRACK_COLUMNS_WITH_PATH}, dup_key AS dupKey FROM local_tracks
    WHERE removed = 0 AND dup_key IN (${placeholders})
    ORDER BY album COLLATE NOCASE, path
  `).all(...keys);

  const byKey = new Map(keys.map((k) => [k, []]));
  for (const row of rows) byKey.get(row.dupKey)?.push(row);
  return [...byKey.values()].filter((copies) => copies.length > 1);
}

export function findDuplicateGroups(db, { limit = 200 } = {}) {
  return duplicateGroups(db, { limit })
    .sort((a, b) => b.length - a.length
      || String(a[0].artist).localeCompare(String(b[0].artist))
      || String(a[0].album ?? '').localeCompare(String(b[0].album ?? ''))
      || String(a[0].title).localeCompare(String(b[0].title)))
    .map((copies) => ({
      artist: copies[0].artist,
      album: copies[0].album,
      title: copies[0].title,
      copies,
    }));
}

export function listTrackPaths(db, { artist, album }) {
  const clauses = ['removed = 0'];
  const params = [];
  if (artist) { clauses.push('artist = ? COLLATE NOCASE'); params.push(artist); }
  if (album) { clauses.push('album = ? COLLATE NOCASE'); params.push(album); }
  return db.prepare(
    `SELECT path FROM local_tracks WHERE ${clauses.join(' AND ')}`
  ).all(...params).map((r) => r.path);
}

export function listArtistAlbums(db, artist) {
  return db.prepare(`
    SELECT DISTINCT album FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND album IS NOT NULL
  `).all(artist).map((r) => r.album);
}

// Whole library in one pass: normalizeTitle folding happens in JS, so per-item SQL can't match.
export function collectionKeys(db) {
  const albums = db.prepare(`
    SELECT DISTINCT artist, album AS name FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL AND album IS NOT NULL
  `).all();
  const recordings = db.prepare(`
    SELECT DISTINCT artist, title AS name FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL AND title IS NOT NULL
  `).all();
  return { albums, recordings };
}

export function hasRecording(db, { artist, title }) {
  const row = db.prepare(`
    SELECT 1 FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND title = ? COLLATE NOCASE
    LIMIT 1
  `).get(artist, title);
  return Boolean(row);
}

export function listArtistTitles(db, artist) {
  return db.prepare(`
    SELECT title FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND title IS NOT NULL
  `).all(artist).map((r) => r.title);
}
