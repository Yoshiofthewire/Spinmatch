import test from 'node:test';
import assert from 'node:assert/strict';

const {
  filterByDuration, perArtistCap, fillPlaylist, clampDuration,
  MIN_DURATION_MS, MAX_DURATION_MS, MAX_DURATION_BOUND,
} = await import('../src/services/playlistFill.js');

// A deterministic stand-in for Math.random: cycles a fixed sequence so a
// shuffle is reproducible and an assertion can name an exact result.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function track(artist, n, extra = {}) {
  return {
    artist, title: `${artist} ${n}`, album: 'Al', matchKey: `${artist}-${n}`,
    durationMs: 200_000, sizeBytes: 1_000_000, year: 2000, trackNumber: n,
    popularityRank: null, signalScore: 1, ...extra,
  };
}

function poolOf(artists, per) {
  return artists.flatMap((a) => Array.from({ length: per }, (_, i) => track(a, i + 1)));
}

test('the duration filter drops interludes, epics and undecodable files', () => {
  const tracks = [
    track('A', 1, { durationMs: 30_000 }),
    track('A', 2, { durationMs: 200_000 }),
    track('A', 3, { durationMs: 900_000 }),
    track('A', 4, { durationMs: null }),
  ];
  const kept = filterByDuration(tracks, { minMs: MIN_DURATION_MS, maxMs: MAX_DURATION_MS });
  assert.deepEqual(kept.map((t) => t.trackNumber), [2]);
});

test('the cap is the documented formula', () => {
  assert.equal(perArtistCap(100, 10), 15);
  assert.equal(perArtistCap(200, 40), 10);
  assert.equal(perArtistCap(100, 4), 30);
  assert.equal(perArtistCap(20, 10), 7);
});

test('a single artist is effectively uncapped', () => {
  assert.equal(perArtistCap(30, 1), 35);
});

test('no artist exceeds the cap', () => {
  const pool = poolOf(['A', 'B', 'C'], 50);
  const { picked, cap } = fillPlaylist({
    pool, target: 30, method: 'random', rng: seqRng([0.1, 0.5, 0.9]),
  });
  const counts = {};
  for (const p of picked) counts[p.artist] = (counts[p.artist] ?? 0) + 1;
  for (const n of Object.values(counts)) assert.ok(n <= cap, `${n} exceeds cap ${cap}`);
});

test('picks spread across artists instead of draining the biggest', () => {
  // 100 tracks by A, 3 each by B and C. Naive uniform sampling would return
  // almost nothing but A.
  const pool = [...poolOf(['A'], 100), ...poolOf(['B', 'C'], 3)];
  const { picked } = fillPlaylist({
    pool, target: 9, method: 'random', rng: seqRng([0.2, 0.7, 0.4]),
  });
  const artists = new Set(picked.map((p) => p.artist));
  assert.equal(artists.size, 3, 'every artist with tracks should be represented');
});

test('popular orders by rank, and falls back to year then track number', () => {
  const pool = [
    track('A', 1, { popularityRank: 2 }),
    track('A', 2, { popularityRank: 0 }),
    track('B', 1, { popularityRank: null, year: 1995, trackNumber: 5 }),
    track('B', 2, { popularityRank: null, year: 1990, trackNumber: 1 }),
  ];
  const { picked } = fillPlaylist({ pool, target: 4, method: 'popular' });
  const a = picked.filter((p) => p.artist === 'A').map((p) => p.trackNumber);
  const b = picked.filter((p) => p.artist === 'B').map((p) => p.trackNumber);
  assert.deepEqual(a, [2, 1], 'ranked tracks come out in rank order');
  assert.deepEqual(b, [1, 5], 'unranked tracks fall back to year then track number');
});

test('the byte budget skips an oversized track rather than stopping', () => {
  const pool = [
    track('A', 1, { sizeBytes: 180_000_000 }),
    track('A', 2, { sizeBytes: 1_000_000 }),
    track('A', 3, { sizeBytes: 1_000_000 }),
  ];
  const { picked, stopped } = fillPlaylist({
    pool, target: 10, byteBudget: 5_000_000, method: 'popular',
  });
  assert.equal(picked.length, 2, 'the two small files fit; the huge one is skipped');
  assert.equal(stopped, 'budget');
});

test('reports stopping at the target', () => {
  const { stopped, picked } = fillPlaylist({ pool: poolOf(['A', 'B'], 20), target: 6, method: 'popular' });
  assert.equal(picked.length, 6);
  assert.equal(stopped, 'target');
});

