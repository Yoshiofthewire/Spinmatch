# Spinmatch Playlists

> **Status:** Designed, not started.

## Motivation

Spinmatch knows what you own and it knows what sits next to what you own. It has no way to turn
either into something you can put on a device and listen to.

The Discover tab already computes the hard part — ListenBrainz says whose listeners overlap with
yours, the MusicBrainz relationship graph says who played with whom — but it only ever reports
artists you *don't* have. The one existing playlist feature, "Rebuild a playlist", is a one-shot
matcher: paste lines, see what you have, and lose the result the moment you navigate away.

This design adds a persistent playlist that you build from any source — by hand, from discovery, or
from a pasted list — and export two ways: an m3u at the music root, or a folder of copied files
ready to drop on an MP3 player.

## Scope

**In scope:**

- Persistent playlists with ordered items, stored in SQLite alongside the library index.
- Items that may be tracks you own *or* gaps you don't, with gaps handing off to the existing
  verify flow.
- Filling a playlist from discovery, restricted to music you already own, by two selection methods.
- Manual add from anywhere in the app, and absorbing the existing paste-a-playlist panel.
- Export to extended m3u at `MUSIC_DIR`, and to a copied drop-off folder at a new `DROPOFF_DIR`.
- A targeted refactor of `libraryDiscovery.js` so neighbour accumulation can include owned artists.

**Out of scope:**

- Transcoding. Copies are byte-for-byte. A FLAC-heavy playlist arrives on a FLAC-incapable player
  unplayable, and that is the stated cost. The copy step is a single seam so this can be added later
  without reshaping the export.
- Track ratings of any kind — neither reading embedded POPM/Vorbis ratings nor a Spinmatch-native
  star rating. See "Rejected alternatives".
- Importing an existing m3u file.
- An m3u written inside the drop-off folder.

## Key decisions

| Decision | Choice |
| --- | --- |
| Playlist item identity | Text (artist/title/album), resolved against the index at read time |
| "Best tracks" source | ListenBrainz popularity, not ratings |
| Drop-off location | New opt-in `DROPOFF_DIR`, flat and numbered inside |
| Re-export | Refuse with a 409, then wipe-and-rewrite on explicit confirm |
| Discovery → playlist | Propose for review; nothing is written until you accept it |
| UI home | A new top-level `/playlists` page |

## Data model

Two new tables, plus two columns on `local_tracks`. `SCHEMA_VERSION` goes 6 → 7.

```sql
CREATE TABLE IF NOT EXISTS playlists (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  name_key         TEXT UNIQUE NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_exported_at INTEGER,
  last_export_dir  TEXT
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id          INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  artist      TEXT,
  title       TEXT NOT NULL,
  album       TEXT,
  match_key   TEXT NOT NULL,
  title_key   TEXT NOT NULL,
  source      TEXT NOT NULL,
  seed_artist TEXT,
  added_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pi_playlist ON playlist_items(playlist_id, position);
```

`name_key` is the name lowercased in JS, matching how `foldKey` in `libraryRepo.js` folds — so
"Road Trip" and "road trip" cannot both exist, and the folding stays in one language for the same
Unicode reason that file documents.

`source` is one of `manual`, `popular`, `random`, `paste`. Note that `random` is the stored value for
the method the UI labels **Chance**; the two names refer to the same thing. `seed_artist` records
which of your
artists led to a discovery-sourced row. Together they are what lets the UI say *why* a row is there,
the same provenance the Discover tab already shows for artists — and they make a bad artist
resolution traceable after the fact, because every row it produced can be found and dropped
together.

`local_tracks` gains:

```sql
match_key TEXT   -- normalizeTitle(artist) ␟ normalizeTitle(title)
title_key TEXT   -- normalizeTitle(title)

CREATE INDEX IF NOT EXISTS idx_lt_live_match_key ON local_tracks(match_key) WHERE removed = 0;
CREATE INDEX IF NOT EXISTS idx_lt_live_title_key ON local_tracks(title_key) WHERE removed = 0;
```

Partial on `removed = 0`, following the convention `db.js` already establishes and documents.

