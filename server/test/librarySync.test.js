// server/test/librarySync.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { intervalForSize, startLibrarySync } = await import('../src/services/librarySync.js');

test('intervalForSize scales with collection size', () => {
  assert.equal(intervalForSize(0), 30 * 60_000);
  assert.equal(intervalForSize(999), 30 * 60_000);
  assert.equal(intervalForSize(5000), 2 * 60 * 60_000);
  assert.equal(intervalForSize(50000), 4 * 60 * 60_000);
});

test('startLibrarySync runs an initial scan and stop() is clean', async () => {
  let calls = 0;
  const scan = async () => { calls += 1; return { scanned: 0, added: 0, updated: 0, removed: 0 }; };
  const handle = startLibrarySync({ scan, watch: false });
  // initial scan is kicked off synchronously; let its microtasks settle
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  handle.stop();
});

test('startLibrarySync coalesces a scan that starts while one is already in flight', async () => {
  let calls = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const scan = async () => {
    calls += 1;
    await gate;
    return { scanned: 0, added: 0, updated: 0, removed: 0 };
  };
  const handle = startLibrarySync({ scan, watch: false });
  // The initial scan runs synchronously up to its first await (the gate),
  // so `scanning` is already true by the time startLibrarySync returns.
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);

  // Simulate a second trigger (e.g. the watch debounce firing) while the
  // first scan is still in flight -- it must be coalesced (a no-op), not run.
  await handle._triggerScan();
  assert.equal(calls, 1, 'a scan in flight should coalesce a concurrent second scan');

  releaseGate();
  await new Promise((r) => setImmediate(r));

  // Now that the first scan finished, a fresh trigger should run for real.
  await handle._triggerScan();
  assert.equal(calls, 2);

  handle.stop();
});
