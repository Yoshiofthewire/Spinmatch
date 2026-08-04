// Fold away the differences that make two spellings of the same track look
// different: case, parenthetical/bracketed suffixes like "(Remastered 2011)" or
// "[Live]", featured-artist tails, and punctuation. Used both by gap detection
// (owned track vs MusicBrainz tracklist) and by the tag-based ingest matcher
// (file's title tag vs a MusicBrainz search hit).
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Unit separator, matching the one libraryRepo's dup_key uses. A control
// character can't occur in a folded key, whose alphabet normalizeTitle has
// already reduced to letters, digits and single spaces.
export const KEY_SEPARATOR = '\u001f';

// The identity a playlist item is stored under, and the one local_tracks is
// indexed on. Folded in JS, once, for the reason libraryRepo.js documents at
// foldKey: SQLite's LOWER() is ASCII-only and JavaScript's toLowerCase() is not,
// so a key built one way and queried the other disagrees the moment an artist is
// called "Ärzte".
//
// Distinct from dup_key, which is a plain lowercase join and therefore will not
// match "Kid A (Remastered)" to "Kid A". Playlist resolution has to, so it folds
// through normalizeTitle instead.
export function makeMatchKey(artist, title) {
  return `${normalizeTitle(artist)}${KEY_SEPARATOR}${normalizeTitle(title)}`;
}

export function makeTitleKey(title) {
  return normalizeTitle(title);
}
