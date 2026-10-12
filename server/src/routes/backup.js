import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../lib/db.js';

// Mounted behind sessionOnly: the file holds the password hash, so an API token can
// never take it.
export const backupRouter = Router();

backupRouter.get('/download', async (req, res, next) => {
  let dir = null;
  try {
    // mkdtemp is 0700, so the copy is never readable by other local users.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-backup-'));
    const file = path.join(dir, 'library.db');
    // VACUUM INTO writes a consistent copy, WAL included; copying the file would not.
    getDb().prepare('VACUUM INTO ?').run(file);
    sanitize(file);
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="spinmatch-${stamp}.db"`,
      'Content-Length': String(fs.statSync(file).size),
      'Cache-Control': 'no-store',
    });
    await pipeline(fs.createReadStream(file), res);
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.destroy(err);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The session-signing secret would let whoever holds a backup mint sessions that
// survive logout and password changes, so it never leaves; a restore makes a new one
// (everyone signs in again). In-flight OIDC round trips are dropped too. VACUUM then
// rewrites the file so the deleted rows aren't left in free pages.
function sanitize(file) {
  const copy = new DatabaseSync(file);
  try {
    copy.exec('DELETE FROM auth_secret; DELETE FROM oidc_pending; VACUUM;');
  } finally {
    copy.close();
  }
}
