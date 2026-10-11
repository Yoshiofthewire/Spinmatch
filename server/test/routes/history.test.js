import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { createApp } = await import('../../src/app.js');
const { openDb, setDbForTest } = await import('../../src/lib/db.js');

let server;
let baseUrl;
let db;
const asJson = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  server = createApp({ gate: (req, res, next) => next() }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => {
  server.close();
  setDbForTest(null);
  db.close();
});

const importEntries = (entries) => fetch(`${baseUrl}/api/history/import`, {
  method: 'POST', headers: asJson, body: JSON.stringify({ entries }),
});

test('import, page, and clear history over HTTP', async () => {
  const entries = [1, 2, 3].map((n) => ({ track: `T${n}`, artist: 'A', action: 'verified', timestamp: n * 1000 }));
  const imported = await importEntries(entries);
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { imported: 3, skipped: 0 });
  // A second tab importing the same entries adds nothing.
  assert.deepEqual(await (await importEntries(entries)).json(), { imported: 0, skipped: 3 });

  const page = await (await fetch(`${baseUrl}/api/history?limit=2&offset=1`)).json();
  assert.equal(page.total, 3);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.entries.map((e) => e.title), ['T2', 'T1']);

  const cleared = await fetch(`${baseUrl}/api/history`, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.deepEqual(await cleared.json(), { cleared: 3 });
  assert.equal((await (await fetch(`${baseUrl}/api/history`)).json()).total, 0);
});

test('import rejects a body without an entries array', async () => {
  const res = await fetch(`${baseUrl}/api/history/import`, { method: 'POST', headers: asJson, body: '{}' });
  assert.equal(res.status, 400);
});
