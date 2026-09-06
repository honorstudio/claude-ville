import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(repoRoot, 'output', 'playwright');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await page.goto('http://localhost:4000/?sim=1&scenario=dense-24-agents', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#topbarCinemaToggle').catch(() => {});
await page.waitForTimeout(9000);
async function sky(hour) {
  await page.evaluate((h) => {
    const a = window.__claudeVilleAtmosphere;
    a?.setTimelineMode?.('fixed'); a?.setHour?.(h);
    a?.setWeather?.({ type: 'clear', intensity: 0, windX: 0.2, seed: 4242 });
    a?.freeze?.();
  }, hour);
}
async function frame(x, y, zoom, settle = 800) {
  await page.evaluate(([a, b, z]) => window.cameraSet({ x: a, y: b, zoom: z }), [x, y, zoom]);
  await page.waitForTimeout(settle);
}
const shot = (name) => page.screenshot({ path: join(outDir, `m2-${name}.png`) }).then(() => console.log(`m2-${name}.png`));

await sky(10);
await frame(0, 260, 1, 1000);
await shot('hero-s1');
await frame(-80, 340, 1, 700);
await shot('hero-s2');
await frame(60, 200, 1, 700);
await shot('hero-s3');
await sky(22);
await frame(60, 200, 1, 1000);
await shot('night-east');
await frame(-80, 340, 1, 700);
await shot('night-south');
await browser.close();
