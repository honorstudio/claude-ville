import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_HINTS } from '../../claudeville/src/config/scenery.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    resolveUpdateRouteBuilding,
} from '../../claudeville/src/presentation/character-mode/MovementRouting.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';

test('completed villagers keep their in-flight ambient destination', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.COMPLETED,
        currentBuilding: 'forge',
    }), 'forge');
});

test('idle villagers keep their in-flight ambient destination', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.IDLE,
        currentBuilding: 'archive',
    }), 'archive');
});

test('directed statuses still replace the current route immediately', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WORKING,
        currentBuilding: 'archive',
        targetBuilding: 'forge',
    }), 'forge');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WAITING,
        currentBuilding: 'forge',
    }), 'taskboard');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.ERRORED,
        currentBuilding: 'mine',
    }), 'watchtower');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WAITING_ON_USER,
        currentBuilding: 'mine',
    }), 'command');
});

test('active intent routing takes priority over status routing', () => {
    assert.equal(resolveUpdateRouteBuilding({
        activeIntentBuilding: 'harbor',
        status: AgentStatus.COMPLETED,
        currentBuilding: 'archive',
    }), 'harbor');
});

test('the landmark bridge keeps decorative side spans non-walkable', () => {
    const bridge = BRIDGE_HINTS.find(hint => hint.id === 'central-river-bridge');

    assert.ok(bridge, 'the central landmark bridge must remain authored');
    assert.equal(bridge.walkableRadius, 0);
    assert.ok(bridge.widthRadius > bridge.walkableRadius);

    const scenery = new SceneryEngine({
        world: null,
        terrainSeed: 1,
        tileNoise: () => 0.5,
    });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const isWalkable = (tileX, tileY) => grid[tileY * MAP_SIZE + tileX] === 1;

    assert.equal(isWalkable(18, 24), true, 'the center deck must remain walkable');
    assert.equal(isWalkable(17, 24), false, 'the west decoration span must block traversal');
    assert.equal(isWalkable(19, 24), false, 'the east decoration span must block traversal');
});
