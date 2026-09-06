#!/usr/bin/env node

import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const defaultManifest = join(repoRoot, 'scripts', 'world', 'render-baseline-manifest.json');
const defaultOutput = join(repoRoot, 'output', 'render-baselines', 'current');
const defaultUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';

const WEATHER = Object.freeze({
    clear: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.08, windX: 0 },
    rain: { type: 'rain', intensity: 0.82, precipitation: 0.9, fog: 0.16, cloudCover: 0.92, windX: -0.4 },
    storm: { type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78 },
});

function usage() {
    console.log(`Usage: node scripts/world/capture-render-baselines.mjs [options]

Options:
  --url=<url>             Maintained ClaudeVille server (default: ${defaultUrl})
  --manifest=<path>       Capture manifest (default: scripts/world/render-baseline-manifest.json)
  --out-dir=<path>        Output directory (default: output/render-baselines/current)
  --only=<id,...>         Capture only the named manifest entries
  --modes=<mode,...>      Subset of webgl,postfx,canvas (default: manifest modes)
  --profile-ms=<n>        Per-output frame sample window (default: 1500)
  --machine=<label>       Reference machine label stored with every capture
  --power-state=<label>   ac, battery, balanced, performance, or unknown
  --headed                Show Chromium
  --dry-run               Validate and print the expanded capture matrix
  --help                  Print this help

The script only loads ?sim=1 deterministic fixtures. It never reads or mutates
provider session data. WebGL records the GPU-resident path, PostFX records the
flattened Canvas upload path and pins FULL only for its source still, and Canvas
uses ?renderer=canvas&postfx=0.`);
}

function parseList(value) {
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
    const options = {
        url: defaultUrl.replace(/\/+$/, ''),
        manifest: defaultManifest,
        outDir: defaultOutput,
        only: [],
        modes: [],
        profileMs: 1500,
        machine: os.hostname(),
        powerState: 'unknown',
        headed: false,
        dryRun: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help') { usage(); process.exit(0); }
        if (arg === '--headed') { options.headed = true; continue; }
        if (arg === '--dry-run') { options.dryRun = true; continue; }
        const [flag, inline] = arg.split('=', 2);
        if (!['--url', '--manifest', '--out-dir', '--only', '--modes', '--profile-ms', '--machine', '--power-state'].includes(flag)) {
            throw new Error(`Unknown argument: ${arg}`);
        }
        const value = inline ?? argv[++index];
        if (value == null || value === '') throw new Error(`Missing value for ${flag}`);
        if (flag === '--url') options.url = value.replace(/\/+$/, '');
        if (flag === '--manifest') options.manifest = resolve(value);
        if (flag === '--out-dir') options.outDir = resolve(value);
        if (flag === '--only') options.only = parseList(value);
        if (flag === '--modes') options.modes = parseList(value);
        if (flag === '--profile-ms') options.profileMs = Number(value);
        if (flag === '--machine') options.machine = value;
        if (flag === '--power-state') options.powerState = value;
    }
    if (!Number.isFinite(options.profileMs) || options.profileMs < 250) {
        throw new Error('profile-ms must be at least 250');
    }
    if (options.modes.some(mode => !['webgl', 'postfx', 'canvas'].includes(mode))) {
        throw new Error('modes must be a subset of webgl,postfx,canvas');
    }
    return options;
}

function readManifest(path) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest?.schemaVersion !== 1) throw new Error(`Unsupported manifest schema: ${manifest?.schemaVersion}`);
    if (!Array.isArray(manifest.captures) || !manifest.captures.length) throw new Error('Manifest has no captures');
    const ids = new Set();
    for (const capture of manifest.captures) {
        if (!capture?.id || !capture?.scenario || !capture?.viewport || !capture?.camera || !capture?.atmosphere) {
            throw new Error(`Incomplete capture entry: ${JSON.stringify(capture)}`);
        }
        if (ids.has(capture.id)) throw new Error(`Duplicate capture id: ${capture.id}`);
        ids.add(capture.id);
        if (!WEATHER[capture.atmosphere.weather]) throw new Error(`Unknown weather for ${capture.id}`);
    }
    return manifest;
}

