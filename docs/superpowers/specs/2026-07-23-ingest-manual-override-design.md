# Manual override for ingest "needs review" files

## Motivation

The ingest pipeline (`server/src/services/ingest.js`) auto-matches loose audio files against
MusicBrainz via AcoustID fingerprinting, but anything it can't confidently identify — no
AcoustID candidates, none above the confidence threshold, or none within duration tolerance —
lands permanently in "needs review" with no way to resolve it from within the app. This is the
one gap that stops the ingest feature from finishing its own stated job: a file stuck there stays
stuck forever.

This design adds a manual override: for loose files that failed auto-matching, the user can pick
the correct MusicBrainz recording themselves (from AcoustID's below-threshold near-misses, or by
free-text search) and have the file tagged and moved exactly as an auto-confirmed match would be.

**Scope**: loose files only. Album folders that don't coherently resolve (`identifyAlbum`
failures) are out of scope — reconciling individual tracks within a folder against a manually
chosen release is a substantially different, more involved UI, better left as a future feature.
Loose-file needs-review entries caused by a duplicate already existing in the library, or a
failed filesystem move, are also out of scope — those already have a confirmed match; picking a
different recording doesn't fix either problem.

## Data model change: `needsReview` entries get a `code`

Every needs-review entry across `scanIngestDir`/`processIngest` currently has the shape
`{ path, name, reason }` with no machine-readable distinction between failure kinds. Add a `code`:

| code | Meaning | Override eligible? |
|---|---|---|
| `no_match` | Loose file: `identifyFile` found no confident match | Yes |
| `duplicate` | Loose file: identical file already exists in the library | No |
| `move_failed` | Loose file: tagged in place but the filesystem move failed | No |
| `album_incoherent` | Album folder: no release coherently matched the whole folder | No |

`processLooseFile` sets `code: 'no_match'` when `identifyFile` fails. `moveFileSafely` sets
`code: 'duplicate'` or `code: 'move_failed'` (used by both loose-file and per-track album paths —
album per-track failures are still not override-eligible even though they share these codes, since
the client only offers override on standalone `type: 'file'` scan items). `processAlbumFolder`
sets `code: 'album_incoherent'` for folder-level failures.

The client shows the "Find a match" action only on rows with `code === 'no_match'`.

## Backend changes

### Shared tag+move logic

`processLooseFile` currently combines identification with tagging/moving in one function. Extract
the tag+move half into a standalone function (working name `finalizeLooseFile(item, confirmed,
{ dryRun })`, taking an already-resolved MusicBrainz recording) so both the automatic path and the
new manual-resolve path call identical logic — no duplicated tagging/moving code.

### New endpoint: `GET /api/ingest/file/candidates?path=<path>`

Re-fingerprints the given file and re-runs the AcoustID lookup, this time keeping every candidate
(not just those scoring ≥ the existing 0.5 threshold), and fetches full MusicBrainz recording
details (`getRecording`) for up to 10 of them, sorted by AcoustID score descending. Returns:

```json
{ "candidates": [
  { "recordingMbid": "...", "title": "...", "artist": "...", "lengthMs": 123000,
    "score": 0.42, "releaseGroupTitle": "..." }
] }
```

`path` must resolve inside `INGEST_DIR` — validated the same way `organize.js`'s
`assertInsideMusicDir` guards `MUSIC_DIR` (`path.resolve` + prefix check), throwing
`BadRequestError` otherwise, since `path` is client-supplied. Behind the existing `ingestEnabled`
gate; no CSRF guard needed (read-only, GET).

### New endpoint: `POST /api/ingest/file/resolve`

Body: `{ path, name, recordingMbid, dryRun }`. Fetches the chosen recording via `getRecording`,
then calls `finalizeLooseFile` with it — identical tagging/moving behavior to an auto-confirmed
match. Returns a `matched` entry, or a `needsReview` entry (with `code: 'duplicate'` or
`'move_failed'`) if the move itself fails. Same `path`-inside-`INGEST_DIR` validation as above,
plus the existing `sameOriginOnly` CSRF guard (it writes tags and moves a file, same as
`/ingest/process`).

### Manual text search

Reuses the existing `GET /api/search?q=` endpoint — its `recordings` array (mbid, title, artist,
`lengthMs`, `releaseGroupTitle`) already has everything the picker needs. No new search endpoint.

## Frontend changes

New component `IngestMatchPicker.jsx`, rendered inline in `IngestPanel`'s needs-review table row
when `code === 'no_match'`, toggled by a "Find a match" button. Contents:

- Loading state while `GET /file/candidates` runs.
- Near-miss list: each candidate shows title/artist/album/length/score with a "Use this" button.
- Manual search box (artist/title text) → calls `GET /api/search`, lists `recordings` results the
  same way, each with a "Use this" button.
- "Cancel" link collapses the panel without changes.

Clicking "Use this" calls `POST /file/resolve` (`dryRun: false`), shows a small inline spinner on
that row. On success: the row is removed from the needs-review table and appended to the matched
table, and a history entry is logged via the existing `addEntry`/`logIngested` path — no full
re-scan required. On failure (new `duplicate`/`move_failed` needs-review entry): the row updates
in place with the new reason and code, and loses its override button (no longer `no_match`).

## Testing

Following the existing pattern (`node:test`, `undici` `MockAgent` for MusicBrainz/AcoustID,
method-mocking for `fpcalc`):

- `server/test/ingest.test.js`: unit tests for `finalizeLooseFile`, and for the near-miss
  candidate lookup (cases: some below-threshold candidates found; zero candidates found at all).
- `server/test/routes/ingest.test.js`: route tests for `GET /file/candidates` and
  `POST /file/resolve`, including the path-traversal rejection and the CSRF guard on `resolve`.
- Frontend tests for `IngestMatchPicker` are deferred to the separate "frontend test
  infrastructure" project later in the feature sequence, to avoid deciding that infrastructure
  ad hoc here.
