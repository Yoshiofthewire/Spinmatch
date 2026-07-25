import { useNavigate } from 'react-router-dom';
import CoverArt from './CoverArt.jsx';
import Pagination from './Pagination.jsx';
import OwnedBadge from './OwnedBadge.jsx';
import { usePagination } from '../lib/usePagination.js';

// ownedMbids: release-group ids already in the local library, badged so an
// artist's discography shows at a glance what's already on disk. Optional — the
// grid works unchanged without it.
export default function AlbumGrid({ albums, ownedMbids }) {
  const navigate = useNavigate();
  const { page, setPage, pageCount, pageItems } = usePagination(albums, 20);

  if (albums.length === 0) return <p className="muted">No studio albums found for this artist.</p>;

  return (
    <>
      <div className="album-grid">
        {pageItems.map((album) => (
          <button key={album.mbid} className="album-card" onClick={() => navigate(`/release-group/${album.mbid}`)}>
            <CoverArt src={album.coverArtUrl} alt={album.title} />
            <span className="album-title">{album.title}</span>
            {album.firstReleaseDate && <span className="muted">{album.firstReleaseDate.slice(0, 4)}</span>}
            <OwnedBadge owned={Boolean(ownedMbids?.has(album.mbid))} label="In your library" />
          </button>
        ))}
      </div>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
