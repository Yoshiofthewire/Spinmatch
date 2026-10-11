import fs from 'node:fs';
import path from 'node:path';

// Express only reads a number as a hop count; the string '1' silently matches nothing.
export function parseTrustProxy(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  // Subnet, IP list, or preset ('loopback'): Express takes the string.
  return value;
}

// Realpath once so scanner and write-side paths are identical strings. Lexical if missing.
function realDir(dir) {
  if (!dir) return null;
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export const config = {
  port: process.env.PORT || 3000,
  // Unset ignores X-Forwarded-* (safe when directly exposed: no IP spoofing past the
  // rate limiter). Set 1 or a subnet behind a reverse proxy you control.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  fpcalcPath: process.env.FPCALC_PATH || 'fpcalc',
  acoustidApiKey: process.env.ACOUSTID_API_KEY || null,
  musicbrainz: {
    contactEmail: process.env.MB_CONTACT_EMAIL || null,
    appName: process.env.MB_APP_NAME || 'Spinmatch',
    appVersion: process.env.MB_APP_VERSION || '0.1.0',
  },
  // Optional: ingest needs both MUSIC_DIR and INGEST_DIR; the library needs MUSIC_DIR.
  ingest: {
    musicDir: realDir(process.env.MUSIC_DIR),
    ingestDir: process.env.INGEST_DIR || null,
  },
  // AcoustID scores 0-1; MusicBrainz artist search scores 0-100.
  matching: {
    acoustidMinScore: Number(process.env.ACOUSTID_MIN_SCORE || 0.5),
    artistAutoAcceptScore: Number(process.env.ARTIST_AUTO_ACCEPT_SCORE || 90),
    durationToleranceMs: Number(process.env.DURATION_TOLERANCE_MS || 5000),
  },
  discovery: {
    // labs.listenbrainz.org is experimental; off leaves discovery on MusicBrainz relations.
    listenBrainzEnabled: process.env.LISTENBRAINZ_ENABLED !== '0',
  },
  library: {
    // Always opened (holds the admin login), so the default must be writable.
    // Docker sets LIBRARY_DB to the mounted volume.
    dbPath: process.env.LIBRARY_DB || 'data/library.db',
  },
  playlist: {
    // "Export to player" target; unset hides the feature. Must be outside MUSIC_DIR.
    dropoffDir: process.env.DROPOFF_DIR || null,
  },
};

export function userAgent() {
  const { appName, appVersion, contactEmail } = config.musicbrainz;
  return `${appName}/${appVersion} ( ${contactEmail} )`;
}

// Called from index.js, not at import, so tests importing config can't exit.
export function assertRequiredConfig() {
  if (!config.musicbrainz.contactEmail) {
    console.error('Missing required environment variable: MB_CONTACT_EMAIL');
    console.error('Copy .env.example to .env and fill in the required values.');
    process.exit(1);
  }
}

export function ingestEnabled() {
  return Boolean(config.ingest.musicDir && config.ingest.ingestDir);
}

export function libraryEnabled() {
  return Boolean(config.ingest.musicDir);
}

export function playlistExportEnabled() {
  return Boolean(config.ingest.musicDir && config.playlist.dropoffDir);
}
