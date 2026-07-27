# Moving a duplicate aside

**Date:** 2026-07-27

## Problem

The Duplicates tab finds real redundancy — the same track from the same release at more than one
path — and then leaves the user with a list of full paths and nothing to do with them. Acting on
the list means leaving the browser, opening a file manager against a network share, and retyping or
copying paths one at a time. The view identifies the work and then declines to help with it.

The reason it declines is a deliberate constraint: **Spinmatch never deletes a file.** That
guarantee is stated twice in `README.md` (lines 133 and 226), on the Duplicates page itself
(`DuplicatesTab.jsx:43`), and as a global constraint in
`docs/superpowers/plans/2026-07-25-album-scoped-duplicates.md:21` — *"The Duplicates view stays
read-only. Do not add a delete button."*

The constraint is right. Deletion is the only operation in this app with no undo, and the Duplicates
view is the worst possible place for it: if the `dup_key` grouping is ever wrong about what counts
as a copy, a delete button turns a tagging mistake into lost music.

## Rule

Spinmatch can **move a copy aside** into a trash folder. It still never deletes a file.

The guarantee narrows rather than retires. Every byte the user had, they still have; what changes is
where one of the copies lives. Reclaiming the space stays a deliberate act the user performs
themselves, against a folder whose contents they can see and check first.

This supersedes `2026-07-25-album-scoped-duplicates-design.md:119` and the plan constraint above on
the question of a delete button. Those documents are historical records of a decision and are not
edited.

### Decisions

- **The trash is `MUSIC_DIR/.spinmatch-trash/`.** Same filesystem as the library, so every move is an
  instant `rename()` regardless of file size — which is what makes this usable at all against a
  network mount holding 100MB lossless files. It also means the move frees no space, which is the
  point: the user cleans up now and reclaims later, having had a chance to change their mind. The
  dot prefix is load-bearing: `walk()` in `libraryScanner.js:50` skips any entry whose name starts
  with `.`, so the trash is invisible to the index with no exclusion logic to write, and invisible
  to Navidrome and Jellyfin for the same reason.

  Rejected: a configurable `TRASH_DIR`. Pointing it at another volume makes every move an `EXDEV`
  byte copy across the network — slow, and able to fail halfway on a full disk. The flexibility
  mostly buys a way to make the feature worse.

- **Spinmatch never empties the trash.** There is no "Empty trash" button, now or later, because
  that button *is* deletion with one indirection. The user frees space with their file manager or
  `rm -rf`. This is what keeps the README sentence honest rather than lawyerly.

  A read-only Trash view — listing what is aside, with sizes, a reclaimable total, and per-file
  Restore, but no empty — is a reasonable later addition. It is out of scope here; build it once
  there is evidence of how this gets used.

- **The trash mirrors the library layout.** `Music/Nick Cave/Tender Prey/01 - The Mercy Seat.flac`
  becomes `Music/.spinmatch-trash/Nick Cave/Tender Prey/01 - The Mercy Seat.flac`. The path is a
  track's identity in this app — `local_tracks` is keyed on it — so restoring is the same move with
  its two arguments swapped, and a person reading the folder in a file manager can act on it without
  instructions. Relative paths are unique within `MUSIC_DIR`, so collisions are near-impossible; the
  residual case takes a ` (2)` suffix, the way ingest already handles it.

  Rejected: dated batch folders (`.spinmatch-trash/2026-07-27/…`) and flattened mangled filenames.
  The first complicates restore to enable curation nobody asked for; the second makes
  restore-by-hand a puzzle.

- **The server refuses to move aside the last live copy of a group.** Checked against the index at
  request time, not in the browser, because the stale-tab case is exactly where the client's idea of
  how many copies exist is the thing that is wrong. This is the sentence that makes the feature
  defensible: *Spinmatch will never move aside your last copy of a track.* "It's recoverable from
  the trash anyway" is true and insufficient — the value here is that a user does not have to notice
  a mistake in order to be protected from it, and a silently emptied group is precisely the mistake
  nobody notices for months.

- **Empty directories left behind are left behind.** Moving the only file out of
  `Artist/Album/` leaves the folder there. Pruning empty directories is a separate behaviour with
  its own failure modes (how far up do you climb? what about a folder holding only cover art?), and
  the next scan ignores them.

- **Undo is a session affordance, not a guarantee.** The button exists for as long as the page is
  open, because a reloaded Duplicates view fetches only live rows and a trashed row is no longer one
  of them. The endpoint outlives the page — it works while the `removed = 1` row survives — but
  `purgeRemoved` eventually deletes those rows, after which recovery is a file-manager move,
  trivial because of the mirrored layout. The README says this plainly rather than implying Undo is
  permanent.