function expandMatrix(manifest, options) {
    const viewports = new Map(manifest.reference.viewports.map(viewport => [viewport.id, viewport]));
    const modes = options.modes.length ? options.modes : manifest.reference.outputModes;
    const requested = new Set(options.only);
    if (requested.size) {
        const known = new Set(manifest.captures.map(capture => capture.id));
        for (const id of requested) if (!known.has(id)) throw new Error(`Unknown capture id: ${id}`);
    }
    return manifest.captures
        .filter(capture => !requested.size || requested.has(capture.id))
        .flatMap(capture => {
            const viewport = viewports.get(capture.viewport);
            if (!viewport) throw new Error(`Unknown viewport ${capture.viewport} for ${capture.id}`);
            return modes.map(mode => ({
                ...capture,
                viewport: { ...viewport },
                mode,
                dpr: manifest.reference.devicePixelRatio || 1,
                browserZoom: manifest.reference.browserZoom || 1,
                seed: manifest.seed || 4242,
            }));
        });
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function round(value, digits = 3) {
    return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

function cloneJson(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
}

async function collectEnvironment(page, browser, run, options) {
    const browserInfo = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            hardwareConcurrency: navigator.hardwareConcurrency ?? null,
            deviceMemoryGiB: navigator.deviceMemory ?? null,
            devicePixelRatio: window.devicePixelRatio,
            webglVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl?.getParameter?.(gl.VENDOR) || null,
            webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter?.(gl.RENDERER) || null,
            webglVersion: gl?.getParameter?.(gl.VERSION) || null,
        };
    });
    return {
        capturedAt: new Date().toISOString(),
        referenceMachine: options.machine,
        powerState: options.powerState,
        os: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpuModel: os.cpus()[0]?.model || null,
            cpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            loadAverage: os.loadavg(),
        },
        chromium: {
            version: browser.version(),
            ...browserInfo,
        },
        viewport: { width: run.viewport.width, height: run.viewport.height },
        devicePixelRatio: run.dpr,
        browserZoom: run.browserZoom,
    };
}

async function freezeFixture(page, timelineMs) {
    if (timelineMs > 0) await page.waitForTimeout(timelineMs);
    await page.evaluate(() => {
        const simulator = window.__claudeVilleApp?.agentSimulator;
        if (!simulator) return;
        for (const handle of simulator._timers || []) clearTimeout(handle);
        simulator._timers = [];
    });
}

async function configureCapture(page, run) {
    const weather = { ...WEATHER[run.atmosphere.weather], seed: run.seed };
    await page.evaluate(async ({ capture, weatherProfile }) => {
        const app = window.__claudeVilleApp;
        const renderer = app?.renderer;
        renderer?.cameraDirector?.setAutoMode?.(false);
        const atmosphere = renderer?.atmosphereState || window.__claudeVilleAtmosphere;
        atmosphere?.setTimelineMode?.('fixed');
        atmosphere?.setHour?.(capture.atmosphere.hour);
        atmosphere?.setSeed?.(capture.seed);
        atmosphere?.setWeather?.(weatherProfile);
        atmosphere?.freeze?.();

        if (capture.agentOverride?.id) {
            app?.world?.updateAgent?.(capture.agentOverride.id, {
                status: capture.agentOverride.status,
                currentTool: null,
                currentToolInput: null,
                lastMessage: capture.agentOverride.lastMessage || null,
            });
            renderer?.selectAgentById?.(capture.agentOverride.id);
            renderer?.onAgentSelect?.(app?.world?.agents?.get?.(capture.agentOverride.id) || null);
        }
        if (capture.pinAgentPositions) {
            const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
            const specs = app.agentSimulator.getScenario().agents;
            for (const spec of specs) {
                if (!spec.position) continue;
                const sprite = renderer.agentSprites.get(spec.id);
                if (!sprite) throw new Error(`Missing posed actor ${spec.id}`);
                const point = tileToWorld(spec.position);
                sprite.x = sprite.targetX = point.x;
                sprite.y = sprite.targetY = point.y;
                sprite.moving = false;
                sprite.waypoints = [];
                // Static art comparisons intentionally exclude actor locomotion.
                sprite.update = () => {};
            }
        }
        if (capture.camera.centerTile) {
            const { tileToWorld } = await import('/src/presentation/character-mode/Projection.js');
            const center = tileToWorld(capture.camera.centerTile);
            renderer.camera.stopFollow();
            window.cameraSet?.({ ...center, zoom: capture.camera.zoom });
        }
        if (capture.camera.mode === 'absolute') {
            window.cameraSet?.({ x: capture.camera.x, y: capture.camera.y, zoom: capture.camera.zoom });
        }
    }, { capture: run, weatherProfile: weather });
    await page.waitForTimeout(500);
}

