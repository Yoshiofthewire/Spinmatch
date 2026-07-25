import { useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import { previewBulkFix, applyBulkFix } from '../../api/library.js';

// Repairs a whole album's tags in one pass.
//
// Preview first, always. The single-track picker shows you one MusicBrainz
// candidate at a time and you decide; at album scale that decision has to be
// made once over a table, so the proposal is rendered in full — with every
// proposed value visible next to the file it would be written to — and nothing
// is sent until rows are ticked and Apply is pressed.
//
// Two sources, because they fail in opposite directions. Reading the file's path
// costs nothing and works on files with no tags at all, which is exactly the
// Health tab's population, but it only knows what the folders say. MusicBrainz
// knows the real tracklist but has to resolve the album first, which needs the
// album tag to already be roughly right.
const SOURCES = [
  ['path', 'From file paths', 'Reads artist, album, track number and title from where each file sits. No network.'],
  ['musicbrainz', 'From MusicBrainz', 'Resolves the album once and aligns your files to its official tracklist.'],
];

// Fields a proposal can carry, in the order they're shown.
const FIELDS = ['artist', 'album', 'title', 'trackNumber', 'disc', 'year'];

function Cell({ track, field }) {
  const proposed = track.proposed?.[field] ?? null;
  const willFill = track.fills.includes(field);
  if (willFill) return <td className="bulk-fix-fill">{proposed}</td>;
  // A value the file already has is shown greyed rather than hidden, so the
  // table reads as the whole album rather than only its holes.
  const current = track.current?.[field] ?? null;
  return <td className="muted">{current ?? '—'}</td>;
}

export default function BulkFixPanel({ artist, album, onApplied }) {
  const [source, setSource] = useState('path');
  const [state, setState] = useState('idle'); // idle | loading | ready | applying | done | error
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function load(nextSource) {
    setSource(nextSource);
    setState('loading');
    setError(null);
    setResult(null);
    try {
      const data = await previewBulkFix({ artist, album, source: nextSource });
      setPreview(data);
      // Everything that would actually change starts ticked — the common case is
      // "yes, all of that" and unticking the exceptions is less work than
      // ticking twenty rows.
      setSelected(new Set(data.tracks.filter((t) => t.fills.length > 0).map((t) => t.trackId)));
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  async function apply() {
    setState('applying');
    setError(null);
    try {
      const applied = await applyBulkFix({ artist, album, source, trackIds: [...selected] });
      setResult(applied);
      setState('done');
      onApplied?.();
    } catch (err) {
      setError(err);
      setState('error');
    }
  }

  function toggle(trackId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId); else next.add(trackId);
      return next;
    });
  }

  const fixable = preview?.tracks.filter((t) => t.fills.length > 0) ?? [];
  const allSelected = fixable.length > 0 && fixable.every((t) => selected.has(t.trackId));

  return (
    <div className="gap-panel">
      <h3>Fix this album&apos;s tags</h3>

      {state === 'idle' && (
        <>
          <p className="muted">
            Fills the tags this album&apos;s files are missing, in one pass. Only ever fills
            what is empty — an existing tag is never overwritten, and nothing is moved
            or renamed.
          </p>
          <div className="bulk-fix-sources">
            {SOURCES.map(([key, label, hint]) => (
              <button key={key} type="button" onClick={() => load(key)} title={hint}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {state === 'loading' && <EqualizerLoader label="Working out what's missing…" />}
      {state === 'applying' && <EqualizerLoader label="Writing tags…" />}

      {error && (
        <>
          <p className={`banner ${error.code === 'RATE_LIMITED' ? 'banner-rate-limited' : 'banner-error'}`}>
            {error.message}
          </p>
          <button type="button" onClick={() => load(source)}>Try again</button>
        </>
      )}

      {state === 'done' && result && (
        <>
          <p className="banner banner-success">
            {result.applied.length === 0
              ? 'Nothing needed changing.'
              : `Repaired ${result.applied.length} file${result.applied.length === 1 ? '' : 's'}.`}
          </p>
          {/* A run no longer stops at the first unwritable file, so the ones it
              couldn't do have to be said out loud — otherwise "Repaired 12
              files" out of 14 selected reads as complete success. */}
          {result.failed?.length > 0 && (
            <div className="banner banner-error">
              <p>
                {`${result.failed.length} file${result.failed.length === 1 ? '' : 's'} could not be written:`}
              </p>
              <ul>
                {result.failed.map((f) => (
                  <li key={f.trackId} className="mono">{f.message}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {(state === 'ready' || state === 'applying' || state === 'done') && preview && (
        preview.unresolved ? (
          <p className="muted">
            Couldn&apos;t match “{album}” to a MusicBrainz release group. Try the file-path
            source, or fix the album tag first.
          </p>
        ) : preview.tracks.length === 0 ? (
          <p className="muted">No tracks in this album.</p>
        ) : fixable.length === 0 ? (
          <p className="muted">
            Every file in this album already carries the tags this source can supply.
          </p>
        ) : (
          <>
            <p className="muted">
              {fixable.length} of {preview.tracks.length} file
              {preview.tracks.length === 1 ? '' : 's'} would change. Highlighted values are
              what would be written; greyed ones are already on the file and stay as they are.
            </p>

            <table className="library-table bulk-fix-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      aria-label="Select every file that would change"
                      onChange={() => setSelected(allSelected
                        ? new Set()
                        : new Set(fixable.map((t) => t.trackId)))}
                    />
                  </th>
                  <th>File</th>
                  <th>Artist</th><th>Album</th><th>Title</th><th>#</th><th>Disc</th><th>Year</th>
                </tr>
              </thead>
              <tbody>
                {preview.tracks.map((track) => (
                  <tr key={track.trackId} className={track.fills.length ? undefined : 'bulk-fix-unchanged'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(track.trackId)}
                        disabled={track.fills.length === 0 || track.unreadable}
                        aria-label={`Repair ${track.path}`}
                        onChange={() => toggle(track.trackId)}
                      />
                    </td>
                    <td className="muted mono fix-path">{track.path.split('/').pop()}</td>
                    {track.unreadable
                      ? <td className="muted" colSpan={6}>couldn&apos;t read this file&apos;s tags</td>
                      : FIELDS.map((field) => <Cell key={field} track={track} field={field} />)}
                  </tr>
                ))}
              </tbody>
            </table>

            {state !== 'done' && (
              <div className="bulk-verify-actions">
                <button type="button" disabled={selected.size === 0 || state === 'applying'} onClick={apply}>
                  {state === 'applying'
                    ? 'Writing…'
                    : `Fix ${selected.size} file${selected.size === 1 ? '' : 's'}`}
                </button>
                <button
                  type="button"
                  className="chip-button"
                  onClick={() => load(source === 'path' ? 'musicbrainz' : 'path')}
                >
                  Try the {source === 'path' ? 'MusicBrainz' : 'file path'} source instead
                </button>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
