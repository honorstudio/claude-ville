import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';
import { RitualConductor } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';
import AgentSimulator from '../../claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js';
import { CACHE_ORE_SCENARIO } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

function agent(id, tokens) {
    return { id, tokens, lastSessionActivity: 1 };
}

function captureTokenEvents(activity, id, before, after) {
    const events = [];
    const unsubscribe = eventBus.on('tool:invoked', event => {
        if (event.agentId === id && event.tool === '__token_delta') events.push(event);
    });
    try {
        activity._observeTokens(agent(id, before), 1000);
        activity._observeTokens(agent(id, after), 2000);
    } finally {
        unsubscribe();
    }
    return events;
}

test('cache cargo follows per-beat cache-read and fresh-input deltas', () => {
    const activity = new LandmarkActivity();
    try {
        const [event] = captureTokenEvents(
            activity,
            'crystal-heavy',
            { input: 20000, output: 6000, cacheRead: 80000, availability: 'observed' },
            { input: 24000, output: 6000, cacheRead: 89500, availability: 'observed' },
        );
        assert.ok(event);
        assert.equal(event.cargo.source, 'delta');
        assert.equal(event.cargo.cacheRead, 9500);
        assert.equal(event.cargo.input, 4000);
        assert.equal(event.cargo.deltaTotal, 13500);
        assert.ok(Math.abs(event.cargo.ratio - 9500 / 13500) < 1e-12);
    } finally {
        activity.dispose();
    }
});

test('output-dominated beats fall back to the cumulative cache ratio', () => {
    const activity = new LandmarkActivity();
    try {
        const [event] = captureTokenEvents(
            activity,
            'cumulative',
            { input: 200, output: 0, cacheRead: 800, availability: 'observed' },
            { input: 208, output: 300, cacheRead: 832, availability: 'observed' },
        );
        assert.ok(event);
        assert.equal(event.cargo.source, 'cumulative');
        assert.equal(event.cargo.ratio, 0.8);
        assert.equal(
            activity.tokenItemTooltip({ cargo: event.cargo }),
            '208 input · 832 cache read · session total',
        );
    } finally {
        activity.dispose();
    }
});

test('unavailable cache data and counter resets never fabricate cache cargo', () => {
    const activity = new LandmarkActivity();
    try {
        const [blindEvent] = captureTokenEvents(
            activity,
            'blind',
            { input: 12000, output: 2000, cacheRead: 0, availability: 'unavailable' },
            { input: 12000, output: 2400, cacheRead: 0, availability: 'unavailable' },
        );
        assert.ok(blindEvent);
        assert.equal(blindEvent.cargo, null);
        assert.equal(activity.tokenItemTooltip({ cargo: blindEvent.cargo }), '');

        const resetEvents = captureTokenEvents(
            activity,
            'reset',
            { input: 9000, output: 2000, cacheRead: 30000, availability: 'observed' },
            { input: 100, output: 3000, cacheRead: 500, availability: 'observed' },
        );
        assert.deepEqual(resetEvents, []);
    } finally {
        activity.dispose();
    }
});

test('sub-ritual token pills carry cargo only above the observable threshold', () => {
    const activity = new LandmarkActivity();
    try {
        activity._observeTokens(agent('pill', { input: 1000, output: 0, cacheRead: 1000, availability: 'observed' }), 1000);
        activity._observeTokens(agent('pill', { input: 1075, output: 0, cacheRead: 1075, availability: 'observed' }), 2000);
        const pill = [...activity.items.values()].find(item => item.type === 'token');
        assert.ok(pill);
        assert.equal(pill.cargo.ratio, 0.5);
        assert.equal(pill.cargo.cacheRead, 75);
        assert.equal(pill.cargo.input, 75);
        assert.equal(Object.hasOwn(pill, 'cargoLabel'), false, 'the transient percent cargo label was removed (counts, never percentages)');
        assert.equal(Object.hasOwn(pill, 'ratio'), false);

        activity._observeTokens(agent('small', { input: 1000, output: 0, cacheRead: 1000, availability: 'observed' }), 1000);
        activity._observeTokens(agent('small', { input: 1050, output: 0, cacheRead: 1050, availability: 'observed' }), 2000);
        assert.equal([...activity.items.values()].some(item => item.agentId === 'small'), false);
    } finally {
        activity.dispose();
    }
});

test('mine rituals preserve and refresh cache cargo when beats coalesce', () => {
    const conductor = new RitualConductor();
    try {
        const firstCargo = { ratio: 0.7, source: 'delta', cacheRead: 9500, input: 4000, deltaTotal: 13500 };
        const first = conductor.enqueue({
            agentId: 'miner', tool: '__token_delta', input: 13500, building: 'mine', ts: 1000, cargo: firstCargo,
        });
        assert.equal(first.kind, 'mine-pick');
        assert.equal(first.building, 'mine');
        assert.equal(first.label, '+13500');
        assert.deepEqual(first.cargo, firstCargo);

        const latestCargo = { ratio: 0.03, source: 'delta', cacheRead: 300, input: 10000, deltaTotal: 10300 };
        const second = conductor.enqueue({
            agentId: 'miner', tool: '__token_delta', input: 10300, building: 'mine', ts: 1100, cargo: latestCargo,
        });
        assert.equal(second, first);
        assert.equal(second.count, 2);
        assert.equal(second.label, '+10300');
        assert.deepEqual(second.cargo, latestCargo);
    } finally {
        conductor.dispose();
    }
});

test('cache-ore simulation exposes distinct zero, half, and crystal-heavy beats', () => {
    const beats = CACHE_ORE_SCENARIO.timeline.filter(step => step.ts === 8000);
    const baselines = new Map(CACHE_ORE_SCENARIO.agents.map(spec => [spec.id, spec.tokens]));
    const ratios = beats.map(step => {
        const before = baselines.get(step.agentId);
        const cacheRead = step.tokens.cacheRead - before.cacheRead;
        const input = step.tokens.input - before.input;
        return cacheRead / (cacheRead + input);
    });
    assert.deepEqual(ratios, [0, 0.5, 0.9]);
    assert.deepEqual(CACHE_ORE_SCENARIO.metadata.camera, {
        centerTile: { tileX: 13, tileY: 34 },
        zoom: 2.2,
    });
    const cargoMix = BuildingSprite.prototype._mineCargoMix({ ratio: 0.9 });
    assert.equal(cargoMix.ratio, 0.9);
    assert.equal(cargoMix.bucket, 0.875);
    assert.equal(cargoMix.crystalSlots, 5);
});

test('sim tool steps apply token counters to a live agent', () => {
    const world = new World();
    world.addAgent(new Agent({
        id: 'sim-token-agent',
        status: 'working',
        tokens: { input: 100, output: 20, cacheRead: 400, availability: 'observed' },
    }));
    const simulator = new AgentSimulator({ world, scenarioId: 'cache-ore' });
    simulator._applyToolStep({
        agentId: 'sim-token-agent',
        tool: 'Read',
        status: 'working',
        tokens: { input: 175, cacheRead: 475 },
    });
    const tokens = world.agents.get('sim-token-agent').tokens;
    assert.equal(tokens.input, 175);
    assert.equal(tokens.cacheRead, 475);
    assert.equal(tokens.output, 20);
});
