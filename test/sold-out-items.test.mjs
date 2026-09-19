// Sold-out items move down into their own "Sold out items" section.
//
// The [⏳LIMITED] Fake Dead MM2 Emote (129297459934395) hit 0 copies left, so it
// no longer belongs in the "Limited stock" grid. These tests pin the split:
// a 0-copies-left item leaves the live grid, lands in the sold-out section with
// a SOLD OUT badge, and is still counted everywhere it was before (header
// totals, revenue board, sales feed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSoldOut,
  itemCardHTML,
  remainingOf,
  soldOutHint,
  splitItemsByStock,
} from '../public/item-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlSrc = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const scriptSrc = readFileSync(path.join(ROOT, 'public/script.js'), 'utf8');
const cssSrc = readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

const EMOTE_ID = '129297459934395';
const HORNS_ID = '137910150798027';
const SHADES_ID = '121581072690400';

const item = (patch = {}) => ({
  assetId: EMOTE_ID,
  name: '[⏳LIMITED] Fake Dead MM2 Emote',
  price: 50,
  totalCopies: 3000,
  copiesSold: 0,
  copiesRemaining: 3000,
  remaining: 3000,
  progress: 0,
  thumbnail: '',
  ...patch,
});

// The real overlays's 3 items: emote sold out, horns + shades still selling.
const emoteSoldOut = item({ copiesSold: 3000, copiesRemaining: 0, remaining: 0, progress: 100 });
const horns = item({ assetId: HORNS_ID, name: 'FIery Horns', price: 95, totalCopies: 3000, copiesSold: 120, copiesRemaining: 2880, remaining: 2880 });
const shades = item({ assetId: SHADES_ID, name: 'Clockwork Shades', price: 95, totalCopies: 3000, copiesSold: 40, copiesRemaining: 2960, remaining: 2960 });

test('zero copies left reads as sold out', () => {
  assert.equal(remainingOf(emoteSoldOut), 0);
  assert.equal(isSoldOut(emoteSoldOut), true);
});

test('items with stock left are not sold out', () => {
  for (const it of [horns, shades]) {
    assert.equal(isSoldOut(it), false, `${it.name} should still be in the live grid`);
  }
});

test('an unknown stock count never counts as sold out', () => {
  // Boot state (before the first Roblox poll) and failed polls both leave the
  // count unknown. Treating that as 0 would dump live items into sold-out.
  for (const unknown of [undefined, null, '', 'n/a']) {
    const it = item({ copiesRemaining: unknown, remaining: unknown });
    assert.equal(remainingOf(it), null, `remainingOf(${JSON.stringify(unknown)}) should be null`);
    assert.equal(isSoldOut(it), false, `unknown (${JSON.stringify(unknown)}) must stay in the live grid`);
  }
  assert.equal(isSoldOut({ assetId: EMOTE_ID }), false);
  assert.equal(isSoldOut(null), false);
  assert.equal(remainingOf({ copiesRemaining: 5, remaining: 0 }), 5, 'copiesRemaining wins over remaining');
});

test('the sold-out emote leaves the Limited stock grid', () => {
  const { inStock, soldOut } = splitItemsByStock([emoteSoldOut, horns, shades]);
  assert.deepEqual(inStock.map(i => i.assetId), [HORNS_ID, SHADES_ID]);
  assert.deepEqual(soldOut.map(i => i.assetId), [EMOTE_ID]);
});

test('an item that just sold out switches sections on the next update', () => {
  const before = splitItemsByStock([item({ copiesRemaining: 1, remaining: 1 }), horns]);
  assert.deepEqual(before.soldOut, [], 'one copy left is still Limited stock');
  const after = splitItemsByStock([emoteSoldOut, horns]);
  assert.deepEqual(after.inStock.map(i => i.assetId), [HORNS_ID]);
  assert.deepEqual(after.soldOut.map(i => i.assetId), [EMOTE_ID]);
});

test('order inside each section follows the server payload', () => {
  const second = item({ assetId: '999999999999999', name: 'Another sold out item', copiesRemaining: 0, remaining: 0 });
  const { inStock, soldOut } = splitItemsByStock([emoteSoldOut, horns, second, shades]);
  assert.deepEqual(inStock.map(i => i.assetId), [HORNS_ID, SHADES_ID]);
  assert.deepEqual(soldOut.map(i => i.assetId), [EMOTE_ID, '999999999999999'], 'no reshuffling on refresh');
});

