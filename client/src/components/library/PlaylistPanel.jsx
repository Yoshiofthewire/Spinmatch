import { useState } from 'react';
import { reconstructPlaylist } from '../../api/library.js';
import { formatDuration } from '../../lib/format.js';

// Playlist reconstruction: paste what you remember, see what you already have
// and what you'd need to find.
//
// Entirely offline — matched against the index, no upstream call — so unlike the
// rest of this tab it answers instantly and keeps working when MusicBrainz
// doesn't. The misses hand off to the existing verify flow, which is the same
// route every other gap in the app takes.
export default function PlaylistPanel({ onPlay }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  async function submit(e) {
    e.preventDefault();
    if (lines.length === 0) return;
    setState('loading');
    setError(null);
    try {
      setData(await reconstructPlaylist(lines));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  return (
    <div className="gap-panel">
      <h3>Rebuild a playlist</h3>
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

      {state === 'ready' && data && (
        <>
          <p className="muted">
            You have {data.found.length} of {data.found.length + data.missing.length}.
          </p>

          {data.found.length > 0 && (
            <table className="library-table">
              <thead>
                <tr><th /><th>Artist</th><th>Title</th><th>Album</th><th>Length</th></tr>
              </thead>
              <tbody>
                {/* Keyed on the index as well as the line: a playlist you're
                    rebuilding from memory routinely repeats a track, and a bare
                    line key made those duplicate React keys. */}
                {data.found.map(({ line, track }, i) => (
                  <tr key={`${i}-${line}`}>
                    <td>
                      <button
                        type="button"
                        className="play-button"
                        aria-label={`Play ${track.title}`}
                        onClick={() => onPlay?.(track, data.found.map((f) => f.track))}
                      >
                        ▶
                      </button>
                    </td>
                    <td>{track.artist ?? <span className="muted">—</span>}</td>
                    <td>{track.title}</td>
                    <td className="muted">{track.album ?? '—'}</td>
                    <td className="mono">{formatDuration(track.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.missing.length > 0 && (
            <>
              <h4>Not in your library</h4>
              <ul className="playlist-missing">
                {data.missing.map((m, i) => <li key={`${i}-${m.line}`}>{m.line}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
