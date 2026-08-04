import { Router } from 'express';
import { libraryEnabled, playlistExportEnabled } from '../config.js';
import { getDb } from '../lib/db.js';
import {
  createPlaylist, listPlaylists, getPlaylist, renamePlaylist, deletePlaylist,
  addItems, removeItem, reorderItems, noteExport, findPlaylistByExportDir,
} from '../services/playlistRepo.js';
import { suggestTracks } from '../services/playlistDiscovery.js';
import {
  writeM3u, inspectM3u, inspectDropoff, exportToDropoff,
} from '../services/playlistExport.js';
import { MIN_DURATION_MS, MAX_DURATION_MS, clampDuration } from '../services/playlistFill.js';
import { NotFoundError, BadRequestError } from '../lib/httpErrors.js';
import { sameOriginOnly } from '../middleware/sameOriginOnly.js';
import { sseStream } from '../lib/sse.js';

export const playlistsRouter = Router();

// Bounds, in the spirit of the ones the rest of the app already applies. A
// request is clamped or refused here rather than trusted downstream.
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

playlistsRouter.post('/', (req, res) => {
  const name = cleanName(req.body?.name);
  try {
    res.json(createPlaylist(getDb(), { name }));
  } catch (err) {
    // The UNIQUE index on name_key is what enforces this; catching it here
    // rather than pre-checking avoids a check-then-act race.
    if (String(err.message).includes('UNIQUE')) {
      res.status(409).json({ error: { code: 'DUPLICATE_NAME', message: 'A playlist with that name already exists' } });
      return;
    }
    throw err;
  }
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
    // Same UNIQUE index, same answer as POST /. Without this the rename form
    // rendered "Internal server error" — and the log got a stack trace — for
    // the most ordinary mistake there is.
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

// Writes nothing. This IS the review step: the client shows what comes back,
// the user unticks, and what survives goes to POST /items.
//
// Wrapped in try/catch, like every other async handler in this app (see
// library.js): loadPlaylist's NotFoundError, and cleanItems'/cleanName's
// BadRequestError, throw synchronously, but a synchronous throw inside an
// async function body doesn't propagate as a synchronous exception — it
// becomes a rejected Promise. Express 4 does not await a handler's return
// value, so an uncaught rejection here is never forwarded to the error
// middleware: the request simply hangs with no response until the client
// times out, instead of getting the 404/400 it should. Calling next(err)
// explicitly is what turns that hang into the response it was supposed to be.
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

// The same confirmation the drop-off export has, for the same reason: the
// filename is the playlist name with the unsafe characters removed, so two
// playlists can produce one file — and MUSIC_DIR/Road Trip.m3u might be
// somebody's hand-written playlist that Spinmatch never created. Nothing
// records who wrote it, so the file itself is what gets reported.
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

// GET, not POST: house convention. Every SSE stream in this app is a GET that
// opts into the CSRF guard by hand, and one shared client helper
// (lib/eventStream.js) that opens all of them beats protocol purity for a
// single route.
//
// It is not a capability claim. The reason given here used to be "EventSource
// only issues GET requests", but the client abandoned EventSource for fetch —
// its own header explains why at length — so POST was available the whole time.
// That distinction has teeth: sameOriginOnly accepts Sec-Fetch-Site: none,
// which is a user-initiated navigation, so this URL pasted into the address bar
// of a logged-in browser starts a real export with no confirmation step in
// front of it. A POST would not have been reachable that way.
playlistsRouter.get('/:id/export/dropoff', sameOriginOnly, async (req, res, next) => {
  try {
    if (!playlistExportEnabled()) {
      throw new NotFoundError('No drop-off folder is configured');
    }
    const playlist = loadPlaylist(req.params.id);
    const existing = await inspectDropoff(playlist.name);

    // Checked on the replace path too, and refused rather than confirmed. The
    // folder name is the playlist name with / \ : * ? " < > | stripped, so two
    // playlists can share one — and the only thing the confirmation showed was
    // a file count, which reads as "yours, from last time" no matter whose it
    // is. There is no safe way to answer "replace?" here, so it isn't asked.
    const owner = findPlaylistByExportDir(getDb(), existing.dir, { excludeId: playlist.id });
    if (owner) {
      throw new BadRequestError(
        `That folder is the last export of the playlist "${owner.name}", whose name lands in `
        + 'the same place once it is made safe for a filesystem. Rename one of the two.'
      );
    }

    if (req.query.replace !== '1' && existing.exists) {
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
      noteExport(getDb(), playlist.id, result.dir);
      return result;
    })(req, res);
  } catch (err) {
    next(err);
  }
});
