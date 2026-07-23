# ---- Build stage: install all workspace deps, build the Vite client ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm install
COPY server server
COPY client client
RUN npm run build

# ---- Runtime stage: server + its production deps + the built client only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# yt-dlp is a Python app; the official standalone binary is a glibc-only
# PyInstaller build and isn't reliable on Alpine's musl libc, so install it
# via pip into the Python already available through apk instead.
#
# YTDLP_VERSION pins a specific release when set (CI passes the latest from
# PyPI and stamps it as a label so the publish workflow can tell which yt-dlp
# a published image contains). An empty value installs the latest — the
# default for plain local `docker build`.
ARG YTDLP_VERSION=
RUN apk add --no-cache python3 py3-pip && \
    pip install --break-system-packages --no-cache-dir \
      "yt-dlp${YTDLP_VERSION:+==$YTDLP_VERSION}"
LABEL ytdlp.version=$YTDLP_VERSION
COPY server/package.json server/package.json
RUN npm install --prefix server --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY --from=build /app/client/dist client/dist

EXPOSE 3000
CMD ["node", "server/src/index.js"]
