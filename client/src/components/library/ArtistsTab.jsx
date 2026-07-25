import Pagination from '../Pagination.jsx';
import SortSelect from './SortSelect.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { getLibraryArtists } from '../../api/library.js';
import { useServerList } from '../../lib/useServerList.js';
import { formatLongDuration } from '../../lib/format.js';

const PAGE_SIZE = 50;

const SORTS = [
  ['name', 'Name'],
  ['tracks', 'Track count'],
  ['albums', 'Album count'],
  ['duration', 'Playtime'],
];

// Filtered and paged on the server, like the tracks tab. Holding the whole list
// client-side bought instant filtering at demo scale, and cost a response
// carrying every artist in the collection on every visit to the page.
export default function ArtistsTab({ sort, onSortChange, onSelect }) {
  const list = useServerList({
    fetcher: ({ q, sort: s, limit, offset }) => getLibraryArtists({ q, sort: s, limit, offset }),
    sort,
    pageSize: PAGE_SIZE,
  });
  const artists = list.data?.artists ?? [];

  return (
    <>
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Filter artists…"
          value={list.query}
          onChange={(e) => list.setQuery(e.target.value)}
          aria-label="Filter artists"
        />
        <SortSelect value={sort} options={SORTS} onChange={onSortChange} />
        {list.data && <span className="muted">{list.total.toLocaleString()} shown</span>}
      </div>

      {list.state === 'error' && <p className="banner banner-error">{list.error}</p>}
      {list.state === 'loading' && <EqualizerLoader label="Loading artists…" />}

      {list.state === 'ready' && (artists.length === 0 ? (
        <p className="muted">No artists match that filter.</p>
      ) : (
        <>
          <table className="library-table">
            <thead>
              <tr><th>Artist</th><th>Albums</th><th>Tracks</th><th>Playtime</th></tr>
            </thead>
            <tbody>
              {artists.map((a) => (
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
          <Pagination page={list.page} pageCount={list.pageCount} onChange={list.setPage} />
        </>
      ))}
    </>
  );
}
