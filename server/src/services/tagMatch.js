import * as tags from './tags.js';
// Namespace imports (like ingest.js's own `tags`/`organize`) so this module
// links against whatever musicbrainz.js exposes — the search endpoints used
// here are only reached on the no-AcoustID path.
import * as mb from './musicbrainz.js';
import { rankCandidates } from './durationMatch.js';
import { normalizeTitle } from '../lib/normalize.js';

// Fallback identification for when ACOUSTID_API_KEY isn't set (or AcoustID
// can't issue one): instead of sending everything to manual review, match on
// the tags the files already carry. A hit is only accepted when MusicBrainz
// agrees on the *title* and the *duration* — the same "confirm before we touch
// anything" bar the fingerprint path applies, just with the file's own metadata
// as the query instead of an acoustic fingerprint.

// How many search hits are considered before duration confirmation. MusicBrainz
// returns them best-scoring first, and the real filter is the title/duration
// agreement below, so a handful is plenty.
const SEARCH_LIMIT = 5;

// Inside a quoted Lucene term only `"` and `\` need handling; drop them rather
// than escape, since a tag containing either is noise for matching anyway.
function term(value) {
  return String(value).replace(/["\\]/g, ' ').trim();
}

// A corrupt or non-audio file that slipped past the extension check has nothing
// to match on — that's a review item, not a crash.
async function readTagsSafely(filePath) {
  try {
    return await tags.readTags(filePath);
  } catch {
    return null;
  }
}

function recordingQuery({ artist, title }) {
  return [title && `recording:"${term(title)}"`, artist && `artist:"${term(artist)}"`]
    .filter(Boolean)
    .join(' AND ');
}

// The candidates whose title agrees with the file's own title tag and that
// carry a length to confirm against, ranked by how close that length is.
function rankByDuration(recordings, { title, durationMs }) {
  const wanted = normalizeTitle(title);
  const plausible = recordings
    .filter((r) => r.lengthMs != null && normalizeTitle(r.title) === wanted)
    .map((r) => ({ ...r, durationMs: r.lengthMs }));
  return rankCandidates(plausible, durationMs);
}

// Mirrors ingest.js's identifyFile: `{ confirmed, reason }`, where `confirmed`
// is a full getRecording() result ready to tag and file.
export async function identifyFileFromTags(filePath) {
  const current = await readTagsSafely(filePath);
  if (!current?.artist || !current.title) {
    return { confirmed: null, reason: 'AcoustID is not configured and this file has no artist/title tags to match on — use "Find a match" to search manually' };
  }
  if (!current.durationMs) {
    return { confirmed: null, reason: "AcoustID is not configured and this file's duration could not be read, so a tag match can't be confirmed" };
  }

  const recordings = await mb.searchRecordings(recordingQuery(current));
  const ranked = rankByDuration(recordings.slice(0, SEARCH_LIMIT), current);
  const best = ranked.find((c) => c.withinTolerance);
  if (!best) {
    return { confirmed: null, reason: "no MusicBrainz recording matched this file's tags and duration" };
  }

  return { confirmed: await mb.getRecording(best.mbid), reason: null };
}

// Mirrors the fingerprint path's per-file candidate gathering for an album
// folder: `{ perFile, releaseGroupMbids }`, or `{ reason }` when the tags give
// us nothing to go on. `recMbids` is always empty here — without fingerprints
// the folder's coherence check rests entirely on durations.
export async function albumCandidatesFromTags(files) {
  const perFile = [];
  for (const filePath of files) {
    const current = (await readTagsSafely(filePath)) ?? {};
    perFile.push({ filePath, durationMs: current.durationMs ?? null, recMbids: [], tags: current });
  }

  // Filename order is only a proxy for track order; when every file carries a
  // track number, trust that instead so the positional coherence check lines up
  // with the tracklist even for folders named "Title.mp3".
  if (perFile.every((f) => f.tags.trackNumber)) {
    perFile.sort((a, b) => (a.tags.disc || 1) - (b.tags.disc || 1) || a.tags.trackNumber - b.tags.trackNumber);
  }

  const album = perFile.find((f) => f.tags.album)?.tags.album;
  const artist = perFile.find((f) => f.tags.artist)?.tags.artist;
  if (!album) {
    return { reason: 'AcoustID is not configured and this folder has no album tags to match on' };
  }
  if (perFile.some((f) => !f.durationMs)) {
    return { reason: "AcoustID is not configured and some of this folder's durations could not be read" };
  }

  const query = [`releasegroup:"${term(album)}"`, artist && `artist:"${term(artist)}"`]
    .filter(Boolean)
    .join(' AND ');
  const groups = await mb.searchReleaseGroups(query);
  if (groups.length === 0) {
    return { reason: "no MusicBrainz release group matched this folder's album tags" };
  }

  return { perFile, releaseGroupMbids: groups.slice(0, SEARCH_LIMIT).map((g) => g.mbid) };
}

// Manual-picker counterpart to findCandidatesForFile's AcoustID near-misses:
// whatever MusicBrainz returns for the file's tags, unfiltered, so a human can
// pick even when the automatic tag match above wasn't confident enough.
export async function candidatesFromTags(filePath) {
  const current = await readTagsSafely(filePath);
  if (!current?.artist && !current?.title) return { candidates: [] };

  const recordings = await mb.searchRecordings(recordingQuery(current));
  const candidates = recordings.slice(0, 10).map((r) => ({
    recordingMbid: r.mbid,
    title: r.title,
    artist: r.artist,
    lengthMs: r.lengthMs,
    // MusicBrainz scores 0–100; AcoustID scores 0–1. Normalize so the picker
    // renders one scale regardless of which path produced the candidate.
    score: r.score / 100,
    releaseGroupTitle: r.releaseGroupTitle ?? null,
  }));
  return { candidates };
}
