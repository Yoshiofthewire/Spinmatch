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
// Under the server's 256 KiB JSON limit, with room for the wrapper.
const MAX_BATCH_BYTES = 200 * 1024;
const MAX_BATCH_ENTRIES = 200;

let importing = null;

// Storage can throw (blocked cookies, private modes); history then simply has nothing to move.
function storage(fn) {
  try {
    return fn(localStorage);
  } catch {
    return null;
  }
}

// One-time move of pre-server browser history. The server skips repeats, so two
// tabs racing is harmless; the key goes only once the server has every entry, and
// a failure is forgotten so the next read tries again.
export function importLegacyHistory() {
  if (storage((s) => s.getItem(LEGACY_KEY)) == null) return Promise.resolve();
  importing ??= moveLegacyHistory().finally(() => { importing = null; }).catch(() => {});
  return importing;
}

// Batches bounded by size as well as count, so long titles can't exceed the body limit.
export function batchEntries(entries) {
  const encoder = new TextEncoder();
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(entry)).length + 1;
    if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_ENTRIES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function moveLegacyHistory() {
  let entries;
  try {
    entries = JSON.parse(storage((s) => s.getItem(LEGACY_KEY)));
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;
  for (const batch of batchEntries(entries)) await post('/history/import', { entries: batch });
  storage((s) => s.removeItem(LEGACY_KEY));
}
