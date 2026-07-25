import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { verifyTrack } from './verifyTrack.js';
import { getDb } from '../lib/db.js';
import { listArtistTitles } from './libraryRepo.js';
import { NotFoundError } from '../lib/httpErrors.js';
import { normalizeTitle } from '../lib/normalize.js';

// verify: when false, missing tracks come back without a YouTube lookup. That
// matters because verifying is one yt-dlp call per missing track at ~1 req/s —
// fine as an explicit action, far too slow for a panel that opens on click.
// The client can then verify individual tracks with the existing VerifyButton.
//
// onMissing/signal exist for the streaming route: with verify on, each missing
// track takes about a second, so the caller needs results as they land and a way
// to abort when the client disconnects rather than a single long-held request.
export async function detectAlbumGaps(releaseGroupMbid, {
  verify = true, onMissing, signal,
} = {}) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) throw new NotFoundError('No release found for this release group');

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  const db = getDb();
  // One query for the artist's owned titles, normalized, instead of an exact
  // match per track — catches "Song (Remastered)" as owning "Song".
  const ownedTitles = new Set(listArtistTitles(db, release.artist).map(normalizeTitle));
  const owned = [];
  const missing = [];

  const album = { mbid: releaseGroupMbid, title: release.title, artist: release.artist };
  const record = (entry) => {
    missing.push(entry);
    onMissing?.(entry);
  };

  for (const track of tracks) {
    if (signal?.aborted) break;
    if (ownedTitles.has(normalizeTitle(track.title))) {
      owned.push({ position: track.position, title: track.title });
      continue;
    }
    if (track.lengthMs == null) {
      record({ position: track.position, title: track.title, lengthMs: null, status: 'no_length', video: null, deltaSeconds: null });
      continue;
    }
    if (!verify) {
      record({ position: track.position, title: track.title, lengthMs: track.lengthMs, status: 'unchecked', video: null, deltaSeconds: null });
      continue;
    }
    const verified = await verifyTrack({ artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs });
    record({ position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
  }

  return { album, owned, missing };
}
