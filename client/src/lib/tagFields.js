// Writable tag fields shared by both edit panels. Bounds mirror
// server/src/lib/tagLimits.js for early feedback; the server stays authoritative.
export const TAG_FIELDS = [
  { key: 'artist', label: 'Artist', type: 'text' },
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'album', label: 'Album', type: 'text' },
  { key: 'trackNumber', label: 'Track number', type: 'number', min: 1, max: 999 },
  { key: 'disc', label: 'Disc', type: 'number', min: 1, max: 99 },
  { key: 'year', label: 'Year', type: 'number', min: 1, max: 2999 },
  { key: 'genre', label: 'Genre', type: 'text' },
];

// Mirrors server ALBUM_WIDE_FIELDS (title and trackNumber are rejected there).
export const ALBUM_WIDE_KEYS = ['artist', 'album', 'year', 'genre', 'disc'];
export const PER_TRACK_KEYS = ['title', 'trackNumber'];

// Form state is always strings, numeric fields too, so 3 vs '3' can't fake dirtiness.
export function toFormValue(value) {
  return value == null ? '' : String(value);
}

/**
 * 'kept': a blanked field is not a change, since editing cannot remove a tag.
 * @returns {'unchanged'|'set'|'kept'}
 */
export function rowState(current, typed) {
  const original = toFormValue(current);
  if (typed.trim() === '') return original === '' ? 'unchanged' : 'kept';
  return typed.trim() === original.trim() ? 'unchanged' : 'set';
}

// Changed rows only; blanked rows are omitted, never sent as "clear".
export function patchFrom(values, current, keys) {
  const patch = {};
  for (const key of keys) {
    if (rowState(current[key], values[key] ?? '') === 'set') patch[key] = values[key].trim();
  }
  return patch;
}
