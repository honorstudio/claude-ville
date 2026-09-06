import test from 'node:test';
import assert from 'node:assert/strict';
import { ChronicleStore } from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { AgentBiographyService } from '../../claudeville/src/application/AgentBiographyService.js';
import { RelationshipAffinityService } from '../../claudeville/src/application/RelationshipAffinityService.js';
import { initialVillageState, reduceVillageState, isStale, linkStatusText } from '../../claudeville/src/application/VillageState.js';

test('simulation broadcasts and every history writer lease are isolated from live stores', () => {
    const originalStorage = globalThis.localStorage;
    const originalChannel = globalThis.BroadcastChannel;
    const storage = new Map();
    const channels = [];
    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
    };
    globalThis.BroadcastChannel = class {
        constructor(name) { channels.push(name); }
        addEventListener() {}
        removeEventListener() {}
        postMessage() {}
        close() {}
    };
    const live = new ChronicleStore();
    const simulated = new ChronicleStore({ dbName: 'claudeville-chronicle-simulation' });
    try {
        const liveLease = live.acquireCaptureLease();
        assert.equal(liveLease.acquired, true);
        assert.equal(simulated.acquireCaptureLease().acquired, true);
        assert.equal(liveLease.renew(), true);
        for (const Service of [AgentBiographyService, RelationshipAffinityService]) {
            const liveWriter = new Service({ store: live });
            const simulatedWriter = new Service({ store: simulated });
            assert.equal(liveWriter._holdsWriteLease(), true);
            const before = new Map(storage);
            assert.equal(simulatedWriter._holdsWriteLease(), true);
            simulatedWriter._releaseWriteLease();
            assert.deepEqual(storage, before, 'simulation must not replace or release a live writer lease');
            assert.equal(liveWriter._holdsWriteLease(), true);
            liveWriter._releaseWriteLease();
        }
        assert.notEqual(channels[0], channels[1]);
        assert.notEqual(live.dbName, simulated.dbName);
    } finally {
        live.close();
        simulated.close();
        globalThis.localStorage = originalStorage;
        globalThis.BroadcastChannel = originalChannel;
    }
});

test('a simulated snapshot stays explicitly simulated without claiming stale network data', () => {
    const state = reduceVillageState(initialVillageState(), {
        type: 'snapshot', source: 'simulator', agentCount: 7, at: 100,
    });
    assert.equal(linkStatusText(state, 1_000_000), 'SIMULATED');
    assert.equal(isStale(state, 1_000_000), false);
    const live = reduceVillageState(state, { type: 'snapshot', source: 'websocket', at: 200 });
    assert.equal(isStale(live, 1_000_000), true);
});
