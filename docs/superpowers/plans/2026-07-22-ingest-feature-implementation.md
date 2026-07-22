# Spinmatch Ingest Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution checkpoint:** Implement Phase 0 and Phase 1 (Tasks 1–11) in order, then STOP and check in with the human before starting Phase 2 (Task 12 onward) — Phase 2 introduces destructive filesystem moves into the user's real music library. Phase 2/3 tasks below are specified at the same rigor as Phase 0/1 but should get a final quick review against how Phase 1 actually behaves in practice before dispatch.

**Goal:** Add a local-library ingest pipeline to Spinmatch: scan a mounted `INGEST_DIR` for audio files/album folders, acoustically fingerprint them (Chromaprint/AcoustID), confirm identity against MusicBrainz recording duration, fill in only the *missing* tags (never overwrite), embed cover art, and (Phase 2) move confirmed files into an organized `MUSIC_DIR` structure. Unmatched items stay untouched and are surfaced as "needs review."

**Architecture:** Clones the conventions established by the existing `services/ytdlp.js` (shell out to an external binary via `execFile` with an args array, default-imported `node:child_process`, typed errors) and `services/musicbrainz.js` (`mbFetch` + `RateLimiter` + `TTLCache`) for two new external integrations: `fpcalc` (Chromaprint CLI) and the AcoustID web API. Tag reading/writing goes through one new npm dependency, `node-taglib-sharp` (pure JS, no native/musl concerns), wrapped in a small `tags.js` service. An `ingest.js` orchestrator ties the leaf services together; a new `/api/ingest` router and `IngestPage`/`IngestPanel` (modeled on `BulkVerifyPanel.jsx`) expose it. The whole feature is optional and gated (like the existing MeTube integration) — hidden in the UI until `ACOUSTID_API_KEY`/`INGEST_DIR`/`MUSIC_DIR` are all configured.

**Tech Stack:** Node.js 20+ built-ins (`node:child_process`, `node:fs`, `fetch`), one new npm dependency (`node-taglib-sharp@^6.0.3`), `fpcalc`/Chromaprint as a system binary (installed via `apk add chromaprint` in the Alpine Docker image), `node:test` for tests (mocked `execFile`/`fetch` plus real tiny audio fixtures generated with `ffmpeg`, both confirmed available in this dev environment: `fpcalc version 1.6.0`, `ffmpeg version n8.1.2` with `libmp3lame`/`flac`/`aac`/`libvorbis` encoders).

## Global Constraints

- Never build the `fpcalc` argument list via a shell string — always `execFile` with an args array (file paths come from our own directory walk, but the convention from the yt-dlp migration is to never introduce a shell-interpolation habit).
- `node:child_process` must be imported as a **default import** (`import child_process from 'node:child_process'`), never a namespace import (`import * as child_process ...`) — namespace imports produce non-configurable properties per the ECMAScript spec, which breaks `t.mock.method` in tests. This bit the team during the yt-dlp migration; don't repeat it.
- No new error classes — reuse `UpstreamUnavailableError` (502), `NotFoundError` (404), `BadRequestError` (400), `RateLimitedError` (429) from `server/src/lib/httpErrors.js`.
- The whole ingest feature is **optional and gated**, not fail-fast: if `ACOUSTID_API_KEY`/`MUSIC_DIR`/`INGEST_DIR` aren't all set, `ingestEnabled()` is false, the UI hides the nav link/page, and ingest routes 404 — this must never block app startup (no `requireEnv` on these three).
- **Only fill in missing tag fields** — `tags.js`'s write path must read current tags first and skip any field that's already non-empty. Never overwrite an existing tag value.
- AcoustID's documented rate limit is 3 requests/sec per API key — the `acoustid.js` service's `RateLimiter` interval must be ~334ms.
- Duration-tolerance confirmation reuses the existing `services/durationMatch.js` (`rankCandidates`/`pickResult`, ±5s `withinTolerance`) — do not reimplement duration comparison logic.
- Known environment quirk (unrelated to this feature, hit during the yt-dlp migration): `node --test <directory>` (including `npm test`, which runs `node --test test/`) fails with a spurious `Cannot find module` error on this Node build. Run specific files (`node --test test/fpcalc.test.js`) or bare `node --test` (auto-discovers recursively) instead.
- All new server dependencies go in `server/package.json`'s `dependencies` (runtime), not `devDependencies`.

---

## Phase 0: Plumbing (config, gating, Docker)

### Task 1: Config, `ingestEnabled()`, and `/api/config` gating

**Files:**
- Modify: `server/src/config.js`
- Modify: `server/src/routes/config.js`
- Test: `server/test/routes/config.test.js`

**Interfaces:**
- Produces: `config.fpcalcPath` (string, default `'fpcalc'`), `config.acoustidApiKey` (string or `null`), `config.ingest.musicDir`/`config.ingest.ingestDir` (string or `null`), `export function ingestEnabled(): boolean` from `server/src/config.js` — consumed by Task 9 (routes) and Task 11 (frontend, via `/api/config`).

- [ ] **Step 1: Write the failing test**

Add to `server/test/routes/config.test.js` (after the existing tests):

```js
test('GET /api/config reports ingestEnabled: false when ACOUSTID_API_KEY/MUSIC_DIR/INGEST_DIR are unset', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ingestEnabled, false);
});

test('ingestEnabled() returns true only when acoustidApiKey, musicDir, and ingestDir are all set', async () => {
  process.env.ACOUSTID_API_KEY = 'test-acoustid-key';
  process.env.MUSIC_DIR = '/tmp/music';
  process.env.INGEST_DIR = '/tmp/ingest';
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-true');
  assert.equal(ingestEnabled(), true);
  delete process.env.ACOUSTID_API_KEY;
  delete process.env.MUSIC_DIR;
  delete process.env.INGEST_DIR;
});

test('ingestEnabled() returns false when only some ingest vars are set', async () => {
  process.env.ACOUSTID_API_KEY = 'test-acoustid-key';
  // MUSIC_DIR / INGEST_DIR left unset
  const { ingestEnabled } = await import('../../src/config.js?variant=ingest-enabled-partial');
  assert.equal(ingestEnabled(), false);
  delete process.env.ACOUSTID_API_KEY;
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/routes/config.test.js`
Expected: FAIL — `ingestEnabled` is not exported from `config.js`, and the `/api/config` response has no `ingestEnabled` field.

- [ ] **Step 3: Implement the config changes**

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
```

Replace the full contents of `server/src/routes/config.js`:

```js
import { Router } from 'express';
import { config, ingestEnabled } from '../config.js';

export const configRouter = Router();

