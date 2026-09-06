import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationModeForPressure, calculateScenePressure, MarkGovernor, MarkTier, salienceTierFor } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { operatorStatusLabel, sortAttentionAgents } from '../../claudeville/src/presentation/shared/SemanticTriage.js';
import { AgentAction, resolveAgentAction } from '../../claudeville/src/presentation/character-mode/ActionVocabulary.js';

test('semantic tiers preserve primary ordering and vocabulary', () => {
    assert.equal(salienceTierFor({ status: 'waiting_on_user' }), MarkTier.PRIMARY);
    assert.equal(salienceTierFor({ recent: true }), MarkTier.RECENT);
    assert.equal(salienceTierFor({ status: 'working' }), MarkTier.WORKING);
    assert.equal(operatorStatusLabel('waiting_on_user'), 'Needs you');
    assert.equal(operatorStatusLabel('idle'), 'Visiting');
});

test('primary reservations reject overlapping routine labels', () => {
    const governor = new MarkGovernor();
    governor.beginFrame();
    assert.equal(governor.reserve({ x: 10, y: 10, w: 80, h: 20 }, MarkTier.PRIMARY, 'hero'), true);
    assert.equal(governor.reserve({ x: 20, y: 12, w: 30, h: 10 }, MarkTier.WORKING, 'routine'), false);
    assert.deepEqual(governor.admit(MarkTier.PRIMARY, 10, 10), { draw: true, alpha: 1 });
});

test('pressure transitions are deterministic and hysteretic', () => {
    const sprites = Array.from({ length: 36 }, () => ({}));
    const pressure = calculateScenePressure({ sprites, viewport: { width: 1000, height: 700 }, overlayArea: 140000, collisions: 18 });
    assert.ok(pressure > .42);
    assert.notEqual(annotationModeForPressure(pressure), 'full');
    assert.equal(annotationModeForPressure(.39, 'compact'), 'compact');
});

test('attention queue sorts human intervention before errors and waits', () => {
    const sorted = sortAttentionAgents([{ id: 'w', status: 'waiting' }, { id: 'e', status: 'errored' }, { id: 'n', status: 'waiting_on_user' }]);
    assert.deepEqual(sorted.map(item => item.id), ['n', 'e', 'w']);
});

test('six-action vocabulary maps semantic work without provider branches', () => {
    assert.deepEqual(AgentAction, {
        READ: 'read',
        WORK: 'work',
        THINK: 'think',
        TALK: 'talk',
        CELEBRATE: 'celebrate',
        SETTLED: 'settled',
    });

    const fixtures = [
        [{ status: 'working', currentTool: 'Read' }, AgentAction.READ],
        [{ status: 'working', currentTool: 'exec' }, AgentAction.WORK],
        [{ status: 'waiting', currentTool: 'plan' }, AgentAction.THINK],
        [{ status: 'working', currentTool: 'SendMessage' }, AgentAction.TALK],
    ];
    const identities = [
        { provider: 'claude', model: 'claude-sonnet' },
        { provider: 'codex', model: 'gpt-5' },
        { provider: 'gemini', model: 'gemini-pro' },
    ];
    for (const [input, expected] of fixtures) {
        for (const identity of identities) {
            assert.equal(resolveAgentAction({ ...input, ...identity }), expected);
        }
    }

    const now = 100_000;
    const completed = { id: 'agent-1', status: 'completed', departedAt: null };
    const verifiedOutcome = {
        kind: 'commit',
        project: 'claude-ville',
        agentId: 'agent-1',
        at: now,
    };
    assert.equal(resolveAgentAction(completed, { now }), null);
    assert.equal(resolveAgentAction(completed, { verifiedOutcome, now }), AgentAction.CELEBRATE);
    assert.notEqual(resolveAgentAction(completed, {
        verifiedOutcome: { ...verifiedOutcome, agentId: 'another-agent' },
        now,
    }), AgentAction.CELEBRATE);
    assert.notEqual(resolveAgentAction(completed, {
        verifiedOutcome: { ...verifiedOutcome, at: now - 5000 },
        now,
    }), AgentAction.CELEBRATE);
    assert.equal(resolveAgentAction({ ...completed, departedAt: now - 1 }, {
        verifiedOutcome,
        now,
    }), AgentAction.SETTLED);
    assert.equal(resolveAgentAction({ ...completed, provider: 'unknown', model: 'unknown' }, { now }), null);
});
