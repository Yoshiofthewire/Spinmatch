import { getDb } from '../lib/db.js';
import { config } from '../config.js';
import { getTrackById } from './libraryRepo.js';
import { candidatesFromTags } from './tagMatch.js';
import { candidatesFromFingerprint } from './fingerprintMatch.js';
import { tagsFromPath } from './libraryPathTags.js';
import { getRecording, resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { getFrontCoverImage } from './coverArt.js';
import { writeTags } from './tags.js';
import { openJournal } from './tagJournal.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { assertMbid } from '../lib/mbid.js';

// Tag repair for files already in the library. Never moves or renames; only writes tags.

async function trackOrThrow(trackId) {
  const track = getTrackById(getDb(), trackId);
  if (!track) throw new NotFoundError('Track not found');
  // Re-validate our own indexed path before opening it for writing.
  const real = await assertReadableInsideMusicDir(track.path);
  return { track, real };
}

// Candidate recordings for a human to pick. Path tags are the fallback, since
// Health rows are by definition files missing tags.
export async function getFixCandidates(trackId) {
  const { track, real } = await trackOrThrow(trackId);
  const fallback = tagsFromPath(real);
  const { candidates } = await candidatesFromTags(real, { fallback });
  return { track, candidates, pathTags: fallback };
}

// Candidates by audio fingerprint. On demand only: fpcalc plus a rate-limited AcoustID call.
export async function getFingerprintCandidates(trackId) {
  if (!config.acoustidApiKey) {
    throw new BadRequestError('AcoustID is not configured on this server');
  }
  const { track, real } = await trackOrThrow(trackId);
  const { candidates } = await candidatesFromFingerprint(real);
  return { track, candidates };
}

// Track/disc number on the release; missing numbers break gap detection.
async function positionOnRelease(releaseGroupMbid, recordingMbid) {
  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) return {};
  const { tracks } = await getReleaseWithTracks(releaseMbid);
  const track = tracks.find((t) => t.recordingMbid === recordingMbid);
  return track ? { trackNumber: track.position, disc: track.discNumber } : {};
}

// Fills only empty tags by default, then re-indexes. `overwrite` (UI: fingerprint
// candidates, explicit opt-in) and `replaceCoverArt` are separate opt-ins. Journaled for undo.
export async function applyFix({ trackId, recordingMbid, overwrite = false, replaceCoverArt = false }) {
  assertMbid(recordingMbid, 'recordingMbid');
  const { track, real } = await trackOrThrow(trackId);
  const recording = await getRecording(recordingMbid);

  const releaseGroupMbid = recording.releaseGroups?.[0]?.mbid ?? null;
  const albumTitle = recording.releaseGroups?.[0]?.title ?? null;

  const position = (overwrite || track.trackNumber == null) && releaseGroupMbid
    ? await positionOnRelease(releaseGroupMbid, recordingMbid)
    : {};

  const coverImage = (replaceCoverArt || !track.hasCoverArt) && releaseGroupMbid
    ? await getFrontCoverImage(releaseGroupMbid)
    : null;

  const journal = openJournal(getDb(), 'fix', `Fixed from MusicBrainz: ${recording.artist ?? 'Unknown artist'} – ${recording.title}`);
  // Concurrent whole-file rewrites corrupt the file (a double-click does it). Re-index
  // inside the lock too, or it can read a half-written file.
  const filledFields = await withFileLock(real, async () => {
    const written = await writeTags(real, {
      artist: recording.artist ?? null,
      title: recording.title ?? null,
      album: albumTitle,
      year: recording.date ? Number(recording.date.slice(0, 4)) || null : null,
      trackNumber: position.trackNumber ?? null,
      disc: position.disc ?? null,
    }, { coverImage, overwrite, replaceCoverArt });
    await journal.record({ trackId, real }, written);
    await reindexFile(real);
    return written.filledFields;
  });

  return {
    filledFields,
    batchId: journal.batchId,
    overwritten: overwrite,
    track: getTrackById(getDb(), trackId),
    recording: { mbid: recording.mbid, title: recording.title, artist: recording.artist },
  };
}
