// The seven writable tag fields, shared by the two edit panels so their forms,
// their labels and their "what will this do" logic can't drift apart.
//
// The bounds mirror server/src/lib/tagLimits.js. They are here so the browser
// catches a typo in the input itself; the server re-checks and stays
// authoritative, because a number input is trivially bypassed.
export const TAG_FIELDS = [
  { key: 'artist', label: 'Artist', type: 'text' },
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'album', label: 'Album', type: 'text' },
  { key: 'trackNumber', label: 'Track number', type: 'number', min: 1, max: 999 },
  { key: 'disc', label: 'Disc', type: 'number', min: 1, max: 99 },
  { key: 'year', label: 'Year', type: 'number', min: 1, max: 2999 },
  { key: 'genre', label: 'Genre', type: 'text' },
];

// Set once across a whole album. Mirrors ALBUM_WIDE_FIELDS on the server, which
// rejects title and trackNumber outright — one title across a record is never
// what anyone means.
export const ALBUM_WIDE_KEYS = ['artist', 'album', 'year', 'genre', 'disc'];
export const PER_TRACK_KEYS = ['title', 'trackNumber'];

// Form state is strings throughout, including for the numeric fields: an <input>
// gives back a string, and keeping one representation avoids a value that is
// sometimes 3 and sometimes '3' deciding whether a row looks dirty.
export function toFormValue(value) {
  return value == null ? '' : String(value);
}

/**
 * What a form row currently means, relative to the value the file holds.
 *
 * Three outcomes, and the third is the one worth naming: a field that had a value
 * and has been blanked is NOT a change, because editing cannot remove a tag. It
 * has to be reported rather than silently ignored, or blanking a field looks like
 * it worked until the row reappears unchanged.
 *
 * @returns {'unchanged'|'set'|'kept'}
 */
export function rowState(current, typed) {
  const original = toFormValue(current);
  if (typed.trim() === '') return original === '' ? 'unchanged' : 'kept';
  return typed.trim() === original.trim() ? 'unchanged' : 'set';
}

/**
 * The `fields` body for an edit request: every row the user actually changed.
 *
 * Blanked rows are left out here as well as being dropped server-side. Sending
 * them and relying on the server to ignore them would work, but it would also
 * mean the request said something ("clear the artist") that the app has decided
 * is not a thing it does.
 */
export function patchFrom(values, current, keys) {
  const patch = {};
  for (const key of keys) {
    if (rowState(current[key], values[key] ?? '') === 'set') patch[key] = values[key].trim();
  }
  return patch;
}
