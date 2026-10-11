// server/test/librarySync.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { intervalForSize, startLibrarySync, getScanStatus, trackedScan } = await import('../src/services/librarySync.js');

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

  // Triggers (e.g. the watch debounce) while the first scan is in flight must
  // not start a concurrent scan...
  await handle._triggerScan();
  await handle._triggerScan();
  assert.equal(calls, 1, 'a scan in flight should coalesce a concurrent second scan');

  // ...but they must not be lost either: exactly one follow-up scan runs.
  releaseGate();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'one rerun for any number of mid-scan triggers');

  // Idle again, so a fresh trigger runs for real.
  await handle._triggerScan();
  assert.equal(calls, 3);

  handle.stop();
});

const tick = () => new Promise((r) => setImmediate(r));

// A scan the test drives by hand: report progress, then resolve or fail.
function manualScan() {
  const runs = [];
  const scan = ({ onProgress }) => new Promise((resolve, reject) => {
    runs.push({ onProgress, resolve, reject });
  });
  return { scan, runs };
}

test('status goes idle -> scanning with progress -> done', async () => {
  const { scan, runs } = manualScan();
  const handle = startLibrarySync({ scan, watch: false });
  await tick();

  let s = getScanStatus();
  assert.equal(s.scanning, true);
  assert.equal(s.scanned, 0);
  assert.ok(s.startedAt > 0);
  assert.equal(s.watching, false);

  runs[0].onProgress(250);
  assert.equal(getScanStatus().scanned, 250);

  runs[0].resolve({ scanned: 300, added: 3, updated: 0, removed: 0 });
  await tick();
  s = getScanStatus();
  assert.equal(s.scanning, false);
  assert.equal(s.scanned, 300);
  assert.equal(s.lastSummary.added, 3);
  assert.equal(s.lastError, null);
  assert.ok(s.lastScanAt > 0);
  assert.ok(s.nextScanAt > Date.now(), 'the next timer scan is scheduled');

  handle.stop();
  assert.equal(getScanStatus().nextScanAt, null);
});

test('a failed scan sets a path-free lastError; a later success clears it', async () => {
  const before = getScanStatus().lastScanAt;
  await assert.rejects(trackedScan(async () => { throw new Error('EIO /secret/path'); }));
  let s = getScanStatus();
  assert.equal(s.scanning, false);
  assert.match(s.lastError, /failed/);
  assert.doesNotMatch(s.lastError, /secret/);
  assert.equal(s.lastScanAt, before, 'a failure is not a completed scan');

  await trackedScan(async () => ({ scanned: 1, added: 0, updated: 0, removed: 0 }));
  s = getScanStatus();
  assert.equal(s.lastError, null);
});

test('a skipped scan (unreadable MUSIC_DIR) is reported as an error', async () => {
  await trackedScan(async () => ({ scanned: 0, added: 0, updated: 0, removed: 0, skipped: true }));
  assert.match(getScanStatus().lastError, /unreadable/);
});

test('the dirty rerun keeps the status scanning and is reflected after the first scan', async () => {
  const { scan, runs } = manualScan();
  const handle = startLibrarySync({ scan, watch: false });
  await tick();
  handle._triggerScan(); // mid-scan trigger buys one rerun

  runs[0].resolve({ scanned: 10, added: 1, updated: 0, removed: 0 });
  await tick();
  let s = getScanStatus();
  assert.equal(runs.length, 2, 'the rerun started');
  assert.equal(s.scanning, true);
  assert.equal(s.scanned, 0, 'progress restarts for the rerun');
  assert.equal(s.lastSummary.added, 1, 'the first scan is already recorded');

  runs[1].resolve({ scanned: 10, added: 0, updated: 2, removed: 0 });
  await tick();
  s = getScanStatus();
  assert.equal(s.scanning, false);
  assert.equal(s.lastSummary.updated, 2);
  handle.stop();
});

test('a manual scan joining an in-flight scan keeps scanning true until both finish', async () => {
  const { scan, runs } = manualScan();
  const a = trackedScan(scan);
  const b = trackedScan(() => a);
  assert.equal(getScanStatus().scanning, true);
  runs[0].resolve({ scanned: 5, added: 0, updated: 0, removed: 0 });
  await Promise.all([a, b]);
  assert.equal(getScanStatus().scanning, false);
});
