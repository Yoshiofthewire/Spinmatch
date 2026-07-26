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
extra configuration is required — auth is always on.

**Changing your password:** use the **Account** page. It asks for your current password, and
changing it signs out every other browser and device — the tab you're in stays signed in.

**Forgotten password:** stop the app and delete the `app_auth` row (or the whole DB file) to
return to the first-run setup screen. Session cookies name the admin they were issued to, and
creating a new admin rotates the token-signing secret, so a cookie from before the reset stops
working immediately.

Sessions are stateless cookies valid for 30 days. **Log out** clears the cookie and revokes the
token server-side, so a copy of it taken elsewhere stops working too — which, this being a
single-account app, means logging out signs you out on every device. Changing your password does
the same.

### Running behind a reverse proxy

Set `TRUST_PROXY=1` (or a subnet — anything Express's
[`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting accepts). Without
it, `X-Forwarded-*` headers are ignored, which is correct for a directly-exposed process but
wrong behind a proxy in two specific ways:

- the login rate limit keys on the client IP, and every request appears to come from the proxy,
  so all clients share one bucket;
- the session cookie is marked `Secure` based on the request scheme, and a proxy that terminates
  TLS makes the request to Spinmatch itself plain HTTP.

Only set it when a proxy you control is actually in front of the app: it makes the app trust a
header any client can send.

Accepted values are a hop count (`1`), `true`/`false`, a subnet (`10.0.0.0/8`), or a named preset
(`loopback`). An unparseable value stops the server at startup with an explicit message rather
than starting up with the setting silently inert.

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

The Library page has eight tabs:

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
  number, and cover art. By default it only fills tags that are *empty*, never overwrites a value
  you already have, and it never moves or renames the file. A missing *duration* is the exception:
  that means the audio stream itself couldn't be decoded, so it's a broken file rather than a
  tagging problem, and no fix is offered. When a file's tags are too empty to search on, the picker
  falls back to what the file's *path* says — `Artist/Album/05 - Title.flac` is metadata too — and a
  **Whole album** button escalates to the album-wide repair described below.

  With an `ACOUSTID_API_KEY` set, the panel also offers **Identify by audio**: it fingerprints the
  file with Chromaprint and asks AcoustID what the recording actually is, which is the only way to
  identify a file whose tags and path are both useless. Because a fingerprint doesn't depend on the
  metadata being repaired, it's also the one source allowed to *replace* tags rather than only fill
  blanks — that's what fixes a file tagged as the wrong song entirely. It's a separate tick box,
  unchecked by default, and offered only for fingerprint matches. Embedded cover art is never
  replaced in either mode. The button is opt-in per track rather than automatic because
  fingerprinting spawns a subprocess over the audio and spends a rate-limited AcoustID call.
- **Duplicates** — the same artist, album and title indexed at more than one path, with every
  copy's track number, length, format, size and full path side by side, and a play button for each
  so they can be compared. The album is part of the match, so a song that appears on two different
  releases — an album track that's also on a compilation — is not a duplicate and is not listed.
  What's left is genuine redundancy: a FLAC and a 128k MP3 of the same album track, or a folder
  copied twice. **Spinmatch never deletes files;** this view tells you what you have and leaves the
  decision to you.
- **Discover** — the one view that looks outward: artists and records connected to the ones you
  already own the most of, plus playlist reconstruction. See below.

Alongside the library-wide **Rescan library** button, artist and album pages have a **Rescan this
artist/album** action that re-reads only those folders — useful right after fixing tags or dropping
a file in, instead of waiting for a full pass. It walks the folders rather than just the files it
already knows about, so newly added tracks are picked up too.

### Repairing a whole album's tags

Album pages carry a **Fix this album's tags** panel — the bulk counterpart to the per-track action
in the Health tab. Repairing files one at a time through MusicBrainz costs one to three rate-limited
lookups each, so a few hundred files is a twenty-minute job; resolving the album *once* costs two
lookups for the entire tracklist. Two sources, because they fail in opposite directions:

- **From file paths** — reads artist, album, track number and title from where each file sits. No
  network at all, and it works on files carrying no tags whatsoever, which is exactly the Health
  tab's population.
- **From MusicBrainz** — resolves the album once and lines your files up against its official
  tracklist, by track number when they have one and by listing order when they don't (and only when
  the two lists are the same length, so a partial album is never shifted onto the wrong titles).

Both show a full preview first: every file, every proposed value, with what would be written
highlighted against what's already on the file. Nothing is written until you tick rows and press
Apply, and the same rules as the single-track fix hold — only empty fields are filled, and nothing
is moved or renamed.

Three MusicBrainz-backed checks sit on top of the offline reports. All run only when you press the
button, so a slow or unreachable MusicBrainz never blocks the page:

- **Missing albums** (artist view) — diffs the artist's studio discography against what you own and
  shows the missing records with cover art and year. Each one links straight into the existing
  release-group page, where you can verify the tracks against YouTube and hand them to MeTube.
  Resolving an artist name to MusicBrainz is a fuzzy search, so when the match is ambiguous
  Spinmatch asks you to pick rather than guessing; the choice is remembered.

  **Joined credits** get a second chance. Roughly a quarter of a real collection is rows like
  `Justice & Thundercat`, `Grabbitz feat. REZZ` or `Nine Inch Nails / Stephen Morris and Gillian
  Gilbert` — none of which resolve to a MusicBrainz artist, which used to strand them even when the
  artist they lead with is one you own hundreds of tracks by. When the whole name doesn't resolve,
  Spinmatch retries with the primary artist, and the panel tells you which artist it matched through.

  Two rules keep that from inventing matches, and both are load-bearing:

  - It only ever runs **after** the whole name has failed, so a real band name that resolves on its
    own — `She & Him`, `Simon & Garfunkel` — is never split.
  - The primary artist is accepted **only if you already own them under that exact name**. This
    matters more than it sounds: MusicBrainz has real artists named `Florence`, `Earth` and `Wind`,
    so splitting `Florence + The Machine` or `Earth, Wind & Fire` and trusting the name would link
    the wrong act with total confidence. Requiring the segment to be something already on disk makes
    the fallback self-validating.

  Nothing is rewritten on disk and no rows are merged — this only affects how a name is resolved
  upstream, so a wrong match is undone with **Wrong artist?** like any other.
- **Check tracklist** (album view) — compares one album against its official tracklist. This catches
  what the track-number check can't: an album numbered 1..10 with no gaps that actually has 12
  tracks. Each missing track gets the usual "Find on YouTube" button, and **Find all missing on
  YouTube** does the whole gap in one pass — the same streaming, one-at-a-time matching the
  release-group page uses, but scoped to the tracks you don't already own, so nothing you have is
  looked up. Results come with the usual copy-link and Send to MeTube actions.
- **Find every missing track on YouTube** (artist view) — the whole-discography sweep: every track
  of every album that artist has and you don't, in one streaming run. This is minutes of work at
  one lookup per second, so results are written to a small on-disk cache as they land — stopping it
  and coming back later resumes rather than starting over. Albums whose tracklist can't be read are
  reported and stepped past; a rate limit stops the run.

### Discovery

Every other library view is about finding holes in records you already know about. The **Discover**
tab is the inverse — music you don't have, reached from music you do:

- **Find similar artists** — seeds from the ten artists you own the most of and follows two
  different signals. **Sounds like** comes from ListenBrainz, where listening histories overlap with
  yours. **Connected to** comes from MusicBrainz's relationship graph — shared members, side
  projects, collaborations. Each suggestion says which of your artists led to it and by which
  signal, ranked by how many of them agree; anything already in your library is filtered out.
- **Suggest albums** — the same, taken one step further: the studio discographies of the top few
  discovered artists, minus anything you already own. Each cover links into the release-group page,
  where the existing verify-and-hand-to-MeTube flow takes over.
- **Rebuild a playlist** — paste one track per line, as `Artist - Title` or just a title, and see
  what you already have against what you'd need to find. Entirely offline: matched against the
  index with no upstream call, so it works when MusicBrainz doesn't.

The two signals are kept apart rather than blended, because they make different claims. MusicBrainz
records facts, not taste: a "member of band" edge is a documented connection, and it finds side
projects that listening data ranks poorly or not at all. ListenBrainz is the reverse — it knows
nothing about who played on what, but it knows Portishead listeners also play Massive Attack. An
artist reached by both is the strongest lead there is here and is marked as such.

Both come from MetaBrainz, both are keyed on the same artist ids, and neither needs an API key —
your listening habits are never sent anywhere, because Spinmatch only ever asks "who is similar to
this artist id".

ListenBrainz's similar-artist endpoint lives on an experimental subdomain, so its absence is a
supported state rather than a failure: discovery falls back to the relationship graph alone and says
so on the page. Set `LISTENBRAINZ_ENABLED=0` to turn it off deliberately. Both lookups are cached
for a month, and an outage is never cached — otherwise a momentary blip would look like "this artist
has no neighbours" for weeks.

A collection concentrated in one scene will still legitimately turn up little. That's an honest
answer, not a broken one.

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
