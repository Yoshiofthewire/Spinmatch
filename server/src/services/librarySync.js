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

  const runScan = async () => {
    // Coalesce overlapping scans: the interval timer and the watch debounce
    // can both fire runScan around the same time. Since scanLibrary() builds
    // its own `seen` set across async yields, two overlapping runs can race
    // and cause a file created during run A to be wrongly markRemoved by run
    // B. Skip a second scan entirely while one is already in flight rather
    // than queue it -- the next scheduled/debounced scan will pick up
    // whatever changed in the meantime.
    if (scanning) return;
    scanning = true;
    try {
      await scan();
    } catch (err) {
      console.warn(`librarySync: scan failed: ${err.message}`);
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
      // Falling back to the shortest interval is the safe choice, but silently
      // is not: a database that can't be read is worth knowing about.
      console.warn(`librarySync: could not read collection size, using the default interval: ${err.message}`);
    }
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
      watcher = fs.watch(config.ingest.musicDir, { recursive: true }, (eventType, filename) => {
        // Ignore the app's own writes. Every tag repair changes an mtime, so a
        // 500-file bulk fix fired 500 watch events, which debounced into a full
        // library scan — one that then re-read the tags of all 500 files, since
        // the app had just changed every one of their change_keys. The individual
        // reindexFile calls had already done that work.
        if (filename && wasWrittenByUs(filename)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(runScan, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
      // Without this the watcher is a live grenade. Recursive fs.watch on Linux
      // takes one inotify watch per directory, and a large library against the
      // default max_user_watches hits ENOSPC — which arrives as an 'error' event,
      // and an EventEmitter 'error' with no listener throws. That went to the
      // global uncaughtException handler, printed one line, and left the app
      // reporting itself healthy with file-change detection silently dead.
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
    // Whether file-change detection is actually running. Surfaced so an operator
    // can tell "nothing changed" from "the watcher died and nobody said so".
    watching: () => watcher !== null,
    // Exposed only so tests can prove the concurrency guard above coalesces
    // overlapping scans; not used by production callers.
    _triggerScan: runScan,
  };
}
