import { get, post, patch, del } from './client.js';

export function listPlaylists() {
  return get('/playlists');
}

export function createPlaylist(name) {
  return post('/playlists', { name });
}

export function getPlaylist(id) {
  return get(`/playlists/${id}`);
}

export function renamePlaylist(id, name) {
  return patch(`/playlists/${id}`, { name });
}

export function deletePlaylist(id) {
  return del(`/playlists/${id}`);
}

export function addPlaylistItems(id, items) {
  return post(`/playlists/${id}/items`, { items });
}

export function removePlaylistItem(id, itemId) {
  return del(`/playlists/${id}/items/${itemId}`);
}

export function reorderPlaylist(id, itemIds) {
  return patch(`/playlists/${id}/order`, { itemIds });
}

// Returns proposals and writes nothing — the review step lives on the client.
export function suggestPlaylistTracks(id, options) {
  return post(`/playlists/${id}/suggest`, options);
}

export function exportM3u(id) {
  return post(`/playlists/${id}/export/m3u`, {});
}

// A GET because EventSource only does GET; the caller opens the stream itself
// via lib/eventStream.js. Exposed as a URL rather than a fetch so the 409
// pre-check and the stream can share one path.
export function dropoffUrl(id, { replace = false } = {}) {
  return `/api/playlists/${id}/export/dropoff${replace ? '?replace=1' : ''}`;
}
