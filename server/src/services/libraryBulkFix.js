import { getDb } from '../lib/db.js';
import { getAlbumTracksForRepair } from './libraryRepo.js';
import { tagsFromPath } from './libraryPathTags.js';
import { resolveAlbum } from './libraryDiscography.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { readTags, writeMissingTags, plannedFills } from './tags.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { BadRequestError } from '../lib/httpErrors.js';

// Repairing a whole album's tags in one pass.
//
// Album-scoped rather than track-scoped on purpose. Repairing tracks one at a
// time through MusicBrainz costs one to three rate-limited calls each, so a few
// hundred files is a twenty-minute job — and worse, the per-track lookup
// searches on the tags the file carries, which finds nothing for exactly the
// files that need repairing. Resolving the album once costs two calls for the
// entire tracklist, and lets position or filename order carry the match instead.
//
// Two sources, one apply path:
//   'path'        — read the tags implied by where the file sits. No network.
//   'musicbrainz' — resolve the album once, align local files to its tracklist.
//
// Nothing here moves or renames a file, and writeMissingTags still only fills
// fields that are empty, so the never-overwrite contract the single-track repair
// makes is unchanged. The preview exists so a proposal is seen before it lands.

// A hard ceiling on one request, alongside the route's other caps. An album is
// tens of tracks; anything near this is a client bug, not a big record.
export const MAX_BULK_FIX = 500;

// Track numbers parsed out of filenames are the one field that can be confidently
// wrong: "99 Problems.mp3" reads as track 99. A real position is bounded by how
// many tracks the album has, so anything well past that is a title that happens
// to start with a number. The floor of 30 keeps partial albums working — owning
// tracks 1, 2 and 12 of a record is normal here, and is not evidence that 12 is
// a mis-read.
function plausibleTrackNumber(trackNumber, trackCount) {
  if (trackNumber == null) return null;
  return trackNumber <= Math.max(30, trackCount) ? trackNumber : null;
}

// What the file's own location says it should be tagged as.
function proposeFromPath(track, trackCount) {
  const fromPath = tagsFromPath(track.path);
  return {
    artist: fromPath.artist,
    album: fromPath.album,
    title: fromPath.title,
    trackNumber: plausibleTrackNumber(fromPath.trackNumber, trackCount),
    disc: fromPath.disc,
    year: fromPath.year,
  };
}

// Lines local files up with an upstream tracklist. Track numbers are used when
// every file has one, because that is a statement about position; otherwise the
// listing order stands in, but only when the two lists are the same length —
// aligning a 9-file folder against a 12-track release by index would shift every
// tag after the first gap onto the wrong file.
//
// The alignment must be one-to-one. Matching each local file independently let
// two files claim the same upstream track, which is not hypothetical: a folder
// holding a duplicate rip has two files tagged track 3, and the app has a whole
// Duplicates tab because that is a normal state for a real library. Both files
// would then be proposed the same title. A collision means the numbers on disk
// don't describe this release, so the alignment is abandoned wholesale rather
// than half-applied — the caller reports `unresolved` and the user picks another
// source.
function alignToTracklist(localTracks, upstreamTracks) {
  const numbered = localTracks.every((t) => t.trackNumber != null);
  if (numbered) {
    const claimed = new Set();
    const pairs = [];
    for (const local of localTracks) {
      const match = upstreamTracks.find((u) => u.position === local.trackNumber
        && (u.discNumber ?? 1) === (local.disc ?? 1));
      if (!match) { pairs.push([local.id, null]); continue; }
      // Two local files pointing at one upstream track: the positions on disk
      // aren't a description of this release, so no proposal from them is
      // trustworthy.
      if (claimed.has(match)) return null;
      claimed.add(match);
      pairs.push([local.id, match]);
    }
    return new Map(pairs);
  }
  if (localTracks.length !== upstreamTracks.length) return new Map();
  return new Map(localTracks.map((local, i) => [local.id, upstreamTracks[i]]));
}

function proposeFromUpstream(upstream, release) {
  if (!upstream) return null;
  return {
    // The track's own credit, falling back to the release's. Using the release
    // credit unconditionally tagged every track on a compilation as "Various
    // Artists" — see the note in musicbrainz.js/getReleaseWithTracks.
    artist: upstream.artist || release.artist || null,
    album: release.title ?? null,
    title: upstream.title ?? null,
    trackNumber: upstream.position ?? null,
    disc: upstream.discNumber ?? null,
    year: release.date ? Number(release.date.slice(0, 4)) || null : null,
  };
}

// Reads the tags actually on disk, which is not the same as the indexed row: the
// scanner falls back to the folder name for a missing album tag and the filename
// for a missing title, so the index shows values the file itself doesn't carry.
// A preview built from the index would report nothing to fill.
async function currentTagsOf(track) {
  const real = await assertReadableInsideMusicDir(track.path);
  try {
    return { real, current: await readTags(real) };
  } catch {
    // A file that can't be read is reported rather than skipped silently — it's
    // the same "this is a file problem, not a tag problem" case the Health tab
    // makes for a missing duration.
    return { real, current: null };
  }
}

