// The ListenBrainz client. It sits on an explicitly experimental subdomain, so
// the contract that matters most is that nothing it does can break discovery:
// every failure mode returns null, and null is never cached.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { getSimilarArtists, resetSimilarCacheForTest } = await import('../src/services/listenBrainz.js');

const MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OTHER = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
}

const jsonResponse = (body) => ({ ok: true, json: async () => body });

test.beforeEach(() => resetSimilarCacheForTest());
test.after(() => { globalThis.fetch = realFetch; });

test('maps the response onto the shape discovery expects', async () => {
  stubFetch(() => jsonResponse([
    { artist_mbid: OTHER, name: 'Nirvana', score: 11156, comment: 'grunge band', type: 'Group' },
  ]));

  const result = await getSimilarArtists(MBID);
  assert.deepEqual(result, [{
    mbid: OTHER, name: 'Nirvana', score: 11156, comment: 'grunge band', type: 'Group',
  }]);
});

test('sends the artist mbid and the algorithm identifier', async () => {
  stubFetch(() => jsonResponse([]));
  await getSimilarArtists(MBID);
  assert.match(calls[0], /artist_mbids=a74b1b7f/);
  assert.match(calls[0], /algorithm=session_based_days_7500/);
});

// The seed appears in its own similar list for some artists; suggesting someone
// they're already looking at is noise.
test('drops the seed artist from its own results', async () => {
  stubFetch(() => jsonResponse([
    { artist_mbid: MBID, name: 'Itself', score: 999 },
    { artist_mbid: OTHER, name: 'Nirvana', score: 100 },
  ]));

  const result = await getSimilarArtists(MBID);
  assert.deepEqual(result.map((a) => a.name), ['Nirvana']);
});

test('an empty result is a real answer and is cached', async () => {
  stubFetch(() => jsonResponse([]));
  const first = await getSimilarArtists(MBID);
  const second = await getSimilarArtists(MBID);

  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(calls.length, 1, 'the remembered empty answer short-circuits');
});

test('a successful result is cached', async () => {
  stubFetch(() => jsonResponse([{ artist_mbid: OTHER, name: 'Nirvana', score: 1 }]));
  await getSimilarArtists(MBID);
  await getSimilarArtists(MBID);
  assert.equal(calls.length, 1);
});

// Everything below is the degrade path. null tells discovery to fall back to the
// relationship graph; caching null would turn a blip into an hour of quietly
// worse results.
test('a network failure returns null and is not cached', async () => {
  stubFetch(() => { throw new Error('ECONNREFUSED'); });
  assert.equal(await getSimilarArtists(MBID), null);
  assert.equal(await getSimilarArtists(MBID), null);
  assert.equal(calls.length, 2, 'the failure was retried rather than remembered');
});

test('a non-ok status returns null', async () => {
  stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.equal(await getSimilarArtists(MBID), null);
});

test('malformed JSON returns null rather than throwing', async () => {
  stubFetch(() => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
  assert.equal(await getSimilarArtists(MBID), null);
});

// If the endpoint ever starts returning an object instead of a bare array, that
// is a shape change under us — degrade, don't crash.
test('an unexpected response shape returns null', async () => {
  stubFetch(() => jsonResponse({ payload: { artists: [] } }));
  assert.equal(await getSimilarArtists(MBID), null);
});

test('a missing mbid makes no request at all', async () => {
  stubFetch(() => jsonResponse([]));
  assert.equal(await getSimilarArtists(null), null);
  assert.equal(await getSimilarArtists(''), null);
  assert.equal(calls.length, 0);
});

test('the request carries a timeout signal', async () => {
  let signal;
  stubFetch((_url, opts) => { signal = opts?.signal; return jsonResponse([]); });
  await getSimilarArtists(MBID);
  assert.ok(signal, 'an AbortSignal is attached so a hung request cannot stall discovery');
});
