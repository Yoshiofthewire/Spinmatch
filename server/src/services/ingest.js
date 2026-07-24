import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording, resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import * as tags from './tags.js';
import { getFrontCoverImage } from './coverArt.js';
import { rankCandidates } from './durationMatch.js';
import * as organize from './organize.js';
import { RateLimitedError, BadRequestError } from '../lib/httpErrors.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
const SCORE_THRESHOLD = 0.5;
const DURATION_TOLERANCE_MS = 5000;

// Defense-in-depth: paths reaching this module from the manual-override
// routes are client-supplied, so verify they resolve inside INGEST_DIR
// before any fingerprint/tag/move work touches the filesystem.
function assertInsideIngestDir(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.ingest.ingestDir);
  if (!resolved.startsWith(root + path.sep)) {
    throw new BadRequestError(`Refusing to operate outside INGEST_DIR: ${filePath}`);
  }
}

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function scanIngestDir() {
  const dir = config.ingest.ingestDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const children = await fs.readdir(path.join(dir, entry.name));
      const trackCount = children.filter(isAudioFile).length;
      if (trackCount > 0) {
        items.push({ id: entry.name, type: 'album', name: entry.name, path: path.join(dir, entry.name), trackCount });
      }
    } else if (isAudioFile(entry.name)) {
      items.push({ id: entry.name, type: 'file', name: entry.name, path: path.join(dir, entry.name) });
    }
  }

  return { items };
}

async function identifyFile(filePath) {
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const candidates = await lookup({ fingerprint: fp, durationSeconds });

  if (candidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidates found' };
  }

  const topCandidates = candidates.filter((c) => c.score >= SCORE_THRESHOLD).slice(0, 5);
  if (topCandidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidate met the confidence threshold' };
  }

  const recordings = await Promise.all(topCandidates.map((c) => getRecording(c.recordingMbid)));
  // Each candidate recording carries its OWN MusicBrainz-canonical length; the
  // fixed point we're matching against is the file's own measured duration —
  // same orientation as verifyTrack.js's YouTube-candidate ranking.
  const rankable = recordings
    .map((rec, i) => ({ id: rec.mbid, title: rec.title, durationMs: rec.lengthMs, recording: rec, score: topCandidates[i].score }))
    .filter((c) => c.durationMs != null);

  const ranked = rankCandidates(rankable, durationSeconds * 1000);
  const best = ranked.find((c) => c.withinTolerance);

  if (!best) {
    return { confirmed: null, reason: 'no candidate recording matched within the duration tolerance' };
  }

  return { confirmed: best.recording, reason: null };
}

// Applies fill-missing tags, or (dryRun) just reports which fields WOULD be
// filled — computed from the already-read `current` tags, nothing written.
async function applyOrPreviewTags(filePath, current, desired, coverImage, dryRun) {
  if (!dryRun) {
    return tags.writeMissingTags(filePath, desired, { coverImage });
  }
  const filledFields = tags.plannedFills(current, desired);
  if (coverImage && !current.hasCoverArt) filledFields.push('coverArt');
  return { filledFields };
}

// Moves a file into MUSIC_DIR, translating the two non-matched outcomes into a
// clean needsReview entry: a byte-identical duplicate (left in place), or an
// fs-level move failure (the file was already tagged in place, just not moved).
async function moveFileSafely(filePath, name, moveMeta) {
  const ext = path.extname(filePath).toLowerCase();
  let result;
  try {
    result = await organize.moveIntoLibrary(filePath, moveMeta, ext);
  } catch (err) {
    return {
      needsReview: {
        path: filePath,
        name,
        code: 'move_failed',
        reason: `tagged in place, but could not be moved into the library: ${err.message}`,
      },
    };
  }
  if (result.duplicate) {
    return {
      needsReview: {
        path: filePath,
        name,
        code: 'duplicate',
        reason: 'an identical file already exists in the library; left in place for review',
      },
    };
  }
  return { movedTo: result.movedTo };
}

