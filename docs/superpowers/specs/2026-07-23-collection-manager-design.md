# Spinmatch Collection Manager

> **Status:** Designed, not started. To be implemented after a token/session refresh.

## Motivation

Spinmatch today is a per-session verification utility: you search MusicBrainz, verify YouTube
links by duration, and optionally ingest local files. It has no persistent knowledge of what the
user already owns. For music enthusiasts — the target audience — the highest-value missing
capability is turning Spinmatch into a **personal music library manager** that knows their
collection and helps them act on it.

The concrete needs that drove this design:

- "I have an album missing tracks — tell me which ones I'm missing."
- "I want to recreate a playlist — find what I have and what's missing."
- "Search my existing collection."
- "Suggest new artists based on what I own."

The unifying insight: the user's music directory (`MUSIC_DIR`) is the source of truth for what
they have. Once Spinmatch maintains a persistent index of that library, gap detection, discovery,
and playlist reconstruction all follow naturally as contextual features on top of it.

## Scope

**In scope:**
- Persistent library index built from `MUSIC_DIR`, stored in SQLite mounted outside the container.
- Startup + adaptive background scanning, plus filesystem change detection.
- Library dashboard (browse/search collection, verification status).
- Album gap detection (own vs. missing, with YouTube links for gaps).
- Discovery: artist similarity and track-based recommendations.
- Playlist reconstruction (match against library + surface gaps).

**Out of scope (this design):**
- **MeTube integration is dropped.** The existing `SendToMeTubeButton` / `METUBE_URL` wiring is
  not part of the collection-manager feature set and should not be extended. (Removal of existing
  MeTube code is a separate decision, not required by this design.)
- Downloading/ripping audio — Spinmatch continues to only find and verify links.

**Future consideration:**
- **Navidrome integration** — stream the verified library through a Navidrome instance. Noted as a
  future expansion point; not designed here.

## Data model

A SQLite database persisted via a Docker volume at `/data/library.db` (mounted outside the
container so it survives restarts and redeploys). Three core entities:

- `local_tracks` — `(id, path, artist, album, title, duration, file_hash, modified_at)`
  Files discovered on disk. `file_hash` + `modified_at` drive incremental rescans and change
  detection.
- `verified_tracks` — `(local_track_id, mb_recording_id, youtube_url, confidence, verified_at)`
  The subset of local tracks matched to a MusicBrainz recording + YouTube link, carrying the
  verification confidence.
- `collection_stats` — `(total_tracks, total_albums, total_artists, last_scan_at,
  collection_size_bytes)`
  Cached summary for the dashboard and for choosing scan frequency.

Files deleted outside the tool are marked removed in the index (audit trail), not hard-deleted
from the DB.

## Library indexing & sync

**Startup:** on container start, perform a full scan of `MUSIC_DIR`, build/update `local_tracks`,
and mark missing files as removed.

**Adaptive background refresh:** frequency scales with collection size to avoid thrashing large
libraries. Starting heuristic (tune during implementation):

| Collection size | Refresh interval |
|---|---|
| < 1,000 tracks | 30 minutes |
| 1,000–10,000 tracks | 2 hours |
| > 10,000 tracks | 4+ hours |

Background refresh only reprocesses changed files (via `file_hash` + `modified_at`).

**Change detection:** watch `MUSIC_DIR` for filesystem events (add / delete / move) and trigger an
immediate partial rescan when changes originate outside the tool, so the index does not go stale
between scheduled refreshes.

## Feature set

### Phase 1 — Foundation (MVP)

1. **Library Dashboard** — collection stats (total tracks / albums / artists), browse by artist or
   album, verification status at a glance, sync status.
2. **Album Gap Detection** — search MusicBrainz for an album → compare against the collection →
   show owned (✓) vs. missing (✗) tracks, with verified YouTube links for the gaps.

### Phase 2 — Discovery

