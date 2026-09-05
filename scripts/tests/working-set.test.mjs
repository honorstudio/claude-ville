import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './support/tmp.mjs';

import workingSetService from '../../claudeville/services/workingSet.js';
import adapterRegistry from '../../claudeville/adapters/index.js';
import ompAdapter from '../../claudeville/adapters/omp.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { formatElapsed } from '../../claudeville/src/presentation/shared/Formatters.js';

const { detectCollisions, DEPARTED_GRACE_MS } = workingSetService;
const { normalizeSession } = adapterRegistry;

function session(id, project, workingSet, extra = {}) {
    return {
        sessionId: id,
        project,
        turnState: 'working',
        lastActivity: Date.now(),
        workingSet,
        ...extra,
    };
}

function file(pathname, op) {
    return { path: pathname, op, at: 1, source: 'transcript' };
}

test('two sessions writing the same canonical project path yield one loud collision', () => {
    const sessions = [
        session('alpha', '/work/project', [file('src/router.ts', 'write')]),
        session('beta', '/work/project', [file('src/router.ts', 'write')]),
    ];

    assert.deepEqual(detectCollisions(sessions), [{
        path: 'src/router.ts',
        project: '/work/project',
        agents: ['alpha', 'beta'],
        kind: 'write-write',
    }]);
});

test('read/write overlap is advisory and read/read overlap is silent', () => {
    const project = '/work/project';
    assert.equal(detectCollisions([
        session('reader', project, [file('src/router.ts', 'read')]),
        session('writer', project, [file('src/router.ts', 'write')]),
    ])[0].kind, 'read-write');
    assert.deepEqual(detectCollisions([
        session('reader-a', project, [file('src/router.ts', 'read')]),
        session('reader-b', project, [file('src/router.ts', 'read')]),
    ]), []);
});

test('a symlink canonicalised outside the project does not join a project-relative path', (t) => {
    const root = makeTempDir('claudeville-working-set-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    const target = path.join(outside, 'router.ts');
    const link = path.join(project, 'router.ts');
    fs.writeFileSync(target, 'export {};\n');
    fs.symlinkSync(target, link);

    const externalCanonicalPath = fs.realpathSync(link);
    assert.deepEqual(detectCollisions([
        session('external', project, [file(externalCanonicalPath, 'write')]),
        session('local', project, [file('router.ts', 'write')]),
    ]), []);
});

test('ended sessions age out after the departed grace', () => {
    const now = 20 * 60 * 1000;
    const recent = session('recent', '/work/project', [file('src/router.ts', 'write')], {
        turnState: 'awaiting_input',
        lastActivity: now - DEPARTED_GRACE_MS + 1,
    });
    const expired = session('expired', '/work/project', [file('src/router.ts', 'write')], {
        turnState: 'awaiting_input',
        lastActivity: now - DEPARTED_GRACE_MS - 1,
    });
    const live = session('live', '/work/project', [file('src/router.ts', 'write')]);

    assert.equal(detectCollisions([recent, live], now).length, 1);
    assert.deepEqual(detectCollisions([expired, live], now), []);
});

test('formatElapsed uses compact state-age units', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(38_999), '38s');
    assert.equal(formatElapsed(4 * 60_000 + 12_000), '4m12s');
    assert.equal(formatElapsed(6 * 60_000), '6m');
    assert.equal(formatElapsed(2 * 60 * 60_000 + 5 * 60_000), '2h5m');
    assert.equal(formatElapsed(24 * 60 * 60_000), '1d');
});

test('session normalisation preserves F2 and F3 fields', () => {
    const normalized = normalizeSession({
        sessionId: 'alpha',
        provider: 'codex',
        turnStartedAt: 10,
        lastTurnDurationMs: 25,
        signalSource: 'transcript',
        workingSet: [file('src/router.ts', 'write')],
    });

    assert.equal(normalized.turnStartedAt, 10);
    assert.equal(normalized.lastTurnDurationMs, 25);
    assert.equal(normalized.signalSource, 'transcript');
    assert.deepEqual(normalized.workingSet, [file('src/router.ts', 'write')]);
});

