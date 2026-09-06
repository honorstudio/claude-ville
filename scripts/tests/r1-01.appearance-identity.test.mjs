import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';

function world() {
    return {
        agents: new Map(),
        addAgent(agent) { this.agents.set(agent.id, agent); },
        updateAgent() {},
        removeAgent(id) { this.agents.delete(id); },
    };
}

function storage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
    };
}

test('appearance follows biography identity rather than ephemeral session id', () => {
    const first = new Agent({ id: 'session-one', name: 'Ada', provider: 'claude' });
    const returning = new Agent({ id: 'session-two', name: 'Ada', provider: 'claude' });

    assert.equal(AgentBiography.identityKeyFor(first), AgentBiography.identityKeyFor(returning));
    assert.deepEqual(first.appearance, returning.appearance);
});

test('anonymous generated names and appearances survive manager restarts', () => {
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = storage();
    try {
        const firstWorld = world();
        const baseName = new Agent({ id: 'returning-session', provider: 'codex' }).name;
        firstWorld.addAgent(new Agent({ id: 'name-blocker', name: baseName, provider: 'codex' }));
        const firstManager = new AgentManager(firstWorld, null);
        firstManager._upsertAgent({ sessionId: 'returning-session', provider: 'codex' }, new Map());
        const first = firstWorld.agents.get('returning-session');
        assert.notEqual(first.name, baseName);

        const secondWorld = world();
        const secondManager = new AgentManager(secondWorld, null);
        secondManager._upsertAgent({ sessionId: 'returning-session', provider: 'codex' }, new Map());
        const returning = secondWorld.agents.get('returning-session');

        assert.equal(returning.name, first.name);
        assert.equal(AgentBiography.identityKeyFor(returning), AgentBiography.identityKeyFor(first));
        assert.deepEqual(returning.appearance, first.appearance);
    } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});
