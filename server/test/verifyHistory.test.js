import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDbForTest } from '../src/lib/db.js';
import {
  recordHistory, listHistory, clearHistory, importHistory, MAX_HISTORY, MAX_IMPORT,
} from '../src/services/verifyHistory.js';

let db;
test.beforeEach(() => {
  db = openDb(':memory:');
  setDbForTest(db);
});
test.afterEach(() => {
  setDbForTest(null);
  db.close();
});

const entry = (over = {}) => ({ track: 'Roygbiv', artist: 'Boards of Canada', album: 'MHTRTC', action: 'verified', timestamp: 1_000, ...over });

test('recordHistory stores a row that listHistory returns newest first with a total', () => {
  recordHistory({ artist: 'A', title: 'First', action: 'verified', status: 'confirmed', videoId: 'v1', recordingMbid: 'm1' });
  recordHistory({ artist: 'A', title: 'Second', album: 'Alb', action: 'ingested' });

  const { entries, total } = listHistory({ limit: 10, offset: 0 });
  assert.equal(total, 2);
  assert.deepEqual(entries.map((e) => e.title), ['Second', 'First']);
  assert.equal(entries[1].status, 'confirmed');
  assert.equal(entries[1].videoId, 'v1');
  assert.equal(entries[1].recordingMbid, 'm1');
  assert.equal(entries[0].status, null);
  assert.equal(typeof entries[0].createdAt, 'number');
});

test('listHistory pages with limit and offset', () => {
  importHistory([1, 2, 3, 4, 5].map((n) => entry({ track: `T${n}`, timestamp: n * 1000 })));
  const page = listHistory({ limit: 2, offset: 2 });
  assert.equal(page.total, 5);
  assert.deepEqual(page.entries.map((e) => e.title), ['T3', 'T2']);
});

test('recording beyond the cap prunes the oldest rows', () => {
  const insert = db.prepare("INSERT INTO verify_history (title, action, created_at) VALUES (?, 'verified', ?)");
  for (let i = 0; i < MAX_HISTORY; i += 1) insert.run(`old ${i}`, i + 1);

  recordHistory({ title: 'newest', action: 'verified' });
  const { entries, total } = listHistory({ limit: 1, offset: 0 });
  assert.equal(total, MAX_HISTORY);
  assert.equal(entries[0].title, 'newest');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verify_history WHERE title = 'old 0'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verify_history WHERE title = 'old 1'").get().n, 1);
});

test('clearHistory deletes everything and reports how much', () => {
  recordHistory({ title: 'x', action: 'verified' });
  recordHistory({ title: 'y', action: 'verified' });
  assert.equal(clearHistory(), 2);
  assert.equal(listHistory({ limit: 10, offset: 0 }).total, 0);
});

test('a failed history write does not throw into the caller', (t) => {
  t.mock.method(console, 'warn', () => {});
  db.exec('DROP TABLE verify_history');
  assert.doesNotThrow(() => recordHistory({ title: 'x', action: 'verified' }));
  assert.equal(console.warn.mock.callCount(), 1);
});

test('importHistory maps legacy entries and skips invalid ones', () => {
  const result = importHistory([
    entry(),
    entry({ track: 'Ingested', action: 'ingested', artist: undefined, album: undefined }),
    // Old MeTube 'sent' entries are not verifications.
    entry({ action: 'sent' }),
    entry({ track: '' }),
    entry({ track: 42 }),
    entry({ artist: ['x'] }),
    entry({ track: 'x'.repeat(501) }),
    entry({ album: 'x'.repeat(501) }),
    entry({ timestamp: 'yesterday' }),
    entry({ timestamp: -5 }),
    entry({ timestamp: 1.5 }),
    null,
    'nope',
  ]);
  assert.deepEqual(result, { imported: 2, skipped: 11 });
  const { entries } = listHistory({ limit: 10, offset: 0 });
  assert.deepEqual(entries.map((e) => [e.title, e.artist, e.album, e.action, e.createdAt]), [
    ['Ingested', null, null, 'ingested', 1000],
    ['Roygbiv', 'Boards of Canada', 'MHTRTC', 'verified', 1000],
  ]);
});

test('importHistory is safe to run twice: repeats are skipped', () => {
  const batch = [entry(), entry({ track: 'Other', timestamp: 2000 }), entry({ artist: null })];
  assert.deepEqual(importHistory(batch), { imported: 3, skipped: 0 });
  assert.deepEqual(importHistory(batch), { imported: 0, skipped: 3 });
  assert.equal(listHistory({ limit: 10, offset: 0 }).total, 3);
});

test('importHistory clamps future timestamps to now', () => {
  const before = Date.now();
  importHistory([entry({ timestamp: before + 10 * 365 * 24 * 3600 * 1000 })]);
  const [row] = listHistory({ limit: 1, offset: 0 }).entries;
  assert.ok(row.createdAt >= before && row.createdAt <= Date.now());
});

test('importHistory rejects a non-array or an oversized batch', () => {
  assert.throws(() => importHistory('x'), { code: 'BAD_REQUEST' });
  assert.throws(() => importHistory(undefined), { code: 'BAD_REQUEST' });
  assert.throws(() => importHistory(Array.from({ length: MAX_IMPORT + 1 }, () => entry())), { code: 'BAD_REQUEST' });
  assert.equal(importHistory(Array.from({ length: MAX_IMPORT }, (_, i) => entry({ timestamp: i + 1 }))).imported, MAX_IMPORT);
});
