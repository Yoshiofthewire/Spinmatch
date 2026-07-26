#!/bin/sh
set -e

# Runs as root, hands off to an unprivileged user. Two requirements that pull in
# opposite directions.
#
# 1. This process shells out to yt-dlp and fpcalc and feeds downloaded files to a
#    native tag parser, none of which should run as uid 0 with the user's music
#    library mounted read-write. So it must drop privileges.
#
# 2. The uid it drops to has to be one that can write the mounted volumes. A
#    baked-in `USER node` cannot know that: a bind mount keeps its host
#    ownership, so the image's chown is masked at runtime and the uid is whatever
#    the Dockerfile happened to pick. Unraid's convention is 99:100
#    (nobody:users), the Debian/Ubuntu default is 1000:1000, a NAS may use
#    something else again.
#
# PUID/PGID resolves it: the operator names the uid that owns their shares and
# this script becomes it. Defaults to 1000:1000 — the `node` user the image
# ships, and what the previous baked-in `USER node` was already using.

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Already unprivileged: someone ran the container with `--user`. Respect that and
# get out of the way — we could not chown anything in that case regardless.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# su-exec switches uid without consulting /etc/passwd, so no account has to exist
# for the requested id and the `shadow` package is not needed. What it does not
# do is set HOME, which would otherwise stay /root — unwritable for the target
# uid, and yt-dlp puts its cache under $HOME. Pointing it at a directory this uid
# owns keeps that working.
#
# Best-effort, and deliberately not fatal under `set -e`: a cache directory the
# target uid cannot claim degrades yt-dlp to an uncached run, which is a slower
# download, not a broken server. Refusing to start over it would be worse than
# the problem.
export HOME=/home/node
{ mkdir -p "$HOME" && chown "$PUID:$PGID" "$HOME"; } 2>/dev/null || true

# Only the database directory, and only ever this one. It is the app's own
# private storage — the SQLite index and the admin login — it is small, and an
# install upgraded from a root-era image has it owned by root, which is exactly
# the failure this script exists to stop recurring.
#
# /data/music and /data/ingest are deliberately NOT touched. Those are the user's
# files: a recursive chown of a music library is slow, is not ours to make, and
# cannot be undone. If they aren't writable the server reports it and the
# operator decides.
#
# Both steps are best-effort. Failing here means the server is not going to
# start, but it is the server that knows how to say why — naming the path, the
# uid, the owner, and the command that fixes it. Dying at `set -e` in a shell
# script would replace that with silence, which is the failure mode this whole
# change exists to remove.
DB_DIR=$(dirname "${LIBRARY_DB:-/data/db/library.db}")
{ mkdir -p "$DB_DIR" && chown -R "$PUID:$PGID" "$DB_DIR"; } 2>/dev/null \
  || echo "entrypoint: could not prepare $DB_DIR as $PUID:$PGID — startup will report why." >&2

# exec, so node replaces this shell as PID 1 and SIGTERM reaches it directly:
# the graceful shutdown in index.js depends on receiving that signal itself.
exec su-exec "$PUID:$PGID" "$@"
