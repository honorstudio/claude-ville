import assert from 'node:assert/strict';
import test from 'node:test';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { CameraDirector } from '../../claudeville/src/presentation/character-mode/CameraDirector.js';
import { prepareSemanticGround } from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';
import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { buildStableGpuBatches, normalizeGpuRecord, clampGpuLights } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { buildGpuWorldRecords, packGpuAgentFrameAtlas } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

test('fractional camera projection, Canvas and GPU share backing-pixel translation', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
        const camera = Object.assign(Object.create(Camera.prototype), {
            x: 12.345, y: -26.789, zoom: 1.73, canvas: { _claudeVilleDpr: dpr },
        });
        let canvasTransform;
        camera.applyTransform({ setTransform: (...values) => { canvasTransform = values; } });
        const screen = camera.worldToScreen(123, 456);
        const back = camera.screenToWorld(screen.x, screen.y);
        assert.ok(Math.abs(back.x - 123) < 1e-10);
        assert.ok(Math.abs(back.y - 456) < 1e-10);
        let gpuCamera;
        GpuWorldRenderer.prototype._setCameraUniforms.call({ gl: {
            uniform3f: (_uniform, ...values) => { gpuCamera = values; },
        } }, { u_camera: {} }, camera);
        assert.equal(canvasTransform[4], Math.round(camera.x * camera.zoom * dpr));
        assert.equal(canvasTransform[5], Math.round(camera.y * camera.zoom * dpr));
        assert.ok(Math.abs((123 + gpuCamera[0]) * gpuCamera[2] - screen.x * dpr) < 1e-10);
        assert.ok(Math.abs((456 + gpuCamera[1]) * gpuCamera[2] - screen.y * dpr) < 1e-10);
    }
});

test('authored geometry travels beside albedo while absent geometry clears reusable scratch', () => {
    const albedo = { width: 16, height: 16 };
    const geometry = { width: 16, height: 16 };
    const renderer = { assets: {
        get: () => albedo, getDims: () => ({ w: 16, h: 16 }), getAnchor: () => [8, 16],
        resolveMaterialChannels: () => ({ ready: true, origin: 'sidecar', occluder: geometry }),
    } };
    const records = buildGpuWorldRecords(renderer, { drawables: [{ kind: 'building',
        building: { type: 'command' }, entry: { id: 'building.command' }, wx: 0, wy: 0,
    }] });
    assert.equal(records[0].occluderSource, geometry);
    const scratch = normalizeGpuRecord(records[0]);
    normalizeGpuRecord({ source: albedo }, 0, scratch);
    assert.equal(scratch.occluderSource, null);
    assert.equal(scratch.occluderTextureUpdates, null);
    const batches = buildStableGpuBatches([
        { source: albedo, textureKey: 'wall', occluderSource: geometry, elevation: .1, occluder: .2 },
        { source: albedo, textureKey: 'wall', occluderSource: geometry, elevation: .9, occluder: .8 },
        { source: albedo, textureKey: 'wall' },
    ]);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].records.map(r => [r.elevation, r.occluder]), [[.1, .2], [.9, .8]]);
});

test('empty disposed Canvas backing stores never reach a GPU upload', () => {
    const renderer = { gl: new Proxy({}, { get() { throw new Error('unexpected GL call'); } }) };
    assert.equal(GpuWorldRenderer.prototype._textureFor.call(renderer, 'disposed', { width: 0, height: 0 }), null);
});

test('a cached night-light budget never pads a short light list with missing lights', () => {
    const cache = { ranked: [], admitted: [], snapshots: [] };
    const light = { id: 'one-light', x: 10, y: 20 };
    assert.deepEqual(clampGpuLights([light], 32, 32, cache), [light]);
    assert.deepEqual(clampGpuLights([], 32, 32, cache), []);
});

