import test from 'node:test';
import assert from 'node:assert/strict';

import {
    anchoredCueDelayMs,
    cueNoteDue,
    cueNoteOffsetsMs,
    cueScoreDiagnostics,
    publishCueScore,
    resetCueScore,
    scheduleAccent,
} from '../../claudeville/src/presentation/shared/audio/CueScore.js';
import {
    sectionForCounts,
    updateWorkingSection,
    workingSectionLabel,
} from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';

test('a council cue carries one note per gathered member, capped at five', () => {
    assert.equal(cueNoteOffsetsMs('council', { teamSize: 2 }).length, 2);
    assert.equal(cueNoteOffsetsMs('council', { teamSize: 4 }).length, 4);
    assert.equal(cueNoteOffsetsMs('council', { teamSize: 9 }).length, 5);
    assert.deepEqual(cueNoteOffsetsMs('recovery'), [0, 200]);
});

test('a more urgent summons closes the gap between its two notes', () => {
    const calm = cueNoteOffsetsMs('summons', { waitingCount: 1, oldestWaitMs: 0 });
    const urgent = cueNoteOffsetsMs('summons', { waitingCount: 5, oldestWaitMs: 20 * 60 * 1000 });
    assert.ok(urgent[1] < calm[1]);
});

test('with no admitted cue every accent is already due', () => {
    resetCueScore();
    assert.equal(cueNoteDue('recovery', 'agent-1', 0, 1000), true);
    assert.equal(cueNoteDue('recovery', 'agent-1', 1, 1000), true);
});

test('an accent waits for its own note and then stays drawn', () => {
    resetCueScore();
    publishCueScore({ kind: 'recovery', agentId: 'agent-1', startMs: 5000, offsetsMs: [0, 200] });
    assert.equal(cueNoteDue('recovery', 'agent-1', 0, 4900), false);
    assert.equal(cueNoteDue('recovery', 'agent-1', 1, 5100), false);
    assert.equal(cueNoteDue('recovery', 'agent-1', 0, 5000), true);
    assert.equal(cueNoteDue('recovery', 'agent-1', 1, 5210), true);
    assert.equal(cueNoteDue('recovery', 'agent-1', 1, 5210), true);
});

test('members past the last note land on the final one', () => {
    resetCueScore();
    publishCueScore({ kind: 'council', teamName: 'Blue', startMs: 0, offsetsMs: [0, 280, 560] });
    assert.equal(cueNoteDue('council', 'Blue', 6, 559), false);
    assert.equal(cueNoteDue('council', 'Blue', 6, 560), true);
});

test('another cue of the same kind never claims a different body\'s notes', () => {
    resetCueScore();
    publishCueScore({ kind: 'recovery', agentId: 'agent-1', startMs: 9000, offsetsMs: [0, 200] });
    assert.equal(cueNoteDue('recovery', 'agent-1', 0, 8000), false);
    assert.equal(cueNoteDue('recovery', 'agent-2', 0, 8000), true);
});

test('a declared accent snaps to a near note and keeps a far time of its own', () => {
    resetCueScore();
    publishCueScore({ kind: 'arrival', agentId: 'agent-1', startMs: 1000, offsetsMs: [0, 220] });
    assert.equal(scheduleAccent('agent-1', 1150, 'arrival', 1000), 1220);
    assert.equal(scheduleAccent('agent-1', 4000, 'arrival', 1000), 4000);
});

test('an accent declared before the cue pulls its carrying note onto itself', () => {
    resetCueScore();
    const now = 1000;
    const landing = now + 3000;
    assert.equal(scheduleAccent('agent-7', landing, 'arrival', now), landing);
    // The second arrival note (offset 220 ms) must ring at the declared time.
    const delay = anchoredCueDelayMs('arrival', 'agent-7', [0, 220], 180, 30, now);
    assert.equal(now + 30 + delay + 220, landing);
});

