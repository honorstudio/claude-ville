import test from 'node:test';
import assert from 'node:assert/strict';

import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import {
    LinkState,
    ProviderHealth,
    VillagePhase,
    bootStatusText,
    initialVillageState,
    linkStatusText,
    reduceVillageState,
} from '../../claudeville/src/application/VillageState.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import {
    ACTIONABLE_BUCKETS,
    SIGNAL_BUCKETS,
    actionableAgents,
    bucketAgents,
    bucketCounts,
    bucketForStatus,
} from '../../claudeville/src/domain/services/SignalLedger.js';
import { isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { sectionHealthCounts } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { operatorStatusLabel, sortAttentionAgents } from '../../claudeville/src/presentation/shared/SemanticTriage.js';

const FIXTURE = Object.freeze([
    fixtureAgent('working', AgentStatus.WORKING, 700, 1),
    fixtureAgent('idle', AgentStatus.IDLE, 600, 2),
    fixtureAgent('waiting', AgentStatus.WAITING, 50, 3),
    fixtureAgent('completed', AgentStatus.COMPLETED, 500, 4),
    fixtureAgent('quota', AgentStatus.RATE_LIMITED, 100, 5),
    fixtureAgent('error', AgentStatus.ERRORED, 200, 6),
    fixtureAgent('needs-you', AgentStatus.WAITING_ON_USER, 300, 7),
]);

function fixtureAgent(id, status, awaitingSince, inputTokens) {
    return Object.freeze({
        id,
        name: id,
        status,
        awaitingSince,
        lastSessionActivity: awaitingSince,
        tokens: Object.freeze({
            input: inputTokens,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
        }),
        cost: inputTokens,
    });
}

function fixtureWorld() {
    const world = new World();
    world.agents = new Map(FIXTURE.map(agent => [agent.id, agent]));
    return world;
}

function provider(id, health) {
    return Object.freeze({ id, name: id, health, sessions: 0 });
}

function observedVillage(providers, agentCount = 2) {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers });
    state = reduceVillageState(state, { type: 'snapshot', agentCount, at: 1_000 });
    return state;
}

test('a populated village never claims that providers or agents are absent', () => {
    const cases = [
        {
            name: 'all-empty',
            providers: [provider('claude', ProviderHealth.EMPTY), provider('codex', ProviderHealth.EMPTY)],
        },
        {
            name: 'mixed-empty-and-unavailable',
            providers: [provider('claude', ProviderHealth.EMPTY), provider('codex', ProviderHealth.UNAVAILABLE)],
        },
        {
            name: 'all-unavailable-but-agents-present',
            providers: [provider('claude', ProviderHealth.UNAVAILABLE), provider('codex', ProviderHealth.UNAVAILABLE)],
        },
    ];

    for (const entry of cases) {
        // The all-unavailable case is genuinely contradictory: agents cannot
        // exist when zero providers are readable. The reducer resolves that
        // contradiction in favor of the concrete populated snapshot.
        const state = observedVillage(entry.providers);
        const status = bootStatusText(state);

        assert.equal(
            state.phase,
            VillagePhase.READY_LIVE,
            `populated-village invariant (${entry.name}): snapshot evidence must resolve to ready-live`,
        );
        assert.notEqual(
            state.phase,
            VillagePhase.READY_NO_PROVIDERS,
            `populated-village invariant (${entry.name}): agents cannot coexist with ready-no-providers`,
        );
        assert.equal(
            status.includes('NO PROVIDERS'),
            false,
            `populated-village invariant (${entry.name}): status must not deny providers while agents render`,
        );
        assert.notEqual(
            state.phase,
            VillagePhase.READY_EMPTY,
            `populated-village invariant (${entry.name}): agents cannot coexist with ready-empty`,
        );
        assert.equal(
            status.includes('NOTHING ACTIVE'),
            false,
            `populated-village invariant (${entry.name}): status must not call a populated village empty`,
        );
    }
});

test('freshness cannot outrun snapshot evidence for any link state', () => {
    for (const linkState of Object.values(LinkState)) {
        const state = reduceVillageState(initialVillageState(), { type: 'link', state: linkState });
        const status = linkStatusText(state, 2_000);

        assert.equal(
            state.link.lastSnapshotAt,
            null,
            `freshness invariant (${linkState}): a link event must not forge a snapshot timestamp`,
        );
        assert.equal(
            status,
            'SYNCING',
            `freshness invariant (${linkState}): missing snapshot evidence must render SYNCING`,
        );
        assert.notEqual(
            status,
            'LIVE',
            `freshness invariant (${linkState}): missing snapshot evidence must never render LIVE`,
        );
    }
});

