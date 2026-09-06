import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    AssetManager,
    agentFrameKeyFromCell,
    atlasSourceRect,
    createDerivedArtQueue,
    derivedArtPriority,
    DERIVED_ART_PRIORITY,
    growTypedArray,
    materialChannelCacheKey,
    resolveMaterialChannelSources,
    shouldUseAtlasForCategory,
} from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import {
    defaultChannelPixel,
    glslMaterialWeatherFunctions,
    MATERIAL_WEATHER_RESPONSE,
    materialWeatherResponseFor,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';

const CHARACTER_MODE = new URL(
    '../../claudeville/src/presentation/character-mode/',
    import.meta.url,
);

function sourceFile(relativePath) {
    return readFileSync(new URL(relativePath, CHARACTER_MODE), 'utf8');
}

function balancedBlock(source, openBrace, label) {
    assert.equal(source[openBrace], '{', `${label} must start at an opening brace`);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openBrace; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = null;
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index++;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return source.slice(openBrace + 1, index);
        }
    }
    assert.fail(`${label} has no balanced closing brace`);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionBody(source, name) {
    const escapedName = escapeRegExp(name);
    const declaration = new RegExp(
        `(?:^|\\n)\\s*(?:(?:export|async|static)\\s+)*(?:function\\s+)?${escapedName}\\s*\\([^)]*\\)\\s*\\{`,
        'm',
    );
    const match = declaration.exec(source);
    assert.ok(match, `${name} function body must be present`);
    const openBrace = match.index + match[0].lastIndexOf('{');
    return balancedBlock(source, openBrace, name);
}

function reachableFunctionBodies(source, roots, names) {
    const bodies = new Map(names.map(name => [name, functionBody(source, name)]));
    const pending = [...roots];
    const reachable = new Set();
    while (pending.length > 0) {
        const name = pending.pop();
        if (reachable.has(name)) continue;
        reachable.add(name);
        const body = bodies.get(name);
        for (const candidate of names) {
            const call = new RegExp(
                `(?:\\bthis\\s*\\.\\s*)?${escapeRegExp(candidate)}\\s*\\(`,
            );
            if (call.test(body) && !reachable.has(candidate)) pending.push(candidate);
        }
    }
    return [...reachable].map(name => ({ name, body: bodies.get(name) }));
}

test('sidecar beats atlas, atlas beats fallback, and an absent channel stays deterministic', () => {
    const sidecarMaterial = { id: 'sidecar' };
    const atlasMaterial = { id: 'atlas' };
    const atlasEmissive = { id: 'atlas-emissive' };
    const sidecarFirst = resolveMaterialChannelSources({
        sidecar: { material: sidecarMaterial },
        atlas: { material: atlasMaterial, emissive: atlasEmissive },
    });
    assert.equal(sidecarFirst.origin, 'sidecar');
    assert.equal(sidecarFirst.material, sidecarMaterial);
    assert.equal(sidecarFirst.emissive, atlasEmissive);

    const atlasNext = resolveMaterialChannelSources({
        atlas: { material: atlasMaterial },
    });
    assert.equal(atlasNext.origin, 'atlas');
    assert.equal(atlasNext.material, atlasMaterial);

    const missing = resolveMaterialChannelSources({});
    assert.equal(missing.origin, 'fallback');
    assert.equal(missing.material, null);
    assert.equal(missing.emissive, null);
    assert.deepEqual(missing.pixels.material, defaultChannelPixel('material'));
    assert.deepEqual(missing.pixels.emissive, [0, 0, 0, 0]);
    assert.deepEqual(defaultChannelPixel('emissive'), [0, 0, 0, 0]);
});

test('a transparent emissive sidecar stays dark and is not replaced by atlas glow', () => {
    const transparent = { width: 1, height: 1, alpha: 0 };
    const glow = { width: 1, height: 1, glow: true };
    const resolved = resolveMaterialChannelSources({
        sidecar: { emissive: transparent },
        atlas: { emissive: glow, material: { id: 'atlas-material' } },
    });
    assert.equal(resolved.origin, 'sidecar');
    assert.equal(resolved.emissive, transparent);
    assert.notEqual(resolved.emissive, glow);
});

