# yt-dlp Backend Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Spinmatch's YouTube Data API v3 integration with `yt-dlp`, removing the API key/quota requirement while keeping the app's scope unchanged (find + verify a matching YouTube video by duration; no downloading).

**Architecture:** `server/src/services/ytdlp.js` shells out to the `yt-dlp` binary via `node:child_process`'s `execFile` (args array, never a shell string) to run `yt-dlp --flat-playlist --skip-download --no-warnings --quiet -j "ytsearchN:<query>"`, which returns newline-delimited JSON already containing each candidate's duration — collapsing today's two YouTube API calls (search + batched duration lookup) into one subprocess call. Calls are serialized through the existing `RateLimiter` (same pattern as the MusicBrainz limiter) at ~1/sec to avoid tripping YouTube's bot detection during bulk album verification. A new `RateLimitedError` replaces `QuotaExceededError` for when YouTube blocks automated requests.

**Tech Stack:** Node.js 20+ built-ins only — `node:child_process`, `node:test` (with `t.mock.method` for mocking `execFile` in tests). No new npm dependencies.

## Global Constraints

- Never build the `yt-dlp` argument list via string concatenation passed through a shell — always call `execFile` with an args array (search queries are user/MusicBrainz-derived text).
- No new npm runtime dependency — shell out to the `yt-dlp` binary directly.
- Preserve current behavior: candidates with a missing/null duration are filtered out (same as today's YouTube API path).
- `RateLimitedError`: `code: 'RATE_LIMITED'`, `status: 429`.
- Docker runtime stage is `node:24-alpine` (musl libc) — install `yt-dlp` via `python3`/`pip`, not the official standalone binary (which is a glibc-only PyInstaller build).
- Frontend has no automated test suite (per README) — verify frontend task by running the client build.

---

### Task 1: yt-dlp search service (`services/ytdlp.js`)

**Files:**
- Create: `server/src/services/ytdlp.js`
- Create: `server/test/ytdlp.test.js`
- Modify: `server/src/lib/httpErrors.js` (add `RateLimitedError`; leave `QuotaExceededError` in place for now — still imported by `routes/verify.js` until Task 3)
- Modify: `server/src/config.js` (drop `youtubeApiKey`, add `ytdlpPath`)

**Interfaces:**
- Produces: `searchCandidates(query: string, maxResults?: number = 5): Promise<{id: string, title: string, durationMs: number}[]>` from `server/src/services/ytdlp.js` — this is the function Task 2's `verifyTrack.js` will consume, replacing the old `searchCandidates`/`getDurations` pair from `services/youtube.js`.
- Produces: `RateLimitedError` class from `server/src/lib/httpErrors.js` (code `RATE_LIMITED`, status 429).
- Produces: `config.ytdlpPath` (string, default `'yt-dlp'`, overridable via `YTDLP_PATH` env var).

- [ ] **Step 1: Add `RateLimitedError` to `httpErrors.js`**

Modify `server/src/lib/httpErrors.js` — add this class (keep every existing class, including `QuotaExceededError`, unchanged):

```js
export class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.code = 'RATE_LIMITED';
    this.status = 429;
  }
}
```

- [ ] **Step 2: Update `config.js`**

Replace the full contents of `server/src/config.js`:

```js
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
  musicbrainz: {
    contactEmail: requireEnv('MB_CONTACT_EMAIL'),
    appName: process.env.MB_APP_NAME || 'Spinmatch',
    appVersion: process.env.MB_APP_VERSION || '0.1.0',
  },
  // Optional: enables the "Send to MeTube" button. Unset means the feature is hidden.
  metubeUrl: (process.env.METUBE_URL || '').replace(/\/+$/, '') || null,
};

export function userAgent() {
  const { appName, appVersion, contactEmail } = config.musicbrainz;
  return `${appName}/${appVersion} ( ${contactEmail} )`;
}
```

- [ ] **Step 3: Write the failing tests for `services/ytdlp.js`**

Create `server/test/ytdlp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as child_process from 'node:child_process';

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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd server && node --test test/ytdlp.test.js`
Expected: FAIL — `Cannot find module '../src/services/ytdlp.js'`

- [ ] **Step 5: Implement `services/ytdlp.js`**

Create `server/src/services/ytdlp.js`:

```js
import * as child_process from 'node:child_process';
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && node --test test/ytdlp.test.js`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/services/ytdlp.js server/test/ytdlp.test.js server/src/lib/httpErrors.js server/src/config.js
git commit -m "Add yt-dlp search service alongside the existing YouTube API service"
```

---

### Task 2: Wire `verifyTrack.js` to the new service

**Files:**
- Modify: `server/src/services/verifyTrack.js`
- Modify: `server/test/verifyTrack.test.js`

**Interfaces:**
- Consumes: `searchCandidates(query, maxResults?): Promise<{id, title, durationMs}[]>` from `server/src/services/ytdlp.js` (Task 1).
- Produces: `verifyTrack({artist, title, album, lengthMs}): Promise<{status, video, deltaSeconds, candidatesConsidered}>` — unchanged shape, consumed by `routes/verify.js` (Task 3).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `server/test/verifyTrack.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { verifyTrack } = await import('../src/services/verifyTrack.js');

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

function ndjson(items) {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

test('verifyTrack retries without the album title when the full query has zero candidates', async (t) => {
  let searchCallCount = 0;
  mockExecFile(t, (bin, args, opts, callback) => {
    searchCallCount += 1;
    const query = args[args.length - 1];
    if (query.includes('Fallback Test Album')) {
      callback(null, ndjson([]), '');
    } else {
      callback(null, ndjson([{ id: 'vid-1', title: 'Found It', duration: 200 }]), '');
    }
  });

  const result = await verifyTrack({
    artist: 'Fallback Test Artist',
    title: 'Fallback Test Song',
    album: 'Fallback Test Album',
    lengthMs: 200000,
  });

  assert.equal(searchCallCount, 2, 'expected one search with album, one retry without it');
  assert.equal(result.status, 'confirmed');
  assert.equal(result.video.id, 'vid-1');
});

test('verifyTrack caches results so an identical repeat call makes no further yt-dlp calls', async (t) => {
  let searchCallCount = 0;
  mockExecFile(t, (bin, args, opts, callback) => {
    searchCallCount += 1;
    callback(null, ndjson([{ id: 'vid-cache', title: 'Cached Song', duration: 200 }]), '');
  });

  const args = { artist: 'Cache Test Artist', title: 'Cache Test Song', album: 'Cache Test Album', lengthMs: 200000 };
  const first = await verifyTrack(args);
  const second = await verifyTrack(args);

  assert.equal(searchCallCount, 1, 'second call should be served from cache, not re-invoke yt-dlp');
  assert.deepEqual(first, second);
});

test('verifyTrack returns no_results when yt-dlp has nothing even after the retry', async (t) => {
  mockExecFile(t, (bin, args, opts, callback) => callback(null, ndjson([]), ''));

  const result = await verifyTrack({
    artist: 'Empty Result Artist',
    title: 'Empty Result Song',
    album: 'Empty Result Album',
    lengthMs: 200000,
  });

  assert.equal(result.status, 'no_results');
  assert.equal(result.video, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/verifyTrack.test.js`
Expected: FAIL — old `verifyTrack.js` still imports `getDurations` from `./youtube.js`, so the mocked `execFile` is never called and results come back empty/wrong (or the YouTube-API code path errors trying to reach the network, since no HTTP mocking is set up anymore).

- [ ] **Step 3: Update `verifyTrack.js`**

Replace the full contents of `server/src/services/verifyTrack.js`:

```js
import { searchCandidates } from './ytdlp.js';
import { rankCandidates, pickResult } from './durationMatch.js';
import { TTLCache } from '../lib/cache.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new TTLCache();

function cacheKey({ artist, title, album, lengthMs }) {
  return `${artist}|${title}|${album || ''}|${lengthMs}`.toLowerCase();
}

async function fetchRankedCandidates(query, lengthMs) {
  const candidates = await searchCandidates(query);
  if (candidates.length === 0) return [];
  return rankCandidates(candidates, lengthMs);
}

export async function verifyTrack({ artist, title, album, lengthMs }) {
  const key = cacheKey({ artist, title, album, lengthMs });
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let ranked = await fetchRankedCandidates(`${artist} ${title} ${album || ''}`.trim(), lengthMs);
  if (ranked.length === 0 && album) {
    // Album title in the query can hurt matching (e.g. compilations, reissues) — retry without it.
    ranked = await fetchRankedCandidates(`${artist} ${title}`.trim(), lengthMs);
  }

  const result = { ...pickResult(ranked), candidatesConsidered: ranked.length };
  cache.set(key, result, CACHE_TTL_MS);
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/verifyTrack.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/verifyTrack.js server/test/verifyTrack.test.js
git commit -m "Point verifyTrack at the yt-dlp search service"
```

---

### Task 3: Route layer — drop quota concept, use `RateLimitedError`

**Files:**
- Modify: `server/src/routes/verify.js`
- Modify: `server/src/routes/releases.js`
- Modify: `server/src/lib/httpErrors.js` (remove `QuotaExceededError` — nothing will import it after this task)
- Modify: `server/test/routes/verify.test.js`
- Modify: `server/test/routes/releases.test.js`

**Interfaces:**
- Consumes: `RateLimitedError` from `server/src/lib/httpErrors.js` (Task 1); `verifyTrack` from `server/src/services/verifyTrack.js` (Task 2, unchanged shape).
- Produces: `POST /api/verify/album/:mbid` response no longer includes `estimatedQuotaUnits`; on a `RateLimitedError` mid-batch it returns `{ album, results, error: { code: 'RATE_LIMITED', message } }`. `GET /api/releases/:mbid/tracks` no longer includes `estimatedQuotaUnits`.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `server/test/routes/releases.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

function mockMusicBrainz() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent.get('https://musicbrainz.org');
}

test('GET /api/releases/:mbid/tracks returns the release and its tracks', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=route-release-group.*/ }).reply(200, {
    releases: [{ id: 'route-release-id', status: 'Official' }],
  });
  pool.intercept({ path: '/ws/2/release/route-release-id?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'route-release-id',
    title: 'Route Test Album',
    'artist-credit': [{ name: 'Route Test Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Track One', length: 180000, recording: { id: 'rec-1' } },
          { position: 2, title: 'Track Two', length: 200000, recording: { id: 'rec-2' } },
        ],
      },
    ],
  });

  const res = await fetch(`${baseUrl}/api/releases/route-release-group/tracks`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.release.title, 'Route Test Album');
  assert.equal(body.tracks.length, 2);
  assert.equal(body.estimatedQuotaUnits, undefined);
});

