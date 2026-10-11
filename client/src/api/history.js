import { get, post, del } from './client.js';

// Waits for the one-time import, so a first visit to History already shows it.
export async function getHistory({ limit, offset = 0 }) {
  await importLegacyHistory();
  return get(`/history?limit=${limit}&offset=${offset}`);
}

export function clearHistory() {
  return del('/history');
}

const LEGACY_KEY = 'spinmatch:history';

let importing = null;

// One-time move of pre-server browser history. The server skips repeats, so two
// tabs racing is harmless; the key goes only once the server has the entries, and
// a failure is forgotten so the next read tries again.
export function importLegacyHistory() {
  if (localStorage.getItem(LEGACY_KEY) == null) return Promise.resolve();
  importing ??= moveLegacyHistory().finally(() => { importing = null; }).catch(() => {});
  return importing;
}

async function moveLegacyHistory() {
  let entries;
  try {
    entries = JSON.parse(localStorage.getItem(LEGACY_KEY));
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;
  await post('/history/import', { entries });
  localStorage.removeItem(LEGACY_KEY);
}
