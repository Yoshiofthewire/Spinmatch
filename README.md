# Spinmatch

Spinmatch searches MusicBrainz for an artist, an album, or a song. It shows album art and
tracklists, and it finds a YouTube link for a track. Spinmatch compares the duration of the video
against the track length that MusicBrainz records, and reports whether the two agree.

Spinmatch **only finds and verifies YouTube links**. It does not download or copy audio.

## First-run login

One admin account protects the whole app. The **first time** you open Spinmatch, it shows a setup
screen. Enter a username and a password of 8 characters or more. Spinmatch then logs you in. After
setup, every visit shows a login screen. All `/api` routes need a valid session, except
`/api/health` and `/api/config`.

Spinmatch stores the password as a scrypt hash. It uses the same SQLite database as the library
index (`LIBRARY_DB`, default `/data/db/library.db`). Keep that path on a persistent volume. No
extra configuration is necessary, because the login is always active.

**To change your password,** use the **Account** page. The page asks for your current password. A
password change logs out every other browser and device. The tab that you use stays logged in.

**If you forget your password,** stop the app and delete the `app_auth` row. You can delete the
whole database file instead. Spinmatch then shows the first-run setup screen again. Each session
cookie names the admin that it belongs to. A new admin also gets a new token-signing secret. A
cookie from before the reset therefore stops working immediately.

A session is a stateless cookie with a life of 30 days. **Log out** deletes the cookie and revokes
the token on the server. A copy of that cookie on another machine therefore stops working too.
Spinmatch has one account only, so a logout logs you out on every device. A password change does
the same.

### Running behind a reverse proxy

