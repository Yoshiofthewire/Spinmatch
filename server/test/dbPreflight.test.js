import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { dbWritabilityError } = await import('../src/lib/dbPreflight.js');

// Running as root defeats every permission check below: root writes through
// mode 0500 regardless. Skipping is honest; pretending to test it is not.
const asRoot = process.getuid?.() === 0;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-preflight-'));
}

test('no error for a writable directory', () => {
  const dir = tmpDir();
  try {
    assert.equal(dbWritabilityError(path.join(dir, 'library.db')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no error for the in-memory database used by tests', () => {
  assert.equal(dbWritabilityError(':memory:'), null);
});

test('creates a missing directory rather than reporting it as broken', () => {
  const dir = tmpDir();
  try {
    const nested = path.join(dir, 'db', 'library.db');
    assert.equal(dbWritabilityError(nested), null);
    assert.equal(fs.existsSync(path.dirname(nested)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports an unwritable directory, naming the path and the uid', { skip: asRoot }, () => {
  const dir = tmpDir();
  try {
    fs.chmodSync(dir, 0o500);
    const message = dbWritabilityError(path.join(dir, 'library.db'));
    assert.ok(message, 'expected an error message');
    assert.match(message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(message, new RegExp(`uid ${process.getuid()}`));
    // The whole point of the check is that the log says what to do about it.
    // Which command it suggests depends on who owns the directory — see below.
    assert.match(message, /Fix it with/);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A directory this uid already owns but cannot write is a mode problem, not an
// ownership one, and telling the operator to chown something they already own
// sends them in a circle.
test('advises chmod, not chown, when the uid already owns the directory', { skip: asRoot }, () => {
  const dir = tmpDir();
  try {
    fs.chmodSync(dir, 0o500);
    const message = dbWritabilityError(path.join(dir, 'library.db'));
    assert.ok(message, 'expected an error message');
    assert.match(message, /chmod/);
    assert.doesNotMatch(message, /chown/);
    assert.doesNotMatch(message, /owned by/);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports an existing database file the process cannot write', { skip: asRoot }, () => {
  const dir = tmpDir();
  try {
    const dbPath = path.join(dir, 'library.db');
    fs.writeFileSync(dbPath, '');
    fs.chmodSync(dbPath, 0o400);
    const message = dbWritabilityError(dbPath);
    assert.ok(message, 'expected an error message');
    assert.match(message, /library\.db/);
    assert.match(message, /Fix it with/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// WAL is the specific reason a *readable* database still isn't enough: SQLite
// creates library.db-wal and library.db-shm alongside it, so a read-only
// directory breaks the app even when the file itself is writable.
test('reports a writable file in a read-only directory', { skip: asRoot }, () => {
  const dir = tmpDir();
  try {
    const dbPath = path.join(dir, 'library.db');
    fs.writeFileSync(dbPath, '');
    fs.chmodSync(dir, 0o500);
    assert.ok(dbWritabilityError(dbPath), 'expected an error message');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
