#!/usr/bin/env node
// Wave-3 buildings/monuments verification captures. Server must run on :4000.
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const shot = (name) => page.screenshot({ path: join(outDir, `verify-w3-${name}.png`) }).then(() => console.log(`verify-w3-${name}.png`));

async function fixSky(hour) {
  await page.evaluate((h) => {
    const a = window.__claudeVilleAtmosphere;
    a?.setTimelineMode?.('fixed');
    a?.setHour?.(h);
    a?.setWeather?.({ type: 'clear', intensity: 0, windX: 0, seed: 4242 });
    a?.freeze?.();
  }, hour);
}

try {
  // Sim crowd so buildings have occupants (pennants/dais/window warmth)
  await page.goto(`${baseUrl}/?sim=1&scenario=dense-24-agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Day: village overview (banner gone, new props/trees, dais rings, pennants)
  await fixSky(10);
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(800);
  await shot('day-overview');

  // Command keep zoom (banner cube gone, windowRects, watchfire)
  await page.evaluate(() => window.cameraSet({ x: 360, y: 200, zoom: 2 }));
  await page.waitForTimeout(700);
  await shot('command-zoom');

  // Night: window warmth, aperture, beacon
  await fixSky(22);
  await page.waitForTimeout(900);
  await shot('night-command');
  await page.evaluate(() => window.cameraSet({ x: 700, y: 120, zoom: 2 }));
  await page.waitForTimeout(700);
  await shot('night-observatory');

  // Night wide (windowRects across village, dais rings)
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(700);
  await shot('night-overview');

  console.log('console/page errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
