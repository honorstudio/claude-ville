import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../../claudeville/src/application/SessionWatcher.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    message(data) {
        this.onmessage?.({ data: JSON.stringify(data) });
    }

    closeFromServer() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }
}

function assertSafeCodes(payloads) {
    for (const payload of payloads) {
        for (const field of ['lastErrorCode', 'code']) {
            if (payload[field] !== null && payload[field] !== undefined) {
                assert.equal(payload[field].includes('/'), false, `${field} leaked path-like text`);
            }
        }
    }
}

test('WebSocket state requires a snapshot and instruments reconnect recovery', async () => {
    const previousWindow = globalThis.window;
    const previousWebSocket = globalThis.WebSocket;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const previousRandom = Math.random;
    const timers = [];
    const states = [];
    let connected = 0;
    let disconnected = 0;

    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    globalThis.WebSocket = FakeWebSocket;
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => { timer.cleared = true; };
    Math.random = () => 0;
    FakeWebSocket.instances = [];

    const onState = payload => states.push(payload);
    const onConnected = () => { connected++; };
    const onDisconnected = () => { disconnected++; };
    eventBus.on('ws:state', onState);
    eventBus.on('ws:connected', onConnected);
    eventBus.on('ws:disconnected', onDisconnected);

    try {
        const { WebSocketClient } = await import(
            `../../claudeville/src/infrastructure/WebSocketClient.js?test=${Date.now()}`
        );
        const client = new WebSocketClient();
        client.connect();
        const first = FakeWebSocket.instances[0];
        first.open();

        assert.equal(client.state.state, 'syncing');
        assert.equal(client.state.lastSnapshotAt, null);
        assert.equal(states.some(state => state.state === 'live'), false);
        assert.equal(connected, 1);

        first.message({ type: 'init', seq: 1, sessions: [], teams: [] });
        assert.equal(client.state.state, 'live');
        assert.equal(typeof client.state.lastSnapshotAt, 'number');

        first.closeFromServer();
        assert.equal(client.state.state, 'reconnecting');
        assert.equal(client.state.attempts, 1);
        assert.equal(typeof client.state.nextRetryAt, 'number');
        assert.equal(client.state.lastErrorCode, 'socket-closed');
        assert.equal(disconnected, 1);

        timers.at(-1).callback();
        const second = FakeWebSocket.instances[1];
        second.open();
        assert.equal(client.state.state, 'reconnecting');
        assert.equal(client.state.attempts, 1);
        assert.equal(client.state.lastSnapshotAt !== null, true);

        second.message({ type: 'init', seq: 2, sessions: [], teams: [] });
        assert.equal(client.state.state, 'live');
        assert.equal(client.state.attempts, 0);
        assert.equal(client.state.nextRetryAt, null);
        assert.equal(client.state.lastErrorCode, null);

        assertSafeCodes(states);
        client.disconnect();
    } finally {
        eventBus.off('ws:state', onState);
        eventBus.off('ws:connected', onConnected);
        eventBus.off('ws:disconnected', onDisconnected);
        globalThis.window = previousWindow;
        globalThis.WebSocket = previousWebSocket;
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
        Math.random = previousRandom;
    }
});

test('delta baseline mismatch emits a safe code and requests resync', async () => {
    const previousWindow = globalThis.window;
    const previousWebSocket = globalThis.WebSocket;
    const states = [];
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    globalThis.WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const onState = payload => states.push(payload);
    eventBus.on('ws:state', onState);

    try {
        const { WebSocketClient } = await import(
            `../../claudeville/src/infrastructure/WebSocketClient.js?delta=${Date.now()}`
        );
        const client = new WebSocketClient();
        client.connect();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        socket.message({ type: 'init', seq: 7, sessions: [], teams: [] });
        socket.message({
            type: 'update-delta',
            baseSeq: 6,
            seq: 8,
            patch: [],
        });

        assert.equal(client.state.lastErrorCode, 'delta-baseline-mismatch');
        assert.deepEqual(socket.sent.at(-1), { type: 'resync' });
        assertSafeCodes(states);
        client.disconnect();
    } finally {
        eventBus.off('ws:state', onState);
        globalThis.window = previousWindow;
        globalThis.WebSocket = previousWebSocket;
    }
});

test('failed session poll preserves the last good roster and emits a safe outcome', async () => {
    let sessionsMode = [{ sessionId: 'last-good' }];
    let roster = [];
    const watcherStates = [];
    const manager = {
        handleWebSocketMessage(message) {
            roster = message.sessions;
        },
    };
    const watcher = new SessionWatcher(
        manager,
        { connect() {}, disconnect() {}, isConnected: false },
        {
            getSessions: async () => {
                if (sessionsMode === 'failure') throw new Error('/private/operator/session.jsonl');
                return sessionsMode;
            },
            getUsage: async () => null,
        },
    );
    watcher.running = true;
    const onState = payload => watcherStates.push(payload);
    const previousError = console.error;
    eventBus.on('watcher:state', onState);
    console.error = () => {};

    try {
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(roster, [{ sessionId: 'last-good' }]);
        assert.deepEqual(watcherStates.at(-1), { ok: true, at: watcherStates.at(-1).at });
        assert.equal(typeof watcherStates.at(-1).at, 'number');

        sessionsMode = 'failure';
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(roster, [{ sessionId: 'last-good' }]);
        assert.deepEqual(watcherStates.at(-1), { ok: false, code: 'session-poll-failed' });
        assertSafeCodes(watcherStates);
    } finally {
        eventBus.off('watcher:state', onState);
        console.error = previousError;
        watcher.running = false;
    }
});

