// Folds case, "(Remastered)"/"[Live]" suffixes, feat. tails, and punctuation.
export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFC') // a decomposed accent's combining mark isn't \p{L}
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Unit separator: can't occur in a folded key.
export const KEY_SEPARATOR = '\u001f';

// Playlist/local_tracks identity. Folded in JS (SQLite LOWER() is ASCII-only), and
// through normalizeTitle so "Kid A (Remastered)" matches "Kid A", unlike dup_key.
export function makeMatchKey(artist, title) {
  return `${normalizeTitle(artist)}${KEY_SEPARATOR}${normalizeTitle(title)}`;
}

// Duplicate-grouping key: plain NFC + lowercase fold, no normalizeTitle stripping.
export function makeDupKey(artist, album, title) {
  if (artist == null || title == null) return null;
  return [artist, album, title]
    .map((p) => String(p ?? '').normalize('NFC').toLowerCase())
    .join(KEY_SEPARATOR);
}

export function makeTitleKey(title) {
  return normalizeTitle(title);
}

// "Artist - Title" (hyphen, en or em dash); no dash means title only.
export function splitArtistTitle(line) {
  const split = line.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  return split
    ? { artist: split[1].trim(), title: split[2].trim() }
    : { artist: null, title: line };
}
