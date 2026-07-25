import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
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

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => { setPage(1); }, [debounced, sort]);

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
  }, [debounced, sort, page]);

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
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <tr key={t.id}>
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
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      ))}
    </>
  );
}
