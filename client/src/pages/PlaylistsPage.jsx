import { useTitle } from '../lib/useTitle.js';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import PlaylistDetail from '../components/playlist/PlaylistDetail.jsx';
import ImportM3uForm from '../components/playlist/ImportM3uForm.jsx';
import PlayerBar from '../components/library/PlayerBar.jsx';
import { listPlaylists, createPlaylist } from '../api/playlists.js';
import { formatBytes } from '../lib/format.js';

// Open playlist lives in the query string so Back steps out of it.
export default function PlaylistsPage() {
  useTitle('Playlists');
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');

  const [playlists, setPlaylists] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [playing, setPlaying] = useState(null); // { track, queue }
  const [imported, setImported] = useState(null); // last import's result, shown on its playlist

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
    // List view only; PlaylistDetail loads its own.
    if (!selectedId) load();
  }, [selectedId, load]);

  function openPlaylist(id) {
    setParams({ id: String(id) });
  }

  function backToList() {
    setImported(null);
    setParams({});
  }

  function onImported(result) {
    setImported(result);
    openPlaylist(result.playlist.id);
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
          {imported?.playlist.id === Number(selectedId) && (
            <div className="banner banner-success">
              Imported {imported.added} track{imported.added === 1 ? '' : 's'}
              {imported.gaps > 0 && `, ${imported.gaps} not in your library`}.
              {imported.truncated && ' The file had more entries than one import takes; the rest were skipped.'}
            </div>
          )}
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
          <ImportM3uForm onImported={onImported} />

          {error && <ErrorBanner message={error} onRetry={load} />}
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
                      <Link className="link-button" to={`?id=${p.id}`}>
                        {p.name}
                      </Link>
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
