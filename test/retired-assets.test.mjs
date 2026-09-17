// Deleted/retired UGC items must stay off the overlay: no item card, no copies
// in the header totals, and no Robux in the revenue counter.
//
// The Blue Valk (73175553972885) was deleted on Roblox. While it was still in
// the tracked list the overlay showed it as "Limited #972885" and counted its
// 3,000 copies in the 12,000 total. These tests pin the fix in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DELETED_ID = '73175553972885';
const DELETED_LABEL = '972885'; // what the overlay showed while the name was unreadable
const TRACKED_IDS = ['137910150798027', '129297459934395', '121581072690400'];
const COPIES_PER_ITEM = 3000;

const serverSrc = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const scriptSrc = readFileSync(path.join(ROOT, 'public/script.js'), 'utf8');
const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const renderYaml = readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');

function objectBody(source, name) {
  const m = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `could not find ${name} in source`);
  return m[1];
}

function assetIdLine(text, file) {
  const line = text.split('\n').find(l => /^\s*(UGC_ASSET_IDS\s*=|- key: UGC_ASSET_IDS)/.test(l) ||
    (/UGC_ASSET_IDS/.test(l) && /=/.test(l) && !l.trim().startsWith('#')));
  assert.ok(line, `could not find a UGC_ASSET_IDS setting in ${file}`);
  return line;
}

test('server lists the deleted item as retired', () => {
  const m = serverSrc.match(/const RETIRED_ASSET_IDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'RETIRED_ASSET_IDS block is missing from server.js');
  assert.ok(m[1].includes(`'${DELETED_ID}'`), 'deleted Blue Valk is not in RETIRED_ASSET_IDS');
});

test('retired ids are filtered out of the tracked list', () => {
  // The filter has to run on the env value too, otherwise a stale
  // UGC_ASSET_IDS on the deploy (Render dashboard / old .env) brings it back.
  assert.match(serverSrc, /const CONFIGURED_ASSET_IDS = \(process\.env\.UGC_ASSET_IDS/);
  assert.match(serverSrc, /const UGC_ASSET_IDS = CONFIGURED_ASSET_IDS\.filter\(id => !RETIRED_ASSET_IDS\.has\(id\)\);/);

  const fallback = serverSrc.match(/process\.env\.UGC_ASSET_IDS \|\| '([^']+)'/);
  assert.ok(fallback, 'could not find the built-in UGC_ASSET_IDS fallback');
  assert.deepEqual(fallback[1].split(','), TRACKED_IDS);
});

test('deleted item is gone from the per-asset maps', () => {
  for (const name of ['KNOWN_TOTALS', 'KNOWN_COLLECTIBLE_IDS']) {
    const body = objectBody(serverSrc, name);
    assert.ok(!body.includes(DELETED_ID), `${name} still lists the deleted asset ${DELETED_ID}`);
    const keys = [...body.matchAll(/'(\d+)':/g)].map(m => m[1]);
    assert.deepEqual(keys, TRACKED_IDS, `${name} should cover exactly the tracked assets`);
  }
});

test('tracked supply is 3 x 3000 = 9000 copies (was 12000)', () => {
  const body = objectBody(serverSrc, 'KNOWN_TOTALS');
  const totals = [...body.matchAll(/'\d+':\s*(\d+)/g)].map(m => Number(m[1]));
  assert.equal(totals.length, TRACKED_IDS.length);
  assert.ok(totals.every(t => t === COPIES_PER_ITEM), `unexpected supply values: ${totals.join(', ')}`);
  assert.equal(totals.reduce((a, b) => a + b, 0), TRACKED_IDS.length * COPIES_PER_ITEM);
});

test('transactions for untracked assets are skipped, not credited to slot 1', () => {
  // The old fallback assigned unknown sales to UGC_ASSET_IDS[0], which would
  // have put the deleted item's Robux on another item's card.
  assert.ok(!/tx\.assetId \? String\(tx\.assetId\) : UGC_ASSET_IDS\[0\]/.test(serverSrc),
    'untracked transactions are still credited to the first tracked asset');
  assert.match(serverSrc, /if \(!assetId\) \{[\s\S]*?continue;\s*\}/);
});

