import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import ErrorBanner from '../ErrorBanner.jsx';
import UndoChange from './UndoChange.jsx';
import { useServerList } from '../../lib/useServerList.js';
import { listChanges } from '../../api/library.js';

// History of tag writes (edits and fixes), each undoable once.
export default function ChangesTab({ onUndone }) {
  const list = useServerList({ fetcher: listChanges, pageSize: 50 });

  if (list.state === 'error') return <ErrorBanner message={list.error} onRetry={list.reload} />;
  if (!list.data) return <EqualizerLoader label="Loading changes…" />;
  if (list.total === 0) return <p className="muted">No tag changes yet.</p>;

  return (
    <>
      <p className="muted">
        Tag edits and fixes from the last 90 days (up to 500). Undo skips any file that changed
        after the edit.
      </p>
      <table className="library-table">
        <thead>
          <tr><th>When</th><th>Change</th><th>Files</th><th /></tr>
        </thead>
        <tbody>
          {list.data.changes.map((c) => (
            <tr key={c.id}>
              <td className="mono">{new Date(c.createdAt).toLocaleString()}</td>
              <td>{c.label}</td>
              <td className="mono">{c.files}</td>
              <td>
                {/* Not refetched after an undo, so the row keeps showing its result. */}
                {c.undoneAt
                  ? <span className="muted">Undone {new Date(c.undoneAt).toLocaleString()}</span>
                  : <UndoChange batchId={c.id} onUndone={onUndone} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={list.page} pageCount={list.pageCount} onChange={list.setPage} />
    </>
  );
}
