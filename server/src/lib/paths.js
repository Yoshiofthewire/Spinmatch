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
    throw new BadRequestError(`Refusing to write outside MUSIC_DIR: ${destPath}`);
  }
  return resolvedDest;
}

// Symlink-safe containment check for a file we are about to read and serve.
// A lexical check alone isn't enough here: a symlink inside MUSIC_DIR pointing
// at /etc/shadow resolves lexically to an in-root path, so the real path has to
// be the thing that gets tested. Returns the resolved path to open.
export async function assertReadableInsideMusicDir(filePath) {
  const root = await fs.realpath(path.resolve(config.ingest.musicDir));
  let real;
  try {
    real = await fs.realpath(filePath);
  } catch {
    throw new BadRequestError('File is not readable');
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new BadRequestError('Refusing to read outside MUSIC_DIR');
  }
  return real;
}
