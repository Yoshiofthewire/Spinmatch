export function upsertLocalTrack(db, {
  path, artist, album, title, durationMs, changeKey,
  trackNumber = null, disc = null, year = null, genre = null,
  hasCoverArt = 0, ext = null, sizeBytes = null, mtimeMs = null,
}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO local_tracks (
      path, artist, album, title, duration_ms, track_number, disc, year, genre,
      has_cover_art, ext, size_bytes, mtime_ms, change_key, removed, added_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      artist = excluded.artist,
      album = excluded.album,
      title = excluded.title,
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
    path, artist, album, title, durationMs, trackNumber, disc, year, genre,
    hasCoverArt, ext, sizeBytes, mtimeMs, changeKey, now, now,
  );
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

// Single-path counterpart to markRemoved, for the targeted rescan: that one
// reconciles against the entire library, so it can't be used on a subset.
export function markRemovedByPath(db, filePath) {
  db.prepare('UPDATE local_tracks SET removed = 1, updated_at = ? WHERE path = ?')
    .run(Date.now(), filePath);
}

export function recomputeStats(db) {
  const { c: totalTracks } = db.prepare('SELECT COUNT(*) c FROM local_tracks WHERE removed = 0').get();
  const { c: totalAlbums } = db.prepare(
    // char(31) is the ASCII unit separator — a real control char that can't
    // occur in a tag value, so "Artist␟Album" pairs collide only on true dupes.
    "SELECT COUNT(DISTINCT COALESCE(artist,'') || char(31) || album) c FROM local_tracks WHERE removed = 0 AND album IS NOT NULL"
  ).get();
  const { c: totalArtists } = db.prepare(
    'SELECT COUNT(DISTINCT artist) c FROM local_tracks WHERE removed = 0 AND artist IS NOT NULL'
  ).get();
  const totals = db.prepare(
    'SELECT SUM(duration_ms) d, SUM(size_bytes) b FROM local_tracks WHERE removed = 0'
  ).get();
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
  `).run(totalTracks, totalAlbums, totalArtists, totals?.d ?? 0, totals?.b ?? 0, Date.now());
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

// Sort keys are resolved through these maps rather than interpolated, so an
// arbitrary ?sort= value can never reach the SQL. Unknown keys fall back to the
// first entry instead of throwing — a stale bookmark shouldn't 500.
function orderBy(map, sort) {
  return map[sort] ?? Object.values(map)[0];
}

const ARTIST_SORTS = {
  name: 'artist COLLATE NOCASE',
  tracks: 'trackCount DESC, artist COLLATE NOCASE',
  albums: 'albumCount DESC, artist COLLATE NOCASE',
  duration: 'totalDurationMs DESC, artist COLLATE NOCASE',
};

export function listArtists(db, { sort = 'name' } = {}) {
  return db.prepare(`
    SELECT artist,
           COUNT(*) AS trackCount,
           COUNT(DISTINCT album) AS albumCount,
           COALESCE(SUM(duration_ms), 0) AS totalDurationMs
    FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL
    GROUP BY artist ORDER BY ${orderBy(ARTIST_SORTS, sort)}
  `).all();
}

const ALBUM_SORTS = {
  artist: 'artist COLLATE NOCASE, year, album COLLATE NOCASE',
  album: 'album COLLATE NOCASE, artist COLLATE NOCASE',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE',
  tracks: 'trackCount DESC, artist COLLATE NOCASE',
  added: 'addedAt DESC, artist COLLATE NOCASE',
};

export function listAlbums(db, { artist, sort = 'artist' } = {}) {
  const where = artist ? 'AND artist = ? COLLATE NOCASE' : '';
  const stmt = db.prepare(`
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
    WHERE removed = 0 AND album IS NOT NULL ${where}
    GROUP BY artist, album ORDER BY ${orderBy(ALBUM_SORTS, sort)}
  `);
  return artist ? stmt.all(artist) : stmt.all();
}

const TRACK_SORTS = {
  title: 'title COLLATE NOCASE',
  artist: 'artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number',
  album: 'album COLLATE NOCASE, disc, track_number, title COLLATE NOCASE',
  duration: 'duration_ms IS NULL, duration_ms DESC',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE',
  added: 'added_at DESC',
};

const TRACK_COLUMNS = `
  id, artist, album, title, duration_ms AS durationMs, track_number AS trackNumber,
  disc, year, genre, has_cover_art AS hasCoverArt, ext, size_bytes AS sizeBytes,
  added_at AS addedAt, path
`;

// Paged because the tracks view runs over the whole library (tens of thousands
// of rows) — the artist and album views aggregate down to a size worth sending
// whole, but this one does not. Returns the total so the client can page.
export function listTracks(db, {
  artist, album, q, sort = 'artist', limit = 100, offset = 0,
} = {}) {
  const clauses = ['removed = 0'];
  const params = [];
  if (artist) { clauses.push('artist = ? COLLATE NOCASE'); params.push(artist); }
  if (album) { clauses.push('album = ? COLLATE NOCASE'); params.push(album); }
  if (q) {
    // ESCAPE binds to each LIKE individually, and % / _ in the user's query are
    // escaped so a search for "50%" isn't a wildcard.
    clauses.push(
      "(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')"
    );
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    params.push(like, like, like);
  }
  const where = clauses.join(' AND ');
  const { c: total } = db.prepare(
    `SELECT COUNT(*) c FROM local_tracks WHERE ${where}`
  ).get(...params);
  const tracks = db.prepare(`
    SELECT ${TRACK_COLUMNS}
    FROM local_tracks WHERE ${where}
    ORDER BY ${orderBy(TRACK_SORTS, sort)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { tracks, total };
}

// Full tracklist of one album in playing order. Not paged: an album is small,
// and the album view needs every position to spot the gaps.
export function getAlbumTracks(db, { artist, album }) {
  return db.prepare(`
    SELECT ${TRACK_COLUMNS}
    FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE
    ORDER BY disc, track_number, title COLLATE NOCASE
  `).all(artist, album);
}

export function getTrackById(db, id) {
  return db.prepare(
    `SELECT ${TRACK_COLUMNS} FROM local_tracks WHERE id = ? AND removed = 0`
  ).get(id) ?? null;
}

// Albums that look incomplete judged purely on what's on disk — no upstream
// call, so this stays available when MusicBrainz doesn't. Three separate
// signals, ranked by how confident we can be:
//   gaps       - numbered holes in 1..max, e.g. {1,2,3,5,6} is missing 4
//   single     - a lone track filed as an album (usually a stray download)
//   unnumbered - no track numbers at all, so completeness is unknowable
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

  const numbersStmt = db.prepare(`
    SELECT DISTINCT track_number AS n FROM local_tracks
    WHERE removed = 0 AND album = ? AND track_number IS NOT NULL
      AND (artist = ? OR (artist IS NULL AND ? IS NULL))
  `);

  const results = [];
  for (const a of albums) {
    if (a.numberedCount === 0) {
      results.push({ ...a, reason: 'unnumbered', missingPositions: [] });
      continue;
    }
    const owned = new Set(numbersStmt.all(a.album, a.artist, a.artist).map((r) => r.n));
    const missingPositions = [];
    for (let n = 1; n <= a.maxTrackNumber; n += 1) {
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

// Tagging problems that make the rest of the library (and gap detection in
// particular) misbehave. All pure SQL, all instant.
export function findHealthIssues(db) {
  const count = (sql) => db.prepare(`SELECT COUNT(*) c FROM local_tracks WHERE removed = 0 AND ${sql}`).get().c;
  // Just the number here — this endpoint loads with the page, and the copies
  // themselves are only needed by the duplicates view, which fetches them itself.
  const { c: duplicateCount } = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT 1 FROM local_tracks
      WHERE removed = 0 AND artist IS NOT NULL AND title IS NOT NULL
      GROUP BY LOWER(artist), LOWER(title)
      HAVING COUNT(*) > 1
    )
  `).get();
  return {
    missingArtist: count('artist IS NULL'),
    missingAlbum: count('album IS NULL'),
    missingTitle: count('title IS NULL'),
    missingTrackNumber: count('track_number IS NULL'),
    missingDuration: count('duration_ms IS NULL'),
    noCoverArt: count('has_cover_art = 0'),
    duplicateCount,
  };
}

// The predicate behind each Health count, reused to list the actual offending
// tracks. Whitelisted the same way as the sort maps: the client sends a key,
// never SQL.
const HEALTH_ISSUES = {
  missingArtist: 'artist IS NULL',
  missingAlbum: 'album IS NULL',
  missingTitle: 'title IS NULL',
  missingTrackNumber: 'track_number IS NULL',
  missingDuration: 'duration_ms IS NULL',
  noCoverArt: 'has_cover_art = 0',
};

export function isHealthIssue(issue) {
  return Object.hasOwn(HEALTH_ISSUES, issue);
}

// The tracks behind one Health count. Paged, because "no embedded cover art" can
// legitimately match most of a library.
export function listHealthTracks(db, { issue, limit = 50, offset = 0 }) {
  const predicate = HEALTH_ISSUES[issue];
  if (!predicate) return { tracks: [], total: 0 };
  const where = `removed = 0 AND ${predicate}`;
  const { c: total } = db.prepare(`SELECT COUNT(*) c FROM local_tracks WHERE ${where}`).get();
  const tracks = db.prepare(`
    SELECT ${TRACK_COLUMNS} FROM local_tracks WHERE ${where}
    ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number, path
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { tracks, total };
}

// Every copy of each duplicated artist/title, so they can be compared field by
// field. findHealthIssues only counts them; deciding which copy to keep needs
// the paths, formats, sizes and durations side by side.
export function findDuplicateGroups(db, { limit = 200 } = {}) {
  const groups = db.prepare(`
    SELECT artist, title, COUNT(*) AS copies
    FROM local_tracks
    WHERE removed = 0 AND artist IS NOT NULL AND title IS NOT NULL
    GROUP BY LOWER(artist), LOWER(title)
    HAVING COUNT(*) > 1
    ORDER BY copies DESC, artist COLLATE NOCASE, title COLLATE NOCASE
    LIMIT ?
  `).all(limit);

  const copiesStmt = db.prepare(`
    SELECT ${TRACK_COLUMNS} FROM local_tracks
    WHERE removed = 0 AND LOWER(artist) = ? AND LOWER(title) = ?
    ORDER BY album COLLATE NOCASE, path
  `);

  return groups.map((g) => ({
    artist: g.artist,
    title: g.title,
    copies: copiesStmt.all(g.artist.toLowerCase(), g.title.toLowerCase()),
  }));
}

// Indexed file paths for one artist or album. The targeted rescan turns these
// into directories to walk (path handling stays out of this module, which is
// deliberately SQL-only) so a file added since the last scan is picked up too.
export function listTrackPaths(db, { artist, album }) {
  const clauses = ['removed = 0'];
  const params = [];
  if (artist) { clauses.push('artist = ? COLLATE NOCASE'); params.push(artist); }
  if (album) { clauses.push('album = ? COLLATE NOCASE'); params.push(album); }
  return db.prepare(
    `SELECT path FROM local_tracks WHERE ${clauses.join(' AND ')}`
  ).all(...params).map((r) => r.path);
}

// Distinct album titles owned by an artist. The discography diff needs these to
// compare against a MusicBrainz release-group list.
export function listArtistAlbums(db, artist) {
  return db.prepare(`
    SELECT DISTINCT album FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND album IS NOT NULL
  `).all(artist).map((r) => r.album);
}

// Every (artist, album) and (artist, title) pair in the library, normalized for
// comparison against MusicBrainz names. Returned as Sets of "artist|name" keys.
//
// The whole library in one pass rather than a query per item: a search result
// page asks about a few dozen names at once, and normalizeTitle folding has to
// happen in JS anyway, so per-item SQL would be dozens of queries that still
// couldn't match "Kid A (Deluxe Edition)" to "Kid A".
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

// All live track titles for an artist (case-insensitive). Used by gap detection
// to match owned tracks against a MusicBrainz tracklist with title
// normalization, which exact-equality hasRecording() can't do.
export function listArtistTitles(db, artist) {
  return db.prepare(`
    SELECT title FROM local_tracks
    WHERE removed = 0 AND artist = ? COLLATE NOCASE AND title IS NOT NULL
  `).all(artist).map((r) => r.title);
}
