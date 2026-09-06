#!/usr/bin/env node

/**
 * Capture deterministic World-mode building integration baselines.
 *
 * Every building pose is derived from BUILDING_DEFS and asserted against the
 * renderer's grounding diagnostics before a screenshot is written.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { buildingCenterToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(repoRoot, 'scripts', 'sprites', 'baselines');
mkdirSync(outDir, { recursive: true });

const baseUrl = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const fresh = process.argv.includes('--fresh');
const suffix = fresh ? '-fresh' : '';
const viewport = { width: 1280, height: 800 };
const captureHeight = 720;
const buildingPoses = Object.fromEntries(BUILDING_DEFS.map((building) => [
    building.type,
    { ...buildingCenterToWorld(building), zoom: 2 },
]));
const overviewPose = { x: -144, y: 620, zoom: 1 };
const phases = [
    { name: 'day', hour: 10 },
    { name: 'night', hour: 23 },
];

const captureUrl = new URL(baseUrl);
captureUrl.searchParams.set('sim', '1');
captureUrl.searchParams.set('scenario', 'no-agents');

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
});
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(error.message));
page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
});

try {
    await page.goto(captureUrl.href, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__claudeVilleApp?._bootState === 'ready'
        && typeof window.cameraSet === 'function', null, { timeout: 12000 });
    // These are art baselines; render-smoke owns empty-state and onboarding UI.
    await page.addStyleTag({ content: '#worldEmpty, #firstRunHint, #worldSemanticSummary, #bootStatusWrap { display: none !important; }' });
    await page.evaluate(() => {
        const renderer = window.__claudeVilleApp?.renderer;
        renderer?.cameraDirector?.setAutoMode?.(false);
        // Art comparisons pin FULL; adaptive quality is measured separately.
        // Host load otherwise changes night lighting between identical poses.
        renderer?.gpuWorld?.qualityLadder?.setOverride?.(0);
        renderer?.postFx?.setLevelOverride?.(0);
        if (renderer) renderer._drawEmptyStateWorldCue = () => {};
        const atmosphere = window.__claudeVilleAtmosphere;
        atmosphere?.setTimelineMode?.('fixed');
        atmosphere?.setWeather?.({ type: 'clear', intensity: 0, windX: 0, seed: 4242 });
        atmosphere?.setSeed?.(4242);
        atmosphere?.freeze?.();
    });

    for (const phase of phases) {
        await page.evaluate((hour) => window.__claudeVilleAtmosphere?.setHour?.(hour), phase.hour);
        await capturePose(page, `overview-${phase.name}`, overviewPose, null);
        for (const building of BUILDING_DEFS) {
            await capturePose(page, `${building.type}-${phase.name}`, buildingPoses[building.type], building.type);
        }
    }

    if (browserErrors.length) {
        throw new Error(`browser errors during capture:\n${browserErrors.map((error) => `- ${error}`).join('\n')}`);
    }
    console.log(`Done - ${phases.length * (BUILDING_DEFS.length + 1)} poses written to ${outDir}`);
} finally {
    await browser.close();
}

async function capturePose(page, name, pose, targetType) {
    const result = await page.evaluate((nextPose) => window.cameraSet(nextPose), pose);
    if (!result) throw new Error(`cameraSet failed for ${name}`);
    await page.waitForTimeout(180);

    if (targetType) {
        const target = await page.evaluate((type) => {
            const renderer = window.__claudeVilleApp?.renderer;
            const diagnostic = renderer?.buildingRenderer?.groundingDiagnostics?.()
                ?.find((entry) => entry.type === type);
            if (!renderer?.camera || !diagnostic) return null;
            const point = renderer.camera.worldToScreen(diagnostic.center.x, diagnostic.center.y);
            return {
                type: diagnostic.type,
                mode: diagnostic.mode,
                x: point.x,
                y: point.y,
                hasSprite: Boolean(diagnostic.sprite),
            };
        }, targetType);
        if (!target?.hasSprite || !target.mode) {
            throw new Error(`${name} has no sprite or grounding profile`);
        }
        const dx = Math.abs(target.x - viewport.width / 2);
        const dy = Math.abs(target.y - captureHeight / 2);
        if (dx > 170 || dy > 140) {
            throw new Error(`${name} target is not centered (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
        }
    }

    const path = join(outDir, `${name}${suffix}.png`);
    await page.screenshot({
        path,
        fullPage: false,
        clip: { x: 0, y: 60, width: viewport.width, height: captureHeight },
    });
    console.log(`captured ${path}`);
}
