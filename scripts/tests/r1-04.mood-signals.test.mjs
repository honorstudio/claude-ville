import test from 'node:test';
import assert from 'node:assert/strict';

import { MoodService } from '../../claudeville/src/application/MoodService.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    MOOD_TUNING,
    Mood,
    deriveAgentMood,
} from '../../claudeville/src/domain/value-objects/AgentMood.js';

const NOW = 1_700_000_000_000;

function telemetryAgent(overrides = {}) {
    return {
        id: 'mood-signals-agent',
        status: AgentStatus.IDLE,
        tokens: { input: 0, output: 0, contextWindow: 0, contextWindowMax: 0 },
        gitEvents: [],
        ...overrides,
    };
}

test('context pressure derives an anxious mood only near the known threshold', () => {
    const calm = deriveAgentMood({ contextRatio: MOOD_TUNING.contextPressureRatio - 0.01 }, NOW);
    const anxious = deriveAgentMood({ contextRatio: 0.9 }, NOW);

    assert.equal(calm.type, Mood.NEUTRAL);
    assert.equal(anxious.type, Mood.ANXIOUS);
    assert.ok(anxious.intensity >= MOOD_TUNING.minIntensity);
});

test('MoodService threads the existing context-window telemetry into mood', () => {
    const agent = telemetryAgent({
        tokens: { input: 0, output: 0, contextWindow: 90, contextWindowMax: 100 },
    });

    new MoodService()._handleAgentSeen(agent);

    assert.equal(agent.mood.type, Mood.ANXIOUS);
});

test('a long WAITING_ON_USER session becomes distressed without an error', () => {
    const waitingSince = Date.now() - MOOD_TUNING.longWaitThresholdMs;
    const agent = telemetryAgent({
        status: AgentStatus.WAITING_ON_USER,
        awaitingSince: waitingSince,
    });

    const service = new MoodService();
    service._handleAgentSeen(agent);

    assert.equal(agent.mood.type, Mood.DISTRESSED);
    assert.equal(service._records.get(agent.id).lastErrorAt, 0);
    assert.equal(agent.mood.since, waitingSince);
});

test('an old awaitingSince timestamp is ignored after the session stops waiting', () => {
    const agent = telemetryAgent({
        awaitingSince: Date.now() - MOOD_TUNING.longWaitThresholdMs * 2,
    });

    new MoodService()._handleAgentSeen(agent);

    assert.equal(agent.mood.type, Mood.NEUTRAL);
});
