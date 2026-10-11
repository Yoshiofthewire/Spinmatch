import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording, resolvePrimaryReleaseForGroup, getReleaseWithTracks } from './musicbrainz.js';
import * as tags from './tags.js';
import { getFrontCoverImage } from './coverArt.js';
import { rankCandidates } from './durationMatch.js';
import * as tagMatch from './tagMatch.js';
import * as fingerprintMatch from './fingerprintMatch.js';
import * as organize from './organize.js';
import { withFileLock } from '../lib/fileLock.js';
import { RateLimitedError, BadRequestError } from '../lib/httpErrors.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
const SCORE_THRESHOLD = config.matching.acoustidMinScore;
const DURATION_TOLERANCE_MS = config.matching.durationToleranceMs;

// Client-supplied paths: realpath both sides so symlinks can't escape INGEST_DIR.
// Callers must use the returned path (TOCTOU). Errors omit the path; they reach the browser.
async function resolveInsideIngestDir(filePath) {
  const root = await fs.realpath(config.ingest.ingestDir);
  let real;
  try {
    real = await fs.realpath(filePath);
  } catch {
    throw new BadRequestError('No such file inside the ingest folder');
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new BadRequestError('Refusing to operate outside the ingest folder');
  }
  return real;
}

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

// Natural sort: "10 - x" after "2 - x", or positional coherence fails.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Album audio files plus one level of disc subfolders ("CD1", "Disc 2"), ordered
// so file[i] lines up with track[i]. Symlinks skipped.
async function collectAlbumFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const here = entries
    .filter((e) => e.isFile() && !e.isSymbolicLink() && isAudioFile(e.name))
    .map((e) => e.name)
    .sort(naturalCompare)
    .map((name) => path.join(dir, name));

  const subdirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(naturalCompare);

  const nested = [];
  for (const sub of subdirs) {
    const subPath = path.join(dir, sub);
    let subEntries;
    try {
      subEntries = await fs.readdir(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    nested.push(...subEntries
      .filter((e) => e.isFile() && !e.isSymbolicLink() && isAudioFile(e.name))
      .map((e) => e.name)
      .sort(naturalCompare)
      .map((name) => path.join(subPath, name)));
  }

  return [...here, ...nested];
}

export async function scanIngestDir() {
  const dir = config.ingest.ingestDir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Unmounted drop-folder is normal (Docker always sets INGEST_DIR); other errors surface.
    if (err.code === 'ENOENT') return { items: [] };
    throw err;
  }
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // A planted symlink could aim the tag/move pipeline outside INGEST_DIR.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const trackCount = (await collectAlbumFiles(path.join(dir, entry.name))).length;
      if (trackCount > 0) {
        items.push({ id: entry.name, type: 'album', name: entry.name, path: path.join(dir, entry.name), trackCount });
      }
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      items.push({ id: entry.name, type: 'file', name: entry.name, path: path.join(dir, entry.name) });
    }
  }

  return { items };
}

// Returns `{ confirmed, reason }`, exactly one set (same as tagMatch.identifyFileFromTags).
async function identifyFile(filePath) {
  if (!config.acoustidApiKey) {
    return tagMatch.identifyFileFromTags(filePath);
  }

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
  // Rank candidate lengths against the file's measured duration.
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
    // Lock: a library repair may write the same inode via a bind mount.
    // Re-resolve: seconds of lookups since scan leave room for a symlink swap.
    const real = await resolveInsideIngestDir(filePath);
    return withFileLock(real, () => tags.writeTags(real, desired, { coverImage }));
  }
  const filledFields = tags.plannedFills(current, desired);
  if (coverImage && !current.hasCoverArt) filledFields.push('coverArt');
  return { filledFields };
}

