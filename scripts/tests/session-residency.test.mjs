// Session residency: which sessions survive leaving the active window.
//
// The bug this prevents is subtle and total — if residency retains too much,
// the village fills with ghosts; if it retains too little, the sessions that
// most need a person vanish while they wait.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionResidency } = require('../../claudeville/services/sessionResidency.js');

const T = 1_700_000_000_000;
const session = (sessionId, turnState, extra = {}) => ({ sessionId, turnState, ...extra });
const ids = (list) => list.map((s) => s.sessionId).sort().join(',');

test('only unresolved tool calls survive the active window', () => {
    const residency = new SessionResidency({ ttlMs: 60_000 });
    residency.merge([
        session('done', 'awaiting_input'),
        session('blocked', 'tool_pending', { pendingTool: 'Edit', pendingSince: T - 60_000 }),
        session('busy', 'working'),
    ], T);

    const after = residency.merge([], T + 1000);
    assert.equal(ids(after), 'blocked');
    assert.ok(after.every((s) => s.resident === true));
});

test('providers with no turn state are not retained', () => {
    // Silence from a provider we cannot read says nothing, so inventing a
    // reason to keep it on screen would be a guess dressed as information.
    const residency = new SessionResidency({ ttlMs: 60_000 });
    residency.merge([session('mystery', 'unknown')], T);
    assert.deepEqual(residency.merge([], T + 1000), []);
});

test('a slow resident never acquires an invented approval', () => {
    const residency = new SessionResidency({ ttlMs: 10 * 60_000 });
    residency.merge([
        session('blocked', 'tool_pending', { pendingTool: 'Edit', pendingSince: T }),
    ], T);

    const [early] = residency.merge([], T + 1000);
    assert.equal(early.waitReason, null);

    const [late] = residency.merge([], T + 30_000);
    assert.equal(late.waitReason, null);
    assert.equal(late.awaitingSince, null);
    assert.equal(late.freshness.state, 'stale');
});

test('residents expire at the TTL', () => {
    const residency = new SessionResidency({ ttlMs: 5_000 });
    residency.merge([session('blocked', 'tool_pending', { pendingTool: 'Bash', pendingSince: T })], T);
    assert.equal(residency.merge([], T + 4_000).length, 1);
    assert.equal(residency.merge([], T + 6_000).length, 0);
    assert.equal(residency.getDiagnostics().expired, 1);
});

test('a live session shadows its resident copy rather than duplicating it', () => {
    const residency = new SessionResidency({ ttlMs: 60_000 });
    residency.merge([session('blocked', 'tool_pending', { pendingTool: 'Bash', pendingSince: T })], T);
    residency.merge([], T + 1000);
    const resumed = residency.merge([session('blocked', 'working')], T + 2000);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].resident, undefined);
    assert.equal(residency.getDiagnostics().resumed, 1);
    // Resuming into `working` also drops it from residency.
    assert.equal(residency.size, 0);
});

test('the cap evicts the stalest residents first', () => {
    const residency = new SessionResidency({ ttlMs: 10 * 60_000, maxResidents: 2 });
    residency.merge([session('a', 'tool_pending', { pendingTool: 'Bash' })], T);
    residency.merge([session('b', 'tool_pending', { pendingTool: 'Bash' })], T + 1000);
    residency.merge([session('c', 'tool_pending', { pendingTool: 'Bash' })], T + 2000);
    const held = residency.merge([], T + 3000);
    assert.equal(ids(held), 'b,c');
    assert.equal(residency.getDiagnostics().capEvictions, 1);
});

test('merge never drops or reorders the live list', () => {
    const residency = new SessionResidency({ ttlMs: 60_000 });
    residency.merge([session('blocked', 'tool_pending', { pendingTool: 'Bash' })], T);
    const live = [session('one', 'working'), session('two', 'working')];
    const merged = residency.merge(live, T + 1000);
    assert.deepEqual(merged.slice(0, 2).map((s) => s.sessionId), ['one', 'two']);
    assert.equal(merged[2].sessionId, 'blocked');
});

test('residency cannot extend a failed provider observation or an expired hook approval', () => {
    const residency = new SessionResidency();
    residency.merge([session('failed', 'tool_pending', { freshness: { state: 'stale', observedAt: T } })], T);
    assert.equal(residency.merge([], T + 1000).length, 0);
    residency.merge([session('hook', 'tool_pending', { signalSource: 'hook', signalObservedAt: T, waitReason: 'approval' })], T);
    assert.equal(residency.merge([], T + 30 * 60_000).length, 0);
});
