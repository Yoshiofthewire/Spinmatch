import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording } from './musicbrainz.js';

// Fingerprint candidates for the human pickers; same row shape as candidatesFromTags.
// Unfiltered by SCORE_THRESHOLD on purpose: near-misses are the point.

// Each candidate costs a MusicBrainz round trip.
const CANDIDATE_LIMIT = 10;

// filePath must already be resolved and validated.
export async function candidatesFromFingerprint(filePath) {
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const top = (await lookup({ fingerprint: fp, durationSeconds })).slice(0, CANDIDATE_LIMIT);
  const recordings = await Promise.all(top.map((c) => getRecording(c.recordingMbid)));

  const candidates = recordings.map((rec, i) => ({
    recordingMbid: rec.mbid,
    title: rec.title,
    artist: rec.artist,
    lengthMs: rec.lengthMs,
    // 0-1, the scale the pickers render.
    score: top[i].score,
    releaseGroupTitle: rec.releaseGroups[0]?.title ?? null,
  }));

  return { candidates };
}
