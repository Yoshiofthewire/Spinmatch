import path from 'node:path';

// Files this process just wrote, so the MUSIC_DIR watcher ignores our own edits.
// Not a lock: an external change inside the window is caught by the interval scan.
const WINDOW_MS = 30_000;

// Keyed on basename: fs.watch doesn't reliably report full paths. Collisions only skip a trigger.
const recent = new Map();

export function noteWrite(filePath) {
  const key = path.basename(filePath);
  recent.set(key, Date.now() + WINDOW_MS);
  // Opportunistic sweep bounds the map.
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
