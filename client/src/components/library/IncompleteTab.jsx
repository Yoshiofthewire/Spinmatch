import { useMemo, useState } from 'react';
import Pagination from '../Pagination.jsx';
import { usePagination } from '../../lib/usePagination.js';
import { albumKey } from '../../lib/albumKey.js';

const REASONS = [
  ['gaps', 'Numbered gaps', 'Track numbers skip — those positions are missing.'],
  ['single', 'Single track', 'One file filed as a whole album, usually a stray download.'],
  ['unnumbered', 'No track numbers', "Nothing to check against — these files aren't numbered."],
];

// Entirely offline: computed from track numbers already in the index, so this
// works with no network and answers instantly even on a large library.
export default function IncompleteTab({ albums, onSelect }) {
  const [reason, setReason] = useState('gaps');

  const filtered = useMemo(
    () => albums.filter((a) => a.reason === reason),
    [albums, reason],
  );
  const { page, setPage, pageCount, pageItems } = usePagination(filtered, 50);
  const active = REASONS.find(([key]) => key === reason);

  return (
    <>
      <div className="library-toolbar">
        {REASONS.map(([key, label]) => {
          const count = albums.filter((a) => a.reason === key).length;
          return (
            <button
              key={key}
              type="button"
              className={`chip-button${reason === key ? ' chip-button-active' : ''}`}
              onClick={() => setReason(key)}
            >
              {label} ({count.toLocaleString()})
            </button>
          );
        })}
      </div>

      <p className="muted">
        {active?.[2]}
        {reason === 'gaps' && ' Open a missing position to look that track up on MusicBrainz and YouTube.'}
      </p>

      {filtered.length === 0 ? (
        <p className="muted">Nothing in this category.</p>
      ) : (
        <>
          <table className="library-table">
            <thead>
              <tr>
                <th>Artist</th><th>Album</th><th>Have</th>
                {reason === 'gaps' && <th>Missing</th>}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((a) => (
                <tr key={albumKey(a.artist, a.album)}>
                  <td>{a.artist ?? <span className="muted">Unknown</span>}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => onSelect(a)}>
                      {a.album}
                    </button>
                  </td>
                  <td className="mono">
                    {a.trackCount}{a.maxTrackNumber ? ` / ${a.maxTrackNumber}` : ''}
                  </td>
                  {reason === 'gaps' && (
                    <td className="mono">
                      {/* Each position opens the album, where the per-gap "Find
                          this track" button lives. A button per position here
                          instead would be hundreds of them on a page — and each
                          one a MusicBrainz call — on the one tab whose whole value
                          is being entirely offline. */}
                      {a.missingPositions.slice(0, 12).map((position, i) => (
                        <span key={position}>
                          {i > 0 && ', '}
                          <button type="button" className="link-button" onClick={() => onSelect(a)}>
                            {position}
                          </button>
                        </span>
                      ))}
                      {a.missingPositions.length > 12 && ` +${a.missingPositions.length - 12}`}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </>
  );
}
