import { searchArtists, browseReleaseGroupsByArtist, searchReleaseGroups } from './musicbrainz.js';
import { luceneQuoted } from '../lib/lucene.js';
import { detectAlbumGaps } from './libraryGaps.js';
import { getDb } from '../lib/db.js';
import { listArtistAlbums, artistExists } from './libraryRepo.js';
import { primaryArtist } from '../lib/artistCredit.js';
import { normalizeTitle } from '../lib/normalize.js';
import { NotFoundError } from '../lib/httpErrors.js';
import { config } from '../config.js';

// A local artist name has to be turned into a MusicBrainz artist id before its
// discography can be fetched, and that resolution is a fuzzy search. Anything at
// or above this score is taken automatically; below it the caller is asked to
// pick, because guessing wrong produces a wildly wrong "missing albums" list.
const AUTO_ACCEPT_SCORE = config.matching.artistAutoAcceptScore;
// Re-check a remembered "no match" after a week — the artist may since have
// been added to MusicBrainz, or the local tags may have been fixed.
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getArtistLink(db, artist) {
  return db.prepare(
    'SELECT artist, mb_artist_id AS mbArtistId, confirmed, checked_at AS checkedAt '
    + 'FROM library_artist_links WHERE artist = ? COLLATE NOCASE'
  ).get(artist) ?? null;
}

// Forgets a remembered resolution so it can be looked up again. A wrong
// auto-accepted guess used to be permanent: positives had no TTL, `confirmed` was
// written but never read, and there was no way to clear one short of opening the
// database by hand.
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

/**
 * Resolves a local artist name to a MusicBrainz id, caching both hits and misses.
 *
 * Exactly one of two outcomes, discriminated by `mbArtistId`:
 *  - settled:  `{ mbArtistId: string, cached: boolean }`
 *  - unsettled: `{ mbArtistId: null, candidates: Array<{mbid, name, disambiguation, score}>, cached: boolean }`
 *
 * `candidates` is empty when nothing matched at all, and populated when several
 * plausible artists matched and guessing would produce a wrong discography.
 *
 * @param {string} artist
 * @param {{db?: object}} [options]
 * @returns {Promise<{mbArtistId: string|null, candidates?: object[], cached: boolean}>}
 */
export async function resolveArtist(artist, { db = getDb(), allowCreditFallback = true } = {}) {
  const cached = getArtistLink(db, artist);
  // A choice the user made explicitly is kept indefinitely. A guess the app made
  // for itself is re-checked on the same cycle as a remembered miss, because a
  // wrong guess produces a wildly wrong "missing albums" list and nothing else
  // would ever revisit it.
  if (cached?.mbArtistId
      && (cached.confirmed || Date.now() - cached.checkedAt < NEGATIVE_TTL_MS)) {
    return { mbArtistId: cached.mbArtistId, cached: true };
  }
  if (cached && !cached.mbArtistId && Date.now() - cached.checkedAt < NEGATIVE_TTL_MS) {
    // Remembered negative: don't re-search on every visit.
    return { mbArtistId: null, candidates: [], cached: true };
  }

  const artists = await searchArtists(`artist:"${luceneQuoted(artist)}"`);
  const exact = artists.filter((a) => normalizeTitle(a.name) === normalizeTitle(artist));
  const best = exact[0] ?? artists[0];

  if (best && best.score >= AUTO_ACCEPT_SCORE && exact.length <= 1) {
    saveArtistLink(db, { artist, mbArtistId: best.mbid, confirmed: 0 });
    return { mbArtistId: best.mbid, cached: false };
  }

  // The whole string didn't settle. Before giving up, try its primary artist —
  // a quarter of a real library is rows like "Justice & Thundercat" or
  // "Nine Inch Nails / Stephen Morris and Gillian Gilbert", which resolve to
  // nothing while the artist they lead with is one you own hundreds of tracks
  // by. Reached only on failure, so a name that resolves whole ("She & Him")
  // never gets split.
  const viaCredit = allowCreditFallback ? await resolveViaCredit(artist, db) : null;
  if (viaCredit) return viaCredit;

  if (!best) {
    saveArtistLink(db, { artist, mbArtistId: null, confirmed: 0 });
    return { mbArtistId: null, candidates: [], cached: false };
  }
  // Ambiguous: hand the choice back rather than guessing.
  return { mbArtistId: null, candidates: artists.slice(0, 8), cached: false };
}

