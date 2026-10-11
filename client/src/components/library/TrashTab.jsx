import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import ErrorBanner from '../ErrorBanner.jsx';
import { useServerList } from '../../lib/useServerList.js';
import { formatBytes } from '../../lib/format.js';
import { listTrash, restoreFromTrash } from '../../api/library.js';

// Read-only view of .spinmatch-trash. Restore only; deleting is left to the user.
export default function TrashTab({ onRestored }) {
  const list = useServerList({ fetcher: listTrash, pageSize: 100 });
  const [errors, setErrors] = useState({}); // relPath -> message
  const [pending, setPending] = useState(() => new Set());
  const [restored, setRestored] = useState([]); // original paths, newest first

  // A restore can empty the last page; step back rather than show nothing.
  const { page, pageCount, setPage } = list;
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount, setPage]);

  const setRowPending = (relPath, on) => setPending((prev) => {
    const next = new Set(prev);
    if (on) next.add(relPath); else next.delete(relPath);
    return next;
  });

  async function restore(entry) {
    const { relPath } = entry;
    setRowPending(relPath, true);
    setErrors(({ [relPath]: _, ...rest }) => rest);
    try {
      await restoreFromTrash(relPath);
      setRestored((prev) => [entry.originalPath, ...prev]);
      // Refetch so paging and totals come from the server, not a patched cache.
      list.reload();
      onRestored?.();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [relPath]: err.message }));
    } finally {
      setRowPending(relPath, false);
    }
  }

  const notes = restored.length > 0 && (
    <p className="banner" role="status">Restored: {restored.join(', ')}</p>
  );

  if (list.state === 'error') return <ErrorBanner message={list.error} onRetry={list.reload} />;
  if (!list.data) return <EqualizerLoader label="Loading the trash…" />;
  if (list.total === 0) return <>{notes}<p className="muted">Nothing has been moved aside.</p></>;

  const { count, bytes } = list.data.totals;
  return (
    <>
      {notes}
      <p className="muted">
        {count.toLocaleString()} file{count === 1 ? '' : 's'} ({formatBytes(bytes)}) moved aside
        to <span className="mono">.spinmatch-trash</span> in your music folder. Spinmatch never
        deletes them; delete files there yourself to get the space back.
      </p>
      <div className="table-scroll">
        <table className="library-table">
          <thead>
            <tr><th>Original path</th><th>Size</th><th>Modified</th><th /></tr>
          </thead>
          <tbody>
            {list.data.entries.map((e) => {
              const error = errors[e.relPath];
              const busy = pending.has(e.relPath);
              return (
                <tr key={e.relPath}>
                  <td className="mono">{e.originalPath}</td>
                  <td className="mono">{formatBytes(e.size)}</td>
                  <td className="mono">{new Date(e.mtimeMs).toLocaleString()}</td>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => restore(e)}
                      disabled={busy}
                    >
                      {busy ? 'Restoring…' : 'Restore'}
                    </button>
                    {!error && !e.restorable && (
                      <span className="muted"> Something is already at the original path.</span>
                    )}
                    {error && <span className="banner banner-error">{error}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={list.page} pageCount={list.pageCount} onChange={list.setPage} />
    </>
  );
}
