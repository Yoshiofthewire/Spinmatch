# Tubarr

Search MusicBrainz for an artist, album, or song, browse album art and tracklists, and get a
YouTube link for a track — verified by cross-checking the video's duration against the
MusicBrainz-recorded track length.

This app **only finds and verifies YouTube links**. It does not download or rip audio.

## Prerequisites

- Node.js 20+ (Node 24 recommended — this project uses native `fetch` and `--env-file`)
- A YouTube Data API v3 key (see below)

## Setting up a YouTube Data API v3 key

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project
   (e.g. "tubarr").
2. Navigate to **APIs & Services → Library**, search for "YouTube Data API v3", and click **Enable**.
3. Navigate to **APIs & Services → Credentials → Create Credentials → API key**.
4. Click **Restrict key**, and under "API restrictions" choose **Restrict key** and select only
   **YouTube Data API v3** — this limits the blast radius if the key ever leaks.
5. Copy the key.
6. The free tier gives you 10,000 quota units/day. Each track lookup costs about 101 units
   (100 for the search, ~1 for the batched duration lookup), so roughly 100 single-track
   lookups per day, or fewer if you use the bulk "Find all on YouTube" album action. You can
   check your usage under **APIs & Services → Enabled APIs → YouTube Data API v3 → Quotas**.

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```
PORT=3000
YOUTUBE_API_KEY=your-key-here
MB_CONTACT_EMAIL=you@example.com
MB_APP_NAME=Tubarr
MB_APP_VERSION=0.1.0
METUBE_URL=
```

`MB_CONTACT_EMAIL` is required by [MusicBrainz's API usage policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) —
every request must identify itself with a real contact email in its `User-Agent` string, or
MusicBrainz may block the app's IP.

### Optional: sending videos to MeTube

If you run a [MeTube](https://github.com/alexta69/metube) instance, set `METUBE_URL` to its base
URL (e.g. `https://metube.example.com`) and a "Send to MeTube" button appears next to every
YouTube result. Leave it blank to hide the button entirely.

The request is sent directly from your browser to `{METUBE_URL}/add`, not proxied through this
app's server — the same way MeTube's own bookmarklet works — so your browser's session/cookies
for that origin are used, and your MeTube instance must allow cross-origin requests from wherever
this app is hosted.

## Running locally

```
npm install
npm run dev
```

This runs the Express backend (with `--env-file=../.env`, picking up `.env` from the repo root)
and the Vite dev server concurrently. Open http://localhost:5173.

## Running in production

```
npm install
npm run build
npm start
```

`npm start` runs the Express server directly (reading `.env` via `--env-file`), serving the
built client from `client/dist` on `$PORT` (default 3000).

## Running with Docker

```
cp .env.example .env   # fill in your values
docker compose up --build
```

The app will be available at http://localhost:3000. The container builds the client and runs
the server in a single image — no separate frontend container needed.

## Tests

```
npm test
```

Runs the backend test suite (Node's built-in test runner, with `undici`'s `MockAgent`
mocking MusicBrainz/YouTube — no live API calls, no quota used). There are no automated
frontend tests; verify UI changes by running `npm run dev` and testing in a browser.
