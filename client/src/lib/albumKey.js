// ASCII 31 (unit separator), built so no invisible character sits in the source.
const SEPARATOR = String.fromCharCode(31);

// (artist, album) key. The separator prevents "AB"+"C" == "A"+"BC"; mirrors
// char(31) in libraryRepo.js recomputeStats.
export function albumKey(artist, album) {
  return `${artist ?? ''}${SEPARATOR}${album ?? ''}`;
}
