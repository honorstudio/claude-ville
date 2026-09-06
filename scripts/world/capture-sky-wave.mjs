#!/usr/bin/env node
// Sky & atmosphere wave (plan items 0.6/0.14/5.2-5.6) — targeted captures.
// Usage: node scripts/world/capture-sky-wave.mjs  (server must run on :4000)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(repoRoot, 'output', 'playwright');
mkdirSync(outDir, { recursive: true });
const baseUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
const shot = (name) => page.screenshot({ path: join(outDir, `skywave-${name}.png`) }).then(() => console.log(`skywave-${name}.png`));

async function fixSky(hour, weather = { type: 'clear', intensity: 0, windX: 0, seed: 4242 }) {
  await page.evaluate(([h, w]) => {
    const a = window.__claudeVilleAtmosphere;
    a?.clear?.();
    a?.setTimelineMode?.('fixed');
    a?.setHour?.(h);
    a?.setWeather?.(w);
    a?.freeze?.();
  }, [hour, weather]);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 1. Day — stepped-disc sun (5.3)
  await fixSky(10);
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(900);
  await shot('day-sun');

  // 2. Night clear — denser starfield + canopy (5.2/5.6)
  await fixSky(22, { type: 'clear', intensity: 0, windX: 0, seed: 4242 });
  await page.waitForTimeout(900);
  await shot('night-stars');

  // 3. Storm (timeline cause) — storm canopy still bakes (5.5 non-fleet path)
  await fixSky(15, { type: 'storm', intensity: 0.9, windX: 1, seed: 4242 });
  await page.waitForTimeout(900);
  await shot('storm-timeline');

  // 4. Back to clear day — sanity that weather transitions don't error
  await fixSky(12);
  await page.waitForTimeout(900);
  await shot('day-clear-after-storm');

  // 5. Snapshot shape probe: seasonal phases, weather.cause, cloudLayers, cacheKey
  const probe = await page.evaluate(() => {
    const s = window.__claudeVilleAtmosphere?.snapshot?.();
    return s ? {
      phase: s.phase,
      month: s.effectiveDate?.getMonth(),
      cause: s.weather?.cause,
      cacheKey: s.cacheKey,
      cloudLayers: s.sky?.cloudLayers?.length,
      sunAssetHook: s.sky?.assetIds?.sun || null,
    } : null;
  });
  console.log('probe:', JSON.stringify(probe));

  console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
} finally {
  await browser.close();
}
