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

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
// Write in batches so the SQLite write lock is released periodically (letting a
// concurrent login/auth write through) instead of held for one giant commit.
const WRITE_CHUNK = 5000;

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function changeKeyFor(stat) {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir -> skip subtree
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      yield full;
    }
  }
}

// The single place a file on disk becomes a local_tracks row. Shared by the full
// scan and the targeted rescan below so the two can never disagree about how a
// file is indexed.
export function rowFor(filePath, stat, meta) {
  const ext = path.extname(filePath);
  return {
    path: filePath,
    artist: meta.artist ?? null,
    album: meta.album ?? path.basename(path.dirname(filePath)),
    title: meta.title ?? path.basename(filePath, ext),
    // taglib reports fractional milliseconds for some formats; round so the
    // INTEGER column and the summed totals stay whole numbers.
    durationMs: meta.durationMs == null ? null : Math.round(meta.durationMs),
    trackNumber: meta.trackNumber ?? null,
    disc: meta.disc ?? null,
    year: meta.year ?? null,
    genre: meta.genre ?? null,
    hasCoverArt: meta.hasCoverArt ? 1 : 0,
    // From the stat the caller already took, so this costs nothing extra.
    ext: ext.replace(/^\./, '').toLowerCase() || null,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    changeKey: changeKeyFor(stat),
  };
}

// Shared across every caller (the interval timer, the fs-watch debounce, and
// the manual POST /api/library/scan route) so a scan started from any of them
// coalesces onto the one in flight instead of racing it. Two concurrent scans
// build independent `seen` sets, so a file created mid-scan could be wrongly
// markRemoved()'d by whichever run finishes last — this prevents that.
let inFlight = null;
let activeWorker = null;

// Hard ceiling on one scan. Without it a worker wedged on an unresponsive mount
// never settles its promise, `inFlight` is never cleared, and every subsequent
// scanLibrary() hands back that same dead promise — the Rescan button spins
// forever until the container restarts. Generous enough that a real 100k-track
// first scan over a slow disk finishes well inside it.
const SCAN_TIMEOUT_MS = 60 * 60 * 1000;

// Runs the scan in a worker thread so its synchronous, CPU-bound work — a tag
// read per file (node-taglib-sharp is sync) and the DB writes — never blocks
// the main event loop. At 100k tracks the main thread stays fully responsive
// (dashboard reads hit the same WAL DB from a separate connection). The worker
// opens its own DB connection from the same config.library.dbPath.
export function scanLibrary() {
  if (inFlight) return inFlight;
  inFlight = spawnScanWorker().finally(() => { inFlight = null; activeWorker = null; });
  return inFlight;
}

// Terminates a scan in progress, so shutdown doesn't wait on a worker that may
// be blocked in a filesystem call. Chunked commits mean the index is left at a
// consistent (if incomplete) point; the next scan reconciles the rest.
export async function stopScan() {
  if (activeWorker) await activeWorker.terminate();
}

function spawnScanWorker() {
  return new Promise((resolve, reject) => {
    // execArgv: [] so the worker doesn't inherit the parent's CLI flags (e.g.
    // `--test` under the test runner, or `--env-file`); process.env is still
    // inherited, so config.js resolves MUSIC_DIR/LIBRARY_DB normally.
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

    worker.once('message', (msg) => {
      if (msg.ok) settle(resolve, msg.summary);
      else settle(reject, new Error(msg.error));
    });
    worker.once('error', (err) => settle(reject, err));
    worker.once('exit', (code) => {
      settle(reject, new Error(`library scan worker exited with code ${code}`));
    });
  });
}

// The actual scan. Exported so it runs directly inside the worker thread (and
// in-process in unit tests, where tags.js is mocked and getDb() is an in-memory
// DB). Not called on the main thread in production — scanLibrary() spawns it.
export async function runScanOnce() {
  const root = config.ingest.musicDir;
  const db = getDb();

  // If the music root itself is unreadable (unmounted volume, permissions),
  // treat it as fatal and bail BEFORE any writes — an empty walk would
  // otherwise markRemoved() the entire library. Deep unreadable subdirs are
  // still skipped gracefully by walk().
  try {
    await fs.access(root, fs.constants.R_OK);
  } catch {
    console.warn(`libraryScanner: MUSIC_DIR is unreadable, skipping scan to protect the index: ${root}`);
    return { scanned: 0, added: 0, updated: 0, removed: 0, skipped: true };
  }

  const known = getChangeKeys(db);
  const seen = new Set();
  const toUpsert = [];
  let scanned = 0;
  let added = 0;
  let updated = 0;

  // Phase 1 (async IO): walk, stat, and read tags for changed files only,
  // collecting the rows to write. No DB mutation happens here.
  for await (const filePath of walk(root)) {
    scanned += 1;
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
      // Keep it in `seen` so a transient read failure doesn't mark an
      // already-indexed track removed; a brand-new unreadable file simply has
      // no row yet, so this is harmless.
      continue;
    }

    if (!known.has(filePath)) added += 1; else updated += 1;
    toUpsert.push(rowFor(filePath, stat, meta));
  }

  // Phase 2 (chunked transactions): batch the upserts so each commit is one
  // fsync for thousands of rows (not one per row), while still releasing the
  // write lock between chunks so a concurrent auth write isn't starved on a
  // 100k-track scan. Removal + stats commit last so counts settle atomically.
  for (let i = 0; i < toUpsert.length; i += WRITE_CHUNK) {
    const batch = toUpsert.slice(i, i + WRITE_CHUNK);
    withTransaction(db, () => {
      for (const row of batch) upsertLocalTrack(db, row);
    });
  }
  withTransaction(db, () => {
    markRemoved(db, seen);
    // Tombstones exist so a file on a temporarily-unavailable volume isn't
    // forgotten and then re-added as brand new (losing its added_at). After a
    // month it isn't coming back, and keeping the row makes every later scan's
    // getChangeKeys() and every COUNT pay for it.
    purgeRemoved(db);
    recomputeStats(db);
  });

  const removed = known.size - [...known.keys()].filter((p) => seen.has(p)).length;
  return { scanned, added, updated, removed };
}

// Re-reads one file's tags and updates its row. Used after the fix flow writes
// tags, so the index reflects the new values without waiting for a full scan.
// Runs on the main thread: it's a single tag read, the same cost the ingest
// flow already pays per file.
export async function reindexFile(filePath) {
  assertInsideMusicDir(filePath);
  const db = getDb();
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // The file went away between the tag write and here. Marking it removed is
    // the honest outcome; a full scan would reach the same conclusion.
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

// Rescans just the given directories instead of all of MUSIC_DIR. Unlike
// runScanOnce this must NOT call markRemoved(), which reconciles against the
// whole library and would wipe every track outside these directories — removals
// are resolved per known path within the subtree instead.
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
  const toUpsert = [];
  let added = 0;
  let updated = 0;

  for (const root of roots) {
    for await (const filePath of walk(root)) {
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

  const gone = knownInScope.filter((p) => !seen.has(p));
  withTransaction(db, () => {
    for (const row of toUpsert) upsertLocalTrack(db, row);
    for (const p of gone) markRemovedByPath(db, p);
    recomputeStats(db);
  });

  return { scanned: seen.size, added, updated, removed: gone.length };
}
