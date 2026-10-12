import { get, post, patch, del } from './client.js';

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

export function getLibraryArtists({ sort, q, limit, offset } = {}) {
  return get(`/library/artists${qs({ sort, q, limit, offset })}`);
}

export function getLibraryAlbums({ artist, sort, q, limit, offset } = {}) {
  return get(`/library/albums${qs({ artist, sort, q, limit, offset })}`);
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

export function getScanStatus() {
  return get('/library/scan/status');
}

// verify=1 opts into the slow per-track YouTube lookup.
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

// Moves a duplicate into MUSIC_DIR/.spinmatch-trash; nothing is deleted.
export function trashDuplicate(trackId) {
  return post(`/library/track/${trackId}/trash`, {});
}

export function restoreDuplicate(trackId) {
  return post(`/library/track/${trackId}/restore`, {});
}

export function listTrash({ limit, offset } = {}) {
  return get(`/library/trash${qs({ limit, offset })}`);
}

export function restoreFromTrash(relPath) {
  return post('/library/trash/restore', { relPath });
}

export function getFixCandidates(trackId) {
  return get(`/library/fix-candidates/${trackId}`);
}

// Audio fingerprint (fpcalc + AcoustID): costly, explicit button only.
export function getFingerprintCandidates(trackId) {
  return get(`/library/fingerprint-candidates/${trackId}`);
}

// `overwrite`/`replaceCoverArt` replace existing tags/art, not just fill blanks.
// Fingerprint matches only.
export function applyFix({ trackId, recordingMbid, overwrite = false, replaceCoverArt = false }) {
  return post('/library/fix', { trackId, recordingMbid, overwrite, replaceCoverArt });
}

// Read-only preview. 'path' makes no upstream call; 'musicbrainz' makes two.
export function previewBulkFix({ artist, album, source }) {
  return post('/library/bulk-fix/preview', { artist, album, source });
}

// Only track ids travel: the server re-derives values, the browser never dictates them.
export function applyBulkFix({ artist, album, source, trackIds }) {
  return post('/library/bulk-fix/apply', { artist, album, source, trackIds });
}

// Hand-typed values: the browser does say what to write here.
// Absent or blank fields are left alone; editing never removes a tag.
// `expectedMtimeMs` (the loaded row's) makes the server 409 if the file changed since.
export function editTrackTags({ trackId, fields, expectedMtimeMs }) {
  return patch(`/library/track/${trackId}/tags`, { fields, expectedMtimeMs });
}

// `perTrack` is `[{trackId, fields}]`. Omitting `trackIds` means the whole album.
export function editAlbumTags({ artist, album, fields, perTrack, trackIds }) {
  return post('/library/album/tags', { artist, album, fields, perTrack, trackIds });
}

// Journaled tag writes, newest first.
export function listChanges({ limit, offset } = {}) {
  return get(`/library/changes${qs({ limit, offset })}`);
}

// Files changed since the write are skipped and come back in `conflicts`.
export function undoChange(batchId) {
  return post(`/library/changes/${batchId}/undo`, {});
}

// Names a gap row's track (one MusicBrainz resolve).
export function getMissingTrack({ artist, album, disc, position }) {
  return get(`/library/missing-track${qs({ artist, album, disc, position })}`);
}

export function rescanLibraryPart({ artist, album }) {
  return post('/library/rescan', { artist, album });
}

// Offline on the server; safe to call alongside a search.
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

// Otherwise a wrong automatic artist match is permanent.
export function unlinkArtist(artist) {
  return del(`/library/artist-link${qs({ artist })}`);
}

// These two walk the 1-req/s MusicBrainz queue: explicit action only, never on mount.
export function getSimilarArtists() {
  return get('/library/similar-artists');
}

export function getRecommendations() {
  return get('/library/recommendations');
}

// Offline: matched against the index, no upstream call.
export function reconstructPlaylist(lines) {
  return post('/library/reconstruct-playlist', { lines });
}

// SSE URLs, read by lib/eventStream.js.
export function artistMissingStreamUrl(artist) {
  return `/api/library/artist-missing/stream?artist=${encodeURIComponent(artist)}`;
}

export function coverUrl(trackId) {
  return `/api/library/cover/${trackId}`;
}

export function streamUrl(trackId) {
  return `/api/library/stream/${trackId}`;
}

export function missingStreamUrl(releaseGroupMbid) {
  return `/api/library/missing/stream${qs({ releaseGroup: releaseGroupMbid })}`;
}
