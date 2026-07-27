import { Fragment, useEffect, useMemo, useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import LocalCover from './LocalCover.jsx';
import AlbumGapPanel from './AlbumGapPanel.jsx';
import BulkFixPanel from './BulkFixPanel.jsx';
import AlbumTagEditPanel from './AlbumTagEditPanel.jsx';
import TagEditPanel from './TagEditPanel.jsx';
import MissingTrackCell from './MissingTrackCell.jsx';
import RescanButton from './RescanButton.jsx';
import { getAlbumTracks } from '../../api/library.js';
import { formatDuration, formatLongDuration } from '../../lib/format.js';

// Builds the display rows for one disc: owned tracks in position order with a
// placeholder row wherever a number is missing from the 1..max run. Showing the
// hole in place is the whole point — a list of what you have can't show it.
function rowsWithGaps(tracks) {
  const numbered = tracks.filter((t) => t.trackNumber != null);
  const unnumbered = tracks.filter((t) => t.trackNumber == null);
  if (!numbered.length) return unnumbered.map((t) => ({ kind: 'track', track: t }));

  const byNumber = new Map(numbered.map((t) => [t.trackNumber, t]));
  const max = Math.max(...numbered.map((t) => t.trackNumber));
  const rows = [];
  for (let n = 1; n <= max; n += 1) {
    const track = byNumber.get(n);
    if (track) rows.push({ kind: 'track', track });
    else rows.push({ kind: 'gap', position: n });
  }
  return rows.concat(unnumbered.map((t) => ({ kind: 'track', track: t })));
}

export default function AlbumDetail({
  album, onPlay, onSelectArtist, onLibraryChanged, onAlbumRenamed,
}) {
  const [tracks, setTracks] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  // Bumped by a rescan or a tag edit to re-run the load below.
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(null); // track id whose panel is open
  const [editingAlbum, setEditingAlbum] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getAlbumTracks({ artist: album.artist, album: album.album })
      .then((result) => {
        if (cancelled) return;
        setTracks(result.tracks);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => { cancelled = true; };
  }, [album.artist, album.album, reload]);

  // Group by disc so a 2-disc set numbers each disc from 1 independently.
  const discs = useMemo(() => {
    const map = new Map();
    for (const track of tracks) {
      const disc = track.disc ?? 1;
      if (!map.has(disc)) map.set(disc, []);
      map.get(disc).push(track);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [tracks]);

  const totalMs = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const missingCount = discs.reduce(
    (sum, [, discTracks]) => sum + rowsWithGaps(discTracks).filter((r) => r.kind === 'gap').length,
    0,
  );

  return (
    <div className="album-detail">
      <div className="album-detail-header">
        <LocalCover trackId={album.coverTrackId} alt={album.album} />
        <div>
          <h2>{album.album}</h2>
          <p className="muted">
            <button type="button" className="link-button" onClick={() => onSelectArtist(album.artist)}>
              {album.artist ?? 'Unknown artist'}
            </button>
          </p>
          <p className="muted">
            {album.year ? `${album.year} · ` : ''}
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
            {totalMs ? ` · ${formatLongDuration(totalMs)}` : ''}
            {missingCount > 0 && ` · ${missingCount} missing`}
          </p>
          <p className="muted">
            <RescanButton
              artist={album.artist}
              album={album.album}
              onDone={() => { setReload((n) => n + 1); onLibraryChanged?.(); }}
            />
            <button
              type="button"
              className="chip-button"
              onClick={() => setEditingAlbum((open) => !open)}
            >
              {editingAlbum ? 'Close editor' : 'Edit album tags'}
            </button>
          </p>
        </div>
      </div>

      {state === 'error' && <p className="banner banner-error">{error}</p>}
      {state === 'loading' && <EqualizerLoader label="Loading tracklist…" />}

      {state === 'ready' && discs.map(([disc, discTracks]) => (
        <div key={disc} className="album-disc">
          {discs.length > 1 && <h3>Disc {disc}</h3>}
          <table className="library-table track-table">
            <thead>
              <tr>
                <th aria-label="Play" /><th>#</th><th>Title</th><th>Length</th><th>Format</th>
                <th aria-label="Edit" />
              </tr>
            </thead>
            <tbody>
              {rowsWithGaps(discTracks).map((row) => (
                row.kind === 'gap' ? (
                  <tr key={`gap-${disc}-${row.position}`} className="track-row-missing">
                    <td />
                    <td className="mono">{row.position}</td>
                    <td colSpan="4">
                      {/* The hole is the one row that can't be edited — there is
                          no file. What it can do is name itself. */}
                      <MissingTrackCell
                        artist={album.artist}
                        album={album.album}
                        disc={disc}
                        position={row.position}
                      />
                    </td>
                  </tr>
                ) : (
                  <Fragment key={row.track.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="play-button"
                          onClick={() => onPlay(row.track, discTracks)}
                          aria-label={`Play ${row.track.title}`}
                        >
                          ▶
                        </button>
                      </td>
                      <td className="mono">{row.track.trackNumber ?? '—'}</td>
                      <td>{row.track.title}</td>
                      <td className="mono">{formatDuration(row.track.durationMs)}</td>
                      <td className="mono">{row.track.ext ?? '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="chip-button"
                          onClick={() => setEditing(editing === row.track.id ? null : row.track.id)}
                        >
                          {editing === row.track.id ? 'Close' : 'Edit'}
                        </button>
                      </td>
                    </tr>
                    {/* Opened as a row of its own directly beneath the one that
                        was clicked, the way the Health tab does it. Rendered after
                        the table instead, it lands a screen away and reads as the
                        button doing nothing. */}
                    {editing === row.track.id && (
                      <tr className="track-row-panel">
                        <td colSpan="6">
                          <TagEditPanel
                            track={row.track}
                            onSaved={() => {
                              setEditing(null);
                              setReload((n) => n + 1);
                              onLibraryChanged?.();
                            }}
                            onCancel={() => setEditing(null)}
                            onPlay={(t) => onPlay(t, discTracks)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Above BulkFixPanel so the two write paths sit together: this one writes
          exactly what you type, that one fills only what's empty from a source it
          derives itself. Seeing the contrast is the point. */}
      {state === 'ready' && editingAlbum && (
        <AlbumTagEditPanel
          artist={album.artist}
          album={album.album}
          tracks={tracks}
          onSaved={(result) => {
            setReload((n) => n + 1);
            onLibraryChanged?.();
            // The album's identity IS its (artist, album) pair, so a rename means
            // the view's own query string now names an album that doesn't exist.
            // The page has to move with it or the tracklist comes back empty.
            if (result.renamed) onAlbumRenamed?.(result.renamed);
          }}
          onCancel={() => setEditingAlbum(false)}
        />
      )}

      {/* Repairs what's here; AlbumGapPanel below finds what isn't. Applying a
          repair re-reads the tracklist, because the tags it just wrote are what
          the rows above are showing. */}
      <BulkFixPanel
        artist={album.artist}
        album={album.album}
        onApplied={() => { setReload((n) => n + 1); onLibraryChanged?.(); }}
      />

      {/* Independent of the local tracklist load, so an upstream failure and a
          local failure can't take each other down. */}
      <AlbumGapPanel artist={album.artist} album={album.album} />
    </div>
  );
}
