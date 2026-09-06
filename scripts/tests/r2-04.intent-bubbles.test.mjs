// Villager speech is provenance-tagged model text only. These tests defend the
// three properties that the previous preset-pool system violated: intents no
// longer manufacture words, stale text never masquerades as current work, and
// nothing falls back to a canned or harness-derived line.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { DIALOGUE_COMPLETED_STALE_MS, DIALOGUE_STALE_MS } from '../../claudeville/src/config/dialogue.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';

function dialogue(overrides = {}) {
    return {
        text: 'Checking git state and largest files',
        full: null,
        kind: 'intent',
        source: 'omp.tool.i',
        fidelity: 'verbatim',
        redacted: false,
        observedAt: Date.now(),
        actionId: 'call-1',
        ...overrides,
    };
}

test('visit intents drive routing without manufacturing speech', () => {
    const now = Date.now();
    const agent = new Agent({
        id: 'intent-agent',
        provider: 'codex',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
    });
    const manager = new VisitIntentManager({ now: () => now });
    manager.reconcile([agent], now);

    agent.currentTool = 'Bash';
    agent.currentToolInput = 'npm test';
    manager.reconcile([agent], now + 1_000);

    // The intent still exists and still carries its structured reason.
    const intent = manager.getIntentForAgent(agent.id, now + 1_000);
    assert.equal(intent.reason, 'validate-after-edit');
    // But it puts no words in the agent's mouth.
    assert.equal(agent.visitIntentBubble, undefined);
    assert.equal(agent.speech(now + 1_000), null);
    manager.dispose();
});

test('an agent with no dialogue is silent rather than reciting a tool label', () => {
    const agent = new Agent({
        id: 'silent-agent',
        status: 'working',
        currentTool: 'Edit',
        currentToolInput: 'forge.js',
        lastMessage: 'Implemented R2-12 in the forge',
    });

    // Both a live tool and an assistant message are present; neither is speech.
    assert.equal(agent.speech(), null);
});

test('speech carries the model text verbatim with its provenance', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'speaking-agent',
        status: 'working',
        dialogue: dialogue({ observedAt: now - 5_000 }),
    });

    const speech = agent.speech(now);
    assert.equal(speech.text, 'Checking git state and largest files');
    assert.equal(speech.source, 'omp.tool.i');
    assert.equal(speech.fidelity, 'verbatim');
    assert.equal(speech.redacted, false);
    assert.equal(speech.observedAt, now - 5_000);
    // Intent is quotable: it renders as a tailed speech bubble.
    assert.equal(speech.shape, 'bubble');
    // No 24-character cap: the renderer truncates by measured pixel width, so
    // a real 36-character intent phrase survives the domain layer intact.
    assert.equal(speech.text.length > 24, true);
    assert.equal(speech.text.endsWith('files'), true);
});

test('reasoning renders as a chip, never as a quote', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'thinking-agent',
        status: 'working',
        dialogue: dialogue({
            kind: 'thinking',
            source: 'grok.thought.chunk',
            fidelity: 'excerpt',
            text: 'The user wants me to execute a research procedure for mint-bridge…',
            full: 'The user wants me to execute a research procedure for mint-bridge-boundary analysis.',
            observedAt: now - 1_000,
        }),
    });

    const speech = agent.speech(now);
    assert.equal(speech.shape, 'chip');
    assert.equal(speech.fidelity, 'excerpt');
    // The untrimmed text survives for the narration panel.
    assert.match(speech.full, /boundary analysis/);
});

test('stale dialogue falls silent instead of asserting finished work', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'stale-agent',
        status: 'working',
        dialogue: dialogue({ observedAt: now - DIALOGUE_STALE_MS - 1 }),
    });

    assert.equal(agent.speech(now), null);
    // One millisecond inside the window still speaks.
    agent.dialogue = dialogue({ observedAt: now - DIALOGUE_STALE_MS + 1 });
    assert.equal(agent.speech(now).text, 'Checking git state and largest files');
});

test('a completed villager stops narrating sooner than a working one', () => {
    const now = 1_800_000_000_000;
    const observedAt = now - DIALOGUE_COMPLETED_STALE_MS - 1;
    // Same line, same age: still current for a working agent, already a parting
    // summary for one that has finished.
    const working = new Agent({ id: 'working-agent', status: 'working', dialogue: dialogue({ observedAt }) });
    const completed = new Agent({ id: 'completed-agent', status: 'completed', dialogue: dialogue({ observedAt }) });

    assert.equal(working.speech(now).text, 'Checking git state and largest files');
    assert.equal(completed.speech(now), null);
});

