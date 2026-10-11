import { getDb, withTransaction } from '../lib/db.js';
import { makeMatchKey, makeTitleKey } from '../lib/normalize.js';

// Playlists and the resolution of their items to files; sole owner of the playlist schema.
// Items store text, not track ids (see db.js), so every read resolves in two indexed queries.

const TRACK_COLUMNS = `
  id, path, artist, album, title,
  duration_ms AS durationMs, size_bytes AS sizeBytes, ext, year,
  track_number AS trackNumber, match_key AS matchKey, title_key AS titleKey
`;

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// Among copies of one key: the named album, then the biggest file. Shared with
// playlistDiscovery so both resolve duplicates the same way.
export function preferBest(candidates, album) {
  const wanted = album ? makeTitleKey(album) : null;
  const byAlbum = wanted
    ? candidates.filter((t) => makeTitleKey(t.album) === wanted)
    : [];
  const pool = byAlbum.length ? byAlbum : candidates;
  return pool.reduce((best, t) => (
    (t.sizeBytes ?? 0) > (best.sizeBytes ?? 0) ? t : best
  ), pool[0]);
}

// Attaches a local track (or null) to each item. Misses fall back to title alone,
// so "The Beatles" vs "Beatles" still resolves.
export function resolveItems(db, allItems) {
  // Unmatchable items (display text only) are always gaps.
  const items = allItems.filter((i) => i.matchable !== 0);
  if (!items.length) return allItems.map((item) => ({ ...item, track: null }));

  const matchKeys = [...new Set(items.map((i) => i.matchKey))];
  const byMatch = new Map();
  for (const row of db.prepare(
    `SELECT ${TRACK_COLUMNS} FROM local_tracks
     WHERE removed = 0 AND match_key IN (${placeholders(matchKeys.length)})`
  ).all(...matchKeys)) {
    if (!byMatch.has(row.matchKey)) byMatch.set(row.matchKey, []);
    byMatch.get(row.matchKey).push(row);
  }

  const missedTitleKeys = [...new Set(
    items.filter((i) => !byMatch.has(i.matchKey)).map((i) => i.titleKey)
  )];
  const byTitle = new Map();
  if (missedTitleKeys.length) {
    for (const row of db.prepare(
      `SELECT ${TRACK_COLUMNS} FROM local_tracks
       WHERE removed = 0 AND title_key IN (${placeholders(missedTitleKeys.length)})`
    ).all(...missedTitleKeys)) {
      if (!byTitle.has(row.titleKey)) byTitle.set(row.titleKey, []);
      byTitle.get(row.titleKey).push(row);
    }
  }

  return allItems.map((item) => {
    if (item.matchable === 0) return { ...item, track: null };
    const candidates = byMatch.get(item.matchKey) ?? byTitle.get(item.titleKey) ?? [];
    return { ...item, track: candidates.length ? preferBest(candidates, item.album) : null };
  });
}

export function createPlaylist(db = getDb(), { name }) {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO playlists (name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(name, name.toLowerCase(), now, now);
  return { id: Number(info.lastInsertRowid), name, createdAt: now };
}

const ITEM_COLUMNS = `
  id, position, artist, title, album,
  match_key AS matchKey, title_key AS titleKey,
  source, seed_artist AS seedArtist, matchable
`;

export function getPlaylist(db, id) {
  const row = db.prepare(
    'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt, '
    + 'last_exported_at AS lastExportedAt, last_export_dir AS lastExportDir '
    + 'FROM playlists WHERE id = ?'
  ).get(id);
  if (!row) return null;
  const items = db.prepare(
    `SELECT ${ITEM_COLUMNS} FROM playlist_items WHERE playlist_id = ? ORDER BY position`
  ).all(id);
  return { ...row, items: resolveItems(db, items) };
}

export function listPlaylists(db) {
  const rows = db.prepare(
    'SELECT id, name, last_exported_at AS lastExportedAt FROM playlists ORDER BY updated_at DESC'
  ).all();
  // Per playlist, not a JOIN: a JOIN on match_key double-counts duplicate copies.
  return rows.map((row) => {
    const items = db.prepare(
      `SELECT ${ITEM_COLUMNS} FROM playlist_items WHERE playlist_id = ? ORDER BY position`
    ).all(row.id);
    const resolved = resolveItems(db, items);
    return {
      ...row,
      itemCount: resolved.length,
      gapCount: resolved.filter((i) => !i.track).length,
      totalBytes: resolved.reduce((sum, i) => sum + (i.track?.sizeBytes ?? 0), 0),
    };
  });
}

export function renamePlaylist(db, id, name) {
  db.prepare('UPDATE playlists SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
    .run(name, name.toLowerCase(), Date.now(), id);
}

export function deletePlaylist(db, id) {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
}

// The playlist last exported to this folder. Two names can sanitize to one folder
// ("Mix: 2024", "Mix 2024"), so export checks this before replacing.
export function findPlaylistByExportDir(db, dir, { excludeId = null } = {}) {
  return db.prepare(
    'SELECT id, name FROM playlists WHERE last_export_dir = ? AND id IS NOT ?'
  ).get(dir, excludeId) ?? null;
}

export function noteExport(db, id, dir) {
  db.prepare('UPDATE playlists SET last_exported_at = ?, last_export_dir = ? WHERE id = ?')
    .run(Date.now(), dir, id);
}

export function addItems(db, playlistId, items) {
  const now = Date.now();
  const next = db.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM playlist_items WHERE playlist_id = ?'
  ).get(playlistId).next;

  const insert = db.prepare(`
    INSERT INTO playlist_items
      (playlist_id, position, artist, title, album, match_key, title_key, source, seed_artist, added_at, matchable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  withTransaction(db, () => {
    items.forEach((item, i) => {
      insert.run(
        playlistId, next + i, item.artist ?? null, item.title, item.album ?? null,
        makeMatchKey(item.artist, item.title), makeTitleKey(item.title),
        item.source, item.seedArtist ?? null, now, item.matchable === false ? 0 : 1,
      );
    });
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
  });
  return { added: items.length };
}

export function removeItem(db, playlistId, itemId) {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?').run(playlistId, itemId);
  renumber(db, playlistId);
}

// Positions stay contiguous, rewritten wholesale; playlists are small enough.
function renumber(db, playlistId) {
  const ids = db.prepare(
    'SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position'
  ).all(playlistId).map((r) => r.id);
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  withTransaction(db, () => {
    ids.forEach((id, i) => update.run(i, id));
  });
}

export function reorderItems(db, playlistId, itemIds) {
  const owned = new Set(db.prepare(
    'SELECT id FROM playlist_items WHERE playlist_id = ?'
  ).all(playlistId).map((r) => r.id));
  // Unmentioned rows go to the end, so a stale client can't drop them.
  const ordered = itemIds.filter((id) => owned.has(id));
  const rest = [...owned].filter((id) => !ordered.includes(id));
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  withTransaction(db, () => {
    [...ordered, ...rest].forEach((id, i) => update.run(i, id));
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
  });
}
