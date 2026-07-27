import { getDb } from '../lib/db.js';
import { getTrackById, getAlbumTracksForRepair } from './libraryRepo.js';
import { writeTags } from './tags.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { yieldToEventLoop, describeFailure } from '../lib/writeLoop.js';
import { MAX_BULK_FIX } from './libraryBulkFix.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import {
  MAX_TRACK_NUMBER, MAX_DISC_NUMBER, MIN_YEAR, MAX_YEAR, MAX_TAG_TEXT,
} from '../lib/tagLimits.js';

// Writing tag values a person typed.
//
// Every other write path in this app derives what to write server-side — from a
// MusicBrainz recording, a MusicBrainz tracklist, or the file's own path — and
// fills empty fields only. This one takes its values from the request, which
// makes validateTagEdit below the whole of the trust boundary. It is called from
// inside the two functions here rather than from the route, so a second caller
// cannot arrive later and skip it.
//
// What this deliberately cannot do is REMOVE a tag. A field the user left blank
// is dropped from the patch, not sent as null, so writeTags never sees a value it
// would have to interpret as "empty this". That keeps the only destructive
// operation out of the feature entirely, and means the cross-container question
// of how you clear a field (empty array? empty string? zero? — it differs across
// mp3, flac, m4a and ogg) never has to be answered.

const TEXT_FIELDS = ['artist', 'title', 'album', 'genre'];
const NUMERIC_FIELDS = {
  trackNumber: [1, MAX_TRACK_NUMBER],
  disc: [1, MAX_DISC_NUMBER],
  year: [MIN_YEAR, MAX_YEAR],
};

export const EDITABLE_FIELDS = [...TEXT_FIELDS, ...Object.keys(NUMERIC_FIELDS)];

// Set once across a whole album. `title` and `trackNumber` are absent on purpose
// — one title across a record is never what anyone means, and accepting them
// here would turn a client bug into every file on the album carrying the same
// title. They are editable per row instead, via `perTrack`.
export const ALBUM_WIDE_FIELDS = ['artist', 'album', 'year', 'genre', 'disc'];

const PER_TRACK_FIELDS = ['title', 'trackNumber'];

// Control characters would go straight into a binary tag frame. A newline in an
// ID3 title is the realistic case, and it is not recoverable by looking at the
// file in another player.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Normalizes a hand-supplied field map into a patch writeTags can take.
 *
 * Pure: no db, no filesystem. Returns a NEW object holding only the fields that
 * carry an opinion, so a key absent from the result is a field writeTags will
 * leave alone.
 *
 * @param {object} fields
 * @param {object} [options]
 * @param {string[]} [options.allow]  Which fields this caller may set.
 * @returns {object} patch
 */
export function validateTagEdit(fields, { allow = EDITABLE_FIELDS } = {}) {
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new BadRequestError('fields must be an object');
  }

  const patch = {};
  for (const [field, raw] of Object.entries(fields)) {
    if (!allow.includes(field)) {
      throw new BadRequestError(`${field} cannot be set here`);
    }

    // Blank means "leave this alone", and is dropped rather than rejected. That
    // is required, not lenient: the edit form starts blank for a synthesized
    // album or title (the scanner fills those from the folder and filename, and
    // pre-filling a value the file does not actually carry would make Save write
    // it), so rejecting blanks would make it impossible to edit only the track
    // number on exactly the files the Health tab lists.
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      continue;
    }

    if (TEXT_FIELDS.includes(field)) {
      if (typeof raw !== 'string') throw new BadRequestError(`${field} must be text`);
      const value = raw.replace(CONTROL_CHARS, '').trim();
      // Only reachable when the input was nothing but control characters, which
      // the blank check above could not see.
      if (!value) continue;
      if (value.length > MAX_TAG_TEXT) {
        throw new BadRequestError(`${field} must be ${MAX_TAG_TEXT} characters or fewer`);
      }
      patch[field] = value;
      continue;
    }

    const [min, max] = NUMERIC_FIELDS[field];
    // A form sends "2002", not 2002, and coercing here is load-bearing rather
    // than cosmetic: writeTags decides whether to write by comparing against
    // what it read off the file, which is a number. Left as a string, every
    // field would compare unequal forever — so the file would be rewritten on
    // every save and filledFields would report a change that didn't happen.
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      throw new BadRequestError(`${field} must be a number`);
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new BadRequestError(`${field} must be a whole number`);
    }
    // Rejected, not clamped. libraryScanner.rowFor clamps because its input is a
    // binary frame from a file the user downloaded from a stranger; this input is
    // a person, and silently turning the 2050 they typed into "no year" is
    // baffling rather than defensive.
    if (value < min || value > max) {
      throw new BadRequestError(`${field} must be between ${min} and ${max}`);
    }
    patch[field] = value;
  }

  if (!Object.keys(patch).length) throw new BadRequestError('no fields to change');
  return patch;
}

