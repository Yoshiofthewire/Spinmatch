import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rm-'));
const dropoffDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spinmatch-rd-'));

process.env.MB_CONTACT_EMAIL = 'test@example.com';
process.env.MUSIC_DIR = musicDir;
process.env.DROPOFF_DIR = dropoffDir;

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const repo = await import('../../src/services/libraryRepo.js');

let server;
let baseUrl;
let db;

test.before(async () => {
  await fs.mkdir(path.join(musicDir, 'A', 'Al'), { recursive: true });
  await fs.writeFile(path.join(musicDir, 'A', 'Al', '01.mp3'), Buffer.alloc(16, 1));

  db = openDb(':memory:');
  repo.upsertLocalTrack(db, {
    path: path.join(musicDir, 'A', 'Al', '01.mp3'), artist: 'A', album: 'Al',
    title: 'One', durationMs: 200_000, sizeBytes: 16, ext: '.mp3', changeKey: '1:1',
  });
  setDbForTest(db);
  const { createApp } = await import('../../src/app.js');
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  setDbForTest(null);
  server.close();
  await fs.rm(musicDir, { recursive: true, force: true });
  await fs.rm(dropoffDir, { recursive: true, force: true });
});

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  body: JSON.stringify(body),
});

test('creates a playlist and adds an item that resolves', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Trip' })).json();
  assert.ok(created.id);

  const added = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  assert.equal(added.status, 200);

  const body = await (await fetch(`${baseUrl}/api/playlists/${created.id}`)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].track.title, 'One');
});

test('rejects a blank name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: '   ' });
  assert.equal(res.status, 400);
});

test('rejects a duplicate name with a 409', async () => {
  await postJson(`${baseUrl}/api/playlists`, { name: 'Dupe' });
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'dupe' });
  assert.equal(res.status, 409);
});

test('rejects a rename onto an existing name with a 409, not a 500', async () => {
  await postJson(`${baseUrl}/api/playlists`, { name: 'Taken' });
  const other = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Free' })).json();

  const res = await fetch(`${baseUrl}/api/playlists/${other.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ name: 'taken' }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'DUPLICATE_NAME');
  // The message is what the rename form renders — "Internal server error" is
  // not something a user can act on.
  assert.match(body.error.message, /already exists/i);
});

test('rejects an over-long name', async () => {
  const res = await postJson(`${baseUrl}/api/playlists`, { name: 'x'.repeat(300) });
  assert.equal(res.status, 400);
});

test('rejects more items than the cap allows', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Big' })).json();
  const items = Array.from({ length: 5001 }, (_, i) => ({ title: `t${i}`, source: 'manual' }));
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/items`, { items });
  assert.equal(res.status, 400);
});

test('404s an unknown playlist', async () => {
  const res = await fetch(`${baseUrl}/api/playlists/99999`);
  assert.equal(res.status, 404);
});

test('exports an m3u to the music root', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'M3U Test' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(res.status, 200);
  const text = await fs.readFile(path.join(musicDir, 'M3U Test.m3u'), 'utf8');
  assert.match(text, /A\/Al\/01\.mp3/);
});

test('reports an existing m3u instead of overwriting it, including one it did not write', async () => {
  // A hand-written MUSIC_DIR/Road Trip.m3u that Spinmatch has never heard of is
  // the case with the least to go on and the most to lose: nothing records who
  // wrote an m3u, so the only safe move is to describe the file and ask.
  await fs.writeFile(path.join(musicDir, 'Road Trip.m3u'), 'hand written\n');

  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Road Trip' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });

  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'M3U_EXISTS');
  assert.equal(body.error.existing.path, path.join(musicDir, 'Road Trip.m3u'));
  assert.equal(
    await fs.readFile(path.join(musicDir, 'Road Trip.m3u'), 'utf8'), 'hand written\n',
    'the 409 wrote nothing',
  );

  const confirmed = await postJson(
    `${baseUrl}/api/playlists/${created.id}/export/m3u`, { replace: true },
  );
  assert.equal(confirmed.status, 200);
  assert.match(await fs.readFile(path.join(musicDir, 'Road Trip.m3u'), 'utf8'), /^#EXTM3U/);
});

