// ASCII 31 (unit separator), constructed rather than written as a literal so no
// invisible control character ends up in the source.
const SEPARATOR = String.fromCharCode(31);

// Identifies an album by its (artist, album) pair, for React keys and for
// cross-referencing the incomplete-albums report against the album lists.
//
// The separator is deliberate: plain concatenation is ambiguous, since artist
// "AB" + album "C" would produce the same key as artist "A" + album "BC". A
// control character can't occur in a tag value, so pairs collide only when
// they're genuinely the same album. This mirrors the char(31) separator the
// server uses when counting distinct albums (recomputeStats in
// server/src/services/libraryRepo.js).
export function albumKey(artist, album) {
  return `${artist ?? ''}${SEPARATOR}${album ?? ''}`;
}
