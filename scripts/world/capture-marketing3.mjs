import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(repoRoot, 'output', 'playwright');
const browser = await chromium.launch();

// 1. Dashboard without the switch toast
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await page.goto('http://localhost:4000/?sim=1&scenario=dense-24-agents', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.click('text=DASHBOARD');
await page.waitForTimeout(1200);
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
await page.waitForTimeout(600);
await page.screenshot({ path: join(outDir, 'm3-dashboard.png') });
console.log('m3-dashboard.png');

// 2. OG card from the hero shot
const imgB64 = readFileSync(join(outDir, 'm2-hero-s2.png')).toString('base64');
const card = await (await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })).newPage();
await card.setContent(`<!doctype html><html><body style="margin:0;position:relative;width:1280px;height:640px;overflow:hidden;background:#0b0f14">
  <img src="data:image/png;base64,${imgB64}" style="position:absolute;left:-160px;top:-60px;width:1600px;height:1000px;object-fit:cover"/>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(8,6,10,0) 40%, rgba(8,6,10,0.55) 68%, rgba(8,6,10,0.92) 100%)"></div>
  <div style="position:absolute;left:56px;bottom:44px;font-family:Georgia,'Times New Roman',serif">
    <div style="font-size:64px;font-weight:700;color:#f5c86e;letter-spacing:1px;line-height:1;text-shadow:0 2px 12px rgba(0,0,0,.6)">ClaudeVille</div>
    <div style="font-size:26px;color:#f2ead9;margin-top:10px">Watch local AI coding agents work in a living village</div>
    <div style="font-size:20px;color:#7fdc8f;margin-top:14px;font-family:monospace">Claude Code&nbsp; | &nbsp;Codex CLI&nbsp; | &nbsp;Gemini&nbsp; | &nbsp;Kimi&nbsp; | &nbsp;OpenCode</div>
  </div>
</body></html>`);
await card.waitForTimeout(400);
await card.screenshot({ path: join(outDir, 'm3-og-card.png') });
console.log('m3-og-card.png');
await browser.close();