test('cache keys change with asset version, atlas key, and frame key', () => {
    const base = materialChannelCacheKey('v1', 'world-pilot', 'walk/s/0');
    assert.notEqual(base, materialChannelCacheKey('v2', 'world-pilot', 'walk/s/0'));
    assert.notEqual(base, materialChannelCacheKey('v1', 'other-atlas', 'walk/s/0'));
    assert.notEqual(base, materialChannelCacheKey('v1', 'world-pilot', 'idle/n/1'));
    assert.equal(base, materialChannelCacheKey('v1', 'world-pilot', 'walk/s/0'));
});

test('atlas rect maths preserve nearest integer UVs and split horizons', () => {
    const rect = { x: 2, y: 390, w: 312, h: 208 };
    assert.deepEqual(atlasSourceRect(rect), { sx: 2, sy: 390, sw: 312, sh: 208 });
    assert.deepEqual(
        atlasSourceRect(rect, { split: true, front: false, horizonY: 130 }),
        { sx: 2, sy: 390, sw: 312, sh: 130 },
    );
    assert.deepEqual(
        atlasSourceRect(rect, { split: true, front: true, horizonY: 130 }),
        { sx: 2, sy: 520, sw: 312, sh: 78 },
    );
});

test('agent cell rects map onto atlas frame keys', () => {
    assert.equal(agentFrameKeyFromCell({ sx: 0, sy: 0, sw: 92, sh: 92 }), 'walk/s/0');
    assert.equal(agentFrameKeyFromCell({ sx: 184, sy: 92, sw: 92, sh: 92 }), 'walk/e/1');
    assert.equal(agentFrameKeyFromCell({ sx: 92, sy: 92 * 6, sw: 92, sh: 92 }), 'idle/se/0');
});

test('scratch buffers grow geometrically and reuse identity', () => {
    const first = growTypedArray(Float32Array, null, 10, 8);
    assert.equal(first.length, 16);
    assert.equal(growTypedArray(Float32Array, first, 10, 8), first);
    const grown = growTypedArray(Float32Array, first, 40, 8);
    assert.equal(grown.length, 64);
    assert.notEqual(grown, first);
});

test('material weather response is bounded, timber and earth respond, fire is exactly zero', () => {
    const fire = materialWeatherResponseFor('fire');
    assert.equal(fire.wetness, 0);
    assert.equal(fire.reflection, 0);
    assert.ok(materialWeatherResponseFor('timber').wetness > 0);
    assert.ok(materialWeatherResponseFor('earth').wetness > 0);
    for (const row of Object.values(MATERIAL_WEATHER_RESPONSE)) {
        assert.ok(row.wetness >= 0 && row.wetness <= 1);
        assert.ok(row.reflection >= 0 && row.reflection <= 1);
        if (row.name === 'fire') {
            assert.equal(row.wetness, 0);
            assert.equal(row.reflection, 0);
        }
    }
    const glsl = glslMaterialWeatherFunctions();
    assert.match(glsl, /material, 2\.0/);
    assert.match(glsl, /material, 6\.0/);
    assert.doesNotMatch(glsl, /material, 10\.0/);
});

