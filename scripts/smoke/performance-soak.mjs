#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const DEFAULT_BROWSER_SECONDS = Number(process.env.CLAUDEVILLE_BROWSER_SOAK_SECONDS) || 600;
const DEFAULT_SERVER_SECONDS = Number(process.env.CLAUDEVILLE_SERVER_SOAK_SECONDS) || 1800;
const DEFAULT_INTERVAL_SECONDS = Number(process.env.CLAUDEVILLE_SOAK_INTERVAL_SECONDS) || 60;
const DEFAULT_WARMUP_SECONDS = Number(process.env.CLAUDEVILLE_SOAK_WARMUP_SECONDS) || 120;
const MAX_HEAP_PLATEAU_BYTES = 8 * 1024 * 1024;
const MAX_SERVER_RSS_PLATEAU_BYTES = 64 * 1024 * 1024;
const MAX_STEADY_GIT_COMMANDS_PER_SECOND = 2.5;
const MAX_EVENT_LOOP_P95_MS = 250;
const MAX_VOLATILE_CANVAS_PIXELS = 32 * 1024 * 1024;
const MAX_RETAINED_ASSET_DRIFT_PIXELS = 256 * 256;

// The reconnect probe measures that the server can still complete a WebSocket
// handshake and deliver an `init` snapshot after a long run. It is NOT a
// latency benchmark, and its original hard 5 s deadline was below the real cost
// of a cold provider scan: an A/B against v0.35.0.1 on a populated HOME
// measured cold `init` at 14.5 s and 8.4 s while the warm path returned in
// ~102 ms. A single cold scan therefore failed the whole release gate for a
// pre-existing reason. Each attempt now gets a generous deadline, a bounded
// number of retries absorbs one cold scan, and the meaningful ceiling is
// applied to post-warmup latency so a genuine regression still fails.
const DEFAULT_WS_PROBE_TIMEOUT_SECONDS = Number(process.env.CLAUDEVILLE_SOAK_WS_TIMEOUT_SECONDS) || 20;
const DEFAULT_WS_PROBE_ATTEMPTS = Number(process.env.CLAUDEVILLE_SOAK_WS_ATTEMPTS) || 3;
const DEFAULT_WS_PROBE_RETRY_DELAY_MS = 750;
// Post-warmup steady-state ceiling. Warm inits are milliseconds; this leaves
// generous headroom for provider churn while still catching a server that has
// degraded into multi-second snapshots.
const MAX_STEADY_WS_INIT_MS = Number(process.env.CLAUDEVILLE_SOAK_WS_STEADY_CEILING_MS) || 8000;

