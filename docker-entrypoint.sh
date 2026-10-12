#!/bin/sh
set -e

# Drops root to PUID:PGID (the uid that owns the operator's mounts; Unraid uses
# 99:100). yt-dlp, fpcalc and the tag parser must never run as uid 0.

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Started with --user: already unprivileged, nothing to chown.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# su-exec doesn't set HOME, and yt-dlp caches there. Best-effort: no cache is
# only slower.
export HOME=/home/node
{ mkdir -p "$HOME" && chown "$PUID:$PGID" "$HOME"; } 2>/dev/null || true

# chown only the app's own DB dir, never the user's music/ingest files.
# Non-fatal: the server's startup check explains the failure better than set -e.
DB_DIR=$(dirname "${LIBRARY_DB:-/data/db/library.db}")
{ mkdir -p "$DB_DIR" && chown -R "$PUID:$PGID" "$DB_DIR"; } 2>/dev/null \
  || echo "entrypoint: could not prepare $DB_DIR as $PUID:$PGID — startup will report why." >&2

# exec so node is PID 1 and receives SIGTERM for graceful shutdown.
exec su-exec "$PUID:$PGID" "$@"
