import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SIGNAL_BUCKETS,
    ACTIONABLE_BUCKETS,
    bucketForStatus,
    isActionableStatus,
    bucketAgents,
    buckets,
    bucketCounts,
    actionableAgents,
    compareByWaitAge,
} from '../../claudeville/src/domain/services/SignalLedger.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import {
    REF_DT_MS,
    clampDt,
    dtAlpha,
    smoothingToTau,
    createMotionClock,
    advanceMotionClock,
    virtualFramesFor,
    inDutyPause,
    IDLE_STRIDE_PERIOD_MS,
} from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import {
    VillagePhase,
    LinkState,
    ProviderHealth,
    initialVillageState,
    reduceVillageState,
    isStale,
    snapshotAgeMs,
    bootStatusText,
    linkStatusText,
    isRetryable,
} from '../../claudeville/src/application/VillageState.js';

const agent = (id, status, awaitingSince = 0) => ({ id, status, awaitingSince, name: id });

// ---------------------------------------------------------------------------
// C2 — SignalLedger
// ---------------------------------------------------------------------------

test('C2: every domain status maps to exactly one bucket', () => {
    const seen = new Map();
    for (const status of Object.values(AgentStatus)) {
        const bucket = bucketForStatus(status);
        assert.ok(SIGNAL_BUCKETS.includes(bucket), `${status} -> unknown bucket ${bucket}`);
        seen.set(status, bucket);
    }
    assert.equal(seen.get(AgentStatus.WAITING_ON_USER), 'needsYou');
    assert.equal(seen.get(AgentStatus.ERRORED), 'errors');
    assert.equal(seen.get(AgentStatus.RATE_LIMITED), 'quota');
    assert.equal(seen.get(AgentStatus.WAITING), 'watchlist');
    assert.equal(seen.get(AgentStatus.WORKING), 'working');
    assert.equal(seen.get(AgentStatus.IDLE), 'quiet');
    assert.equal(seen.get(AgentStatus.COMPLETED), 'quiet');
});

test('C2: unknown and empty statuses fall to quiet, never to an actionable bucket', () => {
    for (const junk of [undefined, null, '', 'nonsense', 'ACTIVE-ish']) {
        assert.equal(bucketForStatus(junk), 'quiet');
        assert.equal(isActionableStatus(junk), false);
    }
});

test('C2: actionable membership is identical to StatusResolver.isAttentionStatus', () => {
    for (const status of Object.values(AgentStatus)) {
        assert.equal(
            isActionableStatus(status),
            isAttentionStatus(status),
            `divergence for ${status}: the ledger and the attention predicate must agree`,
        );
    }
});

test('C2: watchlist is never actionable', () => {
    assert.equal(ACTIONABLE_BUCKETS.includes('watchlist'), false);
    assert.equal(isActionableStatus(AgentStatus.WAITING), false);
});

test('C2: buckets accepts a World, a Map, and a plain array alike', () => {
    const list = [agent('a', AgentStatus.ERRORED), agent('b', AgentStatus.WORKING)];
    const map = new Map(list.map(a => [a.id, a]));
    const fromArray = bucketCounts(bucketAgents(list));
    const fromMap = bucketCounts(bucketAgents(map));
    const fromWorld = bucketCounts(buckets({ agents: map }));
    assert.deepEqual(fromArray, fromMap);
    assert.deepEqual(fromArray, fromWorld);
    assert.equal(fromArray.errors, 1);
    assert.equal(fromArray.working, 1);
    assert.equal(fromArray.actionable, 1);
    assert.equal(fromArray.total, 2);
});

test('C2: an errored agent counts as actionable — the old getStats bug', () => {
    const counts = bucketCounts(bucketAgents([
        agent('err', AgentStatus.ERRORED),
        agent('quota', AgentStatus.RATE_LIMITED),
        agent('blocked', AgentStatus.WAITING_ON_USER),
        agent('quiet-wait', AgentStatus.WAITING),
    ]));
    assert.equal(counts.actionable, 3, 'errored, quota and blocked all need a person');
    assert.equal(counts.watchlist, 1, 'a generic wait stays visible but is not an emergency');
});