// Duplicates and move failures become needsReview entries (file already tagged in place).
async function moveFileSafely(filePath, name, moveMeta) {
  const ext = path.extname(filePath).toLowerCase();
  let result;
  try {
    result = await organize.moveIntoLibrary(await resolveInsideIngestDir(filePath), moveMeta, ext);
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

// dryRun previews the intended destination, without collision resolution.
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

// `confirmed` is a getRecording() result.
async function finalizeLooseFile(filePath, name, confirmed, { dryRun }) {
  const current = await tags.readTags(filePath);
  const releaseGroup = confirmed.releaseGroups[0];
  const coverImage = releaseGroup ? await getFrontCoverImage(releaseGroup.mbid) : null;

  // No release group: leave the album tag empty but file under "Singles".
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

// file[i] matches track[i] by recording MBID or by duration within tolerance.
function albumIsCoherent(perFile, tracks) {
  return perFile.every((f, i) => {
    const track = tracks[i];
    if (track.recordingMbid && f.recMbids.includes(track.recordingMbid)) return true;
    return track.lengthMs != null && Math.abs(track.lengthMs - f.durationMs) <= DURATION_TOLERANCE_MS;
  });
}

// Caps on MusicBrainz fan-out: each call is ~1s through the global rate-limit
// queue, held under the ingest lock. The coherence check is what decides.
const MAX_RECORDINGS_PER_FILE = 3;
const MAX_RELEASE_GROUPS = 8;

async function albumCandidates(files) {
  const perFile = [];
  for (const filePath of files) {
    const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
    const candidates = await lookup({ fingerprint: fp, durationSeconds });
    const recMbids = candidates
      .filter((c) => c.score >= SCORE_THRESHOLD)
      .slice(0, MAX_RECORDINGS_PER_FILE)
      .map((c) => c.recordingMbid);
    perFile.push({ filePath, durationMs: durationSeconds * 1000, recMbids });
  }

  // Rank release groups by how many files name them, so the cap keeps the likeliest.
  const recCache = new Map();
  const groupHits = new Map();
  for (const f of perFile) {
    for (const recMbid of f.recMbids) {
      if (!recCache.has(recMbid)) recCache.set(recMbid, await getRecording(recMbid));
      for (const rg of recCache.get(recMbid).releaseGroups || []) {
        groupHits.set(rg.mbid, (groupHits.get(rg.mbid) ?? 0) + 1);
      }
    }
  }
  if (groupHits.size === 0) {
    return { reason: 'no confident AcoustID matches for the album tracks' };
  }

  const releaseGroupMbids = new Set(
    [...groupHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RELEASE_GROUPS)
      .map(([mbid]) => mbid)
  );

  return { perFile, releaseGroupMbids };
}

// Returns `{ release, tracks, coverImage, files }` or `{ reason }`.
async function identifyAlbum(files) {
  if (files.length === 0) return { reason: 'this folder contains no audio files' };
  const candidates = config.acoustidApiKey
    ? await albumCandidates(files)
    : await tagMatch.albumCandidatesFromTags(files);
  if (candidates.reason || !candidates.perFile) {
    return { reason: candidates.reason ?? 'could not derive candidates for this folder' };
  }
  const { perFile, releaseGroupMbids } = candidates;

  // First release whose tracklist explains the whole folder wins.
  for (const rgMbid of releaseGroupMbids) {
    const releaseId = await resolvePrimaryReleaseForGroup(rgMbid);
    if (!releaseId) continue;
    const { release, tracks } = await getReleaseWithTracks(releaseId);
    if (tracks.length !== files.length) continue;
    if (!albumIsCoherent(perFile, tracks)) continue;
    const coverImage = await getFrontCoverImage(rgMbid);
    // perFile order: tag matching may reorder by track-number tags.
    return { release, tracks, coverImage, files: perFile.map((f) => f.filePath) };
  }
  return { reason: 'no release coherently matched the whole folder' };
}

async function processAlbumFolder(item, { dryRun }) {
  const files = await collectAlbumFiles(item.path);
  const identified = await identifyAlbum(files);
  if (identified.reason) {
    return { needsReview: [{ path: item.path, name: item.name, code: 'album_incoherent', reason: identified.reason }] };
  }

  // Matched order, not filename order.
  const { release, tracks, coverImage, files: orderedFiles } = identified;
  const multiDisc = release.discCount > 1;
  const matched = [];
  const needsReview = [];

  for (let i = 0; i < orderedFiles.length; i += 1) {
    const filePath = orderedFiles[i];
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

// One run at a time: concurrent runs race tag writes and renames on the same file.
// Rejected, not coalesced — each caller has its own onItem stream.
let inFlight = null;

export function processIngest(options = {}) {
  if (inFlight) {
    throw new BadRequestError('An ingest run is already in progress — wait for it to finish.');
  }
  inFlight = runIngest(options).finally(() => { inFlight = null; });
  return inFlight;
}

export function ingestInProgress() {
  return inFlight !== null;
}

// `onItem` streams each result as `{ kind: 'matched' | 'needsReview', ...entry }`.
async function runIngest({ dryRun = false, onItem, signal } = {}) {
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
    if (signal?.aborted) return { matched, needsReview, dryRun, aborted: true };
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

// Manual-pick candidates, including sub-threshold near-misses. Tag search without a key.
export async function findCandidatesForFile(filePath) {
  const real = await resolveInsideIngestDir(filePath);
  return config.acoustidApiKey
    ? fingerprintMatch.candidatesFromFingerprint(real)
    : tagMatch.candidatesFromTags(real);
}

// Manual override: the user already chose the recording.
export async function resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun = false }) {
  const real = await resolveInsideIngestDir(filePath);
  const confirmed = await getRecording(recordingMbid);
  // Open the validated path, not the raw one (TOCTOU).
  return finalizeLooseFile(real, name, confirmed, { dryRun });
}
