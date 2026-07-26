import fs from 'node:fs';
import path from 'node:path';

// The SQLite index lives on a bind-mounted volume, and the container runs as an
// unprivileged uid. A directory created by an older root-owned container is
// owned by root, and the new uid cannot create the -wal/-shm files WAL mode
// needs — so openDb() threw on the first request that touched the database, and
// because getDb() is lazy that surfaced as every route answering "Internal
// server error" with the real cause buried in the log. A login screen that
// 500s tells the operator nothing about a volume's ownership.
//
// Checked at boot instead, and reported as one line naming the path, the uid
// the process is actually running as, who owns the directory, and the command
// that fixes it.
//
// Writability is tested by writing, not by fs.accessSync: access() answers for
// the classic uid/gid bits and is wrong under ACLs, read-only mounts, and root
// (for whom W_OK is always true even on a read-only filesystem). The only
// reliable question is whether a file can actually be created.
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
  // getuid is POSIX-only; on Windows there is no uid to report.
  return process.getuid ? `uid ${process.getuid()}:gid ${process.getgid()}` : 'this user';
}

// Two different failures wear the same symptom, and they have opposite fixes.
// Someone else owns it — the upgraded-from-root case — needs a chown. A
// directory this uid already owns but cannot write is a mode problem, and
// telling the operator to chown something they already own sends them round in
// a circle. So the diagnosis names whichever one is actually true.
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

/**
 * @param {string} dbPath — the configured LIBRARY_DB path
 * @returns {string|null} a message to log and die on, or null when all is well
 */
export function dbWritabilityError(dbPath) {
  // ':memory:' is what the tests open, and it touches no filesystem at all.
  if (!dbPath || dbPath === ':memory:') return null;

  const dir = path.dirname(dbPath);

  // openDb() does this same mkdir, so creating it here changes nothing about a
  // healthy start — it just moves the failure into a message that explains it.
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

  // The directory is writable (the probe above passed) but the database in it is
  // not — a file left behind by a container that ran as a different uid.
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

// Called from index.js at startup, alongside assertRequiredConfig.
export function assertDbWritable(dbPath) {
  const message = dbWritabilityError(dbPath);
  if (message) {
    console.error(`Spinmatch cannot start: ${message}`);
    process.exit(1);
  }
}
