// client/src/api/library.js
import { get, post } from './client.js';

export function getLibraryStats() {
  return get('/library/stats');
}

export function getLibraryArtists() {
  return get('/library/artists');
}

export function getLibraryAlbums(artist) {
  const q = artist ? `?artist=${encodeURIComponent(artist)}` : '';
  return get(`/library/albums${q}`);
}

export function getLibraryTracks({ artist, album } = {}) {
  const params = new URLSearchParams();
  if (artist) params.set('artist', artist);
  if (album) params.set('album', album);
  const q = params.toString();
  return get(`/library/tracks${q ? `?${q}` : ''}`);
}

export function scanLibrary() {
  return post('/library/scan', {});
}

export function getAlbumGaps(releaseGroupMbid) {
  return get(`/library/missing?releaseGroup=${encodeURIComponent(releaseGroupMbid)}`);
}
