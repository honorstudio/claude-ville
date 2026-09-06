import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
const url = new URL('http://localhost:4000/'); url.searchParams.set('sim', '1'); url.searchParams.set('scenario', 'dense-24-agents');
const t0 = Date.now();
await page.goto(url.href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.cameraSet === 'function', null, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => { const a = window.__claudeVilleAtmosphere; a?.setTimelineMode?.('fixed'); a?.setHour?.(23); });
const rows = [];
for (let i = 0; i < 75; i++) {
  await page.waitForTimeout(1000);
  const r = await page.evaluate(() => { try { const f = window.__claudeVillePerf.frameHealth(); const g = window.__claudeVilleApp?.renderer?.gpuWorld?.diagnostics?.() || window.__claudeVilleApp?.renderer?._gpuWorld?.diagnostics?.() || null; return { q: f.qualityLevel, r: f.qualityReason, gpu: f.gpuMs, render: f.appRenderMs, gap: f.frameGapMs, lights: g?.lights ?? g?.lightCount ?? null }; } catch (e) { return { err: String(e).slice(0, 80) }; } });
  rows.push(`${((Date.now() - t0) / 1000).toFixed(0)}s q=${r.q} ${r.r} gpu=${r.gpu} render=${r.render} gap=${r.gap} lights=${r.lights}`);
}
console.log(rows.join('\n'));
await browser.close();
