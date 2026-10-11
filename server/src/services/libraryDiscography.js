import {
  searchArtists, browseReleaseGroupsByArtist, searchReleaseGroups,
  resolvePrimaryReleaseForGroup, getReleaseWithTracks,
} from './musicbrainz.js';
import { luceneQuoted } from '../lib/lucene.js';
import { detectAlbumGaps } from './libraryGaps.js';
import { getDb } from '../lib/db.js';
import { listArtistAlbums, artistExists } from './libraryRepo.js';
import { primaryArtist } from '../lib/artistCredit.js';
import { normalizeTitle } from '../lib/normalize.js';
import { NotFoundError } from '../lib/httpErrors.js';
import { config } from '../config.js';

// Fuzzy artist-search score to auto-accept; below it the user picks.
const AUTO_ACCEPT_SCORE = config.matching.artistAutoAcceptScore;
// Re-check unconfirmed resolutions weekly: MusicBrainz or local tags may change.
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getArtistLink(db, artist) {
  return db.prepare(
    'SELECT artist, mb_artist_id AS mbArtistId, confirmed, checked_at AS checkedAt '
    + 'FROM library_artist_links WHERE artist = ? COLLATE NOCASE'
  ).get(artist) ?? null;
}

// Forgets a resolution so a wrong guess can be redone.
export function deleteArtistLink(db, artist) {
  return db.prepare('DELETE FROM library_artist_links WHERE artist = ? COLLATE NOCASE')
    .run(artist).changes > 0;
}

export function saveArtistLink(db, { artist, mbArtistId, confirmed = 0 }) {
  db.prepare(`
    INSERT INTO library_artist_links (artist, mb_artist_id, confirmed, checked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(artist) DO UPDATE SET
      mb_artist_id = excluded.mb_artist_id,
      confirmed = excluded.confirmed,
      checked_at = excluded.checked_at
  `).run(artist, mbArtistId, confirmed, Date.now());
}

// Returns `{ mbArtistId, cached }`, or `{ mbArtistId: null, candidates, cached }`
// where empty candidates means no match and several means ambiguous.
export async function resolveArtist(artist, { db = getDb(), allowCreditFallback = true } = {}) {
  const cached = getArtistLink(db, artist);
  // User-confirmed links are permanent; app guesses expire like misses.
  if (cached?.mbArtistId
      && (cached.confirmed || Date.now() - cached.checkedAt < NEGATIVE_TTL_MS)) {
    return { mbArtistId: cached.mbArtistId, cached: true };
  }
  if (cached && !cached.mbArtistId && Date.now() - cached.checkedAt < NEGATIVE_TTL_MS) {
    return { mbArtistId: null, candidates: [], cached: true };
  }

  const artists = await searchArtists(`artist:"${luceneQuoted(artist)}"`);
  const exact = artists.filter((a) => normalizeTitle(a.name) === normalizeTitle(artist));
  const best = exact[0] ?? artists[0];

  if (best && best.score >= AUTO_ACCEPT_SCORE && exact.length <= 1) {
    saveArtistLink(db, { artist, mbArtistId: best.mbid, confirmed: 0 });
    return { mbArtistId: best.mbid, cached: false };
  }

  // Joined credits ("Justice & Thundercat") fall back to the primary artist;
  // only on failure, so "She & Him" is never split.
  const viaCredit = allowCreditFallback ? await resolveViaCredit(artist, db) : null;
  if (viaCredit) return viaCredit;

  if (!best) {
    saveArtistLink(db, { artist, mbArtistId: null, confirmed: 0 });
    return { mbArtistId: null, candidates: [], cached: false };
  }
  return { mbArtistId: null, candidates: artists.slice(0, 8), cached: false };
}

// Only when the primary artist is itself in the library: MusicBrainz has exact
// artists "Florence" and "Earth", so a bare name match would link the wrong act.
async function resolveViaCredit(artist, db) {
  const primary = primaryArtist(artist);
  if (!primary || !artistExists(db, primary)) return null;

  const resolved = await resolveArtist(primary, { db, allowCreditFallback: false });
  if (!resolved.mbArtistId) return null;

  saveArtistLink(db, { artist, mbArtistId: resolved.mbArtistId, confirmed: 0 });
  return { mbArtistId: resolved.mbArtistId, cached: false, via: primary };
}

