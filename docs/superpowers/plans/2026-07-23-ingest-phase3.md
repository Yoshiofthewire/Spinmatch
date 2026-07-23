# Ingest Phase 3 — UX/progress polish

> Builds on merged Phase 2 (`main` @ `9e62e0d`): the ingest pipeline already identifies,
> tags-in-place, and moves confirmed files into `MUSIC_DIR` (loose + album, disc-aware).
> Phase 3 is lighter-weight UX polish on top — nothing here changes the identification or
> move logic. TDD per task; run tests with `node --experimental-test-module-mocks --test`
> from `server/` (bare discovery — `node --test test/` hits the known env quirk).

## Context

Phase 2 shipped the destructive move pipeline but the UX around it is blunt: the only control
is a single "Process" button that runs the whole folder for real, blocks until done, and shows
results in one shot. There's no way to see what *would* happen before committing, and successful
ingests aren't recorded in the app's History (unlike verify/MeTube actions). Phase 3 adds:

1. **Dry-run preview** — see the planned tag fills and target paths without writing anything.
2. **History integration** — log each ingested track like other actions.
3. *(Optional)* **Live per-item progress** — stream results as each file finishes instead of
   one blocking response.

**Honest caveat that shaped the design:** a preview still performs every network call
(fingerprint → AcoustID → MusicBrainz) — it only skips the local tag-write and move. So Preview
saves you from touching files prematurely, *not* from the wait. Task 15 (streaming) is what
addresses the wait.

## Constraints / reuse

- Feature stays gated (`ingestEnabled()`); routes 404 when unconfigured. No new deps.
- Reuse `organize.targetPathFor` (already pure/exported) for the "would move to" path — do **not**
  reach into the filesystem during a preview (no collision probing; show the intended path).
- History is the existing best-effort localStorage store: `lib/history.js#addEntry({track,
  artist, album, action})` + `HistoryPage.jsx#actionLabel`. No server-side history exists; keep it
  client-side.
- No automated frontend suite exists (per the original plan) — client tasks are build-check +
  documented manual verification. Server tasks are full TDD.

---

## Task 14 — Dry-run preview + history

### 14.1 — Server: `dryRun` mode for `processIngest`

**Files:** modify `server/src/services/ingest.js`, `server/src/services/tags.js`,
`server/src/routes/ingest.js`, `server/test/ingest.test.js`, `server/test/tags.test.js`.

- Add a pure helper to `tags.js`, exported and unit-tested:
  ```js
  export function plannedFills(current, desired) {
    return Object.keys(desired).filter((k) => desired[k] != null && current[k] == null);
  }
  ```
  This mirrors `writeMissingTags`'s fill rule without touching the file, for previews.
- Thread an options arg through: `processIngest({ dryRun = false } = {})` →
  `processLooseFile(item, { dryRun })` / `processAlbumFolder(item, { dryRun })`. Introduce two
  small internal seams both branches share:
  - `applyOrPreviewTags(filePath, desired, coverImage, dryRun)` → returns `{ filledFields }`.
    Real: `writeMissingTags(...)`. Preview: `readTags(filePath)` then `plannedFills(current,
    desired)` (plus `'coverArt'` when `coverImage && !current.hasCoverArt`). Nothing written.
  - `moveOrPreview(filePath, name, moveMeta, dryRun)` → real: existing `moveFileSafely`. Preview:
    `{ movedTo: targetPathFor(moveMeta, path.extname(filePath).toLowerCase()) }`, no fs call.
