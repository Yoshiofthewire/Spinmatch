# Client test harness

## Setup choices

**Runner: Vitest.** The client already builds with Vite 6; Vitest 4.1.10 shares
its config and transform pipeline instead of adding a second bundler
(Jest/Babel) to the toolchain. Vitest 4.x's peer range is `vite ^6.0.0 || ^7.0.0
|| ^8.0.0`, so it's compatible with the pinned `vite ^6.0.5` without touching
that version.

**Config location: `client/vite.config.js`, not a separate `vitest.config.js`.**
The file is four lines of plugin/proxy config plus a `test` block now — small
enough that a second file would only add indirection. The import changed from
`vite`'s `defineConfig` to `vitest/config`'s, which re-exports the same
function typed to also accept `test`; `vite build`/`vite dev` read the file
exactly as before. `test.environment: 'jsdom'`, `test.setupFiles:
['./src/test/setup.js']`, `test.globals: false` (tests import `describe`/
`it`/`expect` from `'vitest'` explicitly, matching the server suite's plain
`node:test` imports rather than adding ambient globals).

**Setup file:** `client/src/test/setup.js` imports
`@testing-library/jest-dom/vitest`, which registers matchers like
`toHaveClass`/`toBeInTheDocument` on Vitest's `expect`.

**Scripts:** `test` (`vitest`, watch mode for local dev) and `test:run`
(`vitest run`, single pass — used by CI and by `npm test` at the repo root if
that's ever extended to the client).

**Mocking fetch, not the `api/` modules.** `client/src/api/client.js` is the
only module allowed to call `fetch` and it's where the 409 error shaping
happens: `error.code` from `body.error.code`, `error.details` from everything
else on `body.error` (so `existing: { fileCount, exportedAt }` survives), and
`lib/eventStream.js`'s `openFailed()` does the equivalent for the SSE
pre-check. Mocking `api/playlists.js` directly would have required *asserting*
that shaping is correct without ever exercising it — exactly backwards for a
test whose whole point is the 409 path. `client/src/test/fetchMock.js` stubs
`global.fetch` with an ordered route table (`{ method, test(url), respond()
}`), and every test asserts against the actual recorded `{ url, method, body
}` of each call, not just the resulting UI state. `sseResponse()` builds a
real SSE-framed string; the platform's `Response` wraps a string body in a
`ReadableStream` on its own, so `lib/eventStream.js`'s reader loop runs
unmodified against it.

**`ConfigContext` is stubbed via `vi.mock`, not exercised for real.**
`PlaylistDetail`'s "Export to player" button only exists when
`useConfig().playlistExportEnabled` is true, but the config value itself
comes from `ConfigProvider`'s own `GET /config` call, which is `ConfigContext`'s
concern, not `PlaylistDetail`'s. Mocking the hook's return value keeps the
Replace-gate tests about the gate.

## What was tested, in priority order

1. **`PlaylistDetail.jsx` drop-off Replace gate** (3 tests) — the 409 renders
   as `banner-rate-limited` (not `banner-error`) and surfaces `fileCount` and
   `exportedAt`; clicking Replace re-requests with `replace=1` in the URL;
   and, asserting on the full recorded call list rather than just the end
   state, **no request ever carries `replace=1` before the Replace button is
   clicked**, including when the user cancels instead.

2. **`SuggestPanel.jsx`** (8 tests) — proposals arrive with every checkbox
   ticked and only ticked rows appear in the `POST /items` body; the posted
   `source` is `submittedMethod` (the method that produced the results), not
   the live radio, verified by flipping Popular→Chance *after* results
   render and checking the post still says `popular`; `popularity:
   'unavailable'` renders with class `banner-note` (asserted via
   `toHaveClass`, not just text) and explicitly not `banner-error`;
   `popularity: 'unused'` renders no ListenBrainz text at all; each of the
   four `stopped` values (`cap`, `budget`, `exhausted`, `target`) produces
   its own distinct sentence, via `it.each`.

3. **`AddToPlaylistButton.jsx`** (3 tests) — posts `source: 'manual'`; the
   zero-playlists case shows "No playlists yet." *and* the create-and-add
   form still works in one action; two instances rendered side by side don't
   leak `open`/`addedId` state into each other (verified via
   `aria-expanded` on the untouched instance and a count of exactly one
   "Added" label).

4. **`PastePanel.jsx`** (2 tests) — a found line posts `source: 'paste'` with
   the matched track's fields; a missing line posts `source: 'paste'` with
   the server-parsed `artist`/`title` and `album: null`.

**16 tests, 4 files, all passing.**

### Deliberately not tested

- `SeedPicker`'s debounce timing itself (only that typing + picking a match
  produces a usable seed) — the 250ms `setTimeout` is exercised incidentally
  via real timers in every `SuggestPanel` test, not asserted on directly.
- `PastePanel`'s "Add all found" bulk button and `AddTracksPanel`'s tab
  switching — same `addPlaylistItems` call shape as the per-row buttons
  already covered, and switching tabs isn't a network-affecting or
  data-integrity concern.
- `LibrarySearchTab` (inside `AddTracksPanel`) — a thin wrapper over
  `getLibraryTracks`/`addPlaylistItems` with no review step or gate; lower
  risk than the four components above and out of the priority list given.
- `m3u` export's own confirm/replace flow in `PlaylistDetail` — same
  `replace` pattern as drop-off, sharing the same `client.js` error path
  already proven by the drop-off tests; not repeated to avoid a second copy
  of the same assertion shape.
- Anything server-side (684 existing tests untouched) and anything requiring
  a real browser (no drag-and-drop, no visual regression) — out of scope for
  a jsdom + Testing Library harness.

## What failed, and what it revealed

Nothing. Every test in this batch passed on first run against the
already-shipped component code — no bending of tests or components was
needed. That is itself worth noting given the brief's warning that "several
'obvious' fixes in this project turned out to rest on false premises": the
`submittedMethod` guard in `SuggestPanel.jsx` and the 409-not-a-failure
handling in `PlaylistDetail.jsx` both worked exactly as their surrounding
comments describe. The tests exist now so a future edit that breaks either
one fails loudly instead of shipping.

## Dependencies added (client workspace only, devDependencies)

- `vitest@4.1.10`
- `@testing-library/react@16.3.2`
- `@testing-library/user-event@14.6.3`
- `@testing-library/jest-dom@7.0.0`
- `jsdom@30.0.1`

No server dependency changed. `npm ci` from the repo root was verified against
a clean copy of the tree (outside the working checkout) and installs the
client workspace correctly, including `vitest` in `node_modules/.bin`.

## CI

Added one step, "Run client tests" (`npm run test:run -w client`), between
"Run server tests" and "Build the client" in the existing `test` job — same
job, same order semantics, no matrix, Node version untouched. Placed before
the build so a component that lies about what it requests fails on its own
step rather than being indistinguishable from a compile error. Renamed the
job's display name from "Server tests and client build" to "Server tests,
client tests, and client build" so the GitHub UI reflects what actually
runs; no steps were reordered or restructured otherwise.

## Verification run (all green)

- `client && npm run test:run` — 4 files, 16 tests, 16 passed.
- `client && npm run build` — clean, 103 modules transformed.
- `server && npm test` — 684 passed, 0 failed.
- `npm ci` from repo root, in an isolated copy of the tree — succeeds, and
  `npm run test:run -w client` passes from that fresh install too.
