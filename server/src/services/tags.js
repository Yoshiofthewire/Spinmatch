import { File, Picture, PictureType, ByteVector } from 'node-taglib-sharp';

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

// Pure preview of what writeMissingTags would fill: the fields desired provides
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
    return {
      bytes: Buffer.from(picture.data.toByteArray()),
      mimeType: picture.mimeType || 'image/jpeg',
    };
  } finally {
    file.dispose();
  }
}

export async function writeMissingTags(filePath, desired, { coverImage } = {}) {
  const file = File.createFromPath(filePath);
  const filledFields = [];
  try {
    const { tag } = file;
    for (const field of Object.keys(FIELD_TO_TAG_PROP)) {
      const desiredValue = desired[field];
      if (desiredValue == null) continue;
      const current = readField(tag, field);
      if (current == null) {
        writeField(tag, field, desiredValue);
        filledFields.push(field);
      }
    }

    const hasCoverArt = Boolean(tag.pictures && tag.pictures.length > 0);
    if (!hasCoverArt && coverImage) {
      const picture = Picture.fromFullData(
        ByteVector.fromByteArray(coverImage.bytes),
        PictureType.FrontCover,
        coverImage.mimeType,
        ''
      );
      tag.pictures = [picture];
      filledFields.push('coverArt');
    }

    file.save();
  } finally {
    file.dispose();
  }
  return { filledFields };
}
