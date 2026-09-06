import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostFxFeed } from '../../claudeville/src/presentation/character-mode/postfx/PostFxFeed.js';

test('PostFX feed reports water-mask reuse and camera-pose rebuilds', () => {
    const originalDocument = globalThis.document;
    const maskContext = {
        imageSmoothingEnabled: true,
        setTransform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        fill() {},
    };
    globalThis.document = {
        createElement() {
            return { width: 0, height: 0, getContext: () => maskContext };
        },
    };
    const camera = {
        x: 0,
        y: 0,
        zoom: 1,
        worldToScreen(x, y) { return { x: x + this.x + 50, y: y + this.y + 50 }; },
    };
    const renderer = {
        canvas: { width: 400, height: 240, _claudeVilleDpr: 1 },
        camera,
        motionScale: 1,
        particleSystem: { motionEnabled: true },
        waterTiles: new Set(['1,1']),
        waterMeta: new Map([['1,1', { flowDirX: 1, flowDirY: 0 }]]),
        bridgeTiles: new Set(),
        _frameLightSources: { ambient: [] },
    };
    const feed = createPostFxFeed();
    try {
        feed.build({ renderer, atmosphere: { phase: 'day' }, nowMs: 10 });
        feed.build({ renderer, atmosphere: { phase: 'day' }, nowMs: 20 });
        let diagnostics = feed.getDiagnostics();
        assert.equal(diagnostics.maskRebuilds, 1);
        assert.equal(diagnostics.maskReuses, 1);
        assert.equal(diagnostics.maskLastReason, 'cache-hit');
        assert.equal(diagnostics.maskPixels, 100 * 60);

        camera.x = 2;
        feed.build({ renderer, atmosphere: { phase: 'day' }, nowMs: 30 });
        diagnostics = feed.getDiagnostics();
        assert.equal(diagnostics.maskRebuilds, 2);
        assert.equal(diagnostics.maskReasonCounts['camera-pose'], 1);
        assert.equal(feed.getCanvasBudget().volatilePixels, diagnostics.maskPixels);
    } finally {
        feed.dispose();
        globalThis.document = originalDocument;
    }
});