function usage() {
  console.log(`Usage: node scripts/smoke/performance-soak.mjs [options]

Options:
  --url=<url>               ClaudeVille URL (default: ${DEFAULT_URL})
  --browser-seconds=<n>     Active World duration (default: ${DEFAULT_BROWSER_SECONDS})
  --server-seconds=<n>      Server/reconnect duration (default: ${DEFAULT_SERVER_SECONDS})
  --interval-seconds=<n>    Checkpoint interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --warmup-seconds=<n>      Ignore startup samples in slope gates (default: ${DEFAULT_WARMUP_SECONDS})
  --ws-timeout-seconds=<n>  Per-attempt reconnect probe deadline (default: ${DEFAULT_WS_PROBE_TIMEOUT_SECONDS})
  --ws-attempts=<n>         Reconnect probe attempts before failing (default: ${DEFAULT_WS_PROBE_ATTEMPTS})
  --headed                  Show the Chromium window
  --listener-counter-check  Verify native listener accounting; no server or soak
  --rss-gate-check          Verify RSS plateau and growth controls; no server or soak
  --help                    Print this help

The default run is the release-gate 10-minute World and 30-minute server soak.
Provider append/rotation behavior is covered by watcher-runtime.mjs; this script
does not mutate live provider data.`);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL.replace(/\/+$/, ''),
    browserSeconds: DEFAULT_BROWSER_SECONDS,
    serverSeconds: DEFAULT_SERVER_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    warmupSeconds: DEFAULT_WARMUP_SECONDS,
    wsTimeoutSeconds: DEFAULT_WS_PROBE_TIMEOUT_SECONDS,
    wsAttempts: DEFAULT_WS_PROBE_ATTEMPTS,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      options.headed = true;
      continue;
    }
    const [flag, inlineValue] = arg.split('=', 2);
    if (!['--url', '--browser-seconds', '--server-seconds', '--interval-seconds', '--warmup-seconds', '--ws-timeout-seconds', '--ws-attempts'].includes(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    if (flag === '--url') options.url = value.replace(/\/+$/, '');
    if (flag === '--browser-seconds') options.browserSeconds = Number(value);
    if (flag === '--server-seconds') options.serverSeconds = Number(value);
    if (flag === '--interval-seconds') options.intervalSeconds = Number(value);
    if (flag === '--warmup-seconds') options.warmupSeconds = Number(value);
    if (flag === '--ws-timeout-seconds') options.wsTimeoutSeconds = Number(value);
    if (flag === '--ws-attempts') options.wsAttempts = Number(value);
  }
  for (const [name, value] of [
    ['browser seconds', options.browserSeconds],
    ['server seconds', options.serverSeconds],
    ['interval seconds', options.intervalSeconds],
    ['ws timeout seconds', options.wsTimeoutSeconds],
    ['ws attempts', options.wsAttempts],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  if (!Number.isFinite(options.warmupSeconds) || options.warmupSeconds < 0) {
    throw new Error('warmup seconds must be non-negative');
  }
  for (const [name, duration] of [
    ['browser', options.browserSeconds],
    ['server', options.serverSeconds],
  ]) {
    const steadyCheckpoints = options.warmupSeconds > duration
      ? 0
      : Math.floor((duration - options.warmupSeconds) / options.intervalSeconds) + 1;
    if (steadyCheckpoints < 3) {
      throw new Error(
        `${name} soak needs at least 3 post-warmup checkpoints; `
        + `increase --${name}-seconds, reduce --warmup-seconds, or reduce --interval-seconds`,
      );
    }
  }
  return options;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retainedListenerCount(cdp) {
  // Chromium accounts for once/AbortSignal cleanup and collected targets.
  // Registration-minus-explicit-removal monkeypatches count dead listeners.
  return (await cdp.send('Memory.getDOMCounters')).jsEventListeners;
}

async function quiescentListenerCount(page, cdp) {
  let floor = Infinity;
  // A pending IndexedDB request is live even after GC. Barrier all Chronicle
  // stores before each bounded sample; the floor discounts writes that start
  // between that barrier and the native counter without discounting retained
  // UI listeners, which remain present in every sample.
  for (let sample = 0; sample < 3; sample++) {
    await page.evaluate(async () => {
      const databases = new Set([
        window.__claudeVilleApp?.chronicleStore?.db,
        window.__chronicle?.db,
      ].filter(Boolean));
      await Promise.all([...databases].map(db => new Promise((resolve, reject) => {
        const names = [...db.objectStoreNames];
        if (!names.length) { resolve(); return; }
        const tx = db.transaction(names, 'readonly');
        const finish = error => {
          clearTimeout(timer);
          tx.oncomplete = tx.onabort = tx.onerror = null;
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => {
          finish(new Error('Chronicle listener barrier timed out'));
          try { tx.abort(); } catch { /* already settled */ }
        }, 5000);
        tx.oncomplete = () => finish();
        tx.onabort = tx.onerror = () => finish(tx.error || new Error('Chronicle listener barrier failed'));
        for (const name of names) tx.objectStore(name).count();
      })));
    });
    await cdp.send('HeapProfiler.collectGarbage');
    floor = Math.min(floor, await retainedListenerCount(cdp));
  }
  return floor;
}

async function checkListenerCounter() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const cdp = await page.context().newCDPSession(page);
    const count = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return retainedListenerCount(cdp);
    };
    const baseline = await count();
    await page.evaluate(() => {
      // Retain this target so the once/abort checks cannot pass merely because
      // its entire listener owner was collected.
      const target = window.listenerProbeTarget = new EventTarget();
      target.addEventListener('once', () => {}, { once: true });
      target.dispatchEvent(new Event('once'));
      const controller = new AbortController();
      target.addEventListener('aborted', () => {}, { signal: controller.signal });
      controller.abort();
      target.addEventListener('already-aborted', () => {}, { signal: controller.signal });
      for (let index = 0; index < 20; index++) {
        const button = document.createElement('button');
        button.addEventListener('click', () => {});
        document.body.append(button);
        button.remove();
      }
    });
    assert.equal(await count(), baseline, 'expired listeners must not survive forced GC');
    await page.evaluate(() => {
      window.retainedListener = () => {};
      window.addEventListener('retained-probe', window.retainedListener);
    });
    assert.equal(await count(), baseline + 1, 'a retained listener must be counted');
    await page.evaluate(() => {
      window.removeEventListener('retained-probe', window.retainedListener);
      delete window.retainedListener;
      delete window.listenerProbeTarget;
    });
    assert.equal(await count(), baseline, 'explicit removal must restore the baseline');
    const root = 'http://listener-probe.local';
    for (const path of ['src/infrastructure/ChronicleStore.js', 'src/domain/events/DomainEvent.js']) {
      const body = await readFile(new URL(`../../claudeville/${path}`, import.meta.url), 'utf8');
      await page.route(`${root}/${path}`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.route(`${root}/`, route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await page.goto(`${root}/`);
    await page.evaluate(async () => {
      const { ChronicleStore } = await import('/src/infrastructure/ChronicleStore.js');
      const store = new ChronicleStore({ dbName: 'listener-counter-regression' });
      await store.open();
      window.__claudeVilleApp = { chronicleStore: store };
    });
    const settled = await quiescentListenerCount(page, cdp);
    await page.evaluate(() => {
      const store = window.__claudeVilleApp.chronicleStore;
      const tx = store.db.transaction('meta', 'readwrite');
      window.keepProbeAlive = true;
      const pump = () => {
        const request = tx.objectStore('meta').get('probe');
        request.onsuccess = () => { if (window.keepProbeAlive) pump(); };
      };
      pump();
      window.probeWrites = Promise.all(Array.from({ length: 4 }, (_, index) =>
        store.put('meta', { key: `probe${index}`, value: index })));
      window.retainedListener = () => {};
      window.addEventListener('retained-probe', window.retainedListener);
    });
    assert.ok(await count() > settled + 1, 'pending IDB work must exercise the transient listener case');
    await page.evaluate(() => { window.keepProbeAlive = false; });
    assert.equal(await quiescentListenerCount(page, cdp), settled + 1,
      'the barrier must drain real writes while preserving a retained listener');
    await page.evaluate(async () => {
      await window.probeWrites;
      delete window.probeWrites;
      window.removeEventListener('retained-probe', window.retainedListener);
      delete window.retainedListener;
    });
    assert.equal(await quiescentListenerCount(page, cdp), settled);
    console.log('[performance-soak] native listener counter check passed');
  } finally {
    await browser.close();
  }
}

async function measureFrames(page, frameCount = 45) {
  return page.evaluate(async count => {
    const deltas = await new Promise(resolve => {
      const values = [];
      let previous = performance.now();
      const tick = now => {
        values.push(now - previous);
        previous = now;
        if (values.length >= count + 1) resolve(values.slice(1));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((a, b) => a - b);
    const percentile = value => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * value))];
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return {
      samples: deltas.length,
      meanMs: Math.round(mean * 100) / 100,
      p50Ms: Math.round(percentile(0.5) * 100) / 100,
      p95Ms: Math.round(percentile(0.95) * 100) / 100,
      maxMs: Math.round(deltas[deltas.length - 1] * 100) / 100,
      fps: Math.round(1000 / mean),
    };
  }, frameCount);
}

async function sampleBrowser(page, cdp, elapsedSeconds) {
  const listeners = await quiescentListenerCount(page, cdp);
  await sleep(50);
  const frame = await measureFrames(page);
  const snapshot = await page.evaluate(async () => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const budget = window.__claudeVillePerf?.canvasBudget?.() || null;
    const app = window.__claudeVilleApp;
    const trailSamples = app?.renderer?.trailRenderer?.samplesByAgent;
    const maxPerAgentSamples = trailSamples instanceof Map
      ? Math.max(0, ...Array.from(trailSamples.values(), samples => samples?.length || 0))
      : null;
    return {
      heapUsed: performance.memory?.usedJSHeapSize ?? null,
      eventBusListeners: [...eventBus.listeners.values()]
        .reduce((sum, callbacks) => sum + callbacks.size, 0),
      agents: app?.world?.agents?.size ?? null,
      cards: document.querySelectorAll('.dash-card').length,
      avatarCanvases: document.querySelectorAll('.dash-card canvas, .activity-panel canvas').length,
      canvasElements: document.querySelectorAll('canvas').length,
      budget,
      maxPerAgentSamples,
    };
  });
  const runtime = snapshot.budget?.runtime || {};
  return {
    elapsedSeconds,
    heapUsed: snapshot.heapUsed,
    listeners,
    eventBusListeners: snapshot.eventBusListeners,
    agents: snapshot.agents,
    cards: snapshot.cards,
    avatarCanvases: snapshot.avatarCanvases,
    canvasElements: snapshot.canvasElements,
    frame,
    canvas: {
      visiblePixels: snapshot.budget?.visibleCanvasPixels ?? null,
      volatilePixels: snapshot.budget?.volatilePixels ?? null,
      retainedAssetPixels: snapshot.budget?.retainedAssetPixels ?? null,
    },
    boundedState: runtime.boundedState || null,
    harbor: runtime.harbor || null,
    trails: runtime.trails ? {
      ...runtime.trails,
      maxPerAgentSamples: snapshot.maxPerAgentSamples,
    } : null,
    events: runtime.events || null,
    landmarks: runtime.landmarks || null,
    visits: runtime.visits || null,
    pathfinder: runtime.pathfinder || null,
    frameFailures: runtime.frameFailures || null,
  };
}

function openWebSocketProbeOnce(page, url, timeoutMs) {
  return page.evaluate(({ probeUrl, probeTimeoutMs }) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new WebSocket(new URL('/ws', probeUrl).toString().replace(/^http/, 'ws'));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`WebSocket reconnect probe timed out after ${probeTimeoutMs} ms`)),
      probeTimeoutMs,
    );
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', deltas: true }));
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'init') {
          finish(null, { sessions: message.sessions?.length ?? 0, initMs: Date.now() - startedAt });
        }
      } catch (error) {
        finish(error);
      }
    };
    socket.onerror = () => finish(new Error('WebSocket reconnect probe failed'));
  }), { probeUrl: url, probeTimeoutMs: timeoutMs });
}

