import { formatDuration } from '../lib/format.js';
import SendToMeTubeButton from './SendToMeTubeButton.jsx';
import Pagination from './Pagination.jsx';
import { usePagination } from '../lib/usePagination.js';

function statusLabel(status) {
  if (status === 'confirmed') return 'Confirmed';
  if (status === 'unverified') return 'Unverified (closest match)';
  return 'No results';
}

export default function VerifyResultsTable({ results }) {
  const { page, setPage, pageCount, pageItems } = usePagination(results, 20);

  return (
    <>
      <table className="verify-results-table">
        <thead>
          <tr>
            <th>Track</th>
            <th>MB Duration</th>
            <th>YouTube Link</th>
            <th>YouTube Duration</th>
            <th>Δ</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {pageItems.map((r) => (
            <tr key={r.position} className={`status-${r.status}`}>
              <td>{r.title}</td>
              <td>{formatDuration(r.lengthMs)}</td>
              <td>
                {r.video ? (
                  <span className="verify-result">
                    <a href={r.video.url} target="_blank" rel="noreferrer">
                      {r.video.title}
                    </a>
                    <SendToMeTubeButton url={r.video.url} />
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>{r.video ? formatDuration(r.video.durationMs) : '—'}</td>
              <td>{r.deltaSeconds != null ? `${r.deltaSeconds}s` : '—'}</td>
              <td>{statusLabel(r.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
