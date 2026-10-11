import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { verifyRecording } from './verifiedLinks.js';
import { recordHistory } from './verifyHistory.js';
import { getDb } from '../lib/db.js';
import { listArtistTitles, getAlbumTracks } from './libraryRepo.js';
import { NotFoundError } from '../lib/httpErrors.js';
import { normalizeTitle } from '../lib/normalize.js';

// Diffs a MusicBrainz tracklist against disk. verify=false skips the ~1 req/s YouTube
// lookups; onMissing/signal let the streaming route emit results and abort.
export async function detectAlbumGaps(releaseGroupMbid, {
  verify = true, onMissing, signal, localArtist, localAlbum,
} = {}) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) throw new NotFoundError('No release found for this release group');

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  const db = getDb();
  // Prefer the local album's tracklist: MusicBrainz's joined credit may match no
  // local artist tag, and a greatest-hits copy shouldn't count as owned here.
  const ownedTitles = new Set(
    (localAlbum
      ? getAlbumTracks(db, { artist: localArtist, album: localAlbum }).map((t) => t.title)
      : listArtistTitles(db, localArtist ?? release.artist)
    ).filter(Boolean).map(normalizeTitle),
  );
  const owned = [];
  const missing = [];

  const album = { mbid: releaseGroupMbid, title: release.title, artist: release.artist };
  // Every entry carries recordingMbid so a later per-row verify can persist its answer.
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
      record({ position: track.position, title: track.title, lengthMs: null, recordingMbid: track.recordingMbid, status: 'no_length', video: null, deltaSeconds: null });
      continue;
    }
    if (!verify) {
      record({ position: track.position, title: track.title, lengthMs: track.lengthMs, recordingMbid: track.recordingMbid, status: 'unchecked', video: null, deltaSeconds: null });
      continue;
    }
    // verifyRecording persists across restarts; verifyTrack's cache is memory-only.
    const verified = await verifyRecording({
      recordingMbid: track.recordingMbid,
      artist: release.artist,
      title: track.title,
      album: release.title,
      lengthMs: track.lengthMs,
    });
    recordHistory({
      recordingMbid: track.recordingMbid, artist: release.artist, title: track.title, album: release.title,
      action: 'verified', status: verified.status, videoId: verified.video?.id,
    });
    record({ position: track.position, title: track.title, lengthMs: track.lengthMs, recordingMbid: track.recordingMbid, ...verified });
  }

  return { album, owned, missing };
}
