# AcoustID-backed matching for the library's "Fix tags" flow

## Motivation

Two flows in this app repair a file's metadata, and only one of them can hear the audio.

Ingest fingerprints loose files with `fpcalc` and identifies them through AcoustID
(`server/src/services/ingest.js`), and when auto-matching fails, "Find a match" offers AcoustID's
below-threshold near-misses for a human to pick from. The library's own repair flow — Health tab →
"Fix tags", backed by `server/src/services/libraryFix.js` — never fingerprints anything. It
searches MusicBrainz on the tags the file already carries, with the file's path as a fallback
(`tagMatch.candidatesFromTags`). For a file whose tags are missing *and* whose path is
uninformative, that search has nothing to work with and the panel degrades to a bare search box.

The fingerprint is the one signal that doesn't depend on the metadata being repaired. This design
makes it available in the per-track repair panel, on demand.

It also closes a related gap: `applyFix` writes only fields that are currently empty, so a file
tagged as the *wrong song* cannot be corrected through this flow at all — applying a match to it
writes nothing and the row reports "No changes needed". A fingerprint match is strong enough
evidence to justify replacing existing tags, so that becomes possible, but only behind a
deliberate opt-in.

**Scope**: the per-track panel (`FixTrackPanel`) only.

Out of scope:

- **Whole-album bulk fix** (`BulkFixPanel` / `libraryBulkFix.js`, sources `path` and
  `musicbrainz`). An `acoustid` source there means N `fpcalc` subprocesses and N AcoustID calls
  behind one click, which needs progress reporting and partial-failure handling — a different
  design problem, not an extension of this one.
- **Automatic fingerprinting on panel open.** Fingerprinting costs a subprocess that reads 120
  seconds of audio (30s timeout) plus a rate-limited network call. Browsing the Health tab must
  not spawn that work per expanded row. It stays behind an explicit click.
- **Replacing embedded cover art.** Art is filled only when the file has none, in both the
  existing and the new overwrite mode. A corrected file can therefore keep art belonging to the
  song it was previously mis-tagged as. Deliberate: art replacement is irreversible and this app
  has no undo.

## Backend

### New module: `server/src/services/fingerprintMatch.js`

The fingerprint counterpart to the existing `tagMatch.js`, with a matching shape:

```js
export async function candidatesFromFingerprint(filePath) // → { candidates }
```

The body is what `ingest.js`'s `findCandidatesForFile` currently inlines (`ingest.js:472-486`):
`fpcalc` fingerprint → `acoustid.lookup` → top 10 by score → `getRecording` for each → candidate
rows of the shape both pickers already render:

```json
{ "recordingMbid": "...", "title": "...", "artist": "...", "lengthMs": 123000,
  "score": 0.42, "releaseGroupTitle": "..." }
```

Scores stay on AcoustID's 0–1 scale, which is what `candidatesFromTags` already normalizes to.

`findCandidatesForFile` in `ingest.js` becomes a two-branch dispatch between
`tagMatch.candidatesFromTags` (no API key) and `fingerprintMatch.candidatesFromFingerprint`. This
is a pure extraction — ingest's behaviour and output are unchanged.

### `libraryFix.js`: `getFingerprintCandidates(trackId)`

```js
export async function getFingerprintCandidates(trackId) // → { track, candidates }
```

Calls the existing `trackOrThrow` (which re-validates the indexed path through
`assertReadableInsideMusicDir` before the file is opened), then `candidatesFromFingerprint(real)`.

Throws `BadRequestError` when `config.acoustidApiKey` is unset. The client hides the button in
that case, so reaching this means stale client config rather than a normal path.

Unlike `getFixCandidates`, this does **not** fall back to a tag search when the fingerprint yields
nothing — the caller already has the tag candidates on screen. Zero candidates returns an empty
array.

### `tags.js`: `writeMissingTags(filePath, desired, { coverImage, overwrite = false })`

With `overwrite: false` (the default), behaviour is exactly as today: a field is written only when
the current value is `null`.

With `overwrite: true`, a field is written when the desired value is non-null and differs from the
current value. Fields whose value already equals the desired one are not rewritten and do not
appear in `filledFields`, so applying a match that agrees with the file reports "No changes
needed" rather than claiming a write.

Cover art handling is identical in both modes: written only when the file has no pictures.

`plannedFills` (the dry-run preview used by bulk fix) is unchanged — nothing calls it with
overwrite semantics.

