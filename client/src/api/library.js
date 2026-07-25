// client/src/api/library.js
import { get, post } from './client.js';

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
}

export function getLibraryStats() {
  return get('/library/stats');
}

export function getLibraryArtists({ sort } = {}) {
  return get(`/library/artists${qs({ sort })}`);
}

export function getLibraryAlbums({ artist, sort } = {}) {
  return get(`/library/albums${qs({ artist, sort })}`);
}

export function getLibraryTracks({ artist, album, q, sort, limit, offset } = {}) {
  return get(`/library/tracks${qs({ artist, album, q, sort, limit, offset })}`);
}

export function getAlbumTracks({ artist, album }) {
  return get(`/library/album-tracks${qs({ artist, album })}`);
}

export function scanLibrary() {
  return post('/library/scan', {});
}

// verify=1 opts into the slow per-track YouTube lookup; the default returns the
// missing tracklist immediately.
export function getAlbumGaps(releaseGroupMbid, { verify = false } = {}) {
  return get(`/library/missing${qs({ releaseGroup: releaseGroupMbid, verify: verify ? '1' : '' })}`);
}

export function getIncompleteAlbums() {
  return get('/library/incomplete');
}

export function getLibraryHealth() {
  return get('/library/health');
}

export function getHealthTracks({ issue, limit, offset } = {}) {
  return get(`/library/health-tracks${qs({ issue, limit, offset })}`);
}

export function getDuplicates() {
  return get('/library/duplicates');
}

export function getFixCandidates(trackId) {
  return get(`/library/fix-candidates/${trackId}`);
}

export function applyFix({ trackId, recordingMbid }) {
  return post('/library/fix', { trackId, recordingMbid });
}

// Rescans only one artist's or album's folders. The library-wide scan is
// scanLibrary() above.
export function rescanLibraryPart({ artist, album }) {
  return post('/library/rescan', { artist, album });
}

// Which of these MusicBrainz results are already in the library. Offline on the
// server, so this is safe to call alongside a search.
export function checkOwned({ albums, recordings }) {
  return post('/library/owned', { albums, recordings });
}

export function getAlbumGapsFromLibrary({ artist, album }) {
  return get(`/library/album-gaps${qs({ artist, album })}`);
}

export function getArtistDiscography(artist) {
  return get(`/library/discography${qs({ artist })}`);
}

export function linkArtist({ artist, mbArtistId }) {
  return post('/library/artist-link', { artist, mbArtistId });
}

// URL builders, not requests — these are used as <img src> / <audio src>, which
// the browser fetches directly rather than going through client.js.
export function coverUrl(trackId) {
  return `/api/library/cover/${trackId}`;
}

export function streamUrl(trackId) {
  return `/api/library/stream/${trackId}`;
}

// Consumed by EventSource, which fetches directly like the <img>/<audio> URLs
// above rather than going through client.js.
export function missingStreamUrl(releaseGroupMbid) {
  return `/api/library/missing/stream${qs({ releaseGroup: releaseGroupMbid })}`;
}
