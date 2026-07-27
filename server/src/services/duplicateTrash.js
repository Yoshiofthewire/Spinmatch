import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  getTrackById, getRemovedTrackById, getDupKeyForTrack, liveCopyCountForTrack,
} from './libraryRepo.js';
import { reindexFile } from './libraryScanner.js';
import { assertInsideMusicDir, assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { moveOnto } from '../lib/moveFile.js';
import { noteWrite } from '../lib/recentWrites.js';
import { NotFoundError, BadRequestError, ConflictError } from '../lib/httpErrors.js';

// Moving a duplicate aside.
//
// Spinmatch never deletes a file, and this does not change that: a copy is
// relocated into MUSIC_DIR/.spinmatch-trash, which mirrors the library layout,
// and every byte the user had they still have. Reclaiming the space is a
// deliberate act performed outside this app — there is no "empty trash" here,
// now or later, because that is deletion with one indirection.
//
// The dot prefix is load-bearing. walk() in libraryScanner.js skips dot-prefixed
// entries, which is the only reason a trashed file leaves the index and stays
// out of it; there is no exclusion list to keep in sync.
export const TRASH_DIR_NAME = '.spinmatch-trash';

/**
 * Where a library file goes when it is moved aside. Pure: no db, no filesystem.
 *
 * Resolved lexically rather than through realpath, matching assertInsideMusicDir
 * and reindexFile — the two functions this flow actually calls — rather than
 * assertReadableInsideMusicDir. If MUSIC_DIR ever is a symlink, the relative
 * part below starts with "..", the result escapes the root, and the caller's
 * assertInsideMusicDir turns that into a 400 instead of a write outside the
 * library.
 */
export function trashPathFor(filePath) {
  const root = path.resolve(config.ingest.musicDir);
  return path.join(root, TRASH_DIR_NAME, path.relative(root, filePath));
}

// The filesystem failures worth naming for the person who clicked the button.
// writeLoop's describeFailure does this for tag writes and is worded for one
// ("could not be written to"); a move needs different verbs throughout, and it
// has a failure a tag write cannot have — ENOSPC, from the cross-device copy.
const MOVE_FAILURES = {
  ENOENT: 'The file is no longer there.',
  EACCES: 'The music folder is not writable.',
  EPERM: 'The music folder is not writable.',
  EROFS: 'The music folder is not writable.',
  ENOSPC: 'There is not enough room to move the file.',
  EIO: 'The storage holding this file stopped responding.',
  ESTALE: 'The storage holding this file stopped responding.',
  ENOTCONN: 'The storage holding this file stopped responding.',
};

// Errors that already carry a status were written for the browser and pass
// through. A known filesystem code becomes a message with no path in it (the
// path goes to the log). Anything else is left alone, so it reaches the error
// handler as a 500 with the full error logged.
function asMoveError(err, filePath) {
  if (err?.status) return err;
  const known = MOVE_FAILURES[err?.code];
  if (!known) return err;
  console.warn(`duplicateTrash: ${filePath} failed: ${err.code} ${err.message}`);
  return new BadRequestError(known);
}

/**
 * Moves one copy of a duplicated track into the trash folder.
 *
 * @returns {Promise<{trackId: number, trashedPath: string, remainingCopies: number}>}
 */
export async function trashDuplicate({ trackId, db = getDb() }) {
  // Serialized per dup_key, not per file. Without this, two requests trashing
  // two *different* copies of the same 2-copy track can each read "2 live
  // copies" before either has written anything, and both pass the guard below
  // and both proceed — leaving zero live copies, which is exactly what that
  // guard exists to prevent (see the "two concurrent requests" test). A track
  // with nothing to serialize against (unknown id, or no dup_key) locks on its
  // own id instead, which just means it never contends with anything. See
  // lib/fileLock.js for why a namespaced key here is safe to share the lock
  // map with the realpath keys the move itself locks on below.
  const dupKey = getDupKeyForTrack(db, trackId);
  return withFileLock(`dup:${dupKey ?? trackId}`, () => trashLockedCopy({ trackId, db }));
}

async function trashLockedCopy({ trackId, db }) {
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');

  // Re-read now that the lock is held, not carried over from before it: a
  // count read before the lock is exactly the count a racing caller for a
  // sibling copy could also have read, which is the race this lock exists to
  // close. Still decided from the index alone, before anything touches disk —
  // a page left open since yesterday is precisely the case where the client's
  // idea of how many copies exist is the thing that is out of date.
  const copies = liveCopyCountForTrack(db, trackId);
  if (copies < 2) {
    throw new ConflictError('This is the only copy of this track, so it cannot be moved aside.');
  }

  // The path comes from our own index and is still re-validated before the file
  // is touched — the same guard the cover, stream and tag-edit routes use.
  const real = await assertReadableInsideMusicDir(track.path);
  const dest = assertInsideMusicDir(trashPathFor(real));

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Claimed exactly, not suffixed. A suffix used to be offered here when the
    // mirrored path was already occupied, but that occupant is not necessarily
    // this track's own history — it can be an unrelated file, and restoring
    // later recomputes the *canonical* mirror path rather than remembering
    // which suffix was claimed. That combination silently moved the wrong
    // bytes into the library on Undo, with no error, and no scan ever catches
    // it. Refusing instead of suffixing makes trash and restore exact
    // inverses, which is the property that makes Undo trustworthy at all.
    let handle;
    try {
      handle = await fs.open(dest, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.warn(`duplicateTrash: ${dest} already exists, refusing to trash over it`);
        throw new ConflictError('The trash already holds a file at that path. Restore or remove it first.');
      }
      throw err;
    }
    await handle.close();

    // Locked on the resolved path too, so this queues behind (and ahead of) a
    // tag write to the same file rather than racing it — see lib/fileLock.js.
    // A different key from the dup_key lock this function is already running
    // inside: that one is per group, this one is per file, and both apply.
    await withFileLock(real, () => moveOnto(real, dest));

    // Both ends of the move, so the recursive MUSIC_DIR watcher doesn't debounce
    // a full library rescan out of work the app just did itself. recentWrites is
    // keyed on basename, so these usually collapse into one entry.
    noteWrite(real);
    noteWrite(dest);

    // Stats the (now absent) file, marks the row removed and recomputes stats,
    // all in one transaction — libraryScanner.js:249 was written for exactly
    // this case. Deliberately after the move: a failure above must leave the
    // index untouched, or the app shows a track as gone while it is still there.
    // The inverse failure — this throwing after moveOnto has already
    // succeeded, leaving the row live at a path the file has just left — is
    // not guarded against further than this: it self-heals on the next full
    // scan, which finds the path gone and marks the row removed itself.
    await reindexFile(real);

    return { trackId, trashedPath: dest, remainingCopies: copies - 1 };
  } catch (err) {
    throw asMoveError(err, real);
  }
}