test('important and turning atlas slots refresh immediately while ambient frames remain throttled', () => {
    const previousDocument = globalThis.document;
    const canvas = () => ({ width: 16, height: 16, getContext: () => ({ clearRect() {}, drawImage() {} }) });
    globalThis.document = { createElement: canvas };
    try {
        const source = canvas();
        const renderer = { agentSprites: new Map(['focus', 'ambient', 'turn'].map(id => [id, {}])) };
        const records = (sx) => ['focus', 'ambient', 'turn'].map(id => ({
            id: `agent:${id}`, source, sourceWidth: 16, sourceHeight: 16, sx, sy: 0, sw: 8, sh: 8,
            urgentPose: id === 'focus', poseKey: id === 'turn' ? `pose:${sx}` : 'same',
        }));
        packGpuAgentFrameAtlas(renderer, records(0));
        const ambient = renderer._gpuAgentAtlasFrameKeys.get('agent:ambient');
        const focus = renderer._gpuAgentAtlasFrameKeys.get('agent:focus');
        const turn = renderer._gpuAgentAtlasFrameKeys.get('agent:turn');
        renderer._gpuAgentAtlasUpdatedAt = performance.now();
        packGpuAgentFrameAtlas(renderer, records(1));
        assert.notEqual(renderer._gpuAgentAtlasFrameKeys.get('agent:focus'), focus);
        assert.notEqual(renderer._gpuAgentAtlasFrameKeys.get('agent:turn'), turn);
        assert.equal(renderer._gpuAgentAtlasFrameKeys.get('agent:ambient'), ambient);
    } finally { globalThis.document = previousDocument; }
});

test('crowd congestion tightens annotations but never shrinks bodies below the population gate', () => {
    const viewport = { width: 880, height: 845 };
    const rendererFor = (count, zoom = 3) => {
        const sprites = Array.from({ length: count }, () => ({ x: 100, y: 100 }));
        return {
            sprites,
            camera: { zoom, worldToScreen: (x, y) => ({ x, y }) },
            _snapshotAllSprites: () => sprites,
            _crowdStats: { congestedAgents: 0 }, _annotationMode: 'full',
        };
    };
    const modeAt = (renderer) => IsometricRenderer.prototype._agentRenderMode.call(renderer, viewport, renderer.sprites);

    // ~28 villagers with congestion stepping above and below count/2 as
    // walkers cross crowd cells: the annotation LOD may flip, the body must not.
    const small = rendererFor(28);
    for (const congested of [0, 20, 6, 20, 0]) {
        small._crowdStats.congestedAgents = congested;
        assert.equal(modeAt(small).body, 'full');
    }
    small._crowdStats.congestedAgents = 28;
    assert.notEqual(modeAt(small).annotation, 'full');

    // 100 villagers at overview zoom: the population gate compacts bodies.
    const large = rendererFor(100, 1);
    large._crowdStats.congestedAgents = 100;
    const mode = modeAt(large);
    assert.notEqual(mode.body, 'full');
    assert.notEqual(mode.annotation, 'full');
    assert.equal(CameraDirector.prototype._currentMaxZoom.call({ camera: { currentZoomTier: () => 3 } }), 1.5);
});

test('selected, hovered and action-needed agents never enter the compact body branch', () => {
    for (const important of [{ selected: true }, { hovered: true },
        { status: 'waiting_on_user' }, { status: 'errored' }, { status: 'rate_limited' }]) {
        const sprite = { agent: { status: important.status || 'working' }, ...important,
            isArrivalPending: () => false, _archiveFadeProgress: () => 0,
            _drawBudgetImpostor: () => assert.fail('important body was compacted'),
        };
        AgentSprite.prototype._drawAtScreenPosition.call(sprite, {}, 2, 'minimal');
    }
});