test('HTTP fallback and WebSocket delta hydration preserve F1, F2, and F3', async (t) => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    t.after(() => {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
        if (originalFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = originalFetch;
    });

    const cost = {
        usd: 0.42,
        source: 'provider',
        rateMatch: 'provider:codex',
        rateRevision: '2026-09-02',
        unknownModel: false,
    };
    const sessionsPayload = [{
        sessionId: 'alpha',
        provider: 'codex',
        project: '/work/project',
        status: 'active',
        turnState: 'working',
        lastActivity: Date.now(),
        estimatedCost: 0.4,
        cost,
        turnStartedAt: 10,
        lastTurnDurationMs: 25,
        signalSource: 'transcript',
        workingSet: [file('src/router.ts', 'write')],
    }];
    const collisions = [{
        path: 'src/router.ts',
        project: '/work/project',
        agents: ['alpha', 'beta'],
        kind: 'write-write',
    }];

    globalThis.window = { location: { origin: 'http://localhost:4000' } };
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ sessions: sessionsPayload, collisions }),
    });
    const { ClaudeDataSource } = await import(
        `../../claudeville/src/infrastructure/ClaudeDataSource.js?working-set-http=${Date.now()}`
    );
    const httpSessions = await new ClaudeDataSource().getSessions();
    assert.deepEqual(httpSessions.collisions, collisions);

    const world = new World();
    const manager = new AgentManager(world, null);
    // SessionWatcher uses this exact shape for fallback polling: top-level
    // wire metadata remains attached to the sessions array.
    manager.handleWebSocketMessage({ sessions: httpSessions });
    const agent = world.agents.get('alpha');
    assert.equal(agent.estimatedCost, 0.4);
    assert.equal(Number(agent.cost), 0.42);
    assert.equal(agent.cost.source, 'provider');
    assert.equal(agent.turnStartedAt, 10);
    assert.equal(agent.lastTurnDurationMs, 25);
    assert.equal(agent.signalSource, 'transcript');
    assert.deepEqual(agent.workingSet, [file('src/router.ts', 'write')]);
    assert.deepEqual(agent.collisions, collisions);

    const { WebSocketClient } = await import(
        `../../claudeville/src/infrastructure/WebSocketClient.js?working-set-ws=${Date.now()}`
    );
    const client = new WebSocketClient();
    client._rememberSnapshot({ sessions: sessionsPayload, collisions, seq: 1 });
    assert.deepEqual(client._state.collisions, collisions);
    let wsUpdate = null;
    const unsubscribe = eventBus.on('ws:update', payload => { wsUpdate = payload; });
    t.after(unsubscribe);
    client._handleDelta({
        baseSeq: 1,
        seq: 2,
        patch: [{ op: 'replace', path: '/collisions', value: collisions }],
        timestamp: 20,
    });
    assert.deepEqual(wsUpdate.sessions[0].cost, cost);
    assert.equal(wsUpdate.sessions[0].turnStartedAt, 10);
    assert.deepEqual(wsUpdate.sessions[0].workingSet, [file('src/router.ts', 'write')]);
    assert.deepEqual(wsUpdate.collisions, collisions);
});

const ompWorkingSetFixture = fs.readFileSync(
    new URL('../adapters/fixtures/omp/working-set.jsonl', import.meta.url), 'utf8',
).trim().split('\n').map(line => JSON.parse(line));

function ompWorkingSet(records = ompWorkingSetFixture) {
    return ompAdapter.parseOmpTranscript(records, { fileMtimeMs: 0 }).session.workingSet;
}

test('OMP projects verified read, write, and structured edit paths newest first', () => {
    assert.deepEqual(ompWorkingSet(), [
        { path: 'src/edit.js', op: 'write', at: 1788264004000, source: 'transcript' },
        { path: 'src/write.js', op: 'write', at: 1788264002000, source: 'transcript' },
        { path: 'src/read.js', op: 'read', at: 1788264001000, source: 'transcript' },
    ]);
});

test('OMP ignores pathless records, patch prose, failed edits, and non-file resources', () => {
    const records = structuredClone(ompWorkingSetFixture);
    records[1].message.content[0].arguments.path = 'https://example.com/file.js';
    records[2].message.content[0].arguments.path = 'xd://lsp';
    records[4].message.isError = true;
    assert.deepEqual(ompWorkingSet(records), []);
    assert.deepEqual(ompWorkingSet([records[0], records.at(-1)]), []);
});

test('OMP caps output at 16 paths and remembers only the latest 64 path observations', () => {
    const records = [ompWorkingSetFixture[0]];
    for (let i = 0; i < 20; i++) {
        const record = structuredClone(ompWorkingSetFixture[1]);
        record.message.timestamp = 1788264010000 + i;
        record.message.content[0].arguments.path = `src/file-${i}.js`;
        records.push(record);
    }
    assert.deepEqual(ompWorkingSet(records).map(item => item.path),
        Array.from({ length: 16 }, (_, i) => `src/file-${19 - i}.js`));
    for (let i = 0; i < 64; i++) {
        const record = structuredClone(ompWorkingSetFixture[2]);
        record.message.timestamp = 1788264020000 + i;
        record.message.content[0].arguments.path = 'src/file-19.js';
        records.push(record);
    }
    assert.deepEqual(ompWorkingSet(records), [
        { path: 'src/file-19.js', op: 'write', at: 1788264020063, source: 'transcript' },
    ]);
});