### Why text identity rather than a foreign key

The obvious model is `playlist_items.local_track_id REFERENCES local_tracks(id)`. It breaks, and it
breaks because of Spinmatch itself.

`local_tracks` is keyed on `path UNIQUE`. A moved or renamed file becomes a *new row*, and the old
row is flagged `removed = 1`. Ingest's `moveIntoLibrary` moves files. Duplicate-trash moves files.
An album-wide tag repair can relocate them. A playlist built on ids would rot every time you used
the rest of the application, and keeping it correct would mean every code path that moves a file
also remembering to update playlists — with silent data loss as the cost of forgetting.

Text identity resolved at read time survives all of it. It also gives the feature its best property
for free: **a gap fills itself in.** Download a missing track, ingest it, and the playlist row goes
from gap to playable with no bookkeeping anywhere. That is what makes the verifier handoff feel
finished rather than a to-do list you have to reconcile by hand.

### Why two key columns

Resolution cannot reuse the existing `dup_key`. That column is `foldKey(artist, album, title)` — a
plain `toLowerCase()` join — so it will not match "Kid A (Remastered)" to "Kid A". Playlist
resolution needs `normalizeTitle`, which strips parenthetical suffixes, bracketed suffixes and
featured-artist tails.

`match_key` handles the normal case. `title_key` exists because a pasted line can be a bare title
with no artist; without an index for that case it degrades to a table scan. With both, resolving a
whole playlist is two indexed queries regardless of its length.

Resolution order, stated explicitly because it decides how forgiving the feature is:

1. Every item is looked up by `match_key`.
2. Items that miss — including every item whose `artist` is null, whose `match_key` can never
   match — are looked up again by `title_key`.
3. Anything still unmatched is a gap.

Step 2 applying to *misses* rather than only to artist-less items is deliberate: it means a track
whose artist tag disagrees with the playlist ("The Beatles" against "Beatles") still resolves on
title alone, which is the same forgiveness `reconstructPlaylist` offers today.

Today's `reconstructPlaylist` does this with one `listTracks({ q: title, limit: 25 })` per line and
a filter in JS. That is a query per row **and** lossy — a common title with more than 25 index hits
can miss the right file entirely. The existing paste panel gets correct and fast as a side effect of
this work.

### Migration

Both keys derive from `artist` and `title`, which are already in the table, so the backfill is a
single pass in `migrate()` — no files are re-read from disk. This is unlike the v2 column additions,
which needed a rescan.

### Deliberate omissions

- **No unique constraint on items.** A playlist may hold the same track twice. `PlaylistPanel.jsx`
  already documents that a playlist rebuilt from memory routinely repeats a track; forbidding it
  would be a regression.
- **`position` is contiguous**, renumbered inside a transaction on reorder. Sparse positions with
  gap-insertion is the usual trick for large ordered lists. A playlist is hundreds of rows, so a
  full renumber is milliseconds and removes a class of bug about exhausting the gaps.

### Resolving one item to one file

When a `match_key` matches several live files — you own the album and a greatest-hits copy — prefer
the row whose `album` equals the item's `album` if the item has one, then fall back to the largest
`size_bytes` on the theory that the bigger file is the better rip. This is a guess, but it only ever
decides which of two copies you already own reaches the player.

## Modules

Five server modules and one route file. Each has one job and a dependency shape that lets it be
tested alone.

**`services/playlistRepo.js`** — CRUD over the two tables, plus batched resolution. Pure SQL: no
network, no filesystem. The only module that knows the playlist schema, mirroring `libraryRepo.js`
as the only thing that knows `local_tracks`.

**`services/playlistFill.js`** — the samplers, as a **pure function**. Takes a candidate pool (tracks
tagged with artist and popularity rank) plus options — method, target, per-artist cap, duration
bounds, byte budget — and returns the chosen rows. No DB, no network, no clock. Randomness enters
through an injected RNG. This shape is deliberate: the cap arithmetic, the round-robin spread, the
greedy byte fill and the stop-short reporting are where the subtle bugs live, and this lets every
one of them be tested against a fixture array with no mocking.

