import { useState } from 'react';
import { post } from '../api/client.js';
import EqualizerLoader from './EqualizerLoader.jsx';
import SendToMeTubeButton from './SendToMeTubeButton.jsx';
import CopyButton from './CopyButton.jsx';
import { addEntry } from '../lib/history.js';

function StatusBadge({ status }) {
  if (status === 'confirmed') return <span className="badge badge-confirmed">Verified match</span>;
  if (status === 'unverified') return <span className="badge badge-unverified">Closest match — unverified</span>;
  return <span className="badge badge-none">No results</span>;
}

export default function VerifyButton({ artist, title, album, lengthMs }) {
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleClick() {
    setState('loading');
    setError(null);
    try {
      const res = await post('/verify', { artist, title, album, lengthMs });
      setResult(res);
      setState('done');
      if (res.video) addEntry({ track: title, artist, album, action: 'verified' });
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
          <SendToMeTubeButton url={result.video.url} artist={artist} title={title} album={album} />
        </>
      )}
      {result.deltaSeconds != null && <span className="muted"> Δ{result.deltaSeconds}s</span>}
    </span>
  );
}
