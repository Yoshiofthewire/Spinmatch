// server/test/libraryRepo.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');
const repo = await import('../src/services/libraryRepo.js');

function seeded() {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One', durationMs: 1000, changeKey: '10:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Album/02.mp3', artist: 'A', album: 'Album', title: 'Two', durationMs: 2000, changeKey: '20:1' });
  repo.upsertLocalTrack(db, { path: '/m/B/Other/01.mp3', artist: 'B', album: 'Other', title: 'Solo', durationMs: 3000, changeKey: '30:1' });
  repo.recomputeStats(db);
  return db;
}

test('stats reflect distinct artists and albums', () => {
  const db = seeded();
  const stats = repo.getStats(db);
  assert.equal(stats.totalTracks, 3);
  assert.equal(stats.totalAlbums, 2);
  assert.equal(stats.totalArtists, 2);
  assert.equal(stats.totalDurationMs, 6000);
  assert.ok(stats.lastScanAt > 0);
  db.close();
});

test('upsert on the same path updates rather than duplicates', () => {
  const db = seeded();
  repo.upsertLocalTrack(db, { path: '/m/A/Album/01.mp3', artist: 'A', album: 'Album', title: 'One (remaster)', durationMs: 1100, changeKey: '11:2' });
  repo.recomputeStats(db);
  assert.equal(repo.getStats(db).totalTracks, 3);
  const { tracks } = repo.listTracks(db, { artist: 'A', album: 'Album' });
  assert.ok(tracks.some((r) => r.title === 'One (remaster)'));
  assert.ok(!tracks.some((r) => r.title === 'One'), 'the old row was updated, not kept alongside');
  db.close();
});

test('markRemoved drops rows absent from the keep set and stats update', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3', '/m/A/Album/02.mp3']));
  repo.recomputeStats(db);
  const stats = repo.getStats(db);
  assert.equal(stats.totalTracks, 2);
  assert.equal(stats.totalArtists, 1);
  db.close();
});

test('hasRecording matches artist+title case-insensitively, ignoring removed rows', () => {
  const db = seeded();
  assert.equal(repo.hasRecording(db, { artist: 'a', title: 'one' }), true);
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Nope' }), false);
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3', '/m/B/Other/01.mp3']));
  assert.equal(repo.hasRecording(db, { artist: 'A', title: 'Two' }), false);
  db.close();
});

test('a track with a NULL artist but a non-null album still counts toward total_albums', () => {
  const db = seeded();
  repo.upsertLocalTrack(db, { path: '/m/Unknown/Comp/01.mp3', artist: null, album: 'Comp', title: 'Mystery', durationMs: 1500, changeKey: '40:1' });
  repo.recomputeStats(db);
  const stats = repo.getStats(db);
  assert.equal(stats.totalTracks, 4);
  // 2 prior distinct albums (A/Album, B/Other) + this new one = 3.
  assert.equal(stats.totalAlbums, 3);
  db.close();
});

test('findIncompleteAlbums reports numbered holes in an album', () => {
  const db = openDb(':memory:');
  // Tracks 1, 2, 4 of a 4-track album: 3 is missing.
  for (const [n, title] of [[1, 'One'], [2, 'Two'], [4, 'Four']]) {
    repo.upsertLocalTrack(db, {
      path: `/m/A/Al/0${n}.mp3`, artist: 'A', album: 'Al', title,
      durationMs: 1000, changeKey: `${n}:1`, trackNumber: n,
    });
  }
  const [album] = repo.findIncompleteAlbums(db);
  assert.equal(album.reason, 'gaps');
  assert.deepEqual(album.missingPositions, [3]);
  db.close();
});

test('findIncompleteAlbums flags a complete album as fine', () => {
  const db = openDb(':memory:');
  for (const n of [1, 2, 3]) {
    repo.upsertLocalTrack(db, {
      path: `/m/A/Al/0${n}.mp3`, artist: 'A', album: 'Al', title: `T${n}`,
      durationMs: 1000, changeKey: `${n}:1`, trackNumber: n,
    });
  }
  assert.deepEqual(repo.findIncompleteAlbums(db), []);
  db.close();
});

test('findIncompleteAlbums separates unnumbered albums from real gaps', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/A/Untagged/x.mp3', artist: 'A', album: 'Untagged', title: 'X',
    durationMs: 1000, changeKey: '1:1', trackNumber: null,
  });
  repo.upsertLocalTrack(db, {
    path: '/m/B/Gappy/02.mp3', artist: 'B', album: 'Gappy', title: 'Two',
    durationMs: 1000, changeKey: '2:1', trackNumber: 2,
  });
  const found = repo.findIncompleteAlbums(db);
  // Real gaps rank ahead of the unknowable ones.
  assert.equal(found[0].reason, 'gaps');
  assert.deepEqual(found[0].missingPositions, [1]);
  assert.equal(found[1].reason, 'unnumbered');
  db.close();
});

