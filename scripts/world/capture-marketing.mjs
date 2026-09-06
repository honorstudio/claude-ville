#!/usr/bin/env node
// README marketing screenshot capture at v0.26 — hero/night/dashboard/panel + OG card.
// Server must run on :4000. Output: docs/assets/github/*.png (only with --write), else output/playwright/marketing-*.png
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const write = process.argv.includes('--write');
const outDir = write ? join(repoRoot, 'docs', 'assets', 'github') : join(repoRoot, 'output', 'playwright');
const prefix = write ? '' : 'marketing-';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://localhost:4000/?sim=1&scenario=dense-24-agents', { waitUntil: 'networkidle' });
// Kill the auto-camera so framing sticks.
await page.waitForTimeout(1200);
await page.click('#topbarCinemaToggle').catch(() => {});
await page.waitForTimeout(3500);

async function sky(hour) {
  await page.evaluate((h) => {
    const a = window.__claudeVilleAtmosphere;
    a?.setTimelineMode?.('fixed'); a?.setHour?.(h);
    a?.setWeather?.({ type: 'clear', intensity: 0, windX: 0.2, seed: 4242 });
    a?.freeze?.();
  }, hour);
}
async function frame(x, y, zoom, settle = 900) {
  await page.evaluate(([a, b, z]) => window.cameraSet({ x: a, y: b, zoom: z }), [x, y, zoom]);
  await page.waitForTimeout(settle);
}
const shot = (name) => page.screenshot({ path: join(outDir, `${prefix}${name}.png`) }).then(() => console.log(`${prefix}${name}.png`));

// Let the sim crowd gather at buildings.
await page.waitForTimeout(6000);

// ── Hero candidates (day, busy village core) ──
await sky(10);
await frame(0, 60, 1, 1200);
await shot('hero-cand-a');
await frame(120, 40, 1, 700);
await shot('hero-cand-b');
await frame(-80, 140, 1, 700);
await shot('hero-cand-c');

// ── Night ──
await sky(22);
await frame(0, 60, 1, 1200);
await shot('world-night');

// ── Dashboard ──
await page.click('text=DASHBOARD');
await page.waitForTimeout(1500);
await shot('dashboard');

// ── Back to world, select an agent for the activity panel ──
await page.click('text=WORLD');
await page.waitForTimeout(1200);
await sky(10);
await frame(0, 60, 1, 700);
await page.locator('.sidebar__agent-row, [class*="agent-row"]').first().click().catch(async () => {
  await page.locator('.sidebar [class*="agent"]').nth(2).click().catch(() => {});
});
await page.waitForTimeout(1200);
await shot('activity-panel');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
