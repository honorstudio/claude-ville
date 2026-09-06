import test from 'node:test';
import assert from 'node:assert/strict';

import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

function agent(id, status, awaitingSince = null, lastSessionActivity = 0) {
    return {
        id,
        status,
        awaitingSince,
        lastSessionActivity,
        tokens: {},
        cost: 0,
    };
}

function listFor(world) {
    return AttentionService.prototype.list.call({ world });
}

test('World.getStats keeps legacy meanings while counting all actionable statuses', () => {
    const world = new World();
    const statuses = [
        AgentStatus.WORKING,
        AgentStatus.IDLE,
        AgentStatus.WAITING,
        AgentStatus.ERRORED,
        AgentStatus.RATE_LIMITED,
        AgentStatus.WAITING_ON_USER,
        AgentStatus.COMPLETED,
    ];
    for (const status of statuses) world.agents.set(status, agent(status, status));

    const stats = world.getStats();
    const legacyKeys = [
        'totalTokens',
        'totalCost',
        'working',
        'idle',
        'waiting',
        'errored',
        'attention',
        'total',
    ];

    for (const key of legacyKeys) assert.equal(Object.hasOwn(stats, key), true, key);
    assert.equal(stats.attention, 3);
    assert.equal(stats.working, 1);
    assert.equal(stats.idle, 1);
    assert.equal(stats.waiting, 1);
    assert.equal(stats.errored, 1);
    assert.equal(stats.total, 7);
    assert.deepEqual(
        {
            needsYou: stats.needsYou,
            errors: stats.errors,
            quota: stats.quota,
            watchlist: stats.watchlist,
        },
        { needsYou: 1, errors: 1, quota: 1, watchlist: 1 },
    );
});

test('AttentionService.list returns actionable agents longest-waiting first', () => {
    const agents = [
        agent('needs-you', AgentStatus.WAITING_ON_USER, 300),
        agent('error', AgentStatus.ERRORED, null, 100),
        agent('quota', AgentStatus.RATE_LIMITED, 200),
        agent('waiting', AgentStatus.WAITING, 50),
        agent('working', AgentStatus.WORKING, 25),
        agent('idle', AgentStatus.IDLE, 10),
        agent('completed', AgentStatus.COMPLETED, 1),
    ];
    const world = { agents: new Map(agents.map(item => [item.id, item])) };

    assert.deepEqual(listFor(world).map(item => item.id), ['error', 'quota', 'needs-you']);
});

test('errored agents have parity between World stats and AttentionService.list', () => {
    const errored = agent('errored', AgentStatus.ERRORED, 100);
    const world = new World();
    world.agents.set(errored.id, errored);

    assert.equal(world.getStats().attention, 1);
    assert.deepEqual(listFor(world), [errored]);
});
