# Spinmatch

Search MusicBrainz for an artist, album, or song, browse album art and tracklists, and get a
YouTube link for a track — verified by cross-checking the video's duration against the
MusicBrainz-recorded track length.

This app **only finds and verifies YouTube links**. It does not download or rip audio.

## Prerequisites

- Node.js 20+ (Node 24 recommended — this project uses native `fetch` and `--env-file`)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) installed and on `PATH`

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

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```
PORT=3000
YTDLP_PATH=yt-dlp
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Spinmatch
MB_APP_VERSION=0.1.0
METUBE_URL=
```

`MB_CONTACT_EMAIL` is required by [MusicBrainz's API usage policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) —
every request must identify itself with a real contact email in its `User-Agent` string, or
MusicBrainz may block the app's IP.

### Optional: sending videos to MeTube

If you run a [MeTube](https://github.com/alexta69/metube) instance, set `METUBE_URL` to its base
URL (e.g. `https://metube.example.com`) and a "Send to MeTube" button appears next to every
YouTube result. Leave it blank to hide the button entirely.

The request is sent directly from your browser to `{METUBE_URL}/add`, not proxied through this
app's server — the same way MeTube's own bookmarklet works — so your browser's session/cookies
for that origin are used, and your MeTube instance must allow cross-origin requests from wherever
this app is hosted.

## Running locally

```
npm install
npm run dev
```

This runs the Express backend (with `--env-file=../.env`, picking up `.env` from the repo root)
and the Vite dev server concurrently. Open http://localhost:5173.

## Running in production

```
npm install
npm run build
npm start
```

`npm start` runs the Express server directly (reading `.env` via `--env-file`), serving the
built client from `client/dist` on `$PORT` (default 3000).

## Running with Docker

```
cp .env.example .env   # fill in your values
docker compose up --build
```

The app will be available at http://localhost:3000. The container builds the client and runs
the server in a single image — no separate frontend container needed.

## Tests

```
npm test
```

Runs the backend test suite (Node's built-in test runner — `undici`'s `MockAgent` mocks
MusicBrainz, and `node:test`'s built-in method mocking stubs out `yt-dlp` calls — no live
network calls). There are no automated frontend tests; verify UI changes by running
`npm run dev` and testing in a browser.
