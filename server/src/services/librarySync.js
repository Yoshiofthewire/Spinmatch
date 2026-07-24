import fs from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { getStats } from './libraryRepo.js';
import { scanLibrary } from './libraryScanner.js';

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

  const runScan = async () => {
    try {
      await scan();
    } catch (err) {
      console.warn(`librarySync: scan failed: ${err.message}`);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    let count = 0;
    try { count = getStats(getDb()).totalTracks; } catch { count = 0; }
    timer = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, intervalForSize(count));
    timer.unref?.();
  };

  // Kick off the initial scan, then schedule the recurring one.
  runScan().then(scheduleNext);

  if (watch && config.ingest.musicDir) {
    try {
      watcher = fs.watch(config.ingest.musicDir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(runScan, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
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
  };
}
