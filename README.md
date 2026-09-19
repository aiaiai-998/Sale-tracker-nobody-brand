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
- **Limited stock** cards — one per *still available* UGC asset, each with item name, copies sold, total copies, copies remaining, price, and animated progress bar
- **Sold out items** section — anything that hits 0 copies left (like the sold-out MM2 Emote) drops out of Limited stock and slides down into its own section below, badged **SOLD OUT** — copies sold, revenue and feed history still count it
- Near-live polling (Roblox has no instant webhooks) — **sales + stock polled every 5–10s, so the feed moves at the same time as the Robux total**
- Real-time browser updates via **Server-Sent Events (SSE)** — no refresh needed
- Optional **Shopify-style cha-ching sale sound** with a remembered **On / Off** switch and **Test sound** button
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

### Sold out items

An item that sells out is **not** deleted or hidden — it moves down:

- As soon as an item reports **0 copies left** (`copiesRemaining` / `remaining` hits 0), the next update takes its card out of the **Limited stock** grid and renders it in the **Sold out items** section underneath, with a **SOLD OUT** badge, a greyed-out thumbnail and a full, grey progress bar.
- The section header shows the summary (`1 item • 3,000 copies sold`) and the section is **hidden entirely** while every tracked item still has stock — no empty panel on your OBS scene.
- **Totals don't change:** sold-out copies still count in *All copies sold so far* / *Total copies*, in the per-item Robux leaderboard, in the sales feed, and in the *Latest item sold* hero. Only the placement moves.
- If a creator restocks or supply is raised, the item goes straight back up into **Limited stock** on the next poll.
- Copies left that the server has **not reported yet** (boot state, a failed poll) are never treated as 0, so a live item can't be dumped into the sold-out section by a missed poll.
- Split logic lives in `public/item-sections.mjs` (`splitItemsByStock`, `isSoldOut`, `soldOutHint`, `itemCardHTML`) — dependency-free and unit-tested, so the "where does this card go" rule is testable without a browser.

### Removed / deleted items

The **Blue Valk** (`73175553972885`) was deleted on Roblox — while it was still listed the overlay could not read a name for it, so it showed up as **Limited #972885**. It is no longer tracked:

- `RETIRED_ASSET_IDS` in `server.js` strips it out of `UGC_ASSET_IDS` at boot, so a stale env value on Render (or an old local `.env`) cannot bring it back.
- Its 3,000 copies are gone from the header: **Total copies 12,000 → 9,000** (and *Copies left* drops by the same amount).
- Its Robux is excluded from the revenue counter and its sales from the feed. A group transaction for a retired or untracked asset is now **skipped** instead of being credited to the first tracked item.
- With three items tracked, the 4th leaderboard slot hides itself automatically.

To retire another deleted item later: add its asset id to `RETIRED_ASSET_IDS`, and remove it from `KNOWN_TOTALS` / `KNOWN_COLLECTIBLE_IDS` and `UGC_ASSET_IDS`.

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
| `UGC_ASSET_IDS` | no | `137910150798027,129297459934395,121581072690400` | comma-separated asset IDs — ids in `RETIRED_ASSET_IDS` are dropped (see [Removed / deleted items](#removed--deleted-items)) |
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

## Sale sound notifications

In the **Live sales feed**, turn **Sale sound** on to hear a short, cash-register-style **cha-ching** for each newly detected sale. Turning it on plays a preview; **Test sound** lets you hear it again without adding a fake sale or changing any totals.

- Sound starts **off** and your On / Off preference is remembered in this browser (when local storage is available).
- Turning it **off** immediately silences the current chime and clears queued sounds.
- Existing sales on initial load are silent. Repeated updates, reconnects with the same sales, and buyer-name upgrades do not play duplicate alerts. New copies in a batch play one after another, including the feed's **×N** stock entries.
- Browsers may require a click to allow audio after a refresh, even when the saved setting is On. Click **Test sound** (or interact with the page) if the status asks you to activate audio. Sales received while muted or audio-blocked are not replayed later.
- Keep the tracker open for notifications; they follow the existing near-live sale detection, not an instant Roblox webhook. The chime is synthesized locally with Web Audio, so there is no third-party sound download.

**OBS:** Right-click the Browser Source → **Interact**, then enable **Sale sound**. Browser and OBS sound preferences are separate. If needed, enable **Control audio via OBS** in the source properties and make sure the source is unmuted in the Audio Mixer. Use **Test sound** to verify your output/monitoring setup.

### Tests

```bash
npm test
```

The dependency-free tests cover new-sale detection, duplicate suppression, bulk quantities, saved preferences, muting, audio queueing, autoplay restrictions, audio/storage failures, **retired items** (a deleted asset is never tracked, counted in the copy total, or credited with Robux — even when an old `UGC_ASSET_IDS` value still lists it), and **sold-out items** (a 0-copies-left item leaves the Limited stock grid for the Sold out items section, unknown stock never counts as sold out, and the sold-out card markup is badged and escaped).

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
│   ├── index.html         # transparent glass overlay (Limited stock + Sold out items)
│   ├── style.css          # glassmorphism + OBS-friendly
│   ├── script.js          # SSE client, no refresh + sound controls
│   ├── sale-sound.mjs     # local cha-ching synthesis + deduplicated notifications
│   └── item-sections.mjs  # stock split: Limited stock vs Sold out items (+ card HTML)
├── test/
│   ├── sale-sound.test.mjs   # notification and audio behavior tests
│   ├── retired-assets.test.mjs # deleted items stay off the overlay + out of the totals
│   └── sold-out-items.test.mjs # sold-out items move to their own section, totals intact
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
