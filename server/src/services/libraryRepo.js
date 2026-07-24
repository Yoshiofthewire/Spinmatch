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
