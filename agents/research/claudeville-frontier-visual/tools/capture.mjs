#!/usr/bin/env node
// Real-GPU capture helper for the frontier-visual research round.
// Usage:
//   node agents/research/claudeville-frontier-visual/tools/capture.mjs \
//     --scenario dense-24-agents --hour 22 --weather clear --zoom 2 \
//     --center 20,20 --wait 12000 --select sim-user-bell --out shots/light-01.jpg
// Options: --scenario <id> (default mixed-tools) --hour <0-24> --weather clear|rain|storm
//          --zoom <n> --center <tileX,tileY> --wait <ms after load, default 8000>
//          --select <agentId> --mode world|dashboard --width/--height (default 1920x1080)
//          --url <override full URL>  --live (use the real feed instead of ?sim=1)
//          --eval "<js>" (evaluated in page before capture; window.__claudeVilleApp available)
// Reads the operator-maintained server at http://localhost:4000 read-only. Never starts or stops it.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const WEATHER = {
    clear: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.08, windX: 0 },
    rain: { type: 'rain', intensity: 0.82, precipitation: 0.9, fog: 0.16, cloudCover: 0.92, windX: -0.4 },
    storm: { type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78 },
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const scenario = opt('scenario', 'mixed-tools');
const hour = opt('hour', null);
const weather = opt('weather', null);
const zoom = opt('zoom', null);
const center = opt('center', null);
const waitMs = Number(opt('wait', 8000));
const select = opt('select', null);
const mode = opt('mode', 'world');
const width = Number(opt('width', 1920));
const height = Number(opt('height', 1080));
const out = opt('out', 'shots/capture.jpg');
const evalJs = opt('eval', null);
const live = has('live');
const url = opt('url', live ? 'http://localhost:4000/' : `http://localhost:4000/?sim=1&scenario=${scenario}`);

const browser = await chromium.launch({
    headless: !has('headed'),
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(String(err)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__claudeVilleApp?.renderer), null, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.evaluate(async ({ hour, weather, zoom, center, select, mode }) => {
    const app = window.__claudeVilleApp;
    const renderer = app?.renderer;
    if (mode === 'dashboard') {
        app?.modeManager?.switchMode?.('dashboard');
        return;
    }
    renderer?.cameraDirector?.setAutoMode?.(false);
    const atmosphere = renderer?.atmosphereState || window.__claudeVilleAtmosphere;
    if (hour != null) {
        atmosphere?.setTimelineMode?.('fixed');
        atmosphere?.setHour?.(Number(hour));
    }
    if (weather) atmosphere?.setWeather?.(weather);
    if (select) {
        renderer?.selectAgentById?.(select);
        renderer?.onAgentSelect?.(app?.world?.agents?.get?.(select) || null);
    }
    if (center || zoom != null) {
        renderer.camera.abortDirectorGlide?.();
        const pose = {};
        if (center) {
            const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
            const [tileX, tileY] = center.split(',').map(Number);
            const point = tileToWorld({ tileX, tileY });
            pose.x = point.x;
            pose.y = point.y;
        }
        if (zoom != null) pose.zoom = Number(zoom);
        renderer.setCameraPose?.(pose);
    }
}, { hour, weather: weather ? WEATHER[weather] : null, zoom, center, select, mode });

if (evalJs) await page.evaluate(evalJs);
await page.waitForTimeout(waitMs);

const diag = await page.evaluate(() => {
    const r = window.__claudeVilleApp?.renderer;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    const gpu = r?.gpuWorld?.getDiagnostics?.() || null;
    const post = r?.postFx?.getDiagnostics?.() || null;
    const atmo = (r?.atmosphereState || window.__claudeVilleAtmosphere)?.snapshot?.() || null;
    return {
        webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        worldRendererMode: r?.worldRendererMode ?? null,
        qualityLevel: gpu?.qualityLevel ?? post?.level ?? null,
        qualityReason: gpu?.qualityReason ?? null,
        agents: window.__claudeVilleApp?.world?.agents?.size ?? null,
        zoom: r?.camera?.zoom ?? null,
        hour: atmo?.hour ?? atmo?.clock?.hours ?? atmo?.clock?.hour ?? null,
        weather: atmo?.weather?.type ?? null,
    };
});

mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, type: out.endsWith('.png') ? 'png' : 'jpeg', quality: out.endsWith('.png') ? undefined : 82 });
await browser.close();
console.log(JSON.stringify({ out, url, diag, consoleErrors: consoleErrors.slice(0, 10) }, null, 2));