Set `TRUST_PROXY=1`. You can also give a subnet, or any other value that the Express
[`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting accepts. Without this
setting, Spinmatch ignores the `X-Forwarded-*` headers. That is correct for a directly exposed
process, but wrong behind a proxy for two reasons:

- The login rate limit uses the client IP address as its key. Behind a proxy, every request appears
  to come from the proxy, so all clients share one limit.
- Spinmatch marks the session cookie `Secure` from the scheme of the request. A proxy that
  terminates TLS sends a plain HTTP request to Spinmatch.

Set this value only when you control a proxy in front of the app. The setting makes the app trust a
header that any client can send.

Permitted values are a hop count (`1`), `true`, `false`, a subnet (`10.0.0.0/8`), or a named preset
(`loopback`). If the value is not valid, the server stops at startup and prints a message. It does
not start with the setting silently inactive.

## Prerequisites

- Node.js 20 or later. Node 24 is preferred, because this project uses the native `fetch` and
  `--env-file`.
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), installed and on `PATH`.

## Installing yt-dlp

Spinmatch runs `yt-dlp` as a subprocess to find and verify YouTube matches. No API key and no daily
quota are necessary. Install `yt-dlp` with one of these commands:

```
pipx install yt-dlp   # recommended: isolated, easy to upgrade with `pipx upgrade yt-dlp`
pip install --user yt-dlp
brew install yt-dlp   # macOS
```

To confirm that `yt-dlp` is on `PATH`, run `yt-dlp --version`. If you install it in a directory
that is not on `PATH`, set `YTDLP_PATH` in `.env` to the full path of the program.

`yt-dlp` reads the YouTube site directly instead of an official API. A large number of lookups can
therefore cause a temporary rate limit from YouTube. The **Find all on YouTube** album action is the
most likely cause. Spinmatch makes one lookup at a time to reduce this risk. If a rate limit occurs,
wait and then try again. Run `yt-dlp -U` to get the newest anti-bot-detection fixes.

## Configuration

Copy `.env.example` to `.env` and enter your values:

```
PORT=3000
YTDLP_PATH=yt-dlp
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Spinmatch
MB_APP_VERSION=0.1.0
METUBE_URL=
```

`MB_CONTACT_EMAIL` is necessary. The
[MusicBrainz API usage policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) requires a
real contact email in the `User-Agent` string of every request. Without it, MusicBrainz can block
the IP address of the app.

### Optional: local library ingest

Set `INGEST_DIR` and `MUSIC_DIR` to add an **Ingest** page. See `.env.example`. Put new audio in
`INGEST_DIR`, as single files or as whole album directories. Spinmatch tags each file and moves it
into a `{Artist}/{Album}/{Track} - {Title}` structure below `MUSIC_DIR`. A track with no album goes
to `{Artist}/Singles/`. A multi-disc release gets a disc prefix in each track name. If a file is
identical to one already in the library, Spinmatch leaves it in place instead of making a duplicate.

The Docker image sets both variables to `/data/ingest` and `/data/music`. `docker-compose.yml` and
the Unraid template already mount those two paths. Under Docker, the volume mapping is therefore the
whole configuration. Mount the host directories that you want, and the page appears. To disable the
feature, set a variable to an empty string. Outside Docker, both variables are empty by default, so
the feature stays optional.

Also set `ACOUSTID_API_KEY` to enable *automatic* identification. Spinmatch makes a fingerprint of
each track with [Chromaprint](https://acoustid.org/chromaprint) and asks
[AcoustID](https://acoustid.org/) what the recording is. It then compares the result against the
track length from MusicBrainz before it tags and moves the file. Spinmatch handles an album
directory as one unit. It tags and moves that directory only when one release accounts for every
file in it. In all other cases it leaves the whole directory for your review.

Get a free AcoustID API key at
[acoustid.org/new-application](https://acoustid.org/new-application). `fpcalc`, the command-line
program of Chromaprint, must be installed and on `PATH`. The Docker image installs `fpcalc` for you.
For local use, install it with your package manager, for example `apt install chromaprint` or
`brew install chromaprint`. If `fpcalc` is in another directory, set `FPCALC_PATH`.

Without `ACOUSTID_API_KEY`, ingest matches on the tags that the files already have. AcoustID key
registration has been unavailable for some time, so you may not be able to get a key. Spinmatch
searches MusicBrainz for the artist and title of the file. It accepts a result only when the title
agrees, and when the MusicBrainz length is within five seconds of the length of the file. This is
the same "confirm before any change" rule that the fingerprint path uses, without the fingerprint.

Album directories work the same way. Spinmatch matches the album and artist tags against a release
group whose whole tracklist agrees by duration. Track-number tags, when they exist, set the running
order instead of the filenames. This path makes no fingerprint, so it does not need `fpcalc`.

Spinmatch leaves any file that it cannot identify with confidence in `INGEST_DIR`. It lists that
file on the Ingest page as "needs review". Spinmatch never deletes a file, and it never moves an
unmatched item without your review. It also never guesses.

You can resolve a single file directly from the needs-review list. Select one of the offered
candidates, or search MusicBrainz yourself by artist and title. With `ACOUSTID_API_KEY` set, the
candidates are the lower-confidence results from AcoustID. Without it, the candidates are what
MusicBrainz returns for the tags of the file. Spinmatch then tags and moves the file in the same way
as an automatic match. Spinmatch does not change a file that is not audio.

### Library / Collection Manager

When `MUSIC_DIR` is set, Spinmatch also indexes that directory into a local SQLite database and adds
a **Your Library** page. The index records the artist, album, title, duration, track number, disc
number, year, genre, format, and file size. It also records whether the file has embedded cover art,
and the date when Spinmatch first saw the track.

Spinmatch builds the index at startup. A background scan and a filesystem watcher then keep it
current, so Spinmatch detects a change that you make outside the app without a restart. The scan
runs in a worker thread. The tag reads and database writes for each file therefore happen off the
main event loop. The app stays responsive during a scan of a large collection of 100k tracks or
more.

The Library page has eight tabs:

- **Overview** — the track, album, and artist counts, the total playtime, the total size on disk,
  and a format breakdown. It also has shortcuts into the reports below.
- **Artists** — searchable, and sortable by name, album count, track count, or playtime. Open an
  artist to see their albums.
- **Albums** — a grid of cover art, sortable by artist, title, year, track count, or date added. It
  has an "incomplete only" filter. Spinmatch reads album art from the files on demand, so it
  extracts nothing to disk and reads only the covers on the screen. Spinmatch uses the art that the
  audio file embeds. If the file embeds none, Spinmatch serves a `cover`, `folder`, or `front` image
  from the album directory instead. A library that keeps art beside the music therefore still gets
  covers.
- **Tracks** — the whole collection in one sortable, searchable table. The server pages this table,
  so it stays responsive at any library size. Each row has an **Edit tags** action that opens the
  editor in place.
- **Incomplete** — albums that look unfinished. Spinmatch computes this tab from the index alone and
  makes no network request. It reports three cases:

  1. A gap in the numbering. You have 1, 2, and 4 of 4, so 3 is absent.
  2. One file filed as a whole album.
  3. An album with no track numbers, where Spinmatch cannot judge completeness.

  Each absent position opens the album view, where **Find this track** searches for it.
- **Health** — tag hygiene. This tab counts the tracks that have no artist, album, title, track
  number, duration, or cover art. Check it, because the matching described below uses the artist and
  the title. An empty artist tag is invisible to that matching.

  "No album tag" and "No title tag" count files whose album or title the rest of the app *displays*.
  The scanner uses the directory name and the filename as a fallback, so the browse views have
  something to group and label by. The Health tab is where you learn that the file itself has
  neither value. Those rows show the value in grey, mark it *(from folder)* or *(from filename)*, and
  print the path below it.

  Each count opens the tracks behind it, and most rows offer two actions.

  **Fix tags** selects the correct MusicBrainz recording, either from the tags of the file or from a
  search that you make. Spinmatch then adds the values that are absent: artist, title, album, year,
  track number, disc number, and cover art. By default it fills only the tags that are *empty*, and
  it never replaces a value that you already have.

  **Edit tags** is the reverse. You type the values, and Spinmatch writes them over what the file
  has. This is the one path in the app where you are the source of truth instead of MusicBrainz.
  That is what makes it the correct tool here. These rows are files whose tags are absent, and that
  is exactly what a MusicBrainz search has nothing to search on. See
  [Editing tags by hand](#editing-tags-by-hand).

  Neither action ever removes a tag, and neither one moves or renames the file. An absent *duration*
  is the exception. It means that Spinmatch could not decode the audio stream, so the file is
  damaged instead of badly tagged, and Spinmatch offers no repair.

  When the tags of a file are too empty to search on, the picker uses the *path* of the file
  instead. `Artist/Album/05 - Title.flac` is metadata too. A **Whole album** button opens the
  album-wide repair that the next section describes.

  With `ACOUSTID_API_KEY` set, the panel also offers **Identify by audio**. Spinmatch makes a
  fingerprint of the file with Chromaprint and asks AcoustID what the recording is. This is the only
  way to identify a file whose tags and path are both useless. A fingerprint does not depend on the
  metadata that you are about to repair. It is therefore also the one source that may *replace* an
  existing value instead of only filling an empty one. That is what repairs a file tagged as the
  wrong song.

  Two check boxes control the replacement. Both are clear by default, and Spinmatch offers them for
  fingerprint matches only. One replaces the text tags. The other replaces the embedded cover art.
  They are separate on purpose, because the correct title and someone else's cover art are different
  wishes. The button is per track instead of automatic, because a fingerprint starts a subprocess
  over the audio and spends one rate-limited AcoustID request.
- **Duplicates** — the same artist, album, and title indexed at more than one path. Spinmatch shows
  the track number, length, format, size, and full path of every copy beside each other. Each copy
  also gets a play button, so you can compare them. The album is part of the match. A song on two
  different releases is therefore not a duplicate, and Spinmatch does not list it. An album track
  that is also on a compilation is the common example. What remains is real redundancy: a FLAC and a 128k MP3
  of the same album track, or a directory copied twice.

  Each copy also gets a **Move aside** button. It moves that file into a `.spinmatch-trash` folder
  inside your music folder, keeping the same artist and album layout, so
  `Music/Nick Cave/Tender Prey/01 - The Mercy Seat.flac` becomes
  `Music/.spinmatch-trash/Nick Cave/Tender Prey/01 - The Mercy Seat.flac`. **Spinmatch never deletes
  a file.** The move frees no space, which is the point: you clean up now, check the folder later,
  and delete it yourself when you are sure. Spinmatch has no button that empties the trash.

  Spinmatch refuses to move aside the last copy of a track, so a group can never be emptied by
  accident. An **Undo** appears next to a copy you have just moved and puts it straight back. Undo
  is there while the page is open; after that, moving the file back by hand is easy, because the
  trash mirrors your library.
- **Discover** — the one view that looks outward. It shows artists and records connected to the ones
  that you own the most of, and it rebuilds a playlist. See below.

Beside the **Rescan library** button, each artist page and album page has a **Rescan this
artist/album** action. That action re-reads only those directories, which is useful directly after
you repair tags or add a file. Spinmatch reads the whole directory instead of only the files that it
already knows, so it also finds new tracks.

### Repairing a whole album's tags

Each album page has a **Fix this album's tags** panel. It is the bulk equivalent of the per-track
action in the Health tab. A repair of one file at a time through MusicBrainz costs one to three
rate-limited lookups, so a few hundred files take about twenty minutes. A repair that resolves the
album *once* costs two lookups for the whole tracklist. There are two sources, because they fail in
opposite directions:

- **From file paths** — reads the artist, album, track number, and title from the location of each
  file. It makes no network request, and it works on files that have no tags at all, which is
  exactly the population of the Health tab.
- **From MusicBrainz** — resolves the album once and matches your files against its official
  tracklist. It matches by track number when every file has one, and by listing order when they do
  not. It uses the listing order only when both lists have the same length, so it never moves a
  partial album onto the wrong titles.

Both sources show a full preview first. The preview lists every file and every proposed value, and
marks what Spinmatch would write against what the file already has. Spinmatch writes nothing until
you select rows and press **Apply**. The same rules as the single-track **Fix tags** action hold.
Spinmatch fills only empty fields, and it moves and renames nothing. To write your own values across
an album, use **Edit album tags** below.

### Editing tags by hand

Every path above derives what to write, from a MusicBrainz recording, an official tracklist, or the
path of the file. Each one fills only what is empty. This section describes the other half. Here the
values come from you, and Spinmatch writes them over what the file already has.

**One track at a time.** An **Edit tags** action is on every row of the **Tracks** tab, and on
every track in an album tracklist. It is also beside **Fix tags** in the **Health** drill-down. The
editor opens in place, below the row that you selected. It has the seven writable fields: artist,
title, album, track number, disc, year, and genre.

**A whole album at once.** Each album page has an **Edit album tags** panel. Spinmatch applies the
artist, album, year, genre, and disc values to every track that you leave selected. The title and
the track number stay per row, because one title across a whole record is never what anyone means. A
field whose tracks disagree shows *(varies)* and starts empty, so you cannot replace twelve
different values with one by accident.

Three points are worth your attention, because they surprise people:

- **A field that you leave blank keeps its current value.** An edit replaces a value, but it never
  *removes* a tag. Spinmatch cannot empty a field, on purpose, because that is the one operation
  with no way to undo it. If you clear a box, the panel says so on the row instead of doing nothing
  silently. To remove a tag, clear it in an external tag editor and then rescan.
- **Spinmatch writes nothing until you confirm it.** When you press **Save**, Spinmatch shows the
  pending changes as a plain list of the old value, the new value, and the number of files. It
  writes only when you press **Write these tags**. Nothing in this app can be undone, and this is
  the one path whose values come from a keyboard instead of a lookup.
- **A change to the artist or the album changes the tags only.** Spinmatch never moves or renames a
  file, so the directory on disk keeps its old name. The **From file paths** repair source reads that
  directory, so it continues to propose the name that you changed away from. The panel warns you as
  soon as you edit either field.

Both paths write in place and re-index the file immediately. They report the result for each file. A
file that is read-only or absent appears as a failure, and Spinmatch still writes the rest of the
album.

### MusicBrainz checks

Four MusicBrainz checks sit above the offline reports. Each one runs only when you press its button,
so a slow or unreachable MusicBrainz never blocks a page.

- **Missing albums** (artist view) — compares the studio discography of the artist against what you
  own. It shows each absent record with its cover art and year. Each record links to the existing
  release-group page, where you can verify the tracks against YouTube and send them to MeTube. A
  match from a local artist name to MusicBrainz is a fuzzy search. When the match is ambiguous,
  Spinmatch asks you to select one instead of guessing, and it remembers your choice.

  **Joined credits** get a second attempt. About a quarter of a real collection is rows such as
  `Justice & Thundercat`, `Grabbitz feat. REZZ`, or `Nine Inch Nails / Stephen Morris and Gillian
  Gilbert`. None of these match a MusicBrainz artist. Spinmatch used to abandon them, even when it
  held hundreds of tracks by the first artist in the name. When the whole name does not match,
  Spinmatch retries with the primary artist, and the panel reports which artist it matched through.

  Two rules stop that fallback from inventing a match, and both are essential:

  - The fallback runs only **after** the whole name fails. A real band name that matches on its own,
    such as `She & Him` or `Simon & Garfunkel`, is therefore never split.
  - Spinmatch accepts the primary artist **only when you already own that artist under that exact
    name**. This matters more than it appears to. MusicBrainz has real artists named `Florence`,
    `Earth`, and `Wind`. A split of `Florence + The Machine` or `Earth, Wind & Fire` that trusted the
    name would therefore match the wrong act with complete confidence. A requirement that the
    segment is already on disk makes the fallback verify itself.

  Spinmatch rewrites nothing on disk and merges no rows. This affects only how it resolves a name
  upstream, so **Wrong artist?** undoes a wrong match, as it does anywhere else.
- **Find this track** (album view) — appears on each gap in the tracklist. A gap in the numbering
  knows only a position, and you cannot search YouTube for "track 4". Spinmatch therefore asks
  MusicBrainz what sits at that position, and then sends the named track to the usual YouTube
  lookup. The action is per row, and it is cheap on several rows. Spinmatch fetches the tracklist of
  the album once and reuses it, so only the first row reaches the network. If the position is past
  the end of the official tracklist, Spinmatch says so. A gap at 14 on a record of 12 tracks is a
  wrong track number on a file that you already have. **Edit tags** is the repair for that.
- **Check tracklist** (album view) — compares one album against its official tracklist. This finds
  what the track-number check cannot: an album numbered 1 to 10 with no gaps that in fact has 12
  tracks. Each absent track gets the usual **Find on YouTube** button. **Find all missing on
  YouTube** does the whole gap in one pass. It uses the same streaming, one-at-a-time matching as
  the release-group page. It covers only the tracks that you do not own, so Spinmatch searches for
  nothing that you have. The results have the usual copy-link and Send to MeTube actions.
- **Find every missing track on YouTube** (artist view) — a sweep of the whole discography. It
  covers every track of every album that the artist has and you do not, in one streaming run. This
  is several minutes of work at one lookup per second. Spinmatch therefore writes each result to a
  small cache on disk as it arrives. If you stop the run and return later, it continues instead of
  starting again. Spinmatch reports and skips an album whose tracklist it cannot read. A rate limit
  stops the run.

### Discovery

Every other library view finds gaps in records that you already know about. The **Discover** tab is
the reverse. It reaches music that you do not have from music that you do:

- **Find similar artists** — starts from the ten artists that you own the most of, and follows two
  signals. **Sounds like** comes from ListenBrainz, where a listening history overlaps with yours.
  **Connected to** comes from the relationship graph of MusicBrainz, which records shared members,
  side projects, and collaborations. Each suggestion reports which of your artists led to it and by
  which signal. Spinmatch ranks the suggestions by how many of your artists agree, and it removes
  anything already in your library.
- **Suggest albums** — the same idea, one step further. It lists the studio discographies of the
  first few discovered artists, without the records that you already own. Each cover links to the
  release-group page, where the existing verify-and-send-to-MeTube flow continues.
- **Rebuild a playlist** — paste one track for each line, as `Artist - Title` or as a title alone.
  Spinmatch reports what you already have and what you must still find. This works offline. It
  matches against the index and makes no upstream request, so it works when MusicBrainz does not.

Spinmatch keeps the two signals separate instead of combining them, because they make different
claims. MusicBrainz records facts, not taste. A "member of band" edge is a documented connection,
and it finds side projects that listening data ranks poorly or not at all. ListenBrainz is the
reverse. It knows nothing about who played on what, but it knows that a listener of Portishead also
plays Massive Attack. An artist that both signals reach is the strongest result here, and Spinmatch
marks it.

Both signals come from MetaBrainz, both use the same artist ids, and neither needs an API key.
Spinmatch never sends your listening habits anywhere, because it only ever asks which artist is
similar to a given artist id.

The similar-artist endpoint of ListenBrainz is on an experimental subdomain, so Spinmatch supports
its absence instead of treating it as a failure. Discovery then uses the relationship graph alone and
reports that on the page. Set `LISTENBRAINZ_ENABLED=0` to disable it deliberately. Spinmatch caches
both lookups for a month, and it never caches an outage. Without that rule, a short outage would look
like "this artist has no neighbors" for weeks.

A collection concentrated in one scene still returns little. That is an honest answer, not a fault.

Search results and artist pages also know your library. Spinmatch marks an album or song that you
already have with **In your library**. That check is local SQL with no upstream request, and it
matches in the same way as gap detection. "Kid A (Deluxe Edition)" on disk therefore still counts as
ownership of "Kid A". An artist page is also a coverage view, because it shows the whole studio
discography with the records that you own marked.

An album page reached from a search still has the original gap detection. Spinmatch matches by
artist and track title, and it normalizes both. The normalization ignores case, punctuation,
featured-artist suffixes, and a suffix in brackets such as "(Remastered 2011)" or "[Live]". A
remaster that you own is therefore not reported as absent. Larger tag differences, such as "The
Beatles" against "Beatles", can still make a track that you own appear as absent. Results therefore
depend on the tag hygiene of your files. See the Health tab.

Spinmatch also has a small **preview player**. Press play on any track to stream it from disk, with
seeking and with next and previous across the list that you started from. This is a preview on
purpose. It is a way to confirm that a file is what its tags claim, and it is not a music server.
There is no queue management, no transcoding, and no playback outside the Library page. Point
Navidrome or Jellyfin at `MUSIC_DIR` for those features.

**Upgrading:** the first scan after an update re-reads the tags of every file once, to fill the
columns that this version adds. On a large collection that takes a few minutes. It runs in the
background, and it runs once. Spinmatch keeps the date when each track first entered your library. A
later upgrade also deletes an unused `verified_tracks` table from an early schema. No data that you
can see changes.

This feature needs no separate flag. Spinmatch enables it as soon as you configure `MUSIC_DIR`,
independent of the ingest feature above. The index is at `LIBRARY_DB`, default
`/data/db/library.db`. As with `MUSIC_DIR`, this path **must be on a mounted volume** under Docker
and Unraid. Otherwise Spinmatch rebuilds the index every time you recreate the container, which is
harmless but slow. In Docker Compose, set `DB_HOST_DIR` to the host directory to bind-mount for it,
default `./db`.

The built-in `node:sqlite` module of Node is still experimental. On some versions of Node you
therefore see a single `ExperimentalWarning: SQLite is an experimental feature` on stderr at startup.
This warning did not appear on Node 24.16. It is expected and harmless.

## Running locally

```
npm install
npm run dev
```

This runs the Express backend and the Vite dev server together. The backend uses
`--env-file=../.env`, so it reads `.env` from the root of the repository. Open
http://localhost:5173.

## Running in production

```
npm install
npm run build
npm start
```

`npm start` runs the Express server directly, and reads `.env` through `--env-file`. The server
serves the built client from `client/dist` on `$PORT`, default 3000.

## Running with Docker

```
cp .env.example .env   # fill in your values
docker compose up --build
```

The app is then at http://localhost:3000. The container builds the client and runs the server in one
image. No separate frontend container is necessary.

### File ownership (`PUID` / `PGID`)

The container starts as root, prepares its own database directory, and then changes to an
unprivileged user id before it runs the server. It never answers a request as root. This process
runs `yt-dlp` and `fpcalc` as subprocesses, and it parses tags out of files that you downloaded from
anywhere. None of that work should run as root with your music library mounted read-write. The
change of user id also means that the ingest flow writes files owned by you instead of by root.
Your media player can therefore still write to them.

`PUID` and `PGID` select that user id. The default is **1000:1000**:

```
PUID=1000     # `id -u` on most Linux hosts; 99 on Unraid (nobody)
PGID=1000     # `id -g` on most Linux hosts; 100 on Unraid (users)
```

This matters because a bind mount keeps the ownership of the **host**. Nothing that the image does
at build time can change that ownership. Set these values to the owner of the directories that you
mounted.

The container changes the owner of `/data/db` for you at every start. That directory is the private
storage of the app, and it holds the SQLite index and your login. It deliberately does not touch your
music and ingest directories. A recursive change of owner across a music library is slow, is not the
decision of the container, and cannot be undone. If either directory is not writable, correct it
yourself:

```
sudo chown -R 1000:1000 ./ingest ./music
```

If the container cannot make the database directory writable, the server reports the problem at
startup and exits. It does not answer every request with a 500. Read `docker logs` for a message
that names the path, the user id that the server runs as, and the current owner.

An explicit `--user` still works, and it takes priority. The same applies to `user:` in
`docker-compose.yml`. The entrypoint detects that it is already unprivileged and does nothing. In
that case it can change no owner for you, so the mounts must already be writable.

> **Are you upgrading from a version that ran as root?** Your `db` directory belongs to root, and
> the server refuses to start until that changes. The entrypoint corrects this automatically. If you
> pinned `--user`, run `sudo chown -R 1000:1000 ./db` once.

## Running on Unraid

A published image is at `ghcr.io/yoshiofthewire/spinmatch:latest`. The build runs automatically on
every push to `main`, and within an hour of a new release of `yt-dlp` appearing.

To install with Community Applications:

1. Open the **Apps** tab.
2. Search for **Spinmatch**.
3. Click **Install**.

To add the same template by hand, without Community Applications:

1. Open the **Docker** tab.
2. Click **Add Container**.
3. Change the template list to **Enter URL**.
4. Paste this URL:

```
https://raw.githubusercontent.com/Yoshiofthewire/unraid_docker_apps/main/Spinmatch.xml
```

Both methods give you
[`Spinmatch.xml`](https://github.com/Yoshiofthewire/unraid_docker_apps/blob/main/Spinmatch.xml),
with the repository, port, paths, and environment variables already set. That file is in
[unraid_docker_apps](https://github.com/Yoshiofthewire/unraid_docker_apps) beside the other
templates, and not in this repository.

Set **MB Contact Email** at minimum. The mapped paths **Ingest Directory**, **Music Directory**, and
**Library DB Directory** are the host directories bind-mounted at the container paths
`/data/ingest`, `/data/music`, and `/data/db`. A path mapping alone tells the app nothing. The
template therefore also ships the matching `INGEST_DIR`, `MUSIC_DIR`, and `LIBRARY_DB` variables,
under **Show more settings**, which point at those container paths. Leave those variables unchanged
unless you change a container path.

Point **Music Directory** at your existing music share to enable the local library ingest feature
described above. Also set **AcoustID API Key** if you want automatic track identification. Without
that key, ingest still works with manual matching only. Point **Library DB Directory** at a
persistent appdata path, so the collection index survives a rebuild of the container. Spinmatch uses
that index as soon as you set **Music Directory**, and it needs no separate switch.

The template sets **PUID** and **PGID**, under **Show more settings**, to `nobody:users` of Unraid,
which is **99:100**. That pair owns a standard Unraid share. Leave both values unchanged unless you
know that something else owns yours. See [File ownership](#file-ownership-puid--pgid) above for what
they do, and for what happens when they are wrong.

## Tests

```
npm test
```

This runs the backend test suite on the built-in test runner of Node. The `MockAgent` of `undici`
mocks MusicBrainz, and the built-in method mocking of `node:test` replaces the `yt-dlp` calls. The
suite makes no live network request. There are no automated frontend tests. To verify a change to
the UI, run `npm run dev` and test it in a browser.
