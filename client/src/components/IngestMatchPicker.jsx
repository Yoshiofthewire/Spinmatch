import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import { formatDuration } from '../lib/format.js';
import EqualizerLoader from './EqualizerLoader.jsx';

function CandidateRow({ mbid, title, artist, releaseGroupTitle, lengthMs, score, busy, onUse }) {
  return (
    <li className="ingest-candidate-row">
      <span>
        {title} — {artist}
        {releaseGroupTitle ? ` (${releaseGroupTitle})` : ''} · {formatDuration(lengthMs)}
        {score != null && ` · score ${score.toFixed(2)}`}
      </span>
      <button type="button" onClick={() => onUse(mbid)} disabled={busy}>
        {busy ? 'Applying…' : 'Use this'}
      </button>
    </li>
  );
}

export default function IngestMatchPicker({ item, onResolved, onCancel }) {
  const [candidates, setCandidates] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [applyingMbid, setApplyingMbid] = useState(null);
  const [applyError, setApplyError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setLoadError(null);
    get(`/ingest/file/candidates?path=${encodeURIComponent(item.path)}`)
      .then((data) => {
        if (!cancelled) setCandidates(data.candidates);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setApplyError(null);
    try {
      const data = await get(`/search?q=${encodeURIComponent(query.trim())}`);
      setSearchResults(data.recordings);
    } catch (err) {
      setApplyError(err);
    } finally {
      setSearching(false);
    }
  }

  async function handleUse(recordingMbid) {
    setApplyingMbid(recordingMbid);
    setApplyError(null);
    try {
      const result = await post('/ingest/file/resolve', {
        path: item.path,
        name: item.name,
        recordingMbid,
        dryRun: false,
      });
      onResolved(result);
    } catch (err) {
      setApplyError(err);
      setApplyingMbid(null);
    }
  }

  return (
    <div className="ingest-match-picker">
      {loadError && <p className="banner banner-error">{loadError.message}</p>}
      {candidates === null && !loadError && <EqualizerLoader label="Looking for near-misses…" />}
      {candidates && candidates.length === 0 && (
        <p className="muted">AcoustID found no other candidates for this file.</p>
      )}
      {candidates && candidates.length > 0 && (
        <ul className="ingest-candidate-list">
          {candidates.map((c) => (
            <CandidateRow
              key={c.recordingMbid}
              mbid={c.recordingMbid}
              title={c.title}
              artist={c.artist}
              releaseGroupTitle={c.releaseGroupTitle}
              lengthMs={c.lengthMs}
              score={c.score}
              busy={applyingMbid === c.recordingMbid}
              onUse={handleUse}
            />
          ))}
        </ul>
      )}

      <form className="ingest-candidate-search" onSubmit={handleSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search MusicBrainz by artist / title"
        />
        <button type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchResults && searchResults.length === 0 && <p className="muted">No matches found.</p>}
      {searchResults && searchResults.length > 0 && (
        <ul className="ingest-candidate-list">
          {searchResults.map((r) => (
            <CandidateRow
              key={r.mbid}
              mbid={r.mbid}
              title={r.title}
              artist={r.artist}
              releaseGroupTitle={r.releaseGroupTitle}
              lengthMs={r.lengthMs}
              score={null}
              busy={applyingMbid === r.mbid}
              onUse={handleUse}
            />
          ))}
        </ul>
      )}

      {applyError && <p className="banner banner-error">{applyError.message}</p>}

      <button type="button" className="ingest-picker-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
