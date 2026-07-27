// Bounds for the numeric tags, plus a ceiling for the text ones.
//
// These are enforced in two places for two different reasons, and the difference
// matters. libraryScanner.rowFor CLAMPS to them: those values come out of a
// binary frame in a file the user downloaded from a stranger, and a file tagged
// `track = 2000000000` used to take out GET /api/library/incomplete (which
// iterates 1..maxTrackNumber) with no way left to reach the UI that would show
// you the offending file. Out of range there means "this file has no usable
// number", silently.
//
// services/tagEdit.validateTagEdit REJECTS them instead: a value a person typed
// into a form is not a hostile file, and silently turning 2050 into null is
// baffling rather than defensive. Same numbers, opposite handling.
//
// Kept in a leaf module with no imports of its own so both sides can share them
// without either importing the other.
export const MAX_TRACK_NUMBER = 999;
export const MAX_DISC_NUMBER = 99;
export const MIN_YEAR = 1;
export const MAX_YEAR = 2999;

// A hand-typed text tag. There is no format limit worth enforcing here — this
// exists so a pasted document can't become an ID3 frame.
export const MAX_TAG_TEXT = 500;
