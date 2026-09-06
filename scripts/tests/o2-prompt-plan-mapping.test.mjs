import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager, digestAgentPayload } from '../../claudeville/src/application/AgentManager.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';

function recordingWorld() {
    const updates = [];
    const world = {
        agents: new Map(),
        addAgent(agent) { this.agents.set(agent.id, agent); },
        updateAgent(id, data) {
            updates.push(data);
            this.agents.get(id)?.update(data);
        },
        removeAgent(id) { this.agents.delete(id); },
    };
    return { world, updates };
}

function liveSession(overrides = {}) {
    return {
        sessionId: 'prompt-plan-session',
        agentId: 'prompt-plan-session',
        name: 'Wren',
        provider: 'claude',
        status: 'active',
        turnState: 'working',
        lastActivity: 1_800_000_000_000,
        ...overrides,
    };
}

test('session prompt and TodoWrite data become bounded domain Agent state', () => {
    const { world } = recordingWorld();
    const manager = new AgentManager(world, null, { clock: () => 1_800_000_001_000 });
    const todos = Array.from({ length: 65 }, (_, index) => ({
        subject: `  item ${index}  `,
        status: index === 0 ? 'COMPLETED' : index === 1 ? 'IN_PROGRESS' : 'unexpected',
        phase: index === 0 ? `  ${'P'.repeat(100)}  ` : 'Implementation',
    }));
    const payload = manager._sessionToAgentPayload(liveSession({
        lastPrompt: `  ${'x'.repeat(500)}  `,
        todos,
        gitBranch: `  ${'b'.repeat(300)}  `,
    }), null);

    assert.equal(payload.lastPrompt.length, 200);
    assert.equal(payload.todos.length, 64);
    assert.deepEqual(payload.todos.slice(0, 3), [
        { subject: 'item 0', status: 'completed', phase: 'P'.repeat(80) },
        { subject: 'item 1', status: 'in_progress', phase: 'Implementation' },
        { subject: 'item 2', status: 'pending', phase: 'Implementation' },
    ]);
    assert.equal(payload.gitBranch.length, 256);

    manager.handleWebSocketMessage({ sessions: [liveSession({
        lastPrompt: 'Keep the real provider plan visible',
        todos: [{ subject: 'Map TodoWrite', status: 'in_progress', phase: 'Mapping' }],
        gitBranch: 'feature/taskboard',
    })] });
    const agent = world.agents.get('prompt-plan-session');
    assert.ok(agent instanceof Agent);
    assert.equal(agent.lastPrompt, 'Keep the real provider plan visible');
    assert.deepEqual(agent.todos, [{ subject: 'Map TodoWrite', status: 'in_progress', phase: 'Mapping' }]);
    assert.equal(agent.gitBranch, 'feature/taskboard');
    manager.stop();
});

test('prompt-plan signature reacts only when provider data changes', () => {
    const { world, updates } = recordingWorld();
    const manager = new AgentManager(world, null, { clock: () => 1_800_000_001_000 });
    const first = liveSession({
        lastPrompt: 'Render the board',
        todos: [{ subject: 'Draw chalk', status: 'pending', phase: 'Presentation' }],
        gitBranch: 'feature/taskboard',
    });

    manager.handleWebSocketMessage({ sessions: [structuredClone(first)] });
    manager.handleWebSocketMessage({ sessions: [structuredClone(first)] });
    assert.equal(updates.length, 0);

    const changed = structuredClone(first);
    changed.todos[0].status = 'completed';
    manager.handleWebSocketMessage({ sessions: [changed] });
    assert.equal(updates.length, 1);
    assert.deepEqual(world.agents.get(first.sessionId).todos, [
        { subject: 'Draw chalk', status: 'completed', phase: 'Presentation' },
    ]);

    const tailA = Array.from({ length: 64 }, (_, index) => ({ subject: `row ${index}`, status: 'pending', phase: null }));
    const tailB = structuredClone(tailA);
    tailB.at(-1).status = 'completed';
    assert.notEqual(digestAgentPayload({ todos: tailA }), digestAgentPayload({ todos: tailB }));
    manager.stop();
});

test('Agent constructor enforces prompt-plan absence and bounds', () => {
    const absent = new Agent({ id: 'absent', lastPrompt: '   ', todos: null, gitBranch: '' });
    assert.equal(absent.lastPrompt, null);
    assert.deepEqual(absent.todos, []);
    assert.equal(absent.gitBranch, null);

    const bounded = new Agent({
        id: 'bounded',
        lastPrompt: ` ${'p'.repeat(250)} `,
        todos: Array.from({ length: 65 }, (_, index) => ({
            subject: ` ${'s'.repeat(220)}${index} `,
            status: index === 0 ? 'COMPLETED' : 'unknown',
            phase: index === 0 ? ` ${'h'.repeat(100)} ` : undefined,
        })),
        gitBranch: ` ${'g'.repeat(300)} `,
    });
    assert.equal(bounded.lastPrompt.length, 200);
    assert.equal(bounded.todos.length, 64);
    assert.equal(bounded.todos[0].subject.length, 200);
    assert.equal(bounded.todos[0].status, 'completed');
    assert.equal(bounded.todos[0].phase, 'h'.repeat(80));
    assert.equal(bounded.todos[1].status, 'pending');
    assert.equal(bounded.todos[1].phase, null);
    assert.equal(bounded.gitBranch.length, 256);
});