test('reports an existing drop-off folder instead of overwriting it', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Drop' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  await fs.mkdir(path.join(dropoffDir, 'Drop'), { recursive: true });
  await fs.writeFile(path.join(dropoffDir, 'Drop', 'stale.mp3'), 'x');

  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/dropoff`, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.existing.fileCount, 1);
  // The status and the count are not the guarantee — this is. A 409 means the
  // export has not run, and this is the only test in the suite that pins
  // "touches nothing" on the one endpoint in this app that deletes files.
  assert.deepEqual(await fs.readdir(path.join(dropoffDir, 'Drop')), ['stale.mp3']);
});

// A GET is reachable by pasting the URL into a logged-in browser's address bar.
test('the drop-off export is POST-only', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'NoGet' })).json();
  const res = await fetch(`${baseUrl}/api/playlists/${created.id}/export/dropoff`, {
    headers: { 'Sec-Fetch-Site': 'none' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await fs.readdir(dropoffDir).then((d) => d.includes('NoGet')), false);
});

test('an export the client abandons part-way is not recorded as the last export', async (t) => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Abandoned' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [1, 2, 3].map(() => ({ artist: 'A', title: 'One', source: 'manual' })),
  });
  const { copyFile } = fs;
  t.mock.method(fs, 'copyFile', async (...args) => {
    await new Promise((r) => setTimeout(r, 100));
    return copyFile(...args);
  });

  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/api/playlists/${created.id}/export/dropoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({}),
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('event: progress')) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();

  // Let the server notice the hang-up and finish the copy in flight.
  await new Promise((r) => setTimeout(r, 400));
  const body = await (await fetch(`${baseUrl}/api/playlists/${created.id}`)).json();
  assert.equal(body.lastExportedAt, null);
  assert.ok((await fs.readdir(path.join(dropoffDir, 'Abandoned'))).length < 3, 'the export really was cut short');
});

test('refuses to export over the folder another playlist last exported to', async () => {
  // "Mix: 2024" and "Mix 2024" are two playlists — name_key only lowercases —
  // but sanitizeSegment strips the colon, so both land in DROPOFF_DIR/Mix 2024.
  const first = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Mix 2024' })).json();
  await postJson(`${baseUrl}/api/playlists/${first.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  const exported = await postJson(`${baseUrl}/api/playlists/${first.id}/export/dropoff`, {});
  assert.match(await exported.text(), /event: done/);

  const second = await (await postJson(`${baseUrl}/api/playlists`, { name: 'Mix: 2024' })).json();
  await postJson(`${baseUrl}/api/playlists/${second.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  // replace: true is the dangerous click: the one that used to delete the other
  // playlist's export after a confirmation that called it this playlist's.
  const res = await postJson(`${baseUrl}/api/playlists/${second.id}/export/dropoff`, { replace: true });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Mix 2024/);
  assert.deepEqual(await fs.readdir(path.join(dropoffDir, 'Mix 2024')), ['1 - A - One.mp3']);
});

test('a 409 on drop-off touches no byte of what is already there', async () => {
  // The existing 'reports an existing drop-off folder' test above asserts
  // presence (the filename survives). This asserts content: a truncate that
  // ran before the export failed would leave the filename in place but the
  // bytes gone, and readdir alone would not catch that.
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'DropContent' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  await fs.mkdir(path.join(dropoffDir, 'DropContent'), { recursive: true });
  const staleContent = 'not touched by a refused export';
  await fs.writeFile(path.join(dropoffDir, 'DropContent', 'stale.mp3'), staleContent);

  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/dropoff`, {});
  assert.equal(res.status, 409);
  assert.equal(
    await fs.readFile(path.join(dropoffDir, 'DropContent', 'stale.mp3'), 'utf8'),
    staleContent,
    'the bytes are untouched, not just the filename',
  );
});