async function profileCapture(page, durationMs) {
    return page.evaluate(async measurementMs => {
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
        const profile = perfApi?.stopFrameProfile?.() || null;
        const sorted = [...deltas].sort((a, b) => a - b);
        const pct = fraction => sorted.length
            ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
            : null;
        const renderer = window.__claudeVilleApp?.renderer;
        const budget = perfApi?.canvasBudget?.() || null;
        const postFx = renderer?.postFx?.getDiagnostics?.() || null;
        const postFxFeed = renderer?.postFxFeed?.getDiagnostics?.() || null;
        const trails = renderer?.trailRenderer?.getDiagnostics?.() || null;
        const sprites = [...(renderer?.agentSprites?.values?.() || [])];
        const tierFor = sprite => {
            const status = String(sprite?.agent?.status || '').toLowerCase();
            if (sprite?.selected || ['waiting_on_user', 'errored'].includes(status)) return 'primary';
            if (['completed'].includes(status)) return 'recent';
            if (['working', 'waiting', 'rate_limited'].includes(status)) return 'working';
            return 'ambient';
        };
        const census = {
            version: 1,
            sprites: sprites.length,
            bubbles: { total: 0, byTier: { primary: 0, recent: 0, working: 0, ambient: 0 } },
            labels: { total: 0, byTier: { primary: 0, recent: 0, working: 0, ambient: 0 } },
            plaques: renderer?.world?.buildings?.size ?? null,
            marks: renderer?.markGovernor?.getDiagnostics?.() || null,
            particles: renderer?.particleSystem?.particles?.length
                ?? renderer?._lastRenderStats?.canvas?.particles
                ?? null,
        };
        for (const sprite of sprites) {
            const tier = tierFor(sprite);
            const bubbleVisible = !sprite.bubbleSuppressed && !sprite.bubbleMergedInto && !sprite.foldedIntoBuilding;
            if (bubbleVisible) {
                census.bubbles.total++;
                census.bubbles.byTier[tier]++;
            }
            const labelVisible = sprite.nameTagSlot != null || sprite.overlaySlot != null;
            if (labelVisible) {
                census.labels.total++;
                census.labels.byTier[tier]++;
            }
        }
        return {
            frames: {
                samples: deltas.length,
                p50Ms: pct(0.5),
                p95Ms: pct(0.95),
                maxMs: sorted.at(-1) ?? null,
            },
            profile,
            postFx,
            postFxFeed,
            trails,
            canvasBudget: budget,
            frameFailures: budget?.runtime?.frameFailures || null,
            renderStats: renderer?._lastRenderStats || null,
            overlayCensus: census,
            camera: renderer?.camera ? {
                x: renderer.camera.x,
                y: renderer.camera.y,
                zoom: renderer.camera.zoom,
                owner: renderer.camera._cameraOwner || null,
            } : null,
            atmosphere: renderer?._lastAtmosphere ? {
                phase: renderer._lastAtmosphere.phase,
                hour: renderer._lastAtmosphere.clock?.hour ?? null,
                weather: renderer._lastAtmosphere.weather?.type || null,
                reducedMotion: renderer.motionScale === 0,
            } : null,
            agents: renderer?.agentSprites?.size ?? null,
        };
    }, durationMs);
}

