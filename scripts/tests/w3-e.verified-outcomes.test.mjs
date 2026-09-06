import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    AgentAction,
    resolveAgentAction,
    VERIFIED_CELEBRATION_MS,
} from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';
import {
    CHRONICLER_HOME,
    CHRONICLER_PAUSE_MS,
    CHRONICLER_QUEUE_LIMIT,
    Chronicler,
    coalesceChroniclerRoute,
    routeChroniclerEvent,
} from '../../claudeville/src/presentation/character-mode/Chronicler.js';
import {
    createVerifiedOutcome,
    verifiedOutcomeFromGitEvent,
} from '../../claudeville/src/presentation/character-mode/ChronicleEvents.js';

function agent(overrides = {}) {
    return {
        id: 'agent-1',
        agentId: 'agent-1',
        status: AgentStatus.IDLE,
        currentTool: null,
        departedAt: null,
        ...overrides,
    };
}

function eventTargetStub() {
    return { on: () => () => {} };
}

test('only a live verified C7 outcome celebrates', () => {
    const now = 100_000;
    const outcome = createVerifiedOutcome('commit', 'claude-ville', 'agent-1', now);

    assert.deepEqual(outcome, {
        kind: 'commit',
        project: 'claude-ville',
        agentId: 'agent-1',
        at: now,
    });
    assert.equal(resolveAgentAction(agent({ status: AgentStatus.COMPLETED }), {
        verifiedOutcome: outcome,
        now,
    }), AgentAction.CELEBRATE);

    const departed = agent({ status: AgentStatus.COMPLETED, departedAt: now - 1 });
    assert.equal(resolveAgentAction(departed, { now }), AgentAction.SETTLED);
    assert.notEqual(resolveAgentAction(departed, {
        verifiedOutcome: outcome,
        now,
    }), AgentAction.CELEBRATE);
    assert.equal(resolveAgentAction(agent({ status: AgentStatus.COMPLETED }), { now }), null);
});

test('failed pushes do not create a verified outcome or celebration', () => {
    const now = 200_000;
    const outcome = verifiedOutcomeFromGitEvent({
        id: 'push-failed',
        type: 'push',
        project: 'claude-ville',
        success: false,
        exitCode: 1,
        completedAt: now,
    }, { agentId: 'agent-1', at: now });

    assert.equal(outcome, null);
    assert.notEqual(resolveAgentAction(agent({ status: AgentStatus.COMPLETED }), {
        verifiedOutcome: outcome,
        now,
    }), AgentAction.CELEBRATE);
});

test('celebration expires after its one-shot window', () => {
    const at = 300_000;
    const outcome = createVerifiedOutcome('release', 'claude-ville', 'agent-1', at);
    const completed = agent({ status: AgentStatus.COMPLETED });

    assert.equal(resolveAgentAction(completed, { verifiedOutcome: outcome, now: at }), AgentAction.CELEBRATE);
    assert.equal(resolveAgentAction(completed, {
        verifiedOutcome: outcome,
        now: at + VERIFIED_CELEBRATION_MS,
    }), null);
});

test('read, work, think and real talk resolution remains unchanged', () => {
    assert.equal(resolveAgentAction(agent({
        status: AgentStatus.WORKING,
        currentTool: 'Read',
    })), AgentAction.READ);
    assert.equal(resolveAgentAction(agent({
        status: AgentStatus.WORKING,
        currentTool: 'Bash',
    })), AgentAction.WORK);
    assert.equal(resolveAgentAction(agent({
        status: AgentStatus.WAITING,
    })), AgentAction.THINK);
    assert.equal(resolveAgentAction(agent({
        status: AgentStatus.WORKING,
    }), { chatting: true }), AgentAction.TALK);
});

test('an empty Chronicler timeline stays at the Archive indefinitely', () => {
    const chronicler = new Chronicler({ eventTarget: eventTargetStub() });
    for (let now = 0; now <= 60 * 60_000; now += 60_000) chronicler.update(60_000, now);

    assert.deepEqual(chronicler.routeState, {
        phase: 'home',
        queueLength: 0,
        active: null,
        tileX: CHRONICLER_HOME.tileX,
        tileY: CHRONICLER_HOME.tileY,
    });
    chronicler.destroy();
});

test('one milestone produces one outbound route, pause and return home', () => {
    const chronicler = new Chronicler({ eventTarget: eventTargetStub() });
    chronicler.enqueueEvent('chronicle:milestone', {
        kind: 'feature',
        tileX: 10,
        tileY: 17,
    });
    const phases = [];
    let previous = chronicler.routeState.phase;

    for (let now = 0; now < 20_000; now += 16) {
        chronicler.update(16, now);
        const phase = chronicler.routeState.phase;
        if (phase !== previous) {
            phases.push(phase);
            previous = phase;
        }
    }

    assert.deepEqual(phases, ['outbound', 'pause', 'returning', 'home']);
    assert.equal(chronicler.pauseUntil, 0);
    assert.equal(chronicler.routeState.queueLength, 0);
    assert.equal(chronicler.tileX, CHRONICLER_HOME.tileX);
    assert.equal(chronicler.tileY, CHRONICLER_HOME.tileY);
    assert.ok(CHRONICLER_PAUSE_MS > 0);
    chronicler.destroy();
});

test('Chronicler bursts coalesce into a bounded queue', () => {
    let queue = [];
    const burst = [
        ...Array.from({ length: 20 }, () => routeChroniclerEvent('outcome:verified', { kind: 'push' })),
        routeChroniclerEvent('chronicle:recorded', { kind: 'errored' }),
        routeChroniclerEvent('chronicle:recorded', { kind: 'resolved', waitedMs: 0 }),
        routeChroniclerEvent('chronicle:recorded', { kind: 'resolved', waitedMs: 500 }),
        routeChroniclerEvent('outcome:verified', { kind: 'commit' }),
        routeChroniclerEvent('chronicle:milestone', { kind: 'release', tileX: 30, tileY: 20 }),
    ];
    for (const route of burst) queue = coalesceChroniclerRoute(queue, route);

    assert.ok(queue.length <= CHRONICLER_QUEUE_LIMIT);
    assert.equal(queue.filter(route => route.key === 'outcome:push').length, 1);
});

test('reduced motion causes zero Chronicler movement', () => {
    const chronicler = new Chronicler({ motionScale: 0, eventTarget: eventTargetStub() });
    chronicler.enqueueEvent('chronicle:milestone', {
        kind: 'feature',
        tileX: 16,
        tileY: 21,
    });
    chronicler.update(60 * 60_000, 60 * 60_000);

    assert.equal(chronicler.tileX, CHRONICLER_HOME.tileX);
    assert.equal(chronicler.tileY, CHRONICLER_HOME.tileY);
    assert.equal(chronicler.routeState.phase, 'home');
    chronicler.destroy();
});
