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
const ROBLOX_COOKIE = (process.env.ROBLOX_COOKIE || '').trim();
const HAS_COOKIE = ROBLOX_COOKIE.length > 10;

console.log(`[boot] Nobody's Brand Live Sales`);
console.log(`[boot] Group: ${GROUP_ID} | Assets: ${UGC_ASSET_IDS.join(', ')}`);
console.log(`[boot] poll: ${POLL_INTERVAL_MS}ms | inventory: ${INVENTORY_POLL_INTERVAL_MS}ms`);
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
  inventoryPollIntervalMs: INVENTORY_POLL_INTERVAL_MS,
  note: HAS_COOKIE
    ? 'Live polling with cookie — every sale shows buyer + time'
    : 'Public mode — stock is 100% real (no cookie). Sales feed shows real purchases only (anonymous without cookie).',
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
  state.stats = { totalCopies, totalSold, copiesLeft };
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
  const h = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'NobodiesBrandLive/1.0 (polling; +https://www.roblox.com/communities/201198194)',
    ...extra,
  };
  if (HAS_COOKIE) h['Cookie'] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
  if (csrfToken) h['X-CSRF-TOKEN'] = csrfToken;
  return h;
}
let csrfToken = null;
let csrfFetchedAt = 0;
async function ensureCsrfToken() {
  if (!HAS_COOKIE) return null;
  if (csrfToken && Date.now() - csrfFetchedAt < 300000) return csrfToken;
  try {
    // auth.roblox.com is the canonical CSRF endpoint — POST returns x-csrf-token even on failure
    const r = await fetch('https://auth.roblox.com/v2/logout', { method: 'POST', headers: robloxHeaders() });
    const t = r.headers.get('x-csrf-token') || r.headers.get('X-CSRF-TOKEN');
    if (t) { csrfToken = t; csrfFetchedAt = Date.now(); console.log(`[csrf] got token ${t.slice(0,8)}...`); return t; }
  } catch (e) { console.warn(`[csrf] logout fetch failed: ${e.message}`); }
  try {
    const r2 = await fetch('https://www.roblox.com/home', { headers: robloxHeaders() });
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
    `https://economy.roblox.com/v1/communities/${GROUP_ID}/transactions?transactionType=Sale&limit=25&cursor=`,
    `https://economy.roproxy.com/v1/groups/${GROUP_ID}/transactions?transactionType=Sale&limit=25&cursor=`,
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
        demo: false,
      };
      state.sales.unshift(sale);
      newSales++;
      state.sales.sort((a,b)=> new Date(b.soldAt)-new Date(a.soldAt));
      if (state.sales.length>80) state.sales.length=80;
    }
    if (newSales>0) { state.latestSale = state.sales[0]; console.log(`[poll:sales] +${newSales} new`); }
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
          total: (d.Sales != null && d.Remaining != null) ? (d.Sales + d.Remaining) : null,
        };
      }
    }
  } catch {}
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
  try {
    const url3 = `https://catalog.roblox.com/v1/catalog/items/details`;
    const r3 = await fetchJson(url3, { method:'POST', headers, body: JSON.stringify({ items:[{ itemType:'Asset', id:parseInt(assetId,10)}]})});
    if (r3.ok && r3.json && r3.json.data && r3.json.data[0]) {
      const d = r3.json.data[0];
      return { name:d.name||null, price:d.price??null, remaining:d.unitsAvailableForConsumption??d.remaining??null, sales:null, total:d.collectibleItemDetails?.totalQuantity??null };
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
// Public buyer tracking via Limited owners — works WITHOUT cookie, like other UGC trackers do
const seenOwners = new Map(); // assetId -> Set of owner ids already seen
async function pollRecentBuyers() {
  for (const assetId of UGC_ASSET_IDS) {
    try {
      // This is the public endpoint other trackers use to show real buyers without a group cookie
      const url = `https://inventory.roblox.com/v1/assets/${assetId}/owners?sortOrder=Desc&limit=10`;
      const r = await fetchJson(url, { headers: robloxHeaders() });
      if (!r.ok || !r.json) {
        // try alternate: collectible instances
        const altUrl = `https://apis.roblox.com/marketplace-items/v1/items/item/${assetId}/instances?limit=10&cursor=`;
        const r2 = await fetchJson(altUrl, { headers: robloxHeaders() });
        if (!r2.ok || !r2.json) continue;
        const instances = r2.json.data || r2.json.instances || [];
        if (!instances.length) continue;
        if (!seenOwners.has(assetId)) seenOwners.set(assetId, new Set());
        const seen = seenOwners.get(assetId);
        let newOnes = [];
        for (const inst of instances) {
          const owner = inst.owner || inst.currentOwner || {};
          const uid = String(owner.id || owner.userId || inst.ownerId || '');
          if (!uid || seen.has(uid + '-' + (inst.serialNumber || ''))) continue;
          seen.add(uid + '-' + (inst.serialNumber || ''));
          newOnes.push({ uid, name: owner.name || owner.username || `User ${uid}`, at: inst.updated || inst.created || new Date().toISOString(), serial: inst.serialNumber });
        }
        if (seen.size > 200) { const arr=[...seen]; arr.slice(0,100).forEach(v=>seen.delete(v)); }
        if (newOnes.length && seen.size > 10) { // after baseline, only new owners count as sales
          const item = state.items[assetId];
          for (const o of newOnes.reverse()) {
            const sale = { id: `owner-${assetId}-${o.uid}-${o.serial}-${Date.now()}`, assetId, itemName: item?.name || `Item ${assetId}`, buyerName: o.name, buyerId: o.uid, price: item?.price ?? 0, currency:'Robux', soldAt: o.at, created: o.at, demo:false, via:'owners' };
            state.sales.unshift(sale);
            if (state.sales.length>80) state.sales.length=80;
            state.latestSale = state.sales[0];
            console.log(`[owners] ${sale.itemName} new owner ${sale.buyerName} #${o.serial}`);
          }
          state.sales.sort((a,b)=> new Date(b.soldAt)-new Date(a.soldAt));
          state.lastUpdated = new Date().toISOString();
          broadcast('sale', state.latestSale);
          broadcast('state', toPublicState());
        } else if (seen.size <= 10) {
          // baseline — just remember owners, don't flood feed with history
          console.log(`[owners] baseline ${assetId}: ${seen.size} owners`);
        }
        continue;
      }
      const owners = r.json.data || r.json.owners || [];
      if (!owners.length) continue;
      if (!seenOwners.has(assetId)) seenOwners.set(assetId, new Set());
      const seen = seenOwners.get(assetId);
      let newOnes = [];
      for (const o of owners) {
        const uid = String(o.id || o.owner?.id || '');
        const name = o.name || o.owner?.name || o.username || `User ${uid}`;
        const serial = o.serialNumber ?? o.instanceId ?? '';
        const key = uid + '-' + serial;
        if (!uid || seen.has(key)) continue;
        seen.add(key);
        newOnes.push({ uid, name, at: o.updated || o.created || new Date().toISOString(), serial });
      }
      if (seen.size > 200) { const arr=[...seen]; arr.slice(0,100).forEach(v=>seen.delete(v)); }
      if (newOnes.length && seen.size > owners.length) {
        // only after baseline
        const item = state.items[assetId];
        for (const o of newOnes.reverse()) {
          const sale = { id: `owner-${assetId}-${o.uid}-${Date.now()}`, assetId, itemName: item?.name || `Item ${assetId}`, buyerName: o.name, buyerId: o.uid, price: item?.price ?? 0, currency:'Robux', soldAt: o.at, created: o.at, demo:false, via:'owners' };
          state.sales.unshift(sale);
          if (state.sales.length>80) state.sales.length=80;
          state.latestSale = sale;
          console.log(`[owners] ${sale.itemName} new owner ${sale.buyerName}`);
        }
        state.sales.sort((a,b)=> new Date(b.soldAt)-new Date(a.soldAt));
        state.lastUpdated = new Date().toISOString();
        broadcast('state', toPublicState());
      } else if (seen.size <= owners.length) {
        console.log(`[owners] baseline ${assetId}: ${owners.length} owners`);
      }
    } catch (e) { console.warn(`[owners] ${assetId} failed: ${e.message}`); }
    await new Promise(r=>setTimeout(r,400));
  }
}

async function pollInventory() {
  state.lastInventoryAt = new Date().toISOString();
  let changed = false;
  let thumbMap={};
  const needThumbs = UGC_ASSET_IDS.some(id=> !state.items[id]?.thumbnail);
  if (needThumbs) thumbMap = await fetchThumbnails(UGC_ASSET_IDS);
  for (const assetId of UGC_ASSET_IDS) {
    try {
      const details = await fetchAssetDetails(assetId);
      if (!details) continue;
      const item = state.items[assetId];
      if (!item) continue;
      let didUpdate=false;
      if (details.name && details.name !== item.name) { item.name = details.name; didUpdate=true; }
      if (details.price != null && Number.isFinite(Number(details.price))) { const p=Number(details.price); if(p!==item.price){ item.price=p; didUpdate=true; } }
      if (thumbMap[assetId] && !item.thumbnail) { item.thumbnail=thumbMap[assetId]; didUpdate=true; }

      let remaining = details.remaining; let total = details.total; let sales = details.sales;
      const prevSold = item.copiesSold;
      const prevTotal = item.totalCopies;

      // Known totals as per creator: 3000 each (override wrong Sales+Remaining calc)
      const KNOWN_TOTALS = { '137910150798027': 3000, '129297459934395': 3000, '121581072690400': 3000 };
      const knownTotal = KNOWN_TOTALS[assetId] || null;

      // ACCURATE: Use real 3000 total + real remaining to compute real sold = total - remaining
      // This fixes the 0% bug where Sales was 0 and we did 0+2845=2845 total (0% sold) instead of 3000 total (5% sold)
      if (remaining != null && Number.isFinite(Number(remaining))) {
        remaining = Number(remaining);
        let trueTotal = null;
        if (knownTotal) trueTotal = knownTotal;
        else if (total != null && Number.isFinite(Number(total))) trueTotal = Number(total);
        else if (sales != null && Number.isFinite(Number(sales))) trueTotal = Number(sales) + remaining;
        else trueTotal = item.totalCopies;

        const trueSold = Math.max(0, trueTotal - remaining);
        if (trueTotal !== item.totalCopies) { item.totalCopies = trueTotal; didUpdate = true; }
        if (trueSold !== item.copiesSold) { item.copiesSold = trueSold; didUpdate = true; }
        if (remaining !== item.copiesRemaining) { item.copiesRemaining = remaining; didUpdate = true; }
      } else if (total != null && Number.isFinite(Number(total))) {
        const t = Number(total); if (t !== item.totalCopies) { item.totalCopies = t; didUpdate = true; }
      }

      if (didUpdate) {
        item.progress = item.totalCopies>0 ? Math.round((item.copiesSold/item.totalCopies)*100) : 0;
        item.updatedAt = new Date().toISOString();
        changed=true;
      }
    } catch(e){ console.warn(`[poll:inventory] ${assetId} failed: ${e.message}`); }
    await new Promise(r=>setTimeout(r,350));
  }
  if (changed) {
    recalcStats();
    // keep sales sorted newest first
    state.sales.sort((a,b)=> new Date(b.soldAt)-new Date(a.soldAt));
    if (!state.latestSale && state.sales[0]) state.latestSale = state.sales[0];
    state.lastUpdated = new Date().toISOString();
    broadcast('state', toPublicState());
    broadcast('inventory', { items:Object.values(state.items) });
    console.log(`[poll:inventory] ${Object.values(state.items).map(i=> `${i.name}: ${i.copiesSold}/${i.totalCopies} (${i.progress}%)`).join(' | ')}`);
  } else {
    state.lastUpdated = new Date().toISOString();
  }
  // No fake background progress in public mode — only real sales move bars
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
// manual trigger still works but only in demo for testing — not used in public accurate mode
app.post('/api/demo/sale', (req,res)=> {
  if (!state.demoMode) return res.status(403).json({error:'disabled in live mode'});
  // create one anonymous sale for testing
  const id = UGC_ASSET_IDS[0]; const item = state.items[id];
  const s={ id:`test-${Date.now()}`, assetId:id, itemName:item.name, buyerName:'TestBuyer', buyerId:null, price:item.price, currency:'Robux', soldAt:new Date().toISOString(), created:new Date().toISOString(), demo:true};
  state.sales.unshift(s); state.latestSale=s; if(state.sales.length>80) state.sales.length=80;
  state.lastUpdated=new Date().toISOString(); broadcast('state', toPublicState()); res.json({ok:true, latest:s});
});
app.use(express.static(path.join(__dirname,'public'),{ maxAge:'5m', etag:true }));
app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

function startLoops(){
  setTimeout(pollGroupSales,1500);
  setTimeout(pollInventory,2500);
  setTimeout(pollRecentBuyers,4000);
  setInterval(pollGroupSales, POLL_INTERVAL_MS);
  setInterval(pollInventory, INVENTORY_POLL_INTERVAL_MS);
  setInterval(pollRecentBuyers, POLL_INTERVAL_MS); // public owners — real buyers without needing spend perm, like other trackers
}
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`[http] listening on 0.0.0.0:${PORT}`);
  console.log(`[http] overlay: http://localhost:${PORT}/`);
  console.log(`[http] sse: http://localhost:${PORT}/api/events`);
  console.log(`[http] state: http://localhost:${PORT}/api/state`);
  startLoops();
});
