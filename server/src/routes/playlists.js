import express, { Router } from 'express';
import { config, libraryEnabled, playlistExportEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  createPlaylist, listPlaylists, getPlaylist, renamePlaylist, deletePlaylist,
  addItems, removeItem, reorderItems, noteExport, findPlaylistByExportDir,
} from '../services/playlistRepo.js';
import { suggestTracks } from '../services/playlistDiscovery.js';
import { parseM3u, m3uItems } from '../services/m3uImport.js';
import {
  writeM3u, inspectM3u, inspectDropoff, exportToDropoff,
} from '../services/playlistExport.js';
import { MIN_DURATION_MS, MAX_DURATION_MS, clampDuration } from '../services/playlistFill.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { sseStream } from '../lib/sse.js';

export const playlistsRouter = Router();

const MAX_NAME_LENGTH = 200;
const MAX_ITEMS_PER_REQUEST = 5000;
const MAX_TARGET = 1000;
const MAX_BYTE_BUDGET = 2 ** 40; // 1 TiB — a sanity ceiling, not a real limit.

playlistsRouter.use((req, res, next) => {
  if (!libraryEnabled()) return next(new NotFoundError('The library feature is not configured'));
  next();
});

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new BadRequestError('A playlist needs a name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(`A playlist name is at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) throw new BadRequestError('items must be an array');
  if (raw.length > MAX_ITEMS_PER_REQUEST) {
    throw new BadRequestError(`At most ${MAX_ITEMS_PER_REQUEST} items in one request`);
  }
  return raw.map((item) => {
    const title = String(item?.title ?? '').trim();
    if (!title) throw new BadRequestError('Every item needs a title');
    return {
      title: title.slice(0, MAX_NAME_LENGTH),
      artist: item.artist ? String(item.artist).trim().slice(0, MAX_NAME_LENGTH) : null,
      album: item.album ? String(item.album).trim().slice(0, MAX_NAME_LENGTH) : null,
      source: ['manual', 'popular', 'random', 'paste'].includes(item.source) ? item.source : 'manual',
      seedArtist: item.seedArtist ? String(item.seedArtist).slice(0, MAX_NAME_LENGTH) : null,
    };
  });
}

function loadPlaylist(id) {
  const playlist = getPlaylist(getDb(), Number(id));
  if (!playlist) throw new NotFoundError('No such playlist');
  return playlist;
}

playlistsRouter.get('/', (req, res) => {
  res.json({ playlists: listPlaylists(getDb()) });
});

// UNIQUE index on name_key enforces this; no check-then-act race. Null after a 409.
function createOr409(res, name) {
  try {
    return createPlaylist(getDb(), { name });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      res.status(409).json({ error: { code: 'DUPLICATE_NAME', message: 'A playlist with that name already exists' } });
      return null;
    }
    throw err;
  }
}

playlistsRouter.post('/', (req, res) => {
  const playlist = createOr409(res, cleanName(req.body?.name));
  if (playlist) res.json(playlist);
});

// The only route past the global 256kb JSON limit (app.js skips it here), parsed after the gate.
playlistsRouter.post('/import', express.json({ limit: '2mb' }), (req, res) => {
  const name = cleanName(req.body?.name);
  if (typeof req.body?.text !== 'string') throw new BadRequestError('text must be the playlist file');
  const { entries, truncated } = parseM3u(req.body.text, config.ingest.musicDir, MAX_ITEMS_PER_REQUEST);
  if (!entries.length) throw new BadRequestError('No tracks found in that file');

  const db = getDb();
  const items = m3uItems(db, entries).map((item) => ({ ...item, source: 'import' }));
  const playlist = createOr409(res, name);
  if (!playlist) return;
  addItems(db, playlist.id, items);
  const gaps = getPlaylist(db, playlist.id).items.filter((i) => !i.track).length;
  res.json({ playlist, added: items.length, gaps, truncated });
});

playlistsRouter.get('/:id', (req, res) => {
  res.json(loadPlaylist(req.params.id));
});

playlistsRouter.patch('/:id', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  const name = cleanName(req.body?.name);
  try {
    renamePlaylist(getDb(), playlist.id, name);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      res.status(409).json({ error: { code: 'DUPLICATE_NAME', message: 'A playlist with that name already exists' } });
      return;
    }
    throw err;
  }
  res.json({ ok: true });
});

