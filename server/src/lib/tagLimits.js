// Tag bounds. The scanner silently nulls out-of-range values (hostile files; e.g.
// /incomplete iterates 1..maxTrackNumber); tagEdit rejects them (a human typed it).
export const MAX_TRACK_NUMBER = 999;
export const MAX_DISC_NUMBER = 99;
export const MIN_YEAR = 1;
export const MAX_YEAR = 2999;

// Hand-typed text tag ceiling, so a pasted document can't become an ID3 frame.
export const MAX_TAG_TEXT = 500;