test('albums of the same name by different artists are not merged', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: '/m/A/Greatest/01.mp3', artist: 'A', album: 'Greatest Hits', title: 'A1',
    durationMs: 1000, changeKey: '1:1', trackNumber: 1,
  });
  repo.upsertLocalTrack(db, {
    path: '/m/B/Greatest/02.mp3', artist: 'B', album: 'Greatest Hits', title: 'B2',
    durationMs: 1000, changeKey: '2:1', trackNumber: 2,
  });
  // B is missing #1; A is a single-track album. If the two were grouped
  // together as one "Greatest Hits" they'd look complete ({1,2}).
  const found = repo.findIncompleteAlbums(db);
  assert.equal(found.length, 2);
  const b = found.find((f) => f.artist === 'B');
  assert.deepEqual(b.missingPositions, [1]);
  db.close();
});

test('findHealthIssues counts missing tags and duplicate recordings', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'a', album: 'Other', title: 'dup', durationMs: 1000, changeKey: '2:1' });
  repo.upsertLocalTrack(db, { path: '/m/3.mp3', artist: null, album: null, title: 'Orphan', durationMs: null, changeKey: '3:1' });
  const health = repo.findHealthIssues(db);
  assert.equal(health.missingArtist, 1);
  assert.equal(health.missingAlbum, 1);
  assert.equal(health.missingDuration, 1);
  assert.equal(health.missingTrackNumber, 3);
  // Case-insensitive grouping catches "A/Dup" vs "a/dup".
  assert.equal(health.duplicateCount, 1);
  db.close();
});

test('findDuplicateGroups returns every copy so they can be compared', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.flac', artist: 'A', album: 'Al', title: 'Dup', durationMs: 1000, changeKey: '1:1', ext: 'flac', sizeBytes: 900 });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'a', album: 'Other', title: 'dup', durationMs: 1000, changeKey: '2:1', ext: 'mp3', sizeBytes: 100 });
  repo.upsertLocalTrack(db, { path: '/m/3.mp3', artist: 'A', album: 'Al', title: 'Unique', durationMs: 1000, changeKey: '3:1' });

  const groups = repo.findDuplicateGroups(db);
  assert.equal(groups.length, 1, 'only the duplicated title is a group');
  assert.equal(groups[0].copies.length, 2);
  // The formats and sizes are the point: they're how you tell which copy to keep.
  assert.deepEqual(groups[0].copies.map((c) => c.ext).sort(), ['flac', 'mp3']);
  assert.ok(groups[0].copies.every((c) => c.path));
  db.close();
});

// Regression: grouping used SQLite's LOWER() but re-queried the copies with
// JavaScript's toLowerCase(). SQLite's built-in LOWER() folds ASCII only, so for
// any non-ASCII artist or title the two disagreed and the group came back with
// zero copies — the Duplicates tab rendered a header over an empty table.
test('findDuplicateGroups finds the copies for non-ASCII artists and titles', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.flac', artist: 'ÄRZTE', album: 'Al', title: 'Über', durationMs: 1000, changeKey: '1:1', ext: 'flac', sizeBytes: 900 });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'ärzte', album: 'Other', title: 'über', durationMs: 1000, changeKey: '2:1', ext: 'mp3', sizeBytes: 100 });

  const groups = repo.findDuplicateGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies.length, 2, 'both copies must be listed, not zero');
  assert.deepEqual(groups[0].copies.map((c) => c.ext).sort(), ['flac', 'mp3']);
  // And the count on the Health tab has to agree with the view it links to.
  assert.equal(repo.findHealthIssues(db).duplicateCount, 1);
  db.close();
});

test('listHealthTracks returns the tracks behind a count and rejects unknown issues', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'A', album: 'Al', title: 'Has all', durationMs: 1000, changeKey: '1:1', trackNumber: 1 });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: null, album: 'Al', title: 'No artist', durationMs: 1000, changeKey: '2:1', trackNumber: 2 });

  const result = repo.listHealthTracks(db, { issue: 'missingArtist' });
  assert.equal(result.total, 1);
  assert.equal(result.tracks[0].title, 'No artist');
  assert.ok(result.tracks[0].path, 'the path is needed to identify an untagged file');

  // An unknown key must not fall through to unfiltered SQL.
  assert.deepEqual(repo.listHealthTracks(db, { issue: 'artist IS NULL' }), { tracks: [], total: 0 });
  assert.equal(repo.isHealthIssue('missingArtist'), true);
  assert.equal(repo.isHealthIssue('nope'), false);
  db.close();
});

