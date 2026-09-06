import test from 'node:test';
import assert from 'node:assert/strict';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AudioDirector } from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';

function directorWithoutAudio() {
    const director = new AudioDirector({
        engine: { context: null, started: false },
    });
    // Exercise the agent dedupe independently of the four-second spacing gate.
    director.cueKit.governor.minSpacingMs = 0;
    return director;
}

function captureCues() {
    const cues = [];
    const unsubscribe = eventBus.on('audio:cue-played', cue => cues.push(cue));
    return { cues, unsubscribe };
}

test('distress and attention for one agent spend one cue', () => {
    const director = directorWithoutAudio();
    const capture = captureCues();
    try {
        eventBus.emit('distress:watchtower', {
            agentId: 'agent-error',
            kind: 'errored',
            label: 'Ada',
        });
        eventBus.emit('attention:raised', {
            agentId: 'agent-error',
            agent: { id: 'agent-error', name: 'Ada', status: 'errored' },
            reason: 'errored',
            waitingCount: 1,
            oldestWaitMs: 0,
        });

        assert.equal(capture.cues.length, 1);
        assert.equal(capture.cues[0].kind, 'distress');
        assert.equal(capture.cues[0].agentId, 'agent-error');
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});

test('attention and distress dedupe in either event order', () => {
    const director = directorWithoutAudio();
    const capture = captureCues();
    try {
        eventBus.emit('attention:raised', {
            agentId: 'agent-rate-limit',
            agent: { id: 'agent-rate-limit', name: 'Bram', status: 'rate_limited' },
            reason: 'rate_limited',
        });
        eventBus.emit('distress:watchtower', {
            agentId: 'agent-rate-limit',
            kind: 'rate_limited',
        });

        assert.equal(capture.cues.length, 1);
        assert.equal(capture.cues[0].kind, 'summons');
        assert.equal(capture.cues[0].agentId, 'agent-rate-limit');
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});

test('governor-approved cues emit the four-field contract without audio', () => {
    const director = directorWithoutAudio();
    const capture = captureCues();
    try {
        eventBus.emit('attention:raised', {
            agentId: 'agent-caption',
            agent: { id: 'agent-caption', name: 'Cora' },
            waitingCount: 3,
            oldestWaitMs: 90_000,
        });

        assert.equal(capture.cues.length, 1);
        assert.deepEqual(Object.keys(capture.cues[0]).sort(), ['agentId', 'at', 'kind', 'label']);
        assert.equal(capture.cues[0].kind, 'summons');
        assert.equal(capture.cues[0].agentId, 'agent-caption');
        assert.equal(capture.cues[0].label, 'Cora');
        assert.equal(Number.isFinite(capture.cues[0].at), true);
    } finally {
        capture.unsubscribe();
        director.destroy();
    }
});
