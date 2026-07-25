import { getDb } from '../lib/db.js';
import { getTrackById } from './libraryRepo.js';
import { candidatesFromTags } from './tagMatch.js';
import { getRecording, resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { getFrontCoverImage } from './coverArt.js';
import { writeMissingTags } from './tags.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { NotFoundError } from '../lib/httpErrors.js';

// Repairing the tags of a file that is ALREADY in the library. Deliberately not
// the ingest flow: ingest identifies unknown files and moves them into place,
// whereas these files are already where they belong. Nothing here moves or
// renames anything — the only write is to the file's tags.

async function trackOrThrow(trackId) {
  const track = getTrackById(getDb(), trackId);
  if (!track) throw new NotFoundError('Track not found');
  // Same guard the cover and stream routes use: the path comes from our own
  // index, but it is still re-validated before we open the file for writing.
  const real = await assertReadableInsideMusicDir(track.path);
  return { track, real };
}

// MusicBrainz recordings that plausibly match the file, for a human to pick
// from. Reuses the ingest picker's candidate source, which searches on whatever
// tags the file does carry — the useful case being a file that has an artist and
// title but no album, year, or number.
export async function getFixCandidates(trackId) {
  const { track, real } = await trackOrThrow(trackId);
  const { candidates } = await candidatesFromTags(real);
  return { track, candidates };
}

// Where this recording sits on its release, so a missing track/disc number can
// be filled too — that's the Health count the Overview chip surfaces, and the
// one that actually breaks gap detection. Two cached upstream calls, and only
// made when the file is in fact missing a number.
async function positionOnRelease(releaseGroupMbid, recordingMbid) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) return {};
  const { tracks } = await getReleaseWithTracks(releaseMbid);
  const track = tracks.find((t) => t.recordingMbid === recordingMbid);
  return track ? { trackNumber: track.position, disc: track.discNumber } : {};
}

// Applies one candidate: fills the tags the file is missing and re-indexes it.
//
// writeMissingTags only writes fields that are currently empty, which is exactly
// the contract wanted here — a "fix" must never overwrite metadata the user
// already has, only fill the holes the Health report flagged.
export async function applyFix({ trackId, recordingMbid }) {
  const { track, real } = await trackOrThrow(trackId);
  const recording = await getRecording(recordingMbid);

  const releaseGroupMbid = recording.releaseGroups?.[0]?.mbid ?? null;
  const albumTitle = recording.releaseGroups?.[0]?.title ?? null;

  const position = track.trackNumber == null && releaseGroupMbid
    ? await positionOnRelease(releaseGroupMbid, recordingMbid)
    : {};

  // Only fetched when the file has no art of its own, so a fix on a file that is
  // already arted costs no Cover Art Archive request.
  const coverImage = !track.hasCoverArt && releaseGroupMbid
    ? await getFrontCoverImage(releaseGroupMbid)
    : null;

  const { filledFields } = await writeMissingTags(real, {
    artist: recording.artist ?? null,
    title: recording.title ?? null,
    album: albumTitle,
    year: recording.date ? Number(recording.date.slice(0, 4)) || null : null,
    trackNumber: position.trackNumber ?? null,
    disc: position.disc ?? null,
  }, { coverImage });

  await reindexFile(real);

  return {
    filledFields,
    track: getTrackById(getDb(), trackId),
    recording: { mbid: recording.mbid, title: recording.title, artist: recording.artist },
  };
}