async function collectOverlaySignature(page) {
    return page.evaluate(() => {
        const renderer = window.__claudeVilleApp?.renderer;
        const sprites = [...(renderer?.agentSprites?.values?.() || [])];
        const primary = sprites.filter(sprite => (
            sprite.selected
            || ['waiting_on_user', 'errored'].includes(String(sprite?.agent?.status || '').toLowerCase())
        ));
        const visiblePrimaryLabels = primary.filter(sprite => sprite.nameTagSlot != null || sprite.overlaySlot != null).length;
        const visiblePrimaryBubbles = primary.filter(sprite => !sprite.bubbleSuppressed && !sprite.bubbleMergedInto).length;
        const overlay = document.getElementById('worldOverlayCanvas');
        const summary = document.getElementById('worldSemanticSummary');
        return {
            primaryAgents: primary.length,
            visiblePrimaryLabels,
            visiblePrimaryBubbles,
            overlayVisible: overlay ? getComputedStyle(overlay).display !== 'none' : false,
            overlayWidth: overlay?.width || 0,
            overlayHeight: overlay?.height || 0,
            semanticSummary: summary?.textContent || '',
        };
    });
}

function summarizeProfile(profile) {
    const samples = profile?.profile?.samples || [];
    const summary = key => {
        const values = samples.map(sample => Number(sample[key])).filter(Number.isFinite);
        return { p50Ms: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)) };
    };
    return {
        frames: {
            samples: profile.frames.samples,
            p50Ms: round(profile.frames.p50Ms),
            p95Ms: round(profile.frames.p95Ms),
            maxMs: round(profile.frames.maxMs),
        },
        update: summary('updateMs'),
        render: summary('renderMs'),
        total: summary('totalMs'),
        renderSegments: cloneJson(profile.profile?.renderTimings?.segments || []),
    };
}

