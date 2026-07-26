export function upsertLocalTrack(db, {
  path, artist, album, title, durationMs, changeKey,
  trackNumber = null, disc = null, year = null, genre = null,
  hasCoverArt = 0, ext = null, sizeBytes = null, mtimeMs = null,
  albumSynthesized = 0, titleSynthesized = 0,
}) {
  const now = Date.now();
  // Computed here rather than by the caller so it can never drift from the
  // columns it folds, and so every writer (scanner, targeted rescan, tests) gets
  // it without having to remember.
  const dupKey = artist != null && title != null ? foldKey(artist, album, title) : null;
  db.prepare(`
    INSERT INTO local_tracks (
      path, artist, album, title, album_synthesized, title_synthesized, dup_key,
      duration_ms, track_number, disc, year, genre,
      has_cover_art, ext, size_bytes, mtime_ms, change_key, removed, added_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      artist = excluded.artist,
      album = excluded.album,
      title = excluded.title,
      album_synthesized = excluded.album_synthesized,
      title_synthesized = excluded.title_synthesized,
      dup_key = excluded.dup_key,
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
    durationMs, trackNumber, disc, year, genre,
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

// One aggregate query rather than four separate ones. This runs after every
// scan, every targeted rescan, and every single-file reindex (i.e. after every
// tag fix), and node:sqlite is synchronous — so each extra pass over the table is
// event-loop time the whole process spends blocked.
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

// Permanently deletes rows for files that have been gone since before `olderThan`.
// `removed = 1` is a tombstone so a temporarily-unavailable file (unmounted
// volume, a rename in progress) isn't forgotten and re-added as brand new — but
// nothing ever cleared them, so a library that has seen a lot of churn keeps
// paying for them in every scan's getChangeKeys() and every COUNT.
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

// Sort keys are resolved through these maps rather than interpolated, so an
// arbitrary ?sort= value can never reach the SQL. Unknown keys fall back to an
// explicitly named default instead of throwing — a stale bookmark shouldn't 500.
// The fallback is named rather than "whichever key was declared first", so
// reordering a map can't silently change the default sort.
function orderBy(map, sort, fallbackKey) {
  return map[sort] ?? map[fallbackKey];
}

// ASCII 31 (unit separator), constructed rather than written as a literal so no
// invisible control character ends up in the source — the same separator, for the
// same reason, as client/src/lib/albumKey.js and recomputeStats' char(31).
const UNIT_SEPARATOR = String.fromCharCode(31);

// Case-insensitive grouping key. SQLite's built-in LOWER() folds ASCII only, so
// anything that groups rows must not mix it with JavaScript's toLowerCase() —
// the two disagree the moment an artist is called "Ärzte", and a group keyed one
// way then queried the other comes back empty. Folding happens here, in JS, once.

function foldKey(...parts) {
  return parts.map((p) => String(p ?? '').toLowerCase()).join(UNIT_SEPARATOR);
}

const ARTIST_SORTS = {
  name: 'artist COLLATE NOCASE',
  tracks: 'trackCount DESC, artist COLLATE NOCASE',
  albums: 'albumCount DESC, artist COLLATE NOCASE',
  duration: 'totalDurationMs DESC, artist COLLATE NOCASE',
};

// Paged, for the reason listTracks is paged: a serious collection has thousands
// of artists, and sending all of them so the browser can filter is a multi-
// megabyte response on every page load. `q` filters server-side so that search
// doesn't need the whole list either.
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

// Just the distinct artist names, for the "do I already own them" checks.
//
// Discovery was calling listArtists({ limit: 100000 }) for this — three times
// per /recommendations request, each one a grouped aggregate computing track
// counts, album counts and summed durations that were thrown away a line later
// in favour of the name column. This is the query that was actually wanted.
export function listArtistNames(db) {
  return db.prepare(
    'SELECT DISTINCT artist FROM local_tracks WHERE removed = 0 AND artist IS NOT NULL'
  ).all().map((r) => r.artist);
}

const ALBUM_SORTS = {
  artist: 'artist COLLATE NOCASE, year, album COLLATE NOCASE',
  album: 'album COLLATE NOCASE, artist COLLATE NOCASE',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE',
  tracks: 'trackCount DESC, artist COLLATE NOCASE',
  added: 'addedAt DESC, artist COLLATE NOCASE',
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

// Escapes the LIKE wildcards, so searching for "50%" isn't a match-everything.
function likeFor(q) {
  return `%${String(q).replace(/[%_\\]/g, '\\$&')}%`;
}

const TRACK_SORTS = {
  title: 'title COLLATE NOCASE',
  artist: 'artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number',
  album: 'album COLLATE NOCASE, disc, track_number, title COLLATE NOCASE',
  duration: 'duration_ms IS NULL, duration_ms DESC',
  year: 'year IS NULL, year DESC, artist COLLATE NOCASE',
  added: 'added_at DESC',
};

// The absolute path is deliberately not in here.
//
// paths.js refuses to put the server's directory layout in an error message on
// the grounds that it "isn't the client's business", and then every track in
// every browse listing carried it anyway — so the rule was being enforced on the
// one response nobody reads and ignored on the tens of thousands of rows that go
// out on every page load. Browsing doesn't need it: the player streams by id,
// the cover loads by id, and nothing in the tracks or album views renders it.
const TRACK_COLUMNS = `
  id, artist, album, title, duration_ms AS durationMs, track_number AS trackNumber,
  disc, year, genre, has_cover_art AS hasCoverArt, ext, size_bytes AS sizeBytes,
  added_at AS addedAt,
  album_synthesized AS albumSynthesized, title_synthesized AS titleSynthesized
`;

// For the flows whose entire job is identifying a file on disk — the repair
// paths, the Health report (which shows the path precisely because the tags that
// would otherwise name the file are missing), and the duplicates view (where
// choosing which copy to keep is the whole task) — plus the server-internal
// lookups that need a path to open. Opt-in, so adding a new listing endpoint
// doesn't leak paths by default.
const TRACK_COLUMNS_WITH_PATH = `${TRACK_COLUMNS}, path`;

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

// Whether this exact artist is in the collection under its own name. Used by
// credit-string resolution as its safety check: a joined credit is only ever
// collapsed onto a primary artist you demonstrably already have, which is what
// stops "Florence + The Machine" being linked to an unrelated artist named
// "Florence". Deliberately an exact (case-folded) match, not a LIKE — a fuzzy
// test here would reintroduce the guessing this is meant to prevent.
export function artistExists(db, artist) {
  if (!artist) return false;
  return db.prepare(
    'SELECT 1 FROM local_tracks WHERE removed = 0 AND artist = ? COLLATE NOCASE LIMIT 1'
  ).get(artist) !== undefined;
}

// The same album, but selected the way bulk repair needs it. getAlbumTracks
// can't be reused: it matches `artist = ?`, and SQL never matches NULL by
// equality, so an album whose files carry no artist tag comes back empty — and
// those are exactly the files bulk repair exists for. listAlbums groups a
// missing artist as its own album, so this mirrors that grouping.
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

// Albums that look incomplete judged purely on what's on disk — no upstream
// call, so this stays available when MusicBrainz doesn't. Three separate
// signals, ranked by how confident we can be:
//   gaps       - numbered holes in 1..max, e.g. {1,2,3,5,6} is missing 4
//   single     - a lone track filed as an album (usually a stray download)
//   unnumbered - no track numbers at all, so completeness is unknowable
//
// Two queries in total, not one per album: this runs on every visit to the
// Library page, node:sqlite is synchronous, and a query per album meant a
// thousand-album collection blocked the event loop a thousand times to open a
// tab. The track numbers come back in one pass and are grouped here.
// Matches the clamp in libraryScanner.rowFor. Kept as its own constant here
// rather than imported: this module is deliberately SQL-only and importing the
// scanner would close a cycle (the scanner imports this file).
const MAX_TRACK_POSITION = 999;

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

  // Grouped on the same (artist, album) values the query above grouped on, so
  // the two agree by construction.
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
    // Bounded independently of what the tags claim. rowFor already clamps track
    // numbers on the way in, but this loop allocates one array element per
    // position and runs on the synchronous main thread, so it does not get to
    // depend on an upstream guarantee: a row written before that clamp existed,
    // or by any future path that bypasses rowFor, would otherwise turn one bad
    // ID3 frame into a RangeError on the endpoint the Library page opens with.
    const highest = Math.min(a.maxTrackNumber ?? 0, MAX_TRACK_POSITION);
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

// The predicate behind each Health count, and the one used to list the tracks
// behind it. Declared once: the counts and the drill-down have to agree, and when
// these were written out twice a change to one silently disagreed with the other
// (badge says 12, list shows 8). Whitelisted the same way as the sort maps — the
// client sends a key, never SQL.
// The album/title predicates test the synthesized flags, not NULL. The scanner
// fills both columns unconditionally — falling back to the folder name and the
// filename — so `album IS NULL` matched no row the scanner had ever written, and
// these two counts read zero on every install regardless of how many untagged
// files it held. The NULL half of each is kept for rows written by anything that
// doesn't go through rowFor (tests, future importers).
const HEALTH_ISSUES = {
  missingArtist: 'artist IS NULL',
  missingAlbum: '(album IS NULL OR album_synthesized = 1)',
  missingTitle: '(title IS NULL OR title_synthesized = 1)',
  missingTrackNumber: 'track_number IS NULL',
  missingDuration: 'duration_ms IS NULL',
  noCoverArt: 'has_cover_art = 0',
};

// Tagging problems that make the rest of the library (and gap detection in
// particular) misbehave. All pure SQL, all served by the partial indexes in db.js.
export function findHealthIssues(db) {
  const count = (sql) => db.prepare(`SELECT COUNT(*) c FROM local_tracks WHERE removed = 0 AND ${sql}`).get().c;
  const counts = Object.fromEntries(
    Object.entries(HEALTH_ISSUES).map(([key, sql]) => [key, count(sql)]),
  );
  // Just the number here — this endpoint loads with the page, and the copies
  // themselves are only needed by the duplicates view, which fetches them itself.
  // Counted over the same dup_key findDuplicateGroups groups by, so the count on
  // the Health tab always matches the view it links to.
  return { ...counts, duplicateCount: duplicateGroupCount(db) };
}

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
    SELECT ${TRACK_COLUMNS_WITH_PATH} FROM local_tracks WHERE ${where}
    ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc, track_number, path
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { tracks, total };
}

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
// The GROUP BY behind both the count and the listing. dup_key is the folded
// "artist␟album␟title", computed in JS on write (see upsertLocalTrack) precisely
// so this can be a SQL grouping — SQLite's LOWER() and JavaScript's
// toLowerCase() disagree on anything non-ASCII, so folding has to happen once,
// in one language, and be stored.
const DUPLICATE_KEYS_SQL = `
  SELECT dup_key FROM local_tracks
  WHERE removed = 0 AND dup_key IS NOT NULL
  GROUP BY dup_key HAVING COUNT(*) > 1
`;

// Just how many duplicate groups there are.
//
// findHealthIssues needs this number and nothing else, and it used to get it by
// materializing every live track in the library — every column, paths included —
// into JS, building a Map of folded keys, and reading .length off the result.
// That ran synchronously on every Library page load. This is the query that was
// actually wanted.
function duplicateGroupCount(db) {
  return db.prepare(`SELECT COUNT(*) c FROM (${DUPLICATE_KEYS_SQL})`).get().c;
}

// Every copy of each duplicated key. Only the rows that are actually part of a
// duplicate group are fetched — the previous version loaded the whole table and
// then discarded the ~99% of it that had no duplicate.
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

// Every copy of each duplicated artist/album/title, so they can be compared
// field by field. findHealthIssues only counts them; deciding which copy to keep
// needs the paths, formats, sizes and durations side by side.
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