test('GET /api/releases/:mbid/tracks returns 404 when the release group has no releases', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=route-release-group-empty.*/ }).reply(200, {
    releases: [],
  });

  const res = await fetch(`${baseUrl}/api/releases/route-release-group-empty/tracks`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});
```

Replace the full contents of `server/test/routes/verify.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import * as child_process from 'node:child_process';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

function mockMusicBrainzAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/^localhost/); // let requests to our own test server through
  setGlobalDispatcher(agent);
  return agent;
}

function mockExecFile(t, impl) {
  t.mock.method(child_process, 'execFile', impl);
}

function ndjson(items) {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

test('POST /api/verify returns 400 when required fields are missing', async () => {
  mockMusicBrainzAgent();
  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artist: 'Only Artist' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/verify returns a confirmed match for a real-looking candidate', async (t) => {
  mockMusicBrainzAgent();
  mockExecFile(t, (bin, args, opts, callback) => {
    callback(null, ndjson([{ id: 'vid-verify-1', title: 'Verify Route Song', duration: 200 }]), '');
  });

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artist: 'Verify Route Artist',
      title: 'Verify Route Song',
      album: 'Verify Route Album',
      lengthMs: 200000,
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'confirmed');
  assert.equal(body.video.id, 'vid-verify-1');
});

