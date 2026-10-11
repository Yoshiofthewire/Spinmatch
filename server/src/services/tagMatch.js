import * as tags from './tags.js';
// Namespace import so this links against whatever musicbrainz.js exposes.
import * as mb from './musicbrainz.js';
import { luceneQuoted } from '../lib/lucene.js';
import { rankCandidates } from './durationMatch.js';
import { normalizeTitle } from '../lib/normalize.js';

// Identification without AcoustID: match on existing tags, accepted only when
// MusicBrainz agrees on both title and duration.

// Hits come best-first and title/duration is the real filter, so a handful is plenty.
const SEARCH_LIMIT = 5;

// Escaped, not stripped: "AC\DC" must not search for "AC DC".
function term(value) {
  return luceneQuoted(String(value).trim());
}

// A corrupt or non-audio file is a review item, not a crash.
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

// Title-matching candidates with a length, ranked by duration closeness.
function rankByDuration(recordings, { title, durationMs }) {
  const wanted = normalizeTitle(title);
  const plausible = recordings
    .filter((r) => r.lengthMs != null && normalizeTitle(r.title) === wanted)
    .map((r) => ({ ...r, durationMs: r.lengthMs }));
  return rankCandidates(plausible, durationMs);
}

// Mirrors ingest.js's identifyFile: exactly one of `confirmed` (a getRecording()
// result) or `reason` (shown to the user in review) is set.
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

// Album-folder counterpart: `{ perFile, releaseGroupMbids }` or `{ reason }`, never both.
// recMbids is always empty; without fingerprints coherence rests on durations.
export async function albumCandidatesFromTags(files) {
  const perFile = [];
  for (const filePath of files) {
    const current = (await readTagsSafely(filePath)) ?? {};
    perFile.push({ filePath, durationMs: current.durationMs ?? null, recMbids: [], tags: current });
  }

  // Prefer track numbers over filename order when every file has one.
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

// Unfiltered tag-search results for the manual picker. `fallback` (e.g. path
// tags) fills only fields the file lacks; a real tag always wins.
export async function candidatesFromTags(filePath, { fallback = null } = {}) {
  const tags = await readTagsSafely(filePath);
  const current = {
    ...tags,
    artist: tags?.artist ?? fallback?.artist ?? null,
    title: tags?.title ?? fallback?.title ?? null,
  };
  if (!current.artist && !current.title) return { candidates: [] };

  const recordings = await mb.searchRecordings(recordingQuery(current));
  const candidates = recordings.slice(0, 10).map((r) => ({
    recordingMbid: r.mbid,
    title: r.title,
    artist: r.artist,
    lengthMs: r.lengthMs,
    // MusicBrainz scores 0-100, AcoustID 0-1; normalize to one scale.
    score: r.score / 100,
    releaseGroupTitle: r.releaseGroupTitle ?? null,
  }));
  return { candidates };
}
