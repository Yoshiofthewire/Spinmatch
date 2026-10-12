import { useTitle } from '../lib/useTitle.js';
import { useState } from 'react';
import { getHistory, clearHistory } from '../lib/history.js';

function actionLabel(action) {
  if (action === 'ingested') return 'Ingested';
  return 'Verified';
}

export default function HistoryPage() {
  useTitle('History');
  const [entries, setEntries] = useState(() => getHistory());
  const [confirmClear, setConfirmClear] = useState(false);

  function handleClear() {
    clearHistory();
    setEntries([]);
    setConfirmClear(false);
  }

  return (
    <div className="history-page">
      <h1>History</h1>
      {entries.length === 0 ? (
        <p className="muted">No history yet.</p>
      ) : (
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
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Artist</th>
                  <th>Action</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={i}>
                    <td>{entry.track}</td>
                    <td>{entry.artist}</td>
                    <td>{actionLabel(entry.action)}</td>
                    <td className="muted">{new Date(entry.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
