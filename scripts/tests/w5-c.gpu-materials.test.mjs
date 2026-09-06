import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentGpuOverlayRenderer } from '../../claudeville/src/presentation/character-mode/AgentGpuOverlayRenderer.js';
import {
    DISTRICT_LIGHTING_BANDS,
    buildDistrictAtmosphere,
    createDistrictAtmosphereBuffer,
    quantizeDistrictLightingBand,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import {
    DEFAULT_PROVIDER_MATERIAL_CLASS,
    gpuMaterialNameForProvider,
    packGpuAgentFrameAtlas,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import {
    createGpuTimingMetricsScratch,
    materialClassId,
    selectGpuTimingMetrics,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { SceneCategoryRegistry } from '../../claudeville/src/presentation/character-mode/SceneCategoryRegistry.js';
import { createPostFxFeed } from '../../claudeville/src/presentation/character-mode/postfx/PostFxFeed.js';

function fakeCanvas(width = 0, height = 0, drawLog = []) {
    const canvas = {
        width,
        height,
        getContext() {
            return {
                imageSmoothingEnabled: false,
                clearRect() {},
                fillRect() {},
                drawImage(...args) {
                    drawLog.push({ canvas, args });
                },
            };
        },
    };
    return canvas;
}

test('agent overlay and profile lookup use the provider table for every provider', () => {
    assert.equal(gpuMaterialNameForProvider('codex'), 'metal');
    assert.equal(gpuMaterialNameForProvider('gemini'), 'glass-rune');
    assert.equal(gpuMaterialNameForProvider('deepseek'), 'earth');
    assert.equal(gpuMaterialNameForProvider('zai'), 'fabric');
    assert.equal(gpuMaterialNameForProvider('unknown-provider'), DEFAULT_PROVIDER_MATERIAL_CLASS);

    const source = { width: 16, height: 16 };
    const material = { width: 16, height: 16 };
    const emissive = { width: 16, height: 16 };
    const host = {
        gpuWorldEnabled: true,
        spriteCanvas: source,
        _gpuBaseSpriteCanvas: source,
        agent: { id: 'gemini-1', provider: 'gemini', status: 'idle', isDeparted: false },
        assets: {
            assetVersion: 'assets-v1',
            getSidecar(_id, channel) {
                return channel === 'material' ? material : emissive;
            },
        },
    };
    const overlay = new AgentGpuOverlayRenderer(host);
    overlay.setFrameRecord({
        cell: { sx: 0, sy: 0, sw: 8, sh: 8 },
        dx: 10,
        dy: 20,
        drawScale: 1,
        profileKey: 'gemini-profile',
        spriteId: 'agent.gemini.base',
    });

    assert.equal(host._gpuFrameRecord.material, 'glass-rune');
    assert.equal(host._gpuFrameRecord.materialSource, material);
    assert.equal(host._gpuFrameRecord.emissiveSource, emissive);
    assert.equal(host._gpuFrameRecord.channelRevision, 'assets-v1');
});

test('agent atlas packing preserves matching authored material and emissive frames', () => {
    const previousDocument = globalThis.document;
    const drawLog = [];
    globalThis.document = { createElement: () => fakeCanvas(0, 0, drawLog) };
    try {
        const record = {
            id: 'agent:gemini-1',
            stableKey: 'gemini-1',
            textureKey: 'agent-sheet:gemini',
            source: fakeCanvas(8, 8, drawLog),
            materialSource: fakeCanvas(8, 8, drawLog),
            emissiveSource: fakeCanvas(8, 8, drawLog),
            sourceWidth: 8,
            sourceHeight: 8,
            sx: 0,
            sy: 0,
            sw: 8,
            sh: 8,
            width: 8,
            height: 8,
            textureRevision: 'profile-v1',
            channelRevision: 'assets-v1',
            sidecarRevision: 'assets-v1',
        };
        const renderer = { agentSprites: new Map([['gemini-1', {}]]) };
        const [packed] = packGpuAgentFrameAtlas(renderer, [record]);

        assert.equal(packed.source, renderer._gpuAgentFrameAtlas);
        assert.equal(packed.materialSource, renderer._gpuAgentMaterialAtlas);
        assert.equal(packed.emissiveSource, renderer._gpuAgentEmissiveAtlas);
        assert.equal(packed.sidecarKey, 'agent-frame-atlas:channels');
        assert.ok(drawLog.length >= 3, 'albedo, material, and emissive atlases should all be populated');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('agent atlas revisions expose changed slots for incremental GPU uploads', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => fakeCanvas() };
    try {
        const source = fakeCanvas(16, 16);
        const record = {
            id: 'agent:codex-1',
            textureKey: 'agent-sheet:codex',
            source,
            sourceWidth: 16,
            sourceHeight: 16,
            sx: 0,
            sy: 0,
            sw: 8,
            sh: 8,
            width: 8,
            height: 8,
            textureRevision: 'frame-1',
        };
        const renderer = { agentSprites: new Map([['codex-1', {}]]) };
        packGpuAgentFrameAtlas(renderer, [record]);

        renderer._gpuAgentAtlasUpdatedAt = -Infinity;
        record.source = source;
        record.sx = 8;
        record.textureRevision = 'frame-2';
        const [packed] = packGpuAgentFrameAtlas(renderer, [record]);

        assert.equal(packed.textureUpdates.length, 1);
        assert.deepEqual(
            { x: packed.textureUpdates[0].x, y: packed.textureUpdates[0].y },
            { x: 0, y: 0 },
        );
        assert.equal(packed.textureUpdates[0].source.width, 8);
        assert.equal(packed.textureUpdates[0].source.height, 8);
        assert.notEqual(packed.textureUpdates[0].source, renderer._gpuAgentFrameAtlas);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('GPU textures use slot uploads after allocating atlas storage', () => {
    const calls = { full: 0, sub: 0 };
    const gl = {
        TEXTURE_2D: 1,
        TEXTURE_MIN_FILTER: 2,
        TEXTURE_MAG_FILTER: 3,
        TEXTURE_WRAP_S: 4,
        TEXTURE_WRAP_T: 5,
        NEAREST: 6,
        CLAMP_TO_EDGE: 7,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 8,
        UNPACK_FLIP_Y_WEBGL: 9,
        RGBA: 10,
        UNSIGNED_BYTE: 11,
        createTexture: () => ({}),
        bindTexture() {},
        texParameteri() {},
        pixelStorei() {},
        texImage2D() { calls.full++; },
        texSubImage2D() { calls.sub++; },
    };
    const renderer = Object.create(GpuWorldRenderer.prototype);
    Object.assign(renderer, {
        gl,
        frames: 0,
        uploads: 0,
        uploadBytes: 0,
        _frameUploadMs: 0,
        _textureEntries: new Map(),
        _updateTextureBytes() {},
    });
    const atlas = fakeCanvas(64, 64);
    const slot = fakeCanvas(8, 8);

    renderer._textureFor('agent-frame-atlas', atlas, 1);
    renderer._textureFor('agent-frame-atlas', atlas, 2, [{
        x: 8,
        y: 16,
        width: 8,
        height: 8,
        source: slot,
    }]);
    renderer._textureFor('agent-frame-atlas', atlas, 3, [{
        x: 60,
        y: 60,
        width: 8,
        height: 8,
        source: slot,
    }]);

    assert.deepEqual(calls, { full: 2, sub: 1 });
    assert.equal(renderer.uploadBytes, (64 * 64 * 4 * 2) + (8 * 8 * 4));
});

test('district lighting selects contract bands while district haze remains independently feathered', () => {
    assert.deepEqual([...DISTRICT_LIGHTING_BANDS], [0.72, 0.86, 1, 1.12]);
    assert.equal(quantizeDistrictLightingBand(0.8, 'dim'), 0.72);
    assert.equal(quantizeDistrictLightingBand(0.15, 'cool'), 0.86);
    assert.equal(quantizeDistrictLightingBand(0.8, 'warm'), 1.12);
    assert.equal(quantizeDistrictLightingBand(0, 'cool'), 0);

    const buffer = createDistrictAtmosphereBuffer();
    const first = buildDistrictAtmosphere([{
        project: '/repos/failing',
        agentIds: ['agent-1'],
        storminess: 0.8,
        clearing: 0,
    }], buffer);
    const descriptor = first[0];
    assert.deepEqual(descriptor.lightingBias, { cool: 0.72, warm: 0, dim: 0.72 });
    assert.ok(descriptor.groundHaze.alpha > 0);

    const second = buildDistrictAtmosphere([{
        project: '/repos/quiet',
        agentIds: ['agent-2'],
        storminess: 0,
        clearing: 0.8,
    }], buffer);
    assert.equal(second, first);
    assert.equal(second[0], descriptor);
    assert.deepEqual(second[0].lightingBias, { cool: 0, warm: 1.12, dim: 0 });
});

test('frame feeds reuse light slots, scene registry containers, and timing envelopes', () => {
    const feed = createPostFxFeed();
    const renderer = {
        canvas: { width: 320, height: 200, _claudeVilleDpr: 1 },
        camera: { zoom: 1, worldToScreen(x, y) { return { x, y }; } },
        _frameLightSources: {
            ambient: [{ id: 'forge', x: 80, y: 80, color: '#ff8033' }],
        },
    };
    const firstLights = feed.build({ renderer, nowMs: 1 }).lights;
    const firstSlot = firstLights[0];
    const secondLights = feed.build({ renderer, nowMs: 2 }).lights;
    assert.equal(secondLights, firstLights);
    assert.equal(secondLights[0], firstSlot);
    feed.dispose();

    const category = {
        id: 'scratch-category',
        sortBand: 1,
        enumerate: () => [{ id: 'item' }],
        emitSceneCommands: () => ({ type: 'noop' }),
        canvasFallback() {},
        unsupported: 'overlay-safe',
    };
    const registry = new SceneCategoryRegistry([category]);
    const frame = registry.enumerate();
    const resolution = registry.resolve(frame, { id: 'gpu', supportsSceneCommands: () => true });
    const nextFrame = registry.enumerate();
    const nextResolution = registry.resolve(nextFrame, { id: 'gpu', supportsSceneCommands: () => true });
    assert.equal(nextFrame, frame);
    assert.equal(nextResolution, resolution);
    assert.equal(nextResolution.categories[0], resolution.categories[0]);
    assert.equal(nextResolution.nativeCommandBatches[0], resolution.nativeCommandBatches[0]);

    const timingScratch = createGpuTimingMetricsScratch();
    const cpu = selectGpuTimingMetrics({ shaderCpuMs: 3 }, timingScratch);
    const gpu = selectGpuTimingMetrics({ gpuTimerSupported: true, gpuMs: 8 }, timingScratch);
    assert.equal(cpu, timingScratch.cpu);
    assert.equal(gpu, timingScratch.gpu);
    assert.deepEqual(cpu.metrics, { uploadMs: 0, frameGapMs: 0, shaderCpuMs: 3 });
    assert.deepEqual(gpu.metrics, { uploadMs: 0, frameGapMs: 0, gpuMs: 8 });
});

test('provider material fallback still resolves to a stable numeric class id', () => {
    assert.equal(materialClassId(gpuMaterialNameForProvider('gemini')), materialClassId('glass-rune'));
    assert.equal(materialClassId(gpuMaterialNameForProvider('unlisted')), materialClassId('unlit'));
});
