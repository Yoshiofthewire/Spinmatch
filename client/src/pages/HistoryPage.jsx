import { useState } from 'react';
import { getHistory, clearHistory } from '../lib/history.js';

function actionLabel(action) {
  return action === 'sent' ? 'Sent to MeTube' : 'Verified';
}

export default function HistoryPage() {
  const [entries, setEntries] = useState(() => getHistory());

  function handleClear() {
    clearHistory();
    setEntries([]);
  }

  return (
    <div className="history-page">
      <h1>History</h1>
      {entries.length === 0 ? (
        <p className="muted">No history yet.</p>
      ) : (
        <>
          <div className="bulk-verify-actions">
            <button type="button" onClick={handleClear}>Clear All</button>
          </div>
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
        </>
      )}
    </div>
  );
}
