// The one ceiling on how many bytes of cover art this process will hold in
// memory at once, wherever the art comes from.
//
// It lived in coverArt.js and applied only to Cover Art Archive downloads, which
// left the two *local* readers — the sidecar image beside the audio and the
// picture embedded in the tag — completely unbounded. Both are reachable from
// GET /api/library/cover/:trackId, and an album grid fires two dozen of those in
// parallel, so a single oversized cover.png in one folder was two dozen
// simultaneous unbounded Buffer allocations.
//
// A front cover is routinely 1-5 MB. Anything past this is a scan or a decoy,
// and neither is worth an out-of-memory kill.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
