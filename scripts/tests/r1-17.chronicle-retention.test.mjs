import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ChronicleEventKind,
    ChronicleLog,
    chronicleDateKey,
    chronicleDateWindow,
} from '../../claudeville/src/application/ChronicleLog.js';
import {
    ChronicleStore,
    DB_VERSION,
    EVENT_RETENTION_DAYS,
    EVENT_RETENTION_MAX_ROWS,
    eventRetentionCutoff,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { ChroniclePanel } from '../../claudeville/src/presentation/shared/ChroniclePanel.js';

function localTime(year, month, day, hour = 12) {
    return new Date(year, month - 1, day, hour).getTime();
}

test('retention covers today plus thirteen complete local calendar days', () => {
    const now = localTime(2026, 8, 25, 18);
    assert.equal(EVENT_RETENTION_DAYS, 14);
    assert.equal(eventRetentionCutoff(now), new Date(2026, 7, 12).getTime());
    assert.deepEqual(chronicleDateWindow(now, EVENT_RETENTION_DAYS), {
        min: '2026-08-12',
        max: '2026-08-25',
    });
});

test('pruning applies both the calendar cutoff and hard row ceiling', async () => {
    const calls = [];
    const store = Object.assign(Object.create(ChronicleStore.prototype), {
        eventRetentionDays: EVENT_RETENTION_DAYS,
        async _deleteWhere(name) { calls.push(['where', name]); return 0; },
        async deleteRange(name, options) {
            calls.push(['range', name, options]);
            return name === 'events' ? 3 : 0;
        },
        async _trimOldest(name, limit, index) {
            calls.push(['trim', name, limit, index]);
            return 2;
        },
        async put(name, row) { calls.push(['put', name, row]); },
    });
    const now = localTime(2026, 8, 25, 18);
    const deleted = await store.prune(now);
    const eventDelete = calls.find(call => call[0] === 'range' && call[1] === 'events');
    assert.equal(eventDelete[2].upper, new Date(2026, 7, 12).getTime() - 1);
    assert.deepEqual(calls.find(call => call[0] === 'trim'), [
        'trim', 'events', EVENT_RETENTION_MAX_ROWS, 'ts',
    ]);
    assert.equal(deleted.events, 5);
});

test('schema 7 migration preserves existing events, adds identity indexes, and is idempotent', async () => {
    assert.equal(DB_VERSION, 7);
    const rows = [{ id: 'today', ts: Date.now(), kind: ChronicleEventKind.ARRIVED }];
    const originalRows = rows.map(row => ({ ...row }));
    const existingIndexes = new Set(['ts', 'kind']);
    const createdIndexes = [];
    const eventStore = {
        keyPath: 'id',
        indexNames: {
            contains(name) { return existingIndexes.has(name); },
        },
        createIndex(name) {
            createdIndexes.push(name);
            existingIndexes.add(name);
        },
        rows,
    };
    const db = {
        objectStoreNames: { contains(name) { return name === 'events'; } },
        deleteObjectStore() { throw new Error('migration must not replace the event store'); },
        createObjectStore() { throw new Error('existing event store must be reused'); },
    };
    const tx = { objectStore(name) { assert.equal(name, 'events'); return eventStore; } };
    const eventIndexes = ['ts', 'kind', 'localDate', 'identityKey'];

    ChronicleStore.prototype._ensureStore.call({}, db, tx, 'events', 'id', eventIndexes);

    assert.deepEqual(createdIndexes, ['localDate', 'identityKey']);
    assert.deepEqual(rows, originalRows);

    ChronicleStore.prototype._ensureStore.call({}, db, tx, 'events', 'id', eventIndexes);

    assert.deepEqual(createdIndexes, ['localDate', 'identityKey']);
    assert.equal(createdIndexes.filter(name => name === 'identityKey').length, 1);
    assert.deepEqual(rows, originalRows);

    const legacyRows = [
        { id: 'legacy-arrival', ts: localTime(2026, 8, 25, 9), kind: ChronicleEventKind.ARRIVED },
        { id: 'legacy-push', ts: localTime(2026, 8, 25, 10), kind: ChronicleEventKind.PUSH },
    ];
    const originalLegacyRows = legacyRows.map(row => ({ ...row }));
    const legacyIndexes = new Set(['ts', 'kind', 'localDate']);
    const legacyCreatedIndexes = [];
    const legacyEventStore = {
        keyPath: 'id',
        indexNames: {
            contains(name) { return legacyIndexes.has(name); },
        },
        createIndex(name) {
            legacyCreatedIndexes.push(name);
            legacyIndexes.add(name);
        },
        rows: legacyRows,
    };
    const legacyDb = {
        objectStoreNames: { contains(name) { return name === 'events'; } },
        deleteObjectStore() { throw new Error('migration must not replace the legacy event store'); },
        createObjectStore() { throw new Error('legacy event store must be reused'); },
    };
    const legacyTx = {
        objectStore(name) {
            assert.equal(name, 'events');
            return legacyEventStore;
        },
    };

    ChronicleStore.prototype._ensureStore.call({}, legacyDb, legacyTx, 'events', 'id', eventIndexes);

    assert.deepEqual(legacyCreatedIndexes, ['identityKey']);
    assert.deepEqual(legacyRows, originalLegacyRows);
    assert.equal(legacyRows.every(row => row.identityKey === undefined), true);

    const readableLegacyStore = {
        eventRetentionDays: EVENT_RETENTION_DAYS,
        async queryRange(name, options) {
            assert.equal(name, 'events');
            assert.equal(options.index, 'ts');
            return legacyEventStore.rows
                .filter(row => row.ts >= options.lower && row.ts <= options.upper)
                .sort((a, b) => a.ts - b.ts);
        },
    };
    const legacyPage = await new ChronicleLog({ store: readableLegacyStore })
        .readDayPage('2026-08-25');
    assert.deepEqual(legacyPage.events.slice().reverse(), originalLegacyRows);
    assert.equal(legacyPage.totalCount, originalLegacyRows.length);
    assert.equal(legacyPage.events.every(row => row.identityKey === undefined), true);
});

test('day reads reach yesterday without mixing in today', async () => {
    const yesterdayTs = localTime(2026, 8, 24, 9);
    const todayTs = localTime(2026, 8, 25, 9);
    const rows = [
        { id: 'yesterday', ts: yesterdayTs, kind: ChronicleEventKind.COMMIT },
        { id: 'today', ts: todayTs, kind: ChronicleEventKind.PUSH },
    ];
    const store = {
        eventRetentionDays: EVENT_RETENTION_DAYS,
        async reduceRange(_name, options, reducer, initialValue) {
            const matching = rows
                .filter(row => row.ts >= options.lower && row.ts <= options.upper)
                .sort((a, b) => options.direction === 'prev' ? b.ts - a.ts : a.ts - b.ts);
            return matching.reduce(reducer, initialValue);
        },
    };
    const page = await new ChronicleLog({ store }).readDayPage('2026-08-24');
    assert.deepEqual(page.events.map(event => event.id), ['yesterday']);
    assert.equal(page.summary.commits, 1);
    assert.equal(page.summary.pushes, 0);
});

test('panel opens on today and an empty historical date remains selectable', async () => {
    const reads = [];
    const rendered = [];
    const modal = {
        version: 0,
        contentEl: {},
        beginRequest() { return ++this.version; },
        isRequestCurrent(request) { return request === this.version; },
        open() { return true; },
        invalidateRequest() {},
    };
    const emptyPage = {
        events: [],
        summary: {
            agents: [], projects: [], totalEvents: 0, commits: 0, pushes: 0,
            completed: 0, errors: 0, rateLimits: 0, waits: 0,
            totalWaitMs: 0, longestWaitMs: 0, firstTs: null, lastTs: null,
        },
        totalCount: 0,
    };
    const log = {
        retentionDays: EVENT_RETENTION_DAYS,
        async readDayPage(dateKey) { reads.push(dateKey); return emptyPage; },
    };
    const panel = new ChroniclePanel({ modal, chronicleLog: log });
    panel._renderPage = (page, dateKey, request) => rendered.push({ page, dateKey, request });

    await panel.open();
    assert.equal(reads[0], chronicleDateKey());
    assert.equal(rendered[0].dateKey, chronicleDateKey());

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = chronicleDateKey(yesterday);
    await panel._showDate(yesterdayKey, modal.version);
    assert.equal(reads[1], yesterdayKey);
    assert.equal(rendered[1].page.totalCount, 0);
    assert.equal(rendered[1].dateKey, yesterdayKey);
});
