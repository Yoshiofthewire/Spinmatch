import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getDb } from '../lib/db.js';

// Mounted behind sessionOnly: the file holds the password hash and session secret,
// so an API token can never take it.
export const backupRouter = Router();

backupRouter.get('/download', async (req, res, next) => {
  // mkdtemp is 0700, so the copy is never readable by other local users.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinmatch-backup-'));
  const file = path.join(dir, 'library.db');
  try {
    // VACUUM INTO writes a consistent copy, WAL included; copying the file would not.
    getDb().prepare('VACUUM INTO ?').run(file);
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
