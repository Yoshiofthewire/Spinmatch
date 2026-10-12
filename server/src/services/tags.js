import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { File, Picture, PictureType, ByteVector } from 'node-taglib-sharp';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';
import { noteWrite } from '../lib/recentWrites.js';
import { fsyncPath } from '../lib/moveFile.js';
import { BadRequestError } from '../lib/httpErrors.js';

const FIELD_TO_TAG_PROP = {
  artist: 'performers',
  title: 'title',
  album: 'album',
  trackNumber: 'track',
  disc: 'disc',
  year: 'year',
  genre: 'genres',
};

const NUMERIC_FIELDS = new Set(['trackNumber', 'disc', 'year']);

function readField(tag, field) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist') return tag.performers && tag.performers.length ? tag.performers.join(', ') : null;
  if (field === 'genre') return tag.genres && tag.genres.length ? tag.genres.join(', ') : null;
  const value = tag[prop];
  return value === undefined || value === null || value === '' || value === 0 ? null : value;
}

// '' clears the field; readField reads every cleared form back as null.
function writeField(tag, field, value) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist' || field === 'genre') {
    // An array restores a multi-value tag exactly (undo).
    tag[prop] = value === '' ? [] : Array.isArray(value) ? value : [value];
  } else if (value === '') {
    tag[prop] = NUMERIC_FIELDS.has(field) ? 0 : undefined;
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

function frontPicture(tag) {
  const pictures = tag.pictures || [];
  return pictures.find((p) => p.type === PictureType.FrontCover) || pictures[0] || null;
}

function pictureBytes(picture) {
  return { bytes: Buffer.from(picture.data.toByteArray()), mimeType: picture.mimeType || 'image/jpeg' };
}

// Embedded cover as {bytes, mimeType} or null; prefers FrontCover.
export async function readCoverArt(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const picture = frontPicture(file.tag);
    if (!picture) return null;
    // Size-check before toByteArray() copies it; embedded art is unbounded and served over HTTP.
    const length = picture.data?.length ?? 0;
    if (length > MAX_IMAGE_BYTES) {
      console.warn(`tags: embedded cover in ${filePath} is ${length} bytes, over the ${MAX_IMAGE_BYTES} limit — skipping`);
      return null;
    }
    return pictureBytes(picture);
  } finally {
    file.dispose();
  }
}

// Fills only empty fields by default. `overwrite` writes any field that differs;
// `replaceCoverArt` is the separate equivalent for art. A null in `desired` means
// "no opinion"; only '' with `overwrite` (or `removeCoverArt`) removes anything.
// `before` holds each written field's old value (coverArt: {bytes, mimeType} or null).
export async function writeTags(
  filePath,
  desired,
  { coverImage, overwrite = false, replaceCoverArt = false, removeCoverArt = false } = {},
) {
  const opts = { coverImage, overwrite, replaceCoverArt, removeCoverArt };
  // Dry run on the original first: nothing to change means no copy, no save.
  const { filledFields, before } = withFile(filePath, (file) => applyTags(file.tag, desired, opts));
  // Tell the watcher this is our write; noted even for a no-op (a miss costs a rescan).
  noteWrite(filePath);
  if (filledFields.length) {
    await saveViaTemp(filePath, (file) => {
      applyTags(file.tag, desired, opts);
      file.save();
    });
  }
  return { filledFields, before };
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

function applyTags(tag, desired, { coverImage, overwrite, replaceCoverArt, removeCoverArt }) {
  const filledFields = [];
  const before = {};
  for (const field of Object.keys(FIELD_TO_TAG_PROP)) {
    const desiredValue = desired[field];
    if (desiredValue == null || (desiredValue === '' && !overwrite)) continue;
    const current = readField(tag, field);
    const target = desiredValue === '' ? null : desiredValue;
    const shouldWrite = overwrite ? current !== target : current == null;
    if (shouldWrite) {
      const list = tag[FIELD_TO_TAG_PROP[field]];
      // Multi-value artist/genre is kept as its list so undo restores it exactly.
      before[field] = Array.isArray(list) && list.length > 1 ? [...list] : current;
      writeField(tag, field, desiredValue);
      filledFields.push(field);
    }
  }

  // Replacing without a coverImage must never remove existing art.
  const old = frontPicture(tag);
  // The old art is copied (for undo); refuse before copying an unbounded image.
  if (old && (removeCoverArt || (coverImage && replaceCoverArt)) && old.data.length > MAX_IMAGE_BYTES) {
    throw new BadRequestError('The cover art already in this file is too large to replace safely');
  }
  if (removeCoverArt && old) {
    before.coverArt = pictureBytes(old);
    tag.pictures = [];
    filledFields.push('coverArt');
  } else if (coverImage && (replaceCoverArt || !old)) {
    before.coverArt = old ? pictureBytes(old) : null;
    const picture = Picture.fromFullData(
      ByteVector.fromByteArray(coverImage.bytes),
      PictureType.FrontCover,
      coverImage.mimeType,
      ''
    );
    tag.pictures = [picture];
    filledFields.push('coverArt');
  }
  return { filledFields, before };
}
