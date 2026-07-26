import path from 'node:path';

// Remembers, briefly, which files this process just wrote, so the MUSIC_DIR
// watcher can tell the app's own edits apart from someone else's.
//
// Without it the library was in a feedback loop with itself: every tag repair
// changes an mtime, fs.watch fires, the 2-second debounce collapses the burst
// into one full scanLibrary() — and because the repair changed every touched
// file's change_key, that scan then re-read the tags of every file the repair
// had just individually reindexed. A 500-track bulk fix paid for its own work
// twice and blocked the watcher's real job behind it.
//
// The window is short on purpose. This is a debounce companion, not a lock: if a
// real external change lands on the same file inside the window it is picked up
// by the next interval scan, which is the same guarantee the watcher itself
// offers when it misses an event.
const WINDOW_MS = 30_000;

// Keyed on the basename, not the full path: fs.watch's recursive mode reports
// paths relative to the watched root on Linux and (historically) just the
// filename on some platforms, so the full path is not something the callback can
// be relied on to hand back. A basename collision only costs one skipped scan
// trigger, which the interval scan covers.
const recent = new Map();

export function noteWrite(filePath) {
  const key = path.basename(filePath);
  recent.set(key, Date.now() + WINDOW_MS);
  // Opportunistic sweep so the map can't grow with every file ever written.
  if (recent.size > 2000) {
    const now = Date.now();
    for (const [k, expiresAt] of recent) {
      if (expiresAt <= now) recent.delete(k);
    }
  }
}

export function wasWrittenByUs(filename) {
  const key = path.basename(filename);
  const expiresAt = recent.get(key);
  if (expiresAt == null) return false;
  if (expiresAt <= Date.now()) {
    recent.delete(key);
    return false;
  }
  return true;
}

// Test seam.
export function clearRecentWrites() {
  recent.clear();
}