test('queue priority puts selected, waiting, and error work before landmarks and background profiles', () => {
    assert.equal(derivedArtPriority({ selected: true }), DERIVED_ART_PRIORITY.SELECTED_WAITING_ERROR);
    assert.equal(derivedArtPriority({ status: 'waiting_on_user' }), DERIVED_ART_PRIORITY.SELECTED_WAITING_ERROR);
    assert.equal(derivedArtPriority({ status: 'errored' }), DERIVED_ART_PRIORITY.SELECTED_WAITING_ERROR);
    assert.equal(
        derivedArtPriority({ kind: 'landmark', onScreen: true }),
        DERIVED_ART_PRIORITY.ONSCREEN_LANDMARK,
    );
    assert.equal(derivedArtPriority({ kind: 'profile' }), DERIVED_ART_PRIORITY.BACKGROUND_PROFILE);

    const order = [];
    const queue = createDerivedArtQueue({
        sliceMs: 50,
        scheduleIdle: null,
        scheduleTimeout: () => 0,
    });
    queue.enqueue({ key: 'bg', kind: 'profile', build: () => order.push('bg') });
    queue.enqueue({ key: 'land', kind: 'landmark', onScreen: true, build: () => order.push('land') });
    queue.enqueue({ key: 'sel', selected: true, build: () => order.push('sel') });
    queue.enqueue({ key: 'wait', status: 'waiting_on_user', build: () => order.push('wait') });
    queue.enqueue({ key: 'err', status: 'errored', build: () => order.push('err') });
    queue.tick();
    assert.deepEqual(order, ['sel', 'wait', 'err', 'land', 'bg']);
});

test('derived-art jobs coalesce on key and ignore stale generations', () => {
    let value = 0;
    const queue = createDerivedArtQueue({
        sliceMs: 50,
        scheduleIdle: null,
        scheduleTimeout: () => 0,
    });
    queue.enqueue({ key: 'same', build: () => { value = 1; } });
    queue.enqueue({ key: 'same', build: () => { value = 2; } });
    queue.tick();
    assert.equal(value, 2);

    let staleRan = false;
    queue.enqueue({
        key: 'stale',
        generation: queue.generation + 1,
        build: () => { staleRan = true; },
    });
    queue.tick();
    assert.equal(staleRan, false);
});

test('atlas category gate keeps a single landmark on the individual source', () => {
    assert.equal(shouldUseAtlasForCategory({
        atlasBytes: 16 * 1024 * 1024,
        individualBytes: 200 * 1024,
        recordCount: 1,
    }), false);
    assert.equal(shouldUseAtlasForCategory({
        atlasBytes: 16 * 1024 * 1024,
        individualBytes: 200 * 1024,
        recordCount: 2,
    }), true);
    assert.equal(shouldUseAtlasForCategory({
        atlasBytes: 16 * 1024 * 1024,
        individualBytes: 200 * 1024,
        recordCount: 1,
        atlasResident: true,
    }), true);
});

test('AssetManager resolver is sidecar-first and never infers emission from albedo', () => {
    const manager = new AssetManager({ materialAssets: true });
    manager.assetVersion = 'assets-v1';
    manager.companions.get('material').set('agent.claude.opus', 'sidecar-material');
    const resolved = manager.resolveMaterialChannels('agent.claude.opus', 'walk/s/0');
    assert.equal(resolved.origin, 'sidecar');
    assert.equal(resolved.material, 'sidecar-material');
    assert.equal(resolved.emissive, null);
    assert.equal(resolved.revision, materialChannelCacheKey('assets-v1', '', 'walk/s/0'));
});

