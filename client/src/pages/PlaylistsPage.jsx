import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import PlaylistDetail from '../components/playlist/PlaylistDetail.jsx';
import PlayerBar from '../components/library/PlayerBar.jsx';
import { listPlaylists, createPlaylist } from '../api/playlists.js';
import { formatBytes } from '../lib/format.js';

// Which playlist is open lives in the query string, not component state —
// the same reason LibraryPage keeps its tab/artist/album there: it's what
// makes the browser Back button step out of a playlist instead of leaving
// the page entirely.
export default function PlaylistsPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');

  const [playlists, setPlaylists] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [playing, setPlaying] = useState(null); // { track, queue }

  const load = useCallback(async () => {
    setError(null);
    try {
      const { playlists: list } = await listPlaylists();
      setPlaylists(list);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, []);

  useEffect(() => {
    // Only the list view needs this data; skip it while a playlist is open so
    // going back and forth doesn't refetch on every click into the detail
    // view (PlaylistDetail loads its own copy).
    if (!selectedId) load();
  }, [selectedId, load]);

  function openPlaylist(id) {
    setParams({ id: String(id) });
  }

  function backToList() {
    setParams({});
  }

  async function submitCreate(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createPlaylist(trimmed);
      setName('');
      openPlaylist(created.id);
    } catch (err) {
      // Most likely a 409 on a duplicate name — the server owns that rule.
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className={`library-page${playing ? ' library-page-playing' : ''}`}>
      <h1>Playlists</h1>

      {selectedId ? (
        <>
          <div className="library-back">
            <button type="button" className="link-button" onClick={backToList}>
              ← Back to playlists
            </button>
          </div>
          <PlaylistDetail
            id={Number(selectedId)}
            onPlay={(track, queue) => setPlaying({ track, queue })}
            onDeleted={backToList}
          />
        </>
      ) : (
        <>
          <form className="playlist-create-form" onSubmit={submitCreate}>
            <input
              type="text"
              placeholder="New playlist name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="New playlist name"
            />
            <button type="submit" disabled={!name.trim() || creating}>
              {creating ? 'Creating…' : 'Create playlist'}
            </button>
          </form>
          {createError && <p className="banner banner-error">{createError}</p>}

          {error && <p className="banner banner-error">{error}</p>}
          {state === 'loading' && <EqualizerLoader label="Loading playlists…" />}

          {state === 'ready' && (playlists.length === 0 ? (
            <p className="muted">No playlists yet — create one above.</p>
          ) : (
            <table className="library-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Tracks</th>
                  <th>Gaps</th>
                  <th>Size</th>
                  <th>Last exported</th>
                </tr>
              </thead>
              <tbody>
                {playlists.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button type="button" className="link-button" onClick={() => openPlaylist(p.id)}>
                        {p.name}
                      </button>
                    </td>
                    <td className="mono">{p.itemCount}</td>
                    <td className="mono">{p.gapCount > 0 ? p.gapCount : <span className="muted">0</span>}</td>
                    <td className="mono">{formatBytes(p.totalBytes)}</td>
                    <td className="muted">
                      {p.lastExportedAt ? new Date(p.lastExportedAt).toLocaleString() : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}

      {playing && (
        <PlayerBar
          track={playing.track}
          queue={playing.queue}
          onChange={(track) => track && setPlaying({ track, queue: playing.queue })}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