## Changes

### `server/src/lib/moveFile.js` (new)

`organize.js:113-140` holds the move primitive this needs verbatim: `rename()`, and on `EXDEV` a
copy to a `.partial` followed by a rename over the destination and an unlink of the source, cleaning
up both the partial and the placeholder on any failure. It is the subtle, already-proven part, and
it should exist once.

- `moveOnto(src, claimedDest)` — the extracted logic, unchanged in behaviour.
- `claimFreeName(destPath)` — opens `wx` to reserve a name, suffixing ` (2)`, ` (3)`… on `EEXIST`,
  bounded like the ingest loop. Reserving before renaming is what stops a rename silently destroying
  a file that appeared in the gap; see the comment at `organize.js:71-76` for the incident this
  guards against.

`claimDestination` stays in `organize.js`. Its "an identical file is already there, so leave the
source alone" behaviour is an ingest idea and would be wrong here: a user who clicks *Move aside*
and is told the job is done while the file sits untouched in their library has been lied to.

### `server/src/services/organize.js`

`moveIntoLibrary` calls `moveOnto` instead of carrying its own copy of the rename/`EXDEV` block.
No behavioural change; `organize.test.js` passing unchanged is the regression proof.

### `server/src/services/duplicateTrash.js` (new)

- `trashPathFor(filePath)` — pure and synchronous. Maps a library path to its mirror under
  `.spinmatch-trash`, taking the relative part against `path.resolve(config.ingest.musicDir)`.

  Lexically resolved, **not** realpath-resolved. `assertInsideMusicDir` and `reindexFile` already
  compare against the lexically resolved root, so the rest of the app has long assumed
  `MUSIC_DIR` is not itself a symlink; using realpath here would agree with
  `assertReadableInsideMusicDir` and disagree with the two functions this feature actually calls.
  If the assumption is ever violated, `path.relative` produces a `../` prefix, the derived
  destination escapes the root, and the `assertInsideMusicDir(dest)` in the next step turns it into
  a 400 — which is the correct outcome rather than a silent write outside the library.
- `trashDuplicate({ trackId, db })`:
  1. `getTrackById` → `NotFoundError` if it is gone.
  2. `liveCopyCount(db, track.dup_key) < 2` → `ConflictError`. Before any filesystem call.
  3. `assertReadableInsideMusicDir(track.path)` → `real`. Symlink-safe containment, the same guard
     the cover, stream and repair routes use.
  4. `dest = trashPathFor(real)`, then `assertInsideMusicDir(dest)` as defence in depth.
  5. `mkdir` the destination directory, `claimFreeName(dest)`.
  6. `withFileLock(real, …)` around `moveOnto`. A tag write and a move racing on one file is the
     collision that matters, and `tagEdit` and `libraryBulkFix` already take that lock.
  7. `noteWrite(real)` so the recursive `fs.watch` does not debounce a full library rescan out of the
     app's own move. `recentWrites` is keyed on basename and the mirror preserves the basename, so
     one call covers both the disappearance and the appearance — the suffixed-collision case notes
     both names.
  8. `reindexFile(real)` — it stats, finds nothing, and marks the row removed inside a transaction
     with `recomputeStats`. Exactly the path `libraryScanner.js:249-256` was written for; no new
     index code.
  9. Returns `{ trackId, trashedPath, remainingCopies }`, where `remainingCopies` is the live count
     *after* the move, so the client can render the group header without a refetch. The path
     returned is the one actually claimed, which differs from the derived one in the suffixed
     case. The absolute path is returned
     rather than logged, unlike elsewhere in the app: this view already shows full paths by design,
     and the user is going to go and look at that folder.
- `restoreDuplicate({ trackId, db })`: `getRemovedTrackById` → derive the trash path from the stored
  original path → claim the original path **exactly** (plain `wx`, no suffixing) → `moveOnto` back →
  `noteWrite` → `reindexFile(original)`, which re-reads the tags and restores the row. If the
  original path is occupied, `ConflictError` and the trash copy stays put. Restoring to
  `Title (2).flac` would quietly manufacture a new duplicate, which is a comic failure mode for this
  particular feature.

**Failure ordering is the safety property.** Guards and containment checks run before any
filesystem call; the index is updated only after `moveOnto` returns. A failed move leaves both the
file and the index exactly as they were, with no phantom `removed = 1` row pointing at a file still
sitting in the library.

### `server/src/services/libraryRepo.js`

Two additions, both small:

- `getRemovedTrackById(db, id)` — the `removed = 1` sibling of `getTrackById`, which filters
  `removed = 0` (line 366) and so cannot find a row Undo needs.
