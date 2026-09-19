// Nobody's Brand Live — item section split
//
// Items that sell out on Roblox stay tracked (their copies and Robux still count
// in the header) but they no longer belong in the "Limited stock" grid — they
// move down into their own "Sold out items" section.
//
// Dependency-free + DOM-free on purpose: script.js imports it, and the tests in
// test/sold-out-items.test.mjs exercise it directly in node.

// Copies left for an item, or null when the server has not reported a count yet
// (boot values, a failed poll, an unknown item). null must NEVER read as 0 —
// otherwise an item that has not been polled yet would instantly look sold out.
export function remainingOf(item) {
  const raw = item?.copiesRemaining ?? item?.remaining;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function isSoldOut(item) {
  const left = remainingOf(item);
  return left !== null && left <= 0;
}

// Splits the tracked items into the live grid and the sold-out section, keeping
// the server's order inside each group so cards never jump around on a refresh.
export function splitItemsByStock(items) {
  const list = Array.isArray(items) ? items : [];
  const inStock = [];
  const soldOut = [];
  for (const item of list) (isSoldOut(item) ? soldOut : inStock).push(item);
  return { inStock, soldOut };
}

// "1 item • 3,000 copies sold" — the hint under the sold-out heading.
export function soldOutHint(itemCount, copiesSold) {
  const n = Number(itemCount) || 0;
  const copies = Number(copiesSold) || 0;
  return `${n} item${n === 1 ? '' : 's'} • ${copies.toLocaleString()} ${copies === 1 ? 'copy' : 'copies'} sold`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// One stock card. Sold-out cards carry the SOLD OUT badge and get the greyed
// treatment from the .soldout class — same numbers, calmer look.
export function itemCardHTML(it, soldOut = false) {
  const pct = Math.max(0, Math.min(100, it.progress ?? 0));
  const sold = Number(it.copiesSold || 0).toLocaleString();
  const total = Number(it.totalCopies || 0).toLocaleString();
  const left = Number(it.copiesRemaining ?? it.remaining ?? 0).toLocaleString();
  const thumb = it.thumbnail
    ? `<img class="item-thumb" src="${escapeHtml(it.thumbnail)}" alt="${escapeHtml(it.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" /><div class="item-thumb-ph" style="display:none">${escapeHtml(it.name.slice(0,2).toUpperCase())}</div>`
    : `<div class="item-thumb-ph">${escapeHtml(it.name.slice(0,2).toUpperCase())}</div>`;

  return `
      <div class="item-card ${soldOut ? 'soldout' : ''}">
        ${thumb}
        <div class="item-main">
          <div class="item-top">
            <div class="item-name">${escapeHtml(it.name)}${soldOut ? `<span class="item-soldout-badge">SOLD OUT</span>` : ``}</div>
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
            ${soldOut ? `<span class="dot-sep">•</span><span class="item-soldout-note">SOLD OUT</span>` : ``}
          </div>
        </div>
      </div>
    `;
}
