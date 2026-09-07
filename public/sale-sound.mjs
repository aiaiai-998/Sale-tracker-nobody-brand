// Original cash-register-style cha-ching, synthesized locally with Web Audio.
// No external audio downloads or Roblox credentials are needed.
export const SALE_SOUND_STORAGE_KEY = 'nobodies-brand:sale-sound';

function createChaChingBuffer(context) {
  const duration = 0.78;
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const samples = buffer.getChannelData(0);
  const clicks = [0, 0.032, 0.064];
  const bells = [
    { start: 0.075, frequency: 1568, volume: 0.5 },
    { start: 0.16, frequency: 2093, volume: 0.65 },
  ];
  // Slightly inharmonic partials make this a metallic bell rather than a beep.
  const partials = [[1, 1, 8], [1.47, 0.48, 13], [2.09, 0.22, 19], [2.56, 0.11, 26]];
  let previousNoise = 0;
  let peak = 0;

  for (let i = 0; i < samples.length; i++) {
    const t = i / context.sampleRate;
    const noise = Math.random() * 2 - 1;
    const highNoise = (noise - previousNoise) * 0.5;
    previousNoise = noise;
    let value = 0;

    // Short mechanical clicks before the rising coin/bell ring: "cha-ching".
    for (const start of clicks) {
      const age = t - start;
      if (age >= 0 && age < 0.03) {
        value += (highNoise * 0.5 + Math.sin(2 * Math.PI * 180 * age) * 0.15)
          * Math.min(1, age / 0.001) * Math.exp(-age * 150);
      }
    }
    for (const bell of bells) {
      const age = t - bell.start;
      if (age < 0) continue;
      for (const [ratio, volume, decay] of partials) {
        value += Math.sin(2 * Math.PI * bell.frequency * ratio * age)
          * volume * bell.volume * Math.min(1, age / 0.002) * Math.exp(-age * decay);
      }
    }
    value *= Math.min(1, (duration - t) / 0.04);
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  // Keep notification volume moderate and prevent clipping.
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] *= 0.34 / peak;
  return buffer;
}

// All transports share this observer. The server sends a full state AND a sale
// event for the same purchase, and later upgrades buyer names on the same ID.
export function createSaleObserver(onNewSales) {
  const seen = new Set();
  let initialized = false;

  return (state) => {
    if (!Array.isArray(state?.sales)) return;
    let count = 0;
    const sales = state.latestSale ? [...state.sales, state.latestSale] : state.sales;
    for (const sale of sales) {
      if (sale?.id == null || sale.id === '') continue;
      const id = String(sale.id);
      if (!seen.has(id)) {
        const qty = Number(sale.qty ?? 1);
        count += Number.isSafeInteger(qty) && qty > 0 ? qty : 1;
      }
      // Refresh known IDs too, so anything still in the feed stays remembered.
      seen.delete(id);
      seen.add(id);
    }
    // Bound memory for long-running OBS sessions; the public feed holds 50 IDs.
    while (seen.size > 2000) seen.delete(seen.values().next().value);

    const notify = initialized && count > 0;
    initialized = true; // The first snapshot (even an empty one) is a silent baseline.
    if (notify) onNewSales(count);
  };
}

export function createSaleSound({ environment = globalThis, onChange = () => {} } = {}) {
  const AudioContext = environment.AudioContext || environment.webkitAudioContext;
  const supported = typeof AudioContext === 'function';
  let enabled = false;
  try {
    enabled = supported && environment.localStorage?.getItem(SALE_SOUND_STORAGE_KEY) === 'true';
  } catch {} // Storage may be blocked in private browsing or an embedded overlay.

  let context = null;
  let buffer = null;
  let activeSource = null;
  let pending = 0;
  let revision = 0;
  let failed = false;

  function getState() {
    return { enabled, supported, ready: enabled && context?.state === 'running' && !failed, failed };
  }

  function report() { onChange(getState()); }

  function stop() {
    pending = 0;
    if (!activeSource) return;
    const source = activeSource;
    activeSource = null;
    source.onended = null;
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }

  function playNext() {
    if (!getState().ready || !pending || activeSource) return;
    try {
      if (!buffer) buffer = createChaChingBuffer(context);
      const source = context.createBufferSource();
      activeSource = source;
      source.buffer = buffer;
      source.connect(context.destination);
      pending--;
      source.onended = () => {
        source.disconnect();
        if (activeSource !== source) return;
        activeSource = null;
        playNext();
      };
      source.start();
    } catch {
      failed = true;
      stop();
      report();
    }
  }

  function play(count = 1) {
    // Never queue muted or autoplay-blocked sales to replay unexpectedly later.
    if (!getState().ready || !Number.isSafeInteger(count) || count <= 0) return;
    pending += count;
    playNext(); // One chime per copy, sequentially, including bulk stock entries.
  }

  async function unlock({ preview = false } = {}) {
    if (!enabled || !supported) return;
    const requestRevision = revision;
    try {
      if (!context || context.state === 'closed') {
        context = new AudioContext();
        buffer = null;
        context.onstatechange = () => {
          if (context.state !== 'running') stop();
          report();
        };
      }
      failed = false;
      // resume() must be called directly from a click/key gesture when required.
      // Don't cache its promise: an autoplay-blocked resume can remain pending.
      const resuming = context.state === 'running' ? null : context.resume();
      report();
      if (resuming) await resuming;
      if (requestRevision !== revision || !enabled) return;
      report();
      if (preview) play();
    } catch {
      if (requestRevision !== revision || !enabled) return;
      failed = true;
      stop();
      report();
    }
  }

  function setEnabled(value) {
    enabled = supported && Boolean(value);
    revision++;
    stop(); // Muting immediately stops both the current chime and queued sales.
    failed = false;
    try { environment.localStorage?.setItem(SALE_SOUND_STORAGE_KEY, String(enabled)); } catch {}
    report();
    if (enabled) return unlock({ preview: true });
  }

  report();
  if (enabled) void unlock(); // Restore the preference; UI explains if a gesture is still needed.

  return { getState, setEnabled, unlock, play, preview: () => unlock({ preview: true }) };
}
