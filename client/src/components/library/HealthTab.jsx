import { Fragment, useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import FixTrackPanel from './FixTrackPanel.jsx';
import { getHealthTracks } from '../../api/library.js';

const PAGE_SIZE = 50;

// `fixable` is what separates a tagging problem from a file problem: a missing
// duration means the audio stream itself couldn't be decoded, which no amount of
// tag writing repairs, so that tile doesn't pretend to offer a fix.
const ISSUES = [
  ['missingArtist', 'No artist tag', true],
  ['missingAlbum', 'No album tag', true],
  ['missingTitle', 'No title tag', true],
  ['missingTrackNumber', 'No track number', true],
  ['missingDuration', 'No duration', false],
  ['noCoverArt', 'No embedded cover art', true],
];

function IssueTracks({ issue, fixable, onFixed, onSelectAlbum, onPlay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [fixing, setFixing] = useState(null); // track being fixed
  const [fixed, setFixed] = useState({}); // trackId -> filled field list
  // Bumped after a repair to refetch the current page. A repaired track no
  // longer matches the issue it was listed under, so without this it sits in the
  // table looking untouched however many times you fix it.
  const [reloadToken, setReloadToken] = useState(0);

  // Everything below is scoped to one issue and one page of it: leaving either
  // has to clear the open panel and the per-track badges too, or a badge keyed
  // by track id reappears against whatever row reuses that id in the next view.
  useEffect(() => { setPage(1); }, [issue]);
  useEffect(() => {
    setFixing(null);
    setFixed({});
  }, [issue, page]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getHealthTracks({ issue, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [issue, page, reloadToken]);

  function handleFixed(result) {
    setFixed((prev) => ({
      ...prev,
      [fixing.id]: { fields: result.filledFields, overwritten: result.overwritten },
    }));
    setFixing(null);
    setReloadToken((n) => n + 1);
    onFixed();
  }

  if (error) return <p className="banner banner-error">{error}</p>;
  if (!data) return <EqualizerLoader label="Loading tracks…" />;
  if (data.total === 0) return <p className="muted">Nothing to report here.</p>;

  return (
    <>
      <table className="library-table">
        <thead>
          <tr>
            <th>Artist</th><th>Title</th><th>Album</th><th>#</th>
            {fixable && <th aria-label="Fix" />}
          </tr>
        </thead>
        <tbody>
          {data.tracks.map((track) => (
            /* Fragment rather than a bare <tr> so the repair panel can open as a
               row of its own directly beneath the one that was clicked. Rendering
               it after the table instead puts it up to PAGE_SIZE rows below the
               button, off-screen, which reads as the button doing nothing. */
            <Fragment key={track.id}>
              <tr className={fixed[track.id] ? 'track-row-fixed' : undefined}>
                <td>{track.artist ?? <span className="muted">—</span>}</td>
                <td>
                  {/* A synthesized value is shown but marked: the scanner fills
                      album from the folder name and title from the filename when
                      the tag is empty, so a row listed under "No title tag" does
                      carry a title — it just isn't one the file claims. Rendering
                      it as if it were real made the whole category look like a
                      false positive. */}
                  {track.title
                    ? <span className={track.titleSynthesized ? 'muted' : undefined}>{track.title}</span>
                    : <span className="muted">—</span>}
                  {track.titleSynthesized && <span className="muted"> (from filename)</span>}
                  {/* The path is the only identifier an untagged file has, so it
                      has to be visible for the row to mean anything. */}
                  {(!track.title || track.titleSynthesized)
                    && <span className="muted mono fix-path">{track.path}</span>}
                </td>
                <td>
                  {track.album
                    ? <span className={track.albumSynthesized ? 'muted' : undefined}>{track.album}</span>
                    : <span className="muted">—</span>}
                  {track.albumSynthesized && <span className="muted"> (from folder)</span>}
                </td>
                <td className="mono">{track.trackNumber ?? '—'}</td>
                {fixable && (
                  <td>
                    {fixed[track.id] ? (
                      <span className="badge badge-confirmed">
                        {fixed[track.id].fields.length
                          ? `${fixed[track.id].overwritten ? 'Replaced' : 'Filled'} ${fixed[track.id].fields.join(', ')}`
                          : 'No changes needed'}
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setFixing(fixing?.id === track.id ? null : track)}
                        >
                          {fixing?.id === track.id ? 'Close' : 'Fix tags'}
                        </button>
                        {/* One file with an empty tag usually means the whole
                            folder has one, and repairing them one at a time is
                            the slow way round. */}
                        {track.album && (
                          <button
                            type="button"
                            className="chip-button"
                            title={`Repair every file in ${track.album} at once`}
                            onClick={() => onSelectAlbum({ artist: track.artist, album: track.album })}
                          >
                            Whole album
                          </button>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
              {fixing?.id === track.id && (
                <tr className="track-row-panel">
                  <td colSpan={fixable ? 5 : 4}>
                    {/* The play queue is this page of the issue, so skipping
                        forward walks the list being audited rather than
                        stopping dead after one file. */}
                    <FixTrackPanel
                      track={fixing}
                      onFixed={handleFixed}
                      onCancel={() => setFixing(null)}
                      onPlay={onPlay && ((t) => onPlay(t, data.tracks))}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      <Pagination
        page={page}
        pageCount={Math.max(Math.ceil(data.total / PAGE_SIZE), 1)}
        onChange={setPage}
      />
    </>
  );
}

// Tag hygiene. Worth its own view because these are the same problems that make
// gap and discography detection produce false positives: matching is done on
// artist and title, so an empty artist tag is invisible to both. Each count
// drills into the tracks behind it so it can be acted on, not just read.
export default function HealthTab({
  health, totalTracks, duplicateCount, onFixed, onGoTo, onSelectAlbum, onPlay,
}) {
  const [issue, setIssue] = useState(null);
  const active = ISSUES.find(([key]) => key === issue);

  // Repairing the last track in a category drops its count to 0, which disables
  // its tile — leaving the selection stuck on a tile that can no longer be
  // clicked to dismiss it. Clearing the selection is what the disabled tile
  // would have done if it were still clickable.
  useEffect(() => {
    if (issue && health[issue] === 0) setIssue(null);
  }, [issue, health]);

  return (
    <>
      <div className="stat-tiles">
        {ISSUES.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`stat-tile stat-tile-button${issue === key ? ' stat-tile-active' : ''}`}
            onClick={() => setIssue(issue === key ? null : key)}
            disabled={health[key] === 0}
          >
            <span className="stat-value">{health[key].toLocaleString()}</span>
            <span className="stat-label">{label}</span>
            {totalTracks > 0 && (
              <span className="muted stat-hint">
                {((health[key] / totalTracks) * 100).toFixed(1)}% of tracks
              </span>
            )}
          </button>
        ))}
      </div>

      {!active && (
        <p className="muted">
          Pick a category to see the tracks behind it. Most can be repaired in place —
          Spinmatch fills only the tags that are empty and never overwrites what you have.
        </p>
      )}

      {active && (
        <>
          <h3>{active[1]}</h3>
          {active[2] ? (
            <p className="muted">
              Matching a track fills its empty tags from MusicBrainz and re-indexes it.
              The file is never moved or renamed, and existing tags are left alone.
            </p>
          ) : (
            <p className="muted">
              A missing duration means the audio stream itself couldn&apos;t be read, so
              this isn&apos;t a tagging problem — the file is likely truncated or corrupt.
            </p>
          )}
          <IssueTracks
            issue={active[0]}
            fixable={active[2]}
            onFixed={onFixed}
            onSelectAlbum={onSelectAlbum}
            onPlay={onPlay}
          />
        </>
      )}

      {duplicateCount > 0 && (
        <div className="overview-actions">
          <button type="button" className="chip-button" onClick={() => onGoTo('duplicates')}>
            {duplicateCount.toLocaleString()} possible duplicate
            {duplicateCount === 1 ? '' : 's'} — see the Duplicates tab
          </button>
        </div>
      )}
    </>
  );
}