test('an accent beyond the anchor bound leaves the cue where it was', () => {
    resetCueScore();
    scheduleAccent('agent-8', 60000, 'arrival', 1000);
    assert.equal(anchoredCueDelayMs('arrival', 'agent-8', [0, 220], 180, 30, 1000), 180);
});

test('a kind with no body accent is never anchored', () => {
    resetCueScore();
    scheduleAccent('agent-9', 4000, 'recovery', 1000);
    assert.equal(anchoredCueDelayMs('recovery', 'agent-9', [0, 200], 180, 30, 1000), 180);
});

test('the score diagnostics report drawn accents and their lag', () => {
    resetCueScore();
    publishCueScore({ kind: 'recovery', agentId: 'agent-1', startMs: 2000, offsetsMs: [0, 200] });
    cueNoteDue('recovery', 'agent-1', 0, 2004);
    cueNoteDue('recovery', 'agent-1', 1, 2209);
    const diagnostics = cueScoreDiagnostics();
    assert.equal(diagnostics.notesDrawn, 2);
    assert.equal(diagnostics.maxLagMs, 9);
    assert.deepEqual(diagnostics.lags, [4, 9]);
});

test('the score table stays bounded', () => {
    resetCueScore();
    for (let i = 0; i < 20; i++) {
        publishCueScore({ kind: 'recovery', agentId: `agent-${i}`, startMs: 0, offsetsMs: [0] });
    }
    const diagnostics = cueScoreDiagnostics();
    assert.equal(diagnostics.scores, diagnostics.caps.scores);
    assert.equal(diagnostics.published, 20);
});

test('the working count picks the arrangement band', () => {
    assert.equal(sectionForCounts({ working: 0 }), 'rest');
    assert.equal(sectionForCounts({ working: 3 }), 'light');
    assert.equal(sectionForCounts({ working: 11 }), 'steady');
    assert.equal(sectionForCounts({ working: 12 }), 'full');
});

test('a real wait never hides behind a busy section', () => {
    assert.equal(sectionForCounts({ working: 24, actionable: 1 }), 'light');
    assert.equal(sectionForCounts({ working: 2, actionable: 1 }), 'light');
});

test('resting takes the long quiet hold and resuming takes the short one', () => {
    const busy = { applied: 'steady', pending: null, pendingSince: 0 };
    const quiet = { counts: { working: 0 }, now: 0 };
    let state = updateWorkingSection(busy, quiet);
    assert.deepEqual([state.applied, state.pending], ['steady', 'rest']);
    state = updateWorkingSection(state, { ...quiet, now: 29000 });
    assert.equal(state.applied, 'steady');
    state = updateWorkingSection(state, { ...quiet, now: 30000 });
    assert.equal(state.applied, 'rest');

    const work = { counts: { working: 2 }, now: 30000 };
    state = updateWorkingSection(state, work);
    assert.deepEqual([state.applied, state.pending], ['rest', 'light']);
    state = updateWorkingSection(state, { ...work, now: 34000 });
    assert.equal(state.applied, 'light');
});

test('a count that flutters back never rewrites the arrangement', () => {
    let state = { applied: 'steady', pending: null, pendingSince: 0 };
    state = updateWorkingSection(state, { counts: { working: 20 }, now: 0 });
    assert.equal(state.pending, 'full');
    state = updateWorkingSection(state, { counts: { working: 6 }, now: 2000 });
    assert.deepEqual([state.applied, state.pending], ['steady', null]);
    state = updateWorkingSection(state, { counts: { working: 20 }, now: 3000 });
    assert.equal(state.pendingSince, 3000);
    state = updateWorkingSection(state, { counts: { working: 20 }, now: 6000 });
    assert.equal(state.applied, 'steady');
    state = updateWorkingSection(state, { counts: { working: 20 }, now: 7000 });
    assert.equal(state.applied, 'full');
});

test('the section label states exact counts', () => {
    assert.equal(workingSectionLabel({ working: 7, waiting: 2 }), 'Working 7 · Waiting 2');
    assert.equal(workingSectionLabel({}), 'Working 0 · Waiting 0');
});
