#!/usr/bin/env node

import os from 'node:os';
import { chromium } from 'playwright';

const DEFAULT_URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const DEFAULT_COUNTS = [1, 10, 24, 50, 100];
const WEATHER_PROFILES = Object.freeze({
  clear: Object.freeze({
    type: 'clear',
    intensity: 0,
    precipitation: 0,
    fog: 0,
    cloudCover: 0.1,
    windX: 0,
    seed: 4242,
  }),
  rain: Object.freeze({
    type: 'rain',
    intensity: 0.82,
    precipitation: 0.92,
    fog: 0.12,
    cloudCover: 0.92,
    windX: -0.44,
    seed: 4242,
  }),
});
const FIXED_DATE = '2026-05-18T12:00:00.000Z';
const VIEWPORT = Object.freeze({ width: 1600, height: 1000 });
const CAMERA_POSE = Object.freeze({ x: -128, y: 704, zoom: 1.72 });

function usage() {
  console.log(`Usage: node scripts/smoke/world-fps-benchmark.mjs [options]

Options:
  --url=<url>                 ClaudeVille URL (default: ${DEFAULT_URL})
  --duration-seconds=<n>      Measurement duration per run (default: 30)
  --warmup-seconds=<n>        Warmup duration per run (default: 10)
  --repetitions=<n>           Fresh browser contexts per case (default: 3)
  --counts=<list>             Comma-separated agent counts from 1 to 200
  --weather=<list>            Comma-separated subset of clear,rain
  --max-rain-regression-pct=<n>
                              Fail if paired rain median FPS is more than n% below clear
  --profile                   Include opt-in update/render timings
  --headed                    Show the Chromium window
  --help                      Print this help

The default matrix measures clear and heavy rain for 1, 10, 24, 50, and 100
deterministic active agents. Output is newline-delimited JSON followed by a
summary object.`);
}

