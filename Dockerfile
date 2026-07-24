# ---- Build stage: install all workspace deps, build the Vite client ----
FROM node:24-bookworm AS build
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
FROM node:24-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The SQLite index (and the admin login stored alongside it) must live on a
# mounted volume so it survives rebuilds; compose/unraid mount /data/db.
ENV LIBRARY_DB=/data/db/library.db
# yt-dlp is a Python app; the official standalone binary is a glibc-only
# PyInstaller build and isn't reliable on Alpine's musl libc, so install it
# via pip into the Python already available through apt instead.
#
# YTDLP_VERSION pins a specific release when set (CI passes the latest from
# PyPI and stamps it as a label so the publish workflow can tell which yt-dlp
# a published image contains). An empty value installs the latest — the
# default for plain local `docker build`.
#
# chromaprint provides the `fpcalc` binary used by the local library ingest
# feature.
ARG YTDLP_VERSION=
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip chromaprint && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --break-system-packages --no-cache-dir \
      "yt-dlp${YTDLP_VERSION:+==$YTDLP_VERSION}"
LABEL ytdlp.version=$YTDLP_VERSION
COPY server/package.json server/package.json
RUN npm install --prefix server --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY --from=build /app/client/dist client/dist

EXPOSE 3000

# Liveness probe against the public health endpoint (Node 24 has global fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
