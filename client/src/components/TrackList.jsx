import VerifyButton from './VerifyButton.jsx';
import Pagination from './Pagination.jsx';
import { usePagination } from '../lib/usePagination.js';
import { formatDuration } from '../lib/format.js';

export default function TrackList({ artist, album, tracks }) {
  const { page, setPage, pageCount, pageItems } = usePagination(tracks, 20);

  return (
    <>
      <table className="track-list">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Length</th>
            <th>YouTube</th>
          </tr>
        </thead>
        <tbody>
          {pageItems.map((track) => (
            <tr key={track.position}>
              <td>{track.position}</td>
              <td>{track.title}</td>
              <td>{formatDuration(track.lengthMs)}</td>
              <td>
                {track.lengthMs != null ? (
                  <VerifyButton artist={artist} title={track.title} album={album} lengthMs={track.lengthMs} />
                ) : (
                  <span className="muted">No duration data</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
