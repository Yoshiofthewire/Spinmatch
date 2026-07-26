import { getDb } from '../lib/db.js';
import { config } from '../config.js';
import { getTrackById } from './libraryRepo.js';
import { candidatesFromTags } from './tagMatch.js';
import { candidatesFromFingerprint } from './fingerprintMatch.js';
import { tagsFromPath } from './libraryPathTags.js';
import { getRecording, resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { getFrontCoverImage } from './coverArt.js';
import { writeMissingTags } from './tags.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { assertMbid } from '../lib/mbid.js';

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
//
// The file's path is passed as a fallback because this is reached from the
// Health tab, whose rows are by definition files with missing tags: searching
// MusicBrainz for "the tags this file has" finds nothing when the tags are the
// thing that's missing. Where the file sits on disk is the metadata those files
// still carry, so it is what gets searched on instead.
export async function getFixCandidates(trackId) {
  const { track, real } = await trackOrThrow(trackId);
  const fallback = tagsFromPath(real);
  const { candidates } = await candidatesFromTags(real, { fallback });
  return { track, candidates, pathTags: fallback };
}

// The same candidate list, identified by the audio instead of the metadata.
// Reached from a button rather than on panel open: fingerprinting spawns fpcalc
// over 120 seconds of audio and spends a rate-limited AcoustID call, which is
// too much to do for every Health row a user expands.
//
// No tag-search fallback when this comes back empty — whoever asked already has
// the tag/path candidates from getFixCandidates on screen.
export async function getFingerprintCandidates(trackId) {
  if (!config.acoustidApiKey) {
    throw new BadRequestError('AcoustID is not configured on this server');
  }
  const { track, real } = await trackOrThrow(trackId);
  const { candidates } = await candidatesFromFingerprint(real);
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
// By default writeMissingTags only writes fields that are currently empty,
// which is the contract the Health report implies — a "fix" must never
// overwrite metadata the user already has, only fill the holes it flagged.
//
// `overwrite` is the exception the fingerprint path earns: when the audio says
// the file is a different recording than its tags claim, the existing values
// are the thing that's wrong and filling holes repairs nothing. The UI only
// offers it for fingerprint-sourced candidates, and only when explicitly
// ticked, because nothing here can be undone.
//
// `replaceCoverArt` says the same about the picture, and is its own flag: a
// mis-tagged file usually carries the wrong sleeve too, but plenty of people
// want the tags corrected and their own artwork kept.
export async function applyFix({ trackId, recordingMbid, overwrite = false, replaceCoverArt = false }) {
  assertMbid(recordingMbid, 'recordingMbid');
  const { track, real } = await trackOrThrow(trackId);
  const recording = await getRecording(recordingMbid);

  const releaseGroupMbid = recording.releaseGroups?.[0]?.mbid ?? null;
  const albumTitle = recording.releaseGroups?.[0]?.title ?? null;

  // Fill-only can skip the tracklist for a file that already has a number;
  // overwriting has to fetch it, since a wrong number is exactly what it's for.
  const position = (overwrite || track.trackNumber == null) && releaseGroupMbid
    ? await positionOnRelease(releaseGroupMbid, recordingMbid)
    : {};

  // Only fetched when there's somewhere for it to go, so a fix on a file that is
  // already arted costs no Cover Art Archive request unless the art is what's
  // being replaced.
  const coverImage = (replaceCoverArt || !track.hasCoverArt) && releaseGroupMbid
    ? await getFrontCoverImage(releaseGroupMbid)
    : null;

  const { filledFields } = await writeMissingTags(real, {
    artist: recording.artist ?? null,
    title: recording.title ?? null,
    album: albumTitle,
    year: recording.date ? Number(recording.date.slice(0, 4)) || null : null,
    trackNumber: position.trackNumber ?? null,
    disc: position.disc ?? null,
  }, { coverImage, overwrite, replaceCoverArt });

  await reindexFile(real);

  return {
    filledFields,
    overwritten: overwrite,
    track: getTrackById(getDb(), trackId),
    recording: { mbid: recording.mbid, title: recording.title, artist: recording.artist },
  };
}
