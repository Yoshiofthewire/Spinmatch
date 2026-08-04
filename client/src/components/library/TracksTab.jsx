import { Fragment, useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import TagEditPanel from './TagEditPanel.jsx';
import AddToPlaylistButton from '../AddToPlaylistButton.jsx';
import { getLibraryTracks } from '../../api/library.js';
import { formatDuration } from '../../lib/format.js';

const PAGE_SIZE = 100;

const SORTS = [
  ['artist', 'Artist'],
  ['title', 'Title'],
  ['album', 'Album'],
  ['duration', 'Longest'],
  ['year', 'Year (newest)'],
  ['added', 'Recently added'],
];

// Unlike the artist and album tabs, this one queries the server per page: the
// whole-library track list is tens of thousands of rows, too many to ship and
// filter in the browser.
export default function TracksTab({ onPlay }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState('artist');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // track id whose panel is open
  // Bumped after an edit: the row's own values are what changed, so the page has
  // to be refetched or it keeps showing what was there before.
  const [reloadToken, setReloadToken] = useState(0);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => { setPage(1); }, [debounced, sort]);
  useEffect(() => { setEditing(null); }, [debounced, sort, page]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getLibraryTracks({
      q: debounced, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => { cancelled = true; };
  }, [debounced, sort, page, reloadToken]);

  const tracks = data?.tracks ?? [];
  const pageCount = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  return (
    <>
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Search titles, artists, albums…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tracks"
        />
        <SortSelect value={sort} options={SORTS} onChange={setSort} />
        {data && <span className="muted">{data.total.toLocaleString()} matching</span>}
      </div>

      {state === 'error' && <p className="banner banner-error">{error}</p>}
      {state === 'loading' && <EqualizerLoader label="Loading tracks…" />}

      {state === 'ready' && (tracks.length === 0 ? (
        <p className="muted">No tracks match that search.</p>
      ) : (
        <>
          <table className="library-table track-table">
            <thead>
              <tr>
                <th aria-label="Play" />
                <th>#</th><th>Title</th><th>Artist</th><th>Album</th>
                <th>Length</th><th>Year</th><th>Format</th>
                <th aria-label="Add to playlist" />
                <th aria-label="Edit" />
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <Fragment key={t.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="play-button"
                        onClick={() => onPlay(t, tracks)}
                        aria-label={`Play ${t.title}`}
                      >
                        ▶
                      </button>
                    </td>
                    <td className="mono">{t.trackNumber ?? '—'}</td>
                    <td>{t.title}</td>
                    <td>{t.artist ?? <span className="muted">Unknown</span>}</td>
                    <td>{t.album ?? <span className="muted">Unknown</span>}</td>
                    <td className="mono">{formatDuration(t.durationMs)}</td>
                    <td className="mono">{t.year ?? '—'}</td>
                    <td className="mono">{t.ext ?? '—'}</td>
                    <td>
                      <AddToPlaylistButton artist={t.artist} title={t.title} album={t.album} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="chip-button"
                        onClick={() => setEditing(editing === t.id ? null : t.id)}
                      >
                        {editing === t.id ? 'Close' : 'Edit tags'}
                      </button>
                    </td>
                  </tr>
                  {editing === t.id && (
                    <tr className="track-row-panel">
                      <td colSpan="10">
                        <TagEditPanel
                          track={t}
                          onSaved={() => {
                            setEditing(null);
                            setReloadToken((n) => n + 1);
                          }}
                          onCancel={() => setEditing(null)}
                          onPlay={(track) => onPlay(track, tracks)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      ))}
    </>
  );
}