**`services/listenBrainz.js`** — extended, not duplicated, with `getTopRecordings(artistMbid)`. Same
upstream organisation, same shared rate limiter, same month-long cache, and it needs exactly the
null-on-failure convention already implemented and tested there. It requires a second `BASE_URL`,
because popularity is on `api.listenbrainz.org` rather than the experimental `labs.` host — and the
module header needs amending, since it currently declares the whole module experimental
infrastructure and that will be true of only half of it.

**`services/playlistDiscovery.js`** — the glue. Seed artist → neighbour accumulation → neighbours you
own → their tracks → popularity ranks attached. Network and DB live here so they do not live in the
sampler.

**`services/playlistExport.js`** — m3u writing and drop-off copying. Filesystem only; takes resolved
tracks and a destination.

**`routes/playlists.js`** — a new file rather than more of `library.js`, which is already 674 lines.

```
GET    /api/playlists
POST   /api/playlists                    { name }
GET    /api/playlists/:id                → items, resolved
PATCH  /api/playlists/:id                { name }
DELETE /api/playlists/:id
POST   /api/playlists/:id/items          { items: [...] }   bulk add
DELETE /api/playlists/:id/items/:itemId
PATCH  /api/playlists/:id/order          { itemIds: [...] }
POST   /api/playlists/:id/suggest        { seed, method, target, ... }
POST   /api/playlists/:id/export/m3u
POST   /api/playlists/:id/export/dropoff { replace }
```

Two properties of that list are load-bearing.

**`/suggest` writes nothing.** It returns proposals and stops. That *is* the review step: the client
shows the rows with their provenance, you untick what you do not want, and what survives goes back
through `/items`. Making it a read makes review structural rather than a UI convention that a later
change can bypass.

**`/export/dropoff` streams.** Copying gigabytes to a USB volume outlives any reasonable request
timeout, so it reports per-file progress over SSE using the existing `lib/sse.js` — the same pattern
`BulkVerifyPanel` already consumes on the client. It runs inside `withFileLock` on the target
folder, because two concurrent exports into one directory is exactly the race that machinery exists
for.

## The fill pipeline

### Required refactor of `libraryDiscovery.js`

`libraryDiscovery.js` cannot supply the candidate pool as written. Its `note()` function opens with

```js
if (owned.has(artistKey(candidate.name))) return;
```

so every neighbour you already own is discarded before it is ever recorded. That is correct for the
Discover tab, whose purpose is music you do not have. It is precisely inverted for playlists — the
artists it discards are the ones we want. It also seeds only from your global top-10 artists, with
no way to ask for the neighbours of a specific one.

Neighbour accumulation is therefore lifted into a function taking a caller-supplied seed list, with
the owned-filter as the **caller's policy** rather than baked-in behaviour. The Discover tab passes
`excludeOwned: true` and keeps its exact current results; playlists pass `false`. One walk of the
signals serves both, and the existing shared-promise deduplication and month-long cache continue to
work unchanged.

### Steps

1. **Seed** — an artist, or an album or track whose artist is taken. Multiple seeds allowed.
2. **Neighbours** — the refactored call, owned artists kept, each carrying signal strength and `via`
   provenance.
3. **Pool** — every owned track by those neighbours, minus anything failing the duration filter.
4. **Rank within each artist** —
   - *Popular*: the ListenBrainz top-recordings list for that artist's MBID, matched to your files
     via `match_key`. Owned tracks absent from the list fall to the back.
   - *Chance*: shuffled with the injected RNG. An optional **prefer popular** toggle narrows the
     draw to that artist's top `2 × cap` popular tracks before shuffling — enough headroom that the
     result still varies between reshuffles, while keeping it away from the deep cuts. When
     popularity is unavailable for an artist the toggle is a no-op for that artist and the shuffle
     runs over its whole pool.
5. **Fill** — round-robin across artists rather than walking one artist at a time, so the cap is
   rarely what stops the fill. Tracks already in the playlist are skipped.
6. **Stop** — at target, when nothing left fits the byte budget, or when every artist is exhausted
   or capped. Which one is returned and shown.

