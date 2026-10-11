import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitArtistTitle } from '../lib/normalize.js';

const MAX_TEXT = 200;

// Pure. One entry per track line: the library path it names (or null) and its #EXTINF text.
export function parseM3u(text, musicDir, max) {
  const entries = [];
  let display = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const extinf = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (extinf) display = extinf[1].trim() || null;
      continue;
    }
    if (entries.length === max) return { entries, truncated: true };
    entries.push({ line, path: libraryPath(line, musicDir), display });
    display = null;
  }
  return { entries, truncated: false };
}

// Absolute or MUSIC_DIR-relative; anything resolving outside MUSIC_DIR is no path at all.
function libraryPath(line, musicDir) {
  let p = line;
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  p = p.replaceAll('\\', '/');
  const resolved = path.posix.isAbsolute(p) ? path.posix.normalize(p) : path.posix.join(musicDir, p);
  return resolved.startsWith(`${musicDir}/`) ? resolved : null;
}

// A library path contributes its tags. Otherwise #EXTINF text is matched like a pasted
// line (a path outside MUSIC_DIR is never looked up, but its #EXTINF still counts).
// A bare file name is display text only: title-only matching would give false hits.
export function m3uItems(db, entries) {
  const byPath = db.prepare('SELECT artist, album, title FROM local_tracks WHERE removed = 0 AND path = ?');
  return entries.map(({ line, path: p, display }) => {
    const track = p ? byPath.get(p) : null;
    const { artist, title, album } = track
      ?? { ...splitArtistTitle(display ?? stem(p ?? line)), album: null };
    return {
      artist: artist?.slice(0, MAX_TEXT) ?? null,
      title: (title || stem(p ?? line)).slice(0, MAX_TEXT),
      album: album?.slice(0, MAX_TEXT) ?? null,
      matchable: Boolean(track) || display != null,
    };
  });
}

function stem(p) {
  return path.posix.parse(p.replaceAll('\\', '/')).name || p;
}
