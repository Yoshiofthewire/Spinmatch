# Album-scoped duplicate detection

**Date:** 2026-07-25

## Problem

The Duplicates tab groups tracks by folded `(artist, title)` and ignores album entirely
(`server/src/services/libraryRepo.js`, `duplicateGroups`). Any song that appears on more than one
release — an album track that also lands on a greatest-hits set, a soundtrack, or a compilation —
is reported as a duplicate. The Beatles' "Hey Jude" is on *Hey Jude*, *1967–1970*, and *1*; today
that is three "copies" of one song.

Those are not duplicates. They are three different records that happen to share a recording, and a
user who owns all three wants to keep all three. The view is currently noisy enough that its own
help text apologises for it ("Often legitimate — an album track that also appears on a
compilation"), which is an admission that the count means very little.

## Rule

Two tracks are duplicates when their folded **artist, album and title** all match. A song on two
different albums is not a duplicate and does not appear anywhere in the app.

What remains is the case worth acting on: the same track from the same release, indexed at more
than one path — a FLAC and a 128k MP3 of the same album, a folder copied twice, a re-rip left
alongside the original.

### Decisions

- **Cross-album matches are dropped outright.** Not relegated to a second list, not hidden behind a
  toggle. Both alternatives keep the same noise under a new name. If listing cross-album overlap
  turns out to be useful, it is a small addition later.
- **A null album is its own bucket**, so two album-less tracks with the same artist and title do
  group. `foldKey` already maps null to `''`, so this needs no special case. In practice the bucket
  is small: `libraryScanner.js` fills a missing album tag with the containing directory name
  (`album: meta.album ?? path.basename(path.dirname(filePath))`), so untagged files effectively
  group by folder — which reads correctly under this rule. Tracks that reach the table with a true
  null (via bulk fix or ingest) are the residual case. The ambiguity — two untagged rips that
  really came from different albums — is already surfaced separately by the `missingAlbum` health
  count, which gives the user a way to resolve it.
- **Album matching is exact** (case-folded, like artist and title). `Abbey Road` and
  `Abbey Road (2019 Remaster)` are different albums and will not group. Normalising edition
  suffixes was rejected: the suffix list is never complete, it is locale-dependent, and it wrongly
  merges records that are genuinely distinct (`Let It Be` vs `Let It Be... Naked`, `Alive` vs
  `Alive II`). Exact matching is predictable — a user can always see why two things did or did not
  group.

## Changes

### `server/src/services/libraryRepo.js`

`duplicateGroups()` keys on `foldKey(row.artist, row.album, row.title)` instead of
`foldKey(row.artist, row.title)`. That is the entire behavioural change.

The `WHERE` clause is unchanged: artist and title still must be non-null, album stays nullable.
There is no empty-string-versus-null split to guard against — `readField` in `tags.js` normalises
`''` to null before a row is ever written.

`findDuplicateGroups()` returns `{ artist, album, title, copies }`. Album is now a property of the
group rather than of each copy, so it belongs in the group. Its sort comparator gains an album
tiebreak between artist and title so ordering stays deterministic.

### `server/src/routes/library.js`

Unchanged. `GET /api/library/duplicates` passes the new shape straight through.

### `client/src/components/library/DuplicatesTab.jsx`

- The React key is `${group.artist}-${group.title}`, which would now collide between two
  same-titled groups on different albums. It gains album.
- The **Album** column moves from the per-copy table into the group header. Every copy in a group
  shares one album by construction, so as a column it repeats the same value on every row.
- The explanatory paragraph is now backwards — it tells the user that compilation overlap is the
  expected case, which is exactly what no longer appears. It is rewritten to say these are copies
  of the same track from the same release, and that a song shared across albums is not counted.
  The empty state ("No duplicate artist/title pairs found") gets the same correction.

The Health and Overview chips read `duplicateCount` from the same folding function, so they follow
automatically and stay consistent with the tab they link to.

### `README.md`

The Duplicates bullet (around line 175) gets the same rewording as the tab.

## Testing

Every existing duplicate test asserts the old behaviour directly — each pairs `album: 'Al'` with
`album: 'Other'` and expects a group:

- `server/test/libraryRepo.test.js` — `findHealthIssues counts missing tags and duplicate
  recordings`
- `server/test/libraryRepo.test.js` — `findDuplicateGroups returns every copy so they can be
  compared`
- `server/test/libraryRepo.test.js` — `findDuplicateGroups finds the copies for non-ASCII artists
  and titles`

Each is rewritten to use same-album fixtures, preserving what it was actually testing
(case-insensitive folding, non-ASCII folding, format and size comparison). The
non-ASCII regression test keeps its point: that test exists because grouping and re-querying once
used two different case-folding implementations, and it must keep proving the group comes back with
its copies in it.

New tests:

- The same artist and title on two different albums produces no group, and `duplicateCount` is 0.
  This is the requirement, stated directly.
- Two tracks with the same artist and title and a null album on both do group.
- A group's `album` is present in the `findDuplicateGroups` result, since the tab now renders it
  from there.

`server/test/routes/library.test.js` — `GET /api/library/duplicates returns each copy of a
duplicated title` — needs no fixture correction: its two seeded tracks have different titles, so it
only ever asserted an empty result and keeps passing either way. It is extended to seed a genuine
same-album duplicate and assert the response shape, including `album`, so the endpoint's contract
is covered rather than just its empty case.

## Out of scope

Album-name normalisation, a separate cross-album listing, a toggle to include cross-album matches,
and any change to how duplicates are resolved — Spinmatch still never deletes a file.