### The duration filter

Applied to auto-fill only, never to a track added by hand — that is your call, not the sampler's.

- **Minimum 60 s.** Kills interludes, skits and silence fragments. 60 rather than 90 because a lot
  of punk and hardcore is legitimately 45–90 seconds, and silently eating a genre is worse than
  admitting the occasional interlude.
- **Maximum 12 min.** Keeps most prog and post-rock, drops DJ mixes and hidden-track outros. It
  *will* exclude "Echoes". That is the honest cost of a single number.
- **NULL duration is excluded.** The Health tab already establishes what a NULL duration means: the
  scanner could not decode the audio stream, so the file is damaged. It will not play on the device
  either.

Both bounds are tunable in the panel, and both are **per request rather than persisted** — they
travel in the `/suggest` body and are not stored on the playlist. A playlist is a list of tracks,
not a saved query, so there is nothing for a stored bound to apply to on a later visit.

### The per-artist cap

```
cap = ceil(target / poolArtists) + 5
```

| target | artists | cap | one artist's max share |
| --- | --- | --- | --- |
| 100 | 10 | 15 | 15% |
| 200 | 40 | 10 | 5% |
| 100 | 4 | 30 | 30% |
| 20 | 10 | 7 | 35% |

It behaves from roughly 50 tracks up. Below that the `+5` dominates and the cap goes slack — on a
20-track playlist one artist can still take a third. Ship it as the default and **put the computed
number on screen** ("at most 15 per artist") so it is visible when it behaves oddly, rather than
adding a second rule to correct it.

Two details decide whether it works at all:

- **`poolArtists` counts artists that survived step 3** — those you own qualifying tracks by — not
  the neighbours discovery returned. Seed five artists, own two, and dividing by five gives a cap so
  tight the fill stalls.
- **When the cap prevents reaching the target, stop and say so.** "Filled 62 of 100; the per-artist
  cap held the rest back." Never quietly relax it.

### The byte budget

Expressed in MB as well as track count, because the destination is a device with finite storage and
`size_bytes` is already indexed. Greedy fill.

An oversized track is **skipped, not fatal**. One 180 MB lossless file must not end a fill with
400 MB still free; the loop keeps trying smaller candidates and terminates naturally when the pool
runs dry.

## Export

### m3u

Written to `MUSIC_DIR/<name>.m3u`, where `<name>` goes through `sanitizeSegment` from `organize.js`
— the same stripping of path separators and trailing dots that already guards MusicBrainz-sourced
filenames — then through `assertInsideMusicDir` as defence in depth.

Extended M3U, UTF-8, `#EXTM3U` header, one `#EXTINF:<seconds>,<Artist> - <Title>` per entry. Paths
are relative to `MUSIC_DIR` with forward slashes: the file sits at the root, and relative paths are
what survive being read on another machine or a different mount point.

Written to a temp file and renamed, so a half-written playlist never exists at the real path.

Two requirements that are easy to miss:

- **The write must go through `noteWrite`.** The MUSIC_DIR watcher does not filter by extension —
  `librarySync.js` fires on any change under the root and debounces into a full `scanLibrary()`.
  Without this, every m3u export triggers a complete rescan of the collection. `recentWrites.js` is
  keyed on basename and `fs.watch` reports basenames, so `noteWrite(m3uPath)` closes it exactly as
  tag writes already do.
- **Gaps become comments.** A missing track cannot be a path, so it is written as
  `# missing: Artist - Title`. Players ignore `#` lines, and the file stays a complete record of the
  playlist rather than a silently shortened one.

### Drop-off folder

`<DROPOFF_DIR>/<name>/`, flat, as `NN - Artist - Title.ext`.

`NN` is zero-padded **to the width of the track count**, not to two digits. A 100-track playlist
padded to two sorts as `1, 10, 100, 11` on a device that orders by filename, which defeats the
entire purpose of numbering. Flat-and-numbered because the target is a player that walks files
alphabetically and has no concept of a playlist: the numbering *is* the ordering.