### `libraryFix.js`: `applyFix({ trackId, recordingMbid, overwrite = false })`

`overwrite` is passed through to `writeMissingTags`. One other conditional changes: the
track/disc position lookup currently runs only when `track.trackNumber == null`, and now runs when
`overwrite || track.trackNumber == null`, so a wrong track number can be corrected too.

The cover-art fetch condition (`!track.hasCoverArt`) is unchanged, per the scope note above.

Response gains `overwritten: boolean` alongside the existing `filledFields`, `track`, and
`recording`, so the UI can distinguish "filled" from "replaced" in its result badge.

### Routes (`server/src/routes/library.js`)

- `GET /library/fingerprint-candidates/:trackId` → `getFingerprintCandidates`. Read-only GET, no
  CSRF guard, consistent with the neighbouring `fix-candidates` route.
- `POST /library/fix` additionally reads `overwrite` from the body as `Boolean(req.body?.overwrite)`.
  Existing `trackId` and `recordingMbid` validation is untouched.

### Errors

No new error plumbing. `fpcalc` missing from PATH, `fpcalc` timing out, and AcoustID rate-limiting
or being unreachable already throw `UpstreamUnavailableError` / `RateLimitedError` from
`fpcalc.js` and `acoustid.js`, which the error middleware maps to a status and message. The panel
renders that message in the banner it already has. The only new message is the unconfigured-key
`BadRequestError`.

## Frontend

### `FixTrackPanel.jsx`

Reads `acoustidConfigured` from `useConfig()` — already exposed by `GET /config`
(`server/src/routes/config.js:11`) and already consumed by `IngestMatchPicker`.

When configured, an **"Identify by audio"** button renders above the manual search form, reading
"Fingerprinting…" and disabled while the request is in flight. It calls the new endpoint and
stores the result in its own state; the tag/path candidates loaded on panel open stay where they
are.

Fingerprint results render as a separate list under an **AcoustID matches** heading, above the
tag/path candidates, using the same `CandidateRow`. Any tag/path candidate whose `recordingMbid`
already appears in the fingerprint list is filtered out, so no recording offers two "Use" buttons
with two different scores.

When the fingerprint list is non-empty, a checkbox appears with it:

> **Replace existing tags, don't just fill blanks**

Unchecked by default. It applies only to "Use" on fingerprint-sourced rows — tag/path rows always
apply with `overwrite: false`, unchanged from today. `handleUse` therefore takes the candidate's
source alongside the mbid.

Errors from the fingerprint request render in the panel's existing error banner.

### `HealthTab.jsx`

The post-fix badge reads `Replaced <fields>` when the response has `overwritten: true`, and
`Filled <fields>` otherwise. "No changes needed" (empty `filledFields`) is unchanged.

### `client/src/api/library.js`

Adds `getFingerprintCandidates(trackId)` hitting the new route, and threads `overwrite` through
`applyFix`.

## Testing

Server-side only. `client/package.json` defines no test runner and root `npm test` runs the server
suite; adding frontend test infrastructure is its own project and is not decided here.

Following the existing style in `server/test/libraryFix.test.js` (module mocking via `freshFix`)
and `server/test/ingest.test.js` (`undici` `MockAgent` for AcoustID/MusicBrainz, method-mocking
for `fpcalc`):

- `fingerprintMatch`: maps a lookup result to candidate rows; returns an empty list when AcoustID
  finds nothing.
- `ingest.findCandidatesForFile` still returns what it did before the extraction, on both the
  key-configured and no-key branches. The existing ingest tests covering this must keep passing
  unmodified — that is the check that the extraction was behaviour-preserving.
- `getFingerprintCandidates`: returns mapped candidates for an indexed track; rejects with
  `BadRequestError` when no API key is configured.
- `applyFix` with `overwrite: true`: replaces a wrong artist and title; corrects a track number
  that disagrees with the recording's position on its release, which the default path skips;
  leaves existing cover art alone.
- `applyFix` default: the existing fill-only tests in `server/test/libraryFix.test.js` must keep
  passing unmodified.
- `writeMissingTags` unit level: overwrite writes changed fields and reports them in
  `filledFields`; a field already equal to the desired value is not reported.
- Route level (`server/test/routes/`): `GET /library/fingerprint-candidates/:trackId` returns
  candidates, and `POST /library/fix` honours `overwrite` in the body.
