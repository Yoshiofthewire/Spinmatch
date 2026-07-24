import { useState } from 'react';
import { getAlbumGaps } from '../api/library.js';

// releaseGroupMbid comes from an album the user picked in search results.
export default function GapDetectionPanel({ releaseGroupMbid, albumTitle }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  async function run() {
    setState({ status: 'loading', data: null, error: null });
    try {
      const data = await getAlbumGaps(releaseGroupMbid);
      setState({ status: 'done', data, error: null });
    } catch (err) {
      setState({ status: 'error', data: null, error: err.message });
    }
  }

  return (
    <div className="gap-panel">
      <button onClick={run} disabled={state.status === 'loading'}>
        {state.status === 'loading' ? 'Checking…' : `Find missing tracks in ${albumTitle}`}
      </button>

      {state.status === 'error' && <p className="banner banner-error">{state.error}</p>}

      {state.status === 'done' && state.data && (
        <div className="gap-panel-results">
          <p className="muted">{state.data.owned.length} owned · {state.data.missing.length} missing</p>
          <ul className="missing-list">
            {state.data.missing.map((t) => (
              <li key={`${t.position}-${t.title}`}>
                <span>{t.position}. {t.title}</span>{' '}
                {t.video?.url
                  ? <a href={t.video.url} target="_blank" rel="noreferrer">YouTube</a>
                  : <em className="muted">no match found</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
