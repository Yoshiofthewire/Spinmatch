import { useEffect, useRef, useState } from 'react';
import { listPlaylists, createPlaylist, addPlaylistItems } from '../api/playlists.js';
import ErrorBanner from './ErrorBanner.jsx';

// Takes bare artist/title/album so owned, unowned and search rows can all use it.
// An unresolved track is added as a gap.
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

  // Outside click or Escape closes; Escape returns focus to the trigger.
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
    // The menu is fixed to where the button was, so a page scroll or resize would
    // strand it. Scrolling inside the menu itself is fine.
    function onScroll(e) {
      if (!(e.target instanceof Node && boxRef.current?.contains(e.target))) setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
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
      // Likely a 409 duplicate name; the server owns that rule.
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
// Opens on the side with more room and never runs past the viewport: when the menu is
// taller than that room it scrolls inside itself (page scrolling would close it).
const MENU_ROOM = 320;
const GAP = 6;
const EDGE = 8;
export function menuPosition(trigger, viewportHeight = window.innerHeight) {
  if (!trigger) return null;
  const r = trigger.getBoundingClientRect();
  const right = window.innerWidth - r.right;
  const below = viewportHeight - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const down = below >= MENU_ROOM || below >= above;
  return {
    position: 'fixed',
    right,
    overflowY: 'auto',
    maxHeight: Math.max(down ? below : above, 0),
    ...(down
      ? { top: r.bottom + GAP, bottom: 'auto' }
      : { top: 'auto', bottom: viewportHeight - r.top + GAP }),
  };
}
