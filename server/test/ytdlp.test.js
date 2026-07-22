import test from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { searchCandidates } = await import('../src/services/ytdlp.js');
const { RateLimitedError, UpstreamUnavailableError } = await import('../src/lib/httpErrors.js');

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

test('searchCandidates parses NDJSON output into {id, title, durationMs}', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const stdout =
      [
        JSON.stringify({ id: 'abc123', title: 'Song A', duration: 202 }),
        JSON.stringify({ id: 'def456', title: 'Song B', duration: 170 }),
      ].join('\n') + '\n';
    callback(null, stdout, '');
  });

  const candidates = await searchCandidates('some query');
  assert.deepEqual(candidates, [
    { id: 'abc123', title: 'Song A', durationMs: 202000 },
    { id: 'def456', title: 'Song B', durationMs: 170000 },
  ]);
});

test('searchCandidates filters out candidates with a missing duration', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const stdout =
      [
        JSON.stringify({ id: 'live-1', title: 'Live stream', duration: null }),
        JSON.stringify({ id: 'def456', title: 'Song B', duration: 170 }),
      ].join('\n') + '\n';
    callback(null, stdout, '');
  });

  const candidates = await searchCandidates('some query');
  assert.deepEqual(candidates, [{ id: 'def456', title: 'Song B', durationMs: 170000 }]);
});

test('searchCandidates returns an empty array when yt-dlp finds nothing', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => callback(null, '', ''));
  const candidates = await searchCandidates('nothing found');
  assert.deepEqual(candidates, []);
});

test('searchCandidates passes the query as a single ytsearchN: arg, not shell-interpolated', async (t) => {
  let capturedArgs;
  mockExecFile(t, (bin, args, opts, callback) => {
    capturedArgs = args;
    callback(null, '', '');
  });

  await searchCandidates('Artist; rm -rf / #', 5);
  assert.ok(
    capturedArgs.includes('ytsearch5:Artist; rm -rf / #'),
    'the whole query must be a single argv element, never shell-parsed'
  );
});

test('a bot-check stderr message throws RateLimitedError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', "ERROR: [youtube] Sign in to confirm you're not a bot");
  });

  await assert.rejects(searchCandidates('anything'), RateLimitedError);
});

test('a 429 stderr message throws RateLimitedError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', 'ERROR: HTTP Error 429: Too Many Requests');
  });

  await assert.rejects(searchCandidates('anything'), RateLimitedError);
});

test('a generic non-zero exit throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', 'ERROR: unable to download video data');
  });

  await assert.rejects(searchCandidates('anything'), UpstreamUnavailableError);
});

test('malformed JSON on stdout throws UpstreamUnavailableError, not a raw SyntaxError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const stdout =
      [JSON.stringify({ id: 'abc123', title: 'Song A', duration: 202 }), 'not valid json'].join(
        '\n'
      ) + '\n';
    callback(null, stdout, '');
  });

  await assert.rejects(searchCandidates('anything'), UpstreamUnavailableError);
});

test('a missing yt-dlp binary throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('spawn yt-dlp ENOENT');
    error.code = 'ENOENT';
    callback(error, '', '');
  });

  await assert.rejects(searchCandidates('anything'), UpstreamUnavailableError);
});

test('a timed-out call throws UpstreamUnavailableError', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command timed out');
    error.killed = true;
    error.signal = 'SIGTERM';
    callback(error, '', '');
  });

  await assert.rejects(searchCandidates('anything'), UpstreamUnavailableError);
});