configRouter.get('/', (req, res) => {
  res.json({ metubeUrl: config.metubeUrl, ingestEnabled: ingestEnabled() });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test test/routes/config.test.js`
Expected: PASS (5 tests: 2 pre-existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/config.js server/src/routes/config.js server/test/routes/config.test.js
git commit -m "Add ingest feature config gating (ACOUSTID_API_KEY, MUSIC_DIR, INGEST_DIR)"
```

---

### Task 2: Docker + docs for the ingest feature

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** None — infra/docs only.

- [ ] **Step 1: Update the Dockerfile runtime stage**

In `Dockerfile`, change line 19 from:
```dockerfile
RUN apk add --no-cache python3 py3-pip && pip install --break-system-packages --no-cache-dir yt-dlp
```
to:
```dockerfile
RUN apk add --no-cache python3 py3-pip chromaprint && pip install --break-system-packages --no-cache-dir yt-dlp
```
(Alpine's `chromaprint` package provides the `fpcalc` binary, musl-native — no glibc-compatibility concern like yt-dlp's standalone binary had.)

- [ ] **Step 2: Add volumes to docker-compose.yml**

Replace the full contents of `docker-compose.yml`:

```yaml
services:
  spinmatch:
    build: .
    ports:
      - '3000:3000'
    env_file:
      - .env
    volumes:
      - ${INGEST_HOST_DIR:-./ingest}:/data/ingest
      - ${MUSIC_HOST_DIR:-./music}:/data/music
```

(`INGEST_HOST_DIR`/`MUSIC_HOST_DIR` are Compose-only variables for the *host* side of the bind mount, read from `.env` by Docker Compose itself — they are never read by the Node app. The app reads `INGEST_DIR`/`MUSIC_DIR`, which should be set to the fixed *container-side* paths `/data/ingest`/`/data/music` shown below, so the two concerns — "where on my host" vs. "where the app looks" — don't collide under one env var name.)

- [ ] **Step 3: Update .env.example**

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

# Optional: local library ingest feature. All three of ACOUSTID_API_KEY,
# INGEST_DIR, and MUSIC_DIR must be set to enable it — see README for setup.
ACOUSTID_API_KEY=
# Paths the app itself reads (container-side paths if using docker-compose;
# for non-Docker/local use, point these at whatever real paths you want).
INGEST_DIR=/data/ingest
MUSIC_DIR=/data/music
# Optional: override the fpcalc (Chromaprint) binary path.
FPCALC_PATH=fpcalc
# Docker Compose only: host-side folders bind-mounted to INGEST_DIR/MUSIC_DIR
# above. Not read by the app itself.
INGEST_HOST_DIR=./ingest
MUSIC_HOST_DIR=./music
```

- [ ] **Step 4: Add a "Local library ingest" section to README.md**

After the existing "Optional: sending videos to MeTube" section (before "## Running locally"), insert:

```markdown
### Optional: local library ingest

If you set `ACOUSTID_API_KEY`, `INGEST_DIR`, and `MUSIC_DIR` (see `.env.example`), an "Ingest"
page appears letting you drop new, unorganized audio (loose files or whole album folders) into
`INGEST_DIR` and have Spinmatch identify each track by acoustic fingerprint (via
[Chromaprint](https://acoustid.org/chromaprint)/[AcoustID](https://acoustid.org/)), confirm it
against the MusicBrainz-recorded duration, fill in whichever tags are missing (never overwriting
ones you already have), embed cover art, and move the confirmed file into an organized
`{Artist}/{Album}/{Track} - {Title}` structure under `MUSIC_DIR`.

Get a free AcoustID API key at [acoustid.org/new-application](https://acoustid.org/new-application).
`fpcalc` (Chromaprint's command-line tool) must be installed and on `PATH` — the Docker image
installs it automatically; for local/non-Docker use, install it via your package manager (e.g.
`apt install chromaprint` / `brew install chromaprint`) or set `FPCALC_PATH` if it's elsewhere.

Anything that can't be confidently identified is left untouched in `INGEST_DIR` and listed on the
Ingest page as "needs review" — nothing is ever deleted, and unmatched items are never moved
anywhere without your review.
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example README.md
git commit -m "Add Docker/Compose plumbing and docs for the local library ingest feature"
```

---

## Phase 1: Identify + tag in place (nothing moves yet)

### Task 3: Generate test audio fixtures

**Files:**
- Create: `server/test/fixtures/silence.mp3`
- Create: `server/test/fixtures/silence.flac`
- Create: `server/test/fixtures/silence.m4a`
- Create: `server/test/fixtures/silence.ogg`
- Create: `server/test/fixtures/tagged.mp3`

**Interfaces:** Produces: five small (~6 second, low-bitrate) real audio fixture files consumed by Task 4 (`fpcalc.test.js`) and Task 7 (`tags.test.js`).

- [ ] **Step 1: Generate the fixtures with ffmpeg**

Both `ffmpeg` and `fpcalc` are already installed in this environment (confirmed: `ffmpeg version n8.1.2` with `libmp3lame`/`flac`/`aac`/`libvorbis` encoders; `fpcalc version 1.6.0`). **Use a 6-second duration, not shorter** — Chromaprint's `fpcalc` needs more than ~2 seconds of audio to produce a fingerprint at all; a 2-second clip was tried during implementation and reliably produced `ERROR: Empty fingerprint`, while 6 seconds fingerprints successfully (confirmed: `fpcalc` on a 6s fixture printed `DURATION=6` and a non-empty `FINGERPRINT=...`). Run from the repo root:

```bash
mkdir -p server/test/fixtures
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=6" -codec:a libmp3lame -b:a 32k server/test/fixtures/silence.mp3
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=6" -codec:a flac server/test/fixtures/silence.flac
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=6" -codec:a aac -b:a 32k server/test/fixtures/silence.m4a
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=6" -codec:a libvorbis -qscale:a 2 server/test/fixtures/silence.ogg
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=6" -codec:a libmp3lame -b:a 32k \
  -metadata title="Existing Title" -metadata artist="Existing Artist" server/test/fixtures/tagged.mp3
```

- [ ] **Step 2: Verify the fixtures are valid and tiny**

Run: `ls -la server/test/fixtures/ && fpcalc server/test/fixtures/silence.mp3`
Expected: all five files exist and are small (~13-26KB for the lossy formats; `silence.flac` is larger, ~80KB, since lossless compression on a synthetic sine tone doesn't shrink much — still tiny enough to commit), and `fpcalc` prints a `DURATION=6` and a non-empty `FINGERPRINT=...` for `silence.mp3` without error (confirms it's a valid, decodable audio file that Chromaprint can actually fingerprint).

- [ ] **Step 3: Commit**

```bash
git add server/test/fixtures/
git commit -m "Add small real audio fixtures for fpcalc/tags service tests"
```

---

### Task 4: `services/fpcalc.js` — Chromaprint fingerprinting

**Files:**
- Create: `server/src/services/fpcalc.js`
- Create: `server/test/fpcalc.test.js`

**Interfaces:**
- Produces: `fingerprint(filePath: string): Promise<{durationSeconds: number, fingerprint: string}>` — consumed by Task 9's `ingest.js` orchestrator.
- Consumes: `config.fpcalcPath` (Task 1), `UpstreamUnavailableError` from `lib/httpErrors.js`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/fpcalc.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/fpcalc.test.js`
Expected: FAIL — `Cannot find module '../src/services/fpcalc.js'`

- [ ] **Step 3: Implement `services/fpcalc.js`**

Create `server/src/services/fpcalc.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/fpcalc.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/fpcalc.js server/test/fpcalc.test.js
git commit -m "Add fpcalc (Chromaprint) fingerprinting service"
```

---

### Task 5: `services/acoustid.js` — AcoustID web API client

**Files:**
- Create: `server/src/services/acoustid.js`
- Create: `server/test/acoustid.test.js`

**Interfaces:**
- Produces: `lookup({fingerprint: string, durationSeconds: number}): Promise<{recordingMbid: string, score: number}[]>` (best score first, deduplicated by `recordingMbid`) — consumed by Task 9's `ingest.js`.
- Consumes: `config.acoustidApiKey` (Task 1), `RateLimiter`/`TTLCache` (existing `lib/`), `UpstreamUnavailableError`/`RateLimitedError` (existing `lib/httpErrors.js`).

**Confirmed API contract** (verified against AcoustID's own docs at https://acoustid.org/webservice): `POST https://api.acoustid.org/v2/lookup`, form-encoded body with `client`, `duration` (integer seconds), `fingerprint`, `format=json`, `meta=recordings+releasegroups`. Rate limit: 3 requests/sec per key. Example response:
```json
{
  "status": "ok",
  "results": [{
    "id": "9ff43b6a-4f16-427c-93c2-92307ca505e0",
    "score": 1.0,
    "recordings": [{ "id": "cd2e7c47-16f5-46c6-a37c-a1eb7bf599ff", "title": "...", "duration": 639, "artists": [...] }]
  }]
}
```
Note: each top-level `results[]` entry's `score` applies to *all* recordings nested under it — flatten to one `{recordingMbid, score}` pair per nested recording.

- [ ] **Step 1: Write the failing tests**

Create `server/test/acoustid.test.js`:

```js
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

  const candidates = await lookup({ fingerprint: 'AQAB...', durationSeconds: 200 });
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

  await assert.rejects(lookup({ fingerprint: 'AQAB...', durationSeconds: 200 }), RateLimitedError);
});

test('a network error throws UpstreamUnavailableError', async () => {
  const pool = mockAcoustId();
  pool.intercept({ path: '/v2/lookup', method: 'POST' }).replyWithError(new Error('boom'));

  await assert.rejects(lookup({ fingerprint: 'AQAB...', durationSeconds: 200 }), UpstreamUnavailableError);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/acoustid.test.js`
Expected: FAIL — `Cannot find module '../src/services/acoustid.js'`

- [ ] **Step 3: Implement `services/acoustid.js`**

Create `server/src/services/acoustid.js`:

```js
import { config } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { TTLCache } from '../lib/cache.js';
import { UpstreamUnavailableError, RateLimitedError } from '../lib/httpErrors.js';

const BASE_URL = 'https://api.acoustid.org/v2/lookup';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — a fingerprint→recording mapping is stable

// AcoustID's documented limit is 3 requests/sec per API key.
const rateLimiter = new RateLimiter(334);
const cache = new TTLCache();

export async function lookup({ fingerprint, durationSeconds }) {
  const cacheKey = `${Math.round(durationSeconds)}:${fingerprint}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const json = await rateLimiter.schedule(async () => {
    const body = new URLSearchParams({
      client: config.acoustidApiKey,
      format: 'json',
      duration: String(Math.round(durationSeconds)),
      fingerprint,
      meta: 'recordings+releasegroups',
    });

    let response;
    try {
      response = await fetch(BASE_URL, { method: 'POST', body });
    } catch (err) {
      throw new UpstreamUnavailableError(`Could not reach AcoustID: ${err.message}`);
    }

    if (response.status === 429) {
      throw new RateLimitedError('AcoustID is rate-limiting requests — try again shortly.');
    }
    if (!response.ok) {
      throw new UpstreamUnavailableError(`AcoustID returned ${response.status}`);
    }

    const parsed = await response.json();
    if (parsed.status !== 'ok') {
      throw new UpstreamUnavailableError(`AcoustID lookup failed: ${parsed.error?.message || 'unknown error'}`);
    }
    return parsed;
  });

  const candidates = (json.results || []).flatMap((result) =>
    (result.recordings || []).map((recording) => ({ recordingMbid: recording.id, score: result.score }))
  );

  cache.set(cacheKey, candidates, CACHE_TTL_MS);
  return candidates;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/acoustid.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/acoustid.js server/test/acoustid.test.js
git commit -m "Add AcoustID web API client service"
```

---

### Task 6: `services/musicbrainz.js` extension — `getRecording`

**Files:**
- Modify: `server/src/services/musicbrainz.js`
- Modify: `server/test/musicbrainz.test.js`

**Interfaces:**
- Produces: `getRecording(recordingMbid: string): Promise<{mbid, title, lengthMs, artist, releaseGroups: [{mbid, title}], date}>` — consumed by Task 9's `ingest.js` to source canonical tag values for a confirmed AcoustID candidate.
- Consumes: the existing `mbFetch` helper (already provides caching/rate-limiting/error-mapping) — no new HTTP plumbing needed.

- [ ] **Step 1: Write the failing test**

Add to `server/test/musicbrainz.test.js` (following the existing test style in that file — check the top of the file for its `mockMusicBrainz()`/`pool.intercept` helper pattern and reuse it):

```js
test('getRecording flattens a MusicBrainz recording response', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/recording/rec-mbid-1?inc=artists%2Breleases%2Brelease-groups&fmt=json' }).reply(200, {
    id: 'rec-mbid-1',
    title: 'Getting Recording Test',
    length: 202000,
    'first-release-date': '2001-05-01',
    'artist-credit': [{ name: 'Recording Test Artist' }],
    releases: [
      {
        'release-group': { id: 'rg-mbid-1', title: 'Recording Test Album' },
      },
    ],
  });

  const recording = await getRecording('rec-mbid-1');
  assert.deepEqual(recording, {
    mbid: 'rec-mbid-1',
    title: 'Getting Recording Test',
    lengthMs: 202000,
    artist: 'Recording Test Artist',
    releaseGroups: [{ mbid: 'rg-mbid-1', title: 'Recording Test Album' }],
    date: '2001-05-01',
  });
});
```

Add `getRecording` to the destructured import at the top of the test file alongside the other imported functions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/musicbrainz.test.js`
Expected: FAIL — `getRecording` is not exported from `musicbrainz.js`.

- [ ] **Step 3: Implement `getRecording`**

Add to `server/src/services/musicbrainz.js` (after the existing `getReleaseWithTracks` function):

```js
export async function getRecording(recordingMbid) {
  const res = await mbFetch(`/recording/${recordingMbid}`, { inc: 'artists+releases+release-groups' });

  const releaseGroups = (res.releases || [])
    .map((r) => r['release-group'])
    .filter(Boolean)
    .map((rg) => ({ mbid: rg.id, title: rg.title }));

  return {
    mbid: res.id,
    title: res.title,
    lengthMs: res.length || null,
    artist: (res['artist-credit'] || []).map((c) => c.name).join(''),
    releaseGroups,
    date: res['first-release-date'] || null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test test/musicbrainz.test.js`
Expected: PASS (all pre-existing tests + 1 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/musicbrainz.js server/test/musicbrainz.test.js
git commit -m "Add getRecording to the MusicBrainz service for ingest track identification"
```

---

### Task 7: `services/tags.js` — read/write audio tags

**Files:**
- Modify: `server/package.json` (add `node-taglib-sharp` dependency)
- Create: `server/src/services/tags.js`
- Create: `server/test/tags.test.js`

**Interfaces:**
- Produces: `readTags(filePath): Promise<{artist, title, album, trackNumber, year, genre, hasCoverArt}>`, `writeMissingTags(filePath, desired, {coverImage}?): Promise<{filledFields: string[]}>` — consumed by Task 9's `ingest.js`. `desired` has the same shape as `readTags`'s return value (minus `hasCoverArt`); `coverImage` is `{bytes: Buffer, mimeType: string} | undefined`.
- Uses `node-taglib-sharp`'s `File.createFromPath`, `tag.title`, `tag.performers` (array), `tag.album`, `tag.track`, `tag.year`, `tag.genres` (array), `tag.pictures` (array), `file.save()`, `file.dispose()` — confirmed via the library's README and confirmed supported formats (MP3, FLAC, MP4/M4A, AAC, OGG, and more).

- [ ] **Step 1: Add the dependency**

Modify `server/package.json` — add to `dependencies` (alongside `express`):
```json
"node-taglib-sharp": "^6.0.3"
```

Run: `npm install --prefix server`
Expected: `node-taglib-sharp` installed under `server/node_modules`, `server/package-lock.json`/root `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

Create `server/test/tags.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { readTags, writeMissingTags } = await import('../src/services/tags.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function withCopiedFixture(name, fn) {
  const src = path.join(FIXTURES_DIR, name);
  const tmp = path.join(await fs.mkdtemp(path.join(FIXTURES_DIR, '.tmp-')), name);
  await fs.copyFile(src, tmp);
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true });
  }
}

test('readTags reads existing title/artist from a tagged fixture', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const tags = await readTags(file);
    assert.equal(tags.title, 'Existing Title');
    assert.equal(tags.artist, 'Existing Artist');
    assert.equal(tags.hasCoverArt, false);
  });
});

test('readTags reports empty fields on an untagged fixture', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const tags = await readTags(file);
    assert.equal(tags.title, null);
    assert.equal(tags.artist, null);
    assert.equal(tags.album, null);
  });
});

test('writeMissingTags fills blank fields on an untagged fixture', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const { filledFields } = await writeMissingTags(file, {
      artist: 'New Artist',
      title: 'New Title',
      album: 'New Album',
      trackNumber: 3,
      year: 2020,
      genre: null,
    });
    assert.deepEqual(new Set(filledFields), new Set(['artist', 'title', 'album', 'trackNumber', 'year']));

    const after = await readTags(file);
    assert.equal(after.artist, 'New Artist');
    assert.equal(after.title, 'New Title');
    assert.equal(after.album, 'New Album');
    assert.equal(after.trackNumber, 3);
    assert.equal(after.year, 2020);
  });
});

test('writeMissingTags never overwrites a field that already has a value', async () => {
  await withCopiedFixture('tagged.mp3', async (file) => {
    const { filledFields } = await writeMissingTags(file, {
      artist: 'Should Not Overwrite',
      title: 'Should Not Overwrite',
      album: 'Should Fill This In',
    });
    assert.ok(!filledFields.includes('artist'));
    assert.ok(!filledFields.includes('title'));
    assert.ok(filledFields.includes('album'));

    const after = await readTags(file);
    assert.equal(after.artist, 'Existing Artist');
    assert.equal(after.title, 'Existing Title');
    assert.equal(after.album, 'Should Fill This In');
  });
});

test('writeMissingTags embeds cover art only when none is present', async () => {
  await withCopiedFixture('silence.mp3', async (file) => {
    const coverImage = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
    const { filledFields } = await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B' }, { coverImage });
    assert.ok(filledFields.includes('coverArt'));

    const after = await readTags(file);
    assert.equal(after.hasCoverArt, true);
  });
});

test('readTags/writeMissingTags work across MP3, FLAC, M4A, and OGG', async () => {
  for (const name of ['silence.mp3', 'silence.flac', 'silence.m4a', 'silence.ogg']) {
    await withCopiedFixture(name, async (file) => {
      const before = await readTags(file);
      assert.equal(before.title, null, `${name} should start untagged`);
      await writeMissingTags(file, { artist: 'A', title: 'T', album: 'B' });
      const after = await readTags(file);
      assert.equal(after.title, 'T', `${name} should have title written`);
    });
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && node --test test/tags.test.js`
Expected: FAIL — `Cannot find module '../src/services/tags.js'`

- [ ] **Step 4: Implement `services/tags.js`**

Create `server/src/services/tags.js`. Note for the implementer: `node-taglib-sharp`'s exact `Picture`/`IPicture` construction API (whether it's a plain `{data, mimeType}`-shaped object or requires a `Picture.fromFullData(...)` factory with a `PictureType`) should be confirmed by reading the installed package's TypeScript type definitions (`server/node_modules/node-taglib-sharp/dist/**/*.d.ts`, specifically the `Picture`/`IPicture` types) once installed in Step 1 — the README confirms a plain `{data: Buffer, mimeType: string}` object assigned into `tag.pictures = [...]` works for simple embedding, which is what's used below; adjust if the installed version's types require a specific factory method instead.

```js
import { File } from 'node-taglib-sharp';

const FIELD_TO_TAG_PROP = {
  artist: 'performers',
  title: 'title',
  album: 'album',
  trackNumber: 'track',
  year: 'year',
  genre: 'genres',
};

function readField(tag, field) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist') return tag.performers && tag.performers.length ? tag.performers.join(', ') : null;
  if (field === 'genre') return tag.genres && tag.genres.length ? tag.genres.join(', ') : null;
  const value = tag[prop];
  return value === undefined || value === null || value === '' || value === 0 ? null : value;
}

function writeField(tag, field, value) {
  const prop = FIELD_TO_TAG_PROP[field];
  if (field === 'artist') {
    tag.performers = [value];
  } else if (field === 'genre') {
    tag.genres = [value];
  } else {
    tag[prop] = value;
  }
}

export async function readTags(filePath) {
  const file = File.createFromPath(filePath);
  try {
    const { tag } = file;
    return {
      artist: readField(tag, 'artist'),
      title: readField(tag, 'title'),
      album: readField(tag, 'album'),
      trackNumber: readField(tag, 'trackNumber'),
      year: readField(tag, 'year'),
      genre: readField(tag, 'genre'),
      hasCoverArt: Boolean(tag.pictures && tag.pictures.length > 0),
    };
  } finally {
    file.dispose();
  }
}

export async function writeMissingTags(filePath, desired, { coverImage } = {}) {
  const file = File.createFromPath(filePath);
  const filledFields = [];
  try {
    const { tag } = file;
    for (const field of Object.keys(FIELD_TO_TAG_PROP)) {
      const desiredValue = desired[field];
      if (desiredValue == null) continue;
      const current = readField(tag, field);
      if (current == null) {
        writeField(tag, field, desiredValue);
        filledFields.push(field);
      }
    }

    const hasCoverArt = Boolean(tag.pictures && tag.pictures.length > 0);
    if (!hasCoverArt && coverImage) {
      tag.pictures = [{ data: coverImage.bytes, mimeType: coverImage.mimeType }];
      filledFields.push('coverArt');
    }

    file.save();
  } finally {
    file.dispose();
  }
  return { filledFields };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --test test/tags.test.js`
Expected: PASS (10 tests — the last one loops over 4 formats)

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json package-lock.json server/src/services/tags.js server/test/tags.test.js
git commit -m "Add audio tag read/write service using node-taglib-sharp"
```

---

### Task 8: `services/coverArt.js` extension — download cover image bytes

**Files:**
- Modify: `server/src/services/coverArt.js`
- Modify: `server/test/coverArt.test.js`

**Interfaces:**
- Produces: `getFrontCoverImage(releaseGroupMbid: string): Promise<{bytes: Buffer, mimeType: string} | null>` — consumed by Task 9's `ingest.js`. The existing `getFrontCoverUrl` is untouched (still used by the UI for linking).

- [ ] **Step 1: Write the failing test**

Add to `server/test/coverArt.test.js` (matching the existing file's test style/mocking pattern — check the top of the file for how it mocks `coverartarchive.org`):

```js
test('getFrontCoverImage downloads the resolved cover art bytes', async () => {
  const pool = mockCoverArtArchive(); // reuse whatever helper the existing tests use
  pool
    .intercept({ path: '/release-group/rg-cover-image-test/front', method: 'HEAD' })
    .reply(307, '', { headers: { location: 'https://coverartarchive.org/release-group/rg-cover-image-test/front-1200.jpg' } });
  pool
    .intercept({ path: '/release-group/rg-cover-image-test/front-1200.jpg', method: 'GET' })
    .reply(200, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });

  const image = await getFrontCoverImage('rg-cover-image-test');
  assert.deepEqual(image.bytes, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(image.mimeType, 'image/jpeg');
});

test('getFrontCoverImage returns null when no cover art exists', async () => {
  const pool = mockCoverArtArchive();
  pool.intercept({ path: '/release-group/rg-no-cover/front', method: 'HEAD' }).reply(404);

  const image = await getFrontCoverImage('rg-no-cover');
  assert.equal(image, null);
});
```

(Adjust the exact `mockCoverArtArchive`/pool-setup calls to match whatever helper name and mocking conventions the existing `coverArt.test.js` already uses — read the file first.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test test/coverArt.test.js`
Expected: FAIL — `getFrontCoverImage` is not exported.

- [ ] **Step 3: Implement `getFrontCoverImage`**

Add to `server/src/services/coverArt.js` (keep the existing `getFrontCoverUrl` function untouched; add a second, separate `TTLCache` instance for image bytes so the two caches don't collide on key or value shape):

```js
const imageCache = new TTLCache();

export async function getFrontCoverImage(releaseGroupMbid) {
  const cached = imageCache.get(releaseGroupMbid);
  if (cached !== undefined) return cached;

  const url = await getFrontCoverUrl(releaseGroupMbid);
  let result = null;
  if (url) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get('content-type') || 'image/jpeg';
        result = { bytes, mimeType };
      }
    } catch {
      result = null;
    }
  }

  imageCache.set(releaseGroupMbid, result, CACHE_TTL_MS);
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test test/coverArt.test.js`
Expected: PASS (all pre-existing tests + 2 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/coverArt.js server/test/coverArt.test.js
git commit -m "Add cover art image download for embedding into tagged files"
```

---

### Task 9: `services/ingest.js` — orchestration (loose files only in Phase 1)

**Files:**
- Create: `server/src/services/ingest.js`
- Create: `server/test/ingest.test.js`

**Interfaces:**
- Consumes: `fingerprint` (Task 4), `lookup` (Task 5), `getRecording` (Task 6), `readTags`/`writeMissingTags` (Task 7), `getFrontCoverImage` (Task 8), `rankCandidates`/`pickResult` from the existing `durationMatch.js`, `config.ingest.ingestDir`.
- Produces: `scanIngestDir(): Promise<{items: [{id, type: 'file'|'album', name, path, trackCount?}]}>`, `processIngest(): Promise<{matched: [...], needsReview: [...], error?}>` — consumed by Task 10's routes.
- **Phase 1 scope note:** `scanIngestDir` lists both files and album-folder directories, but `processIngest` in this task only processes loose files — any directory entry is pushed straight to `needsReview` with `reason: 'album folders are not yet supported'`. Phase 2 (Task 13) replaces that stub with the real album pipeline.

- [ ] **Step 1: Write the failing tests**

Create `server/test/ingest.test.js`. This orchestrator test mocks its four leaf-service dependencies directly (they're plain function imports from sibling modules — use `t.mock.method` on the imported module objects, the same technique already used for `child_process` elsewhere) and uses a real `fs.mkdtemp` temp directory standing in for `INGEST_DIR`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const fpcalcModule = await import('../src/services/fpcalc.js');
const acoustidModule = await import('../src/services/acoustid.js');
const musicbrainzModule = await import('../src/services/musicbrainz.js');
const tagsModule = await import('../src/services/tags.js');
const coverArtModule = await import('../src/services/coverArt.js');
const configModule = await import('../src/config.js');

const { scanIngestDir, processIngest } = await import('../src/services/ingest.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withIngestDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
  const original = configModule.config.ingest.ingestDir;
  configModule.config.ingest.ingestDir = dir;
  try {
    await fn(dir);
  } finally {
    configModule.config.ingest.ingestDir = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('scanIngestDir distinguishes loose files from album folders and ignores junk', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'loose-track.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, '.DS_Store'), 'junk');
    await fs.mkdir(path.join(dir, 'Some Album'));
    await fs.writeFile(path.join(dir, 'Some Album', 'track1.flac'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'Some Album', 'track2.flac'), 'fake-audio');

    const { items } = await scanIngestDir();
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(items.length, 2, 'junk file should be ignored');
    assert.equal(byName['loose-track.mp3'].type, 'file');
    assert.equal(byName['Some Album'].type, 'album');
    assert.equal(byName['Some Album'].trackCount, 2);
  });
});

test('processIngest moves nothing yet for a confirmed loose file, tags it, and reports it matched', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'track.mp3'), 'fake-audio');

    t.mock.method(fpcalcModule, 'fingerprint', async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }));
    t.mock.method(acoustidModule, 'lookup', async () => [{ recordingMbid: 'rec-1', score: 0.9 }]);
    t.mock.method(musicbrainzModule, 'getRecording', async () => ({
      mbid: 'rec-1', title: 'Track Title', lengthMs: 200000, artist: 'Track Artist',
      releaseGroups: [{ mbid: 'rg-1', title: 'Track Album' }], date: '2020-01-01',
    }));
    t.mock.method(tagsModule, 'readTags', async () => ({
      artist: null, title: null, album: null, trackNumber: null, year: null, genre: null, hasCoverArt: false,
    }));
    t.mock.method(coverArtModule, 'getFrontCoverImage', async () => null);
    t.mock.method(tagsModule, 'writeMissingTags', async () => ({ filledFields: ['artist', 'title', 'album'] }));

    const result = await processIngest();
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].recordingMbid, 'rec-1');
    assert.equal(result.needsReview.length, 0);
  });
});

test('processIngest reports needsReview when AcoustID finds no candidates', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'unknown.mp3'), 'fake-audio');
    t.mock.method(fpcalcModule, 'fingerprint', async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }));
    t.mock.method(acoustidModule, 'lookup', async () => []);

    const result = await processIngest();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /no.*candidate/i);
  });
});

test('processIngest reports needsReview when duration/score confirmation fails', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'mismatch.mp3'), 'fake-audio');
    t.mock.method(fpcalcModule, 'fingerprint', async () => ({ durationSeconds: 100, fingerprint: 'AQAB...' }));
    t.mock.method(acoustidModule, 'lookup', async () => [{ recordingMbid: 'rec-2', score: 0.9 }]);
    t.mock.method(musicbrainzModule, 'getRecording', async () => ({
      mbid: 'rec-2', title: 'Wrong Length Track', lengthMs: 400000, artist: 'A', releaseGroups: [], date: null,
    }));

    const result = await processIngest();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
  });
});

test('a directory entry is reported as needsReview with an "album folders not yet supported" reason', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'An Album'));
    await fs.writeFile(path.join(dir, 'An Album', 'track1.mp3'), 'fake-audio');

    const result = await processIngest();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 1);
    assert.match(result.needsReview[0].reason, /album folders/i);
  });
});

test('a RateLimitedError mid-run stops processing and returns partial results plus error', async (t) => {
  await withIngestDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'a-track.mp3'), 'fake-audio');
    await fs.writeFile(path.join(dir, 'b-track.mp3'), 'fake-audio');
    const { RateLimitedError } = await import('../src/lib/httpErrors.js');

    t.mock.method(fpcalcModule, 'fingerprint', async () => ({ durationSeconds: 200, fingerprint: 'AQAB...' }));
    t.mock.method(acoustidModule, 'lookup', async () => {
      throw new RateLimitedError('rate limited');
    });

    const result = await processIngest();
    assert.equal(result.matched.length, 0);
    assert.equal(result.needsReview.length, 0);
    assert.equal(result.error.code, 'RATE_LIMITED');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/ingest.test.js`
Expected: FAIL — `Cannot find module '../src/services/ingest.js'`

- [ ] **Step 3: Implement `services/ingest.js`**

Create `server/src/services/ingest.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fingerprint } from './fpcalc.js';
import { lookup } from './acoustid.js';
import { getRecording } from './musicbrainz.js';
import { readTags, writeMissingTags } from './tags.js';
import { getFrontCoverImage } from './coverArt.js';
import { rankCandidates, pickResult } from './durationMatch.js';
import { RateLimitedError } from '../lib/httpErrors.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg']);
const SCORE_THRESHOLD = 0.5;

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function scanIngestDir() {
  const dir = config.ingest.ingestDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const children = await fs.readdir(path.join(dir, entry.name));
      const trackCount = children.filter(isAudioFile).length;
      if (trackCount > 0) {
        items.push({ id: entry.name, type: 'album', name: entry.name, path: path.join(dir, entry.name), trackCount });
      }
    } else if (isAudioFile(entry.name)) {
      items.push({ id: entry.name, type: 'file', name: entry.name, path: path.join(dir, entry.name) });
    }
  }

  return { items };
}

async function identifyFile(filePath) {
  const { durationSeconds, fingerprint: fp } = await fingerprint(filePath);
  const candidates = await lookup({ fingerprint: fp, durationSeconds });

  if (candidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidates found' };
  }

  const topCandidates = candidates.filter((c) => c.score >= SCORE_THRESHOLD).slice(0, 5);
  if (topCandidates.length === 0) {
    return { confirmed: null, reason: 'no AcoustID candidate met the confidence threshold' };
  }

  const recordings = await Promise.all(topCandidates.map((c) => getRecording(c.recordingMbid)));
  // Each candidate recording carries its OWN MusicBrainz-canonical length; the
  // fixed point we're matching against is the file's own measured duration —
  // same orientation as verifyTrack.js's YouTube-candidate ranking.
  const rankable = recordings
    .map((rec, i) => ({ id: rec.mbid, title: rec.title, durationMs: rec.lengthMs, recording: rec, score: topCandidates[i].score }))
    .filter((c) => c.durationMs != null);

  const ranked = rankCandidates(rankable, durationSeconds * 1000);
  const best = ranked.find((c) => c.withinTolerance);

  if (!best) {
    return { confirmed: null, reason: 'no candidate recording matched within the duration tolerance' };
  }

  return { confirmed: best.recording, reason: null };
}

async function processLooseFile(item) {
  const { confirmed, reason } = await identifyFile(item.path);
  if (!confirmed) {
    return { needsReview: { path: item.path, name: item.name, reason } };
  }

  const current = await readTags(item.path);
  const coverImage = confirmed.releaseGroups[0]
    ? await getFrontCoverImage(confirmed.releaseGroups[0].mbid)
    : null;

  const desired = {
    artist: confirmed.artist,
    title: confirmed.title,
    album: confirmed.releaseGroups[0]?.title ?? null,
    year: confirmed.date ? Number(confirmed.date.slice(0, 4)) : null,
  };
  const { filledFields } = await writeMissingTags(item.path, desired, { coverImage });

  return {
    matched: {
      path: item.path,
      name: item.name,
      recordingMbid: confirmed.mbid,
      title: confirmed.title,
      artist: confirmed.artist,
      filledFields,
      current,
    },
  };
}

export async function processIngest() {
  const { items } = await scanIngestDir();
  const matched = [];
  const needsReview = [];

  for (const item of items) {
    try {
      if (item.type === 'album') {
        needsReview.push({ path: item.path, name: item.name, reason: 'album folders are not yet supported (coming in a later phase)' });
        continue;
      }

      const result = await processLooseFile(item);
      if (result.matched) matched.push(result.matched);
      else needsReview.push(result.needsReview);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return { matched, needsReview, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
  }

  return { matched, needsReview };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/ingest.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ingest.js server/test/ingest.test.js
git commit -m "Add ingest orchestrator (loose-file identify + tag pipeline, Phase 1 scope)"
```

---

### Task 10: `routes/ingest.js` — `/api/ingest` endpoints

**Files:**
- Create: `server/src/routes/ingest.js`
- Create: `server/test/routes/ingest.test.js`
- Modify: `server/src/app.js`

**Interfaces:**
- Consumes: `scanIngestDir`/`processIngest` (Task 9), `ingestEnabled` (Task 1).
- Produces: `GET /api/ingest/scan` → `{items}`; `POST /api/ingest/process` → `{matched, needsReview, error?}` — consumed by Task 11's frontend.

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/ingest.test.js` (following the request-through-the-app style used by `server/test/routes/verify.test.js` — spin up `createApp()`, mock leaf dependencies via `t.mock.method`, hit the route with `fetch`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-route-'));

process.env.ACOUSTID_API_KEY = 'test-key';
process.env.MUSIC_DIR = await fs.mkdtemp(path.join(__dirname, '.tmp-music-route-'));
process.env.INGEST_DIR = tmpDir;

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(process.env.MUSIC_DIR, { recursive: true, force: true });
});

test('GET /api/ingest/scan lists items in the configured ingest dir', async () => {
  await fs.writeFile(path.join(tmpDir, 'route-track.mp3'), 'fake-audio');

  const res = await fetch(`${baseUrl}/api/ingest/scan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.items.some((i) => i.name === 'route-track.mp3'));
});
```

Also add a second test file/case for the gated-off (404) behavior when ingest is disabled — since `config.js` is read once at module load, this needs its own isolated test process: create `server/test/routes/ingest-disabled.test.js` that does NOT set `ACOUSTID_API_KEY`/`MUSIC_DIR`/`INGEST_DIR` before importing `app.js`, and asserts `GET /api/ingest/scan` returns 404.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/routes/ingest.test.js test/routes/ingest-disabled.test.js`
Expected: FAIL — no `ingestRouter` exists, `/api/ingest/*` is unmatched (Express default 404 HTML, not our JSON 404).

- [ ] **Step 3: Implement `routes/ingest.js`**

Create `server/src/routes/ingest.js`:

```js
import { Router } from 'express';
import { ingestEnabled } from '../config.js';
import { scanIngestDir, processIngest } from '../services/ingest.js';
import { NotFoundError } from '../lib/httpErrors.js';

export const ingestRouter = Router();

ingestRouter.use((req, res, next) => {
  if (!ingestEnabled()) return next(new NotFoundError('The ingest feature is not configured'));
  next();
});

ingestRouter.get('/scan', async (req, res, next) => {
  try {
    const result = await scanIngestDir();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ingestRouter.post('/process', async (req, res, next) => {
  try {
    const result = await processIngest();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

Modify `server/src/app.js` — add the import alongside the other route imports and mount it alongside the other routers:
```js
import { ingestRouter } from './routes/ingest.js';
// ...
app.use('/api/ingest', ingestRouter);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/routes/ingest.test.js test/routes/ingest-disabled.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ingest.js server/test/routes/ingest.test.js server/test/routes/ingest-disabled.test.js server/src/app.js
git commit -m "Add /api/ingest routes for scanning and processing the ingest folder"
```

---

### Task 11: Frontend — Ingest page

**Files:**
- Create: `client/src/pages/IngestPage.jsx`
- Create: `client/src/components/IngestPanel.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/styles/index.css`

**Interfaces:**
- Consumes: `get('/ingest/scan')`, `post('/ingest/process', {})` (existing `api/client.js`, unchanged), `get('/config')`'s `ingestEnabled` flag.

- [ ] **Step 1: Add the nav link and route, gated on `ingestEnabled`**

Modify `client/src/App.jsx` — add state for the config fetch, a new route, and a conditional nav link:

```jsx
import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import ArtistPage from './pages/ArtistPage.jsx';
import AlbumPage from './pages/AlbumPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import IngestPage from './pages/IngestPage.jsx';
import Logo from './components/Logo.jsx';
import { get } from './api/client.js';

function navLinkClass({ isActive }) {
  return isActive ? 'nav-link nav-link-active' : 'nav-link';
}

export default function App() {
  const [ingestEnabled, setIngestEnabled] = useState(false);

  useEffect(() => {
    get('/config').then((config) => setIngestEnabled(Boolean(config.ingestEnabled))).catch(() => {});
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <a href="/" className="app-brand">
          <Logo />
          <span className="app-title">Spinmatch</span>
        </a>
        <p className="app-subtitle">Track down the right take — matched against MusicBrainz, verified by length</p>
        <nav className="app-nav">
          <NavLink to="/" end className={navLinkClass}>Search</NavLink>
          {ingestEnabled && <NavLink to="/ingest" className={navLinkClass}>Ingest</NavLink>}
          <NavLink to="/history" className={navLinkClass}>History</NavLink>
          <NavLink to="/about" className={navLinkClass}>About</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/artist/:mbid" element={<ArtistPage />} />
          <Route path="/release-group/:mbid" element={<AlbumPage />} />
          <Route path="/ingest" element={<IngestPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Create `IngestPanel.jsx`**

Model directly on `client/src/components/BulkVerifyPanel.jsx`'s state machine and markup conventions:

```jsx
import { useState } from 'react';
import { get, post } from '../api/client.js';
import EqualizerLoader from './EqualizerLoader.jsx';

export default function IngestPanel() {
  const [items, setItems] = useState(null);
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleScan() {
    try {
      const data = await get('/ingest/scan');
      setItems(data.items);
    } catch (err) {
      setError(err);
    }
  }

  async function handleProcess() {
    setState('running');
    setError(null);
    try {
      const data = await post('/ingest/process', {});
      setResult(data);
      setState(data.error ? 'error' : 'done');
      if (data.error) setError(data.error);
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  return (
    <div className="ingest-panel">
      <div className="bulk-verify-actions">
        <button onClick={handleScan}>Scan ingest folder</button>
        {items && items.length > 0 && (
          <button onClick={handleProcess} disabled={state === 'running'}>
            Process {items.length} item{items.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {items && items.length === 0 && <p className="muted">The ingest folder is empty.</p>}

      {state === 'running' && <EqualizerLoader label="Identifying and tagging files…" />}

      {error && (
        <p className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
          {error.message}
        </p>
      )}

      {result && (
        <>
          <h2>Matched &amp; tagged ({result.matched.length})</h2>
          {result.matched.length === 0 ? (
            <p className="muted">Nothing was confidently matched this run.</p>
          ) : (
            <table>
              <thead>
                <tr><th>File</th><th>Title</th><th>Artist</th><th>Fields filled</th></tr>
              </thead>
              <tbody>
                {result.matched.map((m) => (
                  <tr key={m.path}>
                    <td>{m.name}</td>
                    <td>{m.title}</td>
                    <td>{m.artist}</td>
                    <td>{m.filledFields.join(', ') || 'none (already complete)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Needs review ({result.needsReview.length})</h2>
          {result.needsReview.length === 0 ? (
            <p className="muted">Nothing needs review this run.</p>
          ) : (
            <table>
              <thead>
                <tr><th>File</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {result.needsReview.map((r) => (
                  <tr key={r.path}>
                    <td>{r.name}</td>
                    <td className="muted">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `IngestPage.jsx`**

```jsx
import IngestPanel from '../components/IngestPanel.jsx';

export default function IngestPage() {
  return (
    <div className="ingest-page">
      <h1>Ingest</h1>
      <p className="muted">
        Drop new audio (loose files or album folders) into your configured ingest folder, then
        scan and process it here. Confirmed tracks get their missing tags filled in; anything
        that can't be confidently identified is left untouched and listed below for review.
      </p>
      <IngestPanel />
    </div>
  );
}
```

- [ ] **Step 4: Add minimal CSS**

Add to `client/src/styles/index.css` (reusing the existing `.bulk-verify-actions`/`.banner`/table styles already defined for `BulkVerifyPanel`/`HistoryPage` — check the existing rules for those classes before adding anything new; only add an `.ingest-panel` wrapper margin if the existing generic styles don't already cover spacing).

- [ ] **Step 5: Verify the client builds and manually test**

Run: `npm run build -w client`
Expected: clean build, no errors.

Manual check (documented for whoever runs this — no automated frontend suite exists): `npm run dev`, set `ACOUSTID_API_KEY`/`INGEST_DIR`/`MUSIC_DIR` in `.env`, confirm the "Ingest" nav link appears, clicking it shows the scan/process UI, and with the vars unset the nav link is hidden.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/IngestPage.jsx client/src/components/IngestPanel.jsx client/src/App.jsx client/src/styles/index.css
git commit -m "Add Ingest page: scan/process UI for the local library ingest feature"
```

---

## Phase 2: Move confirmed files into the organized library

*(Detailed steps below are specified at the same rigor as Phase 0/1, but per the execution checkpoint at the top of this document, review them against how Phase 1 behaves in real use before dispatching — folder-layout preferences or duplicate-handling specifics may want a quick adjustment once there's real usage to look at.)*

### Task 12: `services/organize.js` — safe filesystem move/rename

**Files:**
- Create: `server/src/services/organize.js`
- Create: `server/test/organize.test.js`

**Interfaces:**
- Produces: `sanitizeSegment(name: string): string`, `targetPathFor(meta: {artist, album, trackNumber?, title}, ext: string): string`, `moveIntoLibrary(srcPath: string, meta, ext: string): Promise<{movedTo: string|null, duplicate: boolean}>` — consumed by Task 13. `movedTo === null && duplicate === true` means the source was left in place (byte-identical file already at the destination); the orchestrator maps that to a `needsReview: duplicate` entry.
- Consumes: `config.ingest.musicDir` (Task 1), `BadRequestError` (existing `lib/httpErrors.js`).

- [ ] **Step 1: Write the failing tests**

Create `server/test/organize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configModule = await import('../src/config.js');
const { sanitizeSegment, targetPathFor, moveIntoLibrary } = await import('../src/services/organize.js');

async function withMusicDir(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-music-'));
  const original = configModule.config.ingest.musicDir;
  configModule.config.ingest.musicDir = dir;
  try {
    await fn(dir);
  } finally {
    configModule.config.ingest.musicDir = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('sanitizeSegment strips unsafe characters and trims', () => {
  assert.equal(sanitizeSegment('AC/DC'), 'ACDC');
  assert.equal(sanitizeSegment('  Weird: Title?  '), 'Weird Title');
  assert.equal(sanitizeSegment(''), 'Unknown');
});

test('sanitizeSegment neutralizes path-traversal attempts', () => {
  assert.equal(sanitizeSegment('..'), 'Unknown');
  assert.equal(sanitizeSegment('.'), 'Unknown');
  const traversal = sanitizeSegment('../../etc/passwd');
  assert.ok(!traversal.includes('/') && !traversal.includes('\\'), `got: ${traversal}`);
});

test('targetPathFor builds Artist/Album/NN - Title.ext with a track number', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor({ artist: 'The Band', album: 'The Album', trackNumber: 3, title: 'The Song' }, '.mp3');
    assert.equal(p, path.join(dir, 'The Band', 'The Album', '03 - The Song.mp3'));
  });
});

test('targetPathFor omits the track-number prefix when absent', async () => {
  await withMusicDir(async (dir) => {
    const p = targetPathFor({ artist: 'The Band', album: 'The Album', title: 'The Song' }, '.mp3');
    assert.equal(p, path.join(dir, 'The Band', 'The Album', 'The Song.mp3'));
  });
});

test('moveIntoLibrary renames the file into the computed destination', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');

    const { movedTo, duplicate } = await moveIntoLibrary(src, { artist: 'A', album: 'B', title: 'C' }, '.mp3');
    assert.equal(duplicate, false);
    assert.ok(fsSync.existsSync(movedTo));
    assert.ok(!fsSync.existsSync(src));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary falls back to copy+unlink on a simulated EXDEV', async (t) => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'audio-bytes');

    const fsPromisesModule = await import('node:fs/promises');
    let renameCalls = 0;
    const realRename = fsPromisesModule.rename;
    t.mock.method(fsPromisesModule, 'rename', async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('cross-device link');
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    });

    const { movedTo } = await moveIntoLibrary(src, { artist: 'A', album: 'B', title: 'C' }, '.mp3');
    assert.ok(fsSync.existsSync(movedTo));
    assert.ok(!fsSync.existsSync(src));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary appends (2), (3)... when the destination exists with different content', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const meta = { artist: 'A', album: 'B', title: 'C' };
    const dest = targetPathFor(meta, '.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'different-existing-content-longer');

    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'new-bytes');
    const { movedTo } = await moveIntoLibrary(src, meta, '.mp3');
    assert.equal(movedTo, dest.replace('.mp3', ' (2).mp3'));
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

test('moveIntoLibrary reports a duplicate and leaves the source in place when content is byte-identical', async () => {
  await withMusicDir(async () => {
    const srcDir = await fs.mkdtemp(path.join(__dirname, '.tmp-ingest-'));
    const meta = { artist: 'A', album: 'B', title: 'C' };
    const dest = targetPathFor(meta, '.mp3');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'identical-content');

    const src = path.join(srcDir, 'source.mp3');
    await fs.writeFile(src, 'identical-content');
    const { movedTo, duplicate } = await moveIntoLibrary(src, meta, '.mp3');
    assert.equal(duplicate, true);
    assert.equal(movedTo, null);
    assert.ok(fsSync.existsSync(src), 'source should be left in place for a duplicate');
    await fs.rm(srcDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test test/organize.test.js`
Expected: FAIL — `Cannot find module '../src/services/organize.js'`

- [ ] **Step 3: Implement `services/organize.js`**

Create `server/src/services/organize.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { BadRequestError } from '../lib/httpErrors.js';

const UNSAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;
const MAX_SEGMENT_LENGTH = 200;

export function sanitizeSegment(name) {
  const cleaned = String(name || '')
    .replace(UNSAFE_CHARS, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, MAX_SEGMENT_LENGTH) || 'Unknown';
}

export function targetPathFor(meta, ext) {
  const artist = sanitizeSegment(meta.artist);
  const album = sanitizeSegment(meta.album);
  const title = sanitizeSegment(meta.title);
  const filename =
    meta.trackNumber != null
      ? `${String(meta.trackNumber).padStart(2, '0')} - ${title}${ext}`
      : `${title}${ext}`;
  return path.join(config.ingest.musicDir, artist, album, filename);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function filesAreIdentical(a, b) {
  const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (statA.size !== statB.size) return false;
  const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return bufA.equals(bufB);
}

function withSuffix(destPath, n) {
  const ext = path.extname(destPath);
  const base = destPath.slice(0, ext.length ? -ext.length : undefined);
  return `${base} (${n})${ext}`;
}

// Returns the final destination path, or null if an identical file already
// exists there (caller leaves the source untouched in that case).
async function resolveCollision(srcPath, destPath) {
  if (!(await fileExists(destPath))) return destPath;
  if (await filesAreIdentical(srcPath, destPath)) return null;

  let n = 2;
  let candidate = withSuffix(destPath, n);
  while (await fileExists(candidate)) {
    n += 1;
    candidate = withSuffix(destPath, n);
  }
  return candidate;
}

// Defense-in-depth: sanitizeSegment already strips path separators and
// neutralizes "."/".." segments, so this should never actually fire through
// the normal API — but it's a cheap, correct guard against any future change
// to sanitization logic letting a MusicBrainz-sourced value escape MUSIC_DIR.
function assertInsideMusicDir(destPath) {
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(config.ingest.musicDir);
  if (!resolvedDest.startsWith(resolvedRoot + path.sep)) {
    throw new BadRequestError(`Refusing to write outside MUSIC_DIR: ${destPath}`);
  }
}

export async function moveIntoLibrary(srcPath, meta, ext) {
  const initialDest = targetPathFor(meta, ext);
  assertInsideMusicDir(initialDest);

  const dest = await resolveCollision(srcPath, initialDest);
  if (dest === null) {
    return { movedTo: null, duplicate: true };
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });

  try {
    await fs.rename(srcPath, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const partial = `${dest}.partial`;
    await fs.copyFile(srcPath, partial);
    await fs.rename(partial, dest);
    await fs.unlink(srcPath);
  }

  return { movedTo: dest, duplicate: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test test/organize.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/organize.js server/test/organize.test.js
git commit -m "Add safe file-organizing service (sanitize, target path, atomic move)"
```

---

### Task 13: Wire `organize.js` into the pipeline + album-folder pipeline

**Files:**
- Modify: `server/src/services/ingest.js`
- Modify: `server/test/ingest.test.js`

**Interfaces:**
- Consumes: `moveIntoLibrary` (Task 12).
- Changes `processLooseFile`'s "confirmed" branch to call `moveIntoLibrary` after `writeMissingTags` succeeds, and adds `movedTo` to the `matched` result shape.
- Replaces the Phase 1 stub (`item.type === 'album' → needsReview`) with the real album pipeline:

**Album pipeline behavior spec (confirmed in the approved design, all-or-nothing per the user's choice):**
1. Fingerprint every audio file in the folder; look up AcoustID candidates for each.
2. Collect the union of candidate recordings' release-groups → resolve each to a release via the existing `resolvePrimaryReleaseForGroup` → pull each release's tracklist via the existing `getReleaseWithTracks`.
3. Score each candidate release by: track-count match (folder's audio-file count vs. release's track count) plus how many of the folder's files (sorted by filename) fall within ±5s of the release's tracks in position order.
4. If the best-scoring release clears a coherence threshold (e.g. every file maps to a distinct track position within tolerance, and track counts match), tag+move every file using that track's position/title/disc-number/the release's album title; **if no release coherently explains the whole folder, push the entire folder to `needsReview` with a reason and move nothing** — never a partial move within one folder.

- [ ] Follow the same TDD step structure once this task is picked up for implementation — extend `ingest.test.js`'s existing test suite (don't replace it) with cases for: a loose file's `matched` result now includes `movedTo`; a coherent album folder gets every track tagged+moved; an incoherent album folder (wrong track count, or one track's duration doesn't fit any position) goes entirely to `needsReview` with nothing moved.

- [ ] **Commit** once green: `git commit -m "Wire safe file-moving into the ingest pipeline; add album-folder disambiguation"`

---

## Phase 3: UI/progress polish

*(Lighter-weight enhancements — pick up after Phase 2 is proven in real use. Each is independently small.)*

### Task 14: History integration + dry-run preview mode

**Files:**
- Modify: `client/src/components/IngestPanel.jsx` (log each matched item via the existing `lib/history.js#addEntry`, `action: 'ingested'`)
- Modify: `client/src/pages/HistoryPage.jsx` (`actionLabel` needs an `'ingested'` case, e.g. `"Ingested"`)
- Modify: `server/src/services/ingest.js` / `routes/ingest.js` (add a `dryRun` option to `processIngest`/`POST /api/ingest/process` that runs identification and tag-diffing but skips the actual `writeMissingTags`/`moveIntoLibrary` calls, returning what *would* happen)
- Modify: `client/src/components/IngestPanel.jsx` (a "Preview" button alongside "Process" using `dryRun: true`)

- [ ] Follow the same TDD step structure once this task is picked up.

### Task 15 (optional): Real server-side progress via SSE

Replace the blocking `POST /api/ingest/process` with a streaming variant (Server-Sent Events) so the UI shows true per-item progress instead of `BulkVerifyPanel`-style simulated progress. Only worth doing if ingest batches turn out large enough in practice that the blocking UX feels bad — evaluate after Phase 1/2 usage before committing to this.

---

## Final verification (Phase 0/1 scope)

- [ ] `cd server && node --test` (bare — see the environment quirk in Global Constraints) — all new service/route tests green alongside the existing 49.
- [ ] `docker build -t spinmatch-ingest-check .` succeeds; `docker run --rm spinmatch-ingest-check fpcalc -version` confirms Chromaprint is present in the image.
- [ ] `npm run build -w client` clean.
- [ ] Manual end-to-end check (requires a real `ACOUSTID_API_KEY`): set `INGEST_DIR` to a real local folder, drop in a real small audio file with no tags, run `npm run dev`, visit `/ingest`, scan, process — confirm the file gets tagged in place (Phase 1: nothing moves yet), and that an unidentifiable file (e.g. random noise) is reported under "needs review" and left untouched.
