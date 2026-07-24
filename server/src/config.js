export const config = {
  port: process.env.PORT || 3000,
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
  return Boolean(config.acoustidApiKey && config.ingest.musicDir && config.ingest.ingestDir);
}

export function libraryEnabled() {
  return Boolean(config.ingest.musicDir);
}
