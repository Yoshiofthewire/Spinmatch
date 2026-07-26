# ---- Build stage: install all workspace deps, build the Vite client ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
# npm ci installs exactly what the lockfile pins (reproducible), unlike npm
# install which can silently resolve newer versions and rewrite the lockfile.
RUN npm ci
COPY server server
COPY client client
RUN npm run build

# ---- Runtime stage: server + its production deps + the built client only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The SQLite index (and the admin login stored alongside it) must live on a
# mounted volume so it survives rebuilds; compose/unraid mount /data/db.
ENV LIBRARY_DB=/data/db/library.db
# The ingest drop-folder and music library are gated on these being set, and a
# volume mount alone does not set them — Unraid's template, in particular, maps
# the paths without exporting any variable, which left both pages permanently
# hidden. Default them to the container paths that compose/unraid already mount
# so the mount is the whole configuration. Absent mounts degrade quietly: the
# library scan skips an unreadable tree and ingest reports an empty folder.
ENV INGEST_DIR=/data/ingest
ENV MUSIC_DIR=/data/music
# yt-dlp is a Python app; the official standalone binary is a glibc-only
# PyInstaller build and isn't reliable on Alpine's musl libc, so install it
# via pip into the Python already available through apk instead.
#
# YTDLP_VERSION pins a specific release when set (CI passes the latest from
# PyPI and stamps it as a label so the publish workflow can tell which yt-dlp
# a published image contains). An empty value installs the latest — the
# default for plain local `docker build`.
#
# chromaprint provides the `fpcalc` binary used by the local library ingest
# feature (musl-native on Alpine — no glibc concern like yt-dlp's standalone
# binary had).
ARG YTDLP_VERSION=
RUN apk add --no-cache python3 py3-pip chromaprint && \
    pip install --break-system-packages --no-cache-dir \
      "yt-dlp${YTDLP_VERSION:+==$YTDLP_VERSION}"
LABEL ytdlp.version=$YTDLP_VERSION
COPY server/package.json server/package.json
RUN npm install --prefix server --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY --from=build /app/client/dist client/dist

# Drop root — but at runtime, in the entrypoint, not here. This process shells
# out to yt-dlp (which parses hostile HTML off YouTube) and fpcalc, and feeds
# arbitrary downloaded files into a native tag parser, none of which has any
# business running as uid 0 with the user's music library mounted read-write.
#
# A baked-in `USER node` did the dropping but picked the uid at build time, which
# is the one decision the image cannot make: a bind mount keeps its host
# ownership, so the chown below applies to the image layer and is masked the
# moment a volume is mounted over it. An install upgraded from a root-era image
# had a root-owned /data/db, the unprivileged process could not create the
# -wal/-shm files WAL needs, and every request — including the login the operator
# was staring at — answered "Internal server error".
#
# The entrypoint takes PUID/PGID instead (99:100 on Unraid, 1000:1000 by
# default), fixes up the database directory, and drops privileges itself.
# su-exec is Alpine's ~10KB setuid-and-exec helper; it replaces the process
# rather than forking, so signals and exit codes still reach node directly and
# the graceful shutdown in index.js keeps working.
RUN apk add --no-cache su-exec
RUN mkdir -p /data/db /data/ingest /data/music && chown -R node:node /data /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000

# Liveness probe against the public health endpoint (Node 24 has global fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
