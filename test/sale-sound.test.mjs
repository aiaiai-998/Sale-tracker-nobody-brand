import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaleObserver, createSaleSound, SALE_SOUND_STORAGE_KEY } from '../public/sale-sound.mjs';

const sale = (id, qty = 1) => ({ id, qty, buyerName: 'Someone' });
const snapshot = (sales = [], latestSale = sales[0] ?? null) => ({ sales, latestSale });

function audioHarness({ stored = null, initialState = 'running', resumeMode = 'resolve' } = {}) {
  const storage = new Map(stored === null ? [] : [[SALE_SOUND_STORAGE_KEY, stored]]);
  const contexts = [];
  const harness = { storage, contexts, resumeMode, failStart: false };
  class FakeAudioContext {
    constructor() {
      this.state = initialState;
      this.sampleRate = 48000;
      this.destination = {};
      this.sources = [];
      this.waiting = [];
      this.resumeCalls = 0;
      contexts.push(this);
    }
    createBuffer(channels, length, sampleRate) {
      const samples = new Float32Array(length);
      return { length, sampleRate, getChannelData: () => samples };
    }
    createBufferSource() {
      const source = {
        started: false, stopped: false, disconnected: false, onended: null,
        connect() {},
        start() {
          if (harness.failStart) throw new Error('Audio device unavailable');
          this.started = true;
        },
        stop() { this.stopped = true; },
        disconnect() { this.disconnected = true; },
        finish() { this.onended?.(); },
      };
      this.sources.push(source);
      return source;
    }
    setState(state) { this.state = state; this.onstatechange?.(); }
    resume() {
      this.resumeCalls++;
      if (harness.resumeMode === 'reject') return Promise.reject(new Error('NotAllowedError'));
      if (harness.resumeMode === 'pending') return new Promise(resolve => this.waiting.push(resolve));
      this.setState('running');
      return Promise.resolve();
    }
    allowAudio() {
      this.setState('running');
      this.waiting.splice(0).forEach(resolve => resolve());
    }
  }
  harness.environment = {
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  return harness;
}

test('first snapshot is silent, including existing history and duplicate latestSale', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  const history = snapshot([sale('old-1'), sale('old-2', 5)]);
  observe(history);
  observe(structuredClone(history));
  assert.deepEqual(counts, []);
});

test('empty baseline still notifies the very first live sale', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot());
  observe(snapshot([sale('first')]));
  assert.deepEqual(counts, [1]);
});

test('state, individual events, batch repeats, and reconnects do not double-notify', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot([sale('old')]));
  const update = snapshot([sale('new'), sale('old')]);
  observe(update);
  observe(structuredClone(update)); // individual sale event merged into the same state
  observe(structuredClone(update)); // reconnect or fallback snapshot
  observe(snapshot()); // even a temporary empty feed must not reset seen IDs
  observe(update);
  assert.deepEqual(counts, [1]);
});

test('counts every new copy in a batch, not just the latest entry', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot([sale('old')]));
  observe(snapshot([sale('bulk', 4), sale('new-2'), sale('new-1'), sale('old')]));
  assert.deepEqual(counts, [6]);
});

test('attribution, timestamps, quantity edits, and reordered known IDs stay silent', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot([sale('a'), sale('b')]));
  observe(snapshot([{ ...sale('b', 2), buyerName: 'RealBuyer', soldAt: new Date().toISOString() }, sale('a')]));
  assert.deepEqual(counts, []);
});

test('latest-only entries count once and malformed snapshots do not prime the baseline', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(null);
  observe({ sales: null });
  observe(snapshot([sale('old')]));
  observe(snapshot([sale('old')], sale('new', 2)));
  observe(snapshot([sale('new', 2), sale('old')]));
  assert.deepEqual(counts, [2]);
});

test('invalid IDs are skipped and invalid quantities safely default to one', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot());
  observe(snapshot([null, {}, sale(''), sale('a', -2), sale('b', '3'), sale('c', Infinity)]));
  assert.deepEqual(counts, [5]);
});

