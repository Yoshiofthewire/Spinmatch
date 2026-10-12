import { useMemo, useState } from 'react';
import { editTrackTags } from '../../api/library.js';
import { TAG_FIELDS, toFormValue, rowState, patchFrom } from '../../lib/tagFields.js';

// Hand-edit one file's tags. Overwrites (like the fingerprint path), but cannot
// remove a tag: blank means "leave alone", and the row says so.
export default function TagEditPanel({ track, onSaved, onCancel, onPlay }) {
  // Synthesized values are placeholders only, or saving would write a folder name as a tag.
  const current = useMemo(() => ({
    artist: track.artist ?? null,
    title: track.titleSynthesized ? null : (track.title ?? null),
    album: track.albumSynthesized ? null : (track.album ?? null),
    trackNumber: track.trackNumber ?? null,
    disc: track.disc ?? null,
    year: track.year ?? null,
    genre: track.genre ?? null,
  }), [track]);

  const [values, setValues] = useState(() => Object.fromEntries(
    TAG_FIELDS.map(({ key }) => [key, toFormValue(current[key])]),
  ));
  const [stage, setStage] = useState('edit'); // edit | confirm | saving | error
  const [error, setError] = useState(null);

  const states = TAG_FIELDS.map((field) => ({
    ...field,
    state: rowState(current[field.key], values[field.key]),
  }));
  const changes = states.filter((f) => f.state === 'set');

  function set(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function reset(key) {
    set(key, toFormValue(current[key]));
  }

  async function save() {
    setStage('saving');
    setError(null);
    try {
      const result = await editTrackTags({
        trackId: track.id,
        fields: patchFrom(values, current, TAG_FIELDS.map((f) => f.key)),
        expectedMtimeMs: track.mtimeMs ?? undefined,
      });
      onSaved(result);
    } catch (err) {
      setError(err);
      setStage('error');
    }
  }

  return (
    <div className="tag-edit-panel">
      <div className="fix-identify">
        {onPlay && (
          <button
            type="button"
            className="play-button"
            onClick={() => onPlay(track)}
            aria-label={`Play ${track.title || track.path}`}
            title="Play this file"
          >
            ▶
          </button>
        )}
        {track.path && <p className="muted mono fix-path">{track.path}</p>}
      </div>

      {/* Read back hand-typed changes before writing them. */}
      {(stage === 'confirm' || stage === 'saving') && (
        <div className="tag-edit-confirm">
          <p>Write these tags to the file?</p>
          <ul>
            {changes.map((f) => (
              <li key={f.key}>
                <strong>{f.label}</strong>
                {current[f.key] == null
                  ? <> → “{values[f.key].trim()}”</>
                  : <> “{toFormValue(current[f.key])}” → “{values[f.key].trim()}”</>}
              </li>
            ))}
          </ul>
          <div className="bulk-verify-actions">
            <button type="button" disabled={stage === 'saving'} onClick={save}>
              {stage === 'saving' ? 'Writing…' : 'Write these tags'}
            </button>
            <button
              type="button"
              className="chip-button"
              disabled={stage === 'saving'}
              onClick={() => setStage('edit')}
            >
              Back to editing
            </button>
          </div>
        </div>
      )}

      {(stage === 'edit' || stage === 'error') && (
        <>
          <div className="tag-edit-grid">
            {states.map((field) => {
              // Boolean(): SQLite flags are 0/1 and React renders a bare 0.
              const synthesized = Boolean(
                (field.key === 'album' && track.albumSynthesized)
                || (field.key === 'title' && track.titleSynthesized)
              );
              return (
                <div key={field.key} className="tag-edit-row">
                  <label htmlFor={`tag-${track.id}-${field.key}`}>{field.label}</label>
                  <input
                    id={`tag-${track.id}-${field.key}`}
                    type={field.type}
                    min={field.min}
                    max={field.max}
                    step={field.type === 'number' ? 1 : undefined}
                    value={values[field.key]}
                    placeholder={synthesized ? track[field.key] ?? '' : ''}
                    onChange={(e) => set(field.key, e.target.value)}
                  />
                  {synthesized && (
                    <span className="muted">
                      {field.key === 'album' ? '(from folder)' : '(from filename)'} — the file has
                      no {field.label.toLowerCase()} tag
                    </span>
                  )}
                  {field.state === 'set' && (
                    <>
                      <span className={`tag-edit-change${current[field.key] == null ? '' : ' tag-edit-destructive'}`}>
                        {current[field.key] == null
                          ? `set to “${values[field.key].trim()}”`
                          : `replaces “${toFormValue(current[field.key])}”`}
                      </span>
                      <button type="button" className="chip-button" onClick={() => reset(field.key)}>
                        Undo
                      </button>
                    </>
                  )}
                  {/* The no-clear rule, said where someone would trip over it. */}
                  {field.state === 'kept' && (
                    <span className="tag-edit-kept">
                      kept — editing can&apos;t remove a tag
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Tag layer limitation: read joined, written back as one value. */}
          <p className="muted">
            Artist and genre can hold several values in a file; Spinmatch shows them joined
            with commas and saves what you type back as a single value.
          </p>

          {error && <p className="banner banner-error">{error.message}</p>}

          <div className="bulk-verify-actions">
            <button type="button" disabled={changes.length === 0} onClick={() => setStage('confirm')}>
              {changes.length === 0
                ? 'Nothing changed'
                : `Review ${changes.length} change${changes.length === 1 ? '' : 's'}`}
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
