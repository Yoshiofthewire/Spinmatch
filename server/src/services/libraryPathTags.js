import path from 'node:path';
import { config } from '../config.js';

// Tags derived from where a file sits on disk, for the files MusicBrainz can't
// help with. The Health tab's biggest buckets are files with no artist or title
// tag — and searching MusicBrainz for a file's tags is useless when the tags are
// exactly what's missing. The path is the one piece of metadata those files
// still carry, because the user filed them somewhere meaningful.
//
// Deliberately conservative: every field is nullable and anything ambiguous
// comes back null rather than guessed. A wrong tag written into a file is worse
// than no tag, and the layouts below are the ones that are unambiguous enough to
// act on. Callers preview before writing, and the callers these tags reach ask
// writeTags to fill empty fields only, so a bad read is recoverable — but it
// still shouldn't happen.

// "CD1", "CD 1", "Disc 2", "Disk-3". A folder like this sits between the album
// folder and the files, so it has to be recognised and stepped over or the disc
// folder gets mistaken for the album and the album for the artist.
const DISC_DIR = /^(?:cd|disc|disk)[\s_-]*(\d{1,2})$/i;

// "(1994) Dookie", "[1994] Dookie" — brackets mark the year on their own, so no
// separator is required after them.
const YEAR_BRACKETED = /^[([](\d{4})[)\]]\s*[-–_.]?\s*(.+)$/;
// "1994 - Dookie". A bare year needs a separator to be a year: without one,
// "1994 Dookie" is just as likely to be an album whose title starts with 1994.
const YEAR_PREFIX = /^(\d{4})\s*[-–_.]\s*(.+)$/;
// "Dookie (1994)".
const YEAR_SUFFIX = /^(.+?)\s*[([](\d{4})[)\]]\s*$/;

// "1-05 Title" / "1.05 Title" — a disc-qualified track number. Checked before
// TRACK_PREFIX so the leading number isn't consumed as the track on its own.
const DISC_TRACK_PREFIX = /^(\d{1,2})[-.](\d{1,2})[\s_.-]+(.+)$/;

// "05 - Title", "05. Title", "05_Title", "05 Title".
//
// Note this reads "99 Problems.mp3" as track 99 of "Problems". There is no way
// to tell that apart from "05 Title.mp3" by looking at one filename, so the
// ambiguity is resolved a level up: bulk repair only trusts these numbers when a
// folder's files form a coherent run (see libraryBulkFix), and every proposal is
// shown to the user before anything is written.
const TRACK_PREFIX = /^(\d{1,2})[\s_.-]+(.+)$/;

function cleanSegment(value) {
  return value.replace(/[\s_]+/g, ' ').trim() || null;
}

// The album folder, minus a year that's part of the folder name rather than the
// album title. Returns {album, year}.
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

// The filename, minus extension, split into a leading track (and optionally
// disc) number and the title. Returns {trackNumber, disc, title}.
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

/**
 * Reads whatever the file's location implies about its tags.
 *
 * Recognised layouts, relative to MUSIC_DIR:
 *   Artist/Album/05 - Title.flac
 *   Artist/1994 - Album/05 Title.flac
 *   Artist/Album/CD2/05 Title.flac
 *   Artist/Album/2-05 Title.flac
 *
 * A file directly under MUSIC_DIR, or one folder deep, yields no artist or
 * album: a single folder is as likely to be an album as an artist, and writing
 * the wrong one of those is exactly the failure this module exists to avoid.
 *
 * @param {string} filePath absolute path to a file inside MUSIC_DIR
 * @returns {{artist: string|null, album: string|null, title: string|null,
 *            trackNumber: number|null, disc: number|null, year: number|null}}
 */
export function tagsFromPath(filePath) {
  const empty = { artist: null, album: null, title: null, trackNumber: null, disc: null, year: null };

  const root = path.resolve(config.ingest.musicDir);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return empty;

  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  if (parts.length === 0) return empty;

  const dirs = parts.slice(0, -1);
  const { disc: fileDisc, trackNumber, title } = parseFileName(parts[parts.length - 1]);

  // A disc folder is a level of nesting that carries a number, not a name, so
  // it's dropped from the hierarchy once its number has been taken.
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
