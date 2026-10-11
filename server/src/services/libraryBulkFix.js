import fs from 'node:fs/promises';
import { getDb } from '../lib/db.js';
import { getAlbumTracksForRepair } from './libraryRepo.js';
import { tagsFromPath } from './libraryPathTags.js';
import { resolveAlbum } from './libraryDiscography.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import { readTags, writeTags, plannedFills } from './tags.js';
import { openJournal } from './tagJournal.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { yieldToEventLoop, describeFailure } from '../lib/writeLoop.js';
import { BadRequestError } from '../lib/httpErrors.js';

// Album-scoped tag repair: one MusicBrainz lookup per album, not per track, and per-track
// lookups search on exactly the tags that are broken. Fills empty fields only; never renames.

export const MAX_BULK_FIX = 500;

// Rejects "99 Problems.mp3" as track 99; the floor of 30 keeps partial albums working.
function plausibleTrackNumber(trackNumber, trackCount) {
  if (trackNumber == null) return null;
  return trackNumber <= Math.max(30, trackCount) ? trackNumber : null;
}

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

// By track number if every file has one, else by index only when lengths match.
// One-to-one: a collision (e.g. a duplicate rip) returns null and the whole alignment is abandoned.
function alignToTracklist(localTracks, upstreamTracks) {
  const numbered = localTracks.every((t) => t.trackNumber != null);
  if (numbered) {
    const claimed = new Set();
    const pairs = [];
    for (const local of localTracks) {
      const match = upstreamTracks.find((u) => u.position === local.trackNumber
        && (u.discNumber ?? 1) === (local.disc ?? 1));
      if (!match) { pairs.push([local.id, null]); continue; }
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
    // Track credit first, or compilations get tagged "Various Artists".
    artist: upstream.artist || release.artist || null,
    album: release.title ?? null,
    title: upstream.title ?? null,
    trackNumber: upstream.position ?? null,
    disc: upstream.discNumber ?? null,
    year: release.date ? Number(release.date.slice(0, 4)) || null : null,
  };
}

// Reads tags from disk, not the index: the scanner backfills album/title from folder and filename.
async function currentTagsOf(track) {
  const real = await assertReadableInsideMusicDir(track.path);
  // Lets apply detect a file changed since preview.
  let mtimeMs = null;
  try {
    ({ mtimeMs } = await fs.stat(real));
  } catch { /* reported via `current: null` below */ }
  try {
    return { real, mtimeMs, current: await readTags(real) };
  } catch {
    return { real, mtimeMs, current: null };
  }
}

// Previews are cached up to ten minutes; never write a proposal built from tags that changed since.
// No recorded mtime passes through (legacy cache entries).
async function assertUnchangedSincePreview(track) {
  if (track.mtimeMs == null) return;
  let stat;
  try {
    stat = await fs.stat(track.path);
  } catch {
    const err = new BadRequestError('The file is no longer there.');
    err.code = 'STALE_PREVIEW';
    throw err;
  }
  if (Math.trunc(stat.mtimeMs) !== Math.trunc(track.mtimeMs)) {
    const err = new BadRequestError(
      'This file changed after the preview was taken — re-run the preview to see what it needs now.'
    );
    err.code = 'STALE_PREVIEW';
    throw err;
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
    // Track-number collision: nothing derived from it is trustworthy.
    if (aligned === null) {
      return { artist, album, source, unresolved: true, tracks: [] };
    }
  }

  const tracks = [];
  for (const track of localTracks) {
    await yieldToEventLoop();
    const { current, mtimeMs } = await currentTagsOf(track);
    const proposed = source === 'path'
      ? proposeFromPath(track, localTracks.length)
      : proposeFromUpstream(aligned.get(track.id), release);

    tracks.push({
      trackId: track.id,
      path: track.path,
      mtimeMs,
      current,
      proposed,
      fills: current && proposed ? plannedFills(current, proposed) : [],
      unreadable: current === null,
    });
  }

  return { artist, album, source, unresolved: false, tracks };
}

/**
 * The client picks track ids, never tag values; values come from the server-side preview.
 * Failures are per track, so one bad file doesn't hide what was already written.
 * @returns {{applied: Array<{trackId, filledFields}>, failed: Array<{trackId, message}>,
 *   skipped: number, batchId: number|null}}
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
  // Intersecting with the preview confines the request to the named album.
  const chosen = resolved.tracks.filter((t) => wanted.has(t.trackId) && !t.unreadable && t.proposed);

  const journal = openJournal(db, 'bulk-fix', `Bulk fix: ${resolved.artist ?? 'Unknown artist'} – ${resolved.album}`);
  const applied = [];
  const failed = [];
  for (const track of chosen) {
    await yieldToEventLoop();
    try {
      const real = await assertReadableInsideMusicDir(track.path);
      const filledFields = await withFileLock(real, async () => {
        // Under the lock, so nothing can change the file between check and write.
        await assertUnchangedSincePreview(track);
        const written = await writeTags(real, track.proposed);
        await journal.record({ trackId: track.trackId, real }, written);
        await reindexFile(real);
        return written.filledFields;
      });
      applied.push({ trackId: track.trackId, filledFields });
    } catch (err) {
      // Raw fs messages carry absolute server paths: log them, return only a code.
      console.warn(`libraryBulkFix: track ${track.trackId} failed: ${err.message}`);
      failed.push({ trackId: track.trackId, ...describeFailure(err) });
    }
  }

  return {
    applied, failed, skipped: wanted.size - applied.length - failed.length, batchId: journal.batchId,
  };
}
