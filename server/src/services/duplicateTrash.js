import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { getTrackById, liveCopyCountForTrack } from './libraryRepo.js';
import { reindexFile } from './libraryScanner.js';
import { assertInsideMusicDir, assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { claimFreeName, moveOnto } from '../lib/moveFile.js';
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
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');

  // Checked here rather than in the browser, and before anything touches the
  // disk. A page left open since yesterday is precisely the case where the
  // client's idea of how many copies exist is the thing that is out of date.
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
    const claimed = await claimFreeName(dest);

    // Locked on the resolved path, so this queues behind (and ahead of) a tag
    // write to the same file rather than racing it — see lib/fileLock.js.
    await withFileLock(real, () => moveOnto(real, claimed));

    // Both ends of the move, so the recursive MUSIC_DIR watcher doesn't debounce
    // a full library rescan out of work the app just did itself. recentWrites is
    // keyed on basename, so these usually collapse into one entry.
    noteWrite(real);
    noteWrite(claimed);

    // Stats the (now absent) file, marks the row removed and recomputes stats,
    // all in one transaction — libraryScanner.js:249 was written for exactly
    // this case. Deliberately after the move: a failure above must leave the
    // index untouched, or the app shows a track as gone while it is still there.
    await reindexFile(real);

    return { trackId, trashedPath: claimed, remainingCopies: copies - 1 };
  } catch (err) {
    throw asMoveError(err, real);
  }
}