test('a playlist name that sanitizes to "Unknown" still exports', async () => {
  // cleanName only trims and length-checks — it does not run sanitizeSegment
  // — so a name of nothing but characters sanitizeSegment strips (/ \ : * ?
  // " < > | and friends) is a legal playlist name. The export path is where
  // sanitizeSegment actually runs, folding it to the 'Unknown' fallback.
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: '???' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  const res = await postJson(`${baseUrl}/api/playlists/${created.id}/export/m3u`, {});
  assert.equal(res.status, 200);
  const text = await fs.readFile(path.join(musicDir, 'Unknown.m3u'), 'utf8');
  assert.match(text, /A\/Al\/01\.mp3/);
});

test('deleting a playlist over HTTP removes its item rows, not just the 200', async () => {
  const created = await (await postJson(`${baseUrl}/api/playlists`, { name: 'CascadeMe' })).json();
  await postJson(`${baseUrl}/api/playlists/${created.id}/items`, {
    items: [{ artist: 'A', title: 'One', source: 'manual' }],
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(created.id).n,
    1,
  );

  const res = await fetch(`${baseUrl}/api/playlists/${created.id}`, {
    method: 'DELETE', headers: { Origin: baseUrl },
  });
  assert.equal(res.status, 200);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(created.id).n,
    0,
    'the item rows are gone from the table, not just unreachable through the deleted playlist',
  );
});

test('config advertises whether export to player is available', async () => {
  const body = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(body.playlistExportEnabled, true);
});

test('import: creates the playlist, path and #EXTINF hits resolve, the rest are gaps', async () => {
  const text = [
    '#EXTM3U',
    'A/Al/01.mp3',
    '#EXTINF:200,A - One',
    'C:\\Users\\me\\Music\\elsewhere.mp3',
    '#EXTINF:100,Nobody - Nothing',
    '../../etc/passwd',
  ].join('\r\n');
  const res = await postJson(`${baseUrl}/api/playlists/import`, { name: 'Imported', text });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.playlist.name, 'Imported');
  assert.equal(body.added, 3);
  assert.equal(body.gaps, 1);
  assert.equal(body.truncated, false);

  const saved = await (await fetch(`${baseUrl}/api/playlists/${body.playlist.id}`)).json();
  assert.deepEqual(saved.items.map((i) => [i.source, i.title, Boolean(i.track)]), [
    ['import', 'One', true], ['import', 'One', true], ['import', 'Nothing', false],
  ]);

  const dupe = await postJson(`${baseUrl}/api/playlists/import`, { name: 'imported', text });
  assert.equal(dupe.status, 409);
});

test('import: reports truncation past 5000 entries', async () => {
  const text = Array.from({ length: 5001 }, (_, i) => `x${i}.mp3`).join('\n');
  const res = await postJson(`${baseUrl}/api/playlists/import`, { name: 'Over the cap', text });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.added, 5000);
  assert.equal(body.truncated, true);
});

test('import: an empty file or missing text is a 400 and creates nothing', async () => {
  for (const payload of [{ name: 'Empty', text: '#EXTM3U\n' }, { name: 'Empty' }]) {
    assert.equal((await postJson(`${baseUrl}/api/playlists/import`, payload)).status, 400);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE name = 'Empty'").get().n, 0);
});

test('import accepts a 1 MB body; other routes still refuse it; import refuses 3 MB', async () => {
  const text = `${'#'.repeat(1024 * 1024)}\nA/Al/01.mp3`;
  const ok = await postJson(`${baseUrl}/api/playlists/import`, { name: 'Huge', text });
  assert.equal(ok.status, 200, await ok.clone().text());

  const other = await postJson(`${baseUrl}/api/playlists`, { name: 'x', pad: text });
  assert.equal(other.status, 413);
  // Another spelling reaches the same route but gets the small global parser.
  const otherSpelling = await postJson(`${baseUrl}/api/Playlists/import`, { name: 'Huge2', text });
  assert.equal(otherSpelling.status, 413);

  const tooBig = await postJson(`${baseUrl}/api/playlists/import`, {
    name: 'Huger', text: 'x'.repeat(3 * 1024 * 1024),
  });
  assert.equal(tooBig.status, 413);
});
