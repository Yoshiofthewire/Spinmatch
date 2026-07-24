import { useEffect, useRef, useState } from 'react';
import { post } from '../api/client.js';
import VerifyResultsTable from './VerifyResultsTable.jsx';
import EqualizerLoader from './EqualizerLoader.jsx';
import CopyButton from './CopyButton.jsx';
import { addEntry } from '../lib/history.js';

export default function BulkVerifyPanel({ artist, album, releaseGroupMbid, trackCount }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(trackCount);
  const [error, setError] = useState(null);
  const esRef = useRef(null);
  const doneRef = useRef(false);

  // Close any open stream if the component unmounts mid-run (also tells the
  // server to abort via its req 'close' handler).
  useEffect(() => () => esRef.current?.close(), []);

  function logVerified(list) {
    list.filter((r) => r.video).forEach((r) => addEntry({ track: r.title, artist, album, action: 'verified' }));
  }

  // Fallback for environments without EventSource: one blocking request.
  async function runBlocking() {
    try {
      const result = await post(`/verify/album/${releaseGroupMbid}`, {});
      setResults(result.results);
      if (result.error) {
        setError(result.error);
        setState('error');
      } else {
        setState('done');
        logVerified(result.results);
      }
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  function handleClick() {
    setState('running');
    setError(null);
    setResults([]);
    setTotal(trackCount);

    if (typeof EventSource === 'undefined') {
      runBlocking();
      return;
    }

    doneRef.current = false;
    const acc = [];
    const es = new EventSource(`/api/verify/album/${releaseGroupMbid}/stream`);
    esRef.current = es;

    es.addEventListener('album', (e) => setTotal(JSON.parse(e.data).total));
    es.addEventListener('result', (e) => {
      acc.push(JSON.parse(e.data));
      setResults([...acc]);
    });
    es.addEventListener('rate_limited', (e) => {
      doneRef.current = true;
      es.close();
      setError(JSON.parse(e.data));
      setState('error');
    });
    es.addEventListener('done', () => {
      doneRef.current = true;
      es.close();
      setState('done');
      logVerified(acc);
    });
    es.addEventListener('error', (e) => {
      if (doneRef.current) return; // normal close right after a terminal event
      es.close();
      let message = 'The verification stream failed.';
      let code;
      try {
        if (e.data) ({ message, code } = JSON.parse(e.data));
      } catch {
        /* connection-level error carries no data */
      }
      setError({ message, code });
      setState('error');
    });
  }

  const progress = total ? Math.round((results.length / total) * 100) : 0;

  return (
    <div className="bulk-verify-panel">
      {state === 'idle' && (
        <div className="bulk-verify-prompt">
          <p className="muted">
            Finding all {trackCount} tracks on YouTube checks them one at a time to avoid
            rate limits, so this may take a while.
          </p>
          <button onClick={handleClick}>Find all on YouTube</button>
        </div>
      )}

      {state === 'running' && (
        <div className="bulk-verify-progress">
          <EqualizerLoader />
          <div style={{ flex: 1 }}>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Matched {results.length}{total ? ` of ${total}` : ''} tracks…
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
          {error.message}
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
          <VerifyResultsTable results={results} artist={artist} album={album} />
        </>
      )}
    </div>
  );
}
