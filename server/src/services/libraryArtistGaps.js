import { getDb } from '../lib/db.js';
import { getArtistDiscography } from './libraryDiscography.js';
import { detectAlbumGaps } from './libraryGaps.js';

// Consecutive album failures that mean "systemic" (e.g. yt-dlp missing), not one bad release.
const MAX_CONSECUTIVE_ERRORS = 3;

// Every missing track on every missing album of an artist. Separate module to avoid
// a libraryDiscography <-> libraryGaps cycle. Ownership is per track across the
// whole artist (no localAlbum), so compilation copies count as owned.
export async function sweepArtistMissing(artist, { onEvent, signal, db = getDb() } = {}) {
  const discography = await getArtistDiscography(artist, { db });
  if (discography.unresolved) {
    return { artist, unresolved: true, albums: 0, missing: 0 };
  }

  const albums = discography.missing;
  let missing = 0;
  let consecutiveErrors = 0;

  for (const [index, album] of albums.entries()) {
    if (signal?.aborted) break;

    // Announced before the fetch so the client shows progress during the wait.
    onEvent?.('album', {
      mbid: album.mbid,
      title: album.title,
      year: album.year,
      albumIndex: index + 1,
      albumCount: albums.length,
    });

    try {
      await detectAlbumGaps(album.mbid, {
        verify: true,
        signal,
        localArtist: artist,
        onMissing: (entry) => {
          missing += 1;
          onEvent?.('result', { ...entry, album: album.title, albumMbid: album.mbid });
        },
      });
    } catch (err) {
      // Rate limits stop the sweep; a single bad album is reported and skipped.
      if (err.code === 'RATE_LIMITED') throw err;
      onEvent?.('album_error', { mbid: album.mbid, title: album.title, message: err.message });

      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw err;
      continue;
    }
    consecutiveErrors = 0;
  }

  return { artist, unresolved: false, albums: albums.length, missing };
}
