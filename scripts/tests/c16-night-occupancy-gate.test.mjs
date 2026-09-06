import test from 'node:test';
import assert from 'node:assert/strict';

import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import {
    MIDNIGHT_OIL_FALL_MS,
    MIDNIGHT_OIL_RISE_MS,
    advanceNightOccupancyGate,
    buildingEmissiveGate,
    lightsBuildingWindows,
    nightWindowGate,
} from '../../claudeville/src/presentation/character-mode/NightOccupancyGate.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { normalizeGpuRecord } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { MIDNIGHT_OIL_SCENARIO } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

function lightFixture(phase, forgeGate) {
    const forge = { type: 'forge' };
    const watchtower = { type: 'watchtower' };
    return Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: { phase, phaseProgress: phase === 'night' ? 0.5 : 0, reactions: { windowWarmth: 0.8 } },
        lightingState: { lightBoost: 1, beaconIntensity: 1 },
        harborStatus: { failedPushActive: false, activeWorkingCount: 0 },
        motionScale: 1,
        _litGateByType: new Map([['forge', { value: forgeGate, target: forgeGate }]]),
        _staticLightSources: () => [
            { id: 'forge', kind: 'point', buildingType: 'forge', building: forge, radius: 64, intensity: 1, alpha: 0.4, color: '#fff' },
            { id: 'watchtower', kind: 'point', buildingType: 'watchtower', building: watchtower, radius: 64, intensity: 1, alpha: 0.4, color: '#fff' },
        ],
        _visitorCountFor: () => 0,
        _forgeGlowIntensity: () => 1,
        _watchtowerIntensity: () => 0,
        _beaconScaleFor: () => 1,
        _presenceTierFor: () => 'dormant',
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
    });
}

test('day is unchanged while night follows only live working occupancy', () => {
    assert.equal(buildingEmissiveGate('day', 0, 0), 1);
    assert.equal(buildingEmissiveGate('dawn', 0.9, 0), 1);
    assert.equal(buildingEmissiveGate('night', 0.2, 0), 0);
    assert.equal(buildingEmissiveGate('night', 0.2, 1), 1);

    const dayLights = lightFixture('day', 0).getLightSources();
    assert.deepEqual(dayLights.map(light => light.id), ['forge', 'watchtower']);
    const nightEmptyLights = lightFixture('night', 0).getLightSources();
    assert.deepEqual(nightEmptyLights.map(light => light.id), ['watchtower']);
    const nightWorkingLights = lightFixture('night', 1).getLightSources();
    assert.deepEqual(nightWorkingLights.map(light => light.id), ['forge', 'watchtower']);
});

test('only present mid-turn agents light building windows', () => {
    assert.equal(lightsBuildingWindows({ status: 'working' }), true);
    assert.equal(lightsBuildingWindows({ status: 'waiting', turnState: 'tool_pending' }), true);
    for (const status of ['idle', 'completed', 'waiting', 'waiting_on_user', 'rate_limited', 'errored']) {
        assert.equal(lightsBuildingWindows({ status }), false, status);
    }
    assert.equal(lightsBuildingWindows({ status: 'working', isDeparted: true }), false);
    assert.equal(lightsBuildingWindows({ status: 'working', departedAt: 1234 }), false);
});

test('frame-fresh physical visitor tally drives the rise and completion fade', () => {
    const building = { type: 'forge', containsPoint: () => true };
    const working = { agent: { status: 'working' } };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [building],
        agentSprites: [
            working,
            { agent: { status: 'waiting', turnState: 'tool_pending' } },
            { agent: { status: 'working', departedAt: 100 } },
            { agent: { status: 'idle' } },
        ],
        motionScale: 1,
        _visitorCountByType: new Map(),
        _visitorStatusByType: new Map(),
        _visitorRepoByType: new Map(),
        _litGateByType: new Map(),
        _spriteTilePosition: () => ({ tileX: 25, tileY: 30 }),
    });
    renderer._updateVisitorCounts();
    assert.equal(renderer._visitorStatusByType.get('forge').working, 2);
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer._nightShiftLit('forge'), 1);

    working.agent.status = 'completed';
    renderer.agentSprites[1].agent.turnState = null;
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_FALL_MS);
    assert.equal(renderer._nightShiftLit('forge'), 0);
});

