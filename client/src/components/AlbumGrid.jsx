import { Link } from 'react-router-dom';
import CoverArt from './CoverArt.jsx';
import Pagination from './Pagination.jsx';
import OwnedBadge from './OwnedBadge.jsx';
import { usePagination } from '../lib/usePagination.js';

// ownedMbids (optional): owned release-group ids to badge.
export default function AlbumGrid({ albums, ownedMbids }) {
  const { page, setPage, pageCount, pageItems } = usePagination(albums, 20);

  if (albums.length === 0) return <p className="muted">No studio albums found for this artist.</p>;

  return (
    <>
      <div className="album-grid">
        {pageItems.map((album) => (
          <Link key={album.mbid} className="album-card" to={`/release-group/${album.mbid}`}>
            <CoverArt src={album.coverArtUrl} alt={album.title} />
            <span className="album-title">{album.title}</span>
            {album.firstReleaseDate && <span className="muted">{album.firstReleaseDate.slice(0, 4)}</span>}
            <OwnedBadge owned={Boolean(ownedMbids?.has(album.mbid))} label="In your library" />
          </Link>
        ))}
      </div>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
