import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';
// Intentionally NOT setting MUSIC_DIR or INGEST_DIR so that ingestEnabled()
// returns false. ACOUSTID_API_KEY is irrelevant to this gate (see
// ingest-no-acoustid.test.js for the "enabled without a key" case).

const { createApp } = await import('../../src/app.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp({ gate: (req, res, next) => next() });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

test('GET /api/ingest/scan returns 404 when ingest is disabled', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/scan`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
});
