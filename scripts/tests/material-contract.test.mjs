import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MATERIAL_CLASS_IDS,
    companionPathFor,
    defaultChannelPixel,
    normalizeMaterialMetadata,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    buildGpuRecordsFromDrawables,
    createDepthDrawable,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import {
    BUILDING_MATERIAL_REGISTRY,
    getBuildingMaterial,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { SpriteRenderer } from '../../claudeville/src/presentation/character-mode/SpriteRenderer.js';
import { AssetManager } from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import {
    packFrames,
    stableJson,
} from '../sprites/atlas-packing.mjs';

test('material class ids and generated default pixels stay stable', () => {
    assert.deepEqual(MATERIAL_CLASS_IDS, {
        unlit: 0,
        stone: 1,
        timber: 2,
        metal: 3,
        foliage: 4,
        fabric: 5,
        earth: 6,
        cobble: 7,
        water: 8,
        'glass-rune': 9,
        fire: 10,
    });
    assert.deepEqual(defaultChannelPixel('material', 'water', 128), [8, 0, 0, 128]);
    assert.deepEqual(defaultChannelPixel('emissive', 'fire', 255), [0, 0, 0, 0]);
    assert.deepEqual(defaultChannelPixel('occluder', 'stone', 128), [0, 128, 0, 128]);
});

test('missing companion declarations stay absent and true uses deterministic paths', () => {
    const entry = { id: 'building.command' };
    assert.equal(companionPathFor(entry, 'emissive', 'assets/sprites/buildings/building.command/base.png'), null);
    assert.equal(
        companionPathFor(
            { ...entry, emissiveSidecar: true },
            'emissive',
            'assets/sprites/buildings/building.command/base.png',
        ),
        'assets/sprites/buildings/building.command/base.emissive.png',
    );
    assert.equal(
        companionPathFor({ ...entry, emissiveSidecar: 'custom/glow.png' }, 'emissive', 'ignored.png'),
        'custom/glow.png',
    );
});

test('material normalization supplies safe non-emissive defaults', () => {
    const defaults = normalizeMaterialMetadata({ id: 'prop.unknown' });
    assert.equal(defaults.materialId, 'prop.unknown');
    assert.equal(defaults.materialClass, 'unlit');
    assert.equal(defaults.emissive.strength, 0);
    assert.equal(defaults.occluder.mode, 'alpha-silhouette');
    assert.deepEqual(defaults.elevation, { base: 0, top: 0, unit: 'sprite-px' });
});

test('all nine building pilots expose named emissive material sources', () => {
    const expected = [
        'archive', 'command', 'forge', 'harbor', 'mine',
        'observatory', 'portal', 'taskboard', 'watchtower',
    ];
    assert.deepEqual(Object.keys(BUILDING_MATERIAL_REGISTRY).sort(), expected);
    const sourceIds = [];
    for (const type of expected) {
        const material = getBuildingMaterial(type);
        assert.equal(material.materialId, `building.${type}`);
        assert.notEqual(material.materialClass, 'unlit');
        assert.ok(material.emissive.sources.length >= 1);
        sourceIds.push(...material.emissive.sources.map((source) => source.id));
    }
    assert.equal(new Set(sourceIds).size, sourceIds.length);
});

test('drawable Canvas fallback is preserved while GPU records are additive', () => {
    const calls = [];
    const payload = {
        id: 'building.command',
        entry: {
            id: 'building.command',
            materialClass: 'stone',
            elevation: { base: 0, top: 208, unit: 'sprite-px' },
        },
    };
    const drawable = createDepthDrawable(
        'building',
        Number.NaN,
        payload,
        (ctx, zoom, context, source) => calls.push({ ctx, zoom, context, source }),
        {
            salience: 'primary',
            buildGpuRecord: () => ({ type: 'sprite-quad', assetId: 'building.command' }),
        },
    );
    const ctx = {};
    const context = { frame: 1 };
    drawable.draw(ctx, 2, context);
    assert.deepEqual(calls, [{ ctx, zoom: 2, context, source: payload }]);
    assert.equal(drawable.sortY, 0);
    assert.equal(drawable.materialClass, 'stone');
    assert.equal(drawable.salience, 'primary');
    assert.deepEqual(buildGpuRecordsFromDrawables([drawable]), [{
        kind: 'building',
        sortY: 0,
        sortBand: 95,
        stableKey: 'building.command',
        salience: 'primary',
        materialId: 'building.command',
        materialClass: 'stone',
        elevation: { base: 0, top: 208, unit: 'sprite-px' },
        emissive: { strength: 0, sources: [] },
        occluder: { mode: 'alpha-silhouette', strength: 1 },
        atlasFrame: null,
        type: 'sprite-quad',
        assetId: 'building.command',
        drawOrder: 0,
    }]);
});

test('SpriteRenderer GPU placement matches Canvas integer anchor rounding', () => {
    const drawCalls = [];
    const assets = {
        get: () => ({ width: 32, height: 32 }),
        getDims: () => ({ w: 32, h: 32 }),
        getAnchor: () => [16, 28],
        getEntry: () => ({ id: 'prop.lantern', materialClass: 'metal' }),
        getAtlasFrame: () => ({ atlas: 'world-pilot', key: 'prop.lantern', rect: { x: 2, y: 2, w: 32, h: 32 } }),
        getMaterialChannels: () => ({ albedo: {}, material: null, emissive: null, occluder: null }),
    };
    const renderer = new SpriteRenderer(assets);
    renderer.drawSprite({
        globalAlpha: 1,
        drawImage: (...args) => drawCalls.push(args),
    }, 'prop.lantern', 100.4, 75.6);
    const record = renderer.buildGpuRecord('prop.lantern', 100.4, 75.6);
    assert.equal(drawCalls.length, 1);
    assert.deepEqual(drawCalls[0].slice(1), [84, 48]);
    assert.deepEqual(record.destination, { x: 84, y: 48, w: 32, h: 32 });
    assert.equal(record.sampling, 'nearest');
    assert.equal(record.materialClass, 'metal');
    assert.equal(record.material, MATERIAL_CLASS_IDS.metal);
    assert.deepEqual({ sx: record.sx, sy: record.sy, sw: record.sw, sh: record.sh }, {
        sx: 0, sy: 0, sw: 32, sh: 32,
    });
});

test('SpriteRenderer addresses character atlas frames in frame-local coordinates', () => {
    const atlas = { width: 2048, height: 2048 };
    const assets = {
        assetVersion: 'fixture',
        get: () => ({ width: 736, height: 920 }),
        getDims: () => ({ w: 736, h: 920 }),
        getAnchor: () => [46, 80],
        getEntry: () => ({
            id: 'agent.claude.opus',
            materialClass: 'fabric',
            atlasFrame: { atlas: 'world-pilot', keyPrefix: 'agent.claude.opus' },
        }),
        getAtlasFrame: () => ({
            atlas: 'world-pilot',
            key: 'agent.claude.opus/walk/s/0',
            rect: { x: 400, y: 700, w: 92, h: 92 },
        }),
        getAtlas: (_id, channel) => channel === 'albedo' ? atlas : null,
        getMaterialChannels: () => ({}),
    };
    const record = new SpriteRenderer(assets).buildGpuRecord('agent.claude.opus', 100, 100, {
        frameKey: 'walk/s/0',
        sourceRect: { x: 184, y: 276, w: 92, h: 92 },
    });
    assert.equal(record.source, atlas);
    assert.deepEqual({ sx: record.sx, sy: record.sy, sw: record.sw, sh: record.sh }, {
        sx: 400, sy: 700, sw: 92, sh: 92,
    });
    assert.deepEqual(record.destination, { x: 54, y: 20, w: 92, h: 92 });
});

test('AssetManager optional material misses never enter the albedo placeholder set', async () => {
    const manager = new AssetManager({ materialAssets: true });
    manager._entriesCache = [{ id: 'prop.test', emissiveSidecar: true }];
    manager._entryById.set('prop.test', manager._entriesCache[0]);
    manager.manifest = { atlases: [] };
    manager.dimensions.set('prop.test', { w: 16, h: 16 });
    manager._loadOptionalImage = async () => ({ img: null, ok: false, reason: 'fixture missing' });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await manager._decodeMaterialAssets({
            signal: new AbortController().signal,
            generation: manager._loadGeneration,
        }), true);
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(manager.getCompanion('prop.test', 'emissive'), null);
    assert.equal(manager.missing.has('prop.test'), false);
    assert.equal(manager.materialDebugSnapshot().optionalMisses.length, 1);
    manager.dispose();
    assert.equal(manager.cacheStats().atlasImages, 0);
});

test('atlas packing and canonical metadata are deterministic', () => {
    const frames = [
        { key: 'small', w: 8, h: 8 },
        { key: 'wide', w: 20, h: 6 },
        { key: 'tall', w: 6, h: 20 },
    ];
    const first = packFrames(structuredClone(frames), { maxWidth: 32, padding: 1, powerOfTwo: true });
    const second = packFrames(structuredClone(frames).reverse(), { maxWidth: 32, padding: 1, powerOfTwo: true });
    assert.equal(stableJson(first), stableJson(second));
    assert.equal(first.width, 32);
    assert.equal(first.height, 32);
    assert.equal(first.frames[0].key, 'tall');
    assert.equal(
        stableJson({ z: 1, a: { y: 2, x: 3 } }),
        stableJson({ a: { x: 3, y: 2 }, z: 1 }),
    );
});
