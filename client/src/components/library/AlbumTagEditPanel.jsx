import { useMemo, useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import WriteResultBanner from './WriteResultBanner.jsx';
import { editAlbumTags } from '../../api/library.js';
import {
  TAG_FIELDS, ALBUM_WIDE_KEYS, PER_TRACK_KEYS, toFormValue, rowState, patchFrom,
} from '../../lib/tagFields.js';

const VARIES = Symbol('varies');

// The shared value, or VARIES. A varying field starts blank so one value can't
// be accidentally written over the rest.
function commonValue(tracks, key) {
  if (!tracks.length) return null;
  const first = tracks[0][key] ?? null;
  return tracks.every((t) => (t[key] ?? null) === first) ? first : VARIES;
}

// Hand-edit a whole album's tags. No server preview (you typed the values); a
// confirm step stands in for it.
export default function AlbumTagEditPanel({ artist, album, tracks, onSaved, onCancel }) {
  const albumCurrent = useMemo(
    () => Object.fromEntries(ALBUM_WIDE_KEYS.map((key) => [key, commonValue(tracks, key)])),
    [tracks],
  );

  const [albumValues, setAlbumValues] = useState(() => Object.fromEntries(
    ALBUM_WIDE_KEYS.map((key) => [
      key, albumCurrent[key] === VARIES ? '' : toFormValue(albumCurrent[key]),
    ]),
  ));
  const [rows, setRows] = useState(() => Object.fromEntries(tracks.map((t) => [t.id, initialRow(t)])));
  // The panel outlives a tracklist reload (so a save's result survives); a track a
  // rescan found since gets its form row on first use, and starts unticked.
  const rowFor = (t) => rows[t.id] ?? initialRow(t);
  const [included, setIncluded] = useState(() => new Set(tracks.map((t) => t.id)));
  const [stage, setStage] = useState('edit'); // edit | confirm | saving | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Anything typed into a varying field is a change.
  const albumChanges = ALBUM_WIDE_KEYS.filter((key) => (
    albumCurrent[key] === VARIES
      ? albumValues[key].trim() !== ''
      : rowState(albumCurrent[key], albumValues[key]) === 'set'
  ));

  const albumPatch = Object.fromEntries(
    albumChanges.map((key) => [key, albumValues[key].trim()]),
  );

  const perTrack = tracks
    .filter((t) => included.has(t.id))
    .map((t) => ({
      trackId: t.id,
      fields: patchFrom(rowFor(t), {
        title: t.titleSynthesized ? null : t.title,
        trackNumber: t.trackNumber,
      }, PER_TRACK_KEYS),
    }))
    .filter((entry) => Object.keys(entry.fields).length > 0);

  const chosen = tracks.filter((t) => included.has(t.id));
  const willWrite = (albumChanges.length ? chosen.length : 0) || perTrack.length;
  const renaming = albumChanges.includes('artist') || albumChanges.includes('album');

  function toggle(id) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function setRow(track, key, value) {
    setRows((prev) => ({ ...prev, [track.id]: { ...(prev[track.id] ?? initialRow(track)), [key]: value } }));
  }

  async function save() {
    setStage('saving');
    setError(null);
    try {
      const applied = await editAlbumTags({
        artist,
        album,
        fields: albumPatch,
        perTrack,
        trackIds: chosen.map((t) => t.id),
      });
      // Undoing a rename has to send the page back to the old name.
      setResult({ ...applied, renamedFrom: applied.renamed ? { artist, album } : null });
      setStage('done');
      onSaved?.(applied);
    } catch (err) {
      setError(err);
      setStage('error');
    }
  }

  const allIncluded = tracks.length > 0 && tracks.every((t) => included.has(t.id));
  const fieldsByKey = Object.fromEntries(TAG_FIELDS.map((f) => [f.key, f]));

  return (
    <div className="gap-panel tag-edit-panel">
      <h3>Edit this album&apos;s tags</h3>

      {stage === 'saving' && <EqualizerLoader label="Writing tags…" />}
      {stage === 'done' && result && (
        <>
          <WriteResultBanner
            result={result}
            onUndone={() => onSaved?.({ renamed: result.renamedFrom })}
          />
          <button type="button" onClick={onCancel}>Close</button>
        </>
      )}

      {stage === 'confirm' && (
        <div className="tag-edit-confirm">
          <p>
            {albumChanges.length > 0
              ? `Write these tags to ${chosen.length} file${chosen.length === 1 ? '' : 's'}?`
              : `Write the per-track changes to ${perTrack.length} file${perTrack.length === 1 ? '' : 's'}?`}
          </p>
          <ul>
            {albumChanges.map((key) => (
              <li key={key}>
                <strong>{fieldsByKey[key].label}</strong> → “{albumValues[key].trim()}”
                {albumCurrent[key] === VARIES && <span className="muted"> (replacing several different values)</span>}
              </li>
            ))}
            {perTrack.length > 0 && (
              <li>
                {perTrack.length} per-track change{perTrack.length === 1 ? '' : 's'} to title or
                track number
              </li>
            )}
          </ul>
          <div className="bulk-verify-actions">
            <button type="button" onClick={save}>Write these tags</button>
            <button type="button" className="chip-button" onClick={() => setStage('edit')}>
              Back to editing
            </button>
          </div>
        </div>
      )}

      {(stage === 'edit' || stage === 'error') && (
        <>
          <p className="muted">
            Writes exactly what you type, over whatever the files already carry. A field left
            blank is left alone — editing never removes a tag — and nothing is moved or renamed.
          </p>

          <div className="tag-edit-grid">
            {ALBUM_WIDE_KEYS.map((key) => {
              const field = fieldsByKey[key];
              const varies = albumCurrent[key] === VARIES;
              const state = varies
                ? (albumValues[key].trim() ? 'set' : 'unchanged')
                : rowState(albumCurrent[key], albumValues[key]);
              return (
                <div key={key} className="tag-edit-row">
                  <label htmlFor={`album-tag-${key}`}>{field.label}</label>
                  <input
                    id={`album-tag-${key}`}
                    type={field.type}
                    min={field.min}
                    max={field.max}
                    step={field.type === 'number' ? 1 : undefined}
                    value={albumValues[key]}
                    onChange={(e) => setAlbumValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                  {varies && (
                    <span className="tag-edit-varies">
                      (varies) — filling this sets one value on every selected file
                    </span>
                  )}
                  {state === 'set' && (
                    <span className="tag-edit-change tag-edit-destructive">
                      applies to {chosen.length} file{chosen.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {state === 'kept' && (
                    <span className="tag-edit-kept">kept — editing can&apos;t remove a tag</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Folders aren't renamed, so the path repair source keeps proposing the old name. */}
          {renaming && (
            <p className="banner banner-error">
              This changes tags only. Spinmatch never moves or renames files, so the folder on
              disk keeps its old name — and the “From file paths” repair source will keep
              suggesting the old artist and album.
            </p>
          )}

          <table className="library-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allIncluded}
                    aria-label="Include every track"
                    onChange={() => setIncluded(allIncluded
                      ? new Set()
                      : new Set(tracks.map((t) => t.id)))}
                  />
                </th>
                <th>#</th><th>Title</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => (
                <tr key={track.id} className={included.has(track.id) ? undefined : 'bulk-fix-unchanged'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={included.has(track.id)}
                      aria-label={`Include ${track.title}`}
                      onChange={() => toggle(track.id)}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      step={1}
                      className="tag-edit-number"
                      value={rowFor(track).trackNumber}
                      aria-label={`Track number for ${track.title}`}
                      onChange={(e) => setRow(track, 'trackNumber', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={rowFor(track).title}
                      placeholder={track.titleSynthesized ? track.title : ''}
                      aria-label={`Title for ${track.title}`}
                      onChange={(e) => setRow(track, 'title', e.target.value)}
                    />
                    {/* Boolean(): SQLite flags are 0/1 and React renders a bare 0. */}
                    {Boolean(track.titleSynthesized) && (
                      <span className="muted"> (from filename)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {error && <p className="banner banner-error">{error.message}</p>}

          <div className="bulk-verify-actions">
            <button type="button" disabled={willWrite === 0} onClick={() => setStage('confirm')}>
              {willWrite === 0
                ? 'Nothing changed'
                : `Review changes to ${willWrite} file${willWrite === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="ingest-picker-cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function initialRow(t) {
  return { title: t.titleSynthesized ? '' : toFormValue(t.title), trackNumber: toFormValue(t.trackNumber) };
}
