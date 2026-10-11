import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import ErrorBanner from '../ErrorBanner.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates, trashDuplicate, restoreDuplicate } from '../../api/library.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// Copies of one track on the same album (album is part of the match; see
// libraryRepo duplicateGroups). "Move aside" moves to MUSIC_DIR/.spinmatch-trash;
// Spinmatch never deletes.
export default function DuplicatesTab({ onPlay }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  // trackId -> moved-to path. All move-aside UI state derives from this.
  const [trashed, setTrashed] = useState({});
  // trackId -> in flight. Per row, so clicking B can't un-busy A.
  const [busy, setBusy] = useState({});
  // Group key -> error message.
  const [groupErrors, setGroupErrors] = useState({});
  const { page, setPage, pageCount, pageItems } = usePagination(groups ?? [], 20);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getDuplicates()
      .then((data) => { if (!cancelled) setGroups(data.groups); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [attempt]);

  const keyFor = (group) => `${group.artist}-${group.album}-${group.title}`;

  async function run(group, copy, action) {
    setBusy((prev) => ({ ...prev, [copy.id]: true }));
    setGroupErrors((prev) => ({ ...prev, [keyFor(group)]: null }));
    try {
      await action();
    } catch (err) {
      setGroupErrors((prev) => ({ ...prev, [keyFor(group)]: err.message }));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[copy.id];
        return next;
      });
    }
  }

  const moveAside = (group, copy) => run(group, copy, async () => {
    const { trashedPath } = await trashDuplicate(copy.id);
    setTrashed((prev) => ({ ...prev, [copy.id]: trashedPath }));
  });

  const undo = (group, copy) => run(group, copy, async () => {
    await restoreDuplicate(copy.id);
    setTrashed((prev) => {
      const next = { ...prev };
      delete next[copy.id];
      return next;
    });
  });

  if (error) return <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!groups) return <EqualizerLoader label="Finding duplicates…" />;
  if (groups.length === 0) {
    return <p className="muted">No duplicates — no track is indexed at more than one path within the same release.</p>;
  }

  return (
    <>
      <p className="muted">
        {groups.length.toLocaleString()} track{groups.length === 1 ? '' : 's'} indexed at more than
        one path within the same release. A song that also appears on a different album isn&apos;t
        counted as a duplicate. <strong>Spinmatch never deletes files;</strong> moving a copy aside
        puts it in <span className="mono">.spinmatch-trash</span> inside your music folder, where it
        keeps its artist and album layout. Delete that folder yourself when you want the space back.
      </p>

      {pageItems.map((group) => {
        const liveCopies = group.copies.filter((copy) => !trashed[copy.id]).length;
        const groupError = groupErrors[keyFor(group)];
        return (
          <div key={keyFor(group)} className="duplicate-group">
            <h3>
              {group.title}
              <span className="muted">— {group.artist} · {group.album ?? 'No album'}</span>
              {/* Live count: drops as copies are moved aside, can reach 1. */}
              <span className="badge badge-none">
                {liveCopies} {liveCopies === 1 ? 'copy' : 'copies'}
              </span>
            </h3>
            {groupError ? <p className="banner banner-error">{groupError}</p> : null}
            <div className="table-scroll">
              <table className="library-table">
                <thead>
                  <tr>
                    <th aria-label="Play" /><th>#</th><th>Length</th>
                    <th>Format</th><th>Size</th><th>Path</th><th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {group.copies.map((copy) => {
                    const trashedPath = trashed[copy.id];
                    return (
                      <tr key={copy.id} className={trashedPath ? 'duplicate-copy-trashed' : undefined}>
                        <td>
                          {/* Copies share the album and often the format; the path tells them apart. */}
                          <button
                            type="button"
                            className="play-button"
                            onClick={() => onPlay(copy, group.copies.filter((c) => !trashed[c.id]))}
                            disabled={Boolean(trashedPath)}
                            aria-label={`Play ${copy.title} — ${copy.path}`}
                          >
                            ▶
                          </button>
                        </td>
                        <td className="mono">{copy.trackNumber ?? '—'}</td>
                        <td className="mono">{formatDuration(copy.durationMs)}</td>
                        <td className="mono">{copy.ext ?? '—'}</td>
                        <td className="mono">{copy.sizeBytes ? formatBytes(copy.sizeBytes) : '—'}</td>
                        <td className="mono duplicate-path">{trashedPath ?? copy.path}</td>
                        <td>
                          {trashedPath ? (
                            <>
                              <span className="muted">Moved aside. </span>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => undo(group, copy)}
                                disabled={Boolean(busy[copy.id])}
                              >
                                Undo
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="copy-button"
                              onClick={() => moveAside(group, copy)}
                              disabled={Boolean(busy[copy.id]) || liveCopies < 2}
                              title={liveCopies < 2
                                ? 'This is the only copy left — Spinmatch will not move it aside.'
                                : 'Move this copy into .spinmatch-trash'}
                            >
                              {busy[copy.id] ? 'Moving…' : 'Move aside'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