test('C2: actionableAgents reproduces AttentionService.list() ordering', () => {
    // list() sorts by (awaitingSince || lastSessionActivity) ascending.
    const agents = [
        agent('recent', AgentStatus.ERRORED, 5000),
        agent('oldest', AgentStatus.RATE_LIMITED, 1000),
        agent('middle', AgentStatus.WAITING_ON_USER, 3000),
        agent('ignored', AgentStatus.WAITING, 10),
        agent('busy', AgentStatus.WORKING, 20),
    ];
    const reference = agents
        .filter(a => isAttentionStatus(a.status))
        .sort((a, b) => (a.awaitingSince || a.lastSessionActivity || 0) - (b.awaitingSince || b.lastSessionActivity || 0))
        .map(a => a.id);
    assert.deepEqual(actionableAgents(agents).map(a => a.id), reference);
    assert.deepEqual(reference, ['oldest', 'middle', 'recent'], 'longest-waiting first, not bucket-grouped');
});

test('C2: ordering is deterministic when wait anchors tie', () => {
    const a = [agent('zeta', AgentStatus.ERRORED, 100), agent('alpha', AgentStatus.ERRORED, 100)];
    assert.deepEqual(actionableAgents(a).map(x => x.id), ['alpha', 'zeta']);
    assert.deepEqual(actionableAgents([...a].reverse()).map(x => x.id), ['alpha', 'zeta']);
});

test('C2: lastSessionActivity is used when awaitingSince is absent', () => {
    const older = { id: 'older', status: AgentStatus.ERRORED, lastSessionActivity: 500 };
    const newer = { id: 'newer', status: AgentStatus.ERRORED, lastSessionActivity: 900 };
    assert.deepEqual(actionableAgents([newer, older]).map(a => a.id), ['older', 'newer']);
    assert.ok(compareByWaitAge(older, newer) < 0);
});

test('C2: bucketing does not mutate the caller list', () => {
    const list = [agent('b', AgentStatus.ERRORED, 2), agent('a', AgentStatus.ERRORED, 1)];
    const before = list.map(a => a.id);
    bucketAgents(list);
    actionableAgents(list);
    assert.deepEqual(list.map(a => a.id), before);
});

// ---------------------------------------------------------------------------
// C3 — MotionClock
// ---------------------------------------------------------------------------

test('C3: dtAlpha at the reference frame reproduces the authored coefficient', () => {
    for (const smoothing of [0.02, 0.08, 0.15, 0.5]) {
        assert.ok(
            Math.abs(dtAlpha(smoothing, REF_DT_MS) - smoothing) < 1e-12,
            `authored feel must be preserved exactly at 60 Hz for ${smoothing}`,
        );
    }
});

test('C3: a 30/60/120 Hz second converges to the same position', () => {
    const smoothing = 0.08;
    const run = (dt, steps) => {
        let x = 0;
        for (let i = 0; i < steps; i++) x += (100 - x) * dtAlpha(smoothing, dt);
        return x;
    };
    const at30 = run(1000 / 30, 30);
    const at60 = run(1000 / 60, 60);
    const at120 = run(1000 / 120, 120);
    assert.ok(Math.abs(at60 - at30) < 0.5, `30 vs 60 Hz drifted: ${at30} vs ${at60}`);
    assert.ok(Math.abs(at60 - at120) < 0.5, `120 vs 60 Hz drifted: ${at120} vs ${at60}`);
    // The old fixed-coefficient behaviour: at 120 Hz the naive lerp closes the
    // remaining distance far faster than real time should allow.
    let naive = 0;
    for (let i = 0; i < 120; i++) naive += (100 - naive) * smoothing;
    assert.ok(
        (100 - naive) * 2 < (100 - at120),
        `sanity: the naive per-frame lerp really was refresh-rate dependent (naive=${naive}, dt-normalized=${at120})`,
    );
});

test('C3: alpha is monotonic in dt and clamped to 1', () => {
    const s = 0.08;
    assert.ok(dtAlpha(s, 8) < dtAlpha(s, 16));
    assert.ok(dtAlpha(s, 16) < dtAlpha(s, 100));
    assert.ok(dtAlpha(s, 100000) <= 1);
    assert.equal(dtAlpha(s, 0), 0);
    assert.equal(dtAlpha(s, -5), 0);
    assert.equal(dtAlpha(0, 16), 0);
    assert.equal(dtAlpha(1, 16), 1);
});

test('C3: smoothingToTau matches the analytic time constant', () => {
    const tau = smoothingToTau(0.08);
    assert.ok(Math.abs(tau - (-REF_DT_MS / Math.log(0.92))) < 1e-9);
    assert.ok(tau > 190 && tau < 210, `expected ~200 ms, got ${tau}`);
});

test('C3: clampDt rejects non-finite and caps runaway frames', () => {
    assert.equal(clampDt(NaN), 0);
    assert.equal(clampDt(Infinity), 0, 'a non-finite delta is ignored, not capped');
    assert.equal(clampDt(1000), 250);
    assert.equal(clampDt(16), 16);
});