`DROPOFF_DIR` is a new optional environment variable, following the `INGEST_DIR` pattern — unset
means the feature is hidden. It exists rather than a folder inside `MUSIC_DIR` so the copies stay
off the music volume, which matters when `MUSIC_DIR` is a network share and the player is USB, and
so the scanner never indexes the copies as duplicates.

Order of operations, because this is the destructive path:

1. Resolve `DROPOFF_DIR` through `realpath`. Refuse if unset, or if it resolves to `MUSIC_DIR`, a
   parent of it, or the filesystem root.
2. If the target folder exists, respond `409` with its file count and export date. Nothing is
   touched. Only `replace: true` proceeds.
3. Check free space with `statfs` against the total bytes needed. Better to fail before copying than
   halfway through filling a device.
4. Delete the folder's contents, then copy — `fs.copyFile` per track, progress streamed over SSE.
5. Report the summary: copied, skipped-as-gaps, bytes written.

Wipe-and-rewrite rather than a sync was chosen so that the destructive step happens only after a
count has been shown and a button pressed. "Delete the folder, write it fresh" is a few lines that
are easy to get right; a diff-and-renumber has to reason about which files it owns. A full recopy is
I/O happening at USB speed regardless.

## UI

A new top-level page at `/playlists`, not a ninth Library tab. Library's tabs are all views *of* the
collection; a playlist is an object you create, name, open, edit and export, with its own detail
view. It gets a nav entry beside Search, Library, Ingest and History, and a
`client/src/api/playlists.js` alongside the existing `library.js`.

**List view** — one row per playlist: name, track count, how many are gaps, total size on disk, last
exported. Size is there because it is the number that decides whether it fits on the player.

**Detail view** — the ordered rows, drag to reorder, remove per row, and a play button wired to the
existing preview player using the same `onPlay(track, queue)` signature `PlaylistPanel` already
passes. Each row carries its provenance as a small badge: *from Portishead · sounds like*. Gap rows
are styled apart and carry **Find on YouTube** — the verifier handoff, which needs nothing new,
because the row stores artist and title as text and that is exactly what the existing verify flow
takes. Header actions: Export m3u, Export to player, Rename, Delete.

**Adding tracks** — one panel, three sources:

- *From discovery* — seed picker, method (Popular / Chance), target count, optional size limit in MB,
  the prefer-popular toggle, and the duration bounds behind an "advanced" disclosure. **Suggest**
  returns proposals, each with provenance and a tick box, plus a line saying what stopped the fill.
  Untick, then **Add selected**.
- *From paste* — the existing textarea, with results now addable to a playlist. Found and missing
  lines both go in; missing ones land as gap rows.
- *From the library* — a small `AddToPlaylistButton` on Tracks rows, album pages, artist pages and
  search results, opening a playlist picker.

The existing "Rebuild a playlist" panel **moves out of the Discover tab** into this page. Keeping a
second playlist entry point in Discover would mean two places that build playlists and only one that
saves them.

### README changes

- The Discovery section loses its "Rebuild a playlist" bullet, which moves to a new Playlists
  section.
- `DROPOFF_DIR` joins the Configuration section.
- The line "Spinmatch **only finds and verifies YouTube links**. It does not download or copy audio."
  becomes "It does not download audio." The copy clause is dropped; export copies files you already
  own.

## Failure modes

**Degradation.** ListenBrainz popularity returning null must not fail a fill — it falls back to
Chance for that artist, and the UI reports which artists ranked by popularity and which did not, the
way the Discover tab already reports running on half its signal. An artist that will not resolve to
an MBID contributes no neighbours and is named in the response rather than silently dropped. A
`match_key` that resolves to nothing becomes a gap, which is a normal state and not an error.

**Hard failures, on the destructive path only.** An unset or unsafe `DROPOFF_DIR` is a 400 before
anything is read. Insufficient free space is a 400 before anything is copied. An existing folder
without `replace` is the 409.

**A copy that fails partway** leaves the folder incomplete, and the SSE stream reports which file
died. Deliberately *not* rolled back: deleting files after a failed export is a worse outcome than
leaving a partial folder you can re-export over.

