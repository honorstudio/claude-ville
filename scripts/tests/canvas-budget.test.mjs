import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CANVAS_BUDGET,
    effectiveCanvasDpr,
    gpuResourceAccounting,
    unifiedRendererResourceAccounting,
} from '../../claudeville/src/presentation/character-mode/CanvasBudget.js';
import { displayPixelZoomSteps } from '../../claudeville/src/presentation/character-mode/Camera.js';

test('GPU accounting names and sums textures, attachments, and buffers once', () => {
    const resources = gpuResourceAccounting({
        textures: { source: 400, waterMask: 100 },
        attachments: { sceneColor: 400, bloom: 50 },
        buffers: { vertices: 32 },
    });
    assert.deepEqual(resources.groupTotals, {
        textures: 500,
        attachments: 450,
        buffers: 32,
    });
    assert.equal(resources.totalBytes, 982);
});

test('unified accounting combines RGBA canvas pixels with GPU byte ownership', () => {
    const gpu = gpuResourceAccounting({ textures: { source: 1024 } });
    const resources = unifiedRendererResourceAccounting({
        visibleCanvasPixels: 100,
        volatileCanvasPixels: 50,
        retainedCanvasPixels: 25,
        gpu,
    });
    assert.equal(resources.canvasBytes, 175 * 4);
    assert.equal(resources.gpuBytes, 1024);
    assert.equal(resources.totalBytes, 1724);
    assert.equal(resources.budgetBytes, CANVAS_BUDGET.maxUnifiedRendererBytes);
});

// Viewports a desktop operator actually produces, paired with the device pixel
// ratios macOS/Windows report (browser zoom makes the ratio fractional).
const VIEWPORTS = [
    [1040, 746], [1488, 946], [1690, 1075], [1808, 1098],
    [2320, 1386], [2768, 1638], [3800, 2100],
];
const DEVICE_RATIOS = [0.5, 0.8, 1, 1.1, 1.25, 1.5, 2, 2.5, 3];

test('backing DPR always divides the device ratio by a whole number', () => {
    for (const ratio of DEVICE_RATIOS) {
        for (const [width, height] of VIEWPORTS) {
            const dpr = effectiveCanvasDpr(width, height, ratio);
            const upscale = ratio / dpr;
            assert.ok(dpr > 0, `non-positive dpr ${dpr} at ${width}x${height}@${ratio}`);
            assert.ok(
                Math.abs(upscale - Math.round(upscale)) < 1e-9,
                `device upscale ${upscale} is fractional at ${width}x${height}@${ratio}`,
            );
            assert.ok(Math.round(upscale) >= 1, `backing exceeds device grid at ${width}x${height}@${ratio}`);
        }
    }
});

test('backing DPR is device-native until the per-surface budget runs out', () => {
    // 1690x1075 CSS (a Retina laptop viewport) fits 4x its pixels; 2320x1386
    // (a 5K desktop viewport) does not, so it drops exactly one rung.
    assert.equal(effectiveCanvasDpr(1690, 1075, 2), 2);
    assert.equal(effectiveCanvasDpr(2320, 1386, 2), 1);
    assert.equal(effectiveCanvasDpr(1488, 946, 1), 1);
});

test('the chosen rung is the largest one that fits the per-surface budget', () => {
    for (const ratio of DEVICE_RATIOS) {
        for (const [width, height] of VIEWPORTS) {
            const dpr = effectiveCanvasDpr(width, height, ratio);
            const divisor = Math.round(ratio / dpr);
            const backingPixels = width * dpr * height * dpr;
            if (divisor === 1) {
                // Native: nothing coarser was needed.
                assert.ok(
                    backingPixels <= CANVAS_BUDGET.maxMainCanvasPixels + 1,
                    `native rung is over budget at ${width}x${height}@${ratio}`,
                );
                continue;
            }
            assert.ok(
                backingPixels <= CANVAS_BUDGET.maxMainCanvasPixels + 1,
                `${Math.round(backingPixels)} px over budget at ${width}x${height}@${ratio}`,
            );
            // The rung above must genuinely not fit, or we gave up sharpness
            // that was affordable.
            const finer = ratio / (divisor - 1);
            assert.ok(
                width * finer * height * finer > CANVAS_BUDGET.maxMainCanvasPixels,
                `rung ${finer} would have fit at ${width}x${height}@${ratio}`,
            );
        }
    }
});

// App sizes the backing store as round(css x dpr); the browser then maps it
// onto css x deviceDpr physical pixels, and THAT ratio is what the
// nearest-neighbour upscale uses. At a whole device ratio it is exactly the
// divisor. At a fractional one, rounding the backing dimension by up to half a
// backing pixel skews it by at most `divisor / 2` device pixels across the
// whole axis — one seam at worst, never the per-pixel shredding that a
// fractional backing DPR produced.
test('rounded backing dimensions still map onto a whole device-pixel block', () => {
    for (const ratio of DEVICE_RATIOS) {
        for (const [width, height] of VIEWPORTS) {
            const dpr = effectiveCanvasDpr(width, height, ratio);
            const divisor = Math.round(ratio / dpr);
            for (const cssSize of [width, height]) {
                const backing = Math.round(cssSize * dpr);
                const scale = (cssSize * ratio) / backing;
                const drift = Math.abs(scale - Math.round(scale)) * backing;
                const allowed = Number.isInteger(cssSize * ratio) && Number.isInteger(cssSize * dpr)
                    ? 1e-9
                    : divisor / 2 + 1e-9;
                assert.ok(
                    drift <= allowed,
                    `${cssSize}px @${ratio} drifts ${drift.toFixed(3)} device px (allowed ${allowed})`,
                );
            }
        }
    }
});

test('a nonsense device ratio falls back to 1 instead of hanging', () => {
    for (const bogus of [Infinity, -Infinity, NaN, 0, -2, undefined, null, 'x']) {
        const dpr = effectiveCanvasDpr(1488, 946, bogus);
        assert.ok(Number.isFinite(dpr) && dpr > 0, `bad ratio ${bogus} produced ${dpr}`);
        assert.equal(dpr, 1);
    }
});

test('every resting zoom tier lands on a whole backing pixel', () => {
    for (const ratio of DEVICE_RATIOS) {
        for (const [width, height] of VIEWPORTS) {
            const dpr = effectiveCanvasDpr(width, height, ratio);
            const steps = displayPixelZoomSteps(dpr);
            assert.equal(steps.length, 3);
            let previous = 0;
            for (const step of steps) {
                const backingScale = step * dpr;
                assert.ok(
                    Math.abs(backingScale - Math.round(backingScale)) < 1e-9,
                    `zoom ${step} at dpr ${dpr} covers ${backingScale} backing px`,
                );
                assert.ok(step > previous, `zoom tiers not increasing at dpr ${dpr}`);
                previous = step;
            }
        }
    }
});

test('zoom tiers stay the canonical [1, 2, 3] at whole device ratios', () => {
    assert.deepEqual([...displayPixelZoomSteps(1)], [1, 2, 3]);
    assert.deepEqual([...displayPixelZoomSteps(2)], [1, 2, 3]);
    // Below 1 the historical 1/dpr widening still applies.
    assert.deepEqual([...displayPixelZoomSteps(0.5)], [2, 4, 6]);
});
