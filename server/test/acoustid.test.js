import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.ACOUSTID_API_KEY = 'test-acoustid-key';

const { lookup } = await import('../src/services/acoustid.js');
const { UpstreamUnavailableError, RateLimitedError } = await import('../src/lib/httpErrors.js');

function mockAcoustId() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get('https://api.acoustid.org');
}

test('lookup flattens results[].recordings[] into {recordingMbid, score} pairs', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(200, {
    status: 'ok',
    results: [
      {
        id: 'af-result-1',
        score: 0.9,
        recordings: [{ id: 'mb-recording-1', title: 'Song A' }, { id: 'mb-recording-2', title: 'Song A (live)' }],
      },
    ],
  });

  const candidates = await lookup({ fingerprint: 'AQAB...', durationSeconds: 200 });
  assert.deepEqual(candidates, [
    { recordingMbid: 'mb-recording-1', score: 0.9 },
    { recordingMbid: 'mb-recording-2', score: 0.9 },
  ]);
});

test('lookup returns an empty array when there are no results', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(200, { status: 'ok', results: [] });

  const candidates = await lookup({ fingerprint: 'AQAB-empty', durationSeconds: 200 });
  assert.deepEqual(candidates, []);
});

test('a {status:"error"} response body throws UpstreamUnavailableError', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(200, {
    status: 'error',
    error: { message: 'invalid fingerprint' },
  });

  await assert.rejects(lookup({ fingerprint: 'bad', durationSeconds: 200 }), UpstreamUnavailableError);
});

test('a 429 response throws RateLimitedError', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(429, {});

  await assert.rejects(lookup({ fingerprint: 'AQAB-429', durationSeconds: 200 }), RateLimitedError);
});

test('a network error throws UpstreamUnavailableError', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).replyWithError(new Error('boom'));

  await assert.rejects(lookup({ fingerprint: 'AQAB-network', durationSeconds: 200 }), UpstreamUnavailableError);
});

test('a repeat lookup for the same fingerprint is served from cache, not a second request', async () => {
  const pool = mockAcoustId();
  let callCount = 0;
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(200, () => {
    callCount += 1;
    return { status: 'ok', results: [{ id: 'r1', score: 1, recordings: [{ id: 'mb-1' }] }] };
  });

  const args = { fingerprint: 'AQAB-cache-test', durationSeconds: 180 };
  await lookup(args);
  await lookup(args);
  assert.equal(callCount, 1, 'second identical lookup should be served from cache');
});

test('lookup deduplicates by recordingMbid, keeping the highest score', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).reply(200, {
    status: 'ok',
    results: [
      {
        id: 'af-result-1',
        score: 0.6,
        recordings: [{ id: 'shared-recording', title: 'Song A' }],
      },
      {
        id: 'af-result-2',
        score: 0.9,
        recordings: [{ id: 'shared-recording', title: 'Song A' }, { id: 'other-recording', title: 'Other' }],
      },
    ],
  });

  const candidates = await lookup({ fingerprint: 'AQAB-dedup', durationSeconds: 200 });
  // Should deduplicate: shared-recording appears in both results (0.6 and 0.9),
  // keep only the 0.9 entry. Results sorted by score descending (best-first).
  assert.deepEqual(candidates, [
    { recordingMbid: 'shared-recording', score: 0.9 },
    { recordingMbid: 'other-recording', score: 0.9 },
  ]);
});
