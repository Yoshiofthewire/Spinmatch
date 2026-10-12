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
  // Set by assertRequiredConfig: a bad OIDC config must stop boot, not a test's import.
  oidc: null,
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// HTTPS only; plain http just for loopback (dev and tests). Credentials and fragments refused.
export function secureUrlError(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (url.username || url.password || url.hash) return 'must not contain credentials or a fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'must use https (http is allowed only for localhost)';
}

const OIDC_REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'];

// null when OIDC is off; throws on a partial or insecure config so it can't half-work.
export function parseOidcEnv(env) {
  const set = OIDC_REQUIRED.filter((k) => env[k]);
  if (set.length === 0) {
    if (env.OIDC_ONLY || env.OIDC_POST_LOGOUT_URI) {
      throw new Error(`OIDC_ONLY / OIDC_POST_LOGOUT_URI need ${OIDC_REQUIRED.join(', ')}`);
    }
    return null;
  }
  const missing = OIDC_REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error(`OIDC is partly configured; also set ${missing.join(', ')}`);
  for (const key of ['OIDC_ISSUER', 'OIDC_REDIRECT_URI', 'OIDC_POST_LOGOUT_URI']) {
    const error = env[key] && secureUrlError(env[key]);
    if (error) throw new Error(`${key} ${error}`);
  }
  if (env.OIDC_ONLY && env.OIDC_ONLY !== '1') throw new Error('OIDC_ONLY must be 1 or unset');
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI,
    postLogoutUri: env.OIDC_POST_LOGOUT_URI || null,
    only: env.OIDC_ONLY === '1',
  };
}

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
  try {
    config.oidc = parseOidcEnv(process.env);
  } catch (err) {
    console.error(`Refusing to start: ${err.message}`);
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
