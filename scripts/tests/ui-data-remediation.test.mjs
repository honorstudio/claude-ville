import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { SessionWatcher } from '../../claudeville/src/application/SessionWatcher.js';
import { MODEL_REGISTRY } from '../../claudeville/src/config/models.generated.js';
import { truncateText } from '../../claudeville/src/presentation/shared/Formatters.js';
import {
    formatModelLabel as formatBrowserModelLabel,
    getModelVisualIdentity,
    providerBaseSpriteId,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

const require = createRequire(import.meta.url);
const {
    formatModelLabel: formatServerModelLabel,
    modelIdentity: getServerModelIdentity,
} = require('../../claudeville/adapters/sessionPresentation.js');

test('truncateText never exceeds its requested length', () => {
    const text = 'abcdefghijk';
    for (let max = 0; max <= 8; max++) {
        const value = truncateText(text, max);
        assert.ok(value.length <= max, `max ${max} returned ${value.length} characters`);
    }
    assert.equal(truncateText(text, 0), '');
    assert.equal(truncateText(text, 1), '…');
    assert.equal(truncateText(text, 5), 'abcd…');
    assert.equal(truncateText('short', 8), 'short');
});

test('unknown Gemini models use the same provider-base sprite as World mode', () => {
    assert.equal(providerBaseSpriteId('gemini-2.5-pro', 'gemini'), 'agent.gemini.base');
    assert.equal(
        getModelVisualIdentity('gemini-2.5-pro', null, 'gemini').spriteId,
        'agent.gemini.base',
    );
});

test('registry model identities stay aligned across browser and server presentation', () => {
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const row of MODEL_REGISTRY) {
        const baseIdentity = getModelVisualIdentity(row.sample, 'none', row.provider);
        assert.equal(baseIdentity.label, row.label, `${row.id} label did not come from the registry`);
        assert.equal(baseIdentity.shortLabel, row.shortLabel, `${row.id} short label did not come from the registry`);
        assert.equal(baseIdentity.modelClass, row.modelClass, `${row.id} class did not come from the registry`);
        assert.equal(baseIdentity.modelTier, row.modelTier, `${row.id} tier did not come from the registry`);
        assert.equal(baseIdentity.paletteKey, row.paletteKey, `${row.id} palette did not come from the registry`);
        assert.deepEqual(baseIdentity.trim, row.trim, `${row.id} trim did not come from the registry`);
        assert.deepEqual(baseIdentity.accent, row.accent, `${row.id} accent did not come from the registry`);
        assert.equal(baseIdentity.minimapColor, row.color, `${row.id} color did not come from the registry`);

        for (const effort of efforts) {
            const browserIdentity = getModelVisualIdentity(row.sample, effort, row.provider);
            const serverIdentity = getServerModelIdentity(row.sample, effort, row.provider);
            assert.equal(browserIdentity.spriteId, serverIdentity.spriteId, `${row.id} ${effort} sprite drifted`);
            assert.equal(serverIdentity.color, row.color, `${row.id} ${effort} server color drifted`);
            assert.equal(
                formatBrowserModelLabel(row.sample, effort, row.provider),
                formatServerModelLabel(row.sample, effort, row.provider),
                `${row.id} ${effort} label drifted`,
            );
        }
    }
});

test('legacy Mythos aliases use the canonical Fable identity', () => {
    const identity = getModelVisualIdentity('claude-mythos-5-1', 'high', 'claude');
    assert.equal(identity.label, 'Claude Fable');
    assert.equal(identity.shortLabel, 'Fable');
    assert.equal(identity.spriteId, 'agent.claude.fable');
    assert.equal(formatServerModelLabel('claude-mythos-5-1', 'high', 'claude'), 'Fable high');
});

test('ClaudeDataSource preserves a failed session request as a rejection', async () => {
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    globalThis.window = { location: { origin: 'http://localhost:4000' } };
    globalThis.fetch = async () => {
        throw new Error('offline');
    };
    try {
        const { ClaudeDataSource } = await import(
            `../../claudeville/src/infrastructure/ClaudeDataSource.js?test=${Date.now()}`
        );
        await assert.rejects(() => new ClaudeDataSource().getSessions(), /offline/);
    } finally {
        globalThis.window = previousWindow;
        globalThis.fetch = previousFetch;
    }
});

test('failed session polls never reconcile an authoritative empty list', async () => {
    const messages = [];
    let sessionsMode = 'failure';
    const watcher = new SessionWatcher(
        { handleWebSocketMessage: message => messages.push(message) },
        { connect() {}, disconnect() {}, isConnected: false },
        {
            getSessions: async () => {
                if (sessionsMode === 'failure') throw new Error('offline');
                return sessionsMode;
            },
            getUsage: async () => null,
        },
    );
    watcher.running = true;
    const originalError = console.error;
    console.error = () => {};
    try {
        await watcher._runPoll(0, new AbortController().signal);
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(messages, []);

        sessionsMode = [{ sessionId: 'recovered' }];
        await watcher._runPoll(0, new AbortController().signal);
        assert.deepEqual(messages, [{ sessions: [{ sessionId: 'recovered' }] }]);
    } finally {
        console.error = originalError;
        watcher.running = false;
    }
});