test('dense crowd labels keep one routine identity and expand every primary identity', () => {
    const sprites = Array.from({ length: 8 }, (_, index) => ({
        x: 0, y: 0, agent: { id: String(index), status: index === 1 ? 'waiting_on_user' : 'working' },
        selected: index === 0, hovered: index === 2,
    }));
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        agentSprites: new Map(Array.from({ length: 24 }, (_, index) => [index, {}])),
        _crowdStats: { clusters: [{ id: '0,0', count: 8 }] },
        _overlayCompactRects: [], _overlayNameRects: [], _overlayReservedRects: [],
        _overlayPrioritizedSprites: [], _overlayBubbleSprites: [],
        _screenViewport: () => ({}), _agentVisibleOnScreen: () => true,
        _agentLabelPriority: () => 0, _agentLabelAlpha: () => 1,
        _agentCompactSlotRect: () => ({}), _agentNameSlotRect: () => ({}),
        _leastOverlappedCompactSlot: () => 0, _assignAgentBubbleSlots() {},
        markGovernor: { reserve() {} },
    });
    renderer._assignAgentOverlaySlots(sprites, 1, { agentRenderMode: 'compact' });
    assert.deepEqual(sprites.filter(sprite => sprite.overlaySlot != null).map(sprite => sprite.agent.id), ['0', '1', '2', '3']);
    sprites[7].selected = true;
    renderer._assignAgentOverlaySlots(sprites, 1, { agentRenderMode: 'compact' });
    assert.equal(sprites[7].overlaySlot, 0);
    assert.equal(sprites[7].labelAlpha, 1);
});


test('frozen semantic ground invalidates for in-place relationships, crowd and lighting changes', () => {
    const previousDocument = globalThis.document;
    let created = 0;
    const ctx = { setTransform() {}, clearRect() {} };
    globalThis.document = { createElement: () => { created++; return { width: 0, height: 0, getContext: () => ctx }; } };
    try {
        const a = { x: 10, y: 20, agent: { id: 'a', status: 'idle' } };
        const b = { x: 30, y: 40, agent: { id: 'b', status: 'idle' } };
        const relationship = { teamToMembers: new Map(), parentToChildren: new Map(), advisorPairs: [] };
        const renderer = { agentSprites: new Map([['a', a], ['b', b]]),
            relationshipState: { getSnapshot: () => relationship }, _allyTetherPairs: [],
            _crowdStats: { clusters: [] }, motionScale: 0, motionTimeMs: 500,
            camera: { renderOffsetX: 0, renderOffsetY: 0, zoom: 1 } };
        const viewport = { width: 2048, height: 1200 };
        const atmosphere = { lighting: { lightBoost: 1 }, grade: { worldTint: 'rgba(0,0,0,0)' } };
        const prepare = () => prepareSemanticGround(renderer, viewport, {}, atmosphere);
        assert.equal(prepare(), null);
        assert.equal(created, 0);
        relationship.teamToMembers.set('team', ['a', 'b']);
        assert.equal(prepare().dirty, true);
        assert.equal(renderer._semanticGroundCanvas.width, 1024);
        assert.equal(prepare().dirty, false);
        const mutations = [
            () => relationship.teamToMembers.get('team').pop(),
            () => relationship.parentToChildren.set('a', new Set(['b'])),
            () => relationship.parentToChildren.get('a').clear(),
            () => relationship.advisorPairs.push({ advisorId: 'b', parentId: 'a' }),
            () => renderer._allyTetherPairs.push({ a, b }),
            () => renderer._crowdStats.clusters.push({ id: '0,0', tileX: 1, tileY: 2, count: 6, dominantStatus: 'idle' }),
            () => renderer._crowdStats.clusters[0].dominantStatus = 'working',
            () => atmosphere.lighting.lightBoost = .5,
            () => atmosphere.grade.worldTint = 'rgba(50,92,140,.22)',
            () => a.isArrivalPending = () => true,
        ];
        for (const mutate of mutations) {
            mutate();
            assert.equal(prepare().dirty, true);
            assert.equal(prepare().dirty, false);
        }
        atmosphere.lighting.lightBoost += .0001;
        assert.equal(prepare().dirty, false);
        renderer.motionTimeMs += 1000;
        assert.equal(prepare().dirty, false);
        renderer.motionScale = 1;
        assert.equal(prepare().dirty, true);
        renderer.motionTimeMs += 16;
        assert.equal(prepare().dirty, false);
        renderer.motionTimeMs += 125;
        assert.equal(prepare().dirty, true);
        assert.equal(created, 1);
    } finally { globalThis.document = previousDocument; }
});
