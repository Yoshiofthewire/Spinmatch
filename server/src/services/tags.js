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
  const file = File.createFromPath(filePath);
  const filledFields = [];
  try {
    const { tag } = file;
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

    // Nothing to write means nothing to save. save() rewrites the whole
    // container, which bumps mtime and wakes the MUSIC_DIR watcher — so without
    // this, pressing Save on a manual edit form with nothing dirty rewrites the
    // file, and a bulk repair of an album that already agrees with its
    // MusicBrainz tracklist rewrites every file in it, to change nothing.
    if (filledFields.length) file.save();
  } finally {
    file.dispose();
  }
  // Recorded so the MUSIC_DIR watcher doesn't mistake our own write for an
  // external change and schedule a full library rescan for it — see
  // lib/recentWrites.js. Noted here rather than at each call site so no future
  // writer can forget, and noted even when the save above was skipped: the note
  // is a 30-second suppression window, so a spurious one costs nothing and a
  // missing one costs a full rescan.
  noteWrite(filePath);
  return { filledFields };
}
