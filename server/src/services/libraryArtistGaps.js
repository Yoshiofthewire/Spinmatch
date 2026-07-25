import { getDb } from '../lib/db.js';
import { getArtistDiscography } from './libraryDiscography.js';
import { detectAlbumGaps } from './libraryGaps.js';

// How many albums may fail back-to-back before the run is treated as broken
// rather than unlucky. Three is enough to distinguish one bad release group from
// a missing yt-dlp binary, which fails every album identically.
const MAX_CONSECUTIVE_ERRORS = 3;

// The whole-artist counterpart to detectAlbumGaps: every album of theirs you
// don't have, every track on those albums, looked up on YouTube in one run.
//
// Its own module rather than a function on either neighbour because it needs
// both — libraryDiscography for which albums are missing, libraryGaps for what's
// on each one — and libraryDiscography already imports libraryGaps, so putting
// it in the latter would close a cycle.
//
// Ownership is still judged per track, not per album: detectAlbumGaps is given
// `localArtist` and no `localAlbum`, so it compares against every title you have
// by that artist. An album you don't own as an album, but whose tracks you
// already have off a compilation, correctly reports few or no gaps.

/**
 * @param {string} artist  the artist as tagged locally
 * @param {object} [options]
 * @param {(event: string, data: object) => void} [options.onEvent]  'album' | 'result'
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{artist, unresolved: boolean, albums: number, missing: number}>}
 */
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

    // Announced before the tracklist is fetched, so the client can show which
    // record is being worked on during the pause rather than after it. The
    // grand total isn't known here and deliberately isn't guessed: it would take
    // a full second pass over every tracklist to compute, which is the same cost
    // again as the run itself.
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
      // A rate limit has to stop the whole sweep — the next album would hit the
      // same wall — but one album with no usable release shouldn't end a run
      // over twenty others, so that is reported and stepped past.
      if (err.code === 'RATE_LIMITED') throw err;
      onEvent?.('album_error', { mbid: album.mbid, title: album.title, message: err.message });

      // Something systemic (yt-dlp missing, upstream down) fails every album
      // identically, and reporting it once per record is noise standing in for
      // one clear failure. A run of consecutive errors is that signal; an
      // isolated bad release group isn't, so the counter resets on success.
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw err;
      continue;
    }
    consecutiveErrors = 0;
  }

  return { artist, unresolved: false, albums: albums.length, missing };
}
