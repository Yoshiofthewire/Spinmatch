import { useEffect, useRef, useState } from 'react';
import VerifyResultsTable from './VerifyResultsTable.jsx';
import EqualizerLoader from './EqualizerLoader.jsx';
import CopyButton from './CopyButton.jsx';
import { addEntry } from '../lib/history.js';

// The YouTube-matching run for a list of tracks, streamed one result at a time.
//
// The endpoints are props because two callers want the same panel over different
// track sets: the release-group page verifies the whole official tracklist, and
// the library album view verifies only the tracks you don't already own. Both
// speak the same event protocol, so the streaming/progress/rate-limit handling
// below is written once. Defaults keep the release-group behaviour.
export default function BulkVerifyPanel({
  artist,
  album,
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
  // Only the artist sweep populates these: which record is being worked on, and
  // any whose tracklist couldn't be read.
  const [currentAlbum, setCurrentAlbum] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const esRef = useRef(null);
  const doneRef = useRef(false);

  // Close any open stream if the component unmounts mid-run (also tells the
  // server to abort via its req 'close' handler).
  useEffect(() => () => esRef.current?.close(), []);

  function logVerified(list) {
    // The artist sweep spans many records, so each result carries its own album;
    // the two album-scoped callers don't and fall back to the prop.
    list.filter((r) => r.video).forEach((r) => addEntry({
      track: r.title, artist, album: r.album ?? album, action: 'verified',
    }));
  }

  function handleClick() {
    setState('running');
    setError(null);
    setResults([]);
    setTotal(trackCount);
    setCurrentAlbum(null);
    setSkipped([]);

    // There was a non-streaming fallback here for "environments without
    // EventSource". No such environment runs this client — EventSource predates
    // every browser feature the app already depends on — and the endpoint behind
    // it held one HTTP request open for the whole multi-minute run, which is the
    // shape streaming exists to avoid. Both are gone.
    doneRef.current = false;
    const acc = [];
    const es = new EventSource(streamUrl);
    esRef.current = es;

    // Three shapes reach this handler. The release-group stream announces a
    // track total up front. The library album stream sends nothing, because its
    // caller already knows the count. The artist sweep sends one per record it
    // starts on, with no total — walking every tracklist to compute one would
    // cost as much again as the run — so it reports which album it is on
    // instead, which is the honest progress signal at that scale.
    es.addEventListener('album', (e) => {
      const data = JSON.parse(e.data);
      if (data.total != null) setTotal(data.total);
      if (data.albumIndex != null) setCurrentAlbum(data);
    });
    // An album whose release can't be read is reported and stepped past rather
    // than ending a run over twenty others.
    es.addEventListener('album_error', (e) => {
      setSkipped((prev) => [...prev, JSON.parse(e.data)]);
    });
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
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="muted" style={{ margin: 0 }}>
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
          <VerifyResultsTable results={results} artist={artist} album={album} />
        </>
      )}
    </div>
  );
}
