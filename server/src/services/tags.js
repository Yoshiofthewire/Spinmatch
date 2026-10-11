import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { File, Picture, PictureType, ByteVector } from 'node-taglib-sharp';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';
import { noteWrite } from '../lib/recentWrites.js';
import { fsyncPath } from '../lib/moveFile.js';

const FIELD_TO_TAG_PROP = {
  artist: 'performers',
  title: 'title',
  album: 'album',
  trackNumber: 'track',
  disc: 'disc',
  year: 'year',
  genre: 'genres',
};

function readField(tag, field) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist') return tag.performers && tag.performers.length ? tag.performers.join(', ') : null;
  if (field === 'genre') return tag.genres && tag.genres.length ? tag.genres.join(', ') : null;
  const value = tag[prop];
  return value === undefined || value === null || value === '' || value === 0 ? null : value;
}

function writeField(tag, field, value) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist') {
    tag.performers = [value];
  } else if (field === 'genre') {
    tag.genres = [value];
  } else {
    tag[prop] = value;
  }
}

// Dry-run preview of what a fill-only writeTags would write.
export function plannedFills(current, desired) {
  return Object.keys(desired).filter((key) => desired[key] != null && current[key] == null);
}

export async function readTags(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const { tag, properties } = file;
    return {
      // From the audio stream; lets the tag matcher confirm duration without fpcalc.
      durationMs: properties?.durationMilliseconds || null,
      artist: readField(tag, 'artist'),
      title: readField(tag, 'title'),
      album: readField(tag, 'album'),
      trackNumber: readField(tag, 'trackNumber'),
      disc: readField(tag, 'disc'),
      year: readField(tag, 'year'),
      genre: readField(tag, 'genre'),
      hasCoverArt: Boolean(tag.pictures && tag.pictures.length > 0),
    };
  } finally {
    file.dispose();
  }
}

// Embedded cover as {bytes, mimeType} or null; prefers FrontCover.
export async function readCoverArt(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const pictures = file.tag.pictures || [];
    if (!pictures.length) return null;
    const picture = pictures.find((p) => p.type === PictureType.FrontCover) || pictures[0];
    // Size-check before toByteArray() copies it; embedded art is unbounded and served over HTTP.
    const length = picture.data?.length ?? 0;
    if (length > MAX_IMAGE_BYTES) {
      console.warn(`tags: embedded cover in ${filePath} is ${length} bytes, over the ${MAX_IMAGE_BYTES} limit — skipping`);
      return null;
    }
    return {
      bytes: Buffer.from(picture.data.toByteArray()),
      mimeType: picture.mimeType || 'image/jpeg',
    };
  } finally {
    file.dispose();
  }
}

// Fills only empty fields by default. `overwrite` writes any field that differs;
// `replaceCoverArt` is the separate equivalent for art. A null in `desired` means
// "no opinion", so a partial `desired` touches only its fields and can't remove a tag.
export async function writeTags(
  filePath,
  desired,
  { coverImage, overwrite = false, replaceCoverArt = false } = {},
) {
  const opts = { coverImage, overwrite, replaceCoverArt };
  // Dry run on the original first: nothing to change means no copy, no save.
  const filledFields = withFile(filePath, (file) => applyTags(file.tag, desired, opts));
  // Tell the watcher this is our write; noted even for a no-op (a miss costs a rescan).
  noteWrite(filePath);
  if (filledFields.length) {
    await saveViaTemp(filePath, (file) => {
      applyTags(file.tag, desired, opts);
      file.save();
    });
  }
  return { filledFields };
}

function withFile(filePath, fn) {
  const file = File.createFromPath(filePath);
  try {
    return fn(file);
  } finally {
    file.dispose();
  }
}

// save() rewrites in place, so a crash could truncate the file: tag a copy and rename.
// Dot-file so the scanner skips it; real extension last so taglib detects the format.
async function saveViaTemp(filePath, edit) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.spinmatch-tmp-${randomBytes(6).toString('hex')}${ext}`);
  noteWrite(tmp);
  try {
    const { mode, uid, gid } = await fs.stat(filePath);
    await fs.copyFile(filePath, tmp, fsConstants.COPYFILE_EXCL);
    withFile(tmp, edit);
    await fsyncPath(tmp);
    await fs.chmod(tmp, mode);
    // Preserve ownership where permitted.
    await fs.chown(tmp, uid, gid).catch((err) => { if (err.code !== 'EPERM') throw err; });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await fsyncPath(dir);
}

function applyTags(tag, desired, { coverImage, overwrite, replaceCoverArt }) {
  const filledFields = [];
  for (const field of Object.keys(FIELD_TO_TAG_PROP)) {
    const desiredValue = desired[field];
    if (desiredValue == null) continue;
    const current = readField(tag, field);
    const shouldWrite = overwrite ? current !== desiredValue : current == null;
    if (shouldWrite) {
      writeField(tag, field, desiredValue);
      filledFields.push(field);
    }
  }

  // Replacing without a coverImage must never remove existing art.
  const hasCoverArt = Boolean(tag.pictures && tag.pictures.length > 0);
  if (coverImage && (replaceCoverArt || !hasCoverArt)) {
    const picture = Picture.fromFullData(
      ByteVector.fromByteArray(coverImage.bytes),
      PictureType.FrontCover,
      coverImage.mimeType,
      ''
    );
    tag.pictures = [picture];
    filledFields.push('coverArt');
  }
  return filledFields;
}