test('C3: the clock accumulates real time and derives virtual frames', () => {
    const clock = createMotionClock();
    for (let i = 0; i < 60; i++) advanceMotionClock(clock, REF_DT_MS);
    assert.ok(Math.abs(clock.elapsedMs - 1000) < 1e-6);
    assert.ok(Math.abs(clock.virtualFrame - 60) < 1e-6);
    assert.ok(Math.abs(virtualFramesFor(1000) - 60) < 1e-6);
});

test('C3: reduced motion freezes the clock rather than slowing it', () => {
    const clock = createMotionClock();
    advanceMotionClock(clock, REF_DT_MS, 1);
    const held = clock.elapsedMs;
    for (let i = 0; i < 50; i++) advanceMotionClock(clock, REF_DT_MS, 0);
    assert.equal(clock.elapsedMs, held, 'motionScale <= 0 must hold a static tableau');
    assert.equal(clock.lastDtMs, 0);
});

test('C3: two refresh rates agree on elapsed time for the same wall clock', () => {
    const slow = createMotionClock();
    const fast = createMotionClock();
    for (let i = 0; i < 30; i++) advanceMotionClock(slow, 1000 / 30);
    for (let i = 0; i < 120; i++) advanceMotionClock(fast, 1000 / 120);
    assert.ok(Math.abs(slow.elapsedMs - fast.elapsedMs) < 1e-6);
});

test('C3: the idle stride duty cycle preserves the authored 6-of-12 cadence', () => {
    assert.ok(Math.abs(IDLE_STRIDE_PERIOD_MS - 200) < 1e-6);
    // First half of the period is the pause, exactly as `phase < 6` of 12 was.
    assert.equal(inDutyPause(0, IDLE_STRIDE_PERIOD_MS), true);
    assert.equal(inDutyPause(99, IDLE_STRIDE_PERIOD_MS), true);
    assert.equal(inDutyPause(101, IDLE_STRIDE_PERIOD_MS), false);
    assert.equal(inDutyPause(199, IDLE_STRIDE_PERIOD_MS), false);
    assert.equal(inDutyPause(201, IDLE_STRIDE_PERIOD_MS), true);
    // Duty ratio holds regardless of sampling rate.
    let paused = 0;
    const samples = 1200;
    for (let i = 0; i < samples; i++) {
        if (inDutyPause(i * (1000 / 120), IDLE_STRIDE_PERIOD_MS)) paused++;
    }
    assert.ok(Math.abs(paused / samples - 0.5) < 0.02);
});

// ---------------------------------------------------------------------------
// C1 — VillageState
// ---------------------------------------------------------------------------

const healthy = (sessions = 1) => ({ id: 'claude', name: 'Claude', health: ProviderHealth.HEALTHY, sessions });
const emptyProvider = () => ({ id: 'codex', name: 'Codex', health: ProviderHealth.EMPTY, sessions: 0 });
const missing = () => ({ id: 'gemini', name: 'Gemini', health: ProviderHealth.UNAVAILABLE, sessions: 0 });
const broken = () => ({ id: 'kimi', name: 'Kimi', health: ProviderHealth.DEGRADED, sessions: 0, skippedLines: 2 });

test('C1: the first frame never claims LIVE', () => {
    const state = initialVillageState();
    assert.equal(state.phase, VillagePhase.STARTING);
    assert.equal(state.link.state, LinkState.SYNCING);
    assert.notEqual(linkStatusText(state), 'LIVE');
    assert.equal(bootStatusText(state), 'OPENING THE VILLAGE');
});

test('C1: a link event alone can never render LIVE without a snapshot', () => {
    let state = initialVillageState();
    state = reduceVillageState(state, { type: 'link', state: LinkState.LIVE });
    // No snapshot has arrived, so no surface may claim freshness.
    assert.ok([VillagePhase.STARTING, VillagePhase.SYNCING].includes(state.phase));
    assert.equal(linkStatusText(state), 'SYNCING', 'an opened socket is not proof that data arrived');
    assert.equal(snapshotAgeMs(state), null);
});

test('C1: only a fulfilled snapshot promotes the link to LIVE', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'sync-start' });
    state = reduceVillageState(state, { type: 'providers', providers: [healthy()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 3, at: 1000 });
    assert.equal(state.link.state, LinkState.LIVE);
    assert.equal(state.phase, VillagePhase.READY_LIVE);
    assert.equal(bootStatusText(state), 'WATCHING 3 AGENTS');
});

