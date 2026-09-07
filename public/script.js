// Nobody's Brand Live — frontend (OBS overlay)
// SSE: /api/events  |  State: /api/state
// No Roblox cookie here — ever.

const els = {
  livePill: document.getElementById('live-pill'),
  liveText: document.getElementById('live-text'),
  statSold: document.getElementById('stat-sold'),
  statLeft: document.getElementById('stat-left'),
  statTotal: document.getElementById('stat-total'),
  revenueNet: document.getElementById('revenue-net'),
  revenueGross: document.getElementById('revenue-gross'),
  boardFiery: document.getElementById('board-fiery'),
  boardEmote: document.getElementById('board-emote'),
  boardClock: document.getElementById('board-clock'),
  latestEmpty: document.getElementById('latest-empty'),
  latestContent: document.getElementById('latest-content'),
  latestItem: document.getElementById('latest-item'),
  latestBuyer: document.getElementById('latest-buyer'),
  latestPrice: document.getElementById('latest-price'),
  latestTime: document.getElementById('latest-time'),
  latestThumb: document.getElementById('latest-thumb'),
  latestThumbPh: document.getElementById('latest-thumb-ph'),
  demoBadge: document.getElementById('demo-badge'),
  heroCard: document.getElementById('hero-card'),
  heroFlash: document.getElementById('hero-flash'),
  itemsGrid: document.getElementById('items-grid'),
  feed: document.getElementById('feed'),
  feedEmpty: document.getElementById('feed-empty'),
  feedCount: document.getElementById('feed-count'),
  feedStatus: document.getElementById('feed-status'),
  lastUpdated: document.getElementById('last-updated'),
  modeLabel: document.getElementById('mode-label'),
  inventoryHint: document.getElementById('inventory-hint'),
  groupLink: document.getElementById('group-link'),
  pollNote: document.getElementById('poll-note'),
};

let lastState = null;
let sse = null;
let reconnectTimer = null;
let timeAgoTimer = null;
let displayedRevenue = null;

function fmtTimeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1m ago';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 7200) return '1h ago';
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return d.toLocaleString();
}

function fmtFullTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function setLivePill(mode) {
  // mode: 'live' | 'demo' | 'connecting' | 'offline' — demo now means public accurate (no fake)
  els.livePill.classList.remove('live','demo');
  if (mode === 'live') {
    els.livePill.classList.add('live');
    els.liveText.textContent = 'LIVE';
  } else if (mode === 'demo') {
    els.livePill.classList.add('demo');
    els.liveText.textContent = 'PUBLIC • LIVE';
  } else if (mode === 'connecting') {
    els.liveText.textContent = 'CONNECTING';
  } else {
    els.liveText.textContent = 'OFFLINE';
  }
}

function renderStats(state) {
  const { totalSold, copiesLeft, totalCopies, net, gross } = state.stats || { totalSold: 0, copiesLeft: 0, totalCopies: 0, net: 0, gross: 0 };
  els.statSold.textContent = Number(totalSold).toLocaleString();
  els.statLeft.textContent = Number(copiesLeft).toLocaleString();
  els.statTotal.textContent = Number(totalCopies).toLocaleString();
  // Revenue — after 30% fee, per-item prices (50 for emote, 95 for others) — same size, cooler board
  const netVal = Number(net ?? state.stats?.revenue ?? 0);
  const grossVal = Number(gross ?? state.stats?.revenueGross ?? 0);
  if (els.revenueGross) els.revenueGross.textContent = grossVal.toLocaleString();
  // compact per-item leaderboard (same card, no extra height)
  try {
    const items = state.items || [];
    const find = (id) => items.find(i => String(i.assetId) === id);
    const fiery = find('137910150798027');
    const emote = find('129297459934395');
    const shade = find('121581072690400');
    const fmt = (it) => it ? (Math.floor((Number(it.price)||0)*0.3) * (it.copiesSold||0)).toLocaleString() : '0';
    if (els.boardFiery) els.boardFiery.textContent = `Fiery ${fmt(fiery)}`;
    if (els.boardEmote) els.boardEmote.textContent = `Emote ${fmt(emote)}`;
    if (els.boardClock) els.boardClock.textContent = `Shade ${fmt(shade)}`;
  } catch {}
  if (els.revenueNet) {
    if (displayedRevenue === null) {
      // first paint — no animation
      displayedRevenue = netVal;
      els.revenueNet.textContent = netVal.toLocaleString();
    } else if (displayedRevenue !== netVal) {
      const from = displayedRevenue;
      displayedRevenue = netVal;
      const el = els.revenueNet;
      const start = performance.now();
      const duration = 1000;
      const ease = t => 1 - Math.pow(1 - t, 3);
      el.classList.add('tick');
      const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const v = Math.round(from + (netVal - from) * ease(p));
        el.textContent = v.toLocaleString();
        if (p < 1) requestAnimationFrame(step);
        else { el.classList.remove('tick'); el.textContent = netVal.toLocaleString(); }
      };
      requestAnimationFrame(step);
    }
  }
}

