// The samplers, as pure functions: no DB, network or clock; randomness only via injected rng.

// Auto-fill only. 60s keeps short punk/hardcore; 12min drops DJ mixes and hidden-track outros.
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 720_000;

// A day: sanity ceiling on request input, not a meaningful limit.
export const MAX_DURATION_BOUND = 24 * 60 * 60 * 1000;

// Request input, clamped. A literal 0 means "no bound" (emptied field); absent means default.
export function clampDuration(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DURATION_BOUND, Math.max(0, n));
}

// Null duration means the scanner couldn't decode the stream: damaged, so excluded.
export function filterByDuration(tracks, { minMs = MIN_DURATION_MS, maxMs = MAX_DURATION_MS } = {}) {
  return tracks.filter((t) => t.durationMs != null && t.durationMs >= minMs && t.durationMs <= maxMs);
}

// Loose below ~50 tracks (the +5 dominates); shown in the UI rather than patched with a second rule.
export function perArtistCap(target, artistCount) {
  return Math.ceil(target / Math.max(1, artistCount)) + 5;
}

function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Ranked first, then chronological. The fallback matters: ListenBrainz popularity is
// disabled upstream, so popularityRank is currently always null.
function byPopularity(tracks) {
  const ranked = tracks.filter((t) => t.popularityRank != null)
    .sort((a, b) => a.popularityRank - b.popularityRank);
  const rest = tracks.filter((t) => t.popularityRank == null)
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0)
      || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
  return [...ranked, ...rest];
}

function orderFor(tracks, { method, preferPopular, rng, cap }) {
  if (method === 'popular') return byPopularity(tracks);

  // Chance. prefer-popular shuffles only the top 2*cap; no-op for unranked artists.
  const ranked = tracks.filter((t) => t.popularityRank != null);
  const slice = preferPopular && ranked.length
    ? byPopularity(ranked).slice(0, 2 * cap)
    : tracks;
  return shuffle(slice, rng);
}

/**
 * @returns {{picked: object[], cap: number, stopped: 'target'|'budget'|'exhausted'|'cap'}}
 */
export function fillPlaylist({
  pool,
  target,
  byteBudget = null,
  method = 'popular',
  preferPopular = false,
  rng = Math.random,
  existingKeys = new Set(),
}) {
  const available = pool.filter((t) => !existingKeys.has(t.matchKey));

  const byArtist = new Map();
  for (const t of available) {
    if (!byArtist.has(t.artist)) byArtist.set(t.artist, []);
    byArtist.get(t.artist).push(t);
  }

  const cap = perArtistCap(target, byArtist.size);

  // Strongest neighbours first, so a small target represents them.
  const queues = [...byArtist.entries()]
    .sort((a, b) => (b[1][0].signalScore ?? 0) - (a[1][0].signalScore ?? 0))
    .map(([artist, tracks]) => ({
      artist,
      taken: 0,
      remaining: orderFor(tracks, { method, preferPopular, rng, cap }),
    }));

  const picked = [];
  let bytes = 0;
  let cappedOut = false;
  let budgetBlocked = false;

  // Round-robin so the result is spread, not proportional to how much of each artist you own.
  let progressed = true;
  while (picked.length < target && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= target) break;
      if (queue.taken >= cap) { cappedOut = true; continue; }

      while (queue.remaining.length) {
        const candidate = queue.remaining.shift();
        // Skip an oversized track rather than ending the fill.
        if (byteBudget != null && bytes + (candidate.sizeBytes ?? 0) > byteBudget) {
          budgetBlocked = true;
          continue;
        }
        picked.push(candidate);
        bytes += candidate.sizeBytes ?? 0;
        queue.taken += 1;
        progressed = true;
        break;
      }
    }
  }

  // Cap before budget: when cappedOut is set the cap truly bound, and 'budget' would
  // tell the user to raise a number that wouldn't change the result.
  let stopped = 'exhausted';
  if (picked.length >= target) stopped = 'target';
  else if (cappedOut) stopped = 'cap';
  else if (budgetBlocked) stopped = 'budget';

  return { picked, cap, stopped };
}
