/**
 * Nobody's Brand Live Sales — Server
 * Transparent glass overlay + OBS Browser Source
 * Group: 201198194
 *
 * Env:
 *   ROBLOX_GROUP_ID=201198194
 *   UGC_ASSET_IDS=137910150798027,129297459934395,121581072690400
 *   POLL_INTERVAL_MS=7000
 *   INVENTORY_POLL_INTERVAL_MS=30000
 *   ROBLOX_COOKIE=private .ROBLOSECURITY (never exposed to browser)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const GROUP_ID = process.env.ROBLOX_GROUP_ID || '201198194';
const UGC_ASSET_IDS = (process.env.UGC_ASSET_IDS || '137910150798027,129297459934395,121581072690400')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = Math.max(5000, Math.min(10000, parseInt(process.env.POLL_INTERVAL_MS || '7000', 10)));
const INVENTORY_POLL_INTERVAL_MS = Math.max(15000, Math.min(30000, parseInt(process.env.INVENTORY_POLL_INTERVAL_MS || '30000', 10)));
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || '').trim();

const HAS_COOKIE = ROBLOX_COOKIE.length > 10;

// Log boot (without leaking cookie)
console.log(`[boot] Nobody's Brand Live Sales`);
console.log(`[boot] Group: ${GROUP_ID} | Assets: ${UGC_ASSET_IDS.join(', ')}`);
console.log(`[boot] poll: ${POLL_INTERVAL_MS}ms | inventory: ${INVENTORY_POLL_INTERVAL_MS}ms`);
console.log(`[boot] cookie: ${HAS_COOKIE ? 'present (private, server-only)' : 'MISSING — demo mode'}`);
if (!HAS_COOKIE) {
  console.log(`[boot] demo mode: overlay will show simulated live sales. Add ROBLOX_COOKIE in Render to go live.`);
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let sseClients = [];

let state = {
  groupId: GROUP_ID,
  groupUrl: `https://www.roblox.com/communities/${GROUP_ID}/Nobody-s-Brand#!/about`,
  assetIds: UGC_ASSET_IDS,
  demoMode: !HAS_COOKIE,
  live: false, // true when we have successfully polled Roblox at least once
  lastUpdated: new Date().toISOString(),
  lastPollAt: null,
  lastInventoryAt: null,
  lastError: null,
  pollIntervalMs: POLL_INTERVAL_MS,
  inventoryPollIntervalMs: INVENTORY_POLL_INTERVAL_MS,
  note: 'Near-live polling — Roblox has no instant webhooks. Updates every ~7s for sales, ~30s for stock.',
  latestSale: null,
  sales: [], // newest first, capped
  stats: {
    totalSold: 0,
    totalCopies: 0,
    copiesLeft: 0,
  },
  items: {}, // assetId -> { assetId, name, ... }
};

// Seed items with placeholders until first inventory poll
const DEFAULT_ITEM_NAMES = {
  '137910150798027': 'Nobody Cap — Midnight',
  '129297459934395': 'Nobody Hoodie — Shadow',
  '121581072690400': 'Nobody Shades — Stealth',
};

// Fallback quantities for demo / initial render
const DEFAULT_TOTALS = {
  '137910150798027': 250,
  '129297459934395': 500,
  '121581072690400': 150,
};

UGC_ASSET_IDS.forEach(id => {
  state.items[id] = {
    assetId: id,
    name: DEFAULT_ITEM_NAMES[id] || `Limited #${id.slice(-6)}`,
    description: '',
    price: 85,
    totalCopies: DEFAULT_TOTALS[id] || 200,
    copiesSold: 0,
    copiesRemaining: DEFAULT_TOTALS[id] || 200,
    remaining: DEFAULT_TOTALS[id] || 200,
    sales: 0,
    thumbnail: '',
    progress: 0,
    updatedAt: new Date().toISOString(),
  };
});

// Demo quantities to make progress bars meaningful immediately
if (!HAS_COOKIE) {
  state.items['137910150798027'].copiesSold = 182;
  state.items['137910150798027'].copiesRemaining = 68;
  state.items['137910150798027'].price = 95;
  state.items['129297459934395'].copiesSold = 341;
  state.items['129297459934395'].copiesRemaining = 159;
  state.items['129297459934395'].price = 75;
  state.items['121581072690400'].copiesSold = 97;
  state.items['121581072690400'].copiesRemaining = 53;
  state.items['121581072690400'].price = 125;
  Object.values(state.items).forEach(it => {
    it.progress = Math.round((it.copiesSold / it.totalCopies) * 100);
  });
  recalcStats();
}

// Seed a few demo sales so overlay never looks empty
let demoCounter = 0;
const DEMO_BUYERS = ['NoobMaster_7', 'xToxicPlayz', 'BuilderGal99', 'NobodyFan_01', 'LimitedHunterX', 'Guest_4041337', 'VoidWalker_', 'StarCreator22', 'BlockyBoi', 'UGC_Collector'];
const DEMO_ITEMS = Object.keys(DEFAULT_ITEM_NAMES);
function seedDemoSales() {
  const now = Date.now();
  const seeds = [
    { minutesAgo: 2, buyer: 'UGC_Collector', assetId: '137910150798027' },
    { minutesAgo: 7, buyer: 'VoidWalker_', assetId: '129297459934395' },
    { minutesAgo: 14, buyer: 'NobodyFan_01', assetId: '121581072690400' },
    { minutesAgo: 19, buyer: 'StarCreator22', assetId: '137910150798027' },
    { minutesAgo: 28, buyer: 'LimitedHunterX', assetId: '129297459934395' },
  ];
  seeds.forEach((s, i) => {
    const item = state.items[s.assetId];
    state.sales.push({
      id: `demo-seed-${i}-${s.assetId}`,
      assetId: s.assetId,
      itemName: item ? item.name : `Item ${s.assetId}`,
      buyerName: s.buyer,
      buyerId: null,
      price: item ? item.price : 85,
      currency: 'Robux',
      soldAt: new Date(now - s.minutesAgo * 60 * 1000).toISOString(),
      created: new Date(now - s.minutesAgo * 60 * 1000).toISOString(),
      demo: true,
    });
  });
  state.sales.sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));
  state.latestSale = state.sales[0] || null;
  state.lastUpdated = new Date().toISOString();
  recalcStats();
}
if (!HAS_COOKIE) seedDemoSales();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function recalcStats() {
  const itemsArr = Object.values(state.items);
  const totalCopies = itemsArr.reduce((s, it) => s + (it.totalCopies || 0), 0);
  const totalSold = itemsArr.reduce((s, it) => s + (it.copiesSold || 0), 0);
  const copiesLeft = itemsArr.reduce((s, it) => s + (it.copiesRemaining || 0), 0);
  state.stats = { totalCopies, totalSold, copiesLeft };
}

function toPublicState() {
  // Never include cookie, headers, or raw Roblox errors that might leak
  return {
    groupId: state.groupId,
    groupUrl: state.groupUrl,
    demoMode: state.demoMode,
    live: state.live,
    lastUpdated: state.lastUpdated,
    lastPollAt: state.lastPollAt,
    lastInventoryAt: state.lastInventoryAt,
    pollIntervalMs: state.pollIntervalMs,
    inventoryPollIntervalMs: state.inventoryPollIntervalMs,
    note: state.note,
    stats: state.stats,
    latestSale: state.latestSale,
    sales: state.sales.slice(0, 50),
    items: Object.values(state.items).map(it => ({
      assetId: it.assetId,
      name: it.name,
      price: it.price,
      totalCopies: it.totalCopies,
      copiesSold: it.copiesSold,
      copiesRemaining: it.copiesRemaining,
      remaining: it.copiesRemaining,
      progress: it.progress,
      thumbnail: it.thumbnail,
      updatedAt: it.updatedAt,
    })),
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.res.write(payload); } catch {}
  });
}

function sseHeartbeat() {
  sseClients.forEach(c => {
    try { c.res.write(`: keepalive ${Date.now()}\n\n`); } catch {}
  });
}
setInterval(sseHeartbeat, 25000);

// ---------------------------------------------------------------------------
// Roblox fetch helpers — cookie stays server-only
// ---------------------------------------------------------------------------
function robloxHeaders(extra = {}) {
  const h = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'NobodiesBrandLive/1.0 (polling; +https://www.roblox.com/communities/201198194)',
    ...extra,
  };
  if (HAS_COOKIE) {
    // .ROBLOSECURITY must never be sent to the browser — only outbound to Roblox
    h['Cookie'] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
  }
  return h;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text, headers: res.headers };
}

// Track seen transaction ids to avoid duplicates
const seenTxIds = new Set();

async function pollGroupSales() {
  state.lastPollAt = new Date().toISOString();

  if (!HAS_COOKIE) {
    // Demo tick: occasionally generate a simulated sale
    if (Math.random() < 0.28) generateDemoSale();
    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    return;
  }

  // With cookie: try Roblox group transactions
  // Docs: https://economy.roblox.com/v1/groups/{groupId}/transactions?transactionType=Sale&limit=100&cursor=
  const url = `https://economy.roblox.com/v1/groups/${GROUP_ID}/transactions?transactionType=Sale&limit=25&cursor=`;
  try {
    const { ok, status, json, text } = await fetchJson(url, { headers: robloxHeaders() });

    if (!ok) {
      // 401/403 means cookie invalid or lacks permission; 429 = rate limited
      const msg = `transactions ${status} ${(json && (json.errors?.[0]?.message || json.errorMessage)) || text?.slice(0, 180) || ''}`.trim();
      state.lastError = msg;
      console.warn(`[poll:sales] ${msg} — keeping last state, will retry`);
      // On auth failure, flip to demoMode visually but keep trying in background
      if (status === 401 || status === 403) {
        // don't permanently override demoMode, just mark live=false
        state.live = false;
      }
      broadcast('state', toPublicState());
      return;
    }

    state.live = true;
    state.lastError = null;

    const txs = json?.data || json?.transactions || [];
    if (!Array.isArray(txs) || txs.length === 0) {
      state.lastUpdated = new Date().toISOString();
      broadcast('state', toPublicState());
      return;
    }

    let newSales = 0;
    for (const tx of txs) {
      // transaction shape varies; normalize
      const txId = String(tx.id || tx.idHash || tx.transactionId || `${tx.created}-${tx.agent?.id}-${tx.details?.id}`);
      if (seenTxIds.has(txId)) continue;

      // Only track sales for our UGC assets if we can identify them
      const detailId = String(tx.details?.id || tx.details?.assetId || tx.assetId || '');
      const isRelevant = !detailId || UGC_ASSET_IDS.includes(detailId) || UGC_ASSET_IDS.some(id => String(id) === detailId);
      // If Roblox returns all group sales (including game passes, etc), we filter to our assets when possible
      // If detailId is missing, we still show it as a sale but mark asset unknown — better than dropping

      seenTxIds.add(txId);
      // Cap the set
      if (seenTxIds.size > 500) {
        const arr = [...seenTxIds];
        arr.slice(0, 250).forEach(id => seenTxIds.delete(id));
      }

      const assetId = UGC_ASSET_IDS.includes(detailId) ? detailId : (tx.assetId ? String(tx.assetId) : UGC_ASSET_IDS[0]);
      const item = state.items[assetId] || state.items[UGC_ASSET_IDS[0]];

      const sale = {
        id: txId,
        assetId,
        itemName: tx.details?.name || item?.name || `Item ${assetId}`,
        buyerName: tx.agent?.name || tx.agentName || tx.purchaser?.name || 'Unknown',
        buyerId: tx.agent?.id || tx.purchaser?.id || null,
        price: (tx.currency?.amount ?? tx.amount ?? tx.price ?? item?.price ?? 0),
        currency: tx.currency?.type || 'Robux',
        soldAt: tx.created || tx.createdAt || new Date().toISOString(),
        created: tx.created || tx.createdAt || new Date().toISOString(),
        demo: false,
      };

      // Newest first
      state.sales.unshift(sale);
      newSales++;
      // Keep sorted by date
      state.sales.sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));
      if (state.sales.length > 80) state.sales.length = 80;
    }

    if (newSales > 0) {
      state.latestSale = state.sales[0];
      console.log(`[poll:sales] +${newSales} new sale(s), latest: ${state.latestSale.itemName} by ${state.latestSale.buyerName}`);
    }

    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    if (newSales > 0) broadcast('sales', { latest: state.latestSale, count: newSales });

  } catch (err) {
    state.lastError = err.message || String(err);
    console.warn(`[poll:sales] error: ${state.lastError}`);
    broadcast('state', toPublicState());
  }
}

// ---------------------------------------------------------------------------
// Inventory polling — copy counts for each UGC asset
// ---------------------------------------------------------------------------
async function fetchAssetDetails(assetId) {
  // Try multiple endpoints in order; Roblox has several overlapping APIs
  // 1) economy v2 details (most complete for Remaining)
  // 2) legacy marketplace productinfo (Sales, Remaining, PriceInRobux)
  // 3) catalog items details (fallback)

  // Use headers without cookie for public data — but include cookie if present (more fields)
  const headers = robloxHeaders();

  // Attempt 1
  try {
    const url1 = `https://economy.roblox.com/v2/assets/${assetId}/details`;
    const r1 = await fetchJson(url1, { headers });
    if (r1.ok && r1.json) {
      const j = r1.json;
      // j may be the object directly or nested
      const d = j.AssetDetails || j;
      if (d && (d.Name || d.Remaining !== undefined || d.PriceInRobux !== undefined)) {
        return {
          name: d.Name || d.name || null,
          price: d.PriceInRobux ?? d.price ?? d.PriceInRobux ?? null,
          remaining: d.Remaining ?? d.remaining ?? d.quantityRemaining ?? null,
          sales: d.Sales ?? d.sales ?? null,
          total: (d.Sales != null && d.Remaining != null) ? (d.Sales + d.Remaining) : null,
        };
      }
    }
  } catch {}

  // Attempt 2
  try {
    const url2 = `https://api.roblox.com/marketplace/productinfo?assetId=${assetId}`;
    const r2 = await fetchJson(url2, { headers });
    if (r2.ok && r2.json) {
      const j = r2.json;
      return {
        name: j.Name || j.name || null,
        price: j.PriceInRobux ?? j.price ?? null,
        remaining: j.Remaining ?? j.remaining ?? null,
        sales: j.Sales ?? j.sales ?? null,
        total: (j.Sales != null && j.Remaining != null) ? (j.Sales + j.Remaining) : null,
      };
    }
  } catch {}

  // Attempt 3
  try {
    const url3 = `https://catalog.roblox.com/v1/catalog/items/details`;
    const r3 = await fetchJson(url3, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: [{ itemType: 'Asset', id: parseInt(assetId, 10) }] }),
    });
    if (r3.ok && r3.json && r3.json.data && r3.json.data[0]) {
      const d = r3.json.data[0];
      return {
        name: d.name || null,
        price: d.price ?? null,
        remaining: d.unitsAvailableForConsumption ?? d.remaining ?? null,
        sales: null,
        total: d.collectibleItemDetails?.totalQuantity ?? null,
      };
    }
  } catch {}

  return null;
}

async function fetchThumbnails(assetIds) {
  try {
    const ids = assetIds.join(',');
    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=420x420&format=Png&isCircular=false`;
    const r = await fetchJson(url, { headers: robloxHeaders() });
    if (r.ok && r.json && r.json.data) {
      const map = {};
      r.json.data.forEach(d => {
        if (d.targetId && d.imageUrl) map[String(d.targetId)] = d.imageUrl;
      });
      return map;
    }
  } catch {}
  return {};
}

async function pollInventory() {
  state.lastInventoryAt = new Date().toISOString();
  let changed = false;

  // Thumbnails once per session or if missing
  let thumbMap = {};
  const needThumbs = UGC_ASSET_IDS.some(id => !state.items[id]?.thumbnail);
  if (needThumbs) thumbMap = await fetchThumbnails(UGC_ASSET_IDS);

  for (const assetId of UGC_ASSET_IDS) {
    try {
      const details = await fetchAssetDetails(assetId);
      if (!details) continue;

      const item = state.items[assetId];
      if (!item) continue;

      let didUpdate = false;

      if (details.name && details.name !== item.name) {
        item.name = details.name;
        didUpdate = true;
      }
      if (details.price != null && Number.isFinite(Number(details.price))) {
        const p = Number(details.price);
        if (p !== item.price) { item.price = p; didUpdate = true; }
      }
      if (thumbMap[assetId] && !item.thumbnail) {
        item.thumbnail = thumbMap[assetId];
        didUpdate = true;
      }

      // Remaining / total logic
      let remaining = details.remaining;
      let total = details.total;
      let sales = details.sales;

      // In DEMO mode we keep simulated sold counts so bars move — only sync total/price/name/thumb from Roblox
      // Otherwise a real 0-sold response would reset the nice 68-73% demo bars to 0% every 30s
      if (state.demoMode) {
        if (total != null && Number.isFinite(Number(total))) {
          const t = Number(total);
          if (t > 0 && t !== item.totalCopies) {
            const oldProgress = item.progress || 0;
            const oldTotal = item.totalCopies;
            item.totalCopies = t;
            if (oldProgress > 0) {
              // preserve visual progress when total jumps (250 -> 2845)
              const scaled = Math.round(t * oldProgress / 100);
              // keep scaled but ensure at least a few sold so bar isn't empty
              item.copiesSold = Math.min(t - 1, Math.max(scaled, Math.floor(t * 0.35)));
              item.copiesRemaining = Math.max(0, t - item.copiesSold);
            } else if (item.copiesSold < 10) {
              // first real inventory after boot and we had 0% — seed 42-70%
              const seeded = Math.floor(t * (0.42 + Math.random() * 0.28));
              item.copiesSold = seeded;
              item.copiesRemaining = t - seeded;
            } else {
              item.copiesRemaining = Math.max(0, t - item.copiesSold);
            }
            item.progress = Math.round((item.copiesSold / t) * 100);
            didUpdate = true;
          }
        } else if (remaining != null && Number.isFinite(Number(remaining)) && total == null) {
          // fallback if only remaining known — keep sold, update remaining if needed
        }
      } else {
        // LIVE mode — trust Roblox numbers exactly
        if (remaining != null && Number.isFinite(Number(remaining))) {
          remaining = Number(remaining);
          if (sales != null && Number.isFinite(Number(sales))) {
            const s = Number(sales);
            const t = s + remaining;
            if (t > 0 && t !== item.totalCopies) { item.totalCopies = t; didUpdate = true; }
            if (s !== item.copiesSold) { item.copiesSold = s; didUpdate = true; }
            if (remaining !== item.copiesRemaining) { item.copiesRemaining = remaining; didUpdate = true; }
          } else {
            if (remaining !== item.copiesRemaining) { item.copiesRemaining = remaining; didUpdate = true; }
            const inferredSold = Math.max(0, item.totalCopies - remaining);
            if (inferredSold !== item.copiesSold) {
              item.copiesSold = inferredSold;
              didUpdate = true;
            }
          }
        } else if (total != null && Number.isFinite(Number(total))) {
          const t = Number(total);
          if (t !== item.totalCopies) { item.totalCopies = t; didUpdate = true; }
        }
      }

      if (didUpdate) {
        item.progress = item.totalCopies > 0 ? Math.round((item.copiesSold / item.totalCopies) * 100) : 0;
        item.updatedAt = new Date().toISOString();
        changed = true;
      }
    } catch (e) {
      // per-asset failure shouldn't break others
      console.warn(`[poll:inventory] ${assetId} failed: ${e.message}`);
    }
    // Small delay between assets to avoid hammering Roblox
    await new Promise(r => setTimeout(r, 350));
  }

  if (changed) {
    recalcStats();
    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    broadcast('inventory', { items: Object.values(state.items) });
    console.log(`[poll:inventory] updated — ${Object.values(state.items).map(i => `${i.name}: ${i.copiesSold}/${i.totalCopies}`).join(' | ')}`);
  } else {
    // Still broadcast keepalive state so frontend knows we're alive
    state.lastUpdated = new Date().toISOString();
    // Don't spam SSE if nothing changed; but update lastInventoryAt
  }

  // If inventory fetch consistently fails and we're in cookie-less mode, nudge demo progress occasionally
  if (!HAS_COOKIE && Math.random() < 0.35) {
    const ids = [...UGC_ASSET_IDS];
    const pick = ids[Math.floor(Math.random() * ids.length)];
    const it = state.items[pick];
    if (it && it.copiesRemaining > 0 && Math.random() < 0.5) {
      // Simulate one copy sold in background to make progress bars move
      it.copiesSold = Math.min(it.totalCopies, it.copiesSold + 1);
      it.copiesRemaining = Math.max(0, it.totalCopies - it.copiesSold);
      it.progress = Math.round((it.copiesSold / it.totalCopies) * 100);
      it.updatedAt = new Date().toISOString();
      recalcStats();
      state.lastUpdated = new Date().toISOString();
      broadcast('state', toPublicState());
    }
  }
}

function generateDemoSale() {
  demoCounter++;
  const assetId = DEMO_ITEMS[Math.floor(Math.random() * DEMO_ITEMS.length)];
  const item = state.items[assetId];
  const buyer = DEMO_BUYERS[Math.floor(Math.random() * DEMO_BUYERS.length)] + (Math.random() < 0.3 ? Math.floor(Math.random() * 900 + 100) : '');
  const sale = {
    id: `demo-${Date.now()}-${demoCounter}`,
    assetId,
    itemName: item ? item.name : `Item ${assetId}`,
    buyerName: buyer,
    buyerId: null,
    price: item ? item.price : 85,
    currency: 'Robux',
    soldAt: new Date().toISOString(),
    created: new Date().toISOString(),
    demo: true,
  };
  state.sales.unshift(sale);
  if (state.sales.length > 80) state.sales.length = 80;
  state.latestSale = state.sales[0];
  state.lastUpdated = new Date().toISOString();

  // Also bump that item's sold count (demo)
  if (item && item.copiesRemaining > 0) {
    item.copiesSold = Math.min(item.totalCopies, item.copiesSold + 1);
    item.copiesRemaining = Math.max(0, item.totalCopies - item.copiesSold);
    item.progress = Math.round((item.copiesSold / item.totalCopies) * 100);
    item.updatedAt = new Date().toISOString();
    recalcStats();
  }

  console.log(`[demo] ${sale.itemName} sold to ${sale.buyerName} for ${sale.price} Robux`);
  broadcast('sale', sale);
  broadcast('state', toPublicState());
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Security: never log or expose cookie; add headers useful for OBS
app.use((req, res, next) => {
  // Allow embedding in OBS (no X-Frame-Options denial)
  res.removeHeader('X-Frame-Options');
  next();
});

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, demoMode: state.demoMode, live: state.live, uptime: process.uptime(), lastUpdated: state.lastUpdated });
});

// Public state (no cookie)
app.get('/api/state', (req, res) => {
  res.json(toPublicState());
});

// SSE — live browser updates without refresh
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  // Send retry hint
  res.write('retry: 3000\n\n');
  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify(toPublicState())}\n\n`);
  // Keepalive comment
  res.write(`: connected ${Date.now()}\n\n`);

  const clientId = Date.now() + Math.random().toString(16).slice(2);
  const client = { id: clientId, res };
  sseClients.push(client);
  console.log(`[sse] client connected ${clientId} — ${sseClients.length} total`);

  // Heartbeat for this client is handled globally

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
    console.log(`[sse] client disconnected ${clientId} — ${sseClients.length} total`);
    try { res.end(); } catch {}
  });
});

// Simple demo trigger (not required, but handy for testing overlay without waiting)
// Only works in demo mode to avoid fake data in live mode
app.post('/api/demo/sale', (req, res) => {
  if (!state.demoMode) return res.status(403).json({ error: 'disabled in live mode' });
  generateDemoSale();
  res.json({ ok: true, latest: state.latestSale });
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public'), {
  // OBS browser source may cache aggressively — allow but not forever
  maxAge: '5m',
  etag: true,
}));

// Fallback to index for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start polling loops
// ---------------------------------------------------------------------------
function startLoops() {
  // Initial polls staggered
  setTimeout(pollGroupSales, 1500);
  setTimeout(pollInventory, 2500);

  setInterval(pollGroupSales, POLL_INTERVAL_MS);
  setInterval(pollInventory, INVENTORY_POLL_INTERVAL_MS);

  // In demo mode, ensure feed never looks dead: guarantee a sale every 18–35s
  if (!HAS_COOKIE) {
    setInterval(() => {
      if (Math.random() < 0.6) generateDemoSale();
    }, 18000);
  }
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[http] listening on 0.0.0.0:${PORT}`);
  console.log(`[http] overlay: http://localhost:${PORT}/`);
  console.log(`[http] sse: http://localhost:${PORT}/api/events`);
  console.log(`[http] state: http://localhost:${PORT}/api/state`);
  startLoops();
});