test('no getImageData call remains reachable from a GPU draw path', () => {
    const drawFiles = [
        'gpu/GpuSceneBuilder.js',
        'gpu/GpuWorldRenderer.js',
        'AgentGpuOverlayRenderer.js',
    ];
    const readback = /getImageData\s*\(/;
    for (const file of drawFiles) {
        const source = sourceFile(file);
        assert.doesNotMatch(
            source,
            readback,
            `${file} must not read back pixels on a visible draw`,
        );
        assert.doesNotMatch(source, /luminance/i);
    }

    const assets = sourceFile('AssetManager.js');
    assert.match(assets, /requestIdleCallback/);
    const atlasCropBody = functionBody(assets, '_composeAtlasFrameCrop');
    assert.match(atlasCropBody, /drawImage\s*\(/);
    assert.doesNotMatch(atlasCropBody, readback);
    const resolverBody = functionBody(assets, 'resolveMaterialChannels');
    assert.doesNotMatch(resolverBody, /_composeAtlasFrameCrop\s*\(/);
    const pendingStart = resolverBody.indexOf('const pending = {');
    assert.ok(pendingStart >= 0, 'atlas resolution must expose a pending state');
    const pendingEnd = resolverBody.indexOf('return pending;', pendingStart);
    assert.ok(pendingEnd > pendingStart, 'atlas resolution must return its pending state');
    const pendingBody = resolverBody.slice(pendingStart, pendingEnd);
    assert.match(pendingBody, /ready:\s*false/);
    assert.match(pendingBody, /material:\s*null/);
    assert.match(pendingBody, /emissive:\s*null/);
    assert.match(pendingBody, /occluder:\s*null/);

    const enqueueBody = functionBody(assets, '_enqueueAtlasFrameCrop');
    assert.match(enqueueBody, /this\._derivedArtQueue\.enqueue\s*\(/);
    const buildMarker = 'build: () => {';
    const buildStart = enqueueBody.indexOf(buildMarker);
    assert.ok(buildStart >= 0, 'atlas crop must be built by a queued callback');
    const buildBody = balancedBlock(
        enqueueBody,
        enqueueBody.indexOf('{', buildStart),
        '_enqueueAtlasFrameCrop build callback',
    );
    const composeCall = buildBody.indexOf('_composeAtlasFrameCrop(');
    const publish = buildBody.indexOf('this._materialChannelCache.set(cacheKey, result)');
    assert.ok(composeCall >= 0, 'queued atlas work must call the atlas crop composer');
    assert.ok(publish > composeCall, 'the composed artifact must publish after composition');
    assert.match(
        buildBody.slice(composeCall, publish),
        /if\s*\(!composed\s*\|\|\s*generation\s*!==\s*this\._loadGeneration\)\s*\{\s*if\s*\(composed\)\s*this\._releaseCroppedChannels\(composed\);\s*return;\s*\}/s,
        'a stale composed artifact must be released before publication',
    );
    assert.match(buildBody.slice(0, composeCall), /generation\s*!==\s*this\._loadGeneration/);
    assert.match(buildBody.slice(composeCall, publish), /ready:\s*true/);
    const revision = buildBody.indexOf('this._materialChannelRevision += 1', publish);
    assert.ok(revision > publish, 'the material revision must advance with cache publication');

    const reachable = reachableFunctionBodies(
        assets,
        ['resolveMaterialChannels'],
        [
            'resolveMaterialChannels',
            'resolveMaterialChannelSources',
            'get',
            'getEntry',
            'getCompanion',
            'getAtlas',
            'getAtlasFrame',
            '_enqueueAtlasFrameCrop',
            '_composeAtlasFrameCrop',
            '_releaseCroppedChannels',
            '_releaseImage',
            '_reloadOptionalEntry',
            '_loadCompanion',
            '_reloadAtlasChannel',
            '_loadOptionalImage',
            '_canCommitLoad',
        ],
    );
    for (const { name, body } of reachable) {
        assert.doesNotMatch(body, readback, `${name} is reachable from the draw resolver`);
    }

    const scene = sourceFile('gpu/GpuSceneBuilder.js');
    for (const name of ['composeProceduralTerrainMaterial', 'composeAuthoredTerrainMaterial']) {
        assert.doesNotMatch(functionBody(scene, name), readback, `${name} must not read back pixels`);
    }
    assert.match(
        functionBody(scene, 'packedLandmarkChannels'),
        /resolved\?\.ready\s*&&\s*resolved\.origin\s*!==\s*'fallback'/,
        'landmark draw records must consume only ready channel artifacts',
    );
    const overlay = sourceFile('AgentGpuOverlayRenderer.js');
    assert.match(
        functionBody(overlay, 'setFrameRecord'),
        /const resolvedReady\s*=\s*resolved\?\.ready\s*&&\s*resolved\.origin\s*!==\s*'fallback'/,
        'agent draw records must consume only ready channel artifacts',
    );

    const shader = sourceFile('gpu/GpuWorldRenderer.js');
    assert.match(shader, /materialWetness/);
    assert.match(shader, /materialReflection/);
    assert.match(shader, /u_hasEmissiveMap/);
    assert.match(shader, /authored emission from the albedo texture/);
});
