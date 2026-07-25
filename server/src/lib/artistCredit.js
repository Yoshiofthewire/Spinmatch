// Splitting a joined artist credit down to its primary artist.
//
// A quarter of a real 1000-artist library is rows like "Justice & Thundercat",
// "Grabbitz feat. REZZ" or "Nine Inch Nails / Stephen Morris and Gillian
// Gilbert". None of them resolve to a MusicBrainz artist, so everything keyed on
// that resolution — the discography diff, discovery seeding — silently skips
// them, even when the primary artist is one you own hundreds of tracks by.
//
// This is only ever a FALLBACK, applied after the whole string has failed to
// resolve, and its result is only accepted when the primary segment is an artist
// already in the library. Both guards are load-bearing, and measured rather than
// assumed:
//
//   - Ordering protects real band names. "She & Him" and "Simon & Garfunkel"
//     resolve whole, so the split never runs on them — which matters, because a
//     library can contain a separate artist literally named "She".
//   - The owned check protects against a segment that matches a real but
//     unrelated artist. MusicBrainz has an exact artist named "Florence" (a Dutch
//     techno producer), and separate ones named "Earth" and "Wind" — so splitting
//     "Florence + The Machine" or "Earth, Wind & Fire" and trusting an exact name
//     match would confidently link the wrong act. Requiring the segment to be
//     something you already own makes the fallback self-validating.

// Joiners that reliably separate credits rather than appearing inside a name.
const RELIABLE = /\s+(?:feat\.?|ft\.?|featuring|vs\.?|with|presents)\s+|\s*\/\s*/i;

// Joiners that also occur inside real band names ("Hall & Oates", "Earth, Wind
// & Fire"). Split on them too — the owned check is what makes that safe — but
// only after the reliable ones, so "A feat. B & C" yields "A" rather than
// "A feat. B".
const RISKY = /\s+[&+＆]\s+|\s*[,、／]\s*/;

// A leading "The" is part of the name, not a credit — guard against a split
// producing something that isn't an artist at all.
const MIN_SEGMENT = 2;

/**
 * The primary artist of a joined credit string.
 *
 * @param {string} name
 * @returns {string|null} the leading segment, or null when there is no credit
 *   joiner to split on (in which case there is nothing to fall back to).
 */
export function primaryArtist(name) {
  const full = String(name ?? '').trim();
  if (!full) return null;

  const segment = full.split(RELIABLE)[0].split(RISKY)[0].trim();
  if (segment.length < MIN_SEGMENT) return null;
  // No joiner present: the caller already tried this exact string and it failed,
  // so re-trying it would just burn another upstream call.
  if (segment.toLowerCase() === full.toLowerCase()) return null;
  return segment;
}

/**
 * Whether a name looks like a joined credit at all. Used to decide if a row is
 * worth reporting, without committing to how it would split.
 */
export function isJoinedCredit(name) {
  return primaryArtist(name) !== null;
}
