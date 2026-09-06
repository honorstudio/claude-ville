// W4-D — one sidecar cache key, one channel source.
//
// GpuWorldRenderer._textureFor caches GPU textures by key and re-uploads the
// whole source whenever the key is bound with a different source object. The
// material/emissive key for atlas-sourced drawables is scoped to the atlas page
// (`<atlas>:channels`), so every record carrying that key MUST carry the same
// channel source and the same revision. Resolving a per-landmark sidecar
// companion for an atlas-sourced albedo violated both: the shared key was
// rebound with a different image on every batch, re-uploading the full
// 2048x2048 channel pages several times per frame, and the shader sampled those
// sidecars with the albedo's atlas UVs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildGpuWorldRecords,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

const ATLAS = 'world-pilot';
const LANDMARKS = ['building.forge', 'building.mine'];

function fakeImage(width, height, tag) {
    return { width, height, tag };
}

// Every landmark declares a per-id sidecar companion AND an atlas frame. The
// atlas path must ignore the companion; taking it is the regression.
function createAssets() {
    const atlasPages = new Map();
    const companions = new Map();
    const resolveCalls = [];
    for (const channel of ['albedo', 'material', 'emissive', 'occluder']) {
        atlasPages.set(channel, fakeImage(2048, 2048, `atlas:${channel}`));
    }
    for (const id of LANDMARKS) {
        for (const channel of ['material', 'emissive']) {
            companions.set(`${id}:${channel}`, fakeImage(256, 232, `sidecar:${id}:${channel}`));
        }
    }
    return {
        assetVersion: 'v1',
        resolveCalls,
        atlasPage: channel => atlasPages.get(channel) || null,
        get: id => fakeImage(256, 232, `albedo:${id}`),
        getDims: () => ({ w: 256, h: 232 }),
        getAnchor: () => [128, 232],
        getEntry: id => ({ id, atlasFrame: { atlas: ATLAS, key: id } }),
        getAtlas: (atlasId, channel) => (atlasId === ATLAS ? atlasPages.get(channel) || null : null),
        getAtlasFrame: id => (LANDMARKS.includes(id)
            ? { atlas: ATLAS, key: id, rect: { x: 0, y: 0, w: 256, h: 232 } }
            : null),
        getCompanion: (id, channel) => companions.get(`${id}:${channel}`) || null,
        getMaterialMetadata: () => ({ materialClass: 'stone' }),
        resolveMaterialChannels(id, frameKey = null) {
            resolveCalls.push(id);
            return {
                id,
                frameKey: frameKey || id,
                origin: 'sidecar',
                layout: 'sidecar',
                albedo: this.get(id),
                material: companions.get(`${id}:material`) || null,
                emissive: companions.get(`${id}:emissive`) || null,
                occluder: null,
                atlas: ATLAS,
                // Per-id revision. Harmless under a per-id key, poison under the
                // shared atlas-page key.
                revision: `v1::${ATLAS}::${id}`,
                ready: true,
            };
        },
    };
}

function createRenderer(assets) {
    return {
        assets,
        camera: { zoom: 1 },
        // The atlas pages are already resident, so the policy takes the atlas
        // path for buildings; asserted below so the test cannot pass vacuously.
        _gpuAtlasResident: true,
    };
}

function buildingDrawables() {
    return LANDMARKS.map((id, index) => ({
        kind: 'building',
        payload: {
            kind: 'building',
            entry: { id, material: {} },
            building: { type: id.replace(/^building\./, '') },
            wx: 100 * (index + 1),
            wy: 200 * (index + 1),
        },
    }));
}

function buildingRecords(renderer, drawables) {
    return buildGpuWorldRecords(renderer, { drawables })
        .filter(record => String(record.id || '').startsWith('building.'));
}

test('an atlas-page sidecar key is only ever bound with that page\'s channels', () => {
    const assets = createAssets();
    const renderer = createRenderer(assets);
    const records = buildingRecords(renderer, buildingDrawables());

    assert.equal(renderer._gpuAtlasDecision.building, true, 'buildings must take the atlas path');
    assert.equal(records.length, LANDMARKS.length);

    const material = assets.atlasPage('material');
    const emissive = assets.atlasPage('emissive');
    for (const record of records) {
        assert.equal(record.sourceKind, 'atlas');
        assert.equal(record.sidecarKey, `${ATLAS}:channels`);
        assert.equal(record.materialSource, material, 'atlas albedo takes the atlas material page');
        assert.equal(record.emissiveSource, emissive, 'atlas albedo takes the atlas emissive page');
    }
});

test('records sharing a sidecar key share one source identity and one revision', () => {
    const assets = createAssets();
    const renderer = createRenderer(assets);
    const records = buildingRecords(renderer, buildingDrawables());

    const groups = new Map();
    for (const record of records) {
        if (!record.sidecarKey) continue;
        const group = groups.get(record.sidecarKey) || { material: new Set(), emissive: new Set(), revision: new Set() };
        group.material.add(record.materialSource);
        group.emissive.add(record.emissiveSource);
        group.revision.add(record.sidecarRevision);
        groups.set(record.sidecarKey, group);
    }

    assert.ok(groups.size > 0, 'atlas records must produce a sidecar key');
    for (const [key, group] of groups) {
        assert.equal(group.material.size, 1, `${key} must bind exactly one material source`);
        assert.equal(group.emissive.size, 1, `${key} must bind exactly one emissive source`);
        assert.equal(group.revision.size, 1, `${key} must carry exactly one revision`);
    }
});

test('channel sources share the albedo geometry they are sampled with', () => {
    const assets = createAssets();
    const renderer = createRenderer(assets);
    const records = buildingRecords(renderer, buildingDrawables());

    // The GL fragment shaders sample u_materialMap/u_emissiveMap with the
    // albedo's v_uv, so a channel source of different dimensions samples the
    // wrong pixels.
    for (const record of records) {
        for (const channel of ['materialSource', 'emissiveSource']) {
            const source = record[channel];
            if (!source) continue;
            assert.equal(source.width, record.sourceWidth, `${channel} width must match the albedo source`);
            assert.equal(source.height, record.sourceHeight, `${channel} height must match the albedo source`);
        }
    }
});

test('an individual albedo still takes its per-landmark sidecar companions', () => {
    const assets = createAssets();
    // No atlas frames -> the atlas policy cannot engage, so the sidecar path runs.
    assets.getAtlasFrame = () => null;
    const renderer = createRenderer(assets);
    renderer._gpuAtlasResident = false;
    const records = buildingRecords(renderer, buildingDrawables());

    assert.equal(renderer._gpuAtlasDecision.building, false);
    assert.equal(records.length, LANDMARKS.length);
    for (const record of records) {
        assert.equal(record.sourceKind, 'individual');
        assert.equal(record.sidecarKey, `${record.stableKey.split(':')[0]}:material`);
        assert.equal(record.materialSource?.tag, `sidecar:${record.stableKey.split(':')[0]}:material`);
        assert.equal(record.sidecarRevision, `v1::${ATLAS}::${record.stableKey.split(':')[0]}`);
    }
});