test('a retired asset can never enter the sales feed', () => {
  const addSale = serverSrc.match(/function addSale\(sale\) \{([\s\S]*?)\n\}/);
  assert.ok(addSale, 'could not find addSale in server.js');
  assert.match(addSale[1], /RETIRED_ASSET_IDS\.has\(String\(sale\.assetId\)\)/);
});

test('frontend board labels drop the Valk', () => {
  const body = objectBody(scriptSrc, 'BOARD_LABELS');
  assert.ok(!body.includes(DELETED_ID), 'BOARD_LABELS still maps the deleted asset');
  assert.ok(!/Valk/i.test(body), 'BOARD_LABELS still shows a Valk label');
  assert.deepEqual([...body.matchAll(/'(\d+)':/g)].map(m => m[1]), TRACKED_IDS);
});

test('frontend drops anything the server reports as retired', () => {
  assert.match(scriptSrc, /function pruneRetired\(state\) \{/);
  assert.match(scriptSrc, /retiredAssetIds/);
  assert.match(scriptSrc, /state = pruneRetired\(state\);/);
});

test('deploy config no longer tracks the deleted asset', () => {
  assert.ok(!assetIdLine(envExample, '.env.example').includes(DELETED_ID));
  // render.yaml puts the value on the line after the key
  const yamlValue = renderYaml.split('\n').find(l => l.includes(TRACKED_IDS[0]));
  assert.ok(yamlValue, 'render.yaml has no UGC_ASSET_IDS value');
  assert.ok(!yamlValue.includes(DELETED_ID), 'render.yaml still deploys the deleted asset');
  assert.deepEqual(
    yamlValue.split('value:')[1].trim().split(','),
    TRACKED_IDS,
    'render.yaml should track exactly the live assets'
  );
});

// ---------------------------------------------------------------------------
// Boot the real server with a STALE env (the deleted id still in the list, as
// an old Render/.env value would be) and check what the overlay would render.
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForState(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err; // still booting
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server on port ${port} never answered /api/state: ${lastError?.message || 'timeout'}`);
}

test('live state excludes the deleted item even with a stale UGC_ASSET_IDS', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // deliberately stale: includes the deleted Blue Valk
      UGC_ASSET_IDS: [...TRACKED_IDS, DELETED_ID].join(','),
      ROBLOX_COOKIE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  try {
    const state = await waitForState(port);

    assert.deepEqual(state.retiredAssetIds, [DELETED_ID], 'state should advertise the retired ids');
    assert.deepEqual(state.assetIds, TRACKED_IDS, 'deleted asset is still tracked');

    assert.equal(state.items.length, TRACKED_IDS.length, `expected ${TRACKED_IDS.length} item cards`);
    assert.ok(!state.items.some(i => String(i.assetId) === DELETED_ID), 'deleted item card is still served');
    assert.ok(!state.items.some(i => String(i.name).includes(DELETED_LABEL)),
      `an item is still labelled "Limited #${DELETED_LABEL}"`);

    // Whatever the header shows must be the sum of the tracked items only —
    // the deleted item's 3,000 copies can't be hiding in there.
    assert.equal(state.stats.totalCopies, state.items.reduce((s, i) => s + i.totalCopies, 0));
    assert.equal(state.stats.copiesLeft, state.items.reduce((s, i) => s + i.copiesRemaining, 0));
    if (!state.live) {
      // No successful Roblox poll yet — boot supply is the creator-confirmed 3,000 each.
      assert.equal(state.stats.totalCopies, TRACKED_IDS.length * COPIES_PER_ITEM,
        `header total should be ${TRACKED_IDS.length * COPIES_PER_ITEM}, not 12000`);
    }

    // Revenue is derived from tracked items only — a retired item contributes 0.
    const expectedNet = state.items.reduce(
      (s, i) => s + (i.copiesSold || 0) * Math.floor((Number(i.price) || 0) * 0.3), 0);
    assert.equal(state.stats.net, expectedNet);
    assert.equal(state.stats.revenue, state.stats.net);

    assert.ok(!state.sales.some(s => String(s.assetId) === DELETED_ID), 'feed still holds a deleted-item sale');
  } catch (err) {
    if (/EADDRINUSE/.test(stderr)) t.skip(`port ${port} unavailable`);
    else throw err;
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
  }
});
