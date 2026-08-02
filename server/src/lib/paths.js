import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { BadRequestError } from './httpErrors.js';

// Throws unless destPath resolves to somewhere inside MUSIC_DIR. Used on the
// write side (organize.js, guarding a MusicBrainz-sourced filename) and on the
// read side (the cover and stream routes, guarding a path read back out of the
// index). Purely lexical — see assertReadableInsideMusicDir for the symlink-safe
// variant used when the path is about to be opened.
export function assertInsideMusicDir(destPath) {
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(config.ingest.musicDir);
  if (!resolvedDest.startsWith(resolvedRoot + path.sep)) {
    // The path is logged, not returned: error messages reach the browser, and
    // the server's directory layout isn't the client's business.
    console.warn(`paths: refusing to write outside MUSIC_DIR: ${destPath}`);
    throw new BadRequestError('Refusing to write outside the music folder');
  }
  return resolvedDest;
}

// Symlink-safe containment check for a file we are about to read and serve.
// A lexical check alone isn't enough here: a symlink inside MUSIC_DIR pointing
// at /etc/shadow resolves lexically to an in-root path, so the real path has to
// be the thing that gets tested. Returns the resolved path to open.
export async function assertReadableInsideMusicDir(filePath) {
  let root;
  try {
    root = await fs.realpath(path.resolve(config.ingest.musicDir));
  } catch {
    // An unmounted volume makes the root itself unresolvable. Without this the
    // raw ENOENT escapes as a 500 on every route that reads a file — the same
    // failure the scanner already guards against before it wipes the index.
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

// The write-side containment check for the drop-off folder, and the guard on the
// one path in this app that deletes files it did not create. Stricter than the
// MUSIC_DIR equivalent because of that: the root is resolved through realpath so
// a symlinked DROPOFF_DIR can't point the delete at the music library, and a
// root that resolves to MUSIC_DIR, to a parent of it, or to the filesystem root
// is refused outright.
export async function assertInsideDropoffDir(destPath) {
  const configured = config.playlist.dropoffDir;
  if (!configured) throw new BadRequestError('No drop-off folder is configured');

  let root;
  try {
    root = await fs.realpath(path.resolve(configured));
  } catch {
    throw new BadRequestError('The drop-off folder is not readable');
  }

  const musicRoot = path.resolve(config.ingest.musicDir ?? '');
  if (root === path.parse(root).root) {
    throw new BadRequestError('Refusing to use the filesystem root as a drop-off folder');
  }
  if (musicRoot && (root === musicRoot || musicRoot.startsWith(root + path.sep))) {
    throw new BadRequestError('The drop-off folder must be outside the music folder');
  }

  const resolved = path.resolve(destPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.warn(`paths: refusing to write outside DROPOFF_DIR: ${destPath}`);
    throw new BadRequestError('Refusing to write outside the drop-off folder');
  }
  return resolved;
}