test('fallback polling publishes lifecycle events with exact shapes', () => {
    const states = [];
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    globalThis.setInterval = () => ({ fake: true });
    globalThis.clearInterval = () => {};
    const watcher = new SessionWatcher(
        { handleWebSocketMessage() {} },
        { connect() {}, disconnect() {}, isConnected: false },
        { getSessions: () => new Promise(() => {}), getUsage: () => new Promise(() => {}) },
    );
    watcher.running = true;
    const onState = payload => states.push(payload);
    eventBus.on('watcher:state', onState);

    try {
        watcher._startPolling('socket-disconnected');
        watcher._stopPolling('websocket-active');
        assert.deepEqual(states, [
            { state: 'polling', reason: 'socket-disconnected' },
            { state: 'idle', reason: 'websocket-active' },
        ]);
    } finally {
        eventBus.off('watcher:state', onState);
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
        watcher.running = false;
    }
});

let providerImportId = 0;

async function readProviders(responseBody) {
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    globalThis.window = { location: { origin: 'http://localhost:4000' } };
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => responseBody,
    });

    try {
        const { ClaudeDataSource } = await import(
            `../../claudeville/src/infrastructure/ClaudeDataSource.js?providers=${Date.now()}-${providerImportId++}`
        );
        return await new ClaudeDataSource().getProviders();
    } finally {
        globalThis.window = previousWindow;
        globalThis.fetch = previousFetch;
    }
}

test('provider health summaries take precedence over legacy provider metadata', async () => {
    const providers = await readProviders({
        providers: [
            {
                name: 'Claude Code',
                provider: 'claude',
                homeDir: '/home/test/.claude',
                synthetic: false,
                supportsDetail: true,
                supportsWatchPaths: true,
            },
            {
                name: 'Gemini CLI',
                provider: 'gemini',
                homeDir: '/home/test/.gemini',
                synthetic: false,
                supportsDetail: true,
                supportsWatchPaths: true,
            },
        ],
        count: 2,
        health: [
            {
                id: 'claude',
                name: 'Claude Code',
                health: 'empty',
                sessions: 0,
                lastScanStartedAt: 10,
                lastSuccessAt: 20,
                errorCode: null,
                watchState: 'idle',
                skippedLines: 2,
            },
            {
                id: 'gemini',
                name: 'Gemini CLI',
                health: 'unavailable',
                sessions: 0,
                lastScanStartedAt: null,
                lastSuccessAt: null,
                errorCode: null,
                watchState: 'unavailable',
                skippedLines: 0,
            },
        ],
    });

    assert.equal(providers.find(provider => provider.id === 'claude').health, 'empty');
    assert.equal(providers.find(provider => provider.id === 'gemini').health, 'unavailable');
    assert.equal(providers.find(provider => provider.id === 'claude').lastSuccessAt, 20);
    assert.equal(providers.find(provider => provider.id === 'claude').skippedLines, 2);
});

test('legacy-only provider responses remain conservative about health', async () => {
    const providers = await readProviders({
        providers: [
            { provider: 'claude', name: 'Claude Code' },
            { provider: 'codex', name: 'Codex', sessions: 2 },
        ],
        count: 2,
    });

    assert.deepEqual(providers.map(provider => provider.id), ['claude', 'codex']);
    assert.deepEqual(providers.map(provider => provider.health), ['unavailable', 'unavailable']);
});

test('bare arrays and active provider responses remain supported', async () => {
    const bareProviders = await readProviders([
        'claude',
        { provider: 'codex', name: 'Codex' },
    ]);
    assert.deepEqual(bareProviders.map(provider => provider.id), ['claude', 'codex']);

    const activeProviders = await readProviders({
        active: [
            'claude',
            { id: 'gemini', name: 'Gemini', health: 'healthy', skippedLines: 3 },
        ],
    });
    assert.deepEqual(activeProviders, [
        {
            id: 'claude',
            name: 'claude',
            health: 'unavailable',
            sessions: 0,
            lastSuccessAt: null,
            skippedLines: 0,
        },
        {
            id: 'gemini',
            name: 'Gemini',
            health: 'healthy',
            sessions: 0,
            lastSuccessAt: null,
            skippedLines: 3,
        },
    ]);
});

test('health and legacy provider entries are both retained when unmatched', async () => {
    const providers = await readProviders({
        providers: [{ provider: 'legacy-only', name: 'Legacy Only' }],
        count: 1,
        health: [{ id: 'health-only', name: 'Health Only', health: 'empty', sessions: 0 }],
    });

    assert.deepEqual(providers.map(provider => provider.id), ['health-only', 'legacy-only']);
    assert.equal(providers.find(provider => provider.id === 'health-only').health, 'empty');
    assert.equal(providers.find(provider => provider.id === 'legacy-only').health, 'unavailable');
});
