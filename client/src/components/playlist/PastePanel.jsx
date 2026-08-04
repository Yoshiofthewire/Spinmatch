import { useState } from 'react';
import { reconstructPlaylist } from '../../api/library.js';
import { addPlaylistItems } from '../../api/playlists.js';
import { formatDuration } from '../../lib/format.js';

// Playlist reconstruction, feeding a specific playlist rather than just
// showing you what you have: paste what you remember, then pull any of it in.
//
// Entirely offline — matched against the index, no upstream call — so unlike
// the rest of this app it answers instantly and keeps working when
// MusicBrainz doesn't. A miss can still be added: it lands in the playlist as
// a gap, the same shape a suggestion or a manual add takes when there is no
// file behind it yet, and PlaylistDetail already knows how to show that with
// a working Find-on-YouTube link.
export default function PastePanel({ playlistId, onAdded }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Which rows have already been sent, keyed by index within their own list —
  // found and missing are tracked separately so the two tables never collide.
  const [addedFound, setAddedFound] = useState(new Set());
  const [addedMissing, setAddedMissing] = useState(new Set());
  const [addingKey, setAddingKey] = useState(null); // `f${i}` | `m${i}` | 'all-found' | null
  const [addError, setAddError] = useState(null);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  async function submit(e) {
    e.preventDefault();
    if (lines.length === 0) return;
    setState('loading');
    setError(null);
    setAddedFound(new Set());
    setAddedMissing(new Set());
    setAddError(null);
    try {
      setData(await reconstructPlaylist(lines));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  async function addFound(i, track) {
    setAddingKey(`f${i}`);
    setAddError(null);
    try {
      await addPlaylistItems(playlistId, [{
        artist: track.artist, title: track.title, album: track.album, source: 'paste',
      }]);
      setAddedFound((prev) => new Set(prev).add(i));
      onAdded?.();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddingKey(null);
    }
  }

  async function addAllFound() {
    if (!data) return;
    const pending = data.found
      .map((f, i) => i)
      .filter((i) => !addedFound.has(i));
    if (!pending.length) return;
    setAddingKey('all-found');
    setAddError(null);
    try {
      await addPlaylistItems(playlistId, pending.map((i) => {
        const { track } = data.found[i];
        return { artist: track.artist, title: track.title, album: track.album, source: 'paste' };
      }));
      setAddedFound((prev) => new Set([...prev, ...pending]));
      onAdded?.();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddingKey(null);
    }
  }

  // A miss still carries a parsed artist/title from the server — the same
  // "Artist - Title" split `found` rows resolved against, just with nothing on
  // disk to show for it — so this needs no client-side re-parsing of the line.
  async function addMissing(i, m) {
    setAddingKey(`m${i}`);
    setAddError(null);
    try {
      await addPlaylistItems(playlistId, [{
        artist: m.artist, title: m.title, album: null, source: 'paste',
      }]);
      setAddedMissing((prev) => new Set(prev).add(i));
      onAdded?.();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddingKey(null);
    }
  }

  return (
    <div className="paste-panel">
      <p className="muted">
        One track per line, as <span className="mono">Artist - Title</span> or just the
        title. Matched against your library only — nothing is sent upstream.
      </p>

      <form onSubmit={submit}>
        <textarea
          className="playlist-input"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Radiohead - Idioteque\nPortishead - Roads\nMassive Attack - Teardrop'}
        />
        <div className="bulk-verify-actions">
          <button type="submit" disabled={lines.length === 0 || state === 'loading'}>
            {state === 'loading' ? 'Matching…' : `Match ${lines.length} line${lines.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>

      {state === 'error' && <p className="banner banner-error">{error.message}</p>}
      {addError && <p className="banner banner-error">{addError}</p>}

      {state === 'ready' && data && (
        <>
          <p className="muted">
            You have {data.found.length} of {data.found.length + data.missing.length}.
          </p>

          {data.found.length > 0 && (
            <>
              <div className="bulk-verify-actions">
                <button
                  type="button"
                  className="chip-button"
                  onClick={addAllFound}
                  disabled={addingKey === 'all-found' || data.found.every((_, i) => addedFound.has(i))}
                >
                  {addingKey === 'all-found' ? 'Adding…' : 'Add all found'}
                </button>
              </div>
              <table className="library-table">
                <thead>
                  <tr><th>Artist</th><th>Title</th><th>Album</th><th>Length</th><th aria-label="Add" /></tr>
                </thead>
                <tbody>
                  {/* Keyed on the index as well as the line: a playlist you're
                      rebuilding from memory routinely repeats a track, and a bare
                      line key made those duplicate React keys. */}
                  {data.found.map(({ line, track }, i) => (
                    <tr key={`${i}-${line}`}>
                      <td>{track.artist ?? <span className="muted">—</span>}</td>
                      <td>{track.title}</td>
                      <td className="muted">{track.album ?? '—'}</td>
                      <td className="mono">{formatDuration(track.durationMs)}</td>
                      <td>
                        <button
                          type="button"
                          className="chip-button"
                          disabled={addingKey === `f${i}` || addedFound.has(i)}
                          onClick={() => addFound(i, track)}
                        >
                          {addedFound.has(i) ? 'Added' : addingKey === `f${i}` ? 'Adding…' : 'Add'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {data.missing.length > 0 && (
            <>
              <h4>Not in your library</h4>
              <ul className="playlist-missing">
                {data.missing.map((m, i) => (
                  <li key={`${i}-${m.line}`} className="paste-missing-row">
                    <span>{m.line}</span>
                    <button
                      type="button"
                      className="chip-button"
                      disabled={addingKey === `m${i}` || addedMissing.has(i)}
                      onClick={() => addMissing(i, m)}
                    >
                      {addedMissing.has(i) ? 'Added' : addingKey === `m${i}` ? 'Adding…' : 'Add anyway'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
