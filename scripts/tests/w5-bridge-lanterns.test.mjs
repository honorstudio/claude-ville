import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import {
    BridgeLanterns,
    deriveLanternPlan,
    lanternScreenSize,
    MAX_BRIDGE_LANTERNS,
} from '../../claudeville/src/presentation/character-mode/BridgeLanterns.js';
import {
    appendDepthSortedDrawables,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';
import { worldSceneCategoryRegistry } from '../../claudeville/src/presentation/character-mode/SceneCategoryRegistry.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const DECK = new Map([
    ['16,22', { tileX: 16, tileY: 22, kind: 'plank', orientation: 'EW' }],
    ['17,22', { tileX: 17, tileY: 22, kind: 'plank', orientation: 'EW' }],
]);

function row(index, ageMs, pendingCommits = 1) {
    return {
        project: `/repos/repo-${index}`,
        repoName: `repo-${index}`,
        branch: `branch-${index}`,
        pendingCommits,
        oldestCommitTime: ageMs > 0 ? NOW - ageMs : 0,
        profile: { accent: `#${String(index).padStart(6, '0')}` },
    };
}

test('command pond plank is a single-file walkable east-west crossing', () => {
    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const bridgeTiles = scenery.getBridgeTiles();
    const grid = scenery.getWalkabilityGrid();
    const walkable = (x, y) => grid[y * MAP_SIZE + x] === 1;

    for (const x of [16, 17]) {
        assert.deepEqual(
            { kind: bridgeTiles.get(`${x},22`)?.kind, orientation: bridgeTiles.get(`${x},22`)?.orientation },
            { kind: 'plank', orientation: 'EW' },
        );
        assert.equal(walkable(x, 22), true);
    }
    assert.equal(walkable(15, 22), true);
    assert.equal(walkable(18, 22), true);
    assert.equal(walkable(17, 21), false);
    assert.equal(walkable(17, 23), false);
});

test('lantern plan caps at six and braids oldest branches west to east', () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index, (8 - index) * DAY_MS));
    const plan = deriveLanternPlan(rows, DECK, NOW);

    assert.equal(plan.length, MAX_BRIDGE_LANTERNS);
    assert.deepEqual(plan.map(item => item.branch), rows.slice(0, 6).map(item => item.branch));
    assert.ok(plan.every((item, index) => index === 0 || item.tileX > plan[index - 1].tileX));
    assert.equal(plan[0].tileX, 16);
    assert.equal(plan.at(-1).tileX, 17);
    assert.equal(plan[0].overflowCount, 2);
});

test('lantern glass keeps a 12px screen floor and scales above it', () => {
    assert.equal(lanternScreenSize(1), 12);
    assert.equal(lanternScreenSize(1.5), 12);
    assert.equal(lanternScreenSize(2), 14);
    assert.ok(lanternScreenSize(3) > lanternScreenSize(2));
});

test('lantern brightness follows age boundaries without using unknown ages', () => {
    const ages = [23 * HOUR_MS, 25 * HOUR_MS, 2 * DAY_MS, 4 * DAY_MS, 6 * DAY_MS, 8 * DAY_MS];
    const plan = deriveLanternPlan(ages.map((age, index) => row(index, age)), DECK, NOW);
    const tiersByBranch = Object.fromEntries(plan.map(item => [item.branch, item.tier]));

    assert.equal(tiersByBranch['branch-0'], 0.5);
    assert.equal(tiersByBranch['branch-1'], 0.68);
    assert.equal(tiersByBranch['branch-2'], 0.68);
    assert.equal(tiersByBranch['branch-3'], 0.85);
    assert.equal(tiersByBranch['branch-4'], 0.85);
    assert.equal(tiersByBranch['branch-5'], 1);
    assert.deepEqual(deriveLanternPlan([row(9, 0)], DECK, NOW), []);
    assert.deepEqual(deriveLanternPlan([row(9, DAY_MS, 0)], DECK, NOW), []);
    assert.deepEqual(deriveLanternPlan([row(9, DAY_MS)], [{ tileX: 7, tileY: 25, kind: 'plank', orientation: 'NS' }], NOW), []);
});

test('bridge lanterns disclose capped branches and render nothing without oldest commit data', () => {
    const renderer = {
        bridgeTiles: DECK,
        motionScale: 0,
        _harborPendingReposSignature(repos) { return JSON.stringify(repos); },
    };
    const lanterns = new BridgeLanterns({ renderer });
    const rows = Array.from({ length: 8 }, (_, index) => row(index, (8 - index) * DAY_MS));
    lanterns.update(rows, NOW);
    assert.match(lanterns.tooltipFor(lanterns.plan[0], NOW), /^repo-0 - branch-0 - 1 commit - oldest 1w ago\n\+2 more branches$/);

    lanterns.update([row(99, 0)], NOW);
    const camera = { canvas: { width: 1440, height: 900 }, worldToScreen: () => ({ x: 400, y: 300 }) };
    assert.deepEqual(lanterns.enumerateDrawables(NOW, camera), []);
    assert.deepEqual(lanterns.getLightSources({ beaconIntensity: 1 }), []);
});

test('bridge lanterns use the depth pass on Canvas and overlay replay on unsupported GPU backends', () => {
    const camera = { id: 'camera' };
    const calls = [];
    const enumerationArgs = [];
    const item = {
        kind: 'bridge-lantern',
        sortY: 73,
        draw: (ctx, zoom, context) => calls.push({ ctx, zoom, context }),
    };
    const renderer = {
        camera,
        bridgeLanterns: {
            enumerateDrawables(now, receivedCamera) {
                enumerationArgs.push({ now, camera: receivedCamera });
                return [item];
            },
        },
    };
    const frame = worldSceneCategoryRegistry.enumerate({ renderer, renderNow: 8500 });
    const canvasResolution = worldSceneCategoryRegistry.resolve(frame, {
        id: 'canvas2d',
        canvasFallback: true,
    });
    assert.equal(
        canvasResolution.categories.find(category => category.id === 'bridge-lantern')?.handling,
        'canvas-fallback',
    );

    const drawables = [];
    appendDepthSortedDrawables(drawables, { sceneCategoryFrame: frame });
    const canvasCtx = { path: 'canvas-depth' };
    const canvasContext = { renderer, zoom: 1.5 };
    drawDepthSortedDrawables(canvasCtx, drawables, canvasContext);

    const gpuResolution = worldSceneCategoryRegistry.resolve(frame, {
        id: 'webgl2',
        supportsSceneCommands: () => false,
    });
    const overlayCtx = { path: 'gpu-overlay' };
    const overlayContext = { renderer, zoom: 1.5 };
    drawSceneCategoryOverlays(overlayCtx, drawables, gpuResolution, overlayContext);

    assert.deepEqual(enumerationArgs, [{ now: 8500, camera }]);
    assert.equal(drawables.length, 1);
    assert.equal(drawables[0].kind, 'bridge-lantern');
    assert.equal(drawables[0].sortBand, 45);
    assert.equal(drawables[0].payload, item);
    assert.deepEqual([...gpuResolution.overlayCategoryIds], ['bridge-lantern']);
    assert.deepEqual(calls, [
        { ctx: canvasCtx, zoom: 1.5, context: canvasContext },
        { ctx: overlayCtx, zoom: 1.5, context: overlayContext },
    ]);
});
