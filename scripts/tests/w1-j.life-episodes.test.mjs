import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AgentBiography,
    LIFE_EPISODE_LIMIT,
    LifeEpisodeKind,
    LifeEpisodeLabel,
    reduceLifeEpisodes,
} from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { AgentBiographyService } from '../../claudeville/src/application/AgentBiographyService.js';
import { ChronicleEventKind, ChronicleLog } from '../../claudeville/src/application/ChronicleLog.js';
import {
    ChronicleStore,
    DB_VERSION,
    EVENT_RETENTION_DAYS,
    eventRetentionCutoff,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

function memoryStore() {
    const biographies = new Map();
    const rows = [];
    return {
        biographies,
        rows,
        eventRetentionDays: EVENT_RETENTION_DAYS,
        channel: null,
        async getBiography(identityKey) {
            const record = biographies.get(identityKey);
            return record ? structuredClone(record) : null;
        },
        async putBiography(record) {
            biographies.set(record.identityKey, structuredClone(record));
            return record;
        },
        async put(storeName, record) {
            assert.equal(storeName, 'events');
            rows.push(structuredClone(record));
            return record;
        },
        async queryRange(storeName, options = {}) {
            if (storeName === 'biographies') return [];
            return rows
                .filter(row => options.lower == null || row.ts >= options.lower)
                .filter(row => options.upper == null || row.ts <= options.upper)
                .sort((a, b) => a.ts - b.ts)
                .map(row => structuredClone(row));
        },
        expireEvents(now) {
            const cutoff = eventRetentionCutoff(now, EVENT_RETENTION_DAYS);
            for (let index = rows.length - 1; index >= 0; index--) {
                if (rows[index].ts < cutoff) rows.splice(index, 1);
            }
        },
    };
}

function namedAgent(id = 'session-one') {
    return {
        id,
        name: 'Ada',
        agentName: 'Ada',
        provider: 'claude',
        projectPath: '/work/claude-ville',
        gitEvents: [],
    };
}

test('named Chronicle history survives restarts as one ordered deduped life ring', async () => {
    const store = memoryStore();
    const identityKey = AgentBiography.identityKeyFor(namedAgent());
    const now = Date.now();
    const oldAt = now - 15 * 24 * 60 * 60 * 1000;

    const firstService = new AgentBiographyService({ store }).start();
    const firstLog = new ChronicleLog({ store }).start();
    await firstLog.flush();
    firstLog.record(ChronicleEventKind.ARRIVED, namedAgent(), { ts: oldAt });
    firstLog.record(ChronicleEventKind.WAITING, namedAgent(), { ts: now - 5000 });
    firstLog.record(ChronicleEventKind.RESOLVED, namedAgent(), { ts: now - 4000, waitedMs: 1000 });
    firstLog.record(ChronicleEventKind.ERRORED, namedAgent(), { ts: now - 3000 });
    firstLog.record(ChronicleEventKind.RESOLVED, namedAgent(), { ts: now - 2000, waitedMs: 0 });
    await firstLog.stop();
    await firstService.stop();

    const duplicate = structuredClone(store.rows.find(row => row.kind === ChronicleEventKind.WAITING));
    const secondService = new AgentBiographyService({ store }).start();
    eventBus.emit('chronicle:recorded', duplicate);
    const secondLog = new ChronicleLog({ store }).start();
    await secondLog.flush();
    secondLog.record(ChronicleEventKind.PUSH, namedAgent('session-two'), { ts: now - 1000 });
    await secondLog.stop();
    await secondService.stop();

    const record = store.biographies.get(identityKey);
    const episodes = record.extensions.lifeEpisodes;
    assert.deepEqual(episodes.map(episode => episode.kind), [
        LifeEpisodeKind.ARRIVED,
        LifeEpisodeKind.WAITING,
        LifeEpisodeKind.RESOLVED,
        LifeEpisodeKind.ERRORED,
        LifeEpisodeKind.RESOLVED,
        LifeEpisodeKind.PUSH,
    ]);
    assert.equal(new Set(episodes.map(episode => episode.id)).size, episodes.length);
    assert.deepEqual(episodes.map(episode => episode.at), [...episodes.map(episode => episode.at)].sort());

    store.expireEvents(now);
    assert.equal(store.rows.some(row => row.ts === oldAt), false);
    assert.equal(
        store.biographies.get(identityKey).extensions.lifeEpisodes.some(episode => episode.at === oldAt),
        true,
    );
});

test('distinct anonymous session ids never share a life ring', async () => {
    const store = memoryStore();
    const service = new AgentBiographyService({ store }).start();
    const first = { id: 'anonymous-one', name: 'Wren', provider: 'codex' };
    const second = { id: 'anonymous-two', name: 'Wren', provider: 'codex' };
    const firstKey = AgentBiography.identityKeyFor(first);
    const secondKey = AgentBiography.identityKeyFor(second);

    assert.notEqual(firstKey, secondKey);
    eventBus.emit('chronicle:recorded', {
        id: 'first-arrival', kind: ChronicleEventKind.ARRIVED, ts: 1, identityKey: firstKey,
    });
    eventBus.emit('chronicle:recorded', {
        id: 'second-arrival', kind: ChronicleEventKind.ARRIVED, ts: 2, identityKey: secondKey,
    });
    eventBus.emit('chronicle:recorded', {
        id: 'legacy-row', kind: ChronicleEventKind.PUSH, ts: 3,
    });
    await service.stop();

    assert.deepEqual(
        store.biographies.get(firstKey).extensions.lifeEpisodes.map(episode => episode.id),
        ['first-arrival'],
    );
    assert.deepEqual(
        store.biographies.get(secondKey).extensions.lifeEpisodes.map(episode => episode.id),
        ['second-arrival'],
    );
});

test('the pure reducer caps at 32, evicts oldest-first, and generates all prose', () => {
    const identityKey = 'named:claude:ada';
    const modelProse = 'I inspected the private transcript and decided what to do next.';
    let episodes = [];
    for (let index = 0; index < 40; index++) {
        episodes = reduceLifeEpisodes(episodes, {
            id: `event-${index}`,
            kind: ChronicleEventKind.PUSH,
            ts: index + 1,
            identityKey,
            project: 'claude-ville',
            label: modelProse,
            reason: modelProse,
        }, identityKey);
    }

    assert.equal(episodes.length, LIFE_EPISODE_LIMIT);
    assert.equal(episodes[0].id, 'event-8');
    assert.equal(episodes.at(-1).id, 'event-39');
    assert.equal(JSON.stringify(episodes).includes(modelProse), false);
    for (const episode of episodes) {
        assert.ok(Object.values(LifeEpisodeKind).includes(episode.kind));
        assert.equal(episode.project, 'claude-ville');
        assert.equal(episode.label, LifeEpisodeLabel[episode.kind]);
        assert.match(episode.id, /^event-\d+$/);
        assert.equal(typeof episode.at, 'number');
        assert.equal(typeof episode.waitMs, 'number');
    }
});

test('schema 7 adds identity attribution without rewriting legacy event rows', () => {
    assert.equal(DB_VERSION, 7);
    const rows = [
        { id: 'legacy-arrival', ts: 1, kind: ChronicleEventKind.ARRIVED },
        { id: 'legacy-push', ts: 2, kind: ChronicleEventKind.PUSH },
    ];
    const before = structuredClone(rows);
    const createdIndexes = [];
    const eventStore = {
        keyPath: 'id',
        indexNames: {
            contains(name) {
                return ['ts', 'kind', 'localDate'].includes(name);
            },
        },
        createIndex(name) { createdIndexes.push(name); },
        rows,
    };
    const db = {
        objectStoreNames: { contains(name) { return name === 'events'; } },
        deleteObjectStore() { throw new Error('migration must never replace the event store'); },
        createObjectStore() { throw new Error('the existing event store must be reused'); },
    };
    const tx = { objectStore() { return eventStore; } };

    ChronicleStore.prototype._ensureStore.call(
        {}, db, tx, 'events', 'id', ['ts', 'kind', 'localDate', 'identityKey'],
    );

    assert.deepEqual(createdIndexes, ['identityKey']);
    assert.deepEqual(rows, before);
    assert.equal(rows.every(row => row.identityKey === undefined), true);
});

test('degraded Chronicle storage emits normalized status and leaves live events flowing', async () => {
    const previousIndexedDb = globalThis.indexedDB;
    const statuses = [];
    const liveRows = [];
    const unsubscribeStatus = eventBus.on('chronicle:status', payload => statuses.push(payload));
    const unsubscribeRows = eventBus.on('chronicle:recorded', row => liveRows.push(row));
    delete globalThis.indexedDB;
    const store = new ChronicleStore({ dbName: 'life-ring-degraded' });
    const log = new ChronicleLog({ store }).start();
    try {
        await assert.rejects(store.open());
        log.record(ChronicleEventKind.ARRIVED, namedAgent());
        await log.flush();
        assert.equal(liveRows.length, 1);
        assert.equal(liveRows[0].identityKey, 'named:claude:ada');
        assert.deepEqual(statuses.find(payload => payload.status === 'degraded'), {
            status: 'degraded',
            reason: 'indexeddb-unavailable',
        });
    } finally {
        await log.stop();
        store.close();
        unsubscribeStatus();
        unsubscribeRows();
        if (previousIndexedDb === undefined) delete globalThis.indexedDB;
        else globalThis.indexedDB = previousIndexedDb;
    }
});