- `matched` entries gain nothing new in shape; in preview they simply carry the *planned*
  `filledFields` and `movedTo`. Add a top-level `dryRun: true` flag to the `processIngest` return
  so the client can label the run. Album all-or-nothing/coherence logic is unchanged (preview
  still refuses incoherent folders — it just wouldn't have moved them anyway).
- Route: `POST /api/ingest/process` reads `const { dryRun = false } = req.body || {}` and passes
  it through. (Confirm `express.json()` is mounted in `app.js`; the existing handler already
  receives a JSON body.)

**Tests (extend `ingest.test.js`):** a dry-run of a confirmed loose file returns the planned
`filledFields` + a `movedTo` from `targetPathFor`, with **`writeMissingTags` and `moveIntoLibrary`
never called** (assert via a spy flag on the mocks — have them throw/record if invoked); a
dry-run album preview reports each track's planned fills without writing; `result.dryRun === true`.
Plus a `tags.test.js` unit test for `plannedFills` (fills only null-current/non-null-desired keys).

**Commit:** `Add dry-run preview mode to the ingest pipeline`.

### 14.2 — Client: Preview button + "Moved to" column

**Files:** modify `client/src/components/IngestPanel.jsx` (+ `client/src/styles/index.css` only if
needed).

- Add a **Preview** button beside Process: `post('/ingest/process', { dryRun: true })`. Track
  whether the current `result` came from a preview (`result.dryRun`).
- When previewing, show a banner ("Preview — no files were changed") and label columns as
  intent ("Would fill" / "Would move to"); on a real run they read "Fields filled" / "Moved to".
- Add a **Moved to** column to the matched table bound to `m.movedTo` (Phase 2 populates it;
  today's UI drops it).
- Disable both buttons while `state === 'running'`.

**Verify:** `npm run build -w client` clean; manual — Preview shows planned changes and the
ingest folder is untouched afterward; Process then actually moves/tags.

**Commit:** `Add ingest Preview (dry-run) and Moved-to column to the Ingest page`.

### 14.3 — Client: log ingests to History

**Files:** modify `client/src/components/IngestPanel.jsx`, `client/src/lib/history.js` (none — reuse),
`client/src/pages/HistoryPage.jsx`.

- After a **real** (non-preview) process resolves, for each `result.matched` entry call
  `addEntry({ track: m.title, artist: m.artist, album: m.album, action: 'ingested' })`. Never log
  preview runs.
- `HistoryPage.jsx#actionLabel`: add `action === 'ingested' → 'Ingested'`.

**Verify:** `npm run build -w client` clean; manual — a real ingest run adds "Ingested" rows to
History; a Preview run adds none.

**Commit:** `Log ingested tracks to History`.

---

## Task 15 (optional) — Live per-item progress via SSE

*Pick up only if real batches feel slow in practice (the original plan's own guidance). Albums
multiply MusicBrainz calls behind a ~1 req/s limiter, so a large folder can block for tens of
seconds; this is the fix for the wait that Preview doesn't address.*

**Files:** modify `server/src/services/ingest.js`, `server/src/routes/ingest.js`,
`client/src/components/IngestPanel.jsx`, plus tests.

- Give `processIngest` an optional `onItem(entry)` callback invoked as each item finishes
  (`{ kind: 'matched'|'needsReview', ...entry }`); the collecting POST path passes no callback and
  behaves exactly as now (keeps 14.1 intact and testable without SSE).
- Add `GET /api/ingest/process-stream` (SSE; `dryRun` via `?dryRun=1`): set the event-stream
  headers, wire `onItem` to `res.write('data: ' + JSON.stringify(evt) + '\n\n')`, emit a final
  `done` summary event, and map a mid-run `RateLimitedError`/error to an `error` event. EventSource
  is GET-only, which is why this is a separate GET endpoint rather than the POST.
- Client: use `EventSource`, appending rows live and showing an "N of M processed" counter;
  fall back to the blocking POST if `EventSource` is unavailable.
- Tests: unit-test that `processIngest` calls `onItem` once per item in order (mock leaves as in
  the existing suite); a thin route test that the stream emits one `data:` frame per item and a
  terminal `done`.

**Commit:** `Stream ingest progress over SSE`.

---

## Open decision

- **Phase 3 scope:** Task 14 only (preview + history), or 14 **and** 15 (streaming)?
  *Recommend 14 now, then decide on 15 after seeing real batch sizes* — 15 is a meaningful
  refactor (callback seam + SSE route + EventSource client) whose payoff depends entirely on
  whether the blocking wait actually bothers you.

## Verification (whole phase)

- `cd server && node --experimental-test-module-mocks --test` — all existing tests plus the new
  dry-run / `plannedFills` (and, if built, `onItem`/stream) tests green.
- `npm run build -w client` clean.
- Manual e2e (real `ACOUSTID_API_KEY`): **Preview** a folder → see planned fills + target paths,
  confirm `INGEST_DIR`/`MUSIC_DIR` unchanged. **Process** the same folder → files tagged + moved,
  History shows "Ingested" rows. (If 15 is built: rows stream in one-by-one with a live counter.)
