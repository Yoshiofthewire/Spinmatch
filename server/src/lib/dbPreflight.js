import fs from 'node:fs';
import path from 'node:path';

// Boot-time check that the DB volume is writable by our uid, with an actionable fix.
// Probe by writing: access(W_OK) is wrong under ACLs, read-only mounts, and root.
function canWriteInto(dir) {
  const probe = path.join(dir, `.spinmatch-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function identity() {
  // getuid is POSIX-only.
  return process.getuid ? `uid ${process.getuid()}:gid ${process.getgid()}` : 'this user';
}

// Owned by someone else -> chown; owned by us but unwritable -> chmod.
function diagnose(target) {
  let owner = null;
  try {
    owner = fs.statSync(target);
  } catch { /* reported as unknown below */ }

  const me = process.getuid?.();
  if (owner && me !== undefined && owner.uid === me) {
    return {
      cause: `The server is running as ${identity()}, which already owns it — `
        + 'the ownership is right and only the permissions are wrong.',
      fix: `Fix it with:  chmod u+rwx ${target}`,
    };
  }
  return {
    cause: `The server is running as ${identity()} but it is owned by `
      + (owner ? `uid ${owner.uid}:gid ${owner.gid}` : 'an owner that could not be read')
      + '.',
    fix: `Fix it with:  chown -R ${me !== undefined ? `${me}:${process.getgid()}` : 'the container user'} ${target}`
      + '\nOr set PUID/PGID on the container to a uid that already owns it.',
  };
}

// Returns an error message to die on, or null.
export function dbWritabilityError(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;

  const dir = path.dirname(dbPath);

  // Same mkdir openDb() does; here it fails with an explanation.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    const { cause, fix } = diagnose(path.dirname(dir));
    return `Cannot create the database directory ${dir} (${err.code ?? err.message}).\n${cause}\n${fix}`;
  }

  if (!canWriteInto(dir)) {
    const { cause, fix } = diagnose(dir);
    return `The database directory ${dir} is not writable.\n${cause}\n`
      + 'SQLite runs in WAL mode and has to create library.db-wal and library.db-shm\n'
      + 'alongside the database, so a directory it cannot write breaks the app even\n'
      + `when the database file itself is readable.\n${fix}`;
  }

  // Writable dir, but the file may be left over from a different uid.
  if (fs.existsSync(dbPath)) {
    try {
      fs.closeSync(fs.openSync(dbPath, 'r+'));
    } catch (err) {
      const { cause, fix } = diagnose(dbPath);
      return `The database file ${dbPath} is not writable (${err.code ?? err.message}).\n${cause}\n${fix}`;
    }
  }

  return null;
}

export function assertDbWritable(dbPath) {
  const message = dbWritabilityError(dbPath);
  if (message) {
    console.error(`Spinmatch cannot start: ${message}`);
    process.exit(1);
  }
}
