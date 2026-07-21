import { useNavigate } from 'react-router-dom';
import CoverArt from './CoverArt.jsx';
import Pagination from './Pagination.jsx';
import { usePagination } from '../lib/usePagination.js';

export default function AlbumGrid({ albums }) {
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
          </button>
        ))}
      </div>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
