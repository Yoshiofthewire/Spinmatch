import { useEffect, useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import SuggestPanel from './SuggestPanel.jsx';
import PastePanel from './PastePanel.jsx';
import { getLibraryTracks } from '../../api/library.js';
import { addPlaylistItems } from '../../api/playlists.js';
import { formatDuration } from '../../lib/format.js';

const TABS = [
  ['suggest', 'Suggest'],
  ['paste', 'Paste'],
  ['search', 'Library search'],
];

// The third tab: search what you already own and add a track directly, no
// review step needed because there is nothing to propose — you named it
// yourself. Small enough (25 results, no pagination) that it doesn't warrant
// its own file the way TracksTab does for the full library.
function LibrarySearchTab({ playlistId, onAdded }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);

  const [addedIds, setAddedIds] = useState(new Set());
  const [addingId, setAddingId] = useState(null);
  const [addError, setAddError] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setTracks([]);
      setState('idle');
      return undefined;
    }
    let cancelled = false;
    setState('loading');
    getLibraryTracks({ q: debounced, limit: 25 })
      .then((r) => {
        if (cancelled) return;
        setTracks(r.tracks);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => { cancelled = true; };
  }, [debounced]);

  async function add(track) {
    setAddingId(track.id);
    setAddError(null);
    try {
      await addPlaylistItems(playlistId, [{
        artist: track.artist, title: track.title, album: track.album, source: 'manual',
      }]);
      setAddedIds((prev) => new Set(prev).add(track.id));
      onAdded?.();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="library-search-tab">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your library…"
        aria-label="Search your library to add a track"
      />

      {state === 'error' && <p className="banner banner-error">{error}</p>}
      {addError && <p className="banner banner-error">{addError}</p>}
      {state === 'loading' && <EqualizerLoader label="Searching…" />}

      {state === 'ready' && (tracks.length === 0 ? (
        <p className="muted">No tracks match that search.</p>
      ) : (
        <table className="library-table">
          <thead>
            <tr><th>Artist</th><th>Title</th><th>Album</th><th>Length</th><th aria-label="Add" /></tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr key={t.id}>
                <td>{t.artist ?? <span className="muted">Unknown</span>}</td>
                <td>{t.title}</td>
                <td className="muted">{t.album ?? '—'}</td>
                <td className="mono">{formatDuration(t.durationMs)}</td>
                <td>
                  <button
                    type="button"
                    className="chip-button"
                    disabled={addingId === t.id || addedIds.has(t.id)}
                    onClick={() => add(t)}
                  >
                    {addedIds.has(t.id) ? 'Added' : addingId === t.id ? 'Adding…' : 'Add'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

// The three ways a playlist gains tracks, as tabs over one panel: propose from
// artists you own (SuggestPanel), recover a remembered list (PastePanel), or
// just search and add (LibrarySearchTab, above). `onAdded` is the one thing
// all three share — PlaylistDetail passes its own `load`, so any of the three
// writing an item is what makes the row appear.
export default function AddTracksPanel({ playlistId, onAdded }) {
  const [tab, setTab] = useState('suggest');

  return (
    <div className="add-tracks-panel gap-panel">
      <h3>Add tracks</h3>
      <nav className="library-tabs add-tracks-tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`library-tab${tab === key ? ' library-tab-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'suggest' && <SuggestPanel playlistId={playlistId} onAdded={onAdded} />}
      {tab === 'paste' && <PastePanel playlistId={playlistId} onAdded={onAdded} />}
      {tab === 'search' && <LibrarySearchTab playlistId={playlistId} onAdded={onAdded} />}
    </div>
  );
}
