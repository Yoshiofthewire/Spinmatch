import { useEffect, useRef, useState } from 'react';
import VerifyResultsTable from './VerifyResultsTable.jsx';
import EqualizerLoader from './EqualizerLoader.jsx';
import CopyButton from './CopyButton.jsx';
import { streamEvents } from '../lib/eventStream.js';

// Streams YouTube matching for a track list. Endpoints are props: callers share
// one event protocol over different track sets.
export default function BulkVerifyPanel({
  releaseGroupMbid,
  trackCount,
  streamUrl = `/api/verify/album/${releaseGroupMbid}/stream`,
  prompt,
  actionLabel = 'Find all on YouTube',
}) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(trackCount);
  const [error, setError] = useState(null);
  // Artist sweep only: current record, and records whose tracklist failed.
  const [currentAlbum, setCurrentAlbum] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const abortRef = useRef(null);

  // Abort on unmount; the server stops via its req 'close' handler.
  useEffect(() => () => abortRef.current?.abort(), []);

  function handleClick() {
    setState('running');
    setError(null);
    setResults([]);
    setTotal(trackCount);
    setCurrentAlbum(null);
    setSkipped([]);

    const acc = [];
    const controller = new AbortController();
    abortRef.current = controller;

    // Exactly one terminal event ends a run: `done`, or one of the two failures.
    let terminal = null;

    streamEvents(streamUrl, {
      // Release-group: total up front. Library album: none (caller knows it).
      // Artist sweep: one per record, no total (computing it costs a second run).
      album: (data) => {
        if (data.total != null) setTotal(data.total);
        if (data.albumIndex != null) setCurrentAlbum(data);
      },
      // An unreadable album is reported and skipped, not fatal.
      album_error: (data) => setSkipped((prev) => [...prev, data]),
      result: (data) => {
        acc.push(data);
        setResults([...acc]);
      },
      rate_limited: (data) => { terminal = { failure: data }; },
      error: (data) => { terminal = { failure: data }; },
      done: () => { terminal = { ok: true }; },
    }, { signal: controller.signal }).then(() => {
      if (terminal?.ok) {
        setState('done');
        return;
      }
      // No terminal event: cut off. Results already shown still stand.
      setError(terminal?.failure ?? {
        message: 'The verification stream ended before it finished. Any results below are still good.',
      });
      setState('error');
    }).catch((err) => {
      if (controller.signal.aborted) return; // unmounted mid-run; nothing to report to
      setError({ message: err.message, code: err.code });
      setState('error');
    });
  }

  const progress = total ? Math.round((results.length / total) * 100) : 0;

  return (
    <div className="bulk-verify-panel">
      {state === 'idle' && (
        <div className="bulk-verify-prompt">
          <p className="muted">
            {prompt ?? `Finding all ${trackCount} tracks on YouTube checks them one at a time
              to avoid rate limits, so this may take a while.`}
          </p>
          <button onClick={handleClick}>{actionLabel}</button>
        </div>
      )}

      {state === 'running' && (
        <div className="bulk-verify-progress">
          <EqualizerLoader />
          <div style={{ flex: 1 }}>
            {/* No total (artist sweep) leaves valuenow unset: indeterminate. */}
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Tracks matched"
              aria-valuemin={0}
              aria-valuemax={total || undefined}
              aria-valuenow={total ? results.length : undefined}
            >
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="muted" style={{ margin: 0 }} aria-live="polite">
              Matched {results.length}{total ? ` of ${total}` : ''} tracks…
              {currentAlbum && (
                <> — album {currentAlbum.albumIndex} of {currentAlbum.albumCount}: {currentAlbum.title}</>
              )}
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
          {error.message}
        </p>
      )}

      {skipped.length > 0 && (
        <p className="muted">
          Skipped {skipped.length} album{skipped.length === 1 ? '' : 's'} whose
          tracklist couldn&apos;t be read: {skipped.map((s) => s.title).join(', ')}.
        </p>
      )}

      {results.length > 0 && (
        <>
          <div className="bulk-verify-actions">
            <CopyButton
              text={results
                .filter((r) => r.video)
                .map((r) => r.video.url)
                .join('\n')}
              label="Copy all links to clipboard"
            />
          </div>
          <VerifyResultsTable results={results} />
        </>
      )}
    </div>
  );
}
