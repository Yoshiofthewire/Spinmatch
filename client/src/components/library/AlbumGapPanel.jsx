import { useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import VerifyButton from '../VerifyButton.jsx';
import BulkVerifyPanel from '../BulkVerifyPanel.jsx';
import { getAlbumGapsFromLibrary, missingStreamUrl } from '../../api/library.js';
import { formatDuration } from '../../lib/format.js';

// Finds trailing missing tracks the inline gap rows can't see. Opt-in: two
// rate-limited upstream calls.
export default function AlbumGapPanel({ artist, album }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setState('loading');
    setError(null);
    try {
      setData(await getAlbumGapsFromLibrary({ artist, album }));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  return (
    <div className="gap-panel">
      <h3>Check tracklist against MusicBrainz</h3>

      {state === 'idle' && (
        <>
          <p className="muted">
            Compares this album against its official tracklist — finds missing tracks
            even when the numbering on disk has no gaps.
          </p>
          <button type="button" onClick={load}>Check tracklist</button>
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

      {state === 'ready' && (data.unresolved ? (
        <p className="muted">
          Couldn&apos;t match “{album}” to a MusicBrainz release group. The album or
          artist tag probably differs from the official title.
        </p>
      ) : data.missing.length === 0 ? (
        <p className="muted">
          Complete — all {data.owned.length} tracks of the official tracklist are here.
        </p>
      ) : (
        <>
          <p className="muted">
            You have {data.owned.length} of {data.owned.length + data.missing.length} tracks.
          </p>

          {/* Verifies only the missing tracks. */}
          {data.album?.mbid && data.missing.length > 1 && (
            <BulkVerifyPanel
              trackCount={data.missing.length}
              streamUrl={missingStreamUrl(data.album.mbid)}
              prompt={`Finding all ${data.missing.length} missing tracks on YouTube checks them
                one at a time to avoid rate limits, so this may take a while.`}
              actionLabel="Find all missing on YouTube"
            />
          )}

          <table className="library-table">
            <thead>
              <tr><th>#</th><th>Missing track</th><th>Length</th><th>YouTube</th></tr>
            </thead>
            <tbody>
              {data.missing.map((track) => (
                <tr key={`${track.position}-${track.title}`}>
                  <td className="mono">{track.position}</td>
                  <td>{track.title}</td>
                  <td className="mono">{formatDuration(track.lengthMs)}</td>
                  <td>
                    {track.lengthMs == null ? (
                      <span className="muted">no length on MusicBrainz</span>
                    ) : (
                      <VerifyButton
                        artist={data.album?.artist ?? artist}
                        title={track.title}
                        album={album}
                        lengthMs={track.lengthMs}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ))}
    </div>
  );
}