test('degraded provider evidence outranks silence', () => {
    const cases = [
        [provider('claude', ProviderHealth.DEGRADED)],
        [provider('claude', ProviderHealth.DEGRADED), provider('codex', ProviderHealth.EMPTY)],
        [provider('claude', ProviderHealth.DEGRADED), provider('codex', ProviderHealth.UNAVAILABLE)],
    ];

    for (const [index, providers] of cases.entries()) {
        const state = observedVillage(providers, 0);

        assert.equal(
            state.phase,
            VillagePhase.DEGRADED,
            `degraded-outranks-silence invariant (case ${index + 1}): unreadable evidence must render degraded`,
        );
        assert.equal(
            [VillagePhase.READY_EMPTY, VillagePhase.READY_NO_PROVIDERS].includes(state.phase),
            false,
            `degraded-outranks-silence invariant (case ${index + 1}): blindness must not render as silence`,
        );
    }
});

test('operator status text never leaks normalized error details', () => {
    const errorCodes = [
        'provider-read-failed',
        'websocket-closed',
        'permission-denied',
        'session-source-unavailable',
        'adapter-timeout',
    ];
    const forbidden = /[\\/]|Users|Error:|undefined|null/;

    for (const code of errorCodes) {
        let state = observedVillage([provider('claude', ProviderHealth.EMPTY)], 0);
        state = reduceVillageState(state, { type: 'source-failed', code });
        state = reduceVillageState(state, {
            type: 'link',
            state: LinkState.RECONNECTING,
            attempts: 2,
            lastErrorCode: code,
        });

        assert.equal(
            forbidden.test(bootStatusText(state)),
            false,
            `status-text invariant (${code}): boot copy must not leak paths, errors, or nullish values`,
        );
        assert.equal(
            forbidden.test(linkStatusText(state, 2_000)),
            false,
            `status-text invariant (${code}): link copy must not leak paths, errors, or nullish values`,
        );
    }
});

test('SignalLedger bucket totals reconcile with the World population', () => {
    const ledger = bucketCounts(FIXTURE);
    const stats = fixtureWorld().getStats();
    const bucketTotal = SIGNAL_BUCKETS.reduce((sum, name) => sum + ledger[name], 0);
    const actionableTotal = stats.needsYou + stats.errors + stats.quota;
    const actionableIds = actionableAgents(FIXTURE).map(agent => agent.id);

    assert.equal(
        SIGNAL_BUCKETS.length,
        6,
        'bucket-reconciliation invariant: the canonical partition must contain all six buckets',
    );
    assert.equal(
        bucketTotal,
        FIXTURE.length,
        'bucket-reconciliation invariant: six bucket totals must equal the agent population',
    );
    assert.equal(
        ledger.total,
        FIXTURE.length,
        'bucket-reconciliation invariant: ledger total must equal the agent population',
    );
    assert.equal(
        stats.attention,
        actionableTotal,
        'bucket-reconciliation invariant: World attention must equal needsYou + errors + quota exactly',
    );
    assert.equal(
        new Set(actionableIds).size,
        stats.attention,
        'bucket-reconciliation invariant: World attention must count each actionable agent once',
    );
});

test('every actionable bucket member is visible to attention traversal', () => {
    const bucketed = bucketAgents(FIXTURE);
    const bucketMembers = ACTIONABLE_BUCKETS.flatMap(name => bucketed[name]);
    const ledgerMembers = actionableAgents(bucketed);
    const attentionMembers = AttentionService.prototype.list.call({ world: fixtureWorld() });
    const ledgerIds = new Set(ledgerMembers.map(agent => agent.id));

    for (const bucketAgent of bucketMembers) {
        assert.equal(
            ledgerIds.has(bucketAgent.id),
            true,
            `actionable-visible invariant (${bucketAgent.id}): actionable bucket membership must enter attention population`,
        );
    }
    assert.deepEqual(
        new Set(ledgerMembers.map(agent => agent.id)),
        new Set(bucketMembers.map(agent => agent.id)),
        'actionable-visible invariant: SignalLedger traversal must contain every actionable bucket member',
    );
    assert.deepEqual(
        attentionMembers.map(agent => agent.id),
        ledgerMembers.map(agent => agent.id),
        'actionable-visible invariant: AttentionService and SignalLedger must expose identical membership and order',
    );
});