/**
 * Puts a moved-aside copy back where it came from.
 *
 * Session-scoped in practice: the Duplicates view fetches live rows only, so a
 * reloaded page has no trashed row to offer an Undo for, and purgeRemoved
 * eventually deletes the row this looks up. Recovering after that is a move in a
 * file manager, which the mirrored layout makes obvious.
 *
 * @returns {Promise<{trackId: number, restoredPath: string, track: object}>}
 */
export async function restoreDuplicate({ trackId, db = getDb() }) {
  const track = getRemovedTrackById(db, trackId);
  if (!track) throw new NotFoundError('That track is not in the trash');

  // Lexical rather than symlink-safe: the file is not at this path any more, so
  // there is nothing to realpath. trashPathFor resolves the same way.
  const original = assertInsideMusicDir(track.path);
  const source = assertInsideMusicDir(trashPathFor(original));

  try {
    // The album directory may have been tidied away while the copy was aside.
    await fs.mkdir(path.dirname(original), { recursive: true });

    // Claimed exactly, the same way the move out now claims its trash slot
    // exactly (see trashLockedCopy): suffixing here would restore to
    // "Title (2).flac" when something occupies the original name, quietly
    // manufacturing a new duplicate — a comic outcome for this feature. Refusing
    // leaves the copy in the trash, where the user can still get at it.
    let handle;
    try {
      handle = await fs.open(original, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new ConflictError('Something is already at that path, so the copy has been left in the trash.');
      }
      throw err;
    }
    await handle.close();

    await withFileLock(original, () => moveOnto(source, original));
    noteWrite(original);
    noteWrite(source);
    await reindexFile(original);

    return { trackId, restoredPath: original, track: getTrackById(db, trackId) };
  } catch (err) {
    throw asMoveError(err, original);
  }
}
