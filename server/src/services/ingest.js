import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording } from './musicbrainz.js';
import { readTags, writeMissingTags } from './tags.js';
import { getFrontCoverImage } from './coverArt.js';
import { rankCandidates } from './durationMatch.js';
import { RateLimitedError } from '../lib/httpErrors.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
const SCORE_THRESHOLD = 0.5;

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function scanIngestDir() {
  const dir = config.ingest.ingestDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const children = await fs.readdir(path.join(dir, entry.name));
      const trackCount = children.filter(isAudioFile).length;
      if (trackCount > 0) {
        items.push({ id: entry.name, type: 'album', name: entry.name, path: path.join(dir, entry.name), trackCount });
      }
    } else if (isAudioFile(entry.name)) {
      items.push({ id: entry.name, type: 'file', name: entry.name, path: path.join(dir, entry.name) });
    }
  }

  return { items };
}

async function identifyFile(filePath) {
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const candidates = await lookup({ fingerprint: fp, durationSeconds });

  if (candidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidates found' };
  }

  const topCandidates = candidates.filter((c) => c.score >= SCORE_THRESHOLD).slice(0, 5);
  if (topCandidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidate met the confidence threshold' };
  }

  const recordings = await Promise.all(topCandidates.map((c) => getRecording(c.recordingMbid)));
  // Each candidate recording carries its OWN MusicBrainz-canonical length; the
  // fixed point we're matching against is the file's own measured duration —
  // same orientation as verifyTrack.js's YouTube-candidate ranking.
  const rankable = recordings
    .map((rec, i) => ({ id: rec.mbid, title: rec.title, durationMs: rec.lengthMs, recording: rec, score: topCandidates[i].score }))
    .filter((c) => c.durationMs != null);

  const ranked = rankCandidates(rankable, durationSeconds * 1000);
  const best = ranked.find((c) => c.withinTolerance);

  if (!best) {
    return { confirmed: null, reason: 'no candidate recording matched within the duration tolerance' };
  }

  return { confirmed: best.recording, reason: null };
}

async function processLooseFile(item) {
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, reason } };
  }

  const current = await readTags(item.path);
  const coverImage = confirmed.releaseGroups[0]
    ? await getFrontCoverImage(confirmed.releaseGroups[0].mbid)
    : null;

  const desired = {
    artist: confirmed.artist,
    title: confirmed.title,
    album: confirmed.releaseGroups[0]?.title ?? null,
    year: confirmed.date ? Number(confirmed.date.slice(0, 4)) : null,
  };
  const { filledFields } = await writeMissingTags(item.path, desired, { coverImage });

  return {
    matched: {
      path: item.path,
      name: item.name,
      recordingMbid: confirmed.mbid,
      title: confirmed.title,
      artist: confirmed.artist,
      filledFields,
      current,
    },
  };
}

export async function processIngest() {
  const { items } = await scanIngestDir();
  const matched = [];
  const needsReview = [];

  for (const item of items) {
    try {
      if (item.type === 'album') {
        needsReview.push({ path: item.path, name: item.name, reason: 'album folders are not yet supported (coming in a later phase)' });
        continue;
      }

      const result = await processLooseFile(item);
      if (result.matched) matched.push(result.matched);
      else needsReview.push(result.needsReview);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return { matched, needsReview, error: { code: err.code, message: err.message } };
      }
      needsReview.push({ path: item.path, name: item.name, reason: err.message });
    }
  }

  return { matched, needsReview };
}
