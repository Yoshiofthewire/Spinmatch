import { useMemo, useState } from 'react';
import EqualizerLoader from '../EqualizerLoader.jsx';
import WriteResultBanner from './WriteResultBanner.jsx';
import { editAlbumTags } from '../../api/library.js';
import {
  TAG_FIELDS, ALBUM_WIDE_KEYS, PER_TRACK_KEYS, toFormValue, rowState, patchFrom,
} from '../../lib/tagFields.js';

const VARIES = Symbol('varies');

// The one value every track shares, or VARIES if they disagree. A field that
// varies starts blank: there is no single current value to show, and putting one
// of them in the box would invite overwriting the rest with it by accident.
function commonValue(tracks, key) {
  if (!tracks.length) return null;
  const first = tracks[0][key] ?? null;
  return tracks.every((t) => (t[key] ?? null) === first) ? first : VARIES;
}

// Editing a whole album's tags by hand.
//
// No preview round-trip, unlike BulkFixPanel. That panel needs one because the
// SERVER derives the values and you have to see them before they land; here you
// typed them, so a preview would only read your own form back to you. What stands
// in for it is the confirm step below, which says what will be written and to how
// many files.
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
  const [rows, setRows] = useState(() => Object.fromEntries(tracks.map((t) => [t.id, {
    title: t.titleSynthesized ? '' : toFormValue(t.title),
    trackNumber: toFormValue(t.trackNumber),
  }])));
  const [included, setIncluded] = useState(() => new Set(tracks.map((t) => t.id)));
  const [stage, setStage] = useState('edit'); // edit | confirm | saving | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // A varying field has no single "original", so anything typed into it is a
  // change. Everything else compares against the shared value.
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
      fields: patchFrom(rows[t.id], {
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

  function setRow(id, key, value) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
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
      setResult(applied);
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
          <WriteResultBanner result={result} />
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

          {/* Load-bearing, not a disclaimer: nothing outside the ingest path ever
              moves a file, so the folder keeps its old name — and the file-path
              repair source reads that folder, so it will keep proposing the name
              you just changed away from. */}
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
                      value={rows[track.id].trackNumber}
                      aria-label={`Track number for ${track.title}`}
                      onChange={(e) => setRow(track.id, 'trackNumber', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={rows[track.id].title}
                      placeholder={track.titleSynthesized ? track.title : ''}
                      aria-label={`Title for ${track.title}`}
                      onChange={(e) => setRow(track.id, 'title', e.target.value)}
                    />
                    {track.titleSynthesized && (
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
