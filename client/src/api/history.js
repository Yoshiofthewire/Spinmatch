import { get, post, del } from './client.js';

export function getHistory({ limit, offset = 0 }) {
  return get(`/history?limit=${limit}&offset=${offset}`);
}

export function clearHistory() {
  return del('/history');
}

const LEGACY_KEY = 'spinmatch:history';

// One-time move of pre-server browser history. The server skips repeats, so two
// tabs racing this is harmless; the key goes only once the server has the entries.
export async function importLegacyHistory() {
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