test('C1: one agent is singular', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 1, at: 1 });
    assert.equal(bootStatusText(state), 'WATCHING 1 AGENT');
});

test('C1: providers installed but idle is not an error', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [emptyProvider()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 0, at: 1 });
    assert.equal(state.phase, VillagePhase.READY_EMPTY);
    assert.equal(bootStatusText(state), 'PROVIDERS FOUND / NOTHING ACTIVE');
});

test('C1: no providers is distinct from an empty village', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [missing()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 0, at: 1 });
    assert.equal(state.phase, VillagePhase.READY_NO_PROVIDERS);
    assert.equal(bootStatusText(state), 'NO PROVIDERS FOUND');
});

test('C1: an unreadable watchtower outranks silence', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy(), broken()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 2, at: 1 });
    assert.equal(state.phase, VillagePhase.DEGRADED, 'blindness must not read as a calm village');
});

test('C1: a failed source read is visible, and a retry clears it', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 1, at: 1 });
    state = reduceVillageState(state, { type: 'source-failed', code: 'sessions-request-failed' });
    assert.equal(state.phase, VillagePhase.DEGRADED);
    assert.equal(state.link.lastErrorCode, 'sessions-request-failed');
    assert.equal(isRetryable(state), true);
    state = reduceVillageState(state, { type: 'retry' });
    assert.equal(state.sourceFailed, false);
    assert.equal(state.link.state, LinkState.SYNCING);
});

test('C1: boot failure is terminal until retried, and keeps the shell', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'boot-failed', code: 'renderer-load-failed' });
    assert.equal(state.phase, VillagePhase.FAILED);
    assert.equal(state.failureCode, 'renderer-load-failed');
    assert.equal(bootStatusText(state), 'THE VILLAGE DID NOT OPEN');
    assert.equal(isRetryable(state), true);
    state = reduceVillageState(state, { type: 'retry' });
    assert.equal(state.failureCode, null);
});

test('C1: error codes are normalized, never raw paths or stacks', () => {
    const state = reduceVillageState(initialVillageState(), {
        type: 'source-failed',
        code: 'ENOENT: /Users/someone/.claude/projects/secret.jsonl',
    });
    const code = state.link.lastErrorCode;
    assert.ok(!code.includes('/'), `normalized code leaked a path: ${code}`);
    assert.ok(!code.includes('Users'), `normalized code leaked a home directory: ${code}`);
    assert.ok(code.length <= 48);
    assert.match(code, /^[a-z0-9-]+$/);
});

test('C1: freshness is measured from the last good snapshot only', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy()] });
    assert.equal(isStale(state, 10_000_000), false, 'unknown is not stale');
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 1, at: 1000 });
    assert.equal(isStale(state, 1000 + 5000), false, 'one slow poll must not flash the town');
    assert.equal(isStale(state, 1000 + 20000), true);
    assert.equal(snapshotAgeMs(state, 1000 + 20000), 20000);
    assert.match(linkStatusText(state, 1000 + 20000), /^STALE \/ last seen 20s ago$/);
});

test('C1: reconnect attempts surface a count without inventing freshness', () => {
    let state = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy()] });
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 1, at: 1000 });
    state = reduceVillageState(state, { type: 'link', state: LinkState.RECONNECTING, attempts: 2 });
    assert.equal(linkStatusText(state, 1100), 'RECONNECTING 2');
    // A recovered snapshot resets the attempt counter.
    state = reduceVillageState(state, { type: 'snapshot', agentCount: 1, at: 1200 });
    assert.equal(state.link.attempts, 0);
    assert.equal(linkStatusText(state, 1250), 'LIVE');
});

test('C1: the reducer never mutates the previous state', () => {
    const first = reduceVillageState(initialVillageState(), { type: 'providers', providers: [healthy()] });
    const snapshot = JSON.stringify(first);
    reduceVillageState(first, { type: 'snapshot', agentCount: 9, at: 5 });
    reduceVillageState(first, { type: 'boot-failed', code: 'x' });
    assert.equal(JSON.stringify(first), snapshot);
});

test('C1: unknown actions and junk providers are inert', () => {
    const state = reduceVillageState(initialVillageState(), { type: 'not-a-real-action' });
    assert.equal(state.phase, VillagePhase.STARTING);
    const withJunk = reduceVillageState(initialVillageState(), { type: 'providers', providers: [{ health: 'banana' }] });
    assert.equal(withJunk.providers[0].health, ProviderHealth.UNAVAILABLE);
    assert.equal(withJunk.providers[0].sessions, 0);
});
