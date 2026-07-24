# Spinmatch

Search MusicBrainz for an artist, album, or song, browse album art and tracklists, and get a
YouTube link for a track — verified by cross-checking the video's duration against the
MusicBrainz-recorded track length.

This app **only finds and verifies YouTube links**. It does not download or rip audio.

## First-run login

The whole app is gated behind a single admin account. The **first time** you open Spinmatch
it shows a one-time setup screen — pick a username and password (minimum 8 characters) and it
logs you in. After that, every visit shows a login screen, and all `/api` routes except
`/api/health` and `/api/config` require a valid session.

The credential is stored (scrypt-hashed) in the same SQLite database as the library index
(`LIBRARY_DB`, default `/data/db/library.db`), so keep that path on a persistent volume. No
extra configuration is required — auth is always on. To reset a forgotten password, stop the
app and delete the `app_auth` row (or the DB file) to return to the first-run setup screen.

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

### Optional: local library ingest

If you set `INGEST_DIR` and `MUSIC_DIR` (see `.env.example`), an "Ingest" page appears letting you
drop new audio (loose files or whole album folders) into `INGEST_DIR` and have Spinmatch tag and
move it into an organized `{Artist}/{Album}/{Track} - {Title}` structure under `MUSIC_DIR`. Tracks
with no album land under `{Artist}/Singles/`, and multi-disc releases get disc-prefixed track
names. If a file identical to one already in your library turns up, it's left in place rather than
duplicated.

Also setting `ACOUSTID_API_KEY` turns on *automatic* identification: each track is fingerprinted
(via [Chromaprint](https://acoustid.org/chromaprint)/[AcoustID](https://acoustid.org/)) and
confirmed against the MusicBrainz-recorded duration before being tagged and moved. Album folders
are handled as a unit: a folder is only auto-tagged and moved when a single release cleanly
accounts for every file in it — otherwise the whole folder is left untouched for review. Get a
free AcoustID API key at [acoustid.org/new-application](https://acoustid.org/new-application).
`fpcalc` (Chromaprint's command-line tool) must be installed and on `PATH` — the Docker image
installs it automatically; for local/non-Docker use, install it via your package manager (e.g.
`apt install chromaprint` / `brew install chromaprint`) or set `FPCALC_PATH` if it's elsewhere.

Without `ACOUSTID_API_KEY`, loose files just land straight in "needs review" for manual resolution
(see below); album folders can't be auto-matched at all without it.

Anything that can't be confidently identified is left untouched in `INGEST_DIR` and listed on the
Ingest page as "needs review" — nothing is ever deleted, and unmatched items are never moved
anywhere without your review. For a loose file, you can resolve it manually right from the
needs-review list: pick one of AcoustID's lower-confidence near-misses (if `ACOUSTID_API_KEY` is
set), or search MusicBrainz by artist/title yourself, and Spinmatch tags and moves the file the
same way an auto-confirmed match would be. Non-audio files are left untouched.

### Library / Collection Manager

Whenever `MUSIC_DIR` is set (see above), Spinmatch also indexes it into a local SQLite database
and turns on a "Your Library" page: browse the collection by artist and album, see aggregate
stats (track/album/artist counts), and rescan on demand. The index is built at startup and kept
current afterward by a background scan plus a filesystem watcher, so changes made outside the app
(e.g. copying files in directly) are picked up without a restart. The scan runs in a worker
thread — the per-file tag reads and database writes happen off the main event loop, so the app
stays responsive even while indexing a large (100k+ track) collection.

Album pages also get gap detection: given a MusicBrainz release group, Spinmatch compares its
official tracklist against what's indexed from `MUSIC_DIR` and reports which tracks you already
have versus which are missing, with a YouTube link for each gap. Matching is by artist and track
title, normalized to fold away case, punctuation, featured-artist tails, and parenthetical
suffixes like "(Remastered 2011)" or "[Live]" — so a remaster you own isn't reported as missing.
Larger tag drift (e.g. "The Beatles" vs "Beatles") can still cause a track you own to show up as
missing, so results depend on your files' tag hygiene.

This feature needs no separate opt-in flag — it's enabled automatically as soon as `MUSIC_DIR` is
configured, independent of the ingest feature above. The index itself lives at `LIBRARY_DB`
(default `/data/db/library.db`). As with `MUSIC_DIR`, this path **must be on a mounted volume** in
Docker/Unraid — otherwise the index is rebuilt from scratch (harmless, just slower) every time the
container is recreated. In Docker Compose, set `DB_HOST_DIR` to the host folder to bind-mount for
it (default `./db`).

Node's built-in `node:sqlite` module is still experimental, so on some Node versions you may see a
one-time `ExperimentalWarning: SQLite is an experimental feature` on stderr at startup (it did not
fire on Node 24.16) — this is expected and harmless.

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

## Running on Unraid

A published image is available at `ghcr.io/yoshiofthewire/spinmatch:latest`, rebuilt automatically
on every push to `main` and daily whenever a new `yt-dlp` release comes out.

In the Unraid **Docker** tab, click **Add Container**, switch the template dropdown to
**Enter URL**, and paste:

```
https://raw.githubusercontent.com/Yoshiofthewire/Spinmatch/main/unraid-template.xml
```

This fills in the repository, port, paths, and environment variables from
[`unraid-template.xml`](unraid-template.xml). At minimum, set **MB Contact Email**. The mapped
paths (**Ingest Directory**, **Music Directory**, and **Library DB Directory**) correspond to
`INGEST_DIR`, `MUSIC_DIR`, and the directory holding `LIBRARY_DB` in `.env.example` — point
**Music Directory** at your existing music share to enable the local library ingest feature
described above, and set **AcoustID API Key** as well if you want automatic track identification
(otherwise ingest still works, just with manual matching only). **Library DB Directory** should
point at a persistent appdata path so the
collection index survives container rebuilds; it's used automatically once **Music Directory** is
set, no separate toggle needed.

## Tests

```
npm test
```

Runs the backend test suite (Node's built-in test runner — `undici`'s `MockAgent` mocks
MusicBrainz, and `node:test`'s built-in method mocking stubs out `yt-dlp` calls — no live
network calls). There are no automated frontend tests; verify UI changes by running
`npm run dev` and testing in a browser.
