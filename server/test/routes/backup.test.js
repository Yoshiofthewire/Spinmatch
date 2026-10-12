import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../../src/lib/db.js');
const { createApp } = await import('../../src/app.js');
const { createAdmin, hashPassword, issueToken, getSigningSecret, getAdmin } = await import('../../src/services/auth.js');
const { createToken } = await import('../../src/services/apiTokens.js');
const { createPlaylist } = await import('../../src/services/playlistRepo.js');

let db;
let server;
let base;
let cookie;

test.before(async () => {
  db = openDb(':memory:');
  setDbForTest(db);
  createAdmin(db, 'admin', await hashPassword('testpass123'));
  createPlaylist(db, { name: 'Road trip' });
  cookie = `spinmatch_session=${issueToken(getSigningSecret(db), 'admin', getAdmin(db).tokenEpoch)}`;
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => { server.close(); setDbForTest(null); });

const tempCopies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('spinmatch-backup-'));

test('a session downloads a consistent SQLite copy, and the temp copy is removed', async () => {
  const before = tempCopies().length;
  const res = await fetch(`${base}/api/backup/download`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="spinmatch-\d{4}-\d{2}-\d{2}\.db"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spm-check-')), 'copy.db');
  fs.writeFileSync(out, bytes);
  const copy = new DatabaseSync(out);
  assert.deepEqual(copy.prepare('SELECT name FROM playlists').all().map((r) => r.name), ['Road trip']);
  copy.close();
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  // Removed right after the last byte is sent, so allow it a moment.
  for (let i = 0; i < 50 && tempCopies().length !== before; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(tempCopies().length, before, 'no temp copy left behind');
});

test('no session is 401, and an API token is refused even with full scope', async () => {
  assert.equal((await fetch(`${base}/api/backup/download`)).status, 401);
  const { token } = createToken(db, { name: 'script', scope: 'full' });
  const res = await fetch(`${base}/api/backup/download`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
});

test('the backup never contains the session-signing secret, not even in free pages', async () => {
  const secret = getSigningSecret(db);
  const bytes = Buffer.from(await (await fetch(`${base}/api/backup/download`, { headers: { cookie } })).arrayBuffer());
  assert.equal(bytes.includes(Buffer.from(secret)), false, 'secret bytes absent');

  // A restored copy makes a fresh secret, so an old session cookie no longer works there.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spm-restore-')), 'library.db');
  fs.writeFileSync(out, bytes);
  const restored = openDb(out);
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM auth_secret').get().n, 0);
    const { sessionFromToken } = await import('../../src/services/auth.js');
    const token = cookie.split('=')[1];
    assert.equal(sessionFromToken(restored, token), null);
    assert.notEqual(getSigningSecret(restored), secret);
  } finally {
    restored.close();
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('a failure creating the temp copy answers 500 rather than hanging', async (t) => {
  t.mock.method(fs, 'mkdtempSync', () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
  const res = await fetch(`${base}/api/backup/download`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 500);
});
