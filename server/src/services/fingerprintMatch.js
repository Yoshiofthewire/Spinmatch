import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording } from './musicbrainz.js';

// Identification by the audio itself, for the two pickers that offer a human a
// choice: ingest's "Find a match" and the library's "Fix tags" panel. The
// counterpart to tagMatch.candidatesFromTags, which is what runs when there's no
// AcoustID key — same row shape either way, so the pickers render one list
// regardless of which path produced it.
//
// Deliberately unfiltered by SCORE_THRESHOLD: the automatic path has already
// declined to confirm anything, and the near-misses are the whole point.

// The per-candidate getRecording call is a cached MusicBrainz round trip, and
// AcoustID's tail for a widely-released recording is long. A shortlist is what
// the picker can usefully show.
const CANDIDATE_LIMIT = 10;

/**
 * @param {string} filePath — already resolved and validated by the caller
 * @returns {Promise<{candidates: Array<{recordingMbid, title, artist, lengthMs, score, releaseGroupTitle}>}>}
 */
export async function candidatesFromFingerprint(filePath) {
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const top = (await lookup({ fingerprint: fp, durationSeconds })).slice(0, CANDIDATE_LIMIT);
  const recordings = await Promise.all(top.map((c) => getRecording(c.recordingMbid)));

  const candidates = recordings.map((rec, i) => ({
    recordingMbid: rec.mbid,
    title: rec.title,
    artist: rec.artist,
    lengthMs: rec.lengthMs,
    // AcoustID's native 0-1 scale, which is the scale the pickers render;
    // candidatesFromTags normalizes MusicBrainz's 0-100 down to match.
    score: top[i].score,
    releaseGroupTitle: rec.releaseGroups[0]?.title ?? null,
  }));

  return { candidates };
}
