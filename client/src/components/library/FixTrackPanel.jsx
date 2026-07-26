import { useEffect, useState } from 'react';
import { get } from '../../api/client.js';
import { useConfig } from '../../ConfigContext.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import CandidateRow from '../CandidateRow.jsx';
import { getFixCandidates, getFingerprintCandidates, applyFix } from '../../api/library.js';

// Repairs the tags of a file already in the library. The ingest counterpart of
// this (IngestMatchPicker) tags AND moves the file; here the file is already
// where it belongs, so applying a match only writes tags.
//
// Two ways to identify the file, and the difference matters. The candidates
// loaded on open come from its own tags and path, which is free but useless for
// exactly the files that need repairing most. "Identify by audio" fingerprints
// it instead — the one signal that doesn't depend on the metadata being fixed —
// but that costs an fpcalc run and a rate-limited AcoustID call, so it waits to
// be asked for.
//
// Only a fingerprint match may overwrite tags the file already has, and only
// when explicitly ticked: the tag/path candidates are a guess built from the
// same metadata they'd be replacing.
export default function FixTrackPanel({ track, onFixed, onCancel, onPlay }) {
  const { acoustidConfigured } = useConfig();
  const [candidates, setCandidates] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [applyingMbid, setApplyingMbid] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [fpCandidates, setFpCandidates] = useState(null);
  const [fingerprinting, setFingerprinting] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [replaceCoverArt, setReplaceCoverArt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setLoadError(null);
    setFpCandidates(null);
    setOverwrite(false);
    setReplaceCoverArt(false);
    getFixCandidates(track.id)
      .then((data) => { if (!cancelled) setCandidates(data.candidates); })
      .catch((err) => { if (!cancelled) setLoadError(err); });
    return () => { cancelled = true; };
  }, [track.id]);

  async function handleIdentifyByAudio() {
    setFingerprinting(true);
    setApplyError(null);
    try {
      setFpCandidates((await getFingerprintCandidates(track.id)).candidates);
    } catch (err) {
      setApplyError(err);
    } finally {
      setFingerprinting(false);
    }
  }

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

  // `fromFingerprint` gates the overwrite: a tag-derived candidate never gets to
  // replace the tags it was derived from.
  async function handleUse(recordingMbid, fromFingerprint = false) {
    setApplyingMbid(recordingMbid);
    setApplyError(null);
    try {
      onFixed(await applyFix({
        trackId: track.id,
        recordingMbid,
        overwrite: fromFingerprint && overwrite,
        replaceCoverArt: fromFingerprint && replaceCoverArt,
      }));
    } catch (err) {
      setApplyError(err);
      setApplyingMbid(null);
    }
  }

  // A recording the fingerprint already offered isn't offered again below with a
  // weaker score and a different apply behaviour.
  const fpMbids = new Set((fpCandidates ?? []).map((c) => c.recordingMbid));
  const tagCandidates = (candidates ?? []).filter((c) => !fpMbids.has(c.recordingMbid));

  return (
    <div className="ingest-match-picker">
      {/* Playing the file is the other way to answer "what *is* this?", and the
          cheap one — no fpcalc, no rate-limited lookup, and it works on the
          files AcoustID has never heard of. A row is here precisely because its
          tags don't say what it is, so the path and the audio are the only two
          things that do. */}
      <div className="fix-identify">
        {onPlay && (
          <button
            type="button"
            className="play-button"
            onClick={() => onPlay(track)}
            aria-label={`Play ${track.title || track.path}`}
            title="Play this file"
          >
            ▶
          </button>
        )}
        <p className="muted mono fix-path">{track.path}</p>
      </div>

      {loadError && <p className="banner banner-error">{loadError.message}</p>}

      {acoustidConfigured && (
        <div className="fix-fingerprint">
          <button type="button" onClick={handleIdentifyByAudio} disabled={fingerprinting}>
            {fingerprinting ? 'Fingerprinting…' : 'Identify by audio'}
          </button>
          <span className="muted">Reads the file itself — the way to fix tags that are wrong, not just missing.</span>
        </div>
      )}

      {fpCandidates && fpCandidates.length === 0 && (
        <p className="muted">AcoustID doesn&apos;t recognise this recording.</p>
      )}
      {fpCandidates && fpCandidates.length > 0 && (
        <>
          <h4 className="fix-section-title">AcoustID matches</h4>
          {/* Above the list, not below it: these change what "Use this" does, so
              they have to be read before the button is reached. Both off by
              default and offered only here — nothing in this app can be undone.
              Separate boxes because they're separate decisions: plenty of people
              want the tags corrected and their own artwork left alone. */}
          <label className="fix-overwrite">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Replace existing tags, don&apos;t just fill blanks
          </label>
          <label className="fix-overwrite">
            <input
              type="checkbox"
              checked={replaceCoverArt}
              onChange={(e) => setReplaceCoverArt(e.target.checked)}
            />
            Replace existing cover art
          </label>
          <ul className="ingest-candidate-list">
            {fpCandidates.map((c) => (
              <CandidateRow
                key={c.recordingMbid}
                mbid={c.recordingMbid}
                title={c.title}
                artist={c.artist}
                releaseGroupTitle={c.releaseGroupTitle}
                lengthMs={c.lengthMs}
                score={c.score}
                busy={applyingMbid === c.recordingMbid}
                onUse={(mbid) => handleUse(mbid, true)}
              />
            ))}
          </ul>
        </>
      )}

      {candidates === null && !loadError && <EqualizerLoader label="Searching MusicBrainz…" />}
      {candidates && candidates.length === 0 && (
        <p className="muted">
          MusicBrainz found nothing for this file&apos;s existing tags — which is expected
          when the tags are what&apos;s missing. Search for it below.
        </p>
      )}
      {tagCandidates.length > 0 && (
        <>
          {fpCandidates && fpCandidates.length > 0 && (
            <h4 className="fix-section-title">Matches from this file&apos;s tags and path</h4>
          )}
          <ul className="ingest-candidate-list">
            {tagCandidates.map((c) => (
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
        </>
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