**Bounds.** Playlist name length, item count per playlist, and lines per paste all get caps,
following the pattern the "bound the inputs" work established. A target count or byte budget arriving
as a huge number is clamped, not trusted.

## Testing

Split along the module boundaries above.

- **`playlistFill`** is pure, so its tests are plain arrays and an injected RNG: the per-artist cap
  at each size in the table, the round-robin spread, the oversized-track skip, the byte budget, and
  each of the four stop reasons. Most of the risk lives here and it needs no mocking at all.
- **`playlistRepo`** against a temp DB, as `libraryRepo.test.js` does: resolution through `match_key`
  and `title_key`, the title-only fallback, duplicate items allowed, position renumbering, cascade on
  delete.
- **The migration** gets a test that an existing v6 database backfills both key columns correctly,
  matching `dbMigrate.test.js`.
- **`playlistExport`** against a temp directory: relative m3u paths, `# missing:` comments, padding
  width at 9/10/99/100 tracks, the 409, the containment refusals, and that `noteWrite` is called for
  the m3u.
- **`listenBrainz`** popularity gets the same null-on-outage and never-cache-an-outage tests the
  similar-artists half already has.
- **The discovery refactor** is guarded by the existing `libraryDiscovery.test.js`:
  `excludeOwned: true` must leave the Discover tab's results identical. This is working code being
  reshaped, so it is the regression that matters most.
- **Route tests** in `test/routes/` for auth, validation and the 409.

## Known uncertainty

**The ListenBrainz popularity endpoint's response shape has not been verified against the live
API.** This design assumes `api.listenbrainz.org/1/popularity/top-recordings-for-artist/<mbid>`
returns recordings with listen counts for an artist MBID. The implementation plan must confirm that
before building on it.

If it disappoints, the fallback is that Popular ranks by nothing and the feature ships as Chance
plus manual selection — degraded, not blocked. Nothing else in this design depends on it.

## Rejected alternatives

**Ratings as the "best tracks" signal.** Spinmatch has no ratings: `local_tracks` has no rating
column, `tags.js` reads seven fields and rating is not among them, and the History page is
localStorage search history rather than play counts. Three sources were considered.

*Embedded file ratings* (POPM in ID3v2, `RATING` in Vorbis comments) would need a new column, a
schema bump and a rescan. POPM is a 0–255 byte whose scale is player-specific and mutually
contradictory — Windows Media Player writes 1/64/128/196/255, others map linearly — and Vorbis
`RATING` is non-standard, 0–100 in some players and 1–5 in others, so normalising is partly
guesswork. The worse problem is coverage: an unrated library yields an empty column and a method
that silently picks nothing.

*A Spinmatch-native star rating* is straightforward and dead on arrival until several hundred tracks
have been rated by hand.

*ListenBrainz popularity* needs no rating data, no API key, and reuses machinery that already exists
— MBID resolution in `library_artist_links`, the month-long cache, the degrade-not-fail convention.
It is also on the main API rather than the experimental `labs.` host, making it the sturdier of the
two ListenBrainz dependencies. Its honest flaw is that it is global popularity rather than your
taste: it picks the hits. For a discovery playlist that is arguably right, since the hits are how you
find out whether you like an artist you barely own.

The method is labelled **Popular (ListenBrainz)** in the UI, never "best". Blending signals of
different kinds into one opaque quality score is the thing the Discover tab already refuses to do,
for the same reason: they make different claims, and averaging them produces a number that means
nothing.

**Foreign-key item identity, and the hybrid.** Covered under "Why text identity rather than a foreign
key". The hybrid — text as truth with a cached id as a hint — gains all of text identity's behaviour
plus a cache to keep coherent, and the read cost does not justify it.

**Syncing the drop-off folder instead of wipe-and-rewrite.** Add what is missing, delete what is
gone, renumber the rest. Correct, and the right answer if these playlists run to hundreds of tracks
and are re-exported often. Rejected for now because it deletes files without asking and has to reason
about which files it owns, where wipe-and-rewrite makes the destructive step explicit and trivially
auditable.
