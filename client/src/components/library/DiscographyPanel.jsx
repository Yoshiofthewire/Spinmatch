import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EqualizerLoader from '../EqualizerLoader.jsx';
import CoverArt from '../CoverArt.jsx';
import { getArtistDiscography, linkArtist } from '../../api/library.js';

// The MusicBrainz-backed half of missing detection. Deliberately opt-in: it runs
// on a button press, not on mount, so a slow or unreachable upstream never
// blocks the artist view from rendering what's on disk.
export default function DiscographyPanel({ artist }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  async function load() {
    setState('loading');
    setError(null);
    try {
      setData(await getArtistDiscography(artist));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  async function choose(mbArtistId) {
    await linkArtist({ artist, mbArtistId });
    await load();
  }

  return (
    <div className="gap-panel">
      <h3>Missing albums</h3>

      {state === 'idle' && (
        <>
          <p className="muted">
            Compare this artist&apos;s studio discography on MusicBrainz against what you own.
          </p>
          <button type="button" onClick={load}>Check MusicBrainz</button>
        </>
      )}

      {state === 'loading' && <EqualizerLoader label="Checking MusicBrainz…" />}

      {state === 'error' && (
        <>
          <p className={`banner ${error.code === 'RATE_LIMITED' ? 'banner-rate-limited' : 'banner-error'}`}>
            {error.message}
          </p>
          <button type="button" onClick={load}>Try again</button>
        </>
      )}

      {state === 'ready' && data.unresolved && (
        <>
          {data.candidates.length === 0 ? (
            <p className="muted">
              MusicBrainz has no artist matching “{artist}”. Fixing the artist tag and
              rescanning usually resolves this.
            </p>
          ) : (
            <>
              <p className="muted">
                Several artists match “{artist}”. Pick the right one — guessing would
                produce a misleading missing-albums list.
              </p>
              <ul className="candidate-list">
                {data.candidates.map((c) => (
                  <li key={c.mbid}>
                    <button type="button" className="link-button" onClick={() => choose(c.mbid)}>
                      {c.name}
                    </button>
                    {c.disambiguation && <span className="muted"> — {c.disambiguation}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {state === 'ready' && !data.unresolved && (
        <>
          <p className="muted">
            You own {data.owned.length} of {data.owned.length + data.missing.length} studio albums.
          </p>

          {data.missing.length === 0 ? (
            <p className="muted">Nothing missing — you have the full studio discography.</p>
          ) : (
            <div className="album-grid">
              {data.missing.map((album) => (
                <button
                  key={album.mbid}
                  className="album-card"
                  onClick={() => navigate(`/release-group/${album.mbid}`)}
                  title="Find and verify this album"
                >
                  <CoverArt src={album.coverArtUrl} alt={album.title} />
                  <span className="album-title">{album.title}</span>
                  {album.year && <span className="muted">{album.year}</span>}
                </button>
              ))}
            </div>
          )}

          {data.unmatchedLocal?.length > 0 && (
            <details className="unmatched-local">
              <summary className="muted">
                {data.unmatchedLocal.length} album{data.unmatchedLocal.length === 1 ? '' : 's'} on
                disk that MusicBrainz doesn&apos;t list as a studio album
              </summary>
              <ul>
                {data.unmatchedLocal.map((album) => <li key={album}>{album}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
