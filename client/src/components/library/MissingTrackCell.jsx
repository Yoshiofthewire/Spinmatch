import { useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import VerifyButton from '../VerifyButton.jsx';
import { getMissingTrack } from '../../api/library.js';

// One hole in an album's numbering, made actionable.
//
// The row knows only a position, and you cannot search YouTube for "track 4". So
// this asks MusicBrainz what sits at that position first, and once it has a title
// the existing VerifyButton does the YouTube half unchanged.
//
// Opt-in per row rather than resolved on mount: the album view renders every gap
// at once, and firing a lookup for each on open would queue N calls through the
// 1-req/s MusicBrainz limiter for information nobody asked for. Clicking several
// rows is cheap anyway — the underlying release lookup is cached for an hour, so
// only the first click on an album reaches the network.
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
    // A position past the end of the official tracklist usually means the
    // opposite of a missing file: a wrong track number on a file you already
    // have. Worth saying, because "find this track" would otherwise look broken
    // on an album that is in fact complete.
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
        // POST /verify needs a length to duration-check against, and a guess with
        // nothing to verify it is worse than no answer.
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