// Real move, or (dryRun) the path the file WOULD move to — no filesystem access
// and no collision resolution (a preview shows the intended destination).
async function moveOrPreview(filePath, name, moveMeta, dryRun) {
  if (!dryRun) return moveFileSafely(filePath, name, moveMeta);
  return { movedTo: organize.targetPathFor(moveMeta, path.extname(filePath).toLowerCase()) };
}

async function processLooseFile(item, { dryRun }) {
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, code: 'no_match', reason } };
  }
  return finalizeLooseFile(item.path, item.name, confirmed, { dryRun });
}

// Tags and moves a loose file given an already-resolved MusicBrainz recording
// (the shape `getRecording` returns). Shared by the automatic identify-then-finalize
// path above and the manual-override resolve path (see resolveLooseFileOverride).
async function finalizeLooseFile(filePath, name, confirmed, { dryRun }) {
  const current = await tags.readTags(filePath);
  const releaseGroup = confirmed.releaseGroups[0];
  const coverImage = releaseGroup ? await getFrontCoverImage(releaseGroup.mbid) : null;

  // A track with no release group has no real album — leave the album *tag*
  // empty (don't fabricate one), but file it under a "Singles" folder.
  const albumTitle = releaseGroup?.title ?? null;
  const desired = {
    artist: confirmed.artist,
    title: confirmed.title,
    album: albumTitle,
    year: confirmed.date ? Number(confirmed.date.slice(0, 4)) : null,
  };
  const { filledFields } = await applyOrPreviewTags(filePath, current, desired, coverImage, dryRun);

  const moved = await moveOrPreview(filePath, name, {
    artist: confirmed.artist,
    album: albumTitle ?? 'Singles',
    title: confirmed.title,
  }, dryRun);
  if (moved.needsReview) return { needsReview: moved.needsReview };

  return {
    matched: {
      path: filePath,
      name,
      recordingMbid: confirmed.mbid,
      title: confirmed.title,
      artist: confirmed.artist,
      album: albumTitle,
      filledFields,
      current,
      movedTo: moved.movedTo,
    },
  };
}

// Positional coherence: with files sorted by name and tracks in (disc, position)
// order, file[i] must correspond to track[i] either by a shared recording MBID
// (strongest signal) or by a duration within tolerance.
function albumIsCoherent(perFile, tracks) {
  return perFile.every((f, i) => {
    const track = tracks[i];
    if (track.recordingMbid && f.recMbids.includes(track.recordingMbid)) return true;
    return track.lengthMs != null && Math.abs(track.lengthMs - f.durationMs) <= DURATION_TOLERANCE_MS;
  });
}

async function identifyAlbum(files) {
  const perFile = [];
  for (const filePath of files) {
    const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
    const candidates = await lookup({ fingerprint: fp, durationSeconds });
    const recMbids = candidates.filter((c) => c.score >= SCORE_THRESHOLD).map((c) => c.recordingMbid);
    perFile.push({ filePath, durationMs: durationSeconds * 1000, recMbids });
  }

  // Candidate release-groups come from the files' candidate recordings.
  const recCache = new Map();
  const releaseGroupMbids = new Set();
  for (const f of perFile) {
    for (const recMbid of f.recMbids) {
      if (!recCache.has(recMbid)) recCache.set(recMbid, await getRecording(recMbid));
      for (const rg of recCache.get(recMbid).releaseGroups || []) releaseGroupMbids.add(rg.mbid);
    }
  }
  if (releaseGroupMbids.size === 0) {
    return { reason: 'no confident AcoustID matches for the album tracks' };
  }

  // First release-group that resolves to a release whose tracklist coherently
  // explains the whole folder wins (all-or-nothing at the folder level).
  for (const rgMbid of releaseGroupMbids) {
    const releaseId = await resolvePrimaryReleaseForGroup(rgMbid);
    if (!releaseId) continue;
    const { release, tracks } = await getReleaseWithTracks(releaseId);
    if (tracks.length !== files.length) continue;
    if (!albumIsCoherent(perFile, tracks)) continue;
    const coverImage = await getFrontCoverImage(rgMbid);
    return { release, tracks, coverImage };
  }
  return { reason: 'no release coherently matched the whole folder' };
}

