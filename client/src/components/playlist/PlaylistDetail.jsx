import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import EqualizerLoader from '../EqualizerLoader.jsx';
import ErrorBanner from '../ErrorBanner.jsx';
import AddTracksPanel from './AddTracksPanel.jsx';
import { useConfig } from '../../ConfigContext.jsx';
import { formatBytes, formatDuration } from '../../lib/format.js';
import { streamEvents } from '../../lib/eventStream.js';
import {
  getPlaylist, renamePlaylist, deletePlaylist, removePlaylistItem, reorderPlaylist,
  exportM3u, dropoffUrl,
} from '../../api/playlists.js';

// The UI calls the sampler's `random` method "Chance".
const SOURCE_LABELS = {
  manual: 'Manual', popular: 'Popular', random: 'Chance', paste: 'Pasted',
};

// Reorder uses up/down buttons, not drag-and-drop: predictable and keyboard-accessible.
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
  // Inline second step, not window.confirm, like the rest of the app.
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
  const [removeConfirmId, setRemoveConfirmId] = useState(null);

  async function removeItem(itemId) {
    setRemoveConfirmId(null);
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
    // Optimistic; snaps back if the write fails.
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
  const [m3uState, setM3uState] = useState('idle'); // idle | running | confirm | done | error
  const [m3uResult, setM3uResult] = useState(null);
  const [m3uConfirm, setM3uConfirm] = useState(null); // { path, bytes, writtenAt }
  const [m3uError, setM3uError] = useState(null);

  async function handleExportM3u(replace) {
    setM3uState('running');
    setM3uError(null);
    setM3uResult(null);
    try {
      const result = await exportM3u(id, { replace });
      setM3uResult(result);
      setM3uState('done');
    } catch (err) {
      // 409: a file exists there. Confirmation gate, not a failure.
      if (err.code === 'M3U_EXISTS') {
        setM3uConfirm(err.details?.existing ?? null);
        setM3uState('confirm');
        return;
      }
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

  // Abort an in-flight export on unmount.
  useEffect(() => () => dropoffAbortRef.current?.abort(), []);

  async function runDropoffExport(replace) {
    setDropoffState('running');
    setDropoffError(null);
    setDropoffProgress(null);
    setDropoffResult(null);

    const controller = new AbortController();
    dropoffAbortRef.current = controller;

    // One terminal outcome: `done`, `error`, or never opening (incl. the confirm 409).
    let terminal = null;
    try {
      await streamEvents(dropoffUrl(id), {
        progress: (data) => setDropoffProgress(data),
        done: (data) => { terminal = { ok: true, data }; },
        error: (data) => { terminal = { failure: data }; },
      }, { signal: controller.signal, body: { replace } });

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
      // 409: folder exists. Let the user decide; never auto-retry with replace.
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
  if (state === 'error') return <ErrorBanner message={error} onRetry={load} />;
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
            onClick={() => handleExportM3u(false)}
            disabled={m3uState === 'running'}
          >
            {m3uState === 'running' ? 'Exporting…' : 'Export m3u'}
          </button>
          {/* Hidden, not disabled: no drop-off folder configured. */}
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

        {m3uState === 'confirm' && (
          /* Describe the file; Spinmatch may not have written it. */
          <p className="banner banner-rate-limited">
            A file already exists at{' '}
            <span className="mono">{m3uConfirm?.path ?? 'that path'}</span>
            {m3uConfirm?.bytes ? ` (${formatBytes(m3uConfirm.bytes)})` : ''}
            {m3uConfirm?.writtenAt
              ? `, last written ${new Date(m3uConfirm.writtenAt).toLocaleString()}`
              : ''}.
            {' '}Spinmatch may not have written it.{' '}
            <button type="button" className="chip-button" onClick={() => handleExportM3u(true)}>
              Replace
            </button>
            <button type="button" className="link-button" onClick={() => setM3uState('idle')}>
              Cancel
            </button>
          </p>
        )}

        {dropoffState === 'confirm' && (
          /* Show path and size; the folder may not be this playlist's. */
          <p className="banner banner-rate-limited">
            A folder already exists
            {dropoffConfirm?.dir ? <> at <span className="mono">{dropoffConfirm.dir}</span></> : ''}
            {dropoffConfirm?.fileCount != null && `, with ${dropoffConfirm.fileCount} file${dropoffConfirm.fileCount === 1 ? '' : 's'}`}
            {dropoffConfirm?.bytes ? ` (${formatBytes(dropoffConfirm.bytes)})` : ''}
            {dropoffConfirm?.exportedAt
              ? `, last written ${new Date(dropoffConfirm.exportedAt).toLocaleString()}`
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
              <div
                className="progress-bar"
                role="progressbar"
                aria-label="Files copied"
                aria-valuemin={0}
                aria-valuemax={dropoffProgress?.total || undefined}
                aria-valuenow={dropoffProgress?.total ? dropoffProgress.index : undefined}
              >
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
        <div className="table-scroll"><table className="library-table playlist-table">
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
                  {/* Not a VerifyButton: a gap has no duration, so POST /verify
                      would 400 (requireLengthMs). Search supplies one. */}
                  {!item.track && (
                    <Link
                      className="chip-button"
                      to={`/?q=${encodeURIComponent([item.artist, item.title].filter(Boolean).join(' '))}`}
                    >
                      Find this track
                    </Link>
                  )}
                  {removeConfirmId !== item.id ? (
                    <button type="button" className="link-button" onClick={() => setRemoveConfirmId(item.id)}>
                      Remove
                    </button>
                  ) : (
                    <span className="playlist-delete-confirm">
                      <button type="button" className="chip-button" onClick={() => removeItem(item.id)}>
                        Confirm remove
                      </button>
                      <button type="button" className="link-button" onClick={() => setRemoveConfirmId(null)}>
                        Cancel
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
