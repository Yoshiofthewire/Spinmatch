import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import EqualizerLoader from '../EqualizerLoader.jsx';
import AddTracksPanel from './AddTracksPanel.jsx';
import { useConfig } from '../../ConfigContext.jsx';
import { formatBytes, formatDuration } from '../../lib/format.js';
import { streamEvents } from '../../lib/eventStream.js';
import {
  getPlaylist, renamePlaylist, deletePlaylist, removePlaylistItem, reorderPlaylist,
  exportM3u, dropoffUrl,
} from '../../api/playlists.js';

// `random` is the sampler's internal name for the method; the UI calls it
// Chance, since that reads as what it does rather than how it's implemented.
const SOURCE_LABELS = {
  manual: 'Manual', popular: 'Popular', random: 'Chance', paste: 'Pasted',
};

// One playlist: its ordered rows, and the actions that only make sense once
// you're looking at a single playlist (rename, delete, export, reorder).
//
// Reordering is up/down buttons rather than native HTML5 drag-and-drop. Drag
// events (dragstart/dragover/drop, the ghost image, the drop-target styling)
// are fiddly to get right without a way to click through the result in a
// browser, and this repo has no client-side test harness to catch a bad
// interaction. Buttons are slower for a long playlist but they are honest —
// every click does exactly what it says, and they work with a keyboard.
export default function PlaylistDetail({ id, onPlay, onDeleted }) {
  const { playlistExportEnabled } = useConfig();

  const [playlist, setPlaylist] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getPlaylist(id);
      setPlaylist(data);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, [id]);

  useEffect(() => {
    setState('loading');
    setPlaylist(null);
    load();
  }, [load]);

  // ---- Rename ----
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameError, setRenameError] = useState(null);

  function startRename() {
    setNameDraft(playlist.name);
    setRenameError(null);
    setRenaming(true);
  }

  async function submitRename(e) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    try {
      await renamePlaylist(id, trimmed);
      setRenaming(false);
      await load();
    } catch (err) {
      setRenameError(err.message);
    }
  }

  // ---- Delete ----
  // No window.confirm — the rest of this app never uses one, preferring an
  // inline second step (see the drop-off Replace prompt below) so the choice
  // stays on the page instead of a native dialog.
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  async function confirmDelete() {
    setDeleteError(null);
    try {
      await deletePlaylist(id);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err.message);
    }
  }

  // ---- Item removal ----
  async function removeItem(itemId) {
    setActionError(null);
    try {
      await removePlaylistItem(id, itemId);
      await load();
    } catch (err) {
      setActionError(err.message);
    }
  }

  // ---- Reorder ----
  async function move(index, delta) {
    const items = playlist.items;
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    // Optimistic: the row moves immediately, and only snaps back if the write
    // fails, rather than waiting a round trip to feel like a working button.
    setPlaylist({ ...playlist, items: reordered });
    setActionError(null);
    try {
      await reorderPlaylist(id, reordered.map((i) => i.id));
    } catch (err) {
      setActionError(err.message);
      load();
    }
  }

  // ---- Export: m3u ----
  const [m3uState, setM3uState] = useState('idle'); // idle | running | done | error
  const [m3uResult, setM3uResult] = useState(null);
  const [m3uError, setM3uError] = useState(null);

  async function handleExportM3u() {
    setM3uState('running');
    setM3uError(null);
    setM3uResult(null);
    try {
      const result = await exportM3u(id);
      setM3uResult(result);
      setM3uState('done');
    } catch (err) {
      setM3uError(err.message);
      setM3uState('error');
    }
  }

  // ---- Export: to player (drop-off), streamed over SSE ----
  const [dropoffState, setDropoffState] = useState('idle'); // idle | confirm | running | done | error
  const [dropoffConfirm, setDropoffConfirm] = useState(null); // { fileCount, exportedAt }
  const [dropoffProgress, setDropoffProgress] = useState(null); // { index, total, title, bytes }
  const [dropoffResult, setDropoffResult] = useState(null); // { dir, copied, skipped, bytes }
  const [dropoffError, setDropoffError] = useState(null);
  const dropoffAbortRef = useRef(null);

  // Abort an in-flight export if the user navigates away mid-run — same
  // pattern as BulkVerifyPanel.
  useEffect(() => () => dropoffAbortRef.current?.abort(), []);

  async function runDropoffExport(replace) {
    setDropoffState('running');
    setDropoffError(null);
    setDropoffProgress(null);
    setDropoffResult(null);

    const controller = new AbortController();
    dropoffAbortRef.current = controller;

    // Exactly one terminal outcome ends a run: the `done` event, the `error`
    // event, or the request never opening at all (including the 409 that
    // means "confirm before replacing" — that one isn't a failure).
    let terminal = null;
    try {
      await streamEvents(dropoffUrl(id, { replace }), {
        progress: (data) => setDropoffProgress(data),
        done: (data) => { terminal = { ok: true, data }; },
        error: (data) => { terminal = { failure: data }; },
      }, { signal: controller.signal });

      if (terminal?.ok) {
        setDropoffResult(terminal.data);
        setDropoffState('done');
        load(); // picks up the new lastExportedAt
        return;
      }
      setDropoffError(terminal?.failure ?? {
        message: 'The export stream ended before it finished.',
      });
      setDropoffState('error');
    } catch (err) {
      if (controller.signal.aborted) return; // unmounted mid-run
      // The 409 pre-check: the folder already exists. This is the
      // confirmation gate, not a failure — show what's there and let the
      // user decide, rather than auto-retrying with replace=1.
      if (err.code === 'DROPOFF_EXISTS') {
        setDropoffConfirm(err.details?.existing ?? null);
        setDropoffState('confirm');
        return;
      }
      setDropoffError({ message: err.message, code: err.code });
      setDropoffState('error');
    }
  }

  if (state === 'loading') return <EqualizerLoader label="Loading playlist…" />;
  if (state === 'error') return <p className="banner banner-error">{error}</p>;
  if (!playlist) return null;

  const gapCount = playlist.items.filter((i) => !i.track).length;
  const queue = playlist.items.filter((i) => i.track).map((i) => i.track);
  const dropoffBusy = dropoffState === 'running' || dropoffState === 'confirm';

  return (
    <div className="playlist-detail">
      <div className="playlist-detail-header">
        {renaming ? (
          <form className="playlist-rename-form" onSubmit={submitRename}>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              aria-label="Playlist name"
              autoFocus
            />
            <button type="submit" disabled={!nameDraft.trim()}>Save</button>
            <button type="button" className="link-button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h2>{playlist.name}</h2>
        )}

        <p className="muted">
          {playlist.items.length} track{playlist.items.length === 1 ? '' : 's'}
          {gapCount > 0 && `, ${gapCount} gap${gapCount === 1 ? '' : 's'}`}
          {playlist.lastExportedAt
            ? ` · last exported ${new Date(playlist.lastExportedAt).toLocaleString()}`
            : ''}
        </p>

        {renameError && <p className="banner banner-error">{renameError}</p>}
        {deleteError && <p className="banner banner-error">{deleteError}</p>}

        <div className="playlist-actions">
          {!renaming && (
            <button type="button" className="chip-button" onClick={startRename}>Rename</button>
          )}
          <button
            type="button"
            className="chip-button"
            onClick={handleExportM3u}
            disabled={m3uState === 'running'}
          >
            {m3uState === 'running' ? 'Exporting…' : 'Export m3u'}
          </button>
          {/* Hidden entirely rather than shown-disabled: no drop-off folder is
              configured, so the action has nowhere to go. */}
          {playlistExportEnabled && (
            <button
              type="button"
              className="chip-button"
              onClick={() => runDropoffExport(false)}
              disabled={dropoffBusy}
            >
              {dropoffState === 'running' ? 'Exporting…' : 'Export to player'}
            </button>
          )}
          {!deleteConfirm ? (
            <button type="button" className="chip-button" onClick={() => setDeleteConfirm(true)}>
              Delete
            </button>
          ) : (
            <span className="playlist-delete-confirm">
              <span className="muted">Delete this playlist? This can&apos;t be undone.</span>
              <button type="button" className="chip-button" onClick={confirmDelete}>
                Confirm delete
              </button>
              <button type="button" className="link-button" onClick={() => setDeleteConfirm(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>

        {m3uResult && (
          <p className="banner banner-success">
            Wrote {m3uResult.written} track{m3uResult.written === 1 ? '' : 's'} to {m3uResult.path}
            {m3uResult.skipped ? `, skipped ${m3uResult.skipped}` : ''}.
          </p>
        )}
        {m3uState === 'error' && <p className="banner banner-error">{m3uError}</p>}

        {dropoffState === 'confirm' && (
          <p className="banner banner-rate-limited">
            A folder for this playlist already exists
            {dropoffConfirm?.fileCount != null && ` with ${dropoffConfirm.fileCount} file${dropoffConfirm.fileCount === 1 ? '' : 's'}`}
            {dropoffConfirm?.exportedAt
              ? `, last exported ${new Date(dropoffConfirm.exportedAt).toLocaleString()}`
              : ''}.
            {' '}Replacing it deletes what&apos;s there first.{' '}
            <button type="button" className="chip-button" onClick={() => runDropoffExport(true)}>
              Replace
            </button>
            <button type="button" className="link-button" onClick={() => setDropoffState('idle')}>
              Cancel
            </button>
          </p>
        )}

        {dropoffState === 'running' && (
          <div className="bulk-verify-progress">
            <EqualizerLoader />
            <div style={{ flex: 1 }}>
              <div className="progress-bar">
                <div
                  className="progress-bar-fill"
                  style={{
                    width: `${dropoffProgress?.total
                      ? Math.round((dropoffProgress.index / dropoffProgress.total) * 100)
                      : 0}%`,
                  }}
                />
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {dropoffProgress
                  ? `Copied ${dropoffProgress.index} of ${dropoffProgress.total}`
                    + `${dropoffProgress.title ? `: ${dropoffProgress.title}` : ''}`
                    + ` (${formatBytes(dropoffProgress.bytes)})`
                  : 'Starting export…'}
              </p>
            </div>
          </div>
        )}

        {dropoffState === 'done' && dropoffResult && (
          <p className="banner banner-success">
            Copied {dropoffResult.copied} file{dropoffResult.copied === 1 ? '' : 's'}
            {dropoffResult.skipped ? `, skipped ${dropoffResult.skipped}` : ''}
            {' '}({formatBytes(dropoffResult.bytes)}) to {dropoffResult.dir}.
          </p>
        )}

        {dropoffState === 'error' && dropoffError && (
          <p className={dropoffError.code === 'RATE_LIMITED' ? 'banner banner-rate-limited' : 'banner banner-error'}>
            {dropoffError.message}
          </p>
        )}
      </div>

      <AddTracksPanel playlistId={id} onAdded={load} />

      {actionError && <p className="banner banner-error">{actionError}</p>}

      {playlist.items.length === 0 ? (
        <p className="muted">This playlist is empty.</p>
      ) : (
        <table className="library-table playlist-table">
          <thead>
            <tr>
              <th aria-label="Reorder" />
              <th aria-label="Play" />
              <th>Artist</th>
              <th>Title</th>
              <th>Album</th>
              <th>Length</th>
              <th>Source</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {playlist.items.map((item, index) => (
              <tr key={item.id} className={item.track ? undefined : 'track-row-missing'}>
                <td className="playlist-reorder">
                  <button
                    type="button"
                    className="chip-button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${item.title} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="chip-button"
                    disabled={index === playlist.items.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${item.title} down`}
                  >
                    ↓
                  </button>
                </td>
                <td>
                  {item.track ? (
                    <button
                      type="button"
                      className="play-button"
                      onClick={() => onPlay?.(item.track, queue)}
                      aria-label={`Play ${item.title}`}
                    >
                      ▶
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{item.artist ?? <span className="muted">Unknown</span>}</td>
                <td>{item.title}</td>
                <td className="muted">{item.album ?? '—'}</td>
                <td className="mono">{item.track ? formatDuration(item.track.durationMs) : '—'}</td>
                <td>
                  <span className="badge badge-source">{SOURCE_LABELS[item.source] ?? item.source}</span>
                  {item.seedArtist && <span className="muted"> from {item.seedArtist}</span>}
                </td>
                <td className="playlist-row-actions">
                  {/* Not a VerifyButton: a gap has no local file and no
                      MusicBrainz lookup behind it, so it can never supply the
                      duration POST /verify requires (requireLengthMs in
                      server/src/routes/verify.js rejects a missing lengthMs
                      outright — the same reason MissingTrackCell hides
                      VerifyButton when a length is unknown). A VerifyButton
                      here would only ever 400. Routing to the Search page
                      instead reaches a result that carries its own length and
                      its own working Find on YouTube button — the door a user
                      would walk through by hand anyway. Do not swap this back
                      for a VerifyButton; it will just rediscover the 400. */}
                  {!item.track && (
                    <Link
                      className="chip-button"
                      to={`/?q=${encodeURIComponent([item.artist, item.title].filter(Boolean).join(' '))}`}
                    >
                      Find this track
                    </Link>
                  )}
                  <button type="button" className="link-button" onClick={() => removeItem(item.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
