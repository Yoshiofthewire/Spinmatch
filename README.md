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

The Docker image presets both variables to `/data/ingest` and `/data/music`, the paths
`docker-compose.yml` and the Unraid template already mount, so under Docker the volume mapping is
the whole configuration — there is nothing extra to set. Point a mount at whichever host folders
you want and the page appears. (Set a variable to an empty string to deliberately turn the feature
off.) Outside Docker the variables are unset by default, so the feature stays opt-in.

Also setting `ACOUSTID_API_KEY` turns on *automatic* identification: each track is fingerprinted
(via [Chromaprint](https://acoustid.org/chromaprint)/[AcoustID](https://acoustid.org/)) and
confirmed against the MusicBrainz-recorded duration before being tagged and moved. Album folders
are handled as a unit: a folder is only auto-tagged and moved when a single release cleanly
accounts for every file in it — otherwise the whole folder is left untouched for review. Get a
free AcoustID API key at [acoustid.org/new-application](https://acoustid.org/new-application).
`fpcalc` (Chromaprint's command-line tool) must be installed and on `PATH` — the Docker image
installs it automatically; for local/non-Docker use, install it via your package manager (e.g.
`apt install chromaprint` / `brew install chromaprint`) or set `FPCALC_PATH` if it's elsewhere.

Without `ACOUSTID_API_KEY` (AcoustID's key registration has been down for a while, so you may not
be able to get one), ingest falls back to matching on the tags the files already carry: it searches
MusicBrainz for the file's artist/title and only accepts a hit whose title agrees and whose
MusicBrainz length is within five seconds of the file's own — the same "confirm before touching
anything" bar the fingerprint path applies, just without the fingerprint. Album folders work the
same way, matched by their album/artist tags against a release group whose whole tracklist lines up
by duration (track-number tags, when present, decide the running order rather than filenames).
Files with no useful tags, or whose tags don't confirm, land in "needs review" for manual
resolution (see below) — nothing is guessed at. No fingerprinting means `fpcalc` isn't needed
either on this path.

Anything that can't be confidently identified is left untouched in `INGEST_DIR` and listed on the
Ingest page as "needs review" — nothing is ever deleted, and unmatched items are never moved
anywhere without your review. For a loose file, you can resolve it manually right from the
needs-review list: pick one of the offered candidates — AcoustID's lower-confidence near-misses if
`ACOUSTID_API_KEY` is set, otherwise whatever MusicBrainz returns for the file's own tags — or
search MusicBrainz by artist/title yourself, and Spinmatch tags and moves the file the same way an
auto-confirmed match would be. Non-audio files are left untouched.

### Library / Collection Manager

Whenever `MUSIC_DIR` is set (see above), Spinmatch also indexes it into a local SQLite database
and turns on a "Your Library" page. The index records artist, album, title, duration, track and
disc number, year, genre, format, file size, whether the file carries embedded cover art, and when
the track was first seen. It is built at startup and kept current afterward by a background scan
plus a filesystem watcher, so changes made outside the app (e.g. copying files in directly) are
picked up without a restart. The scan runs in a worker thread — the per-file tag reads and database
writes happen off the main event loop, so the app stays responsive even while indexing a large
(100k+ track) collection.

The Library page has seven tabs:

- **Overview** — track/album/artist counts, total playtime, total size on disk, and a format
  breakdown, plus shortcuts into the reports below.
- **Artists** — searchable and sortable by name, album count, track count, or playtime. Drill into
  an artist for their albums.
- **Albums** — cover-art grid sortable by artist, title, year, track count, or recently added, with
  an "incomplete only" filter. Album art is read from the files themselves on demand, so nothing is
  extracted to disk and only the covers on screen are ever read. Art embedded in the audio is used
  first; failing that, a `cover`/`folder`/`front` image sitting in the album folder is served
  instead, so libraries that keep art alongside the music still get covers.
- **Tracks** — the whole collection in one sortable, searchable table. Paged on the server, so it
  stays responsive at any library size.
- **Incomplete** — albums that look unfinished, computed entirely from the index with no network
  calls: numbered gaps (you have 1, 2, 4 of 4 — so 3 is missing), single files filed as whole
  albums, and albums with no track numbers at all, where completeness can't be judged.
- **Health** — tag hygiene: tracks missing an artist, album, title, track number, duration, or
  cover art. Worth checking, because the matching below is done on artist and title — an empty
  artist tag is invisible to it. Each count drills into the tracks behind it, and most offer a
  **Fix tags** action: pick the right MusicBrainz recording (from the file's own tags, or by
  searching) and Spinmatch fills in what's missing — artist, title, album, year, track and disc
  number, and cover art. It only ever fills tags that are *empty*, never overwrites a value you
  already have, and never moves or renames the file. A missing *duration* is the exception: that
  means the audio stream itself couldn't be decoded, so it's a broken file rather than a tagging
  problem, and no fix is offered.
- **Duplicates** — the same artist and title indexed at more than one path, with every copy's
  album, track number, length, format, size and full path side by side, and a play button for each
  so they can be compared. Often legitimate — an album track that also appears on a compilation.
  **Spinmatch never deletes files;** this view tells you what you have and leaves the decision to
  you.

Alongside the library-wide **Rescan library** button, artist and album pages have a **Rescan this
artist/album** action that re-reads only those folders — useful right after fixing tags or dropping
a file in, instead of waiting for a full pass. It walks the folders rather than just the files it
already knows about, so newly added tracks are picked up too.

Two MusicBrainz-backed checks sit on top of the offline reports. Both run only when you press the
button, so a slow or unreachable MusicBrainz never blocks the page:

- **Missing albums** (artist view) — diffs the artist's studio discography against what you own and
  shows the missing records with cover art and year. Each one links straight into the existing
  release-group page, where you can verify the tracks against YouTube and hand them to MeTube.
  Resolving an artist name to MusicBrainz is a fuzzy search, so when the match is ambiguous
  Spinmatch asks you to pick rather than guessing; the choice is remembered.
- **Check tracklist** (album view) — compares one album against its official tracklist. This catches
  what the track-number check can't: an album numbered 1..10 with no gaps that actually has 12
  tracks. Each missing track gets the usual "Find on YouTube" button, and **Find all missing on
  YouTube** does the whole gap in one pass — the same streaming, one-at-a-time matching the
  release-group page uses, but scoped to the tracks you don't already own, so nothing you have is
  looked up. Results come with the usual copy-link and Send to MeTube actions.

Search results and artist pages are also library-aware: an album or song you already have is
badged **In your library**. That check is pure local SQL with no upstream call, and matches the same
way gap detection does, so "Kid A (Deluxe Edition)" on disk still counts as owning "Kid A". An
artist page therefore doubles as a coverage view — their whole studio discography with the ones you
own marked.

Album pages reached from search still have the original gap detection. Matching is by artist and
track title, normalized to fold away case, punctuation, featured-artist tails, and parenthetical
suffixes like "(Remastered 2011)" or "[Live]" — so a remaster you own isn't reported as missing.
Larger tag drift (e.g. "The Beatles" vs "Beatles") can still cause a track you own to show up as
missing, so results depend on your files' tag hygiene — see the Health tab.

There's also a small **preview player**: press play on any track to stream it from disk, with
seeking, and next/previous across the list you started from. It's deliberately a preview — a way to
confirm a file is what its tags claim — not a music server. There's no queue management,
transcoding, or playback outside the Library page; point Navidrome or Jellyfin at `MUSIC_DIR` if you
want that.

**Upgrading:** the first scan after updating re-reads tags for every file once, to fill in the
columns added above. On a large collection that takes a few minutes; it happens in the background
and only once. The date a track was first added to your library is preserved. A later upgrade also
drops an unused `verified_tracks` table left over from an early schema; no data you can see is
affected.

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
paths (**Ingest Directory**, **Music Directory**, and **Library DB Directory**) are the host folders
bind-mounted at the container paths `/data/ingest`, `/data/music`, and `/data/db`. A path mapping on
its own doesn't tell the app anything, so the template also ships the matching `INGEST_DIR`,
`MUSIC_DIR`, and `LIBRARY_DB` variables (under **Show more settings**) pointing at those container
paths — leave them as-is unless you change a container path. Point
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
