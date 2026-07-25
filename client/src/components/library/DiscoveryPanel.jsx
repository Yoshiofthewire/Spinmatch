import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EqualizerLoader from '../EqualizerLoader.jsx';
import CoverArt from '../CoverArt.jsx';
import { getSimilarArtists, getRecommendations } from '../../api/library.js';

// Music you don't have, reached from music you do — the inverse of every other
// library view, which is all about finding holes in records you already know
// about.
//
// Opt-in on a button, like every other MusicBrainz-backed panel: a run resolves
// and walks up to ten of your artists through the 1-req/s queue, so it takes
// seconds to a minute and must never start on mount.
//
// The copy is deliberate about what this is. MusicBrainz has no "sounds like"
// relation, so these are artists *connected* to yours — shared members, side
// projects, collaborations — not an algorithm's guess at your taste. Saying so
// is what makes a thin result read as an honest answer rather than a broken one.
// Which signal produced a suggestion. Shown rather than flattened because the
// two make different claims: "sounds like" is a statistical statement about
// listeners, "connected to" is a documented fact about people. An artist found
// by both is the strongest lead there is here, and says so.
function SignalBadge({ artist }) {
  if (artist.kind === 'both') {
    return (
      <span className="badge badge-confirmed" title={`Sounds like yours and ${artist.relation}`}>
        sounds like + {artist.relation}
      </span>
    );
  }
  if (artist.kind === 'similar') {
    return <span className="badge badge-similar" title="Listeners overlap with yours">sounds like</span>;
  }
  return <span className="muted">{artist.relation}</span>;
}

export default function DiscoveryPanel() {
  const navigate = useNavigate();
  const [mode, setMode] = useState(null); // null | 'artists' | 'albums'
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load(next) {
    setMode(next);
    setState('loading');
    setError(null);
    try {
      setData(await (next === 'artists' ? getSimilarArtists() : getRecommendations()));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  return (
    <div className="gap-panel">
      <p className="muted">
        Finds artists and records related to the ones you already own the most of, from
        two different signals: <strong>sounds like</strong> comes from ListenBrainz, where
        listening histories overlap with yours, and <strong>connected to</strong> comes
        from MusicBrainz&apos;s relationship graph — shared members, side projects,
        collaborations. Anything already in your library is filtered out.
      </p>

      <div className="bulk-fix-sources">
        <button type="button" onClick={() => load('artists')} disabled={state === 'loading'}>
          Find similar artists
        </button>
        <button type="button" onClick={() => load('albums')} disabled={state === 'loading'}>
          Suggest albums
        </button>
      </div>

      {state === 'loading' && (
        <EqualizerLoader label="Reading your collection and asking MusicBrainz…" />
      )}

      {state === 'error' && (
        <>
          <p className={`banner ${error.code === 'RATE_LIMITED' ? 'banner-rate-limited' : 'banner-error'}`}>
            {error.message}
          </p>
          <button type="button" onClick={() => load(mode)}>Try again</button>
        </>
      )}

      {state === 'ready' && data && (
        <>
          {/* Half the signal missing produces thinner results that would
              otherwise look like your collection simply has no neighbours. */}
          {data.listenBrainz === 'unavailable' && (
            <p className="banner banner-rate-limited">
              ListenBrainz couldn&apos;t be reached, so these are from MusicBrainz&apos;s
              relationship graph alone — shared members and collaborations, without the
              &ldquo;sounds like&rdquo; half. Try again later for the full picture.
            </p>
          )}

          {data.seeds?.length > 0 && (
            <p className="muted">
              Starting from the {data.seeds.length} artist
              {data.seeds.length === 1 ? '' : 's'} you own the most of:{' '}
              {data.seeds.map((s) => s.artist).join(', ')}.
            </p>
          )}

          {mode === 'artists' && (
            data.artists.length === 0 ? (
              <p className="muted">
                Nothing found that you don&apos;t already have. That happens with
                collections concentrated in one scene, or when your top artists are
                ones few other listeners share.
              </p>
            ) : (
              <table className="library-table">
                <thead>
                  <tr><th>Artist</th><th>Signal</th><th>Reached from</th></tr>
                </thead>
                <tbody>
                  {data.artists.map((artist) => (
                    <tr key={artist.mbid}>
                      <td>
                        {artist.name}
                        {artist.comment && <span className="muted"> — {artist.comment}</span>}
                      </td>
                      <td>
                        <SignalBadge artist={artist} />
                      </td>
                      {/* Which of your artists led here — what makes a
                          suggestion explicable rather than an oracle's word. */}
                      <td className="muted">{artist.via.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {mode === 'albums' && (
            data.albums.length === 0 ? (
              <p className="muted">
                Nothing to suggest — no related artist turned up a record you don&apos;t
                already have.
              </p>
            ) : (
              <div className="album-grid">
                {data.albums.map((album) => (
                  <button
                    key={album.mbid}
                    className="album-card"
                    onClick={() => navigate(`/release-group/${album.mbid}`)}
                    title={`Reached from ${album.via.join(', ')} — find and verify this album`}
                  >
                    <CoverArt src={album.coverArtUrl} alt={album.title} />
                    <span className="album-title">{album.title}</span>
                    <span className="muted">{album.artist}</span>
                    {album.year && <span className="muted">{album.year}</span>}
                  </button>
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