test('long sessions retain IDs still in the feed while bounding old history', () => {
  const counts = [];
  const observe = createSaleObserver(count => counts.push(count));
  observe(snapshot([sale('persistent')]));
  for (let i = 0; i < 2100; i++) observe(snapshot([sale(String(i)), sale('persistent')]));
  observe(snapshot([sale('persistent')]));
  assert.equal(counts.length, 2100);
  assert.ok(counts.every(count => count === 1));
});

test('sound is opt-in and creates no AudioContext while off', async () => {
  const harness = audioHarness();
  const sound = createSaleSound(harness);
  sound.play(3);
  await sound.preview();
  assert.deepEqual(sound.getState(), { enabled: false, supported: true, ready: false, failed: false });
  assert.equal(harness.contexts.length, 0);
});

test('enabling saves the setting and previews a reusable, finite, unclipped chime', async () => {
  const harness = audioHarness();
  const sound = createSaleSound(harness);
  await sound.setEnabled(true);
  const context = harness.contexts[0];
  const source = context.sources[0];
  assert.equal(sound.getState().ready, true);
  assert.equal(harness.storage.get(SALE_SOUND_STORAGE_KEY), 'true');
  assert.equal(source.started, true);
  const samples = source.buffer.getChannelData(0);
  assert.ok(samples.every(Number.isFinite));
  assert.ok(samples.some(sample => Math.abs(sample) > 0.3));
  assert.ok(samples.every(sample => Math.abs(sample) < 0.341));
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples.at(-1)) < 0.0001);
  source.finish();
  await sound.preview();
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[1].buffer, source.buffer);
});

test('batched sales play sequentially without overlapping sources', async () => {
  const harness = audioHarness({ stored: 'true' });
  const sound = createSaleSound(harness);
  const context = harness.contexts[0];
  assert.equal(context.sources.length, 0); // restoring On is not a preview
  sound.play(3);
  assert.equal(context.sources.length, 1);
  context.sources[0].finish();
  assert.equal(context.sources.length, 2);
  context.sources[1].finish();
  assert.equal(context.sources.length, 3);
  context.sources[2].finish();
  assert.equal(context.sources.length, 3);
  assert.ok(context.sources.every(source => source.disconnected));
});

test('muting immediately stops active and queued audio; muted sales never replay', async () => {
  const harness = audioHarness({ stored: 'true' });
  const sound = createSaleSound(harness);
  const observe = createSaleObserver(count => sound.play(count));
  const context = harness.contexts[0];
  observe(snapshot());
  observe(snapshot([sale('batch', 4)]));
  sound.setEnabled(false);
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[0].disconnected, true);
  assert.equal(context.sources[0].onended, null);
  assert.equal(harness.storage.get(SALE_SOUND_STORAGE_KEY), 'false');
  observe(snapshot([sale('muted'), sale('batch', 4)]));
  await sound.setEnabled(true);
  assert.equal(context.sources.length, 2); // only the enable preview
  context.sources[1].finish();
  observe(snapshot([sale('muted'), sale('batch', 4)]));
  assert.equal(context.sources.length, 2);
  observe(snapshot([sale('fresh'), sale('muted'), sale('batch', 4)]));
  assert.equal(context.sources.length, 3);
});

test('both On and Off preferences survive a new controller', async () => {
  const harness = audioHarness();
  const first = createSaleSound(harness);
  await first.setEnabled(true);
  const restored = createSaleSound(harness);
  assert.equal(restored.getState().enabled, true);
  assert.equal(harness.contexts[1].sources.length, 0);
  restored.setEnabled(false);
  const muted = createSaleSound(harness);
  assert.equal(muted.getState().enabled, false);
  assert.equal(harness.contexts.length, 2);
});

test('autoplay-blocked audio stays visibly unready and does not retain missed sales', async () => {
  const harness = audioHarness({ stored: 'true', initialState: 'suspended', resumeMode: 'pending' });
  const states = [];
  const sound = createSaleSound({ ...harness, onChange: state => states.push(state) });
  const context = harness.contexts[0];
  assert.equal(sound.getState().enabled, true);
  assert.equal(sound.getState().ready, false);
  sound.play(4);
  assert.equal(context.sources.length, 0);
  const activation = sound.unlock(); // a later user gesture retries resume
  assert.equal(context.resumeCalls, 2);
  context.allowAudio();
  await activation;
  assert.equal(sound.getState().ready, true);
  assert.ok(states.some(state => state.enabled && !state.ready));
  assert.equal(context.sources.length, 0);
  sound.play();
  assert.equal(context.sources.length, 1);
});

