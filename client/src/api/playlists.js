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

// `replace` is the second step of the same confirmation the drop-off export
// uses: without it, a file already at the target path comes back as a 409
// rather than being overwritten.
export function exportM3u(id, { replace = false } = {}) {
  return post(`/playlists/${id}/export/m3u`, { replace });
}

// A GET because every SSE route in this app is one (see routes/playlists.js);
// the caller opens the stream itself via lib/eventStream.js. Exposed as a URL
// rather than a fetch so the 409 pre-check and the stream can share one path.
export function dropoffUrl(id, { replace = false } = {}) {
  return `/api/playlists/${id}/export/dropoff${replace ? '?replace=1' : ''}`;
}
