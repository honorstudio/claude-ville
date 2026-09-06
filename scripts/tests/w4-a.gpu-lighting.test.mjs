import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostFxFeed } from '../../claudeville/src/presentation/character-mode/postfx/PostFxFeed.js';
import {
    GPU_LIGHT_COLOR_ENCODING,
    buildStableGpuBatches,
    clampGpuLights,
    gpuLightColorForShader,
    selectGpuTimingMetrics,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { packGpuSidecarPixels } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';

test('GPU light slots preserve authored RGB, identity, and priority', () => {
    assert.equal(GPU_LIGHT_COLOR_ENCODING, 'rgb-255');
    const renderer = {
        canvas: { width: 320, height: 200, _claudeVilleDpr: 1 },
        camera: {
            zoom: 1,
            worldToScreen(x, y) { return { x, y }; },
        },
        _frameLightSources: {
            ambient: [
                { id: 'forge', priority: 3, x: 80, y: 80, color: '#ff8033', intensity: 1 },
                { id: 'portal', priority: 9, x: 120, y: 80, color: '#8feaff', intensity: 1 },
            ],
        },
    };
    const feed = createPostFxFeed();
    try {
        const lights = feed.build({ renderer, nowMs: 10 }).lights;
        assert.deepEqual(lights.map(light => ({ id: light.id, priority: light.priority })), [
            { id: 'forge', priority: 3 },
            { id: 'portal', priority: 9 },
        ]);
        assert.deepEqual([lights[0].r, lights[0].g, lights[0].b], [255, 128, 51]);
        assert.deepEqual(gpuLightColorForShader(lights[1]), [143 / 255, 234 / 255, 255 / 255]);
        assert.equal(clampGpuLights(lights, 1)[0].id, 'portal');
    } finally {
        feed.dispose();
    }
});

test('authored emissive RGB is kept in a separate packed channel', () => {
    const packed = packGpuSidecarPixels({
        material: new Uint8ClampedArray([3, 0, 0, 255, 4, 0, 0, 255]),
        emissive: new Uint8ClampedArray([12, 34, 56, 64, 90, 80, 70, 128]),
        occluder: new Uint8ClampedArray([0, 2, 5, 255, 0, 7, 0, 0]),
        pixelCount: 2,
    });
    assert.deepEqual([...packed.emissive], [12, 34, 56, 64, 90, 80, 70, 128]);
    // B carries occluder R (authored height) and A carries occluder G (strength).
    // This assertion previously expected max(RGBA) collapsed into both, which was
    // the packing defect itself: it destroyed the height/strength distinction the
    // material contract defines.
    assert.deepEqual([...packed.packed], [3, 64, 0, 2, 4, 128, 0, 7]);

    const source = { width: 2, height: 1 };
    const materialSource = { width: 2, height: 1 };
    const emissiveSource = { width: 2, height: 1 };
    const [batch] = buildStableGpuBatches([{
        source,
        materialSource,
        emissiveSource,
        sidecarKey: 'building.forge:material',
        sourceWidth: 2,
        sourceHeight: 1,
        sw: 2,
        sh: 1,
        width: 2,
        height: 1,
    }]);
    assert.equal(batch.emissiveSource, emissiveSource);
});

test('GPU timing selects asynchronous results and falls back to CPU submission time', () => {
    const cpu = selectGpuTimingMetrics({
        uploadMs: 1,
        shaderCpuMs: 3,
        gpuMs: 8,
        gpuTimerSupported: false,
        frameGapMs: 4,
    });
    assert.equal(cpu.source, 'cpu-fallback');
    assert.deepEqual(cpu.metrics, { uploadMs: 1, frameGapMs: 4, shaderCpuMs: 3 });

    const gpu = selectGpuTimingMetrics({
        uploadMs: 1,
        shaderCpuMs: 3,
        gpuMs: 8,
        gpuTimerSupported: true,
        frameGapMs: 4,
    });
    assert.equal(gpu.source, 'gpu-timer');
    assert.deepEqual(gpu.metrics, { uploadMs: 1, frameGapMs: 4, gpuMs: 8 });

    const pending = selectGpuTimingMetrics({
        shaderCpuMs: 3,
        gpuMs: null,
        gpuTimerSupported: true,
    });
    assert.equal(pending.source, 'cpu-fallback');
    assert.equal(pending.metrics.shaderCpuMs, 3);
});

test('GPU timer polling never reads an unavailable query result', () => {
    const queryCalls = [];
    const query = { available: false, nanoseconds: 6_000_000 };
    const gl = {
        QUERY_RESULT_AVAILABLE: 'available',
        QUERY_RESULT: 'result',
        createQuery() { return query; },
        beginQuery() {},
        endQuery() {},
        getParameter() { return false; },
        getQueryParameter(current, parameter) {
            queryCalls.push(parameter);
            return parameter === 'available' ? current.available : current.nanoseconds;
        },
        deleteQuery() {},
    };
    const renderer = Object.create(GpuWorldRenderer.prototype);
    renderer.gl = gl;
    renderer.timerExtension = { TIME_ELAPSED_EXT: 'elapsed', GPU_DISJOINT_EXT: 'disjoint' };
    renderer.pendingGpuQueries = [];
    renderer.gpuMs = null;
    renderer.gpuTimerErrors = 0;

    const timer = renderer._beginGpuTimer();
    renderer._endGpuTimer(timer);
    renderer._pollGpuQueries();
    assert.deepEqual(queryCalls, ['available']);
    assert.equal(renderer.gpuMs, null);
    assert.equal(renderer.pendingGpuQueries.length, 1);

    query.available = true;
    renderer._pollGpuQueries();
    assert.deepEqual(queryCalls, ['available', 'available', 'result']);
    assert.equal(renderer.gpuMs, 6);
    assert.equal(renderer.pendingGpuQueries.length, 0);
});
