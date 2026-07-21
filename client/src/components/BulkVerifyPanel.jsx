import { useEffect, useRef, useState } from 'react';
import { post } from '../api/client.js';
import VerifyResultsTable from './VerifyResultsTable.jsx';
import EqualizerLoader from './EqualizerLoader.jsx';

const ESTIMATED_MS_PER_TRACK = 1500;

export default function BulkVerifyPanel({ releaseGroupMbid, trackCount, estimatedQuotaUnits }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [progress, setProgress] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => () => clearInterval(intervalRef.current), []);

  async function handleClick() {
    setState('running');
    setError(null);
    setProgress(0);

    // No real server-side progress in the current (blocking) design, so simulate
    // based on an elapsed-time estimate and cap short of 100% until the response lands.
    const estimatedTotalMs = trackCount * ESTIMATED_MS_PER_TRACK;
    const startedAt = Date.now();
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setProgress(Math.min(95, Math.round((elapsed / estimatedTotalMs) * 100)));
    }, 200);

    try {
      const result = await post(`/verify/album/${releaseGroupMbid}`, {});
      setData(result);
      setState(result.error ? 'error' : 'done');
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err);
      setState('error');
    } finally {
      clearInterval(intervalRef.current);
      setProgress(100);
    }
  }

  return (
    <div className="bulk-verify-panel">
      {state === 'idle' && (
        <div className="bulk-verify-prompt">
          <p className="muted">
            Finding all {trackCount} tracks on YouTube will use approximately{' '}
            <strong>{estimatedQuotaUnits}</strong> YouTube quota units (out of your 10,000/day limit).
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
            <p className="muted" style={{ margin: 0 }}>Matching each track against YouTube — this can take a while.</p>
          </div>
        </div>
      )}

      {error && (
        <p className={error.code === 'QUOTA_EXCEEDED' ? 'banner banner-quota' : 'banner banner-error'}>
          {error.message}
        </p>
      )}

      {data && data.results.length > 0 && <VerifyResultsTable results={data.results} />}
    </div>
  );
}
