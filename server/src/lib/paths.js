import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { BadRequestError } from './httpErrors.js';

// Lexical containment in MUSIC_DIR. Use assertReadableInsideMusicDir before opening a file.
export function assertInsideMusicDir(destPath) {
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(config.ingest.musicDir);
  if (!resolvedDest.startsWith(resolvedRoot + path.sep)) {
    // Logged, not returned: error messages reach the browser.
    console.warn(`paths: refusing to write outside MUSIC_DIR: ${destPath}`);
    throw new BadRequestError('Refusing to write outside the music folder');
  }
  return resolvedDest;
}

// Symlink-safe (realpath) containment check; returns the real path to open.
export async function assertReadableInsideMusicDir(filePath) {
  let root;
  try {
    root = await fs.realpath(path.resolve(config.ingest.musicDir));
  } catch {
    // Unmounted volume: a clear 400 rather than a raw ENOENT 500.
    console.warn('paths: MUSIC_DIR is not readable');
    throw new BadRequestError('The music folder is not readable');
  }
  let real;
  try {
    real = await fs.realpath(filePath);
  } catch {
    throw new BadRequestError('File is not readable');
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new BadRequestError('Refusing to read outside the music folder');
  }
  return real;
}

// Guards the only recursive delete of files we didn't create. Realpaths the root and
// refuses / and any overlap with MUSIC_DIR.
export async function assertInsideDropoffDir(destPath) {
  const configured = config.playlist.dropoffDir;
  if (!configured) throw new BadRequestError('No drop-off folder is configured');

  let root;
  try {
    root = await fs.realpath(path.resolve(configured));
  } catch {
    throw new BadRequestError('The drop-off folder is not readable');
  }

  // Realpath so a symlinked MUSIC_DIR compares by target; lexical fallback if unreadable.
  let musicRoot = path.resolve(config.ingest.musicDir ?? '');
  if (config.ingest.musicDir) {
    try {
      musicRoot = await fs.realpath(musicRoot);
    } catch {
      // Fall back to the lexical resolve computed above.
    }
  }
  if (root === path.parse(root).root) {
    throw new BadRequestError('Refusing to use the filesystem root as a drop-off folder');
  }
  // Equal, parent, or child: all put the delete or the copies inside the library.
  if (musicRoot && (
    root === musicRoot
    || musicRoot.startsWith(root + path.sep)
    || root.startsWith(musicRoot + path.sep)
  )) {
    throw new BadRequestError('The drop-off folder must be outside the music folder');
  }

  // The bare root must never pass: a name sanitizing to '.' would rm all of DROPOFF_DIR.
  const resolved = path.resolve(destPath);
  if (!resolved.startsWith(root + path.sep)) {
    console.warn(`paths: refusing to write outside DROPOFF_DIR: ${destPath}`);
    throw new BadRequestError('Refusing to write outside the drop-off folder');
  }
  return resolved;
}
