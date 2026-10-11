# ---- Build stage: install all workspace deps, build the Vite client ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY server server
COPY client client
RUN npm run build

# ---- Runtime stage: server + its production deps + the built client only ----
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# SQLite index + admin login; must live on a mounted volume.
ENV LIBRARY_DB=/data/db/library.db
# Features are gated on these vars; defaulting them makes the volume mount the
# whole configuration. A missing mount just shows an empty library/folder.
ENV INGEST_DIR=/data/ingest
ENV MUSIC_DIR=/data/music
# yt-dlp via pip: its standalone binary is glibc-only. YTDLP_VERSION pins a
# release (empty = latest); the label lets the publish workflow detect updates.
# chromaprint provides fpcalc.
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

# No `USER`: the entrypoint drops root to PUID/PGID at runtime, since only the
# operator knows which uid owns the mounted volumes. su-exec execs (no fork), so
# signals still reach node.
RUN apk add --no-cache su-exec
RUN mkdir -p /data/db /data/ingest /data/music && chown -R node:node /data /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
