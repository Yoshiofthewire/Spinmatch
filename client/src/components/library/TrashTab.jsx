import { useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import ErrorBanner from '../ErrorBanner.jsx';
import { useServerList } from '../../lib/useServerList.js';
import { formatBytes } from '../../lib/format.js';
import { listTrash, restoreFromTrash } from '../../api/library.js';

// Read-only view of .spinmatch-trash. Restore only; deleting is left to the user.
export default function TrashTab({ onRestored }) {
  const list = useServerList({ fetcher: listTrash, pageSize: 100 });
  const [results, setResults] = useState({}); // relPath -> 'restored' | error message
  const [pending, setPending] = useState(null);

  async function restore(relPath) {
    setPending(relPath);
    try {
      await restoreFromTrash(relPath);
      setResults((prev) => ({ ...prev, [relPath]: 'restored' }));
      onRestored?.();
    } catch (err) {
      setResults((prev) => ({ ...prev, [relPath]: err.message }));
    } finally {
      setPending(null);
    }
  }

  if (list.state === 'error') return <ErrorBanner message={list.error} onRetry={list.reload} />;
  if (!list.data) return <EqualizerLoader label="Loading the trash…" />;
  if (list.total === 0) return <p className="muted">Nothing has been moved aside.</p>;

  const { count, bytes } = list.data.totals;
  return (
    <>
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
              const result = results[e.relPath];
              return (
                <tr key={e.relPath}>
                  <td className="mono">{e.originalPath}</td>
                  <td className="mono">{formatBytes(e.size)}</td>
                  <td className="mono">{new Date(e.mtimeMs).toLocaleString()}</td>
                  <td>
                    {/* Not refetched after a restore, so the row keeps showing its result. */}
                    {result === 'restored' ? <span className="muted">Restored</span> : (
                      <>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => restore(e.relPath)}
                          disabled={pending === e.relPath}
                        >
                          {pending === e.relPath ? 'Restoring…' : 'Restore'}
                        </button>
                        {!result && !e.restorable && (
                          <span className="muted"> Something is already at the original path.</span>
                        )}
                        {result && <span className="banner banner-error">{result}</span>}
                      </>
                    )}
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
