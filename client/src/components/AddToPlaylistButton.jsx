import { useEffect, useRef, useState } from 'react';
import { listPlaylists, createPlaylist, addPlaylistItems } from '../api/playlists.js';
import ErrorBanner from './ErrorBanner.jsx';

// A button any track row can drop in to send that one track to a playlist.
// Deliberately takes bare `artist`/`title`/`album` rather than a whole track
// object: the callers span owned rows (TracksTab), release tracklists that
// may not be owned yet (TrackList on the album page) and search results
// (SearchPage) — the one thing all of them can always supply.
//
// A track that doesn't resolve to a local file still gets added; it just
// lands in the playlist as a gap, the same as an unmatched paste line or an
// exhausted suggestion — PlaylistDetail already renders that case with a
// working Find-on-YouTube link, so there is nothing extra for this button to
// handle.
export default function AddToPlaylistButton({ artist, title, album }) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState(null); // null until first fetched
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [addedId, setAddedId] = useState(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState(null);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const triggerRef = useRef(null);

  // Closes like any menu: an outside click, or Escape (which hands focus back
  // to the trigger so keyboard users aren't dropped at the top of the page).
  useEffect(() => {
    if (!open) return undefined;
    function onOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    // The menu is fixed to where the button was, so a page scroll would strand it.
    function onScroll(e) {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  function loadPlaylists() {
    setListError(null);
    listPlaylists()
      .then((r) => setPlaylists(r.playlists))
      .catch((err) => setListError(err.message));
  }

  function toggle() {
    setError(null);
    setAddedId(null);
    if (!open && playlists === null) loadPlaylists();
    if (!open) setPos(menuPosition(triggerRef.current));
    setOpen(!open);
  }

  async function addTo(playlistId) {
    setBusyId(playlistId);
    setError(null);
    try {
      await addPlaylistItems(playlistId, [{ artist, title, album, source: 'manual' }]);
      setAddedId(playlistId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function submitNew(e) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createPlaylist(trimmed);
      setPlaylists((prev) => [{ id: created.id, name: created.name }, ...(prev ?? [])]);
      setNewName('');
      await addTo(created.id);
    } catch (err) {
      // Most likely a 409 on a duplicate name — the server owns that rule,
      // same as PlaylistsPage's own create form.
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <span className="add-to-playlist" ref={boxRef}>
      <button type="button" className="chip-button" onClick={toggle} aria-expanded={open} ref={triggerRef}>
        + Playlist
      </button>
      {open && (
        <div className="add-to-playlist-menu" style={pos}>
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          {playlists === null ? (
            listError
              ? <ErrorBanner message={listError} onRetry={loadPlaylists} />
              : <p className="muted">Loading…</p>
          ) : playlists.length === 0 ? (
            <p className="muted">No playlists yet.</p>
          ) : (
            <ul className="add-to-playlist-list">
              {playlists.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busyId === p.id}
                    onClick={() => addTo(p.id)}
                  >
                    {p.name}
                  </button>
                  {addedId === p.id && <span className="muted"> Added</span>}
                </li>
              ))}
            </ul>
          )}
          <form className="add-to-playlist-new" onSubmit={submitNew}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New playlist"
              aria-label="New playlist name"
            />
            <button type="submit" disabled={!newName.trim() || creating}>
              {creating ? 'Adding…' : 'Add'}
            </button>
          </form>
        </div>
      )}
    </span>
  );
}

// position: fixed escapes the table's overflow wrapper, which clipped an absolute menu.
// Opens upward when there isn't room below the button.
const MENU_ROOM = 320;
function menuPosition(trigger) {
  if (!trigger) return null;
  const r = trigger.getBoundingClientRect();
  const right = window.innerWidth - r.right;
  return r.bottom + MENU_ROOM > window.innerHeight && r.top > MENU_ROOM
    ? { position: 'fixed', right, top: 'auto', bottom: window.innerHeight - r.top + 6 }
    : { position: 'fixed', right, top: r.bottom + 6 };
}
