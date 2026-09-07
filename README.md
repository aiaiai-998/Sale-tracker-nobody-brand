# Nobody’s Brand Live Sales

**Roblox Limited UGC live sales tracker + transparent glass stream overlay**

> Group: **Nobody’s Brand — 201198194**  
> Tracked assets: `137910150798027` • `129297459934395` • `121581072690400`  
> OBS-ready — transparent background, glassmorphism, auto-updates without refresh.

![overlay preview](https://via.placeholder.com/1280x720/0a0a0f/ffffff?text=Nobody%27s+Brand+Live+Overlay)

---

## What it does

- Header: **“Nobody’s Brand Limited UGC Live”** with live pill, link to the group, and global stats **All copies sold so far / Copies left / Total copies**
- **Latest item sold** hero card at the top (item, buyer, time, Robux — flashes on new sale)
- **Live sales feed** (right column) — each sale shows item sold, buyer name, relative time, and Robux amount — newest first
- **Limited stock** cards — one per UGC asset, each with item name, copies sold, total copies, copies remaining, price, and animated progress bar
- Near-live polling (Roblox has no instant webhooks) — **sales + stock polled every 5–10s, so the feed moves at the same time as the Robux total**
- Real-time browser updates via **Server-Sent Events (SSE)** — no refresh needed
- **Transparent background** — looks perfect as an **OBS Browser Source**

---

## How it works

```
Roblox Economy API ──poll 7s──>  Node server (server.js) ──SSE /api/events──>  Browser overlay
                              (stock: remaining / total / price / thumbnail)
```

- **Sales are detected from stock movement** — every poll of `economy.roblox.com/v2/assets/{assetId}/details` compares `Remaining` against the last poll. When copies sold go up, that exact purchase is pushed into the **Live sales feed** and **Latest item sold** instantly (the same signal that moves the Robux total, so they can never fall out of sync).
- **Buyer names are attached when a source is available**: group transactions (with the private cookie) and public item owner/instance endpoints (using the correct `collectibleItemId` UUIDs). A sale already logged anonymously as "Someone" is *upgraded in place* — never duplicated.
- Frontend connects once to `GET /api/events` (SSE) and re-renders on every `state` / `sale` event. Falls back to `GET /api/state` if SSE is buffered.
- **Cookie never leaves the server** — `ROBLOX_COOKIE` is read only from `process.env` and only sent outbound to Roblox. Frontend never sees it.
- If Roblox is unreachable or rate-limits us, the server backs off instead of hammering it, and recovers automatically.

### Public mode (no cookie)

If `ROBLOX_COOKIE` is missing/empty, the server does **not** crash. It:
- tracks 100% real stock numbers (remaining / sold / progress bars) from public endpoints,
- pushes **every real purchase** into the sales feed within seconds of the stock moving,
- shows buyers as **"Someone"** until a name source is available (a private cookie upgrades them to real usernames),
- labels the header pill **PUBLIC • LIVE**.

Add the cookie in Render → redeploy → overlay flips to **LIVE** automatically.

> **Important:** Roblox does not offer zero-delay webhooks for group sales. This project is **near-live** via fast polling, not truly instant. The README and UI never claim otherwise.

---

## Run locally

```bash
git clone https://github.com/aiaiai-998/Sale-tracker-nobody-brand.git
cd Sale-tracker-nobody-brand

# 1) env
cp .env.example .env
# edit .env — paste your private .ROBLOSECURITY cookie if you have one
# leave ROBLOX_COOKIE empty to test demo mode

# 2) install & start
npm install
npm start
# → http://localhost:3000
#   http://localhost:3000/api/state
#   http://localhost:3000/api/events  (SSE)
#   http://localhost:3000/health
```

### Environment variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `ROBLOX_GROUP_ID` | no | `201198194` | Nobody’s Brand |
| `UGC_ASSET_IDS` | no | `137910150798027,129297459934395,121581072690400` | comma-separated asset IDs |
| `POLL_INTERVAL_MS` | no | `7000` | clamped 5000–10000 |
| `INVENTORY_POLL_INTERVAL_MS` | no | `30000` | clamped 15000–30000 |
| `ROBLOX_COOKIE` | no | *(empty → demo)* | **private** `.ROBLOSECURITY` — only on server |
| `PORT` | no | `3000` | Render sets this |

Never put `ROBLOX_COOKIE` in frontend code, in git, or in `public/*`.

---

## Use as OBS Browser Source

1. **Deploy** (see below) and copy your Render URL, e.g. `https://nobodies-brand-live-sales.onrender.com`
2. OBS → Sources → **+ → Browser Source** → Create new
3. **URL:** your Render URL
4. **Width:** `1280`  **Height:** `720`  **FPS:** `30`
5. Check **Transparent background** (or set `?transparent=1` — page is already transparent)
6. Uncheck “Shutdown source when not visible” if you want it to keep polling off-screen
7. Tip: append `?compact=1` for a denser layout, or press **D** while focused to toggle compact.

---

## Deploy to Render (free)

This repo is ready for [Render](https://render.com) free hosting:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check:** `/health`
- Env is defined in `render.yaml` (or set manually in dashboard)

### One-click via `render.yaml`

1. Push to GitHub.
2. Render → **New → Blueprint** → connect this repo.
3. Render reads `render.yaml` and creates the web service.
4. In Render → Environment, add:

```
ROBLOX_GROUP_ID=201198194
UGC_ASSET_IDS=137910150798027,129297459934395,121581072690400
POLL_INTERVAL_MS=7000
INVENTORY_POLL_INTERVAL_MS=30000
ROBLOX_COOKIE=<paste private .ROBLOSECURITY here — never commit it>
```

5. Deploy. The overlay is live at `https://<your-app>.onrender.com`.

> On Render free tier the service sleeps after inactivity — first load may take ~30s to wake. Polling resumes automatically.

---

## File map

```
.
├── server.js              # Express + SSE + polling (cookie stays server-only)
├── package.json           # npm install / npm start
├── render.yaml            # Render blueprint (free plan)
├── .env.example           # copy to .env locally
├── public/
│   ├── index.html         # transparent glass overlay
│   ├── style.css          # glassmorphism + OBS-friendly
│   └── script.js          # SSE client, no refresh
└── README.md
```

---

## API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | — | overlay HTML |
| `/api/state` | GET | — | JSON snapshot (no cookie) |
| `/api/events` | GET | — | SSE stream (`state`, `sale`, `inventory` events) |
| `/health` | GET | — | `{ ok, demoMode, live, uptime }` |
| `/api/demo/sale` | POST | — | always `403` (disabled) |

---

## Security

- `ROBLOX_COOKIE` is only read via `process.env` on the server and only attached to outbound `Cookie: .ROBLOSECURITY=...` headers to Roblox.
- It is **never** returned by `/api/state`, `/api/events`, or any frontend file. Grep the repo — you’ll find it in `server.js` only, server-side.
- `.env` is gitignored via Render’s env store; only `.env.example` is committed (empty placeholder).

---

## License

MIT — see [LICENSE](LICENSE).
