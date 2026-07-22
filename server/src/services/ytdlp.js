import child_process from 'node:child_process';
import { config } from '../config.js';
import { UpstreamUnavailableError, RateLimitedError } from '../lib/httpErrors.js';
import { RateLimiter } from '../lib/rateLimiter.js';

const TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const BOT_CHECK_PATTERN = /sign in to confirm|too many requests|http error 429/i;

// yt-dlp has no official quota, but scraping YouTube directly risks bot
// detection whether it's one call or a bulk album run, so serialize calls
// app-wide at <=1/sec — same pattern as the MusicBrainz limiter.
const rateLimiter = new RateLimiter(1000);

function execYtDlp(args) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      config.ytdlpPath,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      }
    );
  });
}

async function runSearch(query, maxResults) {
  try {
    const { stdout } = await rateLimiter.schedule(() =>
      execYtDlp([
        '--flat-playlist',
        '--skip-download',
        '--no-warnings',
        '--quiet',
        '-j',
        `ytsearch${maxResults}:${query}`,
      ])
    );
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new UpstreamUnavailableError('yt-dlp is not installed or not on PATH');
    }
    if (err.killed) {
      throw new UpstreamUnavailableError('yt-dlp timed out');
    }
    const stderr = err.stderr || '';
    if (BOT_CHECK_PATTERN.test(stderr)) {
      throw new RateLimitedError(
        'YouTube is temporarily rate-limiting automated requests — try again shortly.'
      );
    }
    throw new UpstreamUnavailableError(
      `yt-dlp exited with an error: ${(stderr || err.message).slice(0, 500)}`
    );
  }
}

function parseCandidates(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((item) => item.duration != null)
    .map((item) => ({
      id: item.id,
      title: item.title,
      durationMs: Math.round(item.duration * 1000),
    }));
}

export async function searchCandidates(query, maxResults = 5) {
  const stdout = await runSearch(query, maxResults);
  return parseCandidates(stdout);
}
