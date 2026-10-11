import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  getTrackById, getRemovedTrackById, getDupKeyForTrack, otherLiveCopyPaths,
} from './libraryRepo.js';
import { reindexFile } from './libraryScanner.js';
import { assertInsideMusicDir, assertReadableInsideMusicDir } from '../lib/paths.js';
import { withFileLock } from '../lib/fileLock.js';
import { moveOnto } from '../lib/moveFile.js';
import { noteWrite } from '../lib/recentWrites.js';
import { NotFoundError, BadRequestError, ConflictError } from '../lib/httpErrors.js';

// Spinmatch never deletes files: duplicates move into a mirrored trash, and emptying it is left to the user.
// The dot prefix is load-bearing: walk() skips dot entries, which is what keeps trashed files out of the index.
export const TRASH_DIR_NAME = '.spinmatch-trash';

// Pure, lexical. ".." must be rejected before the join: path.join would normalize it
// back inside the root, and the file would land in the library instead of the trash.
export function trashPathFor(filePath) {
  const root = path.resolve(config.ingest.musicDir);
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BadRequestError('Refusing to write outside the music folder');
  }
  return path.join(root, TRASH_DIR_NAME, rel);
}

// User-facing move errors; ENOSPC comes from the cross-device copy fallback.
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

// Known fs codes become path-free 400s (path goes to the log); unknown errors stay 500s.
function asMoveError(err, filePath) {
  if (err?.status) return err;
  const known = MOVE_FAILURES[err?.code];
  if (!known) return err;
  console.warn(`duplicateTrash: ${filePath} failed: ${err.code} ${err.message}`);
  return new BadRequestError(known);
}

/** @returns {Promise<{trackId: number, trashedPath: string}>} */
export async function trashDuplicate({ trackId, db = getDb() }) {
  // Per dup_key, not per file: trashing two sibling copies concurrently could otherwise leave zero live copies.
  const dupKey = getDupKeyForTrack(db, trackId);
  return withFileLock(`dup:${dupKey ?? trackId}`, () => trashLockedCopy({ trackId, db }));
}

async function trashLockedCopy({ trackId, db }) {
  const track = getTrackById(db, trackId);
  if (!track) throw new NotFoundError('Track not found');

  // Must be read under the lock; never trust the client's copy count.
  const others = otherLiveCopyPaths(db, trackId);
  if (!others.length) {
    throw new ConflictError('This is the only copy of this track, so it cannot be moved aside.');
  }
  // The index can be stale, so another copy must actually be on disk.
  const present = await Promise.all(others.map((p) => fs.stat(p).then(() => true, () => false)));
  if (!present.includes(true)) {
    throw new ConflictError('No other copy of this track is on disk any more, so this one cannot be moved aside.');
  }

  // Indexed paths are still re-validated before touching the file.
  const real = await assertReadableInsideMusicDir(track.path);
  const dest = assertInsideMusicDir(trashPathFor(real));

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Claimed exactly, never suffixed, so trash and restore stay exact inverses.
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

    // Per-file lock too, so the move can't race a tag write to the same file.
    await withFileLock(real, () => moveOnto(real, dest));

    // Keep the watcher from rescanning on our own move.
    noteWrite(real);
    noteWrite(dest);

    // After the move, so a failed move leaves the index untouched. If this throws, the next scan heals it.
    await reindexFile(real);

    return { trackId, trashedPath: dest };
  } catch (err) {
    throw asMoveError(err, real);
  }
}

/**
 * Accepts any removed row, not only trashed ones; non-trashed rows fail as ENOENT only by accident.
 * @returns {Promise<{trackId: number, restoredPath: string, track: object}>}
 */
export async function restoreDuplicate({ trackId, db = getDb() }) {
  const track = getRemovedTrackById(db, trackId);
  if (!track) throw new NotFoundError('That track is not in the trash');

  // Lexical: the file is gone from this path, so there is nothing to realpath.
  const original = assertInsideMusicDir(track.path);
  const source = assertInsideMusicDir(trashPathFor(original));

  try {
    await fs.mkdir(path.dirname(original), { recursive: true });

    // Claimed exactly: suffixing would manufacture a new duplicate.
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
