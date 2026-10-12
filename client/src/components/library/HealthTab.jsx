import { Fragment, useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import FixTrackPanel from './FixTrackPanel.jsx';
import TagEditPanel from './TagEditPanel.jsx';
import { getHealthTracks } from '../../api/library.js';

const PAGE_SIZE = 50;

// `fixable`: tag problems only. A missing duration is undecodable audio; tags can't fix it.
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
  const [fixing, setFixing] = useState(null); // track being matched against MusicBrainz
  const [editing, setEditing] = useState(null); // track being edited by hand
  const [fixed, setFixed] = useState({}); // trackId -> filled field list
  // Bumped after a repair to refetch the page.
  const [reloadToken, setReloadToken] = useState(0);

  // Scoped to one issue and page; reset on leaving either so stale badges can't reappear.
  useEffect(() => { setPage(1); }, [issue]);
  useEffect(() => {
    setFixing(null);
    setEditing(null);
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

  // Hand edits badge the row the same way as MusicBrainz fixes.
  function handleEdited(result) {
    setFixed((prev) => ({
      ...prev,
      [editing.id]: { fields: result.changedFields, overwritten: true },
    }));
    setEditing(null);
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
            /* Fragment so the repair panel opens as a row right beneath its track. */
            <Fragment key={track.id}>
              <tr className={fixed[track.id] ? 'track-row-fixed' : undefined}>
                <td>{track.artist ?? <span className="muted">—</span>}</td>
                <td>
                  {/* Synthesized values (from folder/filename) are shown but marked. */}
                  {track.title
                    ? <span className={track.titleSynthesized ? 'muted' : undefined}>{track.title}</span>
                    : <span className="muted">—</span>}
                  {/* Boolean(): SQLite flags are 0/1 and React renders a bare 0. */}
                  {Boolean(track.titleSynthesized) && <span className="muted"> (from filename)</span>}
                  {/* The path is an untagged file's only identifier. */}
                  {(!track.title || Boolean(track.titleSynthesized))
                    && <span className="muted mono fix-path">{track.path}</span>}
                </td>
                <td>
                  {track.album
                    ? <span className={track.albumSynthesized ? 'muted' : undefined}>{track.album}</span>
                    : <span className="muted">—</span>}
                  {Boolean(track.albumSynthesized) && <span className="muted"> (from folder)</span>}
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
                          onClick={() => {
                            setEditing(null);
                            setFixing(fixing?.id === track.id ? null : track);
                          }}
                        >
                          {fixing?.id === track.id ? 'Close' : 'Fix tags'}
                        </button>
                        {/* Missing tags leave MusicBrainz nothing to search on; typing is often faster. */}
                        <button
                          type="button"
                          className="chip-button"
                          onClick={() => {
                            setFixing(null);
                            setEditing(editing?.id === track.id ? null : track);
                          }}
                        >
                          {editing?.id === track.id ? 'Close' : 'Edit tags'}
                        </button>
                        {/* An empty tag usually means the whole folder has one. */}
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
                    {/* Queue is this page, so skipping walks the audited list. */}
                    <FixTrackPanel
                      track={fixing}
                      onFixed={handleFixed}
                      onCancel={() => setFixing(null)}
                      onPlay={onPlay && ((t) => onPlay(t, data.tracks))}
                    />
                  </td>
                </tr>
              )}
              {editing?.id === track.id && (
                <tr className="track-row-panel">
                  <td colSpan={fixable ? 5 : 4}>
                    <TagEditPanel
                      track={editing}
                      onSaved={handleEdited}
                      onCancel={() => setEditing(null)}
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

// Tag hygiene: bad artist/title tags cause false gaps in gap and discography detection.
export default function HealthTab({
  health, totalTracks, duplicateCount, onFixed, onGoTo, onSelectAlbum, onPlay,
}) {
  const [issue, setIssue] = useState(null);
  const active = ISSUES.find(([key]) => key === issue);

  // A count reaching 0 disables its tile, so clear a selection stuck on it.
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
            aria-pressed={issue === key}
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
          Pick a category to see the tracks behind it. Most can be repaired in place, two ways:
          <strong> Fix tags</strong> takes the values from MusicBrainz and fills only what is
          empty, and <strong> Edit tags</strong> lets you type them yourself, over whatever is
          there. Neither ever removes a tag, and neither moves or renames a file.
        </p>
      )}

      {active && (
        <>
          <h3>{active[1]}</h3>
          {active[2] ? (
            <p className="muted">
              <strong>Fix tags</strong> matches the track against MusicBrainz, fills its empty
              tags and re-indexes it, leaving existing tags alone. <strong>Edit tags</strong>
              {' '}writes what you type instead, replacing what is there — the one path where you
              are the source of truth. A field you leave blank keeps its current value either
              way, and the file is never moved or renamed.
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