// normalizeTitle makes "Album (Deluxe Edition)" count as owning "Album".
export async function getArtistDiscography(artist, { db = getDb() } = {}) {
  const owned = listArtistAlbums(db, artist);
  if (!owned.length) throw new NotFoundError(`No local albums found for artist "${artist}"`);

  const resolution = await resolveArtist(artist, { db });
  if (!resolution.mbArtistId) {
    return {
      artist,
      mbArtistId: null,
      candidates: resolution.candidates ?? [],
      owned: owned.map((album) => ({ album, mbid: null })),
      missing: [],
      unresolved: true,
    };
  }

  const { albums } = await browseReleaseGroupsByArtist(resolution.mbArtistId);
  const ownedNormalized = new Map(owned.map((album) => [normalizeTitle(album), album]));

  const ownedOut = [];
  const missing = [];
  for (const release of albums) {
    const localMatch = ownedNormalized.get(normalizeTitle(release.title));
    const entry = {
      mbid: release.mbid,
      title: release.title,
      year: release.firstReleaseDate ? Number(release.firstReleaseDate.slice(0, 4)) : null,
      coverArtUrl: release.coverArtUrl,
    };
    if (localMatch) ownedOut.push({ ...entry, album: localMatch });
    else missing.push(entry);
  }

  // Local albums MusicBrainz doesn't list (live, bootlegs, mistagged).
  const matchedLocal = new Set(ownedOut.map((o) => o.album));
  const unmatchedLocal = owned.filter((album) => !matchedLocal.has(album));

  return {
    artist,
    mbArtistId: resolution.mbArtistId,
    // The primary artist this resolved through, if any; shown in the UI.
    via: resolution.via ?? null,
    owned: ownedOut,
    missing,
    unmatchedLocal,
    unresolved: false,
  };
}

// --- Per-album gap check -----------------------------------------------------

export function getAlbumLink(db, { artist, album }) {
  return db.prepare(
    'SELECT release_group_mbid AS releaseGroupMbid, confirmed, checked_at AS checkedAt '
    + 'FROM library_album_links WHERE artist = ? COLLATE NOCASE AND album = ? COLLATE NOCASE'
  ).get(artist ?? '', album) ?? null;
}

export function saveAlbumLink(db, { artist, album, releaseGroupMbid, confirmed = 0 }) {
  db.prepare(`
    INSERT INTO library_album_links (artist, album, release_group_mbid, confirmed, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(artist, album) DO UPDATE SET
      release_group_mbid = excluded.release_group_mbid,
      confirmed = excluded.confirmed,
      checked_at = excluded.checked_at
  `).run(artist ?? '', album, releaseGroupMbid, confirmed, Date.now());
}

// Caches hits and misses like resolveArtist.
export async function resolveAlbum(artist, album, { db = getDb() } = {}) {
  const cached = getAlbumLink(db, { artist, album });
  if (cached?.releaseGroupMbid) return { releaseGroupMbid: cached.releaseGroupMbid, cached: true };
  if (cached && !cached.releaseGroupMbid && Date.now() - cached.checkedAt < NEGATIVE_TTL_MS) {
    return { releaseGroupMbid: null, cached: true };
  }

  const query = artist
    ? `releasegroup:"${luceneQuoted(album)}" AND artist:"${luceneQuoted(artist)}"`
    : `releasegroup:"${luceneQuoted(album)}"`;
  const results = await searchReleaseGroups(query);

  // Exact normalized title only: a loose top hit reports the wrong album's tracks as missing.
  const target = normalizeTitle(album);
  const match = results.find((rg) => normalizeTitle(rg.title) === target) ?? null;

  saveAlbumLink(db, { artist, album, releaseGroupMbid: match?.mbid ?? null });
  return { releaseGroupMbid: match?.mbid ?? null, cached: false };
}

// Names the track at a local gap's (disc, position) so it can be searched for.
// Returns `{resolved: false, reason}` rather than throwing. Not in libraryGaps (import cycle).
export async function resolveMissingTrack(artist, album, { disc = 1, position, db = getDb() } = {}) {
  const { releaseGroupMbid } = await resolveAlbum(artist, album, { db });
  if (!releaseGroupMbid) return { resolved: false, reason: 'unresolved_album' };

  const releaseMbid = await resolvePrimaryReleaseForGroup(releaseGroupMbid);
  if (!releaseMbid) return { resolved: false, reason: 'no_release', releaseGroupMbid };

  const { release, tracks } = await getReleaseWithTracks(releaseMbid);
  // Single-disc releases may have no disc number upstream.
  const match = tracks.find((t) => t.position === position && (t.discNumber ?? 1) === disc);
  if (!match) {
    // Usually a wrong track number on a file you have, not a missing file.
    return {
      resolved: false, reason: 'no_such_position', trackCount: tracks.length, releaseGroupMbid,
    };
  }

  return {
    resolved: true,
    // Track credit first, so compilations don't say "Various Artists".
    artist: match.artist || release.artist || null,
    title: match.title,
    album: release.title,
    lengthMs: match.lengthMs,
    recordingMbid: match.recordingMbid,
    position,
    disc,
    releaseGroupMbid,
  };
}

// Catches what numbering can't: 1..10 owned, but 12 tracks upstream.
export async function checkAlbumAgainstMusicBrainz(artist, album, { db = getDb() } = {}) {
  const { releaseGroupMbid } = await resolveAlbum(artist, album, { db });
  if (!releaseGroupMbid) {
    return { artist, album, releaseGroupMbid: null, unresolved: true, owned: [], missing: [] };
  }
  // No verify: one rate-limited yt-dlp call per track; the client verifies individually.
  const gaps = await detectAlbumGaps(releaseGroupMbid, {
    verify: false, localArtist: artist, localAlbum: album,
  });
  return { artist, album, releaseGroupMbid, unresolved: false, ...gaps };
}
