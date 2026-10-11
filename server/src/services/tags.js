import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { File, Picture, PictureType, ByteVector } from 'node-taglib-sharp';
import { MAX_IMAGE_BYTES } from '../lib/imageBytes.js';
import { noteWrite } from '../lib/recentWrites.js';

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

// Pure preview of what writeTags would fill: the fields desired provides
// (non-null) that are currently empty. Used by the dry-run path so a preview can
// report planned fills without touching the file.
export function plannedFills(current, desired) {
  return Object.keys(desired).filter((key) => desired[key] != null && current[key] == null);
}

export async function readTags(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const { tag, properties } = file;
    return {
      // Decoded from the audio stream itself, so the tag-based matcher can
      // duration-confirm a candidate without Chromaprint/fpcalc installed.
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

// Reads the embedded front cover out of a file so the library can show album
// art without keeping a second copy on disk. Returns {bytes, mimeType} or null.
// Prefers an explicit FrontCover picture, falling back to the first one.
export async function readCoverArt(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const pictures = file.tag.pictures || [];
    if (!pictures.length) return null;
    const picture = pictures.find((p) => p.type === PictureType.FrontCover) || pictures[0];
    // The length is checked before toByteArray(), which is what actually
    // materializes the copy. A tag can embed a picture of any size the container
    // allows, and this is served over HTTP — an unbounded copy per request on a
    // route the album grid calls in parallel.
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

// Writes `desired` into the file's tags. Fills only empty fields by default —
// the contract every caller but one relies on — and the two flags below each
// widen that, separately.
//
// `overwrite` widens the contract from "fill the blanks" to "correct the file":
// a field is written when it differs from what's desired, not only when it's
// empty. A field that already agrees is left alone and stays out of
// filledFields, so applying a match the file already matches honestly reports
// that nothing changed.
//
// Two callers earn it, for different reasons. The fingerprint path, where the
// audio itself says the existing tags name the wrong recording; and the manual
// edit path (services/tagEdit.js), where a person typed the value. That second
// caller passes a PARTIAL `desired` — only the fields it means to change — which
// combined with the `desiredValue == null` skip below gives it exactly "write
// these, leave everything else alone". That is why manual editing needs no
// function of its own here, and also why it cannot remove a tag: a null means
// "no opinion" throughout this module, and nothing gives it a second meaning.
//
// `replaceCoverArt` is the same widening for the embedded picture, and is
// deliberately a separate flag rather than something `overwrite` implies:
// correcting a file's text tags and swapping its artwork are different
// decisions, and either is worth making without the other. Without it, art is
// only ever written to a file that has none.
export async function writeTags(
  filePath,
  desired,
  { coverImage, overwrite = false, replaceCoverArt = false } = {},
) {
  const opts = { coverImage, overwrite, replaceCoverArt };
  // Dry run on the original first: nothing to change means no copy, no save.
  const filledFields = withFile(filePath, (file) => applyTags(file.tag, desired, opts));
  // Recorded so the MUSIC_DIR watcher doesn't treat our own write as an
  // external change (lib/recentWrites.js). Noted even for a no-op: a spurious
  // note costs nothing, a missing one costs a full rescan.
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

// save() rewrites the file in place, so a crash mid-save would truncate the
// user's music. Tag a same-directory copy instead and rename it over the
// original. The temp is a dot-file (the scanner skips those) and keeps the real
// extension last so taglib still detects the format.
async function saveViaTemp(filePath, edit) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.spinmatch-tmp-${randomBytes(6).toString('hex')}${ext}`);
  noteWrite(tmp);
  try {
    const { mode } = await fs.stat(filePath);
    await fs.copyFile(filePath, tmp, fsConstants.COPYFILE_EXCL);
    withFile(tmp, edit);
    const fh = await fs.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  const dh = await fs.open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
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

  // No coverImage means there's nothing to put there — asking to replace art
  // must never end up removing the art the file already has.
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
