import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TrailRenderer,
    classifyTrailCameraMotion,
    resolveTrailRenderPolicy,
} from '../../claudeville/src/presentation/character-mode/TrailRenderer.js';

test('trail camera motion classification distinguishes the four benchmark modes', () => {
    assert.equal(classifyTrailCameraMotion({ x: 1, y: 2, zoom: 1 }), 'stationary');
    assert.equal(classifyTrailCameraMotion({ x: 5, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 1 }), 'manual-pan');
    assert.equal(classifyTrailCameraMotion({ followTarget: {}, x: 1, y: 2, zoom: 1 }), 'follow');
    assert.equal(classifyTrailCameraMotion({ isDirectorGliding: () => true }), 'director-glide');
});

test('large trail histories stay hidden while semantic routes remain available', () => {
    const policy = resolveTrailRenderPolicy({ totalSamples: 513, selectedAgentId: 'selected' });
    assert.equal(policy.historicalMode, 'none');
    assert.equal(policy.cacheSpace, 'none');
    assert.equal(policy.repaintOnCameraMotion, false);
    assert.equal(policy.historicalVisibility, 'hidden');
    assert.equal(policy.selectedMode, 'recent-direct-overlay');
    assert.equal(policy.actionNeededMode, 'recent-direct-overlay');
});

test('small trail histories also stay hidden without allocating a cache', () => {
    const policy = resolveTrailRenderPolicy({ totalSamples: 512 });
    assert.equal(policy.historicalMode, 'none');
    assert.equal(policy.cacheSpace, 'none');
    assert.equal(policy.selectedMode, 'none');
});

test('camera motion never revives routine history and retains semantic overlays', () => {
    const follow = resolveTrailRenderPolicy({
        totalSamples: 900,
        selectedAgentId: 'selected',
        cameraMotion: 'follow',
    });
    assert.equal(follow.historicalVisibility, 'hidden');
    assert.equal(follow.selectedMode, 'recent-direct-overlay');
    assert.equal(follow.actionNeededMode, 'recent-direct-overlay');

    const glide = resolveTrailRenderPolicy({ totalSamples: 900, cameraMotion: 'director-glide' });
    assert.equal(glide.historicalVisibility, 'hidden');
});

test('camera pose changes allocate no ambient trail cache', async () => {
    const originalDocument = globalThis.document;
    const cacheContext = {
        save() {},
        restore() {},
        setTransform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
    };
    globalThis.document = {
        visibilityState: 'visible',
        createElement() {
            return {
                width: 0,
                height: 0,
                getContext: () => cacheContext,
            };
        },
    };
    const trail = new TrailRenderer();
    const samples = Array.from({ length: 600 }, (_, index) => ({
        agentId: 'agent',
        ts: 1_000 + index * 1_000,
        tileX: 4 + index * 0.01,
        tileY: 8 + index * 0.005,
        phase: 'afternoon',
    }));
    trail.samplesByAgent.set('agent', samples);
    trail._totalSamples = samples.length;
    const context = { save() {}, restore() {}, drawImage() {} };
    const camera = { x: 0, y: 0, zoom: 1, applyTransform() {} };
    const viewport = { width: 1280, height: 720, dpr: 1 };
    try {
        trail.draw(context, camera, viewport, 700_000);
        assert.equal(trail.getDiagnostics().repaintCount, 0);
        camera.x = 120;
        trail.draw(context, camera, viewport, 700_016);
        const diagnostics = trail.getDiagnostics();
        assert.equal(diagnostics.repaintCount, 0);
        assert.equal(diagnostics.cameraMotion['manual-pan'].frames, 1);
        assert.equal(diagnostics.cacheSpace, 'none');
    } finally {
        await trail.dispose();
        globalThis.document = originalDocument;
    }
});
