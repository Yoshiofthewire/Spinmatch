import { useMemo, useState } from 'react';
import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import LocalCover from './LocalCover.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { albumKey } from '../../lib/albumKey.js';
import { formatLongDuration } from '../../lib/format.js';

const SORTS = [
  ['artist', 'Artist'],
  ['album', 'Album title'],
  ['year', 'Year (newest)'],
  ['tracks', 'Track count'],
  ['added', 'Recently added'],
];

export default function AlbumsTab({ albums, sort, onSortChange, onSelect, incompleteKeys }) {
  const [query, setQuery] = useState('');
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return albums.filter((a) => {
      if (onlyIncomplete && !incompleteKeys.has(albumKey(a.artist, a.album))) return false;
      if (!needle) return true;
      return a.album.toLowerCase().includes(needle)
        || String(a.artist ?? '').toLowerCase().includes(needle);
    });
  }, [albums, query, onlyIncomplete, incompleteKeys]);

  const { page, setPage, pageCount, pageItems } = usePagination(filtered, 24);

  return (
    <>
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Filter albums…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter albums"
        />
        <SortSelect value={sort} options={SORTS} onChange={onSortChange} />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={onlyIncomplete}
            onChange={(e) => setOnlyIncomplete(e.target.checked)}
          />
          Incomplete only
        </label>
        <span className="muted">{filtered.length.toLocaleString()} shown</span>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">No albums match that filter.</p>
      ) : (
        <>
          <div className="album-grid">
            {pageItems.map((a) => {
              const incomplete = incompleteKeys.has(albumKey(a.artist, a.album));
              return (
                <button
                  key={albumKey(a.artist, a.album)}
                  className="album-card"
                  onClick={() => onSelect(a)}
                >
                  <LocalCover trackId={a.coverTrackId} alt={a.album} />
                  <span className="album-title">{a.album}</span>
                  <span className="muted">{a.artist ?? 'Unknown artist'}</span>
                  <span className="muted album-card-meta">
                    {a.year ? `${a.year} · ` : ''}{a.trackCount} track{a.trackCount === 1 ? '' : 's'}
                    {a.totalDurationMs ? ` · ${formatLongDuration(a.totalDurationMs)}` : ''}
                  </span>
                  {incomplete && <span className="badge-incomplete">incomplete</span>}
                </button>
              );
            })}
          </div>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </>
  );
}
