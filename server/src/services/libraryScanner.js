import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { readTags } from './tags.js';
import { getDb, withTransaction } from '../lib/db.js';
import {
  upsertLocalTrack, getChangeKeys, markRemoved, markRemovedByPath, recomputeStats,
  purgeRemoved,
} from './libraryRepo.js';
import { assertInsideMusicDir } from '../lib/paths.js';
import {
  MAX_TRACK_NUMBER, MAX_DISC_NUMBER, MIN_YEAR, MAX_YEAR,
} from '../lib/tagLimits.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
// Batch writes so the SQLite write lock is released for concurrent auth writes.
const WRITE_CHUNK = 5000;
// Files walked between progress messages from the worker.
export const PROGRESS_EVERY = 250;

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function changeKeyFor(stat) {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

// Out-of-range becomes null at index time, so downstream readers are safe (see lib/tagLimits.js).
function boundedInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= min && i <= max ? i : null;
}

// The dot-skip checks entries, not `dir`: a dot-prefixed root (the trash) would
// be indexed. Callers must only pass live indexed paths.
// `unreadable` collects unlistable dirs so callers don't mark their tracks removed.
async function* walk(dir, unreadable) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`libraryScanner: could not read ${dir}, skipping subtree: ${err.message}`);
    unreadable.add(dir);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, unreadable);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      yield full;
    }
  }
}

function isUnderAny(filePath, dirs) {
  for (const dir of dirs) {
    if (filePath.startsWith(dir + path.sep)) return true;
  }
  return false;
}

// The single place a file becomes a local_tracks row.
export function rowFor(filePath, stat, meta) {
  const ext = path.extname(filePath);
  // Folder/file names stand in for missing album/title; the flags let Health count the gaps.
  const albumSynthesized = meta.album == null;
  const titleSynthesized = meta.title == null;
  return {
    path: filePath,
    artist: meta.artist ?? null,
    album: meta.album ?? path.basename(path.dirname(filePath)),
    title: meta.title ?? path.basename(filePath, ext),
    albumSynthesized: albumSynthesized ? 1 : 0,
    titleSynthesized: titleSynthesized ? 1 : 0,
    // taglib can report fractional ms; the column is INTEGER.
    durationMs: meta.durationMs == null ? null : Math.round(meta.durationMs),
    trackNumber: boundedInt(meta.trackNumber, 1, MAX_TRACK_NUMBER),
    disc: boundedInt(meta.disc, 1, MAX_DISC_NUMBER),
    year: boundedInt(meta.year, MIN_YEAR, MAX_YEAR),
    genre: meta.genre ?? null,
    hasCoverArt: meta.hasCoverArt ? 1 : 0,
    ext: ext.replace(/^\./, '').toLowerCase() || null,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    changeKey: changeKeyFor(stat),
  };
}

// All callers coalesce onto one scan: concurrent scans could wrongly mark files removed.
let inFlight = null;
let activeWorker = null;

// Stops a worker wedged on a dead mount from pinning `inFlight` forever.
const SCAN_TIMEOUT_MS = 60 * 60 * 1000;

// Worker thread: tag reads (sync taglib) and DB writes would block the event loop.
// A caller joining a scan in flight gets its result but not its progress.
export function scanLibrary({ onProgress } = {}) {
  if (inFlight) return inFlight;
  inFlight = spawnScanWorker(onProgress).finally(() => { inFlight = null; activeWorker = null; });
  return inFlight;
}

// Safe mid-scan: chunked commits leave a consistent index; the next scan reconciles.
export async function stopScan() {
  if (activeWorker) await activeWorker.terminate();
}

function spawnScanWorker(onProgress) {
  return new Promise((resolve, reject) => {
    // Don't inherit CLI flags like --test; process.env is still inherited.
    const worker = new Worker(new URL('./libraryScanWorker.js', import.meta.url), { execArgv: [] });
    activeWorker = worker;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      settle(reject, new Error(`library scan exceeded ${SCAN_TIMEOUT_MS}ms and was terminated`));
    }, SCAN_TIMEOUT_MS);
    timer.unref?.();

    worker.on('message', (msg) => {
      if ('progress' in msg) onProgress?.(msg.progress);
      else if (msg.ok) settle(resolve, msg.summary);
      else settle(reject, new Error(msg.error));
    });
    worker.once('error', (err) => settle(reject, err));
    worker.once('exit', (code) => {
      settle(reject, new Error(`library scan worker exited with code ${code}`));
    });
  });
}