function renderLatest(state) {
  const latest = state.latestSale;
  const demo = state.demoMode;

  els.demoBadge.classList.toggle('hidden', !demo);

  if (!latest) {
    els.latestEmpty.classList.remove('hidden');
    els.latestContent.classList.add('hidden');
    els.latestTime.textContent = '—';
    els.latestThumb.classList.add('hidden');
    els.latestThumbPh.classList.remove('hidden');
    return;
  }

  els.latestEmpty.classList.add('hidden');
  els.latestContent.classList.remove('hidden');

  els.latestItem.textContent = latest.itemName || `Item ${latest.assetId}`;
  els.latestBuyer.textContent = latest.buyerName || 'Unknown';
  els.latestPrice.textContent = `${latest.price ?? '?'} Robux`;
  els.latestTime.textContent = fmtTimeAgo(latest.soldAt);
  els.latestTime.title = new Date(latest.soldAt).toLocaleString();

  // thumbnail: find item thumb
  const item = (state.items || []).find(i => String(i.assetId) === String(latest.assetId));
  if (item && item.thumbnail) {
    els.latestThumb.src = item.thumbnail;
    els.latestThumb.alt = item.name;
    els.latestThumb.classList.remove('hidden');
    els.latestThumbPh.classList.add('hidden');
    els.latestThumb.onerror = () => {
      els.latestThumb.classList.add('hidden');
      els.latestThumbPh.classList.remove('hidden');
    };
  } else {
    els.latestThumb.classList.add('hidden');
    els.latestThumbPh.classList.remove('hidden');
  }

  // flash
  els.heroCard.classList.add('flash');
  setTimeout(() => els.heroCard.classList.remove('flash'), 900);
}

