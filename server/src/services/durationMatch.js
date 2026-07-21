const TOLERANCE_SECONDS = 5;

// Pure ranking: given YouTube candidates {id, title, durationMs} and a target
// MusicBrainz length in ms, sort by closeness and flag which are within tolerance.
export function rankCandidates(candidates, targetMs) {
  return candidates
    .map((c) => ({
      ...c,
      deltaSeconds: Math.round(Math.abs(c.durationMs - targetMs) / 1000),
    }))
    .sort((a, b) => a.deltaSeconds - b.deltaSeconds)
    .map((c) => ({ ...c, withinTolerance: c.deltaSeconds <= TOLERANCE_SECONDS }));
}

export function pickResult(rankedCandidates) {
  if (rankedCandidates.length === 0) {
    return { status: 'no_results', video: null, deltaSeconds: null };
  }
  const best = rankedCandidates.find((c) => c.withinTolerance) || rankedCandidates[0];
  return {
    status: best.withinTolerance ? 'confirmed' : 'unverified',
    video: { id: best.id, title: best.title, durationMs: best.durationMs, url: `https://www.youtube.com/watch?v=${best.id}` },
    deltaSeconds: best.deltaSeconds,
  };
}
