import { Fragment, useRef, useState } from 'react';
import { get, post } from '../api/client.js';
import { addEntry } from '../lib/history.js';
import EqualizerLoader from './EqualizerLoader.jsx';
import IngestMatchPicker from './IngestMatchPicker.jsx';

// Log only real ingests, never previews.
function logIngested(matched) {
  for (const m of matched) {
    addEntry({ track: m.title, artist: m.artist, album: m.album, action: 'ingested' });
  }
}

export default function IngestPanel() {
  const [items, setItems] = useState(null);
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [processed, setProcessed] = useState(0);
  const doneRef = useRef(false);
  const [expandedPath, setExpandedPath] = useState(null);

  function handleResolved(oldItem, resolution) {
    setResult((prev) => {
      const needsReview = prev.needsReview.filter((r) => r.path !== oldItem.path);
      const matched = [...prev.matched];
      if (resolution.matched) {
        matched.push(resolution.matched);
        addEntry({
          track: resolution.matched.title,
          artist: resolution.matched.artist,
          album: resolution.matched.album,
          action: 'ingested',
        });
      } else if (resolution.needsReview) {
        needsReview.push(resolution.needsReview);
      }
      return { ...prev, matched, needsReview };
    });
    setExpandedPath(null);
  }

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

  // Fallback for environments without EventSource: one blocking request.
  async function runBlocking({ dryRun }) {
    try {
      const data = await post('/ingest/process', { dryRun });
      setResult(data);
      setState(data.error ? 'error' : 'done');
      if (data.error) setError(data.error);
      else if (!dryRun) logIngested(data.matched);
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  function runProcess({ dryRun }) {
    setState('running');
    setError(null);
    setProcessed(0);
    if (typeof EventSource === 'undefined') {
      runBlocking({ dryRun });
      return;
    }

    doneRef.current = false;
    const acc = { matched: [], needsReview: [], dryRun };
    setResult({ matched: [], needsReview: [], dryRun });
    const es = new EventSource(`/api/ingest/process-stream${dryRun ? '?dryRun=1' : ''}`);

    es.addEventListener('item', (e) => {
      const item = JSON.parse(e.data);
      if (item.kind === 'matched') acc.matched.push(item);
      else acc.needsReview.push(item);
      setResult({ matched: [...acc.matched], needsReview: [...acc.needsReview], dryRun });
      setProcessed((n) => n + 1);
    });
    es.addEventListener('done', (e) => {
      doneRef.current = true;
      es.close();
      const summary = JSON.parse(e.data);
      if (summary.error) {
        setError(summary.error);
        setState('error');
        return;
      }
      setState('done');
      if (!dryRun) logIngested(acc.matched);
    });
    es.addEventListener('error', (e) => {
      if (doneRef.current) return; // normal stream close right after a done event
      es.close();
      let message = 'The ingest stream failed.';
      try {
        if (e.data) message = JSON.parse(e.data).message;
      } catch {
        /* connection-level error carries no data */
      }
      setError({ message });
      setState('error');
    });
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

      {state === 'running' && (
        <EqualizerLoader label={`Identifying and tagging files… (${processed} processed)`} />
      )}

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
                <tr><th>File</th><th>Reason</th><th>Action</th></tr>
              </thead>
              <tbody>
                {result.needsReview.map((r) => (
                  <Fragment key={r.path}>
                    <tr>
                      <td>{r.name}</td>
                      <td className="muted">{r.reason}</td>
                      <td>
                        {r.code === 'no_match' && !isPreview && (
                          <button
                            type="button"
                            onClick={() => setExpandedPath(expandedPath === r.path ? null : r.path)}
                          >
                            {expandedPath === r.path ? 'Cancel' : 'Find a match'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedPath === r.path && (
                      <tr>
                        <td colSpan={3}>
                          <IngestMatchPicker
                            item={r}
                            onResolved={(resolution) => handleResolved(r, resolution)}
                            onCancel={() => setExpandedPath(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
