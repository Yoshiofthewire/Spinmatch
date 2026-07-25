import { useState } from 'react';
import { rescanLibraryPart } from '../../api/library.js';

// Rescans one artist's or album's folders rather than all of MUSIC_DIR — the
// point being that after fixing tags or dropping a file in, you shouldn't have to
// wait on a full pass to see it. Walks the folders (not just the known paths), so
// a file added since the last scan is picked up too.
export default function RescanButton({ artist, album, onDone }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  async function run() {
    setState('running');
    setError(null);
    try {
      const result = await rescanLibraryPart({ artist, album });
      setSummary(result);
      setState('done');
      onDone?.();
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }

  return (
    <span className="rescan-control">
      <button type="button" className="link-button" onClick={run} disabled={state === 'running'}>
        {state === 'running' ? 'Rescanning…' : `Rescan this ${album ? 'album' : 'artist'}`}
      </button>
      {state === 'done' && summary && (
        <span className="muted">
          {' '}
          {summary.added} added, {summary.updated} updated
          {summary.removed ? `, ${summary.removed} gone` : ''}
        </span>
      )}
      {state === 'error' && <span className="banner banner-error">{error}</span>}
    </span>
  );
}