// Resolves a joined credit through its primary artist, but only when that artist
// is separately present in the collection.
//
// That ownership check is the entire safety argument, and it is not theoretical:
// MusicBrainz has exact artists named "Florence", "Earth" and "Wind", so
// splitting "Florence + The Machine" or "Earth, Wind & Fire" and trusting a name
// match would link the wrong act with full confidence. Requiring the segment to
// be something already on disk makes the fallback self-validating — it can only
// ever recognise an artist the user demonstrably has.
//
// Recurses once (allowCreditFallback: false) so the primary's own resolution
// reuses the normal cache; for an owned artist that is usually already a cache
// hit and costs no upstream call at all.
async function resolveViaCredit(artist, db) {
  const primary = primaryArtist(artist);
  if (!primary || !artistExists(db, primary)) return null;

  const resolved = await resolveArtist(primary, { db, allowCreditFallback: false });
  if (!resolved.mbArtistId) return null;

  // Remembered against the ORIGINAL string, so the split is paid for once.
  saveArtistLink(db, { artist, mbArtistId: resolved.mbArtistId, confirmed: 0 });
  // `via` lets the UI say which artist this was matched through rather than
  // presenting a discography that appears to come from nowhere.
  return { mbArtistId: resolved.mbArtistId, cached: false, via: primary };
}

// Diffs a MusicBrainz studio-album discography against what's on disk.
// Ownership is decided with normalizeTitle so "Album (Deluxe Edition)" counts as
// owning "Album", the same folding gap detection already uses for track titles.
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

  // Albums on disk that MusicBrainz's studio-album list doesn't mention at all
  // (live records, bootlegs, mistagged folders). Surfaced rather than hidden so
  // the numbers add up from the user's point of view.
  const matchedLocal = new Set(ownedOut.map((o) => o.album));
  const unmatchedLocal = owned.filter((album) => !matchedLocal.has(album));

  return {
    artist,
    mbArtistId: resolution.mbArtistId,
    // Set when the name only resolved through its primary artist, e.g.
    // "Nine Inch Nails / Stephen Morris..." matched via "Nine Inch Nails". The
    // UI shows it, because a discography that silently belongs to a different
    // name than the one you clicked looks like a bug.
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

// Resolves a local album to a MusicBrainz release group, caching the answer
// (including a remembered miss) the same way artist resolution does.
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

  // Require the title to actually match after normalization: MusicBrainz always
  // returns *something*, and a loose top hit would produce a tracklist from the
  // wrong album — which would then be reported as missing tracks.
  const target = normalizeTitle(album);
  const match = results.find((rg) => normalizeTitle(rg.title) === target) ?? null;

  saveAlbumLink(db, { artist, album, releaseGroupMbid: match?.mbid ?? null });
  return { releaseGroupMbid: match?.mbid ?? null, cached: false };
}

// Checks one owned album against its MusicBrainz tracklist. This catches what
// the offline track-number check cannot: an album whose numbering looks
// complete (1..10) but which actually has 12 tracks upstream.
export async function checkAlbumAgainstMusicBrainz(artist, album, { db = getDb() } = {}) {
  const { releaseGroupMbid } = await resolveAlbum(artist, album, { db });
  if (!releaseGroupMbid) {
    return { artist, album, releaseGroupMbid: null, unresolved: true, owned: [], missing: [] };
  }
  // verify:false — the YouTube lookup is one rate-limited yt-dlp call per
  // missing track, far too slow for a panel. The client verifies individually.
  // The local artist/album are passed through so ownership is judged against the
  // album actually on disk rather than against MusicBrainz's joined artist credit.
  const gaps = await detectAlbumGaps(releaseGroupMbid, {
    verify: false, localArtist: artist, localAlbum: album,
  });
  return { artist, album, releaseGroupMbid, unresolved: false, ...gaps };
}
