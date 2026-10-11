import { useState } from 'react';
import { useTitle } from '../lib/useTitle.js';
import { useServerList } from '../lib/useServerList.js';
import { getHistory, clearHistory } from '../api/history.js';
import Pagination from '../components/Pagination.jsx';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { HistoryStatus, YouTubeLink } from '../components/HistoryEntry.jsx';

export default function HistoryPage() {
  useTitle('History');
  const list = useServerList({ fetcher: getHistory, pageSize: 50 });
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearError, setClearError] = useState(null);

  async function handleClear() {
    setConfirmClear(false);
    setClearError(null);
    try {
      await clearHistory();
      list.setPage(1);
      list.reload();
    } catch (err) {
      setClearError(err.message);
    }
  }

  let body;
  if (list.state === 'error') body = <ErrorBanner message={list.error} onRetry={list.reload} />;
  else if (!list.data) body = <EqualizerLoader label="Loading history…" />;
  else if (list.total === 0) body = <p className="muted">No history yet.</p>;
  else {
    body = (
      <>
        <div className="bulk-verify-actions">
          {!confirmClear ? (
            <button type="button" onClick={() => setConfirmClear(true)}>Clear All</button>
          ) : (
            <span className="inline-confirm">
              <span className="muted">Clear all history? This can&apos;t be undone.</span>
              <button type="button" className="chip-button" onClick={handleClear}>Confirm</button>
              <button type="button" className="link-button" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>
        {clearError && <ErrorBanner message={clearError} />}
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Track</th><th>Artist</th><th>Action</th><th>Result</th><th>When</th></tr>
            </thead>
            <tbody>
              {list.data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.title}</td>
                  <td>{entry.artist}</td>
                  <td>{entry.action === 'ingested' ? 'Ingested' : 'Verified'}</td>
                  <td>
                    <HistoryStatus status={entry.status} /> <YouTubeLink videoId={entry.videoId} />
                  </td>
                  <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={list.page} pageCount={list.pageCount} onChange={list.setPage} />
      </>
    );
  }

  return (
    <div className="history-page">
      <h1>History</h1>
      {body}
    </div>
  );
}
