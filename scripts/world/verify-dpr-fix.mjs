// Asserts the pixel-art scaling contract that keeps in-canvas text readable:
// the world backing store is always `devicePixelRatio / n` for a whole n, so
// the browser only ever replicates pixels, and every resting camera tier puts
// one authored world pixel on a whole number of backing pixels.
//
// Requires the maintained dev server on http://localhost:4000.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright';

import { CANVAS_BUDGET } from '../../claudeville/src/presentation/character-mode/CanvasBudget.js';

const URL = process.env.CLAUDEVILLE_URL || 'http://localhost:4000';
const OUT_DIR = 'output/playwright';
// Retina laptop, non-Retina desktop, 125% browser zoom on Retina, 5K, 6K.
const CASES = [
    { width: 1488, height: 946, dpr: 2 },
    { width: 1920, height: 1080, dpr: 1 },
    { width: 1488, height: 946, dpr: 2.5 },
    { width: 2560, height: 1440, dpr: 2 },
    { width: 3008, height: 1692, dpr: 2 },
];

await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];

for (const { width, height, dpr } of CASES) {
    const label = `${width}x${height}@${dpr}`;
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    try {
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2500);
        await page.evaluate(() => window.cameraSet({ x: 0, y: 0, zoom: 1 }));
        await page.waitForTimeout(600);
        const probe = await page.evaluate(() => {
            const canvas = document.getElementById('worldCanvas');
            const camera = window.__claudeVilleApp?.renderer?.camera;
            return {
                device: window.devicePixelRatio,
                backingDpr: canvas?._claudeVilleDpr,
                cssWidth: canvas?._claudeVilleCssWidth,
                cssHeight: canvas?._claudeVilleCssHeight,
                backingWidth: canvas?.width,
                backingHeight: canvas?.height,
                zoom: camera?.zoom,
                zoomSteps: [...(camera?.zoomSteps || [])],
            };
        });

        const upscale = probe.device / probe.backingDpr;
        assert.ok(
            Math.abs(upscale - Math.round(upscale)) < 1e-9 && Math.round(upscale) >= 1,
            `${label}: backing DPR ${probe.backingDpr} is not a whole divisor of device ${probe.device}`,
        );
        // What the compositor actually samples with: physical pixels per
        // backing pixel, per axis. Rounding the backing dimension can skew it
        // by at most half a backing pixel across the axis.
        for (const [axis, cssSize, backingSize] of [
            ['width', probe.cssWidth, probe.backingWidth],
            ['height', probe.cssHeight, probe.backingHeight],
        ]) {
            assert.equal(
                backingSize,
                Math.round(cssSize * probe.backingDpr),
                `${label}: backing ${axis} is not css x dpr`,
            );
            const scale = (cssSize * probe.device) / backingSize;
            const drift = Math.abs(scale - Math.round(scale)) * backingSize;
            assert.ok(
                Math.round(scale) === Math.round(upscale) && drift <= Math.round(upscale) / 2 + 1e-9,
                `${label}: physical ${axis} scale ${scale.toFixed(6)} drifts ${drift.toFixed(3)} device px`,
            );
        }
        // Resting tiers only: the camera tween and director glides legitimately
        // pass through fractional zoom between two aligned poses.
        for (const step of probe.zoomSteps) {
            const backingScale = step * probe.backingDpr;
            assert.ok(
                Math.abs(backingScale - Math.round(backingScale)) < 1e-9,
                `${label}: zoom tier ${step} covers ${backingScale} backing px`,
            );
        }
        const backingPixels = probe.backingWidth * probe.backingHeight;
        if (Math.abs(probe.backingDpr - probe.device) > 1e-9) {
            assert.ok(
                backingPixels <= CANVAS_BUDGET.maxMainCanvasPixels,
                `${label}: downshifted rung still exceeds the per-surface budget`,
            );
        }

        await page.screenshot({ path: `${OUT_DIR}/dpr-${label}.png` });
        console.log(
            `${label}: backing dpr ${probe.backingDpr} (device upscale ${Math.round(upscale)}x), `
            + `${probe.backingWidth}x${probe.backingHeight} backing, tiers [${probe.zoomSteps.join(', ')}]`,
        );
    } catch (error) {
        failures.push(`${label}: ${error.message}`);
    } finally {
        await context.close();
    }
}

await browser.close();

if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`\nall ${CASES.length} viewports keep an integer device-pixel scale`);
}
