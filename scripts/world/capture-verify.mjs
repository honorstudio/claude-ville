#!/usr/bin/env node
// Live visual verification captures for agents/plans/claudeville-visual-quality-plan.md
// Usage: node scripts/world/capture-verify.mjs   (server must run on :4000)
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
const shot = (name) => page.screenshot({ path: join(outDir, `verify-${name}.png`) }).then(() => console.log(`verify-${name}.png`));

async function fixSky(hour, weather = { type: 'clear', intensity: 0, windX: 0, seed: 4242 }) {
  await page.evaluate(([h, w]) => {
    const a = window.__claudeVilleAtmosphere;
    a?.setTimelineMode?.('fixed');
    a?.setHour?.(h);
    a?.setWeather?.(w);
    a?.freeze?.();
  }, [hour, weather]);
}

try {
  // 1. World day overview (live sessions)
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await fixSky(10);
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(700);
  await shot('world-day-overview');

  // 2. Command castle close-up (banner cube region)
  await page.evaluate(() => window.cameraSet({ x: 360, y: 240, zoom: 2 }));
  await page.waitForTimeout(700);
  await shot('command-closeup');

  // 3. Lagoon close-up (water checkerboard region, SW water)
  await page.evaluate(() => window.cameraSet({ x: -320, y: 240, zoom: 2 }));
  await page.waitForTimeout(700);
  await shot('lagoon-closeup');

  // 4. Night world (PRIMARY mark dimming + black-frame check)
  await fixSky(22, { type: 'clear', intensity: 0, windX: 0, seed: 4242 });
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(900);
  await shot('world-night');

  // 5. Back to day; open changelog modal via version chip
  await fixSky(10);
  await page.click('.topbar__version').catch((e) => console.log('version chip click failed:', e.message));
  await page.waitForTimeout(400);
  await shot('modal-changelog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 6. Select first sidebar agent (activity panel name truncation)
  const row = page.locator('.sidebar__agent-row, .sidebar__agent, [class*="agent"]').first();
  await row.click().catch((e) => console.log('agent row click failed:', e.message));
  await page.waitForTimeout(600);
  await shot('agent-selected');

  // 7. Dashboard mode
  await page.click('text=DASHBOARD').catch((e) => console.log('dashboard toggle failed:', e.message));
  await page.waitForTimeout(900);
  await shot('dashboard');

  // 8. Crowd scenario: clone army + synchronized animation
  await page.goto(`${baseUrl}/?scenario=dense-24-agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await fixSky(10);
  await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
  await page.waitForTimeout(700);
  await shot('crowd-frame-a');
  await page.waitForTimeout(260);
  await shot('crowd-frame-b');

  // 9. 2560x1440 world (pixel-uniformity check)
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.cameraSet({ x: 360, y: 240, zoom: 2 }));
  await page.waitForTimeout(700);
  await shot('world-2560');

  console.log('done');
} finally {
  await browser.close();
}
