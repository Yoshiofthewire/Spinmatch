import { useEffect, useState } from 'react';
import { get } from '../../api/client.js';
import EqualizerLoader from '../EqualizerLoader.jsx';
import CandidateRow from '../CandidateRow.jsx';
import { getFixCandidates, applyFix } from '../../api/library.js';

// Repairs the tags of a file already in the library. The ingest counterpart of
// this (IngestMatchPicker) tags AND moves the file; here the file is already
// where it belongs, so applying a match only writes tags — and only the ones
// that are currently empty, so an existing value is never overwritten.
export default function FixTrackPanel({ track, onFixed, onCancel }) {
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
    getFixCandidates(track.id)
      .then((data) => { if (!cancelled) setCandidates(data.candidates); })
      .catch((err) => { if (!cancelled) setLoadError(err); });
    return () => { cancelled = true; };
  }, [track.id]);

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
      onFixed(await applyFix({ trackId: track.id, recordingMbid }));
    } catch (err) {
      setApplyError(err);
      setApplyingMbid(null);
    }
  }

  return (
    <div className="ingest-match-picker">
      <p className="muted mono fix-path">{track.path}</p>

      {loadError && <p className="banner banner-error">{loadError.message}</p>}
      {candidates === null && !loadError && <EqualizerLoader label="Searching MusicBrainz…" />}
      {candidates && candidates.length === 0 && (
        <p className="muted">
          MusicBrainz found nothing for this file&apos;s existing tags — which is expected
          when the tags are what&apos;s missing. Search for it below.
        </p>
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
