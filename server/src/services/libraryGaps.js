import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { verifyTrack } from './verifyTrack.js';
import { getDb } from '../lib/db.js';
import { hasRecording } from './libraryRepo.js';
import { NotFoundError } from '../lib/httpErrors.js';

export async function detectAlbumGaps(releaseGroupMbid) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) throw new NotFoundError('No release found for this release group');

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  const db = getDb();
  const owned = [];
  const missing = [];

  for (const track of tracks) {
    if (hasRecording(db, { artist: release.artist, title: track.title })) {
      owned.push({ position: track.position, title: track.title });
      continue;
    }
    if (track.lengthMs == null) {
      missing.push({ position: track.position, title: track.title, lengthMs: null, status: 'no_length', video: null, deltaSeconds: null });
      continue;
    }
    const verified = await verifyTrack({ artist: release.artist, title: track.title, album: release.title, lengthMs: track.lengthMs });
    missing.push({ position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
  }

  return {
    album: { mbid: releaseGroupMbid, title: release.title, artist: release.artist },
    owned,
    missing,
  };
}
