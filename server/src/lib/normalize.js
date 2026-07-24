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