test('the section hint summarises items and copies sold', () => {
  assert.equal(soldOutHint(1, 3000), '1 item • 3,000 copies sold');
  assert.equal(soldOutHint(2, 4500), '2 items • 4,500 copies sold');
  assert.equal(soldOutHint(1, 1), '1 item • 1 copy sold');
  assert.equal(soldOutHint(0, 0), '0 items • 0 copies sold');
});

test('sold-out cards are labelled, live cards are not', () => {
  const soldCard = itemCardHTML(emoteSoldOut, true);
  assert.match(soldCard, /class="item-card soldout"/);
  assert.match(soldCard, /class="item-soldout-badge">SOLD OUT</);
  assert.match(soldCard, /class="item-soldout-note">SOLD OUT</);
  assert.match(soldCard, /<strong>0<\/strong> left/);
  assert.match(soldCard, /<strong>3,000<\/strong> sold/);
  assert.match(soldCard, /100% sold/);

  const liveCard = itemCardHTML(horns, false);
  assert.match(liveCard, /class="item-card "/);
  assert.doesNotMatch(liveCard, /soldout/i, 'an in-stock card must never look sold out');
  assert.match(liveCard, /<strong>2,880<\/strong> left/);
});

test('stock cards escape the item name', () => {
  const card = itemCardHTML(item({ name: '<img src=x onerror=alert(1)>', copiesRemaining: 0 }), true);
  assert.ok(!card.includes('<img src=x'), 'item name must be escaped');
});

// ---------------------------------------------------------------------------
// Markup + wiring: the section exists, sits below Limited stock, and hides
// itself while nothing is sold out.
// ---------------------------------------------------------------------------
test('the overlay has a Sold out items section below Limited stock', () => {
  assert.match(htmlSrc, /id="soldout-panel"[^>]*data-section="soldout"/);
  assert.match(htmlSrc, /<h2>Sold out items<\/h2>/);
  assert.match(htmlSrc, /id="soldout-grid"/);
  assert.match(htmlSrc, /id="soldout-hint"/);

  const stockPanel = htmlSrc.indexOf('id="stock-panel"');
  const soldOutPanel = htmlSrc.indexOf('id="soldout-panel"');
  assert.ok(stockPanel > -1 && soldOutPanel > -1, 'both panels must exist');
  assert.ok(soldOutPanel > stockPanel, 'the sold-out section must come after Limited stock (moved down)');
});

test('the sold-out section starts hidden until something sells out', () => {
  assert.match(htmlSrc, /id="soldout-panel"[^>]*class="glass panel soldout-panel hidden"|class="glass panel soldout-panel hidden"[^>]*id="soldout-panel"/);
  assert.match(scriptSrc, /import \{ escapeHtml, itemCardHTML, soldOutHint, splitItemsByStock \} from '\.\/item-sections\.mjs';/);
  assert.match(scriptSrc, /els\.soldoutPanel\.classList\.toggle\('hidden', !showSoldOut\)/);
});

test('the frontend renders the split, not one flat grid', () => {
  assert.match(scriptSrc, /const \{ inStock, soldOut \} = splitItemsByStock\(items\);/);
  assert.match(scriptSrc, /els\.itemsGrid\.innerHTML = inStock\.length/);
  assert.match(scriptSrc, /inStock\.map\(it => itemCardHTML\(it, false\)\)/);
  assert.match(scriptSrc, /soldOut\.map\(it => itemCardHTML\(it, true\)\)/);
  assert.match(scriptSrc, /soldOutHint\(soldOut\.length/);
  // Nothing sold out anywhere else may resurrect a sold-out card in the live grid.
  assert.ok(!/els\.itemsGrid\.innerHTML = items\.map/.test(scriptSrc), 'the live grid still renders every item');
});

test('sold-out styling is distinct but readable', () => {
  assert.match(cssSrc, /\.item-soldout-badge\{/);
  assert.match(cssSrc, /\.soldout-panel\{/);
  assert.match(cssSrc, /\.item-card\.soldout \.item-thumb,[\s\S]*?filter: grayscale\(1\)/);
  assert.match(cssSrc, /\.items-empty\{/);
});
