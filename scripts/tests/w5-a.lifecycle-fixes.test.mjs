import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ChronicleEventKind,
    ChronicleLog,
    summarizeDigest,
} from '../../claudeville/src/application/ChronicleLog.js';
import {
    AttentionService,
    formatUnattendedDigest,
} from '../../claudeville/src/application/AttentionService.js';
import { RelationshipAffinityService } from '../../claudeville/src/application/RelationshipAffinityService.js';
import {
    ChronicleStore,
    CHRONICLE_OPEN_TIMEOUT_MS,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';

function later() {
    return new Promise(resolve => setImmediate(resolve));
}

function memoryEventStore() {
    const rows = [];
    return {
        rows,
        async put(_store, record) {
            rows.push(record);
            return record;
        },
        async queryRange() {
            return [...rows].sort((a, b) => a.ts - b.ts);
        },
    };
}

function agent(id, extra = {}) {
    return {
        id,
        name: id,
        agentName: id,
        provider: 'claude',
        projectPath: '/repo',
        status: AgentStatus.WORKING,
        gitEvents: [],
        sendMessages: [],
        ...extra,
    };
}

function affinityStore(getAllAffinities) {
    return {
        getAllAffinities,
        async putAffinity(record) { return record; },
    };
}

async function withIndexedDb(indexedDb, callback) {
    const previous = globalThis.indexedDB;
    globalThis.indexedDB = indexedDb;
    try {
        return await callback();
    } finally {
        if (previous === undefined) delete globalThis.indexedDB;
        else globalThis.indexedDB = previous;
    }
}

test('a blocked Chronicle upgrade becomes a visible bounded degradation', async () => {
    let request;
    const indexedDb = {
        open() {
            request = { result: null, transaction: null, error: null };
            setImmediate(() => request.onblocked?.());
            return request;
        },
    };

    await withIndexedDb(indexedDb, async () => {
        const store = new ChronicleStore({
            dbName: `blocked-${Date.now()}`,
            openTimeoutMs: 15,
        });
        try {
            const opening = store.open();
            await later();
            assert.equal(store.status, 'degraded');
            assert.equal(store.isDegraded, true);
            assert.equal(store.degradedReason, 'upgrade-blocked');

            await assert.rejects(opening, error => (
                error.code === 'CHRONICLE_STORE_OPEN_TIMEOUT'
            ));
            assert.equal(store.degradedReason, 'upgrade-blocked-timeout');
            assert.equal(store.openTimeoutMs, 15);
        } finally {
            store.close();
        }
    });
    assert.equal(CHRONICLE_OPEN_TIMEOUT_MS, 5000);
});

test('an opened Chronicle connection closes itself on versionchange', async () => {
    let request;
    let closeCount = 0;
    const db = {
        close() { closeCount++; },
    };
    const indexedDb = {
        open() {
            request = { result: null, transaction: null, error: null };
            setImmediate(() => {
                request.result = db;
                request.onsuccess?.();
            });
            return request;
        },
    };

    await withIndexedDb(indexedDb, async () => {
        const store = new ChronicleStore({ dbName: `version-${Date.now()}` });
        try {
            await store.open();
            assert.equal(store.status, 'ready');
            assert.equal(typeof db.onversionchange, 'function');
            db.onversionchange();
            assert.equal(closeCount, 1);
            assert.equal(store.db, null);
            assert.equal(store.status, 'idle');
        } finally {
            store.close();
        }
    });
});

test('affinity preload replays one latest roster observation after a long block', async () => {
    let release;
    const store = affinityStore(() => new Promise(resolve => { release = resolve; }));
    const service = new RelationshipAffinityService({ store }).start();
    let processed = 0;
    const process = service._processAgentSeen.bind(service);
    service._processAgentSeen = (...args) => {
        processed++;
        return process(...args);
    };

    try {
        for (let index = 0; index < 4000; index++) {
            service._handleAgentSeen(agent('blocked-agent', { lastMessage: `poll-${index}` }));
        }
        assert.equal(service._readyState, 'loading');
        assert.equal(service._roster.size, 1);

        release([]);
        await service._ready;
        assert.equal(processed, 1);
        assert.equal(service._readyState, 'ready');
    } finally {
        await service.stop();
    }
});

test('departed agents accrue no new affinity while their existing history remains', async () => {
    const service = new RelationshipAffinityService({
        store: affinityStore(async () => []),
    }).start();
    await service._ready;

    const one = agent('one');
    const two = agent('two');
    service._handleAgentSeen(one);
    service._handleAgentSeen(two);

    const oneKey = AgentBiography.identityKeyFor(one);
    const twoKey = AgentBiography.identityKeyFor(two);
    const pair = service.getAffinity(oneKey, twoKey);
    assert.ok(pair);
    assert.equal(pair.meetings, 1);

    one.isDeparted = true;
    one.departedAt = 123;
    one.gitEvents = [{ id: 'departed-commit', type: 'commit', completedAt: Date.now() }];
    one.sendMessages = [{ recipient: two.name, ts: Date.now(), summary: 'departed chat' }];
    const three = agent('three');
    service._handleAgentSeen(one);
    service._handleAgentSeen(three);
    service._handleAgentSeen(two);

    try {
        assert.equal(service.getAffinity(oneKey, twoKey).meetings, 1);
        assert.equal(service.getAffinity(oneKey, twoKey).sharedCommits, 0);
        assert.equal(
            service.getAffinity(oneKey, AgentBiography.identityKeyFor(three)),
            null,
        );

        service._handleAgentRemoved(one);
        assert.equal(service.getAffinity(oneKey, twoKey).meetings, 1);
    } finally {
        await service.stop();
    }
});

test('a departed status projection never becomes a completion or resolved wait', async () => {
    const store = memoryEventStore();
    const log = new ChronicleLog({ store }).start();
    const waiting = agent('brief', {
        status: AgentStatus.WAITING_ON_USER,
        waitReason: 'question',
        awaitingSince: Date.now() - 1000,
    });
    await log.flush();
    log._onAdded(waiting);
    await log.flush();

    log._onUpdated({
        ...waiting,
        status: AgentStatus.COMPLETED,
        isDeparted: true,
        departedAt: Date.now(),
        waitReason: null,
        awaitingSince: null,
    });
    log._onUpdated({
        ...waiting,
        status: AgentStatus.WAITING_ON_USER,
        isDeparted: false,
        departedAt: null,
        waitReason: 'question',
        awaitingSince: waiting.awaitingSince,
    });
    await log.flush();

    try {
        const kinds = store.rows.map(row => row.kind);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.COMPLETED).length, 0);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.RESOLVED).length, 0);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.DEPARTED).length, 0);
    } finally {
        await log.stop();
    }
});

