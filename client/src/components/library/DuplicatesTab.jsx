import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates } from '../../api/library.js';
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
// Deliberately read-only: Spinmatch never deletes a file, so this view shows you
// what you have and leaves the decision (and the deletion) to you.
export default function DuplicatesTab({ onPlay }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const { page, setPage, pageCount, pageItems } = usePagination(groups ?? [], 20);

  useEffect(() => {
    let cancelled = false;
    getDuplicates()
      .then((data) => { if (!cancelled) setGroups(data.groups); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

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
        counted as a duplicate. <strong>Spinmatch never deletes files;</strong> play the copies to
        compare them and remove what you don&apos;t want yourself.
      </p>

      {pageItems.map((group) => (
        <div key={`${group.artist}-${group.album}-${group.title}`} className="duplicate-group">
          <h3>
            {group.title}
            <span className="muted">— {group.artist} · {group.album ?? 'No album'}</span>
            <span className="badge badge-none">{group.copies.length} copies</span>
          </h3>
          <table className="library-table">
            <thead>
              <tr>
                <th aria-label="Play" /><th>#</th><th>Length</th>
                <th>Format</th><th>Size</th><th>Path</th>
              </tr>
            </thead>
            <tbody>
              {group.copies.map((copy) => (
                <tr key={copy.id}>
                  <td>
                    {/* The album no longer tells two copies apart — they share it — and neither
                        does the format when a folder was simply copied twice. The path does. */}
                    <button
                      type="button"
                      className="play-button"
                      onClick={() => onPlay(copy, group.copies)}
                      aria-label={`Play ${copy.title} — ${copy.path}`}
                    >
                      ▶
                    </button>
                  </td>
                  <td className="mono">{copy.trackNumber ?? '—'}</td>
                  <td className="mono">{formatDuration(copy.durationMs)}</td>
                  <td className="mono">{copy.ext ?? '—'}</td>
                  <td className="mono">{copy.sizeBytes ? formatBytes(copy.sizeBytes) : '—'}</td>
                  <td className="mono duplicate-path">{copy.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Pagination page={page} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
