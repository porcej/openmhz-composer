# OpenMHz Composer

Single-page app to browse [OpenMHz](https://openmhz.com) systems and talkgroups, pick transmissions, optionally upload extra audio, add silence between clips, and **merge everything into one WAV file** (play, download, or save locally).

The HTTP API surface matches the public backend in [`trunk-server/backend`](../trunk-server/backend) (e.g. `GET /systems`, `GET /:shortName/talkgroups`, `GET /:shortName/calls` with `filter-type=talkgroup`).

## Run locally

```bash
cd openmhz-composer
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`). The main screen focuses on **Composition** and the final mix; use **System & channels**, **Transmissions**, and **Upload clips** (full-screen overlays) to add sources. Press **Escape** or click outside / **×** to close.

## Configuration

- **API base URL** defaults to `https://api.openmhz.com` (see `trunk-server/backend/config/express.js` — production API host). You can point it at another compatible server if you self-host.

## How it works

1. **Load transmissions** — Select a system, tick one or more talkgroups, then **Load transmissions**. Uses the same filter as the main site: `filter-type=talkgroup&filter-code=…`.
2. **Select calls** — **Select all (loaded)** grabs every row in the list. **Select by time** calls the OpenMHz API (`/calls/newer` paginated) for the **currently selected channels** and a start/end time (or start + delta in seconds), merges results into the table, and selects them—even if they were never loaded with **Load transmissions**. **Shift+click** still selects a row range. **Add selected to composition** inserts them in chronological order.
3. **Uploads** — Add local audio files; they are appended to the composition list.
4. **Composition** — Reorder with Up/Down, set **silence after (ms)** per clip (default gap is configurable above the channel list). **Real-time gap scale** (0–2, default 1) multiplies the computed gap. **Real-time gaps** (OpenMHz-only) checks strict chronological order by transmission time and sets each gap to `((next start − this start) + this duration in ms) × scale` (negative clamped to 0).
5. **Merge** — Decodes each clip in the browser, resamples to 48 kHz, concatenates PCM with silence, and encodes **WAV**.
6. **Final mix** — Play, **Download WAV**, or **Save in browser** (IndexedDB). Saved items can be played, downloaded, or deleted.

## Limitations

- **CORS**: Merging uses `fetch()` + `decodeAudioData()`. If a recording URL does not allow your origin, merge may fail even though `<audio src="…">` still plays. In that case you’d need a small same-origin proxy or CORS-friendly URLs.
- **Cloudflare** and similar filters may block automated requests; a normal browser session usually works.
- **Memory**: Very long compositions load all audio into memory at once.

## Build

```bash
npm run build
```

Static output is in `dist/` (deploy to any static host).

## Docker

Build and run the production bundle with nginx:

```bash
cd openmhz-composer
docker compose up --build
```

Open **http://localhost:8080**. The container serves the built SPA on port **80** inside the image; Compose maps **8080 → 80** (change the left side in `docker-compose.yml` if needed).

Useful commands:

```bash
docker compose build    # build image only
docker compose up -d    # detached
docker compose down     # stop and remove containers
```
