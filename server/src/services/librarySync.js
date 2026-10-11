import fs from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { getStats } from './libraryRepo.js';
import { scanLibrary } from './libraryScanner.js';
import { wasWrittenByUs } from '../lib/recentWrites.js';

const HALF_HOUR = 30 * 60_000;
const TWO_HOURS = 2 * 60 * 60_000;
const FOUR_HOURS = 4 * 60 * 60_000;
const WATCH_DEBOUNCE_MS = 2000;

export function intervalForSize(trackCount) {
  if (trackCount < 1000) return HALF_HOUR;
  if (trackCount <= 10000) return TWO_HOURS;
  return FOUR_HOURS;
}

export function startLibrarySync({ scan = scanLibrary, watch = true } = {}) {
  let timer = null;
  let watcher = null;
  let debounce = null;
  let stopped = false;
  let scanning = false;
  let dirty = false;

  // One scan at a time; a mid-scan trigger buys exactly one more.
  const runScan = async () => {
    if (scanning) {
      dirty = true;
      return;
    }
    scanning = true;
    try {
      do {
        dirty = false;
        try {
          await scan();
        } catch (err) {
          console.warn(`librarySync: scan failed: ${err.message}`);
        }
      } while (dirty && !stopped);
    } finally {
      scanning = false;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    let count = 0;
    try {
      count = getStats(getDb()).totalTracks;
    } catch (err) {
      console.warn(`librarySync: could not read collection size, using the default interval: ${err.message}`);
    }
    timer = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, intervalForSize(count));
    timer.unref?.();
  };

  runScan().then(scheduleNext);

  if (watch && config.ingest.musicDir) {
    try {
      watcher = fs.watch(config.ingest.musicDir, { recursive: true }, (eventType, filename) => {
        // Our own writes are already reindexed; don't rescan for them.
        if (filename && wasWrittenByUs(filename)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(runScan, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
      // An unhandled 'error' (e.g. ENOSPC on inotify limits) would throw.
      watcher.on('error', (err) => {
        console.warn(`librarySync: watch on MUSIC_DIR failed, falling back to interval scans only: ${err.message}`);
        if (err.code === 'ENOSPC') {
          console.warn('librarySync: this is usually the inotify watch limit — raise fs.inotify.max_user_watches.');
        }
        try { watcher.close(); } catch { /* already gone */ }
        watcher = null;
      });
    } catch (err) {
      console.warn(`librarySync: could not watch MUSIC_DIR: ${err.message}`);
    }
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (debounce) clearTimeout(debounce);
      if (watcher) watcher.close();
    },
    watching: () => watcher !== null,
    // Test seam.
    _triggerScan: runScan,
  };
}
