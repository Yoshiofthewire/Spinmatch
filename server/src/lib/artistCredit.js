// Primary artist of a joined credit ("Justice & Thundercat"). Fallback only: callers
// try the whole string first (protects "Simon & Garfunkel") and accept the segment
// only if already owned (MusicBrainz has unrelated acts named "Florence", "Earth").

// Joiners that never appear inside a name.
const RELIABLE = /\s+(?:feat\.?|ft\.?|featuring|vs\.?|with|presents)\s+|\s*\/\s*/i;

// Joiners that also occur in band names ("Hall & Oates"); split after RELIABLE.
const RISKY = /\s+[&+＆]\s+|\s*[,、／]\s*/;

// Reject splits too short to be an artist.
const MIN_SEGMENT = 2;

// Leading segment, or null when there is no joiner to split on.
export function primaryArtist(name) {
  const full = String(name ?? '').trim();
  if (!full) return null;

  const segment = full.split(RELIABLE)[0].split(RISKY)[0].trim();
  if (segment.length < MIN_SEGMENT) return null;
  // No joiner: the caller already tried this exact string.
  if (segment.toLowerCase() === full.toLowerCase()) return null;
  return segment;
}

export function isJoinedCredit(name) {
  return primaryArtist(name) !== null;
}