test('actual eviction records a departure without recording projected completion', async () => {
    const store = memoryEventStore();
    const log = new ChronicleLog({ store }).start();
    const resident = agent('evicted');
    await log.flush();
    log._onAdded(resident);
    await log.flush();
    const departed = {
        ...resident,
        status: AgentStatus.COMPLETED,
        isDeparted: true,
        departedAt: Date.now(),
    };
    log._onUpdated(departed);
    log._onRemoved(departed);
    await log.flush();

    try {
        const kinds = store.rows.map(row => row.kind);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.COMPLETED).length, 0);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.RESOLVED).length, 0);
        assert.equal(kinds.filter(kind => kind === ChronicleEventKind.DEPARTED).length, 1);
    } finally {
        await log.stop();
    }
});

test('unattended digest urgency is based on net unresolved state', () => {
    const digest = summarizeDigest([
        { ts: 1, kind: ChronicleEventKind.WAITING, agentId: 'wait', agentName: 'Waiter' },
        { ts: 2, kind: ChronicleEventKind.RESOLVED, agentId: 'wait', agentName: 'Waiter' },
        { ts: 3, kind: ChronicleEventKind.ERRORED, agentId: 'error', agentName: 'Error' },
        { ts: 4, kind: ChronicleEventKind.COMPLETED, agentId: 'error', agentName: 'Error' },
        { ts: 5, kind: ChronicleEventKind.RATE_LIMITED, agentId: 'rate', agentName: 'Rate' },
        { ts: 6, kind: ChronicleEventKind.COMPLETED, agentId: 'rate', agentName: 'Rate' },
    ]);

    assert.equal(digest.waitingAgents, 0);
    assert.equal(digest.errorAgentCount, 0);
    assert.equal(digest.rateLimitAgentCount, 0);
    assert.deepEqual(digest.urgent, { waiting: [], errors: [], rateLimits: [] });

    const service = new AttentionService({ agents: new Map() });
    try {
        const decorated = service._decorateDigest(digest, 0, 10);
        assert.equal(decorated.hasUrgent, false);
        assert.equal(decorated.desktopNotifiedCount, 0);
        assert.equal(
            formatUnattendedDigest(decorated),
            'While you were away: 2 completions; 1 wait resolved.',
        );
    } finally {
        service.destroy();
    }
});
