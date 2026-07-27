import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { verifyRecording } from './verifiedLinks.js';
import { getDb } from '../lib/db.js';
import { listArtistTitles, getAlbumTracks } from './libraryRepo.js';
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
/**
 * Diffs a MusicBrainz tracklist against what's on disk.
 *
 * @param {string} releaseGroupMbid
 * @param {object} [options]
 * @param {boolean} [options.verify]  Look each missing track up on YouTube.
 * @param {(entry: object) => void} [options.onMissing]  Called per missing track as it lands.
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.localArtist]  The artist as tagged locally, which is
 *   not MusicBrainz's joined artist credit — see the ownership note below.
 * @param {string} [options.localAlbum]  Scopes ownership to one local album.
 * @returns {Promise<{album: object, owned: object[], missing: object[]}>}
 */
export async function detectAlbumGaps(releaseGroupMbid, {
  verify = true, onMissing, signal, localArtist, localAlbum,
} = {}) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) throw new NotFoundError('No release found for this release group');

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  const db = getDb();
  // Which local titles count as "owned" for this tracklist.
  //
  // `release.artist` is MusicBrainz's joined artist-credit string, which for a
  // collaboration or a split is something like "Danger MouseSparklehorse" and
  // matches no local artist tag at all — so scoping ownership to it reported
  // every track of such an album as missing. When the caller knows which local
  // album it is asking about (the per-album check does), compare against that
  // album's own tracklist: it's both correct for collaborations and narrower,
  // since a track also present on a greatest-hits shouldn't count as owned here.
  const ownedTitles = new Set(
    (localAlbum
      ? getAlbumTracks(db, { artist: localArtist, album: localAlbum }).map((t) => t.title)
      : listArtistTitles(db, localArtist ?? release.artist)
    ).filter(Boolean).map(normalizeTitle),
  );
  const owned = [];
  const missing = [];

  const album = { mbid: releaseGroupMbid, title: release.title, artist: release.artist };
  // Every missing entry carries its recordingMbid, including the ones no YouTube
  // lookup was made for. It is what lets a per-row "find on YouTube" click
  // persist its answer in verified_links rather than only caching it in memory —
  // the unverified entries are precisely the rows that get clicked later.
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
    // verifyRecording rather than verifyTrack: this is the one place that knows
    // which MusicBrainz recording a lookup is for, so it's the only place that
    // can remember the answer past a restart. A sweep across an artist is many
    // minutes of 1-req/s lookups, and verifyTrack's cache is in-memory only.
    const verified = await verifyRecording({
      recordingMbid: track.recordingMbid,
      artist: release.artist,
      title: track.title,
      album: release.title,
      lengthMs: track.lengthMs,
    });
    record({ position: track.position, title: track.title, lengthMs: track.lengthMs, recordingMbid: track.recordingMbid, ...verified });
  }

  return { album, owned, missing };
}
