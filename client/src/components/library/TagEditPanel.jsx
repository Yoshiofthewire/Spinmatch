import { useMemo, useState } from 'react';
import { editTrackTags } from '../../api/library.js';
import { TAG_FIELDS, toFormValue, rowState, patchFrom } from '../../lib/tagFields.js';

// Editing one file's tags by hand.
//
// The counterpart to FixTrackPanel, and the two answer different questions.
// FixTrackPanel asks MusicBrainz what this file is, which is the right tool when
// you don't know — and useless for the files that need it most, since it searches
// on the tags that are missing. This panel is for when you already know: you can
// see the album sleeve, or the folder, or you just recognise the song.
//
// It overwrites, which nothing else outside the fingerprint path does. It cannot
// remove a tag: a field left blank means "leave this alone". That is stated on the
// row the moment it happens rather than only in the docs, because "I blanked it
// and pressed save" is otherwise a silent no-op.
export default function TagEditPanel({ track, onSaved, onCancel, onPlay }) {
  // Synthesized values start the form blank with the synthesized text as a
  // placeholder. Pre-filling them would be a trap: the scanner fills album from
  // the folder name and title from the filename when the tag is empty, so
  // pre-filling and saving would write a folder name the file never claimed.
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

      {/* The pending changes are listed on their own before anything is written.
          Nothing in this app can be undone, and this is the one path where the
          values came from a keyboard rather than from a lookup — so the last thing
          before the write is a plain reading of what it will do. */}
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
              const synthesized = (field.key === 'album' && track.albumSynthesized)
                || (field.key === 'title' && track.titleSynthesized);
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

          {/* Read joined, written back as one value — a real limitation of the tag
              layer, and better admitted than discovered. */}
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