- `liveCopyCount(db, dupKey)` — `COUNT(*)` over `removed = 0 AND dup_key = ?`. Counted over the same
  `dup_key` the view groups by, so the guard and the list on screen can never disagree about what a
  group contains.

### `server/src/lib/httpErrors.js`

Add `ConflictError` (409, code `CONFLICT`) alongside the existing four. `errorHandler` maps on
`err.status`, so nothing else changes.

### `server/src/lib/writeLoop.js`

Unchanged. Parameterising `describeFailure` was the original intent, but its messages read "could
not be **written to**" and a move needs a different verb in every branch, so the parameter would
have to be the whole phrase rather than a label — at which point the shared function is a lookup
table with extra steps. It also has no `ENOSPC` case, which a move needs and a tag write does not.

`duplicateTrash.js` carries its own eight-entry `MOVE_FAILURES` table instead, mapping the
filesystem error codes worth naming to messages written for a move. Two short tables, each honest
about its own operation, beat one shared table that is wrong for half its callers.

### `server/src/routes/library.js`

`POST /track/:id/trash` and `POST /track/:id/restore`, both already behind the `gate` applied to
`/api/library` in `app.js:78`. Thin: parse and validate the id, delegate, `next(err)`.

| Case | Response |
|---|---|
| Unknown or already-removed track id | 404 `NOT_FOUND` |
| Last live copy in the group | 409 `CONFLICT` |
| Undo when the original path is occupied | 409 `CONFLICT` |
| Path outside `MUSIC_DIR`, or unreadable | 400, from the existing containment guards |
| `EACCES` / `EROFS` (read-only music mount) | plain-language message via `describeFailure`, path logged not returned |
| Anything else | 500, generic message, full error to the server log |

### `client/src/api/library.js`

`trashDuplicate(trackId)` and `restoreDuplicate(trackId)`, following the existing helpers.

### `client/src/components/library/DuplicatesTab.jsx`

- A **Move aside** button in a new last column of each copy's row.
- On success the row stays, struck through, reading *Moved to `.spinmatch-trash/…`* with an **Undo**
  beside it. It does not vanish: a row that disappears the instant it is clicked offers nothing to
  undo and no confirmation of what happened. Its play button is disabled — the file is no longer at
  that path.
- The group header count drops (`3 copies` → `2 copies`). When one live copy remains, its button is
  disabled with a title explaining why — the client mirroring the server guard, not substituting
  for it.
- Failures render in the existing `banner banner-error` style *inside* the affected group, so one
  group's error does not blank the page.
- The comment at line 17 and the on-page copy at line 43 both currently state that this button does
  not exist. Both are rewritten.

New styles go in `client/src/styles/index.css` following existing naming (`.tag-edit-destructive` is
the precedent).

### `README.md`

The Duplicates bullet (line 226) is rewritten: Spinmatch can move a copy aside into
`MUSIC_DIR/.spinmatch-trash`, the trash mirrors the library layout, nothing is deleted, Undo is
available while the page is open, and reclaiming the space is something the user does themselves
against that folder.

Line 133 is left alone. It sits in the ingest section, and "Spinmatch never deletes a file" is still
literally true after this change.

## Testing

`server/test/duplicateTrash.test.js`, in the house style: `node:test`, `openDb(':memory:')`, real
files in a temp directory, and `readTags` mocked through `--experimental-test-module-mocks` — the
trick `libraryFix.test.js:32` already uses so no real audio file is needed.

1. Moves the file to the mirrored path under `.spinmatch-trash` and marks the row removed.
2. Refuses the last live copy, and the file is still where it was afterwards. This is the
   requirement, stated directly.
3. Refuses a path outside `MUSIC_DIR`.
4. A name collision in the trash takes a ` (2)` suffix instead of overwriting.
5. Undo puts the file back at its original path and re-indexes the row.
6. Undo refuses when something occupies the original path, and the trash copy is still there.
7. A failed move leaves the index untouched — no phantom removed row.
8. `.spinmatch-trash` is invisible to a scan. This pins the dot-skip in `walk()` as something the
   feature now *depends* on rather than incidentally benefits from.

`server/test/routes/library.test.js` gains coverage of the two endpoints' status codes, including
the 409s.

`server/test/organize.test.js` must pass unchanged. That is the regression proof for touching the
ingest write path.

The client has no test runner and this change does not add one. Verification is `npm run build` plus
a described visual check: move a copy aside, confirm the count drops and the row goes struck
through, click Undo, confirm the file and the row come back.

## Out of scope

A Trash view (listing, sizes, reclaimable total, Restore from outside the session), an "Empty trash"
button, pruning the empty directories a move leaves behind, bulk "move aside every copy but the
best one", any automatic choice of which copy is the keeper, and a configurable trash location.

Spinmatch still never deletes a file.
