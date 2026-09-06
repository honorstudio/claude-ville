#!/usr/bin/env node

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const defaultUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';

function usage() {
    console.log(`Usage: node scripts/smoke/trail-camera-benchmark.mjs [options]

Options:
  --url=<url>             ClaudeVille server (default: ${defaultUrl})
  --duration-ms=<n>       Sample window per camera mode (default: 2200)
  --samples-per-agent=<n> Seeded historical points (default: 120)
  --output=<path>         Also write the JSON report to this path
  --headed                Show Chromium
  --help                  Print this help

Profiles stationary, manual pan, selected-agent follow, and CameraDirector
glide against the same deterministic dense-100 trail history.`);
}

function parseArgs(argv) {
    const options = {
        url: defaultUrl.replace(/\/+$/, ''),
        durationMs: 2200,
        samplesPerAgent: 120,
        output: null,
        headed: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help') { usage(); process.exit(0); }
        if (arg === '--headed') { options.headed = true; continue; }
        const [flag, inline] = arg.split('=', 2);
        if (!['--url', '--duration-ms', '--samples-per-agent', '--output'].includes(flag)) {
            throw new Error(`Unknown argument: ${arg}`);
        }
        const value = inline ?? argv[++index];
        if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
        if (flag === '--url') options.url = value.replace(/\/+$/, '');
        if (flag === '--duration-ms') options.durationMs = Number(value);
        if (flag === '--samples-per-agent') options.samplesPerAgent = Number(value);
        if (flag === '--output') options.output = resolve(value);
    }
    if (!Number.isFinite(options.durationMs) || options.durationMs < 500) {
        throw new Error('duration-ms must be at least 500');
    }
    if (!Number.isInteger(options.samplesPerAgent) || options.samplesPerAgent < 6 || options.samplesPerAgent > 500) {
        throw new Error('samples-per-agent must be an integer from 6 to 500');
    }
    return options;
}

function deltaBucket(after, before, mode) {
    const end = after?.cameraMotion?.[mode] || {};
    const start = before?.cameraMotion?.[mode] || {};
    const frames = (end.frames || 0) - (start.frames || 0);
    const drawTimeMs = (end.drawTimeMs || 0) - (start.drawTimeMs || 0);
    const repaintCount = (end.repaintCount || 0) - (start.repaintCount || 0);
    const repaintTimeMs = (end.repaintTimeMs || 0) - (start.repaintTimeMs || 0);
    return {
        frames,
        drawTimeMs,
        drawAverageMs: frames > 0 ? drawTimeMs / frames : null,
        repaintCount,
        repaintTimeMs,
        repaintAverageMs: repaintCount > 0 ? repaintTimeMs / repaintCount : null,
    };
}

async function seedTrailHistory(page, samplesPerAgent) {
    return page.evaluate(sampleCount => {
        const renderer = window.__claudeVilleApp?.renderer;
        const trails = renderer?.trailRenderer;
        if (!trails) throw new Error('TrailRenderer unavailable');
        trails.samplesByAgent.clear();
        trails.pending.length = 0;
        trails._totalSamples = 0;
        const agents = [...renderer.agentSprites.values()].map(sprite => sprite.agent).filter(Boolean);
        const now = Date.now();
        for (let agentIndex = 0; agentIndex < agents.length; agentIndex++) {
            const agent = agents[agentIndex];
            const baseX = 6 + (agentIndex % 12) * 2.5;
            const baseY = 11 + (Math.floor(agentIndex / 12) % 7) * 3.1;
            for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
                const phase = sampleIndex / Math.max(1, sampleCount - 1);
                trails._addSample({
                    id: `${agent.id}:benchmark:${sampleIndex}`,
                    agentId: agent.id,
                    ts: now - (sampleCount - sampleIndex) * 1000,
                    tileX: baseX + Math.sin(phase * Math.PI * 2 + agentIndex) * 4 + phase * 5,
                    tileY: baseY + Math.cos(phase * Math.PI * 2 + agentIndex * 0.7) * 3 + phase * 4,
                    phase: sampleIndex % 4 === 0 ? 'dusk' : 'afternoon',
                }, false);
            }
        }
        trails._enforceGlobalCap();
        trails._needsRepaint = true;
        // Freeze persistence/capture ownership: this benchmark measures camera
        // motion against one immutable history, not one-second sample arrivals.
        trails.releaseLease?.();
        trails.store = null;
        return trails.getDiagnostics();
    }, samplesPerAgent);
}

