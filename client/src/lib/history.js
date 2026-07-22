const STORAGE_KEY = 'spinmatch:history';
const MAX_ENTRIES = 200;

export function getHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addEntry({ track, artist, album, action }) {
  try {
    const entries = [{ track, artist, album, action, timestamp: Date.now() }, ...getHistory()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage unavailable/full — history is best-effort, never blocks the caller
  }
}

export function clearHistory() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
