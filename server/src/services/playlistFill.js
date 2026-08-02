// The samplers, as pure functions.
//
// No database, no network, no clock, and randomness only through an injected
// rng. That is deliberate: the cap arithmetic, the round-robin spread, the
// greedy byte fill and the four stop conditions are where the subtle bugs in
// this feature live, and this shape lets every one of them be tested against a
// literal array with no mocking at all.

// Auto-fill only. A track added by hand is the user's call, not the sampler's.
//
// 60s rather than 90s: plenty of punk and hardcore is legitimately 45-90
// seconds, and silently eating a genre is worse than admitting the occasional
// interlude. 12 minutes keeps most prog and post-rock while dropping DJ mixes
// and hidden-track outros — it does exclude "Echoes", which is the honest cost
// of a single number.
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 720_000;

/**
 * A null duration is excluded, not kept. The Health tab already establishes what
 * it means: the scanner could not decode the audio stream, so the file is
 * damaged — it would not play on the target device either.
 */
export function filterByDuration(tracks, { minMs = MIN_DURATION_MS, maxMs = MAX_DURATION_MS } = {}) {
  return tracks.filter((t) => t.durationMs != null && t.durationMs >= minMs && t.durationMs <= maxMs);
}

/**
 * How many tracks one artist may contribute.
 *
 * Slack below ~50 tracks, where the +5 dominates the average — on a 20-track
 * playlist one artist can still take a third. Left as-is rather than corrected
 * with a second rule, and surfaced in the UI so the number is visible when it
 * behaves oddly.
 */
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

// Ranked first, in rank order; then everything else chronologically.
//
// That second half is doing real work right now. The ListenBrainz popularity
// API is disabled upstream, so popularityRank is null for every track until it
// returns — and without a fallback ordering "Popular" would just be Chance under
// another name. Album year then track number is a chronological walk of what you
// own by an artist: deterministic, useful, and not pretending to be a popularity
// claim.
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

  // Chance. prefer-popular narrows the draw to the artist's top 2*cap by
  // popularity before shuffling — enough headroom that a reshuffle still varies,
  // while staying out of the deep cuts. An artist with no popularity data has
  // nothing to narrow to, so the toggle is a no-op there rather than an empty
  // list.
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

  // Artists in descending signal strength, so when the target is small the
  // strongest neighbours are the ones represented.
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

  // Round-robin rather than one artist at a time, so the cap is rarely what
  // stops the fill and the result is spread rather than proportional to how much
  // of each artist you happen to own.
  let progressed = true;
  while (picked.length < target && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= target) break;
      if (queue.taken >= cap) { cappedOut = true; continue; }

      while (queue.remaining.length) {
        const candidate = queue.remaining.shift();
        // An oversized track is skipped, not fatal: one 180MB lossless file must
        // not end a fill with 400MB still free.
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

  // Cap before budget: cappedOut is only ever set by a real, unblocked pick
  // reaching the cap, so when it is true the cap genuinely bound the fill — a
  // budget block can delay or prevent that, but never trigger it early. Without
  // this order, an oversized track skipped on the way to a cap that was going
  // to bind anyway gets reported as 'budget', which tells the user to raise a
  // number that would not change the result.
  let stopped = 'exhausted';
  if (picked.length >= target) stopped = 'target';
  else if (cappedOut) stopped = 'cap';
  else if (budgetBlocked) stopped = 'budget';

  return { picked, cap, stopped };
}
