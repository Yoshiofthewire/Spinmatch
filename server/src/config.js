// Express's `trust proxy` setting, parsed out of an environment variable.
//
// The parse is the whole point: env values are always strings, and Express only
// treats a *number* as a hop count. Handing it the string '1' — the value both
// the README and .env.example document — sends it down the IP/subnet-list branch
// instead, where it compiles to a matcher that matches nothing and is silently
// ignored. The setting appeared to be on and was off, which meant the login rate
// limiter keyed every request in a containerised deployment to the proxy's
// single IP, and the session cookie never got its Secure flag behind TLS.
// 'true' was worse: proxy-addr threw `invalid IP address: true` and the process
// died at boot.
export function parseTrustProxy(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  // A bare integer is a hop count and has to stay a number to be read as one.
  if (/^\d+$/.test(value)) return Number(value);
  // Anything else is a subnet, an IP list, or a named preset ('loopback'), all
  // of which Express expects as the string it already is.
  return value;
}

export const config = {
  port: process.env.PORT || 3000,
  // Express's `trust proxy` setting. Unset means X-Forwarded-* headers are
  // ignored entirely, which is the safe default for a directly-exposed process:
  // otherwise anyone could spoof their client IP past the login rate limiter, or
  // set X-Forwarded-Proto: https and get a Secure cookie the browser then
  // refuses to send back over plain HTTP. Set it to 1 (or a subnet) when running
  // behind a reverse proxy you control.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  fpcalcPath: process.env.FPCALC_PATH || 'fpcalc',
  acoustidApiKey: process.env.ACOUSTID_API_KEY || null,
  musicbrainz: {
    contactEmail: process.env.MB_CONTACT_EMAIL || null,
    appName: process.env.MB_APP_NAME || 'Spinmatch',
    appVersion: process.env.MB_APP_VERSION || '0.1.0',
  },
  // Optional: enables the "Send to MeTube" button. Unset means the feature is hidden.
  metubeUrl: (process.env.METUBE_URL || '').replace(/\/+$/, '') || null,
  // Optional: enables the local library ingest feature. All three must be set.
  ingest: {
    musicDir: process.env.MUSIC_DIR || null,
    ingestDir: process.env.INGEST_DIR || null,
  },
  // Confidence thresholds for automatic identification. Exposed as config rather
  // than baked into three separate modules so they can be tuned without a code
  // change: AcoustID scores 0-1, MusicBrainz artist search scores 0-100.
  matching: {
    acoustidMinScore: Number(process.env.ACOUSTID_MIN_SCORE || 0.5),
    artistAutoAcceptScore: Number(process.env.ARTIST_AUTO_ACCEPT_SCORE || 90),
    durationToleranceMs: Number(process.env.DURATION_TOLERANCE_MS || 5000),
  },
  discovery: {
    // ListenBrainz supplies the "sounds like" half of discovery. It lives on
    // labs.listenbrainz.org, which is explicitly experimental — so there is an
    // off switch. Turning it off leaves discovery running on the MusicBrainz
    // relationship graph alone rather than breaking it.
    listenBrainzEnabled: process.env.LISTENBRAINZ_ENABLED !== '0',
  },
  library: {
    // The DB is always opened (it stores the admin login), so the default must
    // be writable without config. Local dev falls back to a cwd-relative path;
    // Docker pins LIBRARY_DB=/data/db/library.db via the image's ENV so the
    // index/credential land on the mounted volume.
    dbPath: process.env.LIBRARY_DB || 'data/library.db',
  },
};

export function userAgent() {
  const { appName, appVersion, contactEmail } = config.musicbrainz;
  return `${appName}/${appVersion} ( ${contactEmail} )`;
}

// Called explicitly at startup (see index.js) rather than as an import-time
// side effect, so importing config.js in tests/tools can never kill the process.
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
