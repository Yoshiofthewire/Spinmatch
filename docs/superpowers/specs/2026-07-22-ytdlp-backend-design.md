# Replace YouTube Data API with yt-dlp

## Motivation

Spinmatch currently verifies YouTube matches via the YouTube Data API v3 (`search.list` +
`videos.list`), which requires an API key and is capped at ~100 track lookups/day on the free
quota tier. This design replaces that with `yt-dlp`, which scrapes YouTube directly and has no
formal daily quota, removing the API key requirement entirely. Scope is unchanged: Spinmatch
still only finds and verifies YouTube links — it does not download or rip audio (MeTube remains
the download path).

## Architecture

`server/src/services/youtube.js` is replaced by `server/src/services/ytdlp.js`, which shells out
to the `yt-dlp` binary via `node:child_process`'s `execFile` — **always with an args array, never
a shell string** — since the search query is built from user/MusicBrainz-derived text
(artist/title/album) and passing it through a shell would be a command-injection risk.

A single yt-dlp invocation replaces both of today's YouTube API calls:

```
yt-dlp --flat-playlist --skip-download --no-warnings --quiet -j "ytsearch5:<query>"
```

YouTube's search results already include `duration`, so search and duration lookup collapse into
one subprocess call per track lookup (down from two HTTP calls). Output is newline-delimited JSON,
one object per candidate; each line is parsed into `{id, title, durationMs}` (`durationMs = duration
* 1000`, entries with a missing/null duration — e.g. live streams — are filtered out, matching
today's behavior of dropping candidates without a duration).

`server/src/services/verifyTrack.js`'s `fetchRankedCandidates` simplifies from a two-step
search-then-fetch-durations flow into a single call to the new combined search function.
`rankCandidates`/`pickResult` in `durationMatch.js` are unchanged.

Calls are wrapped in a `RateLimiter(1000)` (reusing `server/src/lib/rateLimiter.js`, the same
pattern already used to serialize MusicBrainz calls at ≤1/sec) to cap yt-dlp invocations to
roughly 1/sec app-wide, reducing the chance of YouTube flagging the server's IP during bulk album
verification.

## Error handling

| Condition | Error |
|---|---|
| yt-dlp binary not found (`ENOENT` on spawn) | `UpstreamUnavailableError` — "yt-dlp is not installed or not on PATH" |
| Non-zero exit, stderr matches bot-check/429 patterns (e.g. "Sign in to confirm you're not a bot", "HTTP Error 429") | New `RateLimitedError` (code `RATE_LIMITED`, status 429) |
| Non-zero exit, other / malformed JSON output | `UpstreamUnavailableError`, message includes a truncated stderr snippet |
| Call exceeds timeout (~15s, via `execFile`'s `timeout` option) | `UpstreamUnavailableError('yt-dlp timed out')` |

`QuotaExceededError`, `QUOTA_UNITS_PER_TRACK`, and `estimatedQuotaUnits` are removed entirely — no
formal quota exists with yt-dlp. In `routes/verify.js`'s bulk `/verify/album/:mbid` endpoint,
catching `RateLimitedError` stops processing further tracks and returns partial results already
gathered (same early-exit shape as today's quota-exceeded handling, minus the quota-units field).

## Config & deployment

- `server/src/config.js`: remove the required `YOUTUBE_API_KEY`. Add optional `ytdlpPath`
  (env `YTDLP_PATH`, default `'yt-dlp'`) so the binary name/path can be overridden without code
  changes.
- `.env.example` / README: remove the "Setting up a YouTube Data API v3 key" section and its env
  var; add a short "Installing yt-dlp" section covering local dev setup (e.g. `pipx install
  yt-dlp`, or a distro package).
- `Dockerfile`: the Alpine (`node:24-alpine`) runtime stage has no Python today. Add `python3` +
  `py3-pip`, then `pip install yt-dlp` into a venv. The official standalone `yt-dlp` binary is a
  PyInstaller build tied to glibc and is not reliable on Alpine's musl libc, so installing via the
  Python already present in the image is the safer route.

## Frontend changes

- `client/src/components/BulkVerifyPanel.jsx`: replace the "will use approximately N YouTube
  quota units (out of your 10,000/day limit)" copy with wording reflecting serialized,
  rate-limit-aware checking (e.g. "Tracks are checked one at a time to avoid rate limits, so this
  may take a while."). Drop the `estimatedQuotaUnits` prop.
- `client/src/pages/AlbumPage.jsx`: stop passing `estimatedQuotaUnits`.
- `server/src/routes/releases.js`: stop returning `estimatedQuotaUnits` in the response.
- `client/src/components/VerifyButton.jsx` and `BulkVerifyPanel.jsx`: banner styling keyed off
  `error.code === 'QUOTA_EXCEEDED'` becomes `error.code === 'RATE_LIMITED'`. Rename the
  `banner-quota` CSS class (in `client/src/styles/index.css`) to `banner-rate-limited` for
  clarity.
- `client/src/pages/AboutPage.jsx`: replace the "Verification runs against the YouTube Data API,
  which has a daily quota…" blurb with wording about yt-dlp-based lookups and possible temporary
  rate limiting under heavy bulk use.

## Testing

- Rename `server/test/youtube.test.js` → `server/test/ytdlp.test.js`. Replace `undici`'s
  `MockAgent` (HTTP mocking, no longer applicable) with stubbing of `child_process.execFile` via
  Node's built-in test runner (`node:test`'s `t.mock.method`) — no new test dependency needed.
- Cover: NDJSON parsing into `{id, title, durationMs}`; empty results; candidates with a
  missing/null duration filtered out; `RateLimitedError` thrown on bot-check/429 stderr patterns;
  `UpstreamUnavailableError` on `ENOENT`, timeout, and other non-zero exits.
- Update `server/test/routes/releases.test.js` and `server/test/routes/verify.test.js` to drop
  `estimatedQuotaUnits` assertions and adjust for the `RATE_LIMITED` error code replacing
  `QUOTA_EXCEEDED`.

## Out of scope

- No change to the app's scope: still find/verify only, no downloading/ripping via yt-dlp.
- No change to MusicBrainz integration, cover art, MeTube send-to, history, or navigation.
