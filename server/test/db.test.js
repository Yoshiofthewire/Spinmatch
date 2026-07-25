import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb } = await import('../src/lib/db.js');

test('openDb creates the collection tables', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes('local_tracks'), 'local_tracks exists');
  assert.ok(names.includes('collection_stats'), 'collection_stats exists');
  assert.ok(!names.includes('verified_tracks'), 'verified_tracks is gone');
  db.close();
});

test('openDb enforces the single-row constraint on collection_stats', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (1, 0)').run();
  assert.throws(
    () => db.prepare('INSERT INTO collection_stats (id, total_tracks) VALUES (2, 0)').run(),
    /CHECK/i
  );
  db.close();
});
