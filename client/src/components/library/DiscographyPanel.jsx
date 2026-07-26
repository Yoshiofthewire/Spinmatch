import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EqualizerLoader from '../EqualizerLoader.jsx';
import CoverArt from '../CoverArt.jsx';
import BulkVerifyPanel from '../BulkVerifyPanel.jsx';
import {
  getArtistDiscography, linkArtist, unlinkArtist, artistMissingStreamUrl,
} from '../../api/library.js';

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

  // The match is remembered, including one the app picked automatically. If it
  // picked wrong, the discography below is wrong and nothing else would ever
  // revisit it — so offer a way to forget it and look again.
  async function forgetMatch() {
    await unlinkArtist(artist);
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
          {/* A joined credit like "Nine Inch Nails / Stephen Morris" only
              resolves through its lead artist. Saying so matters: without it the
              panel shows a discography that plainly belongs to a different name
              than the one you clicked, which reads as a bug rather than a match. */}
          {data.via && (
            <p className="muted">
              Matched through <strong>{data.via}</strong> — “{artist}” is a joined
              credit, so its discography is that artist&apos;s.
            </p>
          )}

          <p className="muted">
            You own {data.owned.length} of {data.owned.length + data.missing.length} studio albums.
            {' '}
            <button type="button" className="link-button" onClick={forgetMatch}>
              Wrong artist?
            </button>
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

          {/* One action for the whole discography gap, the same panel the album
              view uses for one record. Opt-in on a press: this is a rate-limited
              lookup per track across every missing album, so it is minutes of
              work and must never start on its own. The track total isn't known
              up front — see the sweep's 'album' events — so the panel reports
              which record it's on instead. */}
          {data.missing.length > 0 && (
            <BulkVerifyPanel
              artist={artist}
              trackCount={0}
              streamUrl={artistMissingStreamUrl(artist)}
              prompt={`Finding every track from all ${data.missing.length} missing albums
                checks them one at a time to avoid rate limits, so this will take a while.
                Results already found are remembered, so it can be stopped and resumed.`}
              actionLabel="Find every missing track on YouTube"
            />
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
