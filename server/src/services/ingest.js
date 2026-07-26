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
import { RateLimitedError, BadRequestError } from '../lib/httpErrors.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
const SCORE_THRESHOLD = config.matching.acoustidMinScore;
const DURATION_TOLERANCE_MS = config.matching.durationToleranceMs;

// Paths reaching this module from the manual-override routes are client-
// supplied. Resolve BOTH the target and the root through fs.realpath so a
// symlink planted in INGEST_DIR that points at, say, /etc/passwd is rejected —
// path.resolve() alone only normalizes "..", it does not follow symlinks, so it
// would have let the link's in-tree name pass while the real target escaped.
//
// Returns the resolved path, and callers must use it rather than the one they
// were given. Checking one path and then opening another is a time-of-check /
// time-of-use gap: the two callers below make an uncached MusicBrainz request in
// between, so the window is seconds wide, and a symlink swapped into it would be
// followed by the tag write. The message deliberately omits the path — the
// client already knows what it sent, and the error is relayed to the browser.
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

// Natural sort, so "10 - x.mp3" follows "2 - x.mp3". A plain lexicographic sort
// mis-orders any album with 10+ un-zero-padded track numbers, which then fails
// the positional coherence check for the whole folder.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// The audio files of an album folder, including one level of disc subfolders —
// "Album/CD1", "Album/Disc 2" and friends, which is how most multi-disc rips are
// laid out and which used to be invisible to ingest entirely. Ordered by
// subfolder then filename so file[i] lines up with track[i] across discs.
// Symlinks are skipped at both levels, same as everywhere else in this module.
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
    // The Docker image sets INGEST_DIR unconditionally, so "enabled but the
    // drop-folder was never mounted" is a normal state rather than a fault:
    // report it as empty instead of failing the page. Only ENOENT — a
    // permissions problem is a real misconfiguration and still surfaces.
    if (err.code === 'ENOENT') return { items: [] };
    throw err;
  }
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Skip symlinks entirely: a link planted in INGEST_DIR could point the
    // fingerprint/tag/move pipeline at a file outside it (see also the realpath
    // guard on the manual-override path).
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

/**
 * Identifies one loose file. Same two-outcome shape as
 * tagMatch.identifyFileFromTags: `{ confirmed, reason }`, with exactly one set.
 *
 * @param {string} filePath
 * @returns {Promise<{confirmed: object|null, reason: string|null}>}
 */
async function identifyFile(filePath) {
  // No API key (or no key obtainable — AcoustID's registration has been down):
  // fall back to matching on the file's existing tags rather than punting the
  // whole file to manual review.
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
    return tags.writeTags(filePath, desired, { coverImage });
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

// Per-file durations (plus any candidate recording MBIDs) and the release
// groups worth checking the folder against. Either fingerprints every file, or
// — without an AcoustID key — derives both from the files' own tags.
async function albumCandidates(files) {
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

  return { perFile, releaseGroupMbids };
}

// Returns either `{ release, tracks, coverImage, files }` on success or
// `{ reason }` on failure — never a mixture. Callers discriminate on `reason`.
async function identifyAlbum(files) {
  if (files.length === 0) return { reason: 'this folder contains no audio files' };
  const candidates = config.acoustidApiKey
    ? await albumCandidates(files)
    : await tagMatch.albumCandidatesFromTags(files);
  // The two producers return one shape or the other; treating a missing perFile
  // as a failure means a future third producer can't leak `undefined` into the
  // coherence check below.
  if (candidates.reason || !candidates.perFile) {
    return { reason: candidates.reason ?? 'could not derive candidates for this folder' };
  }
  const { perFile, releaseGroupMbids } = candidates;

  // First release-group that resolves to a release whose tracklist coherently
  // explains the whole folder wins (all-or-nothing at the folder level).
  for (const rgMbid of releaseGroupMbids) {
    const releaseId = await resolvePrimaryReleaseForGroup(rgMbid);
    if (!releaseId) continue;
    const { release, tracks } = await getReleaseWithTracks(releaseId);
    if (tracks.length !== files.length) continue;
    if (!albumIsCoherent(perFile, tracks)) continue;
    const coverImage = await getFrontCoverImage(rgMbid);
    // `files` in perFile order: the tag-based path may reorder a folder by its
    // track-number tags, and the caller pairs file[i] with track[i].
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

  // identifyAlbum hands back the files in the order it matched them against the
  // tracklist, which is not necessarily the filename order above.
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

// Only one ingest run at a time, process-wide. Two concurrent runs walk the same
// directory and reach the same file: that's two node-taglib-sharp writers racing
// on one save(), and two moveIntoLibrary() calls racing on one rename — a
// corrupted audio file, not an error message. A double-clicked button or an
// EventSource retry is enough to trigger it.
//
// Unlike scanLibrary(), a second caller can't be coalesced onto the run in
// flight: each has its own onItem stream and expects its own results. Reject.
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

// `onItem`, when given, is called once per completed item as it resolves
// (`{ kind: 'matched' | 'needsReview', ...entry }`) so callers can stream
// progress. Without it, behaviour is identical — everything is just collected.
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
    // Stop between items if the caller aborted (e.g. the SSE client
    // disconnected) so we don't keep tagging/moving files with nobody watching.
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

// Candidates for a human to pick from when auto-matching failed, keeping every
// candidate rather than only ones above SCORE_THRESHOLD — the near-misses are
// the point. Which of the two sources answers depends on the key: without one
// there are no fingerprint near-misses to offer, so the picker is seeded with
// what MusicBrainz returns for the file's own tags instead.
export async function findCandidatesForFile(filePath) {
  const real = await resolveInsideIngestDir(filePath);
  return config.acoustidApiKey
    ? fingerprintMatch.candidatesFromFingerprint(real)
    : tagMatch.candidatesFromTags(real);
}

// Manual-override counterpart to the automatic identify-then-finalize flow:
// the recording is already chosen (by the user, via findCandidatesForFile's
// near-misses or a text search), so just resolve it and finalize.
export async function resolveLooseFileOverride({ filePath, name, recordingMbid, dryRun = false }) {
  const real = await resolveInsideIngestDir(filePath);
  const confirmed = await getRecording(recordingMbid);
  // `real`, not `filePath`: getRecording above is a network call, and the path
  // that gets opened has to be the one that was actually validated.
  return finalizeLooseFile(real, name, confirmed, { dryRun });
}
