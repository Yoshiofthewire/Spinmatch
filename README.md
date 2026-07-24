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

### Optional: local library ingest

If you set `ACOUSTID_API_KEY`, `INGEST_DIR`, and `MUSIC_DIR` (see `.env.example`), an "Ingest"
page appears letting you drop new audio (loose files or whole album folders) into `INGEST_DIR`
and have Spinmatch identify each track by acoustic fingerprint (via
[Chromaprint](https://acoustid.org/chromaprint)/[AcoustID](https://acoustid.org/)), confirm it
against the MusicBrainz-recorded duration, fill in whichever tags are missing (never overwriting
ones you already have), embed cover art, and move the confirmed file into an organized
`{Artist}/{Album}/{Track} - {Title}` structure under `MUSIC_DIR`. Tracks with no album land under
`{Artist}/Singles/`, and multi-disc releases get disc-prefixed track names. Album folders are
handled as a unit: a folder is only tagged and moved when a single release cleanly accounts for
every file in it — otherwise the whole folder is left untouched for review. If a file identical
to one already in your library turns up, it's left in place rather than duplicated.

Get a free AcoustID API key at [acoustid.org/new-application](https://acoustid.org/new-application).
`fpcalc` (Chromaprint's command-line tool) must be installed and on `PATH` — the Docker image
installs it automatically; for local/non-Docker use, install it via your package manager (e.g.
`apt install chromaprint` / `brew install chromaprint`) or set `FPCALC_PATH` if it's elsewhere.

Anything that can't be confidently identified is left untouched in `INGEST_DIR` and listed on the
Ingest page as "needs review" — nothing is ever deleted, and unmatched items are never moved
anywhere without your review. For a loose file that AcoustID couldn't confidently match, you can
resolve it manually right from the needs-review list: pick one of AcoustID's lower-confidence
near-misses, or search MusicBrainz by artist/title yourself, and Spinmatch tags and moves the file
the same way an auto-confirmed match would be.

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
