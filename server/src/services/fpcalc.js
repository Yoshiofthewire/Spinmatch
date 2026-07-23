import child_process from 'node:child_process';
import { config } from '../config.js';
import { UpstreamUnavailableError } from '../lib/httpErrors.js';

const TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;

function execFpcalc(args) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      config.fpcalcPath,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      }
    );
  });
}

export async function fingerprint(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFpcalc(['-json', '-length', '120', filePath]));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new UpstreamUnavailableError('fpcalc (Chromaprint) is not installed or not on PATH');
    }
    if (err.killed) {
      throw new UpstreamUnavailableError('fpcalc timed out');
    }
    const stderr = err.stderr || '';
    throw new UpstreamUnavailableError(
      `fpcalc exited with an error: ${(stderr || err.message).slice(0, 500)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new UpstreamUnavailableError(`fpcalc returned unparseable output: ${err.message}`);
  }

  return { durationSeconds: parsed.duration, fingerprint: parsed.fingerprint };
}