test('night phase gate crossfades only during the last fifth of dusk', () => {
    assert.equal(nightWindowGate('day', 1), 0);
    assert.equal(nightWindowGate('dawn', 1), 0);
    assert.equal(nightWindowGate('dusk', 0.5), 0);
    assert.ok(Math.abs(nightWindowGate('dusk', 0.9) - 0.5) < 1e-9);
    assert.equal(nightWindowGate('dusk', 1), 1);
    assert.equal(nightWindowGate('night', 0), 1);
});

test('working transitions are monotonic and reduced motion snaps instantly', () => {
    const rising = [0];
    for (let elapsed = 0; elapsed < MIDNIGHT_OIL_RISE_MS; elapsed += 80) {
        rising.push(advanceNightOccupancyGate(rising.at(-1), 1, 80, 1));
    }
    assert.equal(rising.at(-1), 1);
    assert.ok(rising.every((value, index) => index === 0 || value >= rising[index - 1]));

    const falling = [1];
    for (let elapsed = 0; elapsed < MIDNIGHT_OIL_FALL_MS; elapsed += 160) {
        falling.push(advanceNightOccupancyGate(falling.at(-1), 0, 160, 1));
    }
    assert.equal(falling.at(-1), 0);
    assert.ok(falling.every((value, index) => index === 0 || value <= falling[index - 1]));
    assert.equal(advanceNightOccupancyGate(0, 1, 16, 0), 1);
    assert.equal(advanceNightOccupancyGate(1, 0, 16, 0), 0);
});

test('GPU building records carry the shared emissive gate and omitted gates normalize to one', () => {
    const image = { width: 20, height: 30 };
    const renderer = {
        assets: {
            assetVersion: 'test',
            get: id => id === 'building.forge' ? image : null,
            getDims: () => ({ w: 20, h: 30 }),
            getAnchor: () => [10, 25],
        },
        buildingRenderer: {
            _buildingOccupancyInfo: () => ({ state: 'idle' }),
            _emissiveGateFor: () => 0,
        },
        camera: { zoom: 1 },
    };
    const records = buildGpuWorldRecords(renderer, {
        drawables: [{
            kind: 'building',
            payload: {
                kind: 'building',
                building: { type: 'forge' },
                entry: { id: 'building.forge' },
                wx: 100,
                wy: 80,
            },
        }],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].emissiveGate, 0);
    assert.equal(normalizeGpuRecord({ emissiveGate: -2 }).emissiveGate, 0);
    assert.equal(normalizeGpuRecord({ emissiveGate: 4 }).emissiveGate, 1);
    assert.equal(normalizeGpuRecord({}).emissiveGate, 1);
});

test('midnight-oil fixture pins two working buildings and non-working buildings at 23:10', () => {
    assert.equal(MIDNIGHT_OIL_SCENARIO.id, 'midnight-oil');
    assert.equal(MIDNIGHT_OIL_SCENARIO.metadata.atmosphere.clock.hours, 23);
    assert.equal(MIDNIGHT_OIL_SCENARIO.metadata.atmosphere.weather.type, 'clear');
    assert.deepEqual(
        MIDNIGHT_OIL_SCENARIO.agents.filter(agent => lightsBuildingWindows(agent)).map(agent => agent.id),
        ['oil-forge', 'oil-archive'],
    );
    assert.deepEqual(
        MIDNIGHT_OIL_SCENARIO.agents.filter(agent => !lightsBuildingWindows(agent)).map(agent => agent.id),
        ['oil-idle', 'oil-waiting'],
    );
});