function parseList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL.replace(/\/+$/, ''),
    durationSeconds: 30,
    warmupSeconds: 10,
    repetitions: 3,
    counts: [...DEFAULT_COUNTS],
    weather: Object.keys(WEATHER_PROFILES),
    profile: false,
    headed: false,
    maxRainRegressionPct: null,
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
    if (arg === '--profile') {
      options.profile = true;
      continue;
    }
    const [flag, inlineValue] = arg.split('=', 2);
    if (![
      '--url',
      '--duration-seconds',
      '--warmup-seconds',
      '--repetitions',
      '--counts',
      '--weather',
      '--max-rain-regression-pct',
    ].includes(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
    if (flag === '--url') options.url = value.replace(/\/+$/, '');
    if (flag === '--duration-seconds') options.durationSeconds = Number(value);
    if (flag === '--warmup-seconds') options.warmupSeconds = Number(value);
    if (flag === '--repetitions') options.repetitions = Number(value);
    if (flag === '--counts') options.counts = parseList(value).map(Number);
    if (flag === '--weather') options.weather = parseList(value);
    if (flag === '--max-rain-regression-pct') options.maxRainRegressionPct = Number(value);
  }

  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1) {
    throw new Error('duration seconds must be at least 1');
  }
  if (!Number.isFinite(options.warmupSeconds) || options.warmupSeconds < 0) {
    throw new Error('warmup seconds must be zero or positive');
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions <= 0) {
    throw new Error('repetitions must be a positive integer');
  }
  if (!options.counts.length || options.counts.some(count => !Number.isInteger(count) || count < 1 || count > 200)) {
    throw new Error('counts must be a non-empty list of integers from 1 to 200');
  }
  if (!options.weather.length || options.weather.some(name => !WEATHER_PROFILES[name])) {
    throw new Error(`weather must be a non-empty subset of ${Object.keys(WEATHER_PROFILES).join(',')}`);
  }
  if (
    options.maxRainRegressionPct != null
    && (!Number.isFinite(options.maxRainRegressionPct) || options.maxRainRegressionPct < 0)
  ) {
    throw new Error('max rain regression percent must be zero or positive');
  }
  if (
    options.maxRainRegressionPct != null
    && (!options.weather.includes('clear') || !options.weather.includes('rain'))
  ) {
    throw new Error('rain regression checks require both clear and rain weather cases');
  }
  return options;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function summarizeFps(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    mean: round(mean, 1),
    median: round(percentile(values, 0.5), 1),
    p10: round(percentile(values, 0.1), 1),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeFrames(deltas) {
  if (!deltas.length) return null;
  const meanMs = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const longFrames = deltas.filter(value => value > 50).length;
  return {
    samples: deltas.length,
    fps: round(1000 / meanMs, 1),
    meanMs: round(meanMs),
    p50Ms: round(percentile(deltas, 0.5)),
    p95Ms: round(percentile(deltas, 0.95)),
    maxMs: round(Math.max(...deltas)),
    over50Ms: longFrames,
    over50MsRatio: round(longFrames / deltas.length, 4),
  };
}

function summarizeProfile(profile) {
  const samples = profile?.samples;
  if (!samples?.length) return null;
  const summarize = key => ({
    p50Ms: round(percentile(samples.map(sample => sample[key]), 0.5)),
    p95Ms: round(percentile(samples.map(sample => sample[key]), 0.95)),
  });
  return {
    samples: samples.length,
    update: summarize('updateMs'),
    render: summarize('renderMs'),
    total: summarize('totalMs'),
    renderSegments: profile.renderTimings?.segments || [],
  };
}

async function measureFrames(page, durationMs) {
  return page.evaluate(async measurementMs => {
    const { eventBus } = await import('/src/domain/events/DomainEvent.js');
    const fpsSamples = [];
    const renderer = window.__claudeVilleApp?.renderer;
    if (renderer) {
      renderer._fpsFrames = 0;
      renderer._fpsWindowStart = performance.now();
    }
    const unsubscribe = eventBus.on('fps:updated', value => {
      if (Number.isFinite(value)) fpsSamples.push(value);
    });
    const deltas = await new Promise(resolve => {
      const values = [];
      const startedAt = performance.now();
      let previous = startedAt;
      const tick = now => {
        if (now > startedAt) values.push(now - previous);
        previous = now;
        if (now - startedAt >= measurementMs) resolve(values);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    unsubscribe?.();
    return { fpsSamples, deltas };
  }, durationMs);
}

async function startQualityTimeline(page) {
  await page.evaluate(() => {
    const startedAt = performance.now();
    const entries = [];
    let lastLevel;
    const sample = () => {
      const health = window.__claudeVillePerf?.frameHealth?.() || null;
      const gpu = window.__claudeVilleApp?.renderer?.gpuWorld?.getDiagnostics?.() || null;
      const qualityLevel = health?.qualityLevel ?? null;
      if (qualityLevel === null) return;
      if (entries.length && qualityLevel === lastLevel) return;
      lastLevel = qualityLevel;
      entries.push({
        elapsedMs: Math.round(performance.now() - startedAt),
        qualityLevel,
        qualityReason: health?.qualityReason ?? null,
        gpuMs: Number.isFinite(health?.gpuMs) ? health.gpuMs : null,
        lights: gpu?.lights ?? null,
      });
    };
    sample();
    const interval = setInterval(sample, 250);
    window.__claudeVilleBenchmarkQualityTimeline = {
      entries,
      sample,
      stop() {
        clearInterval(interval);
        sample();
        return entries;
      },
    };
  });
}

async function stopQualityTimeline(page) {
  return page.evaluate(() => {
    const tracker = window.__claudeVilleBenchmarkQualityTimeline;
    const entries = tracker?.stop?.() || [];
    delete window.__claudeVilleBenchmarkQualityTimeline;
    return entries;
  });
}

async function runCase(browser, options, count, weatherName, repetition) {
  const loadAverageStart = os.loadavg();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  const pageUrl = new URL(options.url);
  pageUrl.searchParams.set('sim', '1');
  pageUrl.searchParams.set('scenario', `perf-${count}-agents`);

  try {
    await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await startQualityTimeline(page);
    await page.waitForFunction(expectedCount => {
      const app = window.__claudeVilleApp;
      return app?._bootState === 'ready'
        && app?.renderer?.agentSprites?.size === expectedCount
        && app?.world?.getStats?.().working === expectedCount
        && typeof window.cameraSet === 'function'
        && typeof window.__claudeVillePerf?.canvasBudget === 'function';
    }, count, { timeout: 60_000 });

    const weather = WEATHER_PROFILES[weatherName];
    await page.evaluate(({ cameraPose, fixedDate, weatherProfile }) => {
      const renderer = window.__claudeVilleApp.renderer;
      renderer.cameraDirector?.setAutoMode?.(false);
      window.cameraSet(cameraPose);
      const atmosphere = renderer.atmosphereState;
      atmosphere.clear();
      // WorldFrameRenderer supplies a live date every frame. Override only this
      // fixture's atmosphere clock so the rain case cannot become winter snow.
      const updateAtmosphere = atmosphere.update.bind(atmosphere);
      const fixedNow = new Date(fixedDate);
      atmosphere.update = (options = {}) => updateAtmosphere({ ...options, now: fixedNow });
      atmosphere.setTimelineMode('fixed');
      atmosphere.setHour(12);
      atmosphere.setSeed(weatherProfile.seed);
      atmosphere.setWeather(weatherProfile);
      if (renderer.weatherRenderer) renderer.weatherRenderer.elapsedMs = 0;
    }, { cameraPose: CAMERA_POSE, fixedDate: FIXED_DATE, weatherProfile: weather });

    await page.waitForFunction(expectedWeather => {
      const atmosphere = window.__claudeVilleApp?.renderer?._lastAtmosphere;
      return atmosphere?.weather?.type === expectedWeather
        && atmosphere?.motion?.particleEnabled === true;
    }, weatherName);
    await sleep(options.warmupSeconds * 1000);

    if (options.profile) {
      await page.evaluate(() => window.__claudeVillePerf.startFrameProfile());
    }
    const measured = await measureFrames(page, options.durationSeconds * 1000);
    const profile = options.profile
      ? await page.evaluate(() => window.__claudeVillePerf.stopFrameProfile())
      : null;
    const qualityTimeline = await stopQualityTimeline(page);
    if (!measured.fpsSamples.length) throw new Error('no fps:updated samples were recorded');
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);

    const snapshot = await page.evaluate(() => {
      const app = window.__claudeVilleApp;
      const renderer = app?.renderer;
      const canvasBudget = window.__claudeVillePerf?.canvasBudget?.() || null;
      const postFx = renderer?.postFx?.getDiagnostics?.() || null;
      const postFxFeed = renderer?.postFxFeed?.getDiagnostics?.() || null;
      return {
        agents: app?.world?.agents?.size ?? null,
        working: app?.world?.getStats?.().working ?? null,
        weather: renderer?._lastAtmosphere?.weather || null,
        effectiveMonth: renderer?._lastAtmosphere?.effectiveDate?.getMonth?.() ?? null,
        particleEnabled: renderer?._lastAtmosphere?.motion?.particleEnabled ?? null,
        renderMode: renderer?._lastRenderStats?.quality?.agentRenderMode || null,
        canvasDpr: canvasBudget?.dpr ?? null,
        visibleCanvasPixels: canvasBudget?.visibleCanvasPixels ?? null,
        particles: renderer?._lastRenderStats?.canvas?.particles ?? null,
        frameFailures: canvasBudget?.runtime?.frameFailures || null,
        postFx,
        postFxFeed,
        gpuWorld: renderer?.gpuWorld?.getDiagnostics?.() || null,
        resources: canvasBudget?.resources || null,
        trails: renderer?.trailRenderer?.getDiagnostics?.() || null,
      };
    });

    if (snapshot.agents !== count || snapshot.working !== count) {
      throw new Error(`expected ${count} active agents, received ${snapshot.agents}/${snapshot.working}`);
    }
    if (snapshot.weather?.type !== weatherName || snapshot.particleEnabled !== true) {
      throw new Error(`weather control failed for ${weatherName}`);
    }
    if (snapshot.effectiveMonth !== 4) {
      throw new Error(`fixed benchmark date drifted to month ${snapshot.effectiveMonth}`);
    }

    return {
      type: 'run',
      count,
      weather: weatherName,
      repetition,
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      hostLoadAverage: { start: loadAverageStart, end: os.loadavg() },
      uiFps: summarizeFps(measured.fpsSamples),
      frames: summarizeFrames(measured.deltas),
      qualityTimeline,
      profile: summarizeProfile(profile),
      snapshot,
    };
  } finally {
    await context.close();
  }
}

function summarizeRuns(runs) {
  const cases = [];
  for (const count of [...new Set(runs.map(run => run.count))].sort((a, b) => a - b)) {
    for (const weather of [...new Set(runs.map(run => run.weather))]) {
      const matches = runs.filter(run => run.count === count && run.weather === weather);
      if (!matches.length) continue;
      cases.push({
        count,
        weather,
        repetitions: matches.length,
        medianFps: round(percentile(matches.map(run => run.uiFps.median), 0.5), 1),
        p10Fps: round(percentile(matches.map(run => run.uiFps.p10), 0.5), 1),
        rawFps: round(percentile(matches.map(run => run.frames.fps), 0.5), 1),
        frameP95Ms: round(percentile(matches.map(run => run.frames.p95Ms), 0.5)),
      });
    }
  }
  for (const item of cases) {
    const clear = cases.find(candidate => candidate.count === item.count && candidate.weather === 'clear');
    if (item.weather === 'rain' && clear?.medianFps) {
      item.fpsChangeVsClearPct = round(((item.medianFps / clear.medianFps) - 1) * 100, 1);
    }
  }
  return cases;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: !options.headed });
  const runs = [];
  try {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const weatherOrder = repetition % 2 === 0 ? [...options.weather].reverse() : options.weather;
      const countOrder = repetition % 2 === 0 ? [...options.counts].reverse() : options.counts;
      for (const count of countOrder) {
        for (const weather of weatherOrder) {
          const result = await runCase(browser, options, count, weather, repetition);
          runs.push(result);
          console.log(JSON.stringify(result));
        }
      }
    }
    const cpu = os.cpus()[0];
    const cases = summarizeRuns(runs);
    const rainRegressionViolations = options.maxRainRegressionPct == null
      ? []
      : cases
        .filter(item => item.weather === 'rain')
        .filter(item => (
          !Number.isFinite(item.fpsChangeVsClearPct)
          || item.fpsChangeVsClearPct < -options.maxRainRegressionPct
        ))
        .map(item => ({
          count: item.count,
          fpsChangeVsClearPct: item.fpsChangeVsClearPct,
          maxRainRegressionPct: options.maxRainRegressionPct,
        }));
    const summary = {
      type: 'summary',
      ok: rainRegressionViolations.length === 0,
      url: options.url,
      browserVersion: browser.version(),
      environment: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpu: cpu?.model || null,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        loadAverage: os.loadavg(),
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        fixedDate: FIXED_DATE,
      },
      options: {
        counts: options.counts,
        weather: options.weather,
        durationSeconds: options.durationSeconds,
        warmupSeconds: options.warmupSeconds,
        repetitions: options.repetitions,
        profile: options.profile,
        headed: options.headed,
        maxRainRegressionPct: options.maxRainRegressionPct,
      },
      cases,
      rainRegressionViolations,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`[world-fps-benchmark] FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
