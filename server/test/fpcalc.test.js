import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { fingerprint } = await import('../src/services/fpcalc.js');
const { UpstreamUnavailableError } = await import('../src/lib/httpErrors.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'silence.mp3');

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

test('fingerprint parses fpcalc JSON output into {durationSeconds, fingerprint}', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    callback(null, '{"duration": 2.03, "fingerprint": "AQABz0kkJUmSJEk"}', '');
  });

  const result = await fingerprint('/some/file.mp3');
  assert.deepEqual(result, { durationSeconds: 2.03, fingerprint: 'AQABz0kkJUmSJEk' });
});

test('fingerprint passes the file path as a single argv element, not shell-interpolated', async (t) => {
  let capturedArgs;
  mockExecFile(t, (bin, args, opts, callback) => {
    capturedArgs = args;
    callback(null, '{"duration": 1, "fingerprint": "x"}', '');
  });

  await fingerprint('/tmp/Artist; rm -rf / #.mp3');
  assert.ok(
    capturedArgs.includes('/tmp/Artist; rm -rf / #.mp3'),
    'the whole path must be a single argv element, never shell-parsed'
  );
  assert.deepEqual(capturedArgs.slice(0, 3), ['-json', '-length', '120']);
});

test('a missing fpcalc binary throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('spawn fpcalc ENOENT');
    error.code = 'ENOENT';
    callback(error, '', '');
  });

  await assert.rejects(fingerprint('/some/file.mp3'), UpstreamUnavailableError);
});

test('a timed-out call throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command timed out');
    error.killed = true;
    error.signal = 'SIGTERM';
    callback(error, '', '');
  });

  await assert.rejects(fingerprint('/some/file.mp3'), UpstreamUnavailableError);
});

test('a generic non-zero exit throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', 'ERROR: could not decode audio file');
  });

  await assert.rejects(fingerprint('/some/file.mp3'), UpstreamUnavailableError);
});

test('malformed JSON output throws UpstreamUnavailableError, not a raw SyntaxError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    callback(null, 'not json at all', '');
  });

  await assert.rejects(fingerprint('/some/file.mp3'), UpstreamUnavailableError);
});

test('fingerprint works against the real fpcalc binary and a real audio fixture', async () => {
  const result = await fingerprint(FIXTURE);
  assert.ok(result.durationSeconds > 5.5 && result.durationSeconds < 6.5, `expected ~6s, got ${result.durationSeconds}`);
  assert.equal(typeof result.fingerprint, 'string');
  assert.ok(result.fingerprint.length > 0);
});