async function configureMode(page, mode, durationMs) {
    await page.evaluate(({ nextMode, measurementMs }) => {
        window.__cvStopTrailBenchmarkMotion?.();
        const renderer = window.__claudeVilleApp?.renderer;
        const camera = renderer?.camera;
        if (!camera) throw new Error('Camera unavailable');
        camera.abortDirectorGlide?.();
        camera.stopFollow?.();
        renderer.selectAgentById?.(null);
        renderer.trailRenderer?.setSelectedAgent?.(null);
        camera._momentum = null;
        camera.x = -128;
        camera.y = 704;
        camera.zoom = camera.zoomSteps?.[0] || 1;
        if (nextMode === 'manual-pan') {
            camera.noteUserInput?.();
            let active = true;
            let direction = 1;
            const origin = camera.x;
            const tick = () => {
                if (!active) return;
                camera._cameraOwner = 'user';
                camera.x += direction * 1.8;
                if (Math.abs(camera.x - origin) > 120) direction *= -1;
                requestAnimationFrame(tick);
            };
            window.__cvStopTrailBenchmarkMotion = () => { active = false; };
            requestAnimationFrame(tick);
        } else if (nextMode === 'follow') {
            const sprite = renderer.agentSprites.values().next().value;
            if (!sprite) throw new Error('No agent available for follow benchmark');
            renderer.selectAgentById?.(sprite.agent.id);
            renderer.trailRenderer?.setSelectedAgent?.(sprite.agent.id);
            camera.followAgent?.(sprite);
        } else if (nextMode === 'director-glide') {
            camera.glideToWorld?.({ minX: -850, maxX: 620, minY: 180, maxY: 1120 }, {
                duration: measurementMs + 500,
                maxZoom: 2,
                owner: 'benchmark',
            });
        }
    }, { nextMode: mode, measurementMs: durationMs });
    await page.waitForTimeout(100);
}

async function measureMode(page, mode, durationMs) {
    const before = await page.evaluate(() => window.__claudeVilleApp.renderer.trailRenderer.getDiagnostics());
    const result = await page.evaluate(async measurementMs => {
        const perfApi = window.__claudeVillePerf;
        perfApi?.startFrameProfile?.();
        const deltas = await new Promise(resolve => {
            const values = [];
            const started = performance.now();
            let previous = started;
            const tick = now => {
                if (now > started) values.push(now - previous);
                previous = now;
                if (now - started >= measurementMs) resolve(values);
                else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        deltas.sort((a, b) => a - b);
        const pct = fraction => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * fraction))] ?? null;
        return {
            frame: { samples: deltas.length, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: deltas.at(-1) ?? null },
            profile: perfApi?.stopFrameProfile?.() || null,
            postFx: window.__claudeVilleApp?.renderer?.postFx?.getDiagnostics?.() || null,
        };
    }, durationMs);
    const after = await page.evaluate(() => window.__claudeVilleApp.renderer.trailRenderer.getDiagnostics());
    await page.evaluate(() => window.__cvStopTrailBenchmarkMotion?.());
    return {
        mode,
        frame: result.frame,
        trail: deltaBucket(after, before, mode),
        trailPolicy: after.renderPolicy,
        cacheSpace: after.cacheSpace,
        cachePixels: after.highWaterCachePixels,
        postFx: result.postFx,
        renderSegments: result.profile?.renderTimings?.segments || [],
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
    });
    await context.addInitScript(() => {
        try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const url = new URL(options.url);
    url.searchParams.set('sim', '1');
    url.searchParams.set('scenario', 'dense-100-agents');

    try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => {
            const app = window.__claudeVilleApp;
            return app?._bootState === 'ready'
                && app?.renderer?.agentSprites?.size === 100
                && typeof window.__claudeVillePerf?.startFrameProfile === 'function';
        }, null, { timeout: 60_000 });
        await page.evaluate(() => {
            const renderer = window.__claudeVilleApp.renderer;
            renderer.cameraDirector?.setAutoMode?.(false);
            const atmosphere = renderer.atmosphereState;
            atmosphere?.setTimelineMode?.('fixed');
            atmosphere?.setHour?.(12);
            atmosphere?.setWeather?.({ type: 'clear', intensity: 0, precipitation: 0, fog: 0, seed: 4242 });
            atmosphere?.freeze?.();
        });
        const seeded = await seedTrailHistory(page, options.samplesPerAgent);
        await configureMode(page, 'stationary', options.durationMs);
        // Let the world-space cache materialize before mode deltas begin.
        await page.waitForTimeout(300);

        const cases = [];
        for (const mode of ['stationary', 'manual-pan', 'follow', 'director-glide']) {
            await configureMode(page, mode, options.durationMs);
            cases.push(await measureMode(page, mode, options.durationMs));
        }
        if (errors.length) throw new Error(`browser errors:\n${errors.map(error => `- ${error}`).join('\n')}`);
        const report = {
            schemaVersion: 1,
            capturedAt: new Date().toISOString(),
            environment: {
                machine: os.hostname(),
                platform: `${os.platform()} ${os.release()} ${os.arch()}`,
                cpu: os.cpus()[0]?.model || null,
                cpuCount: os.cpus().length,
                chromium: browser.version(),
                viewport: { width: 1920, height: 1080, dpr: 1 },
            },
            fixture: {
                scenario: 'dense-100-agents',
                samplesPerAgent: options.samplesPerAgent,
                retainedSamples: seeded.totalSamples,
            },
            cases,
            acceptance: {
                cameraMotionRepaints: Object.fromEntries(cases.map(item => [item.mode, item.trail.repaintCount])),
                passes: cases
                    .filter(item => item.mode !== 'stationary')
                    .every(item => item.trail.repaintCount === 0),
            },
        };
        const json = `${JSON.stringify(report, null, 2)}\n`;
        if (options.output) writeFileSync(options.output, json);
        process.stdout.write(json);
        if (!report.acceptance.passes) process.exitCode = 1;
    } finally {
        await page.evaluate(() => window.__cvStopTrailBenchmarkMotion?.()).catch(() => {});
        await context.close();
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
