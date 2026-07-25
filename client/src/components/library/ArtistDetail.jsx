import { useEffect, useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import LocalCover from './LocalCover.jsx';
import DiscographyPanel from './DiscographyPanel.jsx';
import RescanButton from './RescanButton.jsx';
import { getLibraryAlbums } from '../../api/library.js';
import { formatLongDuration } from '../../lib/format.js';
import { albumKey } from '../../lib/albumKey.js';

export default function ArtistDetail({ artist, onSelectAlbum, incompleteKeys, onLibraryChanged }) {
  const [albums, setAlbums] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  // Bumped by a rescan to re-run the load below.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getLibraryAlbums({ artist, sort: 'year' })
      .then((result) => {
        if (cancelled) return;
        setAlbums(result.albums);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => { cancelled = true; };
  }, [artist, reload]);

  return (
    <div className="artist-detail">
      <h2>{artist}</h2>
      <p className="muted">
        <RescanButton
          artist={artist}
          onDone={() => { setReload((n) => n + 1); onLibraryChanged?.(); }}
        />
      </p>

      {state === 'error' && <p className="banner banner-error">{error}</p>}
      {state === 'loading' && <EqualizerLoader label="Loading albums…" />}

      {state === 'ready' && (
        <>
          <p className="muted">
            {albums.length} album{albums.length === 1 ? '' : 's'} on disk
          </p>
          <div className="album-grid">
            {albums.map((a) => (
              <button
                key={albumKey(a.artist, a.album)}
                className="album-card"
                onClick={() => onSelectAlbum(a)}
              >
                <LocalCover trackId={a.coverTrackId} alt={a.album} />
                <span className="album-title">{a.album}</span>
                <span className="muted album-card-meta">
                  {a.year ? `${a.year} · ` : ''}{a.trackCount} track{a.trackCount === 1 ? '' : 's'}
                  {a.totalDurationMs ? ` · ${formatLongDuration(a.totalDurationMs)}` : ''}
                </span>
                {incompleteKeys.has(albumKey(a.artist, a.album)) && (
                  <span className="badge-incomplete">incomplete</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Rendered regardless of the local album load, so an upstream failure
          and a local failure stay independent of each other. */}
      <DiscographyPanel artist={artist} />
    </div>
  );
}