// Runs inside the worker (or in-process in tests); production uses scanLibrary().
export async function runScanOnce({ onProgress } = {}) {
  const root = config.ingest.musicDir;
  const db = getDb();

  // Unreadable root: bail before writes, or an empty walk removes the whole library.
  try {
    await fs.access(root, fs.constants.R_OK);
  } catch {
    console.warn(`libraryScanner: MUSIC_DIR is unreadable, skipping scan to protect the index: ${root}`);
    return { scanned: 0, added: 0, updated: 0, removed: 0, skipped: true };
  }

  const known = getChangeKeys(db);
  const seen = new Set();
  const unreadableDirs = new Set();
  const toUpsert = [];
  let scanned = 0;
  let added = 0;
  let updated = 0;

  // Phase 1: read tags of changed files; no DB writes.
  for await (const filePath of walk(root, unreadableDirs)) {
    scanned += 1;
    if (scanned % PROGRESS_EVERY === 0) onProgress?.(scanned);
    seen.add(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const changeKey = changeKeyFor(stat);
    if (known.get(filePath) === changeKey) continue; // unchanged -> no tag read

    let meta;
    try {
      meta = await readTags(filePath);
    } catch (err) {
      console.warn(`libraryScanner: skipping unreadable file ${filePath}: ${err.message}`);
      // Stays in `seen`: a transient read failure must not mark it removed.
      continue;
    }

    if (!known.has(filePath)) added += 1; else updated += 1;
    toUpsert.push(rowFor(filePath, stat, meta));
  }

  // Unlistable subtrees count as "still there"; the next good scan corrects removals.
  for (const filePath of known.keys()) {
    if (!seen.has(filePath) && isUnderAny(filePath, unreadableDirs)) seen.add(filePath);
  }

  // Phase 2: chunked upserts; removal + stats commit last, atomically.
  for (let i = 0; i < toUpsert.length; i += WRITE_CHUNK) {
    const batch = toUpsert.slice(i, i + WRITE_CHUNK);
    withTransaction(db, () => {
      for (const row of batch) upsertLocalTrack(db, row);
    });
  }
  // Only paths known at scan start: a row indexed mid-scan (ingest, a tag fix)
  // was never walked and must not be swept.
  const gone = [...known.keys()].filter((p) => !seen.has(p));
  withTransaction(db, () => {
    markRemoved(db, gone);
    // Tombstones preserve added_at across a missing volume; purged after a month.
    purgeRemoved(db);
    recomputeStats(db);
  });

  return { scanned, added, updated, removed: gone.length };
}

// Re-index one file after a tag write. Main thread: it's a single tag read.
export async function reindexFile(filePath) {
  assertInsideMusicDir(filePath);
  const db = getDb();
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    withTransaction(db, () => {
      markRemovedByPath(db, filePath);
      recomputeStats(db);
    });
    return { indexed: false };
  }
  const meta = await readTags(filePath);
  withTransaction(db, () => {
    upsertLocalTrack(db, rowFor(filePath, stat, meta));
    recomputeStats(db);
  });
  return { indexed: true };
}

// Must not call markRemoved(): it would wipe every track outside `dirs`.
export async function rescanDirs(dirs) {
  const db = getDb();
  const roots = dirs.map((dir) => {
    assertInsideMusicDir(dir);
    return path.resolve(dir);
  });
  const inScope = (p) => roots.some((root) => p === root || p.startsWith(root + path.sep));

  const known = getChangeKeys(db);
  const knownInScope = [...known.keys()].filter(inScope);
  const seen = new Set();
  const unreadableDirs = new Set();
  const toUpsert = [];
  let added = 0;
  let updated = 0;

  for (const root of roots) {
    for await (const filePath of walk(root, unreadableDirs)) {
      seen.add(filePath);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (known.get(filePath) === changeKeyFor(stat)) continue;
      let meta;
      try {
        meta = await readTags(filePath);
      } catch (err) {
        console.warn(`libraryScanner: skipping unreadable file ${filePath}: ${err.message}`);
        seen.add(filePath);
        continue;
      }
      if (!known.has(filePath)) added += 1; else updated += 1;
      toUpsert.push(rowFor(filePath, stat, meta));
    }
  }

  // As in the full scan, unlistable dirs say nothing about their tracks.
  const gone = knownInScope.filter((p) => !seen.has(p) && !isUnderAny(p, unreadableDirs));
  withTransaction(db, () => {
    for (const row of toUpsert) upsertLocalTrack(db, row);
    for (const p of gone) markRemovedByPath(db, p);
    recomputeStats(db);
  });

  return { scanned: seen.size, added, updated, removed: gone.length };
}
