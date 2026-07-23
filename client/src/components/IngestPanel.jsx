import { useState } from 'react';
import { get, post } from '../api/client.js';
import { addEntry } from '../lib/history.js';
import EqualizerLoader from './EqualizerLoader.jsx';

export default function IngestPanel() {
  const [items, setItems] = useState(null);
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleScan() {
    setError(null);
    setResult(null);
    try {
      const data = await get('/ingest/scan');
      setItems(data.items);
    } catch (err) {
      setError(err);
    }
  }

  async function runProcess({ dryRun }) {
    setState('running');
    setError(null);
    try {
      const data = await post('/ingest/process', { dryRun });
      setResult(data);
      setState(data.error ? 'error' : 'done');
      if (data.error) setError(data.error);
      // Log only real ingests, never previews.
      if (!dryRun) {
        for (const m of data.matched) {
          addEntry({ track: m.title, artist: m.artist, album: m.album, action: 'ingested' });
        }
      }
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  const isPreview = result?.dryRun === true;

  return (
    <div className="bulk-verify-panel">
      <div className="bulk-verify-actions">
        <button onClick={handleScan} disabled={state === 'running'}>Scan ingest folder</button>
        {items && items.length > 0 && (
          <>
            <button onClick={() => runProcess({ dryRun: true })} disabled={state === 'running'}>
              Preview {items.length} item{items.length === 1 ? '' : 's'}
            </button>
            <button onClick={() => runProcess({ dryRun: false })} disabled={state === 'running'}>
              Process {items.length} item{items.length === 1 ? '' : 's'}
            </button>
          </>
        )}
      </div>

      {items && items.length === 0 && <p className="muted">The ingest folder is empty.</p>}

      {state === 'running' && <EqualizerLoader label="Identifying and tagging files…" />}

      {error && (
        <p className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
          {error.message}
        </p>
      )}

      {isPreview && state === 'done' && (
        <p className="banner">Preview only — no tags were written and no files were moved.</p>
      )}

      {result && (
        <>
          <h2>{isPreview ? 'Would match & tag' : 'Matched & tagged'} ({result.matched.length})</h2>
          {result.matched.length === 0 ? (
            <p className="muted">Nothing was confidently matched this run.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>File</th><th>Title</th><th>Artist</th>
                  <th>{isPreview ? 'Would fill' : 'Fields filled'}</th>
                  <th>{isPreview ? 'Would move to' : 'Moved to'}</th>
                </tr>
              </thead>
              <tbody>
                {result.matched.map((m) => (
                  <tr key={m.path}>
                    <td>{m.name}</td>
                    <td>{m.title}</td>
                    <td>{m.artist}</td>
                    <td>{m.filledFields.join(', ') || 'none (already complete)'}</td>
                    <td className="muted">{m.movedTo || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Needs review ({result.needsReview.length})</h2>
          {result.needsReview.length === 0 ? (
            <p className="muted">Nothing needs review this run.</p>
          ) : (
            <table>
              <thead>
                <tr><th>File</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {result.needsReview.map((r) => (
                  <tr key={r.path}>
                    <td>{r.name}</td>
                    <td className="muted">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
