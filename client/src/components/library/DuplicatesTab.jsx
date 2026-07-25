import { useEffect, useState } from 'react';
import Pagination from '../Pagination.jsx';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { getDuplicates } from '../../api/library.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// The same artist and title at more than one path, with every copy laid out so
// they can actually be compared — a count alone can't tell you whether you have
// a FLAC and a 128k MP3 of the same song or two legitimately different
// recordings that happen to share a title.
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
  if (groups.length === 0) return <p className="muted">No duplicate artist/title pairs found.</p>;

  return (
    <>
      <p className="muted">
        {groups.length.toLocaleString()} artist/title pair{groups.length === 1 ? '' : 's'} appear
        at more than one path. Often legitimate — an album track that also shows up on a
        compilation or soundtrack. <strong>Spinmatch never deletes files;</strong> play the
        copies to compare them and remove what you don&apos;t want yourself.
      </p>

      {pageItems.map((group) => (
        <div key={`${group.artist}-${group.title}`} className="duplicate-group">
          <h3>
            {group.title} <span className="muted">— {group.artist}</span>
            <span className="badge badge-none">{group.copies.length} copies</span>
          </h3>
          <table className="library-table">
            <thead>
              <tr>
                <th aria-label="Play" /><th>Album</th><th>#</th><th>Length</th>
                <th>Format</th><th>Size</th><th>Path</th>
              </tr>
            </thead>
            <tbody>
              {group.copies.map((copy) => (
                <tr key={copy.id}>
                  <td>
                    <button
                      type="button"
                      className="play-button"
                      onClick={() => onPlay(copy, group.copies)}
                      aria-label={`Play ${copy.title} from ${copy.album ?? 'unknown album'}`}
                    >
                      ▶
                    </button>
                  </td>
                  <td>{copy.album ?? <span className="muted">—</span>}</td>
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