3. **Artist Similarity** — "artists similar to ones in my collection," via MusicBrainz artist
   relationships.
4. **Track-Based Recommendations** — suggestions derived from the user's verified tracks.
5. **Playlist Reconstruction** — search a playlist or type remembered track names → best matches in
   the library + missing pieces with YouTube links.

Discovery is its own flow, deliberately separate from gap detection.

## Architecture

**Backend (Node.js / Express), under `server/src/`:**
- `services/libraryManager.js` — scans `MUSIC_DIR`, maintains the SQLite index, handles sync logic.
- `services/librarySync.js` — adaptive background scheduler + filesystem watcher.
- Update `routes/verify.js` — when a track is verified, record it in `verified_tracks` and refresh
  stats.
- New routes:
  - `GET /library/stats`
  - `GET /library/artists`
  - `GET /library/albums` (optional `?artist=`)
  - `GET /library/tracks` (optional `?album=`)
  - `POST /library/scan` (manual rescan trigger)
  - `GET /library/missing` (given a MusicBrainz release ID → missing tracks + YouTube links)
  - `GET /library/similar-artists`
  - `GET /library/recommendations`
  - `GET /library/reconstruct-playlist`

**Frontend (React / Vite), under `client/src/`:**
- `pages/LibraryPage.jsx` — dashboard: stats, recent verifications, sync status.
- `components/GapDetectionPanel.jsx` — album search + missing-track display.
- `components/DiscoveryPanel.jsx` — similar artists + recommendations.
- `components/PlaylistReconstructionPanel.jsx` — playlist search + gap detection.
- Update `pages/SearchPage.jsx` — library context: "in your collection" badges, missing counts.

**Reuse existing services** where they already exist: MusicBrainz client, `verifyTrack.js`,
`durationMatch.js`, tagging/organize services. This design adds the persistent-index layer and
library-aware routes/UI on top; it does not re-implement verification.

## Verification flow integration

When a track is verified via YouTube:
1. Find/match the local file in the library index.
2. Insert/update the row in `verified_tracks` (MusicBrainz ID + YouTube link + confidence).
3. Refresh `collection_stats`.
4. Gap detection and recommendations then reflect it as verified.

## Deployment

Docker:
- Mount music read-only: `-v /path/to/music:/music:ro`, with `MUSIC_DIR=/music`.
- Mount the database volume: `-v spinmatch-db:/data` (DB at `/data/library.db`).
- Existing env vars still apply: `MB_CONTACT_EMAIL`, `YTDLP_PATH`, `PORT`.
- Update `unraid-template.xml` and compose/docs to add the DB volume mount.

## Error handling & resilience

- **Scan interruptions** (permissions, corrupt files): resume on the next background refresh; don't
  fail the whole scan on one bad file.
- **Missing files:** mark removed in the index, don't hard-delete (audit trail).
- **Verification staleness:** if a YouTube link goes dead, flag it in the UI but keep the record so
  the user can re-verify.

## Testing

- **Unit:** library scanning (mock filesystem), gap detection (mock MusicBrainz), recommendation
  logic. Follow the existing backend test approach (Node built-in runner + MockAgent; see the
  `npm test` Node 24 caveat in project memory — use
  `node --experimental-test-module-mocks --test`).
- **Integration:** full scan → verify track → assert database state.
- **Manual / scale:** validate against 100, 1k, and 10k-track libraries to confirm sync-frequency
  scaling and that scans don't spike memory/CPU or block the UI.

## Pre-implementation verification checklist

- [ ] SQLite schema normalized and efficient for frequent dashboard queries.
- [ ] Background sync never blocks the UI or causes request timeouts.
- [ ] File change detection works across filesystems (ext4, NTFS, macOS).
- [ ] Large-library scans (10k+) complete without memory/CPU spikes.
- [ ] All routes handle edge cases (empty library, malformed files).
- [ ] Discovery surfaces meaningful suggestions, not random noise.