test('reports running out of pool', () => {
  const { stopped, picked } = fillPlaylist({ pool: poolOf(['A', 'B'], 2), target: 50, method: 'popular' });
  assert.equal(picked.length, 4);
  assert.equal(stopped, 'exhausted');
});

test('reports the cap holding the fill back', () => {
  // 200 tracks by one artist, target 50 → cap 55, so the cap can't bite.
  // Two artists, one with 100 tracks and one with 1: cap is 30, so the fill
  // stops at 31 with pool left over.
  const pool = [...poolOf(['A'], 100), ...poolOf(['B'], 1)];
  const { stopped, picked } = fillPlaylist({ pool, target: 50, method: 'popular' });
  assert.equal(picked.length, 31);
  assert.equal(stopped, 'cap');
});

test('reports the cap, not the budget, when both were touched but the cap is what bound the fill', () => {
  // A has 100 tracks: A-1 is 200MB, A-2..A-100 are 1MB each. B has 1 track at 1MB.
  // target=50, byteBudget=50MB -> cap = ceil(50/2)+5 = 30. The oversized A-1 is
  // skipped (budgetBlocked), but the fill still stops because A hits its cap of
  // 30, not because the budget ran out -- raising the budget would not add more.
  const pool = [
    track('A', 1, { sizeBytes: 200_000_000 }),
    ...Array.from({ length: 99 }, (_, i) => track('A', i + 2, { sizeBytes: 1_000_000 })),
    track('B', 1, { sizeBytes: 1_000_000 }),
  ];
  const { picked, stopped } = fillPlaylist({
    pool, target: 50, byteBudget: 50_000_000, method: 'popular',
  });
  assert.equal(picked.length, 31);
  assert.equal(stopped, 'cap');
});

test('prefer-popular narrows the draw to the top slice', () => {
  const pool = Array.from({ length: 40 }, (_, i) => track('A', i + 1, { popularityRank: i }));
  const { picked, cap } = fillPlaylist({
    pool, target: 5, method: 'random', preferPopular: true, rng: seqRng([0.1, 0.4, 0.8, 0.2, 0.6]),
  });
  for (const p of picked) {
    assert.ok(p.popularityRank < 2 * cap, `rank ${p.popularityRank} came from outside the top slice`);
  }
});

test('prefer-popular is a no-op for an artist with no popularity data', () => {
  const pool = poolOf(['A'], 20);
  const { picked } = fillPlaylist({
    pool, target: 5, method: 'random', preferPopular: true, rng: seqRng([0.3, 0.7]),
  });
  assert.equal(picked.length, 5);
});

test('an already-present key is never picked again', () => {
  const pool = poolOf(['A'], 5);
  const { picked } = fillPlaylist({
    pool, target: 5, method: 'popular', existingKeys: new Set(['A-1', 'A-2']),
  });
  assert.equal(picked.length, 3);
  assert.ok(!picked.some((p) => p.matchKey === 'A-1'));
});

// --- Duration bounds off the wire ---------------------------------------------

test('a duration bound of 0 is honoured rather than read as absent', () => {
  // The client sends 0 for an emptied "Shortest (seconds)" field. Under
  // `Number(x) || MIN_DURATION_MS` that came straight back as the 60s default,
  // so the one setting whose whole point is "no lower bound" could not be set.
  assert.equal(clampDuration(0, MIN_DURATION_MS), 0);
  assert.equal(clampDuration('0', MIN_DURATION_MS), 0);
});

test('an absent or unusable duration bound falls back to the default', () => {
  assert.equal(clampDuration(undefined, MIN_DURATION_MS), MIN_DURATION_MS);
  assert.equal(clampDuration(null, MIN_DURATION_MS), MIN_DURATION_MS);
  assert.equal(clampDuration('', MAX_DURATION_MS), MAX_DURATION_MS);
  assert.equal(clampDuration('soon', MAX_DURATION_MS), MAX_DURATION_MS);
  assert.equal(clampDuration(Infinity, MAX_DURATION_MS), MAX_DURATION_MS);
});

test('a duration bound is clamped at both ends', () => {
  assert.equal(clampDuration(-5000, MIN_DURATION_MS), 0);
  assert.equal(clampDuration(Number.MAX_SAFE_INTEGER, MAX_DURATION_MS), MAX_DURATION_BOUND);
});
