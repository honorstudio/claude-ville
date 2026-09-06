import test from 'node:test';
import assert from 'node:assert/strict';

import { SpendLedger } from '../../claudeville/src/application/SpendLedger.js';

const T = 1_700_000_000_000;

function session(id, projectPath, provider, input = 0, cost = 0) {
    return {
        id,
        projectPath,
        provider,
        tokens: { input, output: 0, cacheRead: 0, cacheCreate: 0 },
        cost,
    };
}

function worldOf(...agents) {
    return { agents: new Map(agents.map(agent => [agent.id, agent])) };
}

test('rollups attribute observed deltas to existing project and provider identities', () => {
    const alpha = session('a', '/work/alpha', 'claude', 1_000, 1);
    const beta = session('b', '/work/beta', 'codex', 2_000, 2);
    const ledger = new SpendLedger(worldOf(alpha, beta));
    ledger.sample(T);

    alpha.tokens.input += 500;
    alpha.cost += 0.1;
    beta.tokens.input += 2_000;
    beta.cost += 0.5;
    ledger.sample(T + 10_000);
    alpha.tokens.input += 500;
    alpha.cost += 0.1;
    beta.tokens.input += 3_000;
    beta.cost += 0.75;
    ledger.sample(T + 180_000);

    const { projects, providers } = ledger.rollups(T + 180_000);
    assert.deepEqual(projects.map(row => row.key), ['/work/beta', '/work/alpha']);
    assert.equal(projects[0].tokens, 5_000);
    assert.equal(projects[0].cost, 1.25);
    assert.equal(projects[0].activeSessions, 1);
    assert.ok(projects[0].burnRate.tokensPerHour > projects[1].burnRate.tokensPerHour);
    assert.deepEqual(providers.map(row => row.key), ['codex', 'claude']);
    assert.equal(providers[0].tokens, 5_000);
});

test('sessions sharing a project combine there but remain split by provider', () => {
    const claude = session('a', '/work/town', 'claude', 100, 1);
    const codex = session('b', '/work/town', 'codex', 100, 1);
    const ledger = new SpendLedger(worldOf(claude, codex));
    ledger.sample(T);
    claude.tokens.input += 200;
    codex.tokens.input += 300;
    ledger.sample(T + 1_000);

    const { projects, providers } = ledger.rollups(T + 1_000);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].tokens, 500);
    assert.equal(projects[0].activeSessions, 2);
    assert.equal(providers.find(row => row.key === 'claude').tokens, 200);
    assert.equal(providers.find(row => row.key === 'codex').tokens, 300);
});

test('an active project with no attributable delta stays visible as watching', () => {
    const fresh = session('fresh', '/work/new-project', 'gemini', 90_000, 7);
    const ledger = new SpendLedger(worldOf(fresh));
    ledger.sample(T);

    const { projects } = ledger.rollups(T);
    assert.deepEqual(projects, [{
        key: '/work/new-project',
        tokens: 0,
        cacheRead: 0,
        cost: 0,
        activeSessions: 1,
        burnRate: null,
    }]);
});

test('a reused session id with changed attribution re-baselines the interval', () => {
    const moving = session('same-id', '/work/old', 'claude', 100, 1);
    const ledger = new SpendLedger(worldOf(moving));
    ledger.sample(T);
    moving.projectPath = '/work/new';
    moving.tokens.input = 10_000;
    moving.cost = 9;
    ledger.sample(T + 1_000);

    assert.equal(ledger.today.tokens, 0);
    assert.equal(ledger.rollups(T + 1_000).projects[0].key, '/work/new');
    moving.tokens.input += 250;
    moving.cost += 0.2;
    ledger.sample(T + 2_000);
    assert.equal(ledger.rollups(T + 2_000).projects[0].tokens, 250);
});

test('daily project and provider totals survive a ledger reload', async () => {
    const now = Date.now();
    let saved;
    const store = {
        async get() { return saved ? { value: saved } : null; },
        async put(_name, record) { saved = record.value; },
    };
    const firstAgent = session('a', '/work/persisted', 'opencode', 100, 1);
    const first = new SpendLedger(worldOf(firstAgent), { store });
    first.sample(now);
    firstAgent.tokens.input += 400;
    firstAgent.cost += 0.25;
    first.sample(now + 1_000);
    await first.flush();

    const restored = new SpendLedger(worldOf(), { store });
    await restored.start();
    const rollups = restored.rollups();
    assert.equal(rollups.projects[0].key, '/work/persisted');
    assert.equal(rollups.projects[0].tokens, 400);
    assert.equal(rollups.providers[0].key, 'opencode');
    assert.equal(rollups.providers[0].cost, 0.25);
    await restored.stop();
});
