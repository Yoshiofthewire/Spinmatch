// Escapes for a quoted Lucene term (artist:"..."): only " and \ are special inside quotes.
// Separate from musicbrainz.js so tests can mock that module wholesale.
export function luceneQuoted(value) {
  return String(value ?? '').replace(/[\\"]/g, '\\$&');
}