test('pending enable previews cannot play after muting or rapid Off/On toggles', async () => {
  const harness = audioHarness({ initialState: 'suspended', resumeMode: 'pending' });
  const sound = createSaleSound(harness);
  const firstEnable = sound.setEnabled(true);
  const context = harness.contexts[0];
  sound.setEnabled(false);
  const secondEnable = sound.setEnabled(true);
  context.allowAudio();
  await Promise.all([firstEnable, secondEnable]);
  assert.equal(context.sources.length, 1);

  const mutedHarness = audioHarness({ initialState: 'suspended', resumeMode: 'pending' });
  const mutedSound = createSaleSound(mutedHarness);
  const pending = mutedSound.setEnabled(true);
  mutedSound.setEnabled(false);
  mutedHarness.contexts[0].allowAudio();
  await pending;
  assert.equal(mutedHarness.contexts[0].sources.length, 0);
});

test('resume failures are handled and Test sound can retry successfully', async () => {
  const harness = audioHarness({ initialState: 'suspended', resumeMode: 'reject' });
  const sound = createSaleSound(harness);
  await sound.setEnabled(true);
  assert.equal(sound.getState().failed, true);
  assert.equal(sound.getState().ready, false);
  harness.resumeMode = 'resolve';
  await sound.preview();
  assert.equal(sound.getState().failed, false);
  assert.equal(sound.getState().ready, true);
  assert.equal(harness.contexts[0].sources.length, 1);
});

test('audio interruptions discard queued chimes instead of replaying stale alerts', async () => {
  const harness = audioHarness({ stored: 'true' });
  const sound = createSaleSound(harness);
  const context = harness.contexts[0];
  sound.play(5);
  context.setState('suspended');
  assert.equal(context.sources[0].stopped, true);
  assert.equal(sound.getState().ready, false);
  await sound.unlock();
  assert.equal(context.sources.length, 1);
  sound.play();
  assert.equal(context.sources.length, 2);
});

test('denied localStorage does not stop the toggle or playback', async () => {
  const harness = audioHarness();
  Object.defineProperty(harness.environment, 'localStorage', {
    get() { throw new Error('SecurityError'); },
  });
  const sound = createSaleSound(harness);
  await sound.setEnabled(true);
  assert.equal(sound.getState().ready, true);
  sound.setEnabled(false);
  assert.equal(sound.getState().enabled, false);
});

test('unavailable Web Audio degrades gracefully, and the webkit alias is supported', async () => {
  const unsupported = createSaleSound({ environment: {} });
  await unsupported.setEnabled(true);
  await unsupported.preview();
  assert.equal(unsupported.getState().supported, false);
  assert.equal(unsupported.getState().enabled, false);
  const harness = audioHarness();
  harness.environment.webkitAudioContext = harness.environment.AudioContext;
  delete harness.environment.AudioContext;
  const sound = createSaleSound(harness);
  await sound.setEnabled(true);
  assert.equal(sound.getState().ready, true);
});

test('AudioContext creation and source playback errors never escape into the feed', async () => {
  const unavailable = createSaleSound({ environment: { AudioContext: class {
    constructor() { throw new Error('No audio device'); }
  } } });
  await unavailable.setEnabled(true);
  assert.equal(unavailable.getState().failed, true);

  const harness = audioHarness({ stored: 'true' });
  const sound = createSaleSound(harness);
  harness.failStart = true;
  sound.play(4);
  assert.equal(sound.getState().failed, true);
  assert.equal(harness.contexts[0].sources[0].disconnected, true);
  harness.failStart = false;
  await sound.preview();
  assert.equal(sound.getState().ready, true);
  assert.equal(harness.contexts[0].sources.length, 2);
  harness.contexts[0].sources[1].finish();
  assert.equal(harness.contexts[0].sources.length, 2); // failed queue was cleared
});
