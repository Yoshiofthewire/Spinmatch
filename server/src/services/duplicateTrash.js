import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getDb, withTransaction } from '../lib/db.js';
import {
  getTrackById, getRemovedTrackById, getDupKeyForTrack, otherLiveCopyPaths,
  markRemovedByPath, recomputeStats,
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

function trashRoot() {
  return path.join(path.resolve(config.ingest.musicDir), TRASH_DIR_NAME);
}

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

    // After the move, so a failed move leaves the index untouched. The file is gone either way,
    // so a failed reindex must not leave the row live.
    try {
      await reindexFile(real);
    } catch (err) {
      console.warn(`duplicateTrash: reindex after trashing ${real} failed: ${err.message}`);
      withTransaction(db, () => {
        markRemovedByPath(db, track.path);
        recomputeStats(db);
      });
    }

    return { trackId, trashedPath: dest };
  } catch (err) {
    throw asMoveError(err, real);
  }
}

/**
 * Only rows whose file is actually in the trash; anything else is a 404.
 * @returns {Promise<{trackId: number, restoredPath: string, track: object}>}
 */
export async function restoreDuplicate({ trackId, db = getDb() }) {
  const track = getRemovedTrackById(db, trackId);
  if (!track) throw new NotFoundError('That track is not in the trash');
  const relPath = path.relative(trashRoot(), trashPathFor(track.path));
  const { restoredPath } = await restoreFromTrash({ relPath });
  return { trackId, restoredPath, track: getTrackById(db, trackId) };
}

/** Every regular file in the trash, sorted by path. Symlinks are skipped, never followed. */
export async function listTrash({ limit, offset }) {
  const root = trashRoot();
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`duplicateTrash: could not list ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full).catch(() => null);
      if (stat?.isDirectory()) await walk(full);
      else if (stat?.isFile()) files.push({ relPath: path.relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  // A symlinked trash root would list files from wherever it points.
  if ((await fs.lstat(root).catch(() => null))?.isDirectory()) await walk(root);

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const musicRoot = path.resolve(config.ingest.musicDir);
  const page = await Promise.all(files.slice(offset, offset + limit).map(async (f) => ({
    ...f,
    // The trash mirrors the library, so the original sits at the same relative path.
    originalPath: f.relPath,
    restorable: await fs.lstat(path.join(musicRoot, f.relPath)).then(() => false, (err) => err.code === 'ENOENT'),
  })));
  return {
    entries: page,
    total: files.length,
    totals: { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) },
  };
}

// Path-based, so it works after purgeRemoved has dropped the track's row.
/** @returns {Promise<{relPath: string, restoredPath: string}>} */
export async function restoreFromTrash({ relPath }) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')
    || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    throw new BadRequestError('Not a path inside the trash');
  }
  const root = trashRoot();
  const source = path.join(root, relPath);
  let real;
  try {
    real = await fs.realpath(source);
  } catch {
    throw new NotFoundError('That file is not in the trash');
  }
  // No symlink anywhere on the way: the real path must be exactly the lexical one.
  if (real !== source || !(await fs.lstat(real)).isFile()) {
    console.warn(`duplicateTrash: refusing to restore ${source} (resolves to ${real})`);
    throw new BadRequestError('Only regular files inside the trash can be restored');
  }
  const original = assertInsideMusicDir(path.join(path.resolve(config.ingest.musicDir), relPath));

  try {
    await fs.mkdir(path.dirname(original), { recursive: true });
    // A symlinked folder in the library must not carry the file outside it.
    await assertReadableInsideMusicDir(path.dirname(original));

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

    return { relPath, restoredPath: original };
  } catch (err) {
    throw asMoveError(err, original);
  }
}
