import fs from 'node:fs/promises';
import { getDb } from '../lib/db.js';
import { getTrackById, getAlbumTracksForRepair } from './libraryRepo.js';
import { writeTags } from './tags.js';
import { openJournal } from './tagJournal.js';
import { reindexFile } from './libraryScanner.js';
import { assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { yieldToEventLoop, describeFailure } from '../lib/writeLoop.js';
import { MAX_BULK_FIX } from './libraryBulkFix.js';
import { NotFoundError, BadRequestError, ConflictError } from '../lib/httpErrors.js';
import {
  MAX_TRACK_NUMBER, MAX_DISC_NUMBER, MIN_YEAR, MAX_YEAR, MAX_TAG_TEXT,
} from '../lib/tagLimits.js';

// User-typed tag values: validateTagEdit is the trust boundary, called here (not
// in the route) so no caller can skip it. Blank fields are dropped, so tags can
// never be removed.

const TEXT_FIELDS = ['artist', 'title', 'album', 'genre'];
const NUMERIC_FIELDS = {
  trackNumber: [1, MAX_TRACK_NUMBER],
  disc: [1, MAX_DISC_NUMBER],
  year: [MIN_YEAR, MAX_YEAR],
};

export const EDITABLE_FIELDS = [...TEXT_FIELDS, ...Object.keys(NUMERIC_FIELDS)];

// No title/trackNumber: one value across an album is always a bug. Use `perTrack`.
export const ALBUM_WIDE_FIELDS = ['artist', 'album', 'year', 'genre', 'disc'];

const PER_TRACK_FIELDS = ['title', 'trackNumber'];

// Stripped before they reach a binary tag frame.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Pure. Returns a new patch; absent keys are left alone by writeTags.
export function validateTagEdit(fields, { allow = EDITABLE_FIELDS } = {}) {
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new BadRequestError('fields must be an object');
  }

  const patch = {};
  for (const [field, raw] of Object.entries(fields)) {
    if (!allow.includes(field)) {
      throw new BadRequestError(`${field} cannot be set here`);
    }

    // Blank = leave alone. The form is blank for synthesized album/title fields.
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      continue;
    }

    if (TEXT_FIELDS.includes(field)) {
      if (typeof raw !== 'string') throw new BadRequestError(`${field} must be text`);
      const value = raw.replace(CONTROL_CHARS, '').trim();
      // Input was only control characters.
      if (!value) continue;
      if (value.length > MAX_TAG_TEXT) {
        throw new BadRequestError(`${field} must be ${MAX_TAG_TEXT} characters or fewer`);
      }
      patch[field] = value;
      continue;
    }

    const [min, max] = NUMERIC_FIELDS[field];
    // Coerce: writeTags compares against numbers read off the file.
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      throw new BadRequestError(`${field} must be a number`);
    }
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new BadRequestError(`${field} must be a whole number`);
    }
    // Rejected, not clamped like the scanner: a person typed this.
    if (value < min || value > max) {
      throw new BadRequestError(`${field} must be between ${min} and ${max}`);
    }
    patch[field] = value;
  }

  if (!Object.keys(patch).length) throw new BadRequestError('no fields to change');
  return patch;
}

// Write and re-index under one lock: concurrent rewrites corrupt the file, and
// re-indexing outside it could read a half-written file.
async function writeOne(journal, trackId, real, patch, expectedMtimeMs = null) {
  return withFileLock(real, async () => {
    // The form was filled from the index; refuse if the file moved on since.
    if (expectedMtimeMs != null && Math.trunc((await fs.stat(real)).mtimeMs) !== expectedMtimeMs) {
      throw new ConflictError('This file changed since you opened it. Close the editor and try again.');
    }
    const written = await writeTags(real, patch, { overwrite: true });
    await journal.record({ trackId, real }, written);
    await reindexFile(real);
    return written.filledFields;
  });
}

const named = (artist, rest) => `${artist ?? 'Unknown artist'} – ${rest}`;

// `expectedMtimeMs` is the track row's mtimeMs the client loaded; omitted skips the check.
export async function editTrackTags({ trackId, fields, expectedMtimeMs = null, db = getDb() }) {
  const patch = validateTagEdit(fields);
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');
  // Re-validate even our own indexed path before writing.
  const real = await assertReadableInsideMusicDir(track.path);

  const journal = openJournal(db, 'edit', `Edited tags: ${named(track.artist, track.title)}`);
  let changedFields;
  try {
    changedFields = await writeOne(journal, trackId, real, patch, expectedMtimeMs);
  } finally {
    journal.close();
  }

  // Re-read row: re-index recomputes *_synthesized and dup_key.
  return { trackId, changedFields, batchId: journal.batchId, track: getTrackById(db, trackId) };
}

// `fields` on every chosen track, plus `perTrack` overrides.
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

  // Enumerate targets before writing: a rename re-keys the (artist, album) group.
  // ForRepair variant also matches files with no artist tag.
  const rows = getAlbumTracksForRepair(db, { artist, album });
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Ids outside this album are ignored.
  const wanted = Array.isArray(trackIds) && trackIds.length
    ? trackIds.map(Number).filter((id) => byId.has(id))
    : [...byId.keys()];
  if (wanted.length > MAX_BULK_FIX) {
    throw new BadRequestError(`at most ${MAX_BULK_FIX} tracks per request`);
  }

  const journal = openJournal(db, 'album-edit', `Album tags: ${named(artist, album)}`);
  const applied = [];
  const failed = [];
  try {
    for (const id of wanted) {
      const row = byId.get(id);
      const patch = { ...albumPatch, ...(overrides.get(id) ?? {}) };
      if (!Object.keys(patch).length) continue;

      // taglib is sync; yield so the loop doesn't hog the main thread.
      await yieldToEventLoop();
      try {
        const real = await assertReadableInsideMusicDir(row.path);
        applied.push({ trackId: id, changedFields: await writeOne(journal, id, real, patch) });
      } catch (err) {
        // Raw message has an absolute path: log it, don't return it.
        console.warn(`tagEdit: ${row.path} failed: ${err?.message}`);
        failed.push({ trackId: id, ...describeFailure(err) });
      }
    }
  } finally {
    journal.close();
  }

  // Tells the client its ?artist=/?album= view no longer exists.
  const renamed = 'artist' in albumPatch || 'album' in albumPatch
    ? {
      artist: 'artist' in albumPatch ? albumPatch.artist : artist,
      album: 'album' in albumPatch ? albumPatch.album : album,
    }
    : null;

  return { applied, failed, skipped: rows.length - wanted.length, renamed, batchId: journal.batchId };
}
