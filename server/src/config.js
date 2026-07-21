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
  youtubeApiKey: requireEnv('YOUTUBE_API_KEY'),
  musicbrainz: {
    contactEmail: requireEnv('MB_CONTACT_EMAIL'),
    appName: process.env.MB_APP_NAME || 'Tubarr',
    appVersion: process.env.MB_APP_VERSION || '0.1.0',
  },
  // Optional: enables the "Send to MeTube" button. Unset means the feature is hidden.
  metubeUrl: (process.env.METUBE_URL || '').replace(/\/+$/, '') || null,
};

export function userAgent() {
  const { appName, appVersion, contactEmail } = config.musicbrainz;
  return `${appName}/${appVersion} ( ${contactEmail} )`;
}
