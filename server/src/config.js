function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error('Copy .env.example to .env and fill in the required values.');
    process.exit(1);
  }
  return value;
}

export const config = {
  port: process.env.PORT || 3000,
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  fpcalcPath: process.env.FPCALC_PATH || 'fpcalc',
  acoustidApiKey: process.env.ACOUSTID_API_KEY || null,
  musicbrainz: {
    contactEmail: requireEnv('MB_CONTACT_EMAIL'),
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
};

export function userAgent() {
  const { appName, appVersion, contactEmail } = config.musicbrainz;
  return `${appName}/${appVersion} ( ${contactEmail} )`;
}

export function ingestEnabled() {
  return Boolean(config.acoustidApiKey && config.ingest.musicDir && config.ingest.ingestDir);
}