/**
 * Probe with bounded retries so one cold provider scan cannot fail the gate.
 * Returns the observed latency and attempt count so the run reports why it was
 * slow instead of only that it exceeded a deadline.
 */
async function openWebSocketProbe(page, url, { timeoutMs, attempts, retryDelayMs = DEFAULT_WS_PROBE_RETRY_DELAY_MS } = {}) {
  const deadlineMs = timeoutMs ?? DEFAULT_WS_PROBE_TIMEOUT_SECONDS * 1000;
  const maxAttempts = Math.max(1, attempts ?? DEFAULT_WS_PROBE_ATTEMPTS);
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await openWebSocketProbeOnce(page, url, deadlineMs);
      return { ...result, attempts: attempt, failures };
    } catch (error) {
      failures.push(error?.message || String(error));
      if (attempt === maxAttempts) {
        throw new Error(
          `WebSocket reconnect probe exhausted ${maxAttempts} attempts at ${deadlineMs} ms each: ${failures.join('; ')}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error('unreachable');
}

async function sampleServer(probePage, url, elapsedSeconds, probeOptions = {}) {
  const probe = await openWebSocketProbe(probePage, url, probeOptions);
  const response = await fetch(`${url}/api/perf`);
  if (!response.ok) throw new Error(`/api/perf returned HTTP ${response.status}`);
  const perf = await response.json();
  return {
    elapsedSeconds,
    reconnectSessions: probe.sessions,
    wsInitMs: probe.initMs,
    wsAttempts: probe.attempts,
    wsRetryReasons: probe.failures,
    websocketClients: perf.websocketClients,
    runtime: perf.runtime,
    watchers: perf.watchers,
    caches: perf.caches,
    providers: perf.providers,
    tailCache: perf.tailCache,
    tailRate: perf.tailRate,
    gitRate: perf.gitRate,
    gitCommandCount: perf.gitEnrichment?.gitCommandCount ?? null,
    gitCommandTimeMs: perf.gitEnrichment?.gitCommandTimeMs ?? null,
    dirtyMarks: perf.dirty?.marks ?? null,
    dirtyMarksCoalesced: perf.dirty?.coalesced ?? null,
    lastBroadcast: perf.lastBroadcast,
  };
}

async function checkpointWorldSuspendResume(page) {
  const before = await page.evaluate(() => window.__claudeVillePerf?.canvasBudget?.() || null);
  await page.evaluate(() => document.getElementById('btnModeDashboard')?.click());
  await page.waitForFunction(() => {
    const budget = window.__claudeVillePerf?.canvasBudget?.();
    const assets = budget?.cacheStats?.assets;
    return window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'dashboard'
      && budget?.worldResourcesSuspended === true
      && budget.visibleCanvasPixels === 0
      && assets?.suspended === true
      && assets.bitmaps === 0
      && assets.masks === 0
      && assets.outlines === 0
      && budget?.cacheStats?.compositor?.pixels === 0;
  });
  const suspended = await page.evaluate(() => window.__claudeVillePerf?.canvasBudget?.() || null);
  await page.evaluate(() => document.getElementById('btnModeCharacter')?.click());
  await page.waitForFunction(() => {
    const budget = window.__claudeVillePerf?.canvasBudget?.();
    const assets = budget?.cacheStats?.assets;
    return window.__claudeVilleApp?.modeManager?.getCurrentMode?.() === 'character'
      && budget?.worldResourcesSuspended === false
      && budget.visibleCanvasPixels > 0
      && assets?.decodedLoaded === true
      && assets.suspended === false
      && assets.bitmaps > 0;
  });
  const resumed = await page.evaluate(() => window.__claudeVillePerf?.canvasBudget?.() || null);
  assert.ok(before?.visibleCanvasPixels > 0, 'World checkpoint started without a canvas backing store');
  assert.equal(suspended?.visibleCanvasPixels, 0, 'Dashboard did not release the World canvas backing store');
  assert.equal(suspended?.worldResourcesSuspended, true, 'Dashboard did not suspend World resources');
  assert.equal(suspended?.cacheStats?.assets?.bitmapPixels, 0, 'Dashboard retained decoded World bitmaps');
  assert.equal(suspended?.cacheStats?.assets?.maskBytes, 0, 'Dashboard retained World hit masks');
  assert.equal(suspended?.cacheStats?.assets?.outlinePixels, 0, 'Dashboard retained World outlines');
  assert.equal(suspended?.cacheStats?.compositor?.pixels, 0, 'Dashboard retained composited agent sheets');
  assert.ok(resumed?.visibleCanvasPixels > 0, 'World canvas backing store was not restored');
  assert.equal(resumed?.worldResourcesSuspended, false, 'World resources stayed suspended after resume');
  assert.equal(resumed?.cacheStats?.assets?.decodedLoaded, true, 'World resumed before assets decoded');
  return {
    beforePixels: before.visibleCanvasPixels,
    suspendedPixels: suspended.visibleCanvasPixels,
    resumedPixels: resumed.visibleCanvasPixels,
    suspendedAssetPixels: suspended.cacheStats.assets.bitmapPixels,
    resumedAssetPixels: resumed.cacheStats.assets.bitmapPixels,
    suspendedCompositorPixels: suspended.cacheStats.compositor.pixels,
    resumedCompositorPixels: resumed.cacheStats.compositor.pixels,
  };
}

function assertBrowserBounds(sample) {
  const state = sample.boundedState || {};
  assert.ok(state.lightFadeColors <= state.lightFadeColorLimit, 'light fade cache exceeded its cap');
  assert.ok(state.crowdBumpCooldowns <= state.crowdBumpCooldownLimit, 'crowd cooldowns exceeded their cap');
  const harbor = sample.harbor || {};
  for (const [countKey, limitKey] of [
    ['seenEventIds', 'maxSeenEventIds'],
    ['pushEvents', 'maxPushEvents'],
    ['ships', 'maxShips'],
    ['batches', 'maxBatches'],
    ['repoQuays', 'maxRepoQuays'],
    ['eventTombstones', 'maxEventTombstones'],
    ['commitReplayFloors', 'maxCommitReplayFloors'],
    ['overflowDockCounts', 'maxOverflowDockCounts'],
    ['repoFirstSeen', 'maxRepoFirstSeen'],
  ]) {
    assert.ok(harbor[countKey] <= harbor[limitKey], `Harbor ${countKey} exceeded ${limitKey}`);
  }
  assert.ok(sample.events?.emittedToolKeys <= sample.events?.maxEmittedToolKeysTotal,
    'tool-event keys exceeded their cap');
  assert.ok(sample.pathfinder?.cacheEntries <= sample.pathfinder?.cacheLimit,
    'pathfinder cache exceeded its cap');
  assert.equal(sample.frameFailures?.paused, false, 'World frame loop paused after repeated failures');
  assert.ok(Number.isFinite(sample.canvas?.volatilePixels), 'volatile canvas diagnostics are missing');
  assert.ok(Number.isFinite(sample.canvas?.visiblePixels), 'visible canvas diagnostics are missing');
  assert.ok(Number.isFinite(sample.canvas?.retainedAssetPixels), 'retained asset diagnostics are missing');
  assert.ok(sample.canvas.volatilePixels <= MAX_VOLATILE_CANVAS_PIXELS,
    `volatile canvas pixels were ${sample.canvas.volatilePixels}`);
  const trails = sample.trails;
  assert.ok(trails, 'trail diagnostics are missing');
  assert.ok(trails.totalSamples <= trails.globalLimit,
    `trail samples were ${trails.totalSamples} (limit ${trails.globalLimit})`);
  assert.ok(Number.isFinite(trails.maxPerAgentSamples), 'per-agent trail diagnostics are missing');
  assert.ok(trails.maxPerAgentSamples <= trails.perAgentLimit,
    `per-agent trail samples were ${trails.maxPerAgentSamples} (limit ${trails.perAgentLimit})`);
  assert.ok(trails.pendingSamples <= trails.pendingLimit,
    `pending trail samples were ${trails.pendingSamples} (limit ${trails.pendingLimit})`);
  for (const field of [
    'hydratedSamples',
    'duplicateDrops',
    'repaintCount',
    'repaintTimeMs',
    'highWaterSamples',
    'highWaterCachePixels',
  ]) {
    assert.ok(Number.isFinite(trails[field]), `trail ${field} diagnostics are missing`);
  }
}

function samplesAfterWarmup(samples, warmupSeconds) {
  const steady = samples.filter(sample => Number(sample.elapsedSeconds) >= warmupSeconds);
  assert.ok(steady.length >= 3, `soak produced only ${steady.length} post-warmup checkpoints`);
  return steady;
}

function linearSlope(samples, valueFor) {
  if (samples.length < 2) return 0;
  const points = samples
    .map(sample => ({ x: Number(sample.elapsedSeconds), y: Number(valueFor(sample)) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function assertRollingSlope(samples, valueFor, maxGrowthBytes, label) {
  const valid = samples.filter(sample => Number.isFinite(valueFor(sample)));
  assert.ok(valid.length >= 3, `${label} needs at least 3 numeric checkpoints`);
  const trailingCount = Math.max(3, Math.ceil(valid.length / 2));
  const windows = [
    { name: 'steady', values: valid },
    { name: 'trailing', values: valid.slice(-trailingCount) },
  ];
  const results = {};
  for (const window of windows) {
    const slopeBytesPerSecond = linearSlope(window.values, valueFor);
    const spanSeconds = Math.max(
      0,
      Number(window.values.at(-1).elapsedSeconds) - Number(window.values[0].elapsedSeconds),
    );
    const projectedGrowthBytes = Math.max(0, slopeBytesPerSecond * spanSeconds);
    assert.ok(
      projectedGrowthBytes <= maxGrowthBytes,
      `${label} ${window.name} slope projects ${Math.round(projectedGrowthBytes)} bytes of growth `
      + `(limit ${maxGrowthBytes})`,
    );
    results[window.name] = {
      bytesPerMinute: Math.round(slopeBytesPerSecond * 60),
      projectedGrowthBytes: Math.round(projectedGrowthBytes),
      windowSeconds: Math.round(spanSeconds * 10) / 10,
    };
  }
  return results;
}

function assertBrowserPlateau(samples, warmupSeconds) {
  assert.ok(samples.length >= 3, 'browser soak needs at least 3 checkpoints');
  const steady = samplesAfterWarmup(samples, warmupSeconds);
  const baseline = steady[0];
  const final = steady.at(-1);
  assert.equal(final.listeners, baseline.listeners, 'DOM listener count changed during World soak');
  assert.equal(final.eventBusListeners, baseline.eventBusListeners,
    'event-bus listener count changed during World soak');
  assert.equal(final.canvasElements, baseline.canvasElements, 'canvas element count changed during World soak');
  assert.equal(final.cards, baseline.cards, 'dashboard cards appeared during World soak');
  assert.equal(final.avatarCanvases, baseline.avatarCanvases, 'avatar canvases appeared during World soak');
  assert.equal(final.canvas.visiblePixels, baseline.canvas.visiblePixels,
    'visible canvas backing pixels changed during World soak');
  assert.ok(
    Math.abs(final.canvas.retainedAssetPixels - baseline.canvas.retainedAssetPixels)
      <= MAX_RETAINED_ASSET_DRIFT_PIXELS,
    `retained asset pixels drifted by more than ${MAX_RETAINED_ASSET_DRIFT_PIXELS}`,
  );
  const heapSamples = steady.map(sample => sample.heapUsed).filter(Number.isFinite);
  if (heapSamples.length >= 3) {
    const secondHalf = heapSamples.slice(Math.floor(heapSamples.length / 2));
    const floor = Math.min(...secondHalf);
    assert.ok(heapSamples.at(-1) - floor <= MAX_HEAP_PLATEAU_BYTES,
      `forced-GC heap did not plateau within ${MAX_HEAP_PLATEAU_BYTES} bytes`);
  }
  return assertRollingSlope(steady, sample => sample.heapUsed, MAX_HEAP_PLATEAU_BYTES, 'forced-GC heap');
}

export function assertServerPlateau(samples, warmupSeconds) {
  assert.ok(samples.length >= 3, 'server soak needs at least 3 checkpoints');
  const steady = samplesAfterWarmup(samples, warmupSeconds);
  const rssSamples = steady
    .map(sample => sample.runtime?.memory?.rss)
    .filter(Number.isFinite);
  if (rssSamples.length >= 3) {
    const secondHalf = rssSamples.slice(Math.floor(rssSamples.length / 2));
    // RSS is not forced-GC heap: one capacity-shrink trough must not turn an
    // ordinary rebound into a leak. Keep the same allowance and both slopes.
    const sorted = secondHalf.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    assert.ok(rssSamples.at(-1) - median <= MAX_SERVER_RSS_PLATEAU_BYTES,
      `server RSS exceeded its second-half median by more than ${MAX_SERVER_RSS_PLATEAU_BYTES} bytes`);
  }

  // The reconnect probe's meaningful gate: a cold provider scan may be slow
  // once (absorbed by the retries), but the steady state must not sit in
  // multi-second snapshots. Reported rather than merely asserted so a slow run
  // says how slow it was.
  const steadyInit = steady.map(sample => sample.wsInitMs).filter(Number.isFinite);
  if (steadyInit.length) {
    const worst = Math.max(...steadyInit);
    assert.ok(worst <= MAX_STEADY_WS_INIT_MS,
      `steady-state WebSocket init peaked at ${worst} ms (ceiling ${MAX_STEADY_WS_INIT_MS} ms); samples: ${steadyInit.join(', ')}`);
  }
  const retried = samples.filter(sample => (sample.wsAttempts ?? 1) > 1);
  if (retried.length) {
    console.log(`[performance-soak] reconnect probe retried on ${retried.length}/${samples.length} checkpoints: `
      + retried.map(s => `${s.elapsedSeconds}s x${s.wsAttempts}`).join(', '));
  }

  for (const sample of samples) {
    const p95 = sample.runtime?.eventLoop?.delayMs?.p95;
    assert.ok(Number.isFinite(sample.runtime?.memory?.rss), 'server RSS diagnostics are missing');
    assert.ok(Number.isFinite(p95), 'event-loop p95 diagnostics are missing');
    assert.ok(p95 <= MAX_EVENT_LOOP_P95_MS,
      `event-loop p95 was ${p95} ms at ${sample.elapsedSeconds}s`);
    const tailCache = sample.tailCache;
    assert.ok(Number.isFinite(tailCache?.estimatedBytes) && Number.isFinite(tailCache?.byteLimit),
      'tail-cache diagnostics are missing');
    assert.ok(tailCache.estimatedBytes <= tailCache.byteLimit,
      `tail cache used ${tailCache.estimatedBytes} bytes (limit ${tailCache.byteLimit})`);
    const orphanScan = sample.providers?.claude?.orphanScan;
    assert.ok(
      Number.isFinite(orphanScan?.subagentActivityEntries)
        && Number.isFinite(orphanScan?.subagentActivityLimit),
      'Claude subagent-activity cache diagnostics are missing',
    );
    assert.ok(orphanScan.subagentActivityEntries <= orphanScan.subagentActivityLimit,
      `Claude subagent-activity cache used ${orphanScan.subagentActivityEntries} entries `
      + `(limit ${orphanScan.subagentActivityLimit})`);
    assert.ok(Number.isFinite(sample.gitCommandCount), 'Git command diagnostics are missing');
    if (sample.tailRate != null) {
      assert.ok(Number.isFinite(sample.tailRate?.parsedLinesPerSecond),
        'parsed-tail rate diagnostics are malformed');
    }
  }
  assert.ok(
    Number.isFinite(steady.at(-1)?.tailRate?.parsedLinesPerSecond),
    'post-warmup parsed-tail rate diagnostics are missing',
  );

  const steadySamples = steady.slice(1);
  const first = steadySamples[0];
  const last = steadySamples.at(-1);
  const elapsed = last.elapsedSeconds - first.elapsedSeconds;
  if (elapsed > 0 && Number.isFinite(first.gitCommandCount) && Number.isFinite(last.gitCommandCount)) {
    const rate = (last.gitCommandCount - first.gitCommandCount) / elapsed;
    assert.ok(rate <= MAX_STEADY_GIT_COMMANDS_PER_SECOND,
      `steady git command rate was ${rate.toFixed(2)}/s`);
  }
  return assertRollingSlope(
    steady,
    sample => sample.runtime?.memory?.rss,
    MAX_SERVER_RSS_PLATEAU_BYTES,
    'server RSS',
  );
}

function checkRssGate() {
  const samples = values => values.map((rssMiB, index) => ({
    elapsedSeconds: 120 + index * 60,
    runtime: { memory: { rss: rssMiB * 1024 * 1024 }, eventLoop: { delayMs: { p95: 1 } } },
    tailCache: { estimatedBytes: 0, byteLimit: 32 * 1024 * 1024 },
    providers: { claude: { orphanScan: { subagentActivityEntries: 0, subagentActivityLimit: 24 } } },
    gitCommandCount: 0,
    tailRate: { parsedLinesPerSecond: 0 },
    wsInitMs: 1,
  }));
  for (const values of [
    Array(29).fill(300),
    [...Array(27).fill(400), 190, 305],
    [...Array(4).fill(400), 400, 200, 300, 365], // Even median is the midpoint, not the lower element.
    Array.from({ length: 29 }, (_, index) => 200 + index * 2), // 56 MiB remains within the allowance.
  ]) assert.doesNotThrow(() => assertServerPlateau(samples(values), 120));
  for (const values of [
    [...Array(28).fill(300), 396],
    [...Array(4).fill(400), 300, 100, 100, 300], // Using the upper element would hide this 100 MiB rise.
  ]) assert.throws(() => assertServerPlateau(samples(values), 120), /second-half median/);
  for (const values of [
    Array.from({ length: 29 }, (_, index) => 200 + index * 128 / 28),
    Array.from({ length: 29 }, (_, index) => 200 + Math.max(0, index - 14) * 128 / 14),
    Array.from({ length: 29 }, (_, index) => 200 + index * 6 - (index % 7 === 0 ? 50 : 0)),
  ]) assert.throws(() => assertServerPlateau(samples(values), 120), /slope projects/);
  const lateGrowth = Array.from({ length: 29 }, (_, index) => index < 14 ? 600 : 200 + (index - 14) * 128 / 14);
  assert.throws(() => assertServerPlateau(samples(lateGrowth), 120), /trailing slope projects/);
  console.log('[performance-soak] RSS gate controls passed');
}

async function main() {
  if (process.argv.includes('--listener-counter-check')) return checkListenerCounter();
  if (process.argv.includes('--rss-gate-check')) return checkRssGate();
  const options = parseArgs(process.argv.slice(2));
  const browserSamples = [];
  const serverSamples = [];
  const browserErrors = [];
  let modeCheckpoint = null;
  const startedAt = Date.now();
  const browserUntil = startedAt + options.browserSeconds * 1000;
  const serverUntil = startedAt + options.serverSeconds * 1000;
  const finishAt = Math.max(browserUntil, serverUntil);
  const intervalMs = options.intervalSeconds * 1000;

  const browser = await chromium.launch({
    headless: !options.headed,
    args: ['--enable-precise-memory-info'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const probePage = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await probePage.goto(`${options.url}/api/providers`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__claudeVilleApp?._bootState === 'ready', null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__claudeVillePerf?.canvasBudget === 'function');
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  modeCheckpoint = await checkpointWorldSuspendResume(page);
  console.log(JSON.stringify({ type: 'mode-checkpoint', ...modeCheckpoint }));

  let browserOpen = true;
  let nextCheckpointAt = startedAt;
  try {
    while (nextCheckpointAt <= finishAt) {
      const checkpointAt = nextCheckpointAt;
      const now = Date.now();
      if (now < checkpointAt) await sleep(checkpointAt - now);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
      if (browserOpen && checkpointAt <= browserUntil) {
        const sample = await sampleBrowser(page, cdp, elapsedSeconds);
        assertBrowserBounds(sample);
        browserSamples.push(sample);
        console.log(JSON.stringify({ type: 'browser', ...sample }));
      } else if (browserOpen) {
        browserOpen = false;
        await page.close();
      }
      if (checkpointAt <= serverUntil) {
        const sample = await sampleServer(probePage, options.url, elapsedSeconds, {
          timeoutMs: options.wsTimeoutSeconds * 1000,
          attempts: options.wsAttempts,
        });
        const physicalWatchEntries = sample.watchers?.linux?.watchEntries;
        if (Number.isFinite(physicalWatchEntries)) {
          assert.ok(physicalWatchEntries < 1000,
            `physical watcher count was ${physicalWatchEntries}`);
        }
        serverSamples.push(sample);
        console.log(JSON.stringify({ type: 'server', ...sample }));
      }
      nextCheckpointAt += intervalMs;
    }
  } finally {
    await browser.close();
  }

  const browserSlopes = assertBrowserPlateau(browserSamples, options.warmupSeconds);
  const serverSlopes = assertServerPlateau(serverSamples, options.warmupSeconds);
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  const summary = {
    ok: true,
    url: options.url,
    durations: {
      browserSeconds: options.browserSeconds,
      serverSeconds: options.serverSeconds,
      intervalSeconds: options.intervalSeconds,
      warmupSeconds: options.warmupSeconds,
    },
    slopes: {
      browserHeap: browserSlopes,
      serverRss: serverSlopes,
    },
    checkpoints: {
      browser: browserSamples.length,
      server: serverSamples.length,
      worldSuspendResume: modeCheckpoint,
    },
    browser: browserSamples.length ? {
      heapFirst: browserSamples[0].heapUsed,
      heapLast: browserSamples.at(-1).heapUsed,
      heapMin: Math.min(...browserSamples.map(sample => sample.heapUsed).filter(Number.isFinite)),
      heapMax: Math.max(...browserSamples.map(sample => sample.heapUsed).filter(Number.isFinite)),
      listeners: browserSamples.at(-1).listeners,
      eventBusListeners: browserSamples.at(-1).eventBusListeners,
      lightFadeColors: browserSamples.at(-1).boundedState?.lightFadeColors,
      harborSeenEvents: browserSamples.at(-1).harbor?.seenEventIds,
      trails: {
        totalSamples: browserSamples.at(-1).trails?.totalSamples,
        maxPerAgentSamples: browserSamples.at(-1).trails?.maxPerAgentSamples,
        pendingSamples: browserSamples.at(-1).trails?.pendingSamples,
        hydratedSamples: browserSamples.at(-1).trails?.hydratedSamples,
        duplicateDrops: browserSamples.at(-1).trails?.duplicateDrops,
        repaintCount: browserSamples.at(-1).trails?.repaintCount,
        repaintTimeMs: browserSamples.at(-1).trails?.repaintTimeMs,
        highWaterSamples: Math.max(...browserSamples.map(sample => sample.trails?.highWaterSamples || 0)),
        highWaterCachePixels: Math.max(...browserSamples.map(sample => sample.trails?.highWaterCachePixels || 0)),
      },
      frameP95Ms: browserSamples.map(sample => sample.frame.p95Ms),
    } : null,
    server: serverSamples.length ? {
      rssFirst: serverSamples[0].runtime?.memory?.rss,
      rssLast: serverSamples.at(-1).runtime?.memory?.rss,
      heapFirst: serverSamples[0].runtime?.memory?.heapUsed,
      heapLast: serverSamples.at(-1).runtime?.memory?.heapUsed,
      physicalWatchesMax: (() => {
        const values = serverSamples.map(sample => sample.watchers?.linux?.watchEntries).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
      })(),
      gitCommandsFirst: serverSamples[0].gitCommandCount,
      gitCommandsLast: serverSamples.at(-1).gitCommandCount,
      parsedLinesPerSecondLast: serverSamples.at(-1).tailRate?.parsedLinesPerSecond ?? null,
      rejectedEntriesPerSecondLast: serverSamples.at(-1).tailRate?.rejectedEntriesPerSecond ?? null,
      dirtyMarksCoalesced: serverSamples.at(-1).dirtyMarksCoalesced,
      broadcastMaxMs: Math.max(...serverSamples.map(sample => sample.lastBroadcast?.elapsed || 0)),
    } : null,
  };
  console.log(JSON.stringify({ type: 'summary', ...summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[performance-soak] FAIL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
