import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { readTags } from './tags.js';
import { getDb } from '../lib/db.js';
import {
  upsertLocalTrack, getChangeKeys, markRemoved, recomputeStats,
} from './libraryRepo.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function changeKeyFor(stat) {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir -> skip subtree
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      yield full;
    }
  }
}

export async function scanLibrary() {
  const root = config.ingest.musicDir;
  const db = getDb();
  const known = getChangeKeys(db);
  const seen = new Set();
  let scanned = 0;
  let added = 0;
  let updated = 0;

  for await (const filePath of walk(root)) {
    scanned += 1;
    seen.add(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const changeKey = changeKeyFor(stat);
    if (known.get(filePath) === changeKey) continue; // unchanged -> no tag read

    let meta;
    try {
      meta = await readTags(filePath);
    } catch (err) {
      console.warn(`libraryScanner: skipping unreadable file ${filePath}: ${err.message}`);
      seen.delete(filePath); // don't let a skipped file mark a prior good row removed... it stays as-is
      continue;
    }

    const isNew = !known.has(filePath);
    upsertLocalTrack(db, {
      path: filePath,
      artist: meta.artist ?? null,
      album: meta.album ?? path.basename(path.dirname(filePath)),
      title: meta.title ?? path.basename(filePath, path.extname(filePath)),
      durationMs: null,
      changeKey,
    });
    if (isNew) added += 1; else updated += 1;
  }

  markRemoved(db, seen);
  recomputeStats(db);
  const removed = known.size - [...known.keys()].filter((p) => seen.has(p)).length;
  return { scanned, added, updated, removed };
}
