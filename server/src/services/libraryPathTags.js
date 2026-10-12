import path from 'node:path';
import { config } from '../config.js';

// Tags inferred from a file's location under MUSIC_DIR, for files whose tags are missing.
// Conservative: anything ambiguous is null, since a wrong tag is worse than none.

// "CD1", "Disc 2", "Disk-3": stepped over, or it would be mistaken for the album.
const DISC_DIR = /^(?:cd|disc|disk)[\s_-]*(\d{1,2})$/i;

// "(1994) Dookie", "[1994] Dookie": brackets need no separator.
const YEAR_BRACKETED = /^[([](\d{4})[)\]]\s*[-–_.]?\s*(.+)$/;
// "1994 - Dookie". Separator required: "1994 Dookie" may be the title.
const YEAR_PREFIX = /^(\d{4})\s*[-–_.]\s*(.+)$/;
// "Dookie (1994)".
const YEAR_SUFFIX = /^(.+?)\s*[([](\d{4})[)\]]\s*$/;

// "1-05 Title" / "1.05 Title". Must be checked before TRACK_PREFIX.
const DISC_TRACK_PREFIX = /^(\d{1,2})[-.](\d{1,2})[\s_.-]+(.+)$/;

// "05 - Title", "05 Title". Misreads "99 Problems"; libraryBulkFix only trusts
// numbers forming a coherent run per folder.
const TRACK_PREFIX = /^(\d{1,2})[\s_.-]+(.+)$/;

function cleanSegment(value) {
  return value.replace(/[\s_]+/g, ' ').trim() || null;
}

function parseAlbumDir(dir) {
  let name = dir.replace(/[_]+/g, ' ').trim();
  let year = null;

  const prefix = name.match(YEAR_BRACKETED) ?? name.match(YEAR_PREFIX);
  if (prefix) {
    year = Number(prefix[1]);
    name = prefix[2];
  } else {
    const suffix = name.match(YEAR_SUFFIX);
    if (suffix) {
      year = Number(suffix[2]);
      name = suffix[1];
    }
  }

  return { album: cleanSegment(name), year };
}

function parseFileName(base) {
  const name = base.replace(/\.[^.]+$/, '');

  const discTrack = name.match(DISC_TRACK_PREFIX);
  if (discTrack) {
    return {
      disc: Number(discTrack[1]),
      trackNumber: Number(discTrack[2]),
      title: cleanSegment(discTrack[3]),
    };
  }

  const track = name.match(TRACK_PREFIX);
  if (track) {
    return { disc: null, trackNumber: Number(track[1]), title: cleanSegment(track[2]) };
  }

  return { disc: null, trackNumber: null, title: cleanSegment(name) };
}

// Layouts: Artist/[1994 - ]Album/[CD2/][2-]05 - Title.flac. Fewer than two
// folders yields no artist/album: one folder could be either.
export function tagsFromPath(filePath) {
  const empty = { artist: null, album: null, title: null, trackNumber: null, disc: null, year: null };

  const root = path.resolve(config.ingest.musicDir);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return empty;

  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  if (parts.length === 0) return empty;

  const dirs = parts.slice(0, -1);
  const { disc: fileDisc, trackNumber, title } = parseFileName(parts[parts.length - 1]);

  let disc = fileDisc;
  if (dirs.length > 0) {
    const discMatch = dirs[dirs.length - 1].match(DISC_DIR);
    if (discMatch) {
      disc = disc ?? Number(discMatch[1]);
      dirs.pop();
    }
  }

  if (dirs.length < 2) return { ...empty, title, trackNumber, disc };

  const { album, year } = parseAlbumDir(dirs[dirs.length - 1]);
  return {
    artist: cleanSegment(dirs[dirs.length - 2]),
    album,
    title,
    trackNumber,
    disc,
    year,
  };
}
