// Escapes a value for use inside a quoted Lucene term, e.g. artist:"...".
//
// Inside quotes the only two characters with meaning are the closing quote and
// the backslash, so those are the two that need escaping. Escaping beats
// stripping, because an artist really is called "AC\DC" — and leaving a backslash
// unescaped produced an invalid escape sequence, which MusicBrainz answers with a
// 400 that surfaced as "MusicBrainz returned 400" with no way for the user to
// proceed. Characters like ( ) ! ~ are literal inside a phrase and are left alone.
//
// Lives here rather than in musicbrainz.js because the tag matcher imports that
// module as a namespace so tests can mock it wholesale; a named import of a
// helper would break every one of those mocks.
export function luceneQuoted(value) {
  return String(value ?? '').replace(/[\\"]/g, '\\$&');
}
