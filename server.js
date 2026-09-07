/**
 * Nobody's Brand Live Sales — Server
 * Transparent glass overlay + OBS Browser Source
 * Group: 201198194
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
// Stock counts ARE the sales feed now (a drop in "Remaining" = a real purchase),
// so inventory is polled at the fast sales interval, not the slow 30s one.
const STOCK_POLL_MS = Math.min(INVENTORY_POLL_INTERVAL_MS, POLL_INTERVAL_MS);
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || '').trim();
const HAS_COOKIE = ROBLOX_COOKIE.length > 10;

// Collectible item IDs (NOT the same as asset IDs!). The marketplace instances
// endpoints need these UUIDs — passing an asset id there always fails.
// Seeds are from economy/v2/assets/{id}/details; refreshed automatically while running.
const KNOWN_COLLECTIBLE_IDS = {
  '137910150798027': '7841aa19-9999-4081-8825-6da41b4f6b86', // FIery Horns
  '129297459934395': '2378fc2a-8eee-4574-aec8-8f254a7f838e', // [⏳LIMITED] Fake Dead MM2 Emote
  '121581072690400': 'eada40b1-0dcc-4cfc-96b4-40ad2afb00d1', // Clockwork Shades
};
const collectibleItemIds = { ...KNOWN_COLLECTIBLE_IDS };

console.log(`[boot] Nobody's Brand Live Sales`);
console.log(`[boot] Group: ${GROUP_ID} | Assets: ${UGC_ASSET_IDS.join(', ')}`);
console.log(`[boot] poll: ${POLL_INTERVAL_MS}ms | stock+sales: ${STOCK_POLL_MS}ms`);
console.log(`[boot] cookie: ${HAS_COOKIE ? 'present (private, server-only)' : 'MISSING — accurate public mode (no fake sales)'}`);

let sseClients = [];

let state = {
  groupId: GROUP_ID,
  groupUrl: `https://www.roblox.com/communities/${GROUP_ID}/Nobody-s-Brand#!/about`,
  assetIds: UGC_ASSET_IDS,
  demoMode: !HAS_COOKIE,
  live: false,
  lastUpdated: new Date().toISOString(),
  lastPollAt: null,
  lastInventoryAt: null,
  lastError: null,
  pollIntervalMs: POLL_INTERVAL_MS,
  inventoryPollIntervalMs: STOCK_POLL_MS,
  note: HAS_COOKIE
    ? 'Live polling with cookie — every sale shows buyer + time'
    : 'Live — stock is 100% real and every purchase hits the feed within seconds. Buyers show as "Someone" when names are unavailable without a cookie.',
  latestSale: null,
  sales: [],
  stats: { totalSold: 0, totalCopies: 0, copiesLeft: 0 },
  items: {},
};

UGC_ASSET_IDS.forEach(id => {
  state.items[id] = {
    assetId: id,
    name: `Limited #${id.slice(-6)}`,
    description: '',
    price: 85,
    totalCopies: 200,
    copiesSold: 0,
    copiesRemaining: 200,
    remaining: 200,
    sales: 0,
    thumbnail: '',
    progress: 0,
    feedSold: 0,      // copies already represented by feed entries (dedupe ledger)
    stockBaseline: false, // set on first successful read — no fake history at boot
    updatedAt: new Date().toISOString(),
  };
});
// No fake seeded sales — accurate mode starts empty until Roblox says otherwise
// No demo sold numbers — will be overwritten by first real inventory poll in ~2.5s

function recalcStats() {
  const itemsArr = Object.values(state.items);
  const totalCopies = itemsArr.reduce((s, it) => s + (it.totalCopies || 0), 0);
  const totalSold = itemsArr.reduce((s, it) => s + (it.copiesSold || 0), 0);
  const copiesLeft = itemsArr.reduce((s, it) => s + (it.copiesRemaining || 0), 0);
  const gross = itemsArr.reduce((s, it) => s + ((it.copiesSold || 0) * (Number(it.price) || 0)), 0);
  // User gets 30% per sale: 15 for emote (50*0.3) and 28 for 95 horn/shades (floor)
  const net = itemsArr.reduce((s, it) => s + ((it.copiesSold || 0) * Math.floor((Number(it.price)||0)*0.3)), 0);
  state.stats = { totalCopies, totalSold, copiesLeft, gross, net, revenue: net, revenueGross: gross, feePercent: 70, netPercent: 30 };
}

function toPublicState() {
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
  sseClients.forEach(c => { try { c.res.write(payload); } catch {} });
}
function sseHeartbeat() { sseClients.forEach(c => { try { c.res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }); }
setInterval(sseHeartbeat, 25000);

function robloxHeaders(extra = {}) {
  const skipCsrf = extra.skipCsrf === true;
  const rest = { ...extra };
  delete rest.skipCsrf;
  const h = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'NobodiesBrandLive/1.0 (polling; +https://www.roblox.com/communities/201198194)',
    ...rest,
  };
  if (HAS_COOKIE) h['Cookie'] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
  // Never send X-CSRF-TOKEN to auth endpoints — a stale token on /v2/logout would sign the account out.
  if (csrfToken && !skipCsrf) h['X-CSRF-TOKEN'] = csrfToken;
  return h;
}
let csrfToken = null;
let csrfFetchedAt = 0;
async function ensureCsrfToken() {
  if (!HAS_COOKIE) return null;
  if (csrfToken && Date.now() - csrfFetchedAt < 300000) return csrfToken;
  try {
    // POST /v2/login is safe — it can never log anyone out. Do NOT use /v2/logout:
    // after 5 minutes the cached token is re-sent and that actually signs the account out.
    // Never send X-CSRF-TOKEN to auth endpoints.
    const r = await fetch('https://auth.roblox.com/v2/login', { method: 'POST', headers: robloxHeaders({ skipCsrf: true }) });
    const t = r.headers.get('x-csrf-token') || r.headers.get('X-CSRF-TOKEN');
    if (t) { csrfToken = t; csrfFetchedAt = Date.now(); console.log(`[csrf] got token ${t.slice(0,8)}...`); return t; }
  } catch (e) { console.warn(`[csrf] login fetch failed: ${e.message}`); }
  try {
    const r2 = await fetch('https://www.roblox.com/home', { headers: robloxHeaders({ skipCsrf: true }) });
    const t2 = r2.headers.get('x-csrf-token') || r2.headers.get('X-CSRF-TOKEN');
    if (t2) { csrfToken = t2; csrfFetchedAt = Date.now(); return t2; }
  } catch {}
  return null;
}
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}
const seenTxIds = new Set();

// ---------------------------------------------------------------------------
// Sales list helpers — single source of truth for feed + latest sale.
// Sales can be detected by three sources (group transactions with cookie,
// public item owners/instances, and the stock delta). These helpers make sure
// they merge into ONE feed entry per real purchase instead of duplicating.
// ---------------------------------------------------------------------------
const pendingAttribution = new Map(); // assetId -> [saleId, ...] anonymous sales waiting for a buyer name

function addSale(sale) {
  if (!sale || state.sales.some(s => s.id === sale.id)) return false;
  state.sales.unshift(sale);
  if (state.sales.length > 80) state.sales.length = 80;
  registerFeedSale(sale.assetId, sale.qty || 1);
  return true;
}

// Ledger: how many copies of an item are already represented by feed entries.
// The stock poll only emits entries for purchases NOT yet in the feed, so the
// three detection sources (transactions / owners / stock delta) never duplicate.
function registerFeedSale(assetId, n) {
  const it = state.items[assetId];
  if (it) it.feedSold = (it.feedSold || 0) + n;
}

function sortSales() {
  state.sales.sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));
  if (state.sales.length) state.latestSale = state.sales[0];
}

// Do we already have a recent sale for this asset + buyer? (cross-source dedupe)
function hasRecentSale(assetId, buyerId, windowMs = 300000) {
  if (!buyerId) return false;
  const cutoff = Date.now() - windowMs;
  return state.sales.some(s =>
    s.assetId === assetId && s.buyerId &&
    String(s.buyerId) === String(buyerId) &&
    new Date(s.soldAt).getTime() > cutoff
  );
}

// Attach a real buyer name to a recent anonymous (stock-delta) sale instead of
// creating a duplicate entry. Returns true if a pending sale was upgraded.
function attributeSale(assetId, buyerName, buyerId, soldAt) {
  const q = pendingAttribution.get(assetId);
  if (!q || !q.length) return false;
  while (q.length) {
    const sid = q.shift();
    const s = state.sales.find(x => x.id === sid);
    if (!s) continue; // already scrolled out of the feed — try the next one
    if (buyerName) s.buyerName = buyerName;
    s.buyerId = buyerId ?? s.buyerId ?? null;
    if (soldAt) { s.soldAt = soldAt; s.created = soldAt; }
    s.via = 'stock+named';
    return true;
  }
  return false;
}

// Emit anonymous sales for a stock drop (one feed entry per copy, capped).
// Names are attached later by attributeSale when a name source is available.
function emitStockSales(item, count) {
  const now = Date.now();
  let emitted = 0;
  const n = Math.min(count, 10);
  for (let i = 0; i < n; i++) {
    const soldAt = new Date(now - (n - 1 - i) * 1000).toISOString();
    const sale = {
      id: `stock-${item.assetId}-${now}-${i}`,
      assetId: item.assetId,
      itemName: item.name,
      buyerName: 'Someone',
      buyerId: null,
      price: item.price ?? 0,
      currency: 'Robux',
      soldAt,
      created: soldAt,
      qty: 1,
      demo: false,
      via: 'stock',
    };
    if (addSale(sale)) {
      const q = pendingAttribution.get(item.assetId) || [];
      q.push(sale.id);
      if (q.length > 30) q.splice(0, q.length - 30);
      pendingAttribution.set(item.assetId, q);
      emitted++;
    }
  }
  if (count > n) {
    // big spike — aggregate the rest into one ×N entry so the feed still shows it
    const soldAt = new Date(now).toISOString();
    if (addSale({
      id: `stock-${item.assetId}-${now}-bulk`,
      assetId: item.assetId,
      itemName: item.name,
      buyerName: 'Someone',
      buyerId: null,
      price: item.price ?? 0,
      currency: 'Robux',
      soldAt,
      created: soldAt,
      qty: count - n,
      demo: false,
      via: 'stock',
    })) emitted++;
  }
  return emitted;
}

async function pollGroupSales() {
  state.lastPollAt = new Date().toISOString();
  if (!HAS_COOKIE) {
    // Public mode: do NOT fake sales. Just keep connection alive.
    // Real sales (with buyer names) require cookie — without it we rely on inventory for anonymous sales.
    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    return;
  }
  await ensureCsrfToken();
  const urlsToTry = [
    `https://economy.roblox.com/v1/groups/${GROUP_ID}/transactions?transactionType=Sale&limit=25&cursor=`,
  ];
  let lastRes = null;
  let lastUrl = urlsToTry[0];
  try {
    let ok = false, status = 0, json = null, text = '';
    for (const u of urlsToTry) {
      lastUrl = u;
      const r = await fetchJson(u, { headers: robloxHeaders() });
      lastRes = r;
      ok = r.ok; status = r.status; json = r.json; text = r.text;
      if (ok) break;
      if (status === 404) continue;
      if (status === 401 || status === 403) break;
    }
    // use last attempt's result
    ok = lastRes?.ok; status = lastRes?.status; json = lastRes?.json; text = lastRes?.text;
    if (!ok) {
      if (status === 404) {
        if (!state.last404 || Date.now() - state.last404 > 300000) {
          console.warn(`[poll:sales] transactions 404 on ${lastUrl} — Communities API not found, using inventory-only (stock 100% real, buyer names hidden without new API)`);
          state.last404 = Date.now();
        }
        state.lastError = `transactions 404 — inventory-only mode`;
        broadcast('state', toPublicState());
        return;
      }
      const msg = `transactions ${status} ${(json && (json.errors?.[0]?.message || json.errorMessage)) || text?.slice(0,180) || ''}`.trim();
      state.lastError = msg;
      console.warn(`[poll:sales] ${msg} (${lastUrl})`);
      if (status === 401 || status === 403) state.live = false;
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
      const txId = String(tx.id || tx.idHash || tx.transactionId || `${tx.created}-${tx.agent?.id}-${tx.details?.id}`);
      if (seenTxIds.has(txId)) continue;
      const detailId = String(tx.details?.id || tx.details?.assetId || tx.assetId || '');
      seenTxIds.add(txId);
      if (seenTxIds.size > 500) { const arr=[...seenTxIds]; arr.slice(0,250).forEach(id=>seenTxIds.delete(id)); }
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
        qty: 1,
        demo: false,
      };
      // If the stock poll already logged this purchase as "Someone", just attach
      // the buyer name to it. Only add a new entry if nothing has it yet.
      const upgraded = attributeSale(assetId, sale.buyerName, sale.buyerId, sale.soldAt);
      const dup = hasRecentSale(assetId, sale.buyerId);
      if (upgraded) newSales++;
      else if (!dup && addSale(sale)) newSales++;
    }
    if (newSales>0) { sortSales(); console.log(`[poll:sales] +${newSales} new (latest: ${state.latestSale?.buyerName} — ${state.latestSale?.itemName})`); }
    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    if (newSales>0) broadcast('sales', { latest: state.latestSale, count:newSales });
  } catch (err) {
    state.lastError = err.message || String(err);
    console.warn(`[poll:sales] error: ${state.lastError}`);
    broadcast('state', toPublicState());
  }
}

async function fetchAssetDetails(assetId) {
  const headers = robloxHeaders();
  // 1) economy v2 asset details — best source: Remaining, TotalQuantity, CollectibleItemId
  try {
    const url1 = `https://economy.roblox.com/v2/assets/${assetId}/details`;
    const r1 = await fetchJson(url1, { headers });
    if (r1.ok && r1.json) {
      const j = r1.json; const d = j.AssetDetails || j;
      if (d && (d.Name || d.Remaining !== undefined || d.PriceInRobux !== undefined)) {
        return {
          name: d.Name || d.name || null,
          price: d.PriceInRobux ?? d.price ?? null,
          remaining: d.Remaining ?? d.remaining ?? null,
          sales: d.Sales ?? d.sales ?? null,
          total: d.CollectiblesItemDetails?.TotalQuantity ?? ((d.Sales != null && d.Remaining != null) ? d.Sales + d.Remaining : null),
          collectibleItemId: d.CollectibleItemId || null,
        };
      }
    }
  } catch {}
  // 2) catalog per-item details — public, no cookie needed
  try {
    const url2 = `https://catalog.roblox.com/v1/catalog/items/${assetId}/details?itemType=Asset`;
    const r2 = await fetchJson(url2, { headers });
    if (r2.ok && r2.json) {
      const j = r2.json;
      if (j.name || j.unitsAvailableForConsumption !== undefined) {
        return {
          name: j.Name || j.name || null,
          price: j.PriceInRobux ?? j.price ?? null,
          remaining: j.Remaining ?? j.unitsAvailableForConsumption ?? null,
          sales: null,
          total: j.totalQuantity ?? null,
          collectibleItemId: j.collectibleItemId || null,
        };
      }
    }
  } catch {}
  // 3) legacy productinfo (kept as extra fallback)
  try {
    const url3 = `https://api.roblox.com/marketplace/productinfo?assetId=${assetId}`;
    const r3 = await fetchJson(url3, { headers });
    if (r3.ok && r3.json) {
      const j = r3.json;
      return {
        name: j.Name || j.name || null,
        price: j.PriceInRobux ?? j.price ?? null,
        remaining: j.Remaining ?? j.remaining ?? null,
        sales: j.Sales ?? j.sales ?? null,
        total: (j.Sales != null && j.Remaining != null) ? (j.Sales + j.Remaining) : null,
        collectibleItemId: null,
      };
    }
  } catch {}
  // 4) catalog batch details
  try {
    const url4 = `https://catalog.roblox.com/v1/catalog/items/details`;
    const r4 = await fetchJson(url4, { method:'POST', headers, body: JSON.stringify({ items:[{ itemType:'Asset', id:parseInt(assetId,10)}]})});
    if (r4.ok && r4.json && r4.json.data && r4.json.data[0]) {
      const d = r4.json.data[0];
      return { name:d.name||null, price:d.price??null, remaining:d.unitsAvailableForConsumption??d.remaining??null, sales:null, total:d.collectibleItemDetails?.totalQuantity??null, collectibleItemId: d.collectibleItemId || null };
    }
  } catch {}
  return null;
}
async function fetchThumbnails(assetIds) {
  try {
    const ids = assetIds.join(','); const url=`https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=420x420&format=Png&isCircular=false`;
    const r = await fetchJson(url, { headers: robloxHeaders() });
    if (r.ok && r.json && r.json.data) { const map={}; r.json.data.forEach(d=>{ if(d.targetId && d.imageUrl) map[String(d.targetId)]=d.imageUrl; }); return map; }
  } catch {} return {};
}
// ---------------------------------------------------------------------------
// Buyer-name enrichment (best effort, works WITHOUT cookie).
// Tries public owner/instance endpoints with the CORRECT ids: the plain asset
// id for inventory.roblox.com and the collectibleItemId UUID for apis.roblox.com
// (the old code sent the asset id there, which always failed).
// If every endpoint is unavailable, the feed still works — sales come from the
// stock delta in pollInventory, they just show as "Someone".
// ---------------------------------------------------------------------------
const seenOwners = new Map(); // assetId -> Set of "uid-serial" keys
const highestSerial = new Map(); // assetId -> highest serialNumber seen (resales have lower serials)
const ownersPoll = { failures: 0, skipUntil: 0 };
const USER_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const userNameCache = new Map(); // uid -> { name, expiresAt }

async function lookupUsername(uid) {
  const key = String(uid);
  const cached = userNameCache.get(key);
  if (cached && cached.expiresAt > Date.now() && cached.name) return cached.name;
  try {
    const r = await fetchJson(`https://users.roblox.com/v1/users/${encodeURIComponent(key)}`, { headers: robloxHeaders() });
    if (r.ok && r.json) {
      const name = r.json.name || r.json.displayName || null;
      if (name) {
        userNameCache.set(key, { name, expiresAt: Date.now() + USER_NAME_TTL_MS });
        return name;
      }
    }
  } catch {}
  return null;
}

function parseSerial(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchRecentOwners(assetId) {
  const cid = collectibleItemIds[assetId];
  // v2 owners endpoints (cookie via robloxHeaders) first — they actually return usernames.
  const tries = [];
  if (cid) tries.push(`https://inventory.roblox.com/v2/collectible-items/${cid}/owners?limit=10&sortOrder=Desc`);
  tries.push(`https://inventory.roblox.com/v2/assets/${assetId}/owners?limit=10&sortOrder=Desc`);
  tries.push(`https://inventory.roblox.com/v1/assets/${assetId}/owners?sortOrder=Desc&limit=10`);
  if (cid) {
    tries.push(`https://apis.roblox.com/marketplace-items/v1/items/item/${cid}/instances?limit=10&cursor=`);
    tries.push(`https://apis.roblox.com/collectibles-item/v1/collectible-items/${cid}/instances?limit=10&cursor=`);
  }
  for (const url of tries) {
    try {
      const r = await fetchJson(url, { headers: robloxHeaders() });
      if (!r.ok || !r.json) continue;
      const data = r.json.data || r.json.instances || r.json.owners || [];
      if (!Array.isArray(data) || !data.length) continue;
      const list = [];
      for (const e of data) {
        const owner = e.owner || e.currentOwner || {};
        const uid = String(owner.id || owner.userId || e.userId || e.ownerId || '');
        if (!uid) continue;
        let name = owner.name || owner.username || owner.displayName || e.username || e.name || null;
        if (!name) name = await lookupUsername(uid);
        if (!name) name = `User ${uid}`;
        const serialRaw = e.serialNumber ?? e.instanceId ?? e.id ?? '';
        const pricePaid = e.pricePaid ?? e.price ?? e.recentAveragePrice ?? e.sale?.price ?? owner.pricePaid ?? null;
        list.push({
          uid,
          name,
          at: e.updated || e.created || e.purchasedAt || null,
          serial: String(serialRaw),
          serialNumber: parseSerial(e.serialNumber ?? serialRaw),
          pricePaid: pricePaid == null || pricePaid === '' ? null : Number(pricePaid),
        });
      }
      if (list.length) return list;
    } catch {}
  }
  return null;
}

async function pollRecentBuyers() {
  if (Date.now() < ownersPoll.skipUntil) return;
  let anyOk = false;
  for (const assetId of UGC_ASSET_IDS) {
    try {
      const owners = await fetchRecentOwners(assetId);
      if (!owners) continue;
      anyOk = true;
      const item = state.items[assetId];
      if (!seenOwners.has(assetId)) {
        // first successful poll = baseline; don't flood the feed with old history
        seenOwners.set(assetId, new Set(owners.map(o => `${o.uid}-${o.serial}`)));
        const maxSerial = owners.reduce((m, o) => {
          const n = o.serialNumber;
          return n != null ? Math.max(m, n) : m;
        }, 0);
        highestSerial.set(assetId, maxSerial);
        console.log(`[owners] baseline ${assetId}: ${owners.length} owners (max serial ${maxSerial})`);
        continue;
      }
      const seen = seenOwners.get(assetId);
      const newOnes = [];
      for (const o of owners) {
        const key = `${o.uid}-${o.serial}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const maxSeen = highestSerial.get(assetId) || 0;
        // Resales, not new catalog sales: older serial than the highest already seen,
        // or paid more than the item's listed price.
        if (o.serialNumber != null && maxSeen > 0 && o.serialNumber < maxSeen) continue;
        if (o.pricePaid != null && Number.isFinite(o.pricePaid) && item?.price != null && o.pricePaid > Number(item.price)) continue;
        if (o.serialNumber != null && o.serialNumber > maxSeen) highestSerial.set(assetId, o.serialNumber);
        newOnes.push(o);
      }
      if (seen.size > 400) { const arr = [...seen]; arr.slice(0, 200).forEach(k => seen.delete(k)); }
      if (!newOnes.length) continue;
      newOnes.reverse(); // oldest first so the newest ends up as latestSale
      let handled = 0;
      for (const o of newOnes) {
        const soldAt = o.at || new Date().toISOString();
        // if the stock poll already logged this purchase anonymously, attach the name
        if (attributeSale(assetId, o.name, o.uid, soldAt)) { handled++; continue; }
        // already logged via transactions/another source? skip
        if (hasRecentSale(assetId, o.uid)) { handled++; continue; }
        if (addSale({
          id: `owner-${assetId}-${o.uid}-${o.serial}`,
          assetId,
          itemName: item?.name || `Item ${assetId}`,
          buyerName: o.name,
          buyerId: o.uid,
          price: item?.price ?? 0,
          currency: 'Robux',
          soldAt,
          created: soldAt,
          qty: 1,
          demo: false,
          via: 'owners',
        })) handled++;
      }
      if (handled) {
        sortSales();
        state.lastUpdated = new Date().toISOString();
        console.log(`[owners] ${assetId}: ${handled} new owner(s) — latest: ${state.latestSale?.buyerName}`);
        broadcast('state', toPublicState());
        broadcast('sale', state.latestSale);
      }
    } catch (e) { console.warn(`[owners] ${assetId} failed: ${e.message}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  if (anyOk) {
    ownersPoll.failures = 0;
  } else {
    ownersPoll.failures++;
    if (ownersPoll.failures >= 10) {
      ownersPoll.skipUntil = Date.now() + 5 * 60 * 1000; // all endpoints dead — retry in 5 min
      ownersPoll.failures = 0;
      console.warn('[owners] all buyer-name endpoints unavailable — feed still updates via stock (buyers show as "Someone")');
    }
  }
}

let inventorySkipUntil = 0;
let inventoryFailStreak = 0;

async function pollInventory() {
  if (Date.now() < inventorySkipUntil) return;
  state.lastInventoryAt = new Date().toISOString();
  let changed = false;
  let anyOk = false;
  let newStockSales = 0;
  let thumbMap = {};
  const needThumbs = UGC_ASSET_IDS.some(id => !state.items[id]?.thumbnail);
  if (needThumbs) thumbMap = await fetchThumbnails(UGC_ASSET_IDS);
  for (const assetId of UGC_ASSET_IDS) {
    try {
      const details = await fetchAssetDetails(assetId);
      if (!details) continue;
      anyOk = true;
      const item = state.items[assetId];
      if (!item) continue;
      let didUpdate = false;
      if (details.collectibleItemId && collectibleItemIds[assetId] !== details.collectibleItemId) {
        collectibleItemIds[assetId] = details.collectibleItemId; // keep instances polling id fresh
      }
      if (details.name && details.name !== item.name) { item.name = details.name; didUpdate = true; }
      if (details.price != null && Number.isFinite(Number(details.price))) { const p = Number(details.price); if (p !== item.price) { item.price = p; didUpdate = true; } }
      if (thumbMap[assetId] && !item.thumbnail) { item.thumbnail = thumbMap[assetId]; didUpdate = true; }

      let remaining = details.remaining; let total = details.total; let sales = details.sales;
      const prevTotal = item.totalCopies;

      // Creator-confirmed totals as a fallback if the API doesn't report one
      const KNOWN_TOTALS = { '137910150798027': 3000, '129297459934395': 3000, '121581072690400': 3000 };

      if (remaining != null && Number.isFinite(Number(remaining))) {
        remaining = Number(remaining);
        let trueTotal = null;
        if (total != null && Number.isFinite(Number(total))) trueTotal = Number(total);            // CollectiblesItemDetails.TotalQuantity — real value (3000)
        else if (KNOWN_TOTALS[assetId]) trueTotal = KNOWN_TOTALS[assetId];
        else if (sales != null && Number.isFinite(Number(sales))) trueTotal = Number(sales) + remaining;
        else trueTotal = item.totalCopies;

        const trueSold = Math.max(0, trueTotal - remaining);
        const totalChanged = prevTotal && trueTotal !== prevTotal; // creator changed supply — rebaseline, don't fake sales

        if (!item.stockBaseline) {
          item.stockBaseline = true; // first read after boot — just set the baseline, no fake history
          item.feedSold = trueSold;
        } else if (!totalChanged) {
          // A REAL purchase happened between polls: copiesSold went up, which is
          // the exact same signal that moves the Robux number. Emit every copy
          // that isn't already in the feed (tx/owners may have logged it first).
          const missing = trueSold - (item.feedSold ?? 0);
          if (missing > 0) {
            const emit = Math.min(missing, 50);
            newStockSales += emitStockSales(item, emit);
            if (missing > emit) {
              console.warn(`[poll:inventory] ${assetId} stock jumped +${missing} — ${missing - emit} beyond feed cap skipped`);
              registerFeedSale(assetId, missing - emit);
            }
          }
        }
        if (trueTotal !== item.totalCopies) { item.totalCopies = trueTotal; didUpdate = true; }
        if (trueSold !== item.copiesSold) { item.copiesSold = trueSold; didUpdate = true; }
        if (remaining !== item.copiesRemaining) { item.copiesRemaining = remaining; didUpdate = true; }
      } else if (total != null && Number.isFinite(Number(total))) {
        const t = Number(total); if (t !== item.totalCopies) { item.totalCopies = t; didUpdate = true; }
      }

      if (didUpdate) {
        item.progress = item.totalCopies>0 ? Math.round((item.copiesSold/item.totalCopies)*100) : 0;
        item.updatedAt = new Date().toISOString();
        changed = true;
      }
    } catch(e){ console.warn(`[poll:inventory] ${assetId} failed: ${e.message}`); }
    await new Promise(r=>setTimeout(r,350));
  }

  if (!anyOk) {
    // every item failed (network down / rate limited) — back off so we don't hammer Roblox
    inventoryFailStreak++;
    const wait = Math.min(60000, 10000 * inventoryFailStreak);
    inventorySkipUntil = Date.now() + wait;
    console.warn(`[poll:inventory] all items failed — backing off ${Math.round(wait/1000)}s`);
    return;
  }
  inventoryFailStreak = 0;

  if (changed || newStockSales > 0) {
    recalcStats();
    sortSales();
    state.lastUpdated = new Date().toISOString();
    state.live = true; // inventory succeeded — overlay is live even without group transactions
    broadcast('state', toPublicState());
    broadcast('inventory', { items:Object.values(state.items) });
    if (newStockSales > 0) {
      console.log(`[poll:inventory] +${newStockSales} sale(s) via stock — latest: ${state.latestSale?.buyerName} bought ${state.latestSale?.itemName}`);
      broadcast('sale', state.latestSale);
    }
    console.log(`[poll:inventory] ${Object.values(state.items).map(i=> `${i.name}: ${i.copiesSold}/${i.totalCopies} (${i.progress}%)`).join(' | ')}`);
  } else {
    state.lastUpdated = new Date().toISOString();
    // even if nothing changed, a successful poll means we're live
    if (state.lastInventoryAt) state.live = true;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req,res,next)=>{ res.removeHeader('X-Frame-Options'); next(); });
app.get('/health', (req,res)=> res.json({ ok:true, demoMode:state.demoMode, live:state.live, uptime:process.uptime(), lastUpdated:state.lastUpdated }));
app.get('/api/state', (req,res)=> res.json(toPublicState()));
app.get('/api/events', (req,res)=>{
  res.writeHead(200,{ 'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'*'});
  res.write('retry: 3000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(toPublicState())}\n\n`);
  res.write(`: connected ${Date.now()}\n\n`);
  const clientId=Date.now()+Math.random().toString(16).slice(2);
  const client={id:clientId,res}; sseClients.push(client);
  console.log(`[sse] client connected ${clientId} — ${sseClients.length} total`);
  req.on('close',()=>{ sseClients=sseClients.filter(c=>c.id!==clientId); console.log(`[sse] client disconnected ${clientId}`); try{res.end();}catch{} });
});
app.post('/api/demo/sale', (req,res)=> {
  return res.status(403).json({ error: 'disabled' });
});
app.use(express.static(path.join(__dirname,'public'),{ maxAge:'5m', etag:true }));
app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

function startLoops(){
  setTimeout(pollGroupSales,1500);
  setTimeout(pollInventory,2500);
  setTimeout(pollRecentBuyers,4000);
  setInterval(pollGroupSales, POLL_INTERVAL_MS);
  // Stock IS the sales feed now (remaining drop = purchase), so poll it at the
  // fast sales interval — this is what keeps the feed in sync with the Robux total.
  setInterval(pollInventory, STOCK_POLL_MS);
  setInterval(pollRecentBuyers, POLL_INTERVAL_MS); // buyer names without cookie (best effort)
}
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`[http] listening on 0.0.0.0:${PORT}`);
  console.log(`[http] overlay: http://localhost:${PORT}/`);
  console.log(`[http] sse: http://localhost:${PORT}/api/events`);
  console.log(`[http] state: http://localhost:${PORT}/api/state`);
  startLoops();
});
