import { useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import VerifyButton from '../VerifyButton.jsx';
import { getMissingTrack } from '../../api/library.js';

// Resolves a gap position to a title via MusicBrainz, then hands off to VerifyButton.
// Opt-in per row: on mount it would queue every gap through the 1-req/s limiter.
export default function MissingTrackCell({ artist, album, disc, position }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setState('loading');
    setError(null);
    try {
      setFound(await getMissingTrack({ artist, album, disc, position }));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <>
        <span className="muted">missing</span>
        <button type="button" className="chip-button" onClick={load}>
          Find this track
        </button>
      </>
    );
  }

  if (state === 'loading') return <EqualizerLoader label="Asking MusicBrainz…" />;

  if (state === 'error') {
    return (
      <>
        <span className={`banner ${error.code === 'RATE_LIMITED' ? 'banner-rate-limited' : 'banner-error'}`}>
          {error.message}
        </span>
        <button type="button" className="chip-button" onClick={load}>Try again</button>
      </>
    );
  }

  if (!found.resolved) {
    // Past the tracklist's end usually means a wrong track number on an owned file.
    if (found.reason === 'no_such_position') {
      return (
        <span className="muted">
          MusicBrainz lists only {found.trackCount} track{found.trackCount === 1 ? '' : 's'} on
          this release, so position {position} is more likely a wrong track number on one of your
          files than a missing track — edit its tags to correct it.
        </span>
      );
    }
    if (found.reason === 'no_release') {
      return <span className="muted">MusicBrainz has this release group but no usable release.</span>;
    }
    return (
      <span className="muted">
        Couldn&apos;t match this album on MusicBrainz — the album or artist tag probably differs
        from the official title. “Check tracklist” below has more detail.
      </span>
    );
  }

  return (
    <span className="verify-result">
      <strong>{found.title}</strong>
      {found.lengthMs == null ? (
        // POST /verify requires a length to duration-check against.
        <span className="muted"> no length on MusicBrainz</span>
      ) : (
        <VerifyButton
          artist={found.artist ?? artist}
          title={found.title}
          album={found.album ?? album}
          lengthMs={found.lengthMs}
          recordingMbid={found.recordingMbid}
        />
      )}
    </span>
  );
}