test('Wave 1 consumers agree on one seven-status partition', () => {
    const world = fixtureWorld();
    const ledger = bucketCounts(FIXTURE);
    const stats = world.getStats();
    const dashboard = sectionHealthCounts(FIXTURE);

    assert.deepEqual(
        {
            needsYou: stats.needsYou,
            errors: stats.errors,
            quota: stats.quota,
            watchlist: stats.watchlist,
        },
        {
            needsYou: ledger.needsYou,
            errors: ledger.errors,
            quota: ledger.quota,
            watchlist: ledger.watchlist,
        },
        'World must expose the ledger partition without reclassifying statuses',
    );

    assert.equal(stats.attention, stats.needsYou + stats.errors + stats.quota);
    assert.equal(stats.attention, 3, 'errored must be included with blocked and quota statuses');
    assert.equal(stats.errors, 1, 'the errored agent must remain visible in the actionable total');

    assert.deepEqual(dashboard, {
        errors: ledger.errors,
        needsYou: ledger.needsYou,
        quota: ledger.quota,
        working: ledger.working,
        watchlist: ledger.watchlist,
        idle: ledger.quiet,
    });
    assert.equal(dashboard.errors, 1, 'blocked and rate-limited work must not count as errors');

});

test('attention membership and traversal agree across the ledger and resolver', () => {
    const world = fixtureWorld();
    const expected = FIXTURE
        .filter(agent => isAttentionStatus(agent.status))
        .sort((a, b) => a.awaitingSince - b.awaitingSince)
        .map(agent => agent.id);
    const listed = AttentionService.prototype.list.call({ world }).map(agent => agent.id);

    assert.deepEqual(listed, expected);
    assert.deepEqual(listed, ['quota', 'error', 'needs-you'], 'traversal must be longest-waiting first');
    assert.equal(listed.includes('waiting'), false, 'generic waiting must not enter attention traversal');

    const semanticOrder = sortAttentionAgents(
        FIXTURE.filter(agent => isAttentionStatus(agent.status)),
    ).map(agent => agent.id);
    assert.deepEqual(
        new Set(semanticOrder),
        new Set(expected),
        'semantic urgency sorting must preserve the same actionable membership',
    );
    assert.deepEqual(
        semanticOrder,
        ['needs-you', 'error', 'quota'],
        'semantic display precedence is distinct from age-based attention traversal',
    );
});

test('generic waiting remains watchlist-only on every classification surface', () => {
    const waitingAgent = FIXTURE.find(agent => agent.status === AgentStatus.WAITING);
    const waitingLedger = bucketCounts([waitingAgent]);
    const waitingWorld = new World();
    waitingWorld.agents = new Map([[waitingAgent.id, waitingAgent]]);
    const waitingDashboard = sectionHealthCounts([waitingAgent]);

    assert.equal(ACTIONABLE_BUCKETS.includes(bucketForStatus(waitingAgent.status)), false);
    assert.equal(isAttentionStatus(waitingAgent.status), false);
    assert.equal(waitingWorld.getStats().attention, 0);
    assert.equal(AttentionService.prototype.list.call({ world: waitingWorld }).length, 0);
    assert.deepEqual(waitingDashboard, {
        errors: 0,
        needsYou: 0,
        quota: 0,
        working: 0,
        watchlist: 1,
        idle: 0,
    });
});

test('operator labels distinguish every actionable status and generic waiting', () => {
    const statuses = [
        AgentStatus.ERRORED,
        AgentStatus.RATE_LIMITED,
        AgentStatus.WAITING_ON_USER,
        AgentStatus.WAITING,
    ];
    const labels = statuses.map(operatorStatusLabel);

    assert.equal(new Set(labels).size, statuses.length, 'no actionable state may share an operator label');
    assert.deepEqual(labels, ['Errored', 'Waiting — quota', 'Needs you', 'Waiting']);
});

test('World preserves every pre-Wave 1 stats key and its original meaning', () => {
    const stats = fixtureWorld().getStats();
    const legacy = {
        working: 1,
        idle: 1,
        waiting: 1,
        errored: 1,
        attention: 3,
        total: 7,
        totalTokens: 28,
        totalCost: 28,
    };

    for (const [key, value] of Object.entries(legacy)) {
        assert.equal(Object.hasOwn(stats, key), true, `missing legacy stats key: ${key}`);
        assert.equal(stats[key], value, `changed legacy meaning for: ${key}`);
    }
});