/**
 * What a bulk repair of this album would write, without writing any of it.
 *
 * @returns {{artist, album, source, unresolved: boolean, tracks: Array<{
 *   trackId, path, current, proposed, fills: string[], unreadable: boolean }>}}
 */
export async function previewBulkFix({ artist = null, album, source = 'path', db = getDb() } = {}) {
  if (!album) throw new BadRequestError('album is required');
  if (source !== 'path' && source !== 'musicbrainz') {
    throw new BadRequestError('source must be "path" or "musicbrainz"');
  }

  const localTracks = getAlbumTracksForRepair(db, { artist, album });
  if (localTracks.length === 0) {
    return { artist, album, source, unresolved: false, tracks: [] };
  }

  let aligned = null;
  let release = null;
  if (source === 'musicbrainz') {
    const { releaseGroupMbid } = await resolveAlbum(artist, album, { db });
    if (!releaseGroupMbid) {
      return { artist, album, source, unresolved: true, tracks: [] };
    }
    const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
    if (!releaseMbid) {
      return { artist, album, source, unresolved: true, tracks: [] };
    }
    const fetched = await getReleaseWithTracks(releaseMbid);
    release = fetched.release;
    aligned = alignToTracklist(localTracks, fetched.tracks);
    // null means the local track numbers collided against this tracklist, so
    // nothing derived from them can be trusted. Reported as unresolved, which is
    // the same state the UI already renders for "MusicBrainz can't place this
    // album" and offers the path source for.
    if (aligned === null) {
      return { artist, album, source, unresolved: true, tracks: [] };
    }
  }

  const tracks = [];
  for (const track of localTracks) {
    const { current } = await currentTagsOf(track);
    const proposed = source === 'path'
      ? proposeFromPath(track, localTracks.length)
      : proposeFromUpstream(aligned.get(track.id), release);

    tracks.push({
      trackId: track.id,
      path: track.path,
      current,
      proposed,
      // The fields this would actually change. A proposal that fills nothing is
      // still listed, so the preview accounts for every file in the album rather
      // than quietly dropping the ones already in good shape.
      fills: current && proposed ? plannedFills(current, proposed) : [],
      unreadable: current === null,
    });
  }

  return { artist, album, source, unresolved: false, tracks };
}

/**
 * Applies a previewed repair to the chosen tracks.
 *
 * The proposal is re-derived here rather than accepted from the request: the
 * client sends which tracks to repair, not what to write. That keeps the tag
 * values the server's own conclusion, and keeps the request small.
 *
 * A caller that already holds a preview passes it in. Recomputing it meant
 * re-reading every file's tags and, for the musicbrainz source, spending two
 * more calls on the 1-req/s upstream queue to re-resolve an album the client had
 * just been shown — doubling the cost of an operation that is already the
 * slowest thing in the app.
 *
 * Failures are isolated per track. A single unwritable file used to throw
 * straight out of the loop, which discarded the record of everything already
 * written and left the user with a 500 and no idea which of their files had been
 * modified. Now every track reports its own outcome and the run continues.
 *
 * @returns {{applied: Array<{trackId, filledFields}>, failed: Array<{trackId, message}>,
 *   skipped: number}}
 */
export async function applyBulkFix({
  artist = null, album, source = 'path', trackIds, preview = null, db = getDb(),
} = {}) {
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    throw new BadRequestError('trackIds is required');
  }
  if (trackIds.length > MAX_BULK_FIX) {
    throw new BadRequestError(`Too many tracks in one request (max ${MAX_BULK_FIX})`);
  }

  const resolved = preview ?? await previewBulkFix({ artist, album, source, db });
  const wanted = new Set(trackIds.map(Number));
  // Intersecting against the preview is what confines a request to the album it
  // named: an id the preview didn't produce isn't in this album and is dropped,
  // so a caller can't repair arbitrary tracks by listing their ids here.
  const chosen = resolved.tracks.filter((t) => wanted.has(t.trackId) && !t.unreadable && t.proposed);

  const applied = [];
  const failed = [];
  for (const track of chosen) {
    try {
      const real = await assertReadableInsideMusicDir(track.path);
      const { filledFields } = await writeMissingTags(real, track.proposed);
      await reindexFile(real);
      applied.push({ trackId: track.trackId, filledFields });
    } catch (err) {
      // A file that vanished, went read-only, or sits on a mount that dropped
      // out mid-run. Routine on the network storage these libraries live on, and
      // no reason for the other 200 tracks to go unrepaired.
      failed.push({ trackId: track.trackId, message: err.message });
    }
  }

  return { applied, failed, skipped: wanted.size - applied.length - failed.length };
}
