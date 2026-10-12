import { useState } from 'react';
import { post } from '../api/client.js';
import EqualizerLoader from './EqualizerLoader.jsx';
import CopyButton from './CopyButton.jsx';

function StatusBadge({ status }) {
  if (status === 'confirmed') return <span className="badge badge-confirmed">Verified match</span>;
  if (status === 'unverified') return <span className="badge badge-unverified">Closest match — unverified</span>;
  return <span className="badge badge-none">No results</span>;
}

// Optional `recordingMbid` persists the result (30 days hit, 7 miss) instead of 1h in memory.
export default function VerifyButton({ artist, title, album, lengthMs, recordingMbid }) {
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleClick() {
    setState('loading');
    setError(null);
    try {
      const res = await post('/verify', { artist, title, album, lengthMs, recordingMbid });
      setResult(res);
      setState('done');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <button className="verify-button" onClick={handleClick}>
        Find on YouTube
      </button>
    );
  }

  if (state === 'loading') {
    return <EqualizerLoader label="Matching against YouTube…" />;
  }

  if (state === 'error') {
    return (
      <span className={error.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
        {error.message}
      </span>
    );
  }

  return (
    <span className="verify-result">
      <StatusBadge status={result.status} />
      {result.video && (
        <>
          <a href={result.video.url} target="_blank" rel="noreferrer">
            {result.video.title}
          </a>
          <CopyButton text={result.video.url} />
        </>
      )}
      {result.deltaSeconds != null && <span className="muted"> Δ{result.deltaSeconds}s</span>}
    </span>
  );
}
