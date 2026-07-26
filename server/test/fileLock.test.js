import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { withFileLock, pendingLockCount } = await import('../src/lib/fileLock.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The hazard: node-taglib-sharp reads a whole file, mutates it in memory, and
// writes it back. Two of those overlapping on one path destroys the file. A
// double-clicked Apply button produces exactly that overlap, because both calls
// await the same MusicBrainz lookup and are released together.
test('work on the same path does not overlap', async () => {
  const order = [];
  const first = deferred();

  const a = withFileLock('/music/a.flac', async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
  });
  const b = withFileLock('/music/a.flac', async () => {
    order.push('b:start');
    order.push('b:end');
  });

  // b must not have started while a is still in flight.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a:start']);

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('different paths run concurrently', async () => {
  const order = [];
  const held = deferred();

  const a = withFileLock('/music/a.flac', async () => {
    order.push('a:start');
    await held.promise;
  });
  const b = withFileLock('/music/b.flac', async () => { order.push('b:ran'); });

  await b;
  assert.deepEqual(order, ['a:start', 'b:ran'], 'b did not wait on an unrelated file');
  held.resolve();
  await a;
});

// A failed write must not wedge the path until restart.
test('a rejection releases the lock for the next caller', async () => {
  await assert.rejects(
    withFileLock('/music/c.flac', async () => { throw new Error('EACCES'); }),
    /EACCES/,
  );
  assert.equal(await withFileLock('/music/c.flac', async () => 'ran'), 'ran');
});

test('the rejection is delivered to the caller, not swallowed', async () => {
  const boom = new Error('boom');
  await assert.rejects(withFileLock('/music/d.flac', async () => { throw boom; }), /boom/);
});

test('settled paths are dropped so the map does not grow forever', async () => {
  const before = pendingLockCount();
  for (let i = 0; i < 50; i += 1) {
    await withFileLock(`/music/bulk-${i}.flac`, async () => i);
  }
  // Each entry clears itself once nothing is queued behind it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingLockCount(), before);
});
