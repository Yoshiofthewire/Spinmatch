import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.YOUTUBE_API_KEY = 'test-key';
process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { searchCandidates, getDurations, parseIso8601Duration, QUOTA_UNITS_PER_TRACK } = await import(
  '../src/services/youtube.js'
);
const { QuotaExceededError, UpstreamUnavailableError } = await import('../src/lib/httpErrors.js');

function mockAgentFor(host) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get(host);
}

test('parseIso8601Duration handles minutes/seconds', () => {
  assert.equal(parseIso8601Duration('PT3M22S'), 202000);
});

test('parseIso8601Duration handles hours', () => {
  assert.equal(parseIso8601Duration('PT1H2M3S'), (3600 + 120 + 3) * 1000);
});

test('parseIso8601Duration handles seconds only', () => {
  assert.equal(parseIso8601Duration('PT45S'), 45000);
});

test('parseIso8601Duration returns null for malformed input', () => {
  assert.equal(parseIso8601Duration('not-a-duration'), null);
  assert.equal(parseIso8601Duration(''), null);
});

test('QUOTA_UNITS_PER_TRACK reflects search (100) + batched videos.list (~1)', () => {
  assert.equal(QUOTA_UNITS_PER_TRACK, 101);
});

test('searchCandidates maps search.list items to {id, title}', async () => {
  const pool = mockAgentFor('https://www.googleapis.com');
  pool
    .intercept({ path: /\/youtube\/v3\/search.*/, method: 'GET' })
    .reply(200, {
      items: [
        { id: { videoId: 'abc123' }, snippet: { title: 'Song A' } },
        { id: { videoId: 'def456' }, snippet: { title: 'Song B' } },
      ],
    });

  const candidates = await searchCandidates('311 Down Music');
  assert.deepEqual(candidates, [
    { id: 'abc123', title: 'Song A' },
    { id: 'def456', title: 'Song B' },
  ]);
});

test('getDurations makes a single batched videos.list call for all ids', async () => {
  const pool = mockAgentFor('https://www.googleapis.com');
  let callCount = 0;
  pool
    .intercept({ path: /\/youtube\/v3\/videos.*/, method: 'GET' })
    .reply(200, () => {
      callCount += 1;
      return {
        items: [
          { id: 'abc123', contentDetails: { duration: 'PT3M22S' } },
          { id: 'def456', contentDetails: { duration: 'PT2M50S' } },
        ],
      };
    });

  const durations = await getDurations(['abc123', 'def456']);
  assert.equal(callCount, 1, 'videos.list should be called once, batched, not once per id');
  assert.deepEqual(durations, [
    { id: 'abc123', durationMs: 202000 },
    { id: 'def456', durationMs: 170000 },
  ]);
});

test('getDurations returns an empty array without making a call for an empty id list', async () => {
  mockAgentFor('https://www.googleapis.com'); // net connect disabled; any call would throw
  const durations = await getDurations([]);
  assert.deepEqual(durations, []);
});

test('a 403 quotaExceeded response throws QuotaExceededError', async () => {
  const pool = mockAgentFor('https://www.googleapis.com');
  pool
    .intercept({ path: /\/youtube\/v3\/search.*/, method: 'GET' })
    .reply(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });

  await assert.rejects(searchCandidates('anything'), QuotaExceededError);
});

test('a generic upstream failure throws UpstreamUnavailableError', async () => {
  const pool = mockAgentFor('https://www.googleapis.com');
  pool.intercept({ path: /\/youtube\/v3\/search.*/, method: 'GET' }).reply(500, {});

  await assert.rejects(searchCandidates('anything'), UpstreamUnavailableError);
});