async function processAlbumFolder(item, { dryRun }) {
  const entries = await fs.readdir(item.path);
  const files = entries
    .filter(isAudioFile)
    .sort()
    .map((name) => path.join(item.path, name));

  const identified = await identifyAlbum(files);
  if (identified.reason) {
    return { needsReview: [{ path: item.path, name: item.name, code: 'album_incoherent', reason: identified.reason }] };
  }

  const { release, tracks, coverImage } = identified;
  const multiDisc = release.discCount > 1;
  const matched = [];
  const needsReview = [];

  for (let i = 0; i < files.length; i += 1) {
    const filePath = files[i];
    const track = tracks[i];
    const name = path.basename(filePath);
    const discNumber = multiDisc ? track.discNumber : null;

    const desired = {
      artist: release.artist,
      title: track.title,
      album: release.title,
      trackNumber: track.position,
      disc: discNumber,
    };
    const current = dryRun ? await tags.readTags(filePath) : null;
    const { filledFields } = await applyOrPreviewTags(filePath, current, desired, coverImage, dryRun);

    const moved = await moveOrPreview(filePath, name, {
      artist: release.artist,
      album: release.title,
      title: track.title,
      trackNumber: track.position,
      discNumber,
    }, dryRun);
    if (moved.needsReview) {
      needsReview.push(moved.needsReview);
      continue;
    }
    matched.push({
      path: filePath,
      name,
      recordingMbid: track.recordingMbid,
      title: track.title,
      artist: release.artist,
      album: release.title,
      filledFields,
      movedTo: moved.movedTo,
    });
  }

  return { matched, needsReview };
}

// `onItem`, when given, is called once per completed item as it resolves
// (`{ kind: 'matched' | 'needsReview', ...entry }`) so callers can stream
// progress. Without it, behaviour is identical — everything is just collected.
export async function processIngest({ dryRun = false, onItem } = {}) {
  const { items } = await scanIngestDir();
  const matched = [];
  const needsReview = [];

  const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const emitMatched = (m) => {
    matched.push(m);
    onItem?.({ kind: 'matched', ...m });
  };
  const emitNeedsReview = (r) => {
    needsReview.push(r);
    onItem?.({ kind: 'needsReview', ...r });
  };

  for (const item of items) {
    try {
      const result = item.type === 'album'
        ? await processAlbumFolder(item, { dryRun })
        : await processLooseFile(item, { dryRun });
      toArray(result.matched).forEach(emitMatched);
      toArray(result.needsReview).forEach(emitNeedsReview);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return { matched, needsReview, dryRun, error: { code: err.code, message: err.message } };
      }
      emitNeedsReview({ path: item.path, name: item.name, reason: err.message });
    }
  }

  return { matched, needsReview, dryRun };
}

// Re-fingerprints filePath and re-runs the AcoustID lookup, this time keeping
// every candidate (not just ones scoring above SCORE_THRESHOLD) so a human can
// pick from AcoustID's near-misses when auto-matching failed.
export async function findCandidatesForFile(filePath) {
  assertInsideIngestDir(filePath);
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const acoustidCandidates = await lookup({ fingerprint: fp, durationSeconds });
  const top = acoustidCandidates.slice(0, 10);
  const recordings = await Promise.all(top.map((c) => getRecording(c.recordingMbid)));

  const candidates = recordings.map((rec, i) => ({
    recordingMbid: rec.mbid,
    title: rec.title,
    artist: rec.artist,
    lengthMs: rec.lengthMs,
    score: top[i].score,
    releaseGroupTitle: rec.releaseGroups[0]?.title ?? null,
  }));

  return { candidates };
}

// Manual-override counterpart to the automatic identify-then-finalize flow:
// the recording is already chosen (by the user, via findCandidatesForFile's
// near-misses or a text search), so just resolve it and finalize.
export async function resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun = false }) {
  assertInsideIngestDir(filePath);
  const confirmed = await getRecording(recordingMbid);
  return finalizeLooseFile(filePath, name, confirmed, { dryRun });
}
