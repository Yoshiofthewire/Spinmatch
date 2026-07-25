import { useMemo, useState } from 'react';
import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import LocalCover from './LocalCover.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { getLibraryAlbums } from '../../api/library.js';
import { useServerList } from '../../lib/useServerList.js';
import { usePagination } from '../../lib/usePagination.js';
import { albumKey } from '../../lib/albumKey.js';
import { formatLongDuration } from '../../lib/format.js';

const PAGE_SIZE = 24;

const SORTS = [
  ['artist', 'Artist'],
  ['album', 'Album title'],
  ['year', 'Year (newest)'],
  ['tracks', 'Track count'],
  ['added', 'Recently added'],
];

export default function AlbumsTab({ sort, onSortChange, onSelect, incomplete, incompleteKeys }) {
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  // The normal view is server-paged. "Incomplete only" is served from the
  // incomplete report the page already loaded instead: it's an inherently small
  // list, and filtering a server page by it would only ever filter the 24 albums
  // that happened to land on the current page.
  const list = useServerList({
    fetcher: ({ q, sort: s, limit, offset }) => getLibraryAlbums({ q, sort: s, limit, offset }),
    sort,
    pageSize: PAGE_SIZE,
    enabled: !onlyIncomplete,
  });

  const incompleteAlbums = useMemo(
    () => incomplete.filter((a) => a.reason === 'gaps'),
    [incomplete],
  );
  const localPage = usePagination(incompleteAlbums, PAGE_SIZE);

  const albums = onlyIncomplete ? localPage.pageItems : (list.data?.albums ?? []);
  const total = onlyIncomplete ? incompleteAlbums.length : list.total;
  const page = onlyIncomplete ? localPage.page : list.page;
  const pageCount = onlyIncomplete ? localPage.pageCount : list.pageCount;
  const setPage = onlyIncomplete ? localPage.setPage : list.setPage;
  const loading = !onlyIncomplete && list.state === 'loading';

  return (
    <>
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Filter albums…"
          value={list.query}
          onChange={(e) => list.setQuery(e.target.value)}
          aria-label="Filter albums"
          disabled={onlyIncomplete}
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
        <span className="muted">{total.toLocaleString()} shown</span>
      </div>

      {list.state === 'error' && !onlyIncomplete && (
        <p className="banner banner-error">{list.error}</p>
      )}
      {loading && <EqualizerLoader label="Loading albums…" />}

      {!loading && (albums.length === 0 ? (
        <p className="muted">
          {onlyIncomplete ? 'No albums have numbered gaps.' : 'No albums match that filter.'}
        </p>
      ) : (
        <>
          <div className="album-grid">
            {albums.map((a) => {
              const isIncomplete = incompleteKeys.has(albumKey(a.artist, a.album));
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
                  {isIncomplete && <span className="badge-incomplete">incomplete</span>}
                </button>
              );
            })}
          </div>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      ))}
    </>
  );
}