// Writes a patch to one file and re-indexes it, both under the path's lock.
// Everything above a call to this is lookups and can safely overlap; from here
// down it is a whole-file rewrite, and two of those at once corrupts the file
// rather than losing an edit. The re-index is inside the lock too — it stats and
// re-reads the file, and doing that while the next queued write had already
// started would index a half-written file.
async function writeOne(real, patch) {
  return withFileLock(real, async () => {
    const { filledFields } = await writeTags(real, patch, { overwrite: true });
    await reindexFile(real);
    return filledFields;
  });
}

/**
 * Sets the named tags on one file, over whatever is there.
 *
 * No staleness check against the file on disk, deliberately — libraryBulkFix has
 * assertUnchangedSincePreview because a ten-minute-old *server-derived* preview
 * could otherwise write values the user never saw. Here the user typed the
 * values, so writing them is correct whatever the file happens to hold now, and
 * a field absent from the patch is untouched either way, so a concurrent change
 * to a field this edit doesn't name survives it.
 */
export async function editTrackTags({ trackId, fields, db = getDb() }) {
  const patch = validateTagEdit(fields);
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');
  // The path comes from our own index, and is still re-validated before the file
  // is opened for writing — same guard the cover, stream and repair routes use.
  const real = await assertReadableInsideMusicDir(track.path);

  const changedFields = await writeOne(real, patch);

  // The re-read row, so the client renders from server truth rather than from
  // what it hoped it wrote: the *_synthesized flags and dup_key are both
  // recomputed by the re-index, and neither is derivable in the browser.
  return { trackId, changedFields, track: getTrackById(db, trackId) };
}

/**
 * Sets tags across one album: `fields` on every chosen track, plus `perTrack`
 * overrides for the fields that are per-row.
 *
 * @returns {Promise<{applied: object[], failed: object[], skipped: number,
 *   renamed: {artist: string|null, album: string}|null}>}
 */
export async function editAlbumTags({
  artist = null, album, fields = {}, perTrack = [], trackIds = null, db = getDb(),
}) {
  if (!album) throw new BadRequestError('album is required');
  if (!Array.isArray(perTrack)) throw new BadRequestError('perTrack must be an array');
  if (perTrack.length > MAX_BULK_FIX) {
    throw new BadRequestError(`at most ${MAX_BULK_FIX} tracks per request`);
  }

  const albumPatch = Object.keys(fields).length
    ? validateTagEdit(fields, { allow: ALBUM_WIDE_FIELDS })
    : {};

  const overrides = new Map();
  for (const entry of perTrack) {
    const id = Number(entry?.trackId);
    if (!id) throw new BadRequestError('each perTrack entry needs a trackId');
    overrides.set(id, validateTagEdit(entry.fields, { allow: PER_TRACK_FIELDS }));
  }

  if (!Object.keys(albumPatch).length && !overrides.size) {
    throw new BadRequestError('no fields to change');
  }

  // Every target is enumerated BEFORE anything is written, and nothing below
  // re-queries by (artist, album). That is not a tidiness point: an album's
  // identity in this app IS that string pair, so renaming one re-keys the group
  // — a loop that re-read its own worklist would stop finding the files it had
  // already renamed and write to half the album.
  //
  // getAlbumTracksForRepair rather than getAlbumTracks because it also matches an
  // album whose files carry no artist tag at all.
  const rows = getAlbumTracksForRepair(db, { artist, album });
  const byId = new Map(rows.map((row) => [row.id, row]));

  // An id the album didn't produce cannot be edited through this endpoint — the
  // same confinement bulk repair applies to its own track list.
  const wanted = Array.isArray(trackIds) && trackIds.length
    ? trackIds.map(Number).filter((id) => byId.has(id))
    : [...byId.keys()];
  if (wanted.length > MAX_BULK_FIX) {
    throw new BadRequestError(`at most ${MAX_BULK_FIX} tracks per request`);
  }

  const applied = [];
  const failed = [];
  for (const id of wanted) {
    const row = byId.get(id);
    // Per-track values win: they are the more specific statement about this file.
    const patch = { ...albumPatch, ...(overrides.get(id) ?? {}) };
    if (!Object.keys(patch).length) continue;

    // taglib is synchronous, so without this an album-sized loop holds the main
    // thread for its whole duration — see lib/writeLoop.js.
    await yieldToEventLoop();
    try {
      const real = await assertReadableInsideMusicDir(row.path);
      applied.push({ trackId: id, changedFields: await writeOne(real, patch) });
    } catch (err) {
      // One unreadable or read-only file must not abandon the rest of the album,
      // so this is reported per track and the run continues. The raw message
      // carries an absolute path, so it is logged rather than returned.
      console.warn(`tagEdit: ${row.path} failed: ${err?.message}`);
      failed.push({ trackId: id, ...describeFailure(err) });
    }
  }

  // Non-null only when the group's own identity moved, which is what tells the
  // client its current view (?artist=/?album= in the query string) now names an
  // album that no longer exists.
  const renamed = 'artist' in albumPatch || 'album' in albumPatch
    ? {
      artist: 'artist' in albumPatch ? albumPatch.artist : artist,
      album: 'album' in albumPatch ? albumPatch.album : album,
    }
    : null;

  return { applied, failed, skipped: rows.length - wanted.length, renamed };
}