test('listTrackPaths scopes to one album', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/A/One/01.mp3', artist: 'A', album: 'One', title: 'a', durationMs: 1, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/A/Two/01.mp3', artist: 'A', album: 'Two', title: 'b', durationMs: 1, changeKey: '2:1' });

  assert.deepEqual(repo.listTrackPaths(db, { artist: 'A', album: 'One' }), ['/m/A/One/01.mp3']);
  assert.equal(repo.listTrackPaths(db, { artist: 'A' }).length, 2);
  db.close();
});

test('listTracks pages and reports the unpaged total', () => {
  const db = seeded();
  const page = repo.listTracks(db, { limit: 2, offset: 0, sort: 'title' });
  assert.equal(page.tracks.length, 2);
  assert.equal(page.total, 3);
  const rest = repo.listTracks(db, { limit: 2, offset: 2, sort: 'title' });
  assert.equal(rest.tracks.length, 1);
});

test('a search for a literal % is not treated as a wildcard', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'A', album: 'Al', title: '50% Off', durationMs: 1, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'A', album: 'Al', title: 'Nothing', durationMs: 1, changeKey: '2:1' });
  assert.equal(repo.listTracks(db, { q: '50%' }).total, 1);
  // Escaped, so this matches only the title that literally contains "%".
  // Treated as a wildcard it would have matched both rows.
  assert.equal(repo.listTracks(db, { q: '%' }).total, 1);
  assert.equal(repo.listTracks(db, { q: '_' }).total, 0);
  db.close();
});

test('getChangeKeys returns path->key for live rows only', () => {
  const db = seeded();
  repo.markRemoved(db, new Set(['/m/A/Album/01.mp3']));
  const keys = repo.getChangeKeys(db);
  assert.equal(keys.get('/m/A/Album/01.mp3'), '10:1');
  assert.equal(keys.has('/m/B/Other/01.mp3'), false);
  db.close();
});

// Artists and albums used to be returned whole so the browser could filter them.
// For a real collection that's a multi-megabyte response on every page load.
test('listArtists and listAlbums page and report the unpaged total', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i += 1) {
    repo.upsertLocalTrack(db, {
      path: `/m/${i}.mp3`, artist: `Artist ${i}`, album: `Album ${i}`,
      title: `T${i}`, durationMs: 1000, changeKey: `${i}:1`,
    });
  }

  const artists = repo.listArtists(db, { limit: 2, offset: 0 });
  assert.equal(artists.total, 5);
  assert.equal(artists.artists.length, 2);
  assert.equal(repo.listArtists(db, { limit: 2, offset: 4 }).artists.length, 1);

  const albums = repo.listAlbums(db, { limit: 3, offset: 0 });
  assert.equal(albums.total, 5);
  assert.equal(albums.albums.length, 3);

  // Server-side filtering, so search doesn't need the whole list either.
  assert.equal(repo.listArtists(db, { q: 'Artist 3' }).total, 1);
  assert.equal(repo.listAlbums(db, { q: 'Album 3' }).total, 1);
  db.close();
});

// An unknown ?sort= must not reach the SQL, and must not produce ORDER BY
// undefined either — it falls back to a named default.
test('an unknown sort key falls back to the default ordering', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/1.mp3', artist: 'B', album: 'Al', title: 'x', durationMs: 1, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/2.mp3', artist: 'A', album: 'Al', title: 'y', durationMs: 1, changeKey: '2:1' });
  assert.deepEqual(
    repo.listArtists(db, { sort: 'nonsense; DROP TABLE local_tracks' }).artists.map((a) => a.artist),
    ['A', 'B'],
  );
  assert.equal(repo.listAlbums(db, { sort: 'nope' }).albums.length, 2);
  assert.equal(repo.listTracks(db, { sort: 'nope' }).tracks.length, 2);
  db.close();
});

// `removed = 1` is a tombstone so a file on a temporarily-unavailable volume
// isn't forgotten and re-added as new. Nothing ever cleared them, so a churning
// library kept paying for them in every scan and every COUNT.
test('purgeRemoved deletes only long-gone tombstones', () => {
  const db = openDb(':memory:');
  repo.upsertLocalTrack(db, { path: '/m/gone.mp3', artist: 'A', album: 'Al', title: 'Gone', durationMs: 1, changeKey: '1:1' });
  repo.upsertLocalTrack(db, { path: '/m/here.mp3', artist: 'A', album: 'Al', title: 'Here', durationMs: 1, changeKey: '2:1' });
  repo.markRemoved(db, new Set(['/m/here.mp3']));

  // Just removed: still a tombstone, still protected.
  assert.equal(repo.purgeRemoved(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM local_tracks').get().c, 2);

  // Backdate it past the window.
  db.prepare("UPDATE local_tracks SET updated_at = 0 WHERE path = '/m/gone.mp3'").run();
  assert.equal(repo.purgeRemoved(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM local_tracks').get().c, 1);
  // A live row is never touched.
  assert.equal(db.prepare('SELECT path FROM local_tracks').get().path, '/m/here.mp3');
  db.close();
});
