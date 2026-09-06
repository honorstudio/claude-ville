import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CUE_LANES,
    collapseCueBurst,
    compareCuePriority,
    computeCueMix,
    cueLifecycleDecision,
    updateQuietFloor,
} from '../../claudeville/src/presentation/shared/audio/CueGovernor.js';

test('an urgent cue preempts a routine cue', () => {
    const urgent = { kind: 'summons', lane: CUE_LANES.NEEDS_YOU };
    const routine = { kind: 'arrival', lane: CUE_LANES.ROUTINE };

    assert.ok(compareCuePriority(urgent, routine) < 0);
    assert.equal([routine, urgent].sort(compareCuePriority)[0], urgent);
});

test('six routine cues in one aggregation window become one honest result', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'arrival',
        lane: CUE_LANES.ROUTINE,
        agentId: `agent-${index}`,
        at: 1000 + index * 20,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].eventKind, 'aggregate');
    assert.equal(collapsed[0].aggregateCount, 6);
    assert.equal(collapsed[0].agentId, null);
    assert.match(collapsed[0].label, /6 arrivals/);
});

test('urgent cues never collapse', () => {
    const cues = Array.from({ length: 6 }, (_, index) => ({
        kind: 'summons',
        lane: CUE_LANES.NEEDS_YOU,
        agentId: `agent-${index}`,
    }));

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 6);
    assert.ok(collapsed.every(cue => cue.kind === 'summons'));
});

test('provider-voiced council cues bypass burst aggregation', () => {
    const cues = [
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'claude', aggregate: false },
        { kind: 'council', lane: CUE_LANES.ROUTINE, provider: 'codex', aggregate: false },
    ];

    const collapsed = collapseCueBurst(cues);

    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map(cue => cue.provider), ['claude', 'codex']);
});

test('urgent ducking preserves headroom and leaves cues above ambience', () => {
    for (const lane of [CUE_LANES.NEEDS_YOU, CUE_LANES.ERRORS, CUE_LANES.QUOTA]) {
        const mix = computeCueMix(lane, 1);
        assert.ok(mix.cueBusGain > mix.ambientBusGain);
        assert.ok(mix.cueBusGain <= mix.masterCeiling);
        assert.ok(mix.masterCeiling < 1);
    }
});

test('quiet floor requires sustained calm and sustained activity without flutter', () => {
    let state = updateQuietFloor(undefined, {
        calm: true,
        now: 0,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: true,
        now: 9999,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'active');

    state = updateQuietFloor(state, {
        calm: true,
        now: 10000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 11000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: true,
        now: 12000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 13000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    state = updateQuietFloor(state, {
        calm: false,
        now: 15999,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'resting');

    state = updateQuietFloor(state, {
        calm: false,
        now: 16000,
        enterAfterMs: 10000,
        leaveAfterMs: 3000,
    });
    assert.equal(state.mode, 'active');
});

test('hidden lifecycle suppresses ambience but permits summons without a return backlog', () => {
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.SCENERY,
        hidden: true,
    }), 'suppress');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.NEEDS_YOU,
        hidden: true,
    }), 'play');
    assert.equal(cueLifecycleDecision({
        lane: CUE_LANES.ROUTINE,
        returning: true,
    }), 'discard');
});
