import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObservation } from '../../claudeville/src/presentation/character-mode/ObservationCertainty.js';

test('observation recovers independently of execution status', () => {
    const agent = { status: 'working', freshness: { state: 'fresh', observedAt: 1000 } };
    assert.deepEqual(resolveObservation(agent, 3000), { state: 'fresh', observedAt: 1000, ageMs: 2000 });
    agent.signalStale = true;
    assert.equal(resolveObservation(agent, 4000).state, 'stale');
    assert.equal(agent.status, 'working');
    agent.freshness.state = 'unavailable';
    assert.equal(resolveObservation(agent, 4000).state, 'unavailable');
    agent.signalStale = false;
    agent.freshness = { state: 'fresh', observedAt: 5000 };
    assert.equal(resolveObservation(agent, 5000).state, 'fresh');
    agent.resident = true;
    assert.equal(resolveObservation(agent, 5000).state, 'stale');
});
test('unknown observation dates never become epoch or idle age', () => {
    for (const value of [null, undefined, '', NaN, Infinity, 'yesterday']) {
        const result = resolveObservation({ status: 'idle', signalStale: true, signalObservedAt: value }, 9000);
        assert.deepEqual(result, { state: 'stale', observedAt: null, ageMs: null });
    }
    assert.deepEqual(resolveObservation({}, 9000), { state: 'unavailable', observedAt: null, ageMs: null });
    assert.equal(resolveObservation({ signalObservedAt: 10000 }, 9000).ageMs, 0);
    assert.equal(resolveObservation({ signalObservedAt: 2000, freshness: { observedAt: 1000 } }, 3000).ageMs, 1000);
});
