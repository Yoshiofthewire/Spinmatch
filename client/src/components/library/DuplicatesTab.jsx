import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates, trashDuplicate, restoreDuplicate } from '../../api/library.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// Every copy of the same track from the same release, laid out so they can
// actually be compared — a count alone can't tell you whether you have a FLAC
// and a 128k MP3 of one album track or something you'd rather keep both of.
//
// A song that appears on two different albums never reaches this view: owning a
// track on its album and again on a compilation is owning two records, not two
// copies. Album is part of the match server-side, in libraryRepo's
// duplicateGroups.
//
// "Move aside" relocates a copy into MUSIC_DIR/.spinmatch-trash, which mirrors
// the library layout. Spinmatch still never deletes a file: every byte is still
// there, and reclaiming the space is something the user does themselves, once
// they've had a chance to change their mind.
export default function DuplicatesTab({ onPlay }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  // trackId -> where it was moved to. The whole move-aside UI derives from this:
  // which rows are struck through, what each group's live count is, and which
  // rows can still be moved.
  const [trashed, setTrashed] = useState({});
  // trackId -> true while that row has a request in flight, so one click can't
  // be double-fired. Keyed per row rather than a single value — a single value
  // would un-busy row A the moment row B was clicked, letting a still-in-flight
  // move-aside on A be re-fired.
  const [busy, setBusy] = useState({});
  // Group key -> message. Per group rather than per page, so one group's failure
  // doesn't blank the rest of the list.
  const [groupErrors, setGroupErrors] = useState({});
  const { page, setPage, pageCount, pageItems } = usePagination(groups ?? [], 20);

  useEffect(() => {
    let cancelled = false;
    getDuplicates()
      .then((data) => { if (!cancelled) setGroups(data.groups); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

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

  if (error) return <p className="banner banner-error">{error}</p>;
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
              {/* Not `group.copies.length` any more: once a copy is moved aside the
                  count has to drop, and it can now legitimately reach 1. */}
              <span className="badge badge-none">
                {liveCopies} {liveCopies === 1 ? 'copy' : 'copies'}
              </span>
            </h3>
            {groupError ? <p className="banner banner-error">{groupError}</p> : null}
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
                        {/* The album no longer tells two copies apart — they share it — and neither
                            does the format when a folder was simply copied twice. The path does. */}
                        <button
                          type="button"
                          className="play-button"
                          onClick={() => onPlay(copy, group.copies)}
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
        );
      })}

      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