async function runCapture(browser, run, options) {
    const context = await browser.newContext({
        viewport: { width: run.viewport.width, height: run.viewport.height },
        deviceScaleFactor: run.dpr,
        reducedMotion: run.reducedMotion ? 'reduce' : 'no-preference',
    });
    await context.addInitScript(() => {
        try { localStorage.setItem('cv-auto-camera', '0'); } catch {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    const url = new URL(options.url);
    url.searchParams.set('sim', '1');
    url.searchParams.set('scenario', run.scenario);
    url.searchParams.set('renderer', run.mode === 'webgl' ? 'webgl' : 'canvas');
    url.searchParams.set('postfx', run.mode === 'canvas' ? '0' : '1');

    try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(expected => {
            const app = window.__claudeVilleApp;
            const count = app?.renderer?.agentSprites?.size;
            return app?._bootState === 'ready'
                && typeof window.cameraSet === 'function'
                && typeof window.__claudeVillePerf?.canvasBudget === 'function'
                && (expected.agents == null || count === expected.agents)
                && (expected.agentsMin == null || count >= expected.agentsMin);
        }, run.expected || {}, { timeout: 60_000 });
        await freezeFixture(page, Number(run.timelineMs) || 0);
        await configureCapture(page, run);
        const environment = await collectEnvironment(page, browser, run, options);
        const measured = await profileCapture(page, options.profileMs);
        const adaptiveOverlay = await collectOverlaySignature(page);

        let captureLevelOverride = null;
        if (run.mode === 'postfx') {
            captureLevelOverride = await page.evaluate(() => {
                const postFx = window.__claudeVilleApp?.renderer?.postFx;
                return postFx?.setLevelOverride?.(0) ?? null;
            });
            await page.waitForTimeout(250);
        }
        const captureOverlay = await collectOverlaySignature(page);
        if (errors.length) throw new Error(`browser errors:\n${errors.map(error => `- ${error}`).join('\n')}`);
        const baseName = `${run.id}--${run.mode}`;
        const imagePath = join(options.outDir, `${baseName}.png`);
        await page.screenshot({ path: imagePath, fullPage: false });
        const result = {
            schemaVersion: 1,
            id: run.id,
            mode: run.mode,
            scenario: run.scenario,
            declared: {
                viewport: run.viewport,
                dpr: run.dpr,
                browserZoom: run.browserZoom,
                reducedMotion: Boolean(run.reducedMotion),
                camera: run.camera,
                atmosphere: run.atmosphere,
                expected: run.expected,
                northStar: Boolean(run.northStar),
                overlayCensus: Boolean(run.overlayCensus),
            },
            environment,
            performance: summarizeProfile(measured),
            diagnostics: {
                postFx: cloneJson(measured.postFx),
                postFxFeed: cloneJson(measured.postFxFeed),
                trails: cloneJson(measured.trails),
                canvasBudget: cloneJson(measured.canvasBudget),
                frameFailures: cloneJson(measured.frameFailures),
                renderStats: cloneJson(measured.renderStats),
                overlayLevelStability: {
                    adaptive: adaptiveOverlay,
                    capture: captureOverlay,
                    primaryAgentsStable: adaptiveOverlay.primaryAgents === captureOverlay.primaryAgents,
                    primaryLabelsStable: adaptiveOverlay.visiblePrimaryLabels === captureOverlay.visiblePrimaryLabels,
                    overlayVisible: adaptiveOverlay.overlayVisible && captureOverlay.overlayVisible,
                },
            },
            actual: {
                agents: measured.agents,
                camera: cloneJson(measured.camera),
                atmosphere: cloneJson(measured.atmosphere),
                adaptivePostFxLevel: measured.postFx?.level ?? null,
                captureLevelOverride,
                overlayCensus: run.overlayCensus ? cloneJson(measured.overlayCensus) : null,
            },
            artifacts: {
                screenshot: imagePath,
                metadata: join(options.outDir, `${baseName}.json`),
            },
        };
        writeFileSync(result.artifacts.metadata, `${JSON.stringify(result, null, 2)}\n`);
        return result;
    } finally {
        await context.close();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const manifest = readManifest(options.manifest);
    const matrix = expandMatrix(manifest, options);
    if (options.dryRun) {
        console.log(JSON.stringify({ manifest: options.manifest, captures: matrix }, null, 2));
        return;
    }
    mkdirSync(options.outDir, { recursive: true });
    const browser = await chromium.launch({ headless: !options.headed });
    const results = [];
    try {
        for (const run of matrix) {
            const result = await runCapture(browser, run, options);
            results.push(result);
            console.log(JSON.stringify({
                captured: `${run.id}--${run.mode}`,
                frameP95Ms: result.performance.frames.p95Ms,
                postFxLevel: result.actual.adaptivePostFxLevel,
                textureBytes: result.diagnostics.canvasBudget?.gpu?.textureBytes ?? result.diagnostics.postFx?.textureBytes ?? 0,
                trailRepaintMs: result.diagnostics.trails?.repaintTimeMs ?? 0,
            }));
        }
    } finally {
        await browser.close();
    }
    const runSummary = {
        schemaVersion: 1,
        manifest: options.manifest,
        outputDirectory: options.outDir,
        captures: results.map(result => result.artifacts.metadata),
    };
    const summaryPath = join(options.outDir, 'capture-run.json');
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, `${JSON.stringify(runSummary, null, 2)}\n`);
    console.log(`Captured ${results.length} deterministic renderer baselines to ${options.outDir}`);
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
