import { useMemo, useState } from 'react';
import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { formatLongDuration } from '../../lib/format.js';

const SORTS = [
  ['name', 'Name'],
  ['tracks', 'Track count'],
  ['albums', 'Album count'],
  ['duration', 'Playtime'],
];

// The full artist list is small enough to hold client-side (a thousand rows of
// four numbers), which buys instant filtering as you type instead of a request
// per keystroke. The tracks tab, which is two orders of magnitude bigger, pages
// on the server instead.
export default function ArtistsTab({ artists, sort, onSortChange, onSelect }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return artists;
    return artists.filter((a) => a.artist.toLowerCase().includes(needle));
  }, [artists, query]);

  const { page, setPage, pageCount, pageItems } = usePagination(filtered, 50);

  return (
    <>
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Filter artists…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter artists"
        />
        <SortSelect value={sort} options={SORTS} onChange={onSortChange} />
        <span className="muted">{filtered.length.toLocaleString()} shown</span>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">No artists match that filter.</p>
      ) : (
        <>
          <table className="library-table">
            <thead>
              <tr><th>Artist</th><th>Albums</th><th>Tracks</th><th>Playtime</th></tr>
            </thead>
            <tbody>
              {pageItems.map((a) => (
                <tr key={a.artist}>
                  <td>
                    <button type="button" className="link-button" onClick={() => onSelect(a.artist)}>
                      {a.artist}
                    </button>
                  </td>
                  <td className="mono">{a.albumCount}</td>
                  <td className="mono">{a.trackCount}</td>
                  <td className="mono">{formatLongDuration(a.totalDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </>
  );
}