test('a question outlives the window only while the operator has not answered', () => {
    const now = 1_800_000_000_000;
    const asked = dialogue({ kind: 'assistant', source: 'omp.message', observedAt: now - DIALOGUE_STALE_MS * 4 });

    // Blocked on the operator: the question is still the truth of the session.
    const waiting = new Agent({ id: 'waiting-agent', status: 'waiting_on_user', dialogue: asked });
    const held = waiting.speech(now);
    assert.equal(held.text, asked.text);
    // Held lines disclose themselves rather than posing as something just said.
    assert.equal(held.held, true);
    assert.equal(held.observedAt, asked.observedAt);

    // Same age, same text, but nothing is blocked: silence.
    const working = new Agent({ id: 'working-too', status: 'working', dialogue: asked });
    assert.equal(working.speech(now), null);

    // `waiting` is not an outstanding prompt. statusFromSessionActivity assigns
    // it to any session merely quiet for 30s-2min, so holding for it would let
    // an old ordinary line reappear whenever an agent paused.
    const quiet = new Agent({ id: 'quiet-agent', status: 'waiting', dialogue: asked });
    assert.equal(quiet.speech(now), null);
    // Every non-actionable state keeps the normal ceiling.
    for (const status of ['waiting', 'idle', 'errored', 'rate_limited', 'completed']) {
        const agent = new Agent({ id: `ceiling-${status}`, status, dialogue: asked });
        assert.equal(agent.speech(now), null, `${status} must not hold a stale line`);
    }

    // Reasoning is not a standing question, so it decays even while blocked.
    const thinking = new Agent({
        id: 'waiting-thinker',
        status: 'waiting_on_user',
        dialogue: dialogue({ kind: 'thinking', observedAt: now - DIALOGUE_STALE_MS * 4 }),
    });
    assert.equal(thinking.speech(now), null);

    // A fresh line is never marked held.
    const fresh = new Agent({
        id: 'waiting-fresh',
        status: 'waiting_on_user',
        dialogue: dialogue({ kind: 'assistant', observedAt: now - 1_000 }),
    });
    assert.equal(fresh.speech(now).held, false);
});

test('the client holds a blocked question the server has already dropped', () => {
    // The server only publishes lines inside its own max age, so retention has
    // to survive the poll where `dialogue` arrives null.
    const asked = dialogue({ kind: 'assistant', source: 'omp.message', observedAt: Date.now() - DIALOGUE_STALE_MS * 3 });
    const world = { agents: new Map([['s1', new Agent({ id: 's1', status: 'waiting_on_user', dialogue: asked })]]) };
    const manager = new AgentManager(world, { getSessions: async () => [] });

    // `tool_pending` + a wait reason is what the adapters emit for a session
    // blocked on the operator (see StatusResolver).
    const blocked = { sessionId: 's1', dialogue: null, turnState: 'tool_pending', waitReason: 'question', lastActivity: Date.now() };
    const heldPayload = manager._sessionToAgentPayload(blocked, null);
    assert.equal(heldPayload.status, 'waiting_on_user');
    assert.equal(heldPayload.dialogue, asked);

    // Once the agent is working again the retained question is dropped.
    const movedOn = manager._sessionToAgentPayload(
        { sessionId: 's1', dialogue: null, turnState: 'working', lastTool: 'Edit', lastActivity: Date.now() },
        null,
    );
    assert.equal(movedOn.status, 'working');
    assert.equal(movedOn.dialogue, null);

    // Reasoning is never retained, even while blocked.
    world.agents.set('s2', new Agent({ id: 's2', status: 'waiting_on_user', dialogue: dialogue({ kind: 'thinking' }) }));
    const notHeld = manager._sessionToAgentPayload(
        { sessionId: 's2', dialogue: null, turnState: 'tool_pending', waitReason: 'question', lastActivity: Date.now() },
        null,
    );
    assert.equal(notHeld.dialogue, null);

    // Ordinary inactivity retains nothing, even for assistant prose.
    world.agents.set('s3', new Agent({ id: 's3', status: 'waiting', dialogue: asked }));
    const quietPayload = manager._sessionToAgentPayload(
        { sessionId: 's3', dialogue: null, status: 'active', lastActivity: Date.now() - 45_000 },
        null,
    );
    assert.equal(quietPayload.status, 'waiting');
    assert.equal(quietPayload.dialogue, null);
});

test('departed villagers stay silent', () => {
    const now = 1_800_000_000_000;
    const agent = new Agent({
        id: 'departed-agent',
        status: 'completed',
        departedAt: now - 1_000,
        dialogue: dialogue({ observedAt: now - 1_000 }),
    });

    assert.equal(agent.isDeparted, true);
    assert.equal(agent.speech(now), null);
});

test('malformed dialogue is silence, not a guess', () => {
    const now = 1_800_000_000_000;
    for (const broken of [
        dialogue({ text: '' }),
        dialogue({ observedAt: null }),
        dialogue({ observedAt: 'yesterday' }),
    ]) {
        const agent = new Agent({ id: 'broken-agent', status: 'working', dialogue: broken });
        assert.equal(agent.speech(now), null);
    }
});

test('Round 1 biography identity still determines appearance', () => {
    const first = new Agent({ id: 'session-one', name: 'Ada', provider: 'claude' });
    const returning = new Agent({ id: 'session-two', name: 'Ada', provider: 'claude' });

    assert.equal(AgentBiography.identityKeyFor(first), AgentBiography.identityKeyFor(returning));
    assert.deepEqual(first.appearance, returning.appearance);
});