test('POST /api/verify surfaces a rate-limited message and 429 status', async (t) => {
  mockMusicBrainzAgent();
  mockExecFile(t, (bin, args, opts, callback) => {
    const error = new Error('Command failed');
    error.code = 1;
    callback(error, '', "ERROR: [youtube] Sign in to confirm you're not a bot");
  });

  const res = await fetch(`${baseUrl}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artist: 'Rate Limited Artist',
      title: 'Rate Limited Song',
      album: 'Rate Limited Album',
      lengthMs: 200000,
    }),
  });

  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
});

test('POST /api/verify/album/:mbid returns partial results plus a rate-limited error mid-batch', async (t) => {
  const agent = mockMusicBrainzAgent();
  const mb = agent.get('https://musicbrainz.org');

  mb.intercept({ path: /\/ws\/2\/release\?.*release-group=bulk-album-test.*/ }).reply(200, {
    releases: [{ id: 'bulk-release-id', status: 'Official' }],
  });
  mb.intercept({ path: '/ws/2/release/bulk-release-id?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'bulk-release-id',
    title: 'Bulk Test Album',
    'artist-credit': [{ name: 'Bulk Test Artist' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Bulk Track One', length: 180000, recording: { id: 'rec-1' } },
          { position: 2, title: 'Bulk Track Two', length: 190000, recording: { id: 'rec-2' } },
        ],
      },
    ],
  });

  mockExecFile(t, (bin, args, opts, callback) => {
    const query = args[args.length - 1];
    if (query.includes('Bulk Track One')) {
      callback(null, ndjson([{ id: 'vid-bulk-1', title: 'Bulk Track One', duration: 180 }]), '');
    } else {
      const error = new Error('Command failed');
      error.code = 1;
      callback(error, '', "ERROR: [youtube] Sign in to confirm you're not a bot");
    }
  });

  const res = await fetch(`${baseUrl}/api/verify/album/bulk-album-test`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.results.length, 1, 'only the first track should have completed before the rate limit hit');
  assert.equal(body.results[0].title, 'Bulk Track One');
  assert.equal(body.results[0].status, 'confirmed');
  assert.equal(body.error.code, 'RATE_LIMITED');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/routes/verify.test.js test/routes/releases.test.js`
Expected: FAIL — routes still reference `QUOTA_UNITS_PER_TRACK`/`QuotaExceededError` and return `estimatedQuotaUnits`.

- [ ] **Step 3: Update `routes/verify.js`**

Replace the full contents of `server/src/routes/verify.js`:

```js
import { Router } from 'express';
import { verifyTrack } from '../services/verifyTrack.js';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { BadRequestError, RateLimitedError, NotFoundError } from '../lib/httpErrors.js';

export const verifyRouter = Router();

verifyRouter.post('/', async (req, res, next) => {
  try {
    const { artist, title, album, lengthMs } = req.body || {};
    if (!artist || !title || !lengthMs) {
      throw new BadRequestError('artist, title, and lengthMs are required');
    }
    const result = await verifyTrack({ artist, title, album, lengthMs });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

verifyRouter.post('/album/:mbid', async (req, res, next) => {
  try {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) throw new NotFoundError('No release found for this release group');

    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    const results = [];

    for (const track of tracks) {
      if (track.lengthMs == null) {
        results.push({ position: track.position, title: track.title, status: 'no_results', video: null, deltaSeconds: null });
        continue;
      }
      try {
        const verified = await verifyTrack({
          artist: release.artist,
          title: track.title,
          album: release.title,
          lengthMs: track.lengthMs,
        });
        results.push({ position: track.position, title: track.title, lengthMs: track.lengthMs, ...verified });
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return res.json({
            album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
            results,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }

    res.json({
      album: { mbid: req.params.mbid, title: release.title, artist: release.artist },
      results,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Update `routes/releases.js`**

Replace the full contents of `server/src/routes/releases.js`:

```js
import { Router } from 'express';
import { resolvePrimaryReleaseForGroup, getReleaseWithTracks } from '../services/musicbrainz.js';
import { NotFoundError } from '../lib/httpErrors.js';

export const releasesRouter = Router();

releasesRouter.get('/:mbid/tracks', async (req, res, next) => {
  try {
    const releaseMbid = await resolvePrimaryReleaseForGroup(req.params.mbid);
    if (!releaseMbid) throw new NotFoundError('No release found for this release group');

    const { release, tracks } = await getReleaseWithTracks(releaseMbid);
    res.json({ release, tracks });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Remove `QuotaExceededError` from `httpErrors.js`**

Modify `server/src/lib/httpErrors.js` — delete this class (nothing imports it after Step 3/4 above):

```js
export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = 'QUOTA_EXCEEDED';
    this.status = 403;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && node --test test/routes/verify.test.js test/routes/releases.test.js`
Expected: PASS (2 releases tests, 4 verify tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/verify.js server/src/routes/releases.js server/src/lib/httpErrors.js server/test/routes/verify.test.js server/test/routes/releases.test.js
git commit -m "Drop YouTube quota concept from routes; use RateLimitedError"
```

---

### Task 4: Delete the old YouTube Data API service

**Files:**
- Delete: `server/src/services/youtube.js`
- Delete: `server/test/youtube.test.js`
- Modify: `server/test/musicbrainz.test.js` (remove stale `YOUTUBE_API_KEY` bootstrap line)
- Modify: `server/test/routes/search.test.js` (remove stale `YOUTUBE_API_KEY` bootstrap line)
- Modify: `server/test/routes/artists.test.js` (remove stale `YOUTUBE_API_KEY` bootstrap line)
- Modify: `server/test/routes/config.test.js` (remove stale `YOUTUBE_API_KEY` bootstrap line)

**Interfaces:** None — this task removes dead code only. After Task 3, nothing imports `server/src/services/youtube.js`.

- [ ] **Step 1: Confirm nothing still imports the old service**

Run: `grep -rn "services/youtube" server/src server/test`
Expected: no output (empty)

- [ ] **Step 2: Delete the old service and its test**

```bash
git rm server/src/services/youtube.js server/test/youtube.test.js
```

- [ ] **Step 3: Remove the stale `YOUTUBE_API_KEY` line from remaining test files**

In each of the four files below, delete the line `process.env.YOUTUBE_API_KEY = 'test-key';` (it's a no-op now that `config.js` no longer requires it):
- `server/test/musicbrainz.test.js`
- `server/test/routes/search.test.js`
- `server/test/routes/artists.test.js`
- `server/test/routes/config.test.js`

- [ ] **Step 4: Run the full backend test suite**

Run: `cd server && npm test`
Expected: PASS (all suites, no reference to `services/youtube.js` remains)

- [ ] **Step 5: Commit**

```bash
git add -A server/test
git commit -m "Remove the old YouTube Data API service and stale test bootstrap lines"
```

---

### Task 5: Docker + docs — install yt-dlp, drop API key setup

**Files:**
- Modify: `Dockerfile`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** None — infra/docs only, no code interfaces.

- [ ] **Step 1: Update the Dockerfile runtime stage**

In `Dockerfile`, the current runtime stage (lines 12-23) is:

```dockerfile
# ---- Runtime stage: server + its production deps + the built client only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package.json
RUN npm install --prefix server --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY --from=build /app/client/dist client/dist

EXPOSE 3000
CMD ["node", "server/src/index.js"]
```

Replace it with:

```dockerfile
# ---- Runtime stage: server + its production deps + the built client only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# yt-dlp is a Python app; the official standalone binary is a glibc-only
# PyInstaller build and isn't reliable on Alpine's musl libc, so install it
# via pip into the Python already available through apk instead.
RUN apk add --no-cache python3 py3-pip && pip install --break-system-packages --no-cache-dir yt-dlp
COPY server/package.json server/package.json
RUN npm install --prefix server --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY --from=build /app/client/dist client/dist

EXPOSE 3000
CMD ["node", "server/src/index.js"]
```

- [ ] **Step 2: Update `.env.example`**

Replace the full contents of `.env.example`:

```
PORT=3000

# Optional: override the yt-dlp binary name/path if it's not on PATH as `yt-dlp`.
YTDLP_PATH=yt-dlp

# Required: MusicBrainz requires a real contact email in the User-Agent
# string of every request, per their API usage policy.
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Spinmatch
MB_APP_VERSION=0.1.0

# Optional: base URL of a MeTube instance (https://github.com/alexta69/metube).
# When set, a "Send to MeTube" button appears next to YouTube results, posting
# the video URL to {METUBE_URL}/add from the browser. Leave blank to hide it.
METUBE_URL=
```

- [ ] **Step 3: Update `README.md`**

Replace the "Prerequisites" section (lines 9-12):

```markdown
## Prerequisites

- Node.js 20+ (Node 24 recommended — this project uses native `fetch` and `--env-file`)
- A YouTube Data API v3 key (see below)
```

with:

```markdown
## Prerequisites

- Node.js 20+ (Node 24 recommended — this project uses native `fetch` and `--env-file`)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) installed and on `PATH`
```

Replace the "Setting up a YouTube Data API v3 key" section (lines 14-27):

```markdown
## Setting up a YouTube Data API v3 key

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project
   (e.g. "spinmatch").
2. Navigate to **APIs & Services → Library**, search for "YouTube Data API v3", and click **Enable**.
3. Navigate to **APIs & Services → Credentials → Create Credentials → API key**.
4. Click **Restrict key**, and under "API restrictions" choose **Restrict key** and select only
   **YouTube Data API v3** — this limits the blast radius if the key ever leaks.
5. Copy the key.
6. The free tier gives you 10,000 quota units/day. Each track lookup costs about 101 units
   (100 for the search, ~1 for the batched duration lookup), so roughly 100 single-track
   lookups per day, or fewer if you use the bulk "Find all on YouTube" album action. You can
   check your usage under **APIs & Services → Enabled APIs → YouTube Data API v3 → Quotas**.
```

with:

```markdown
## Installing yt-dlp

Spinmatch looks up and verifies YouTube matches by shelling out to `yt-dlp` — there's no API key
or daily quota. Install it with one of:

```
pipx install yt-dlp   # recommended: isolated, easy to upgrade with `pipx upgrade yt-dlp`
pip install --user yt-dlp
brew install yt-dlp   # macOS
```

Confirm it's on `PATH`: `yt-dlp --version`. If you install it somewhere not on `PATH`, set
`YTDLP_PATH` in `.env` to the full path of the binary.

Because yt-dlp scrapes YouTube directly rather than calling an official API, heavy bulk use
(especially the "Find all on YouTube" album action) can trigger temporary rate limiting from
YouTube — Spinmatch serializes lookups to reduce this risk, but if it happens, wait a bit and
retry, and consider running `yt-dlp -U` to pick up any anti-bot-detection fixes.
```

Replace the "Configuration" env block (lines 32-39):

```
PORT=3000
YOUTUBE_API_KEY=your-key-here
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Spinmatch
MB_APP_VERSION=0.1.0
METUBE_URL=
```

with:

```
PORT=3000
YTDLP_PATH=yt-dlp
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Spinmatch
MB_APP_VERSION=0.1.0
METUBE_URL=
```

Replace the test-suite description in the "Tests" section (last paragraph, currently mentioning `undici`'s `MockAgent` for "MusicBrainz/YouTube"):

```markdown
Runs the backend test suite (Node's built-in test runner, with `undici`'s `MockAgent`
mocking MusicBrainz/YouTube — no live API calls, no quota used). There are no automated
frontend tests; verify UI changes by running `npm run dev` and testing in a browser.
```

with:

```markdown
Runs the backend test suite (Node's built-in test runner — `undici`'s `MockAgent` mocks
MusicBrainz, and `node:test`'s built-in method mocking stubs out `yt-dlp` calls — no live
network calls). There are no automated frontend tests; verify UI changes by running
`npm run dev` and testing in a browser.
```

- [ ] **Step 4: Verify the Docker image builds**

Run: `docker build -t spinmatch-ytdlp-check .`
Expected: build succeeds; this confirms `apk add python3 py3-pip` and the `pip install yt-dlp`
step work on the `node:24-alpine` base. (If Docker isn't available in this environment, skip this
step and note it as unverified — everything else in this task is documentation/config only.)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .env.example README.md
git commit -m "Document and containerize yt-dlp instead of the YouTube API key"
```

---

### Task 6: Frontend — remove quota UI, adopt `RATE_LIMITED`

**Files:**
- Modify: `client/src/components/BulkVerifyPanel.jsx`
- Modify: `client/src/components/VerifyButton.jsx`
- Modify: `client/src/pages/AlbumPage.jsx`
- Modify: `client/src/pages/AboutPage.jsx`
- Modify: `client/src/styles/index.css`
- Modify: `server/src/routes/releases.js` was already updated in Task 3 to drop `estimatedQuotaUnits` — this task is the matching frontend cleanup.

**Interfaces:**
- Consumes: `error.code === 'RATE_LIMITED'` (Task 3) instead of `'QUOTA_EXCEEDED'`.
- `BulkVerifyPanel` no longer accepts an `estimatedQuotaUnits` prop.

- [ ] **Step 1: Update `BulkVerifyPanel.jsx`**

In `client/src/components/BulkVerifyPanel.jsx`, change the function signature (line 10):

```jsx
export default function BulkVerifyPanel({ artist, album, releaseGroupMbid, trackCount, estimatedQuotaUnits }) {
```

to:

```jsx
export default function BulkVerifyPanel({ artist, album, releaseGroupMbid, trackCount }) {
```

Change the idle prompt (lines 54-62):

```jsx
      {state === 'idle' && (
        <div className="bulk-verify-prompt">
          <p className="muted">
            Finding all {trackCount} tracks on YouTube will use approximately{' '}
            <strong>{estimatedQuotaUnits}</strong> YouTube quota units (out of your 10,000/day limit).
          </p>
          <button onClick={handleClick}>Find all on YouTube</button>
        </div>
      )}
```

to:

```jsx
      {state === 'idle' && (
        <div className="bulk-verify-prompt">
          <p className="muted">
            Finding all {trackCount} tracks on YouTube checks them one at a time to avoid
            rate limits, so this may take a while.
          </p>
          <button onClick={handleClick}>Find all on YouTube</button>
        </div>
      )}
```

Change the error banner class (line 77):

```jsx
        <p className={error.code === 'QUOTA_EXCEEDED' ? 'banner banner-quota' : 'banner banner-error'}>
```

to:

```jsx
        <p className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
```

- [ ] **Step 2: Update `VerifyButton.jsx`**

In `client/src/components/VerifyButton.jsx`, change the error banner class (line 47):

```jsx
      <span className={error.code === 'QUOTA_EXCEEDED' ? 'banner banner-quota' : 'banner banner-error'}>
```

to:

```jsx
      <span className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
```

- [ ] **Step 3: Update `AlbumPage.jsx`**

In `client/src/pages/AlbumPage.jsx`, remove the `estimatedQuotaUnits` prop (lines 37-43):

```jsx
      <BulkVerifyPanel
        artist={data.release.artist}
        album={data.release.title}
        releaseGroupMbid={mbid}
        trackCount={data.tracks.length}
        estimatedQuotaUnits={data.estimatedQuotaUnits}
      />
```

to:

```jsx
      <BulkVerifyPanel
        artist={data.release.artist}
        album={data.release.title}
        releaseGroupMbid={mbid}
        trackCount={data.tracks.length}
      />
```

- [ ] **Step 4: Update `AboutPage.jsx`**

In `client/src/pages/AboutPage.jsx`, replace the quota blurb (lines 13-16):

```jsx
      <p className="muted">
        Verification runs against the YouTube Data API, which has a daily quota — heavy use
        (especially bulk album verification) may be rate-limited until the quota resets.
      </p>
```

with:

```jsx
      <p className="muted">
        Verification looks up each track via yt-dlp, not an official API — heavy use
        (especially bulk album verification) may be temporarily rate-limited by YouTube.
      </p>
```

- [ ] **Step 5: Rename the CSS class**

In `client/src/styles/index.css`, rename the class (lines 438-443):

```css
.banner-quota {
  background: rgba(240, 180, 41, 0.12);
  border-color: rgba(240, 180, 41, 0.3);
  color: var(--amber);
  font-weight: 600;
}
```

to:

```css
.banner-rate-limited {
  background: rgba(240, 180, 41, 0.12);
  border-color: rgba(240, 180, 41, 0.3);
  color: var(--amber);
  font-weight: 600;
}
```

- [ ] **Step 6: Verify the client builds cleanly**

Run: `npm run build -w client`
Expected: build succeeds with no errors (there's no automated frontend test suite per the
README, so a clean build plus a manual check in the browser — `npm run dev`, open an album page,
confirm the bulk-verify prompt copy and a normal verify flow — is the available verification).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/BulkVerifyPanel.jsx client/src/components/VerifyButton.jsx client/src/pages/AlbumPage.jsx client/src/pages/AboutPage.jsx client/src/styles/index.css
git commit -m "Remove YouTube quota UI; adopt RATE_LIMITED styling and copy"
```

---

## Final verification

- [ ] Run `npm test -w server` from the repo root — full backend suite green.
- [ ] Run `npm run build` from the repo root — client builds cleanly.
- [ ] Run `npm run dev`, open http://localhost:5173, search for a real artist/album, and confirm
      "Find on YouTube" and "Find all on YouTube" both work end-to-end against a real `yt-dlp`
      installation (requires `yt-dlp` actually installed locally — this is the one thing the
      mocked test suite can't cover).