playlistsRouter.delete('/:id', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  deletePlaylist(getDb(), playlist.id);
  res.json({ ok: true });
});

playlistsRouter.post('/:id/items', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  res.json(addItems(getDb(), playlist.id, cleanItems(req.body?.items)));
});

playlistsRouter.delete('/:id/items/:itemId', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  removeItem(getDb(), playlist.id, Number(req.params.itemId));
  res.json({ ok: true });
});

playlistsRouter.patch('/:id/order', (req, res) => {
  const playlist = loadPlaylist(req.params.id);
  const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(Number) : null;
  if (!ids) throw new BadRequestError('itemIds must be an array');
  reorderItems(getDb(), playlist.id, ids);
  res.json({ ok: true });
});

// Writes nothing: the client reviews suggestions, then POSTs survivors to /items.
// try/next(err): Express 4 doesn't catch async rejections.
playlistsRouter.post('/:id/suggest', async (req, res, next) => {
  try {
    const playlist = loadPlaylist(req.params.id);
    const seedArtists = Array.isArray(req.body?.seedArtists)
      ? req.body.seedArtists.map((a) => String(a).trim()).filter(Boolean).slice(0, 10)
      : [];
    if (!seedArtists.length) throw new BadRequestError('Pick at least one artist to start from');

    const target = Math.min(MAX_TARGET, Math.max(1, Number(req.body?.target) || 50));
    const rawBudget = Number(req.body?.byteBudget);
    const byteBudget = Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.min(MAX_BYTE_BUDGET, rawBudget)
      : null;

    const result = await suggestTracks(getDb(), {
      seedArtists,
      method: req.body?.method === 'random' ? 'random' : 'popular',
      target,
      byteBudget,
      preferPopular: Boolean(req.body?.preferPopular),
      minMs: clampDuration(req.body?.minMs, MIN_DURATION_MS),
      maxMs: clampDuration(req.body?.maxMs, MAX_DURATION_MS),
      existingKeys: new Set(playlist.items.map((i) => i.matchKey)),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Confirm before overwriting: sanitized names collide, and the file may be hand-written.
playlistsRouter.post('/:id/export/m3u', async (req, res, next) => {
  try {
    const playlist = loadPlaylist(req.params.id);
    if (req.body?.replace !== true) {
      const existing = await inspectM3u(playlist.name);
      if (existing.exists) {
        res.status(409).json({
          error: {
            code: 'M3U_EXISTS',
            message: 'A file already exists at that path. Confirm to replace it.',
            existing: { path: existing.path, bytes: existing.bytes, writtenAt: existing.writtenAt },
          },
        });
        return;
      }
    }
    const result = await writeM3u({ name: playlist.name, items: playlist.items });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST + same-origin: it deletes and rewrites a folder. Answers with SSE.
playlistsRouter.post('/:id/export/dropoff', sameOriginOnly, async (req, res, next) => {
  try {
    if (!playlistExportEnabled()) {
      throw new NotFoundError('No drop-off folder is configured');
    }
    const playlist = loadPlaylist(req.params.id);
    const existing = await inspectDropoff(playlist.name);

    // Refused even with replace: another playlist's sanitized name owns this folder.
    const owner = findPlaylistByExportDir(getDb(), existing.dir, { excludeId: playlist.id });
    if (owner) {
      throw new BadRequestError(
        `That folder is the last export of the playlist "${owner.name}", whose name lands in `
        + 'the same place once it is made safe for a filesystem. Rename one of the two.'
      );
    }

    if (req.body?.replace !== true && existing.exists) {
      res.status(409).json({
        error: {
          code: 'DROPOFF_EXISTS',
          message: 'That folder already exists. Confirm to replace it.',
          existing: {
            dir: existing.dir,
            fileCount: existing.fileCount,
            bytes: existing.bytes,
            exportedAt: existing.exportedAt,
          },
        },
      });
      return;
    }

    await sseStream(async ({ send, signal }) => {
      const result = await exportToDropoff({
        name: playlist.name,
        items: playlist.items,
        onProgress: (p) => send('progress', p),
        signal,
      });
      // Don't record an aborted, partial export.
      if (result.copied + result.skipped === playlist.items.length) {
        noteExport(getDb(), playlist.id, result.dir);
      }
      return result;
    })(req, res);
  } catch (err) {
    next(err);
  }
});