function renderItems(state) {
  const items = state.items || [];
  if (!items.length) {
    els.itemsGrid.innerHTML = `<div class="item-card"><div class="item-main"><div class="item-name">No items</div></div></div>`;
    return;
  }

  // Keep existing DOM nodes where possible to allow bar animation
  els.itemsGrid.innerHTML = items.map(it => {
    const pct = Math.max(0, Math.min(100, it.progress ?? 0));
    const sold = Number(it.copiesSold || 0).toLocaleString();
    const total = Number(it.totalCopies || 0).toLocaleString();
    const left = Number(it.copiesRemaining ?? it.remaining ?? 0).toLocaleString();
    const isSoldOut = (it.copiesRemaining ?? it.remaining) === 0;
    const thumb = it.thumbnail
      ? `<img class="item-thumb" src="${escapeHtml(it.thumbnail)}" alt="${escapeHtml(it.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" /><div class="item-thumb-ph" style="display:none">${escapeHtml(it.name.slice(0,2).toUpperCase())}</div>`
      : `<div class="item-thumb-ph">${escapeHtml(it.name.slice(0,2).toUpperCase())}</div>`;

    return `
      <div class="item-card ${isSoldOut ? 'soldout' : ''}">
        ${thumb}
        <div class="item-main">
          <div class="item-top">
            <div class="item-name">${escapeHtml(it.name)}</div>
            <div class="item-price">${escapeHtml(it.price ?? '?')} R$</div>
          </div>
          <div class="item-stats">
            <span><strong>${sold}</strong> sold</span>
            <span><strong>${left}</strong> left</span>
            <span><strong>${total}</strong> total</span>
          </div>
          <div class="item-bar" aria-label="progress ${pct}%">
            <div class="item-bar-fill" style="width:${pct}%"></div>
          </div>
          <div class="item-foot">
            <span class="item-dot"></span>
            <span>${pct}% sold</span>
            <span class="dot-sep">•</span>
            <span>ID ${escapeHtml(it.assetId)}</span>
            ${isSoldOut ? `<span class="dot-sep">•</span><span style="color:#fff;font-weight:700">SOLD OUT</span>` : ``}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderFeed(state) {
  const sales = state.sales || [];
  els.feedCount.textContent = `${sales.length} sale${sales.length === 1 ? '' : 's'}`;

  if (!sales.length) {
    els.feedEmpty.style.display = 'grid';
    // clear feed items but keep empty
    [...els.feed.querySelectorAll('.feed-item')].forEach(n => n.remove());
    return;
  }

  els.feedEmpty.style.display = 'none';
  // Build feed HTML newest first
  const html = sales.slice(0, 40).map((s, idx) => {
    const item = (state.items || []).find(i => String(i.assetId) === String(s.assetId));
    const thumb = item?.thumbnail
      ? `<img class="feed-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" /><div class="feed-thumb-ph" style="display:none">${escapeHtml((item.name || s.itemName || 'NB').slice(0,2).toUpperCase())}</div>`
      : `<div class="feed-thumb-ph">${escapeHtml((s.itemName || 'NB').slice(0,2).toUpperCase())}</div>`;

    const time = fmtTimeAgo(s.soldAt);
    return `
      <div class="feed-item ${idx === 0 ? 'latest' : ''}">
        ${thumb}
        <div class="feed-main">
          <div class="feed-item-name">${escapeHtml(s.itemName || item?.name || `Item ${s.assetId}`)}</div>
          <div class="feed-item-buyer">bought by <strong>${escapeHtml(s.buyerName || 'Unknown')}</strong></div>
        </div>
        <div class="feed-meta">
          <div class="feed-price">${escapeHtml(s.price ?? '?')} R$</div>
          <div class="feed-time" title="${escapeHtml(new Date(s.soldAt).toLocaleString())}">${escapeHtml(time)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Efficiently update if changed
  if (els.feed.dataset.hash !== String(sales[0]?.id)) {
    els.feed.dataset.hash = String(sales[0]?.id || '');
    // Preserve scroll if user scrolled up — only autoscroll if at top
    const atTop = els.feed.scrollTop < 40;
    els.feed.innerHTML = html + els.feed.innerHTML.includes('feed-empty') ? '' : '';
    // Re-inject empty but hidden
    if (!document.getElementById('feed-empty')) {
      // already handled
    }
    // Ensure empty node stays
    if (els.feedEmpty && !els.feed.contains(els.feedEmpty)) {
      els.feed.prepend(els.feedEmpty);
      els.feedEmpty.style.display = 'none';
    }
    if (atTop) els.feed.scrollTop = 0;
  }
}

function renderMeta(state) {
  els.lastUpdated.textContent = `Last updated ${fmtTimeAgo(state.lastUpdated)} • ${fmtFullTime(state.lastUpdated)}`;
  els.lastUpdated.title = new Date(state.lastUpdated).toLocaleString();

  const mode = state.demoMode
    ? `Public mode — stock is 100% real. Buyer names hidden without private cookie.`
    : (state.live ? `Live — polling Roblox with cookie` : `Connecting to Roblox…`);
  els.modeLabel.textContent = mode;

  els.inventoryHint.textContent = `Live counts update ~every ${Math.round((state.inventoryPollIntervalMs || 30000)/1000)}s`;
  els.pollNote.textContent = `Near-live polling • Sales ~${Math.round((state.pollIntervalMs||7000)/1000)}s • Stock ~${Math.round((state.inventoryPollIntervalMs||30000)/1000)}s`;

  if (state.live) setLivePill('live');
  else if (state.demoMode) setLivePill('demo');
  else setLivePill('connecting');
}

function render(state) {
  lastState = state;
  renderStats(state);
  renderLatest(state);
  renderItems(state);
  renderFeed(state);
  renderMeta(state);

  // Group link
  if (state.groupUrl) els.groupLink.href = state.groupUrl;
}

async function fetchStateOnce() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    render(j);
  } catch (e) {
    console.warn('[state] fetch failed', e);
  }
}

function connectSSE() {
  if (sse) try { sse.close(); } catch {}
  if (reconnectTimer) clearTimeout(reconnectTimer);

  els.feedStatus.textContent = 'Connecting via Server-Sent Events…';
  setLivePill('connecting');

  // EventSource is perfect for OBS (no websockets needed)
  sse = new EventSource('/api/events');

  sse.addEventListener('open', () => {
    els.feedStatus.textContent = 'Live — connected (SSE). No refresh needed.';
  });

  sse.addEventListener('state', (e) => {
    try {
      const data = JSON.parse(e.data);
      render(data);
      els.feedStatus.textContent = `Live — updated ${fmtTimeAgo(data.lastUpdated)} • SSE`;
    } catch {}
  });

  sse.addEventListener('sale', (e) => {
    try {
      const sale = JSON.parse(e.data);
      // Flash latest even if state hasn't arrived yet
      if (lastState) {
        lastState.latestSale = sale;
        lastState.sales.unshift(sale);
        if (lastState.sales.length > 50) lastState.sales.length = 50;
        render(lastState);
      }
    } catch {}
  });

  sse.addEventListener('sales', (e) => {
    try {
      const d = JSON.parse(e.data);
      console.log('[sse] sales batch', d);
    } catch {}
  });

  sse.addEventListener('inventory', () => {
    // state event already handles it
  });

  sse.onerror = () => {
    setLivePill('offline');
    els.feedStatus.textContent = 'Reconnecting… (SSE dropped)';
    try { sse.close(); } catch {}
    reconnectTimer = setTimeout(connectSSE, 3000);
  };
}

// Keep "time ago" labels fresh
function startTimeAgoTicker() {
  if (timeAgoTimer) clearInterval(timeAgoTimer);
  timeAgoTimer = setInterval(() => {
    if (!lastState) return;
    // Re-render time-sensitive parts only
    renderMeta(lastState);
    // Update feed times without full re-render churn — just re-render feed
    renderFeed(lastState);
    // Latest time
    if (lastState.latestSale) {
      els.latestTime.textContent = fmtTimeAgo(lastState.latestSale.soldAt);
    }
  }, 15000);
}

// Compact toggle (press D or add ?compact=1)
function initCompact() {
  const params = new URLSearchParams(location.search);
  if (params.get('compact') === '1' || params.get('obs') === '1') {
    document.body.classList.add('compact');
  }
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey) {
      document.body.classList.toggle('compact');
      const hud = document.getElementById('obs-hud');
      hud.textContent = document.body.classList.contains('compact') ? 'Compact mode — press D to expand' : 'Comfort mode — press D for compact';
      hud.classList.remove('hidden');
      setTimeout(() => hud.classList.add('hidden'), 1800);
    }
  });
}

// Boot
(async function boot(){
  initCompact();
  setLivePill('connecting');
  await fetchStateOnce();
  connectSSE();
  startTimeAgoTicker();

  // Fallback polling if SSE blocked (some corporate proxies buffer SSE)
  setInterval(async () => {
    if (!sse || sse.readyState === EventSource.CLOSED) {
      await fetchStateOnce();
    }
  }, 10000);
})();
