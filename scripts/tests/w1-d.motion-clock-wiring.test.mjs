import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    REF_DT_MS,
    clampDt,
    createMotionClock,
    advanceMotionClock,
    virtualFramesFor,
} from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { bucketCounts } from '../../claudeville/src/domain/services/SignalLedger.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

const rendererUrl = new URL('../../claudeville/src/presentation/character-mode/IsometricRenderer.js', import.meta.url);
const rendererSource = fs.readFileSync(rendererUrl, 'utf8');
const waterStepMatch = rendererSource.match(/\bconst\s+WATER_FRAME_STEP\s*=\s*([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?);/);
assert.ok(waterStepMatch, 'renderer must declare a numeric WATER_FRAME_STEP');
const WATER_FRAME_STEP = Number(waterStepMatch[1]);

const occurrenceCount = (source, needle) => source.split(needle).length - 1;

// This mirrors the renderer's exact water derivation without importing its DOM/canvas-bound module.
function deriveWaterFrame(clock) {
    return virtualFramesFor(clock.elapsedMs) * WATER_FRAME_STEP;
}

function runWaterFrames(deltas, motionScale = 1) {
    const clock = createMotionClock();
    for (const dt of deltas) advanceMotionClock(clock, dt, motionScale);
    return { clock, waterFrame: deriveWaterFrame(clock) };
}

// ---------------------------------------------------------------------------
// C3 — shared renderer motion clock
// ---------------------------------------------------------------------------

test('C3: sixty reference steps preserve the authored water cadence', () => {
    const { waterFrame } = runWaterFrames(Array.from({ length: 60 }, () => REF_DT_MS));
    assert.ok(
        Math.abs(waterFrame - 60 * WATER_FRAME_STEP) < 1e-9,
        `60 Hz water cadence drifted: ${waterFrame} vs ${60 * WATER_FRAME_STEP}`,
    );
});

test('C3: one wall-clock second derives the same water frame at 30, 60, and 120 Hz', () => {
    const at30 = runWaterFrames(Array.from({ length: 30 }, () => 1000 / 30)).waterFrame;
    const at60 = runWaterFrames(Array.from({ length: 60 }, () => 1000 / 60)).waterFrame;
    const at120 = runWaterFrames(Array.from({ length: 120 }, () => 1000 / 120)).waterFrame;

    assert.ok(Math.abs(at30 - at60) < 1e-9, `30 Hz drifted from 60 Hz: ${at30} vs ${at60}`);
    assert.ok(Math.abs(at120 - at60) < 1e-9, `120 Hz drifted from 60 Hz: ${at120} vs ${at60}`);
});

test('C3: reduced motion freezes the derived water frame across many frames', () => {
    const clock = createMotionClock();
    advanceMotionClock(clock, REF_DT_MS);
    const held = deriveWaterFrame(clock);

    for (let i = 0; i < 240; i++) advanceMotionClock(clock, REF_DT_MS, 0);

    assert.equal(deriveWaterFrame(clock), held);
});

test('C3: a long frame is capped before it reaches the shared clock', () => {
    const clock = createMotionClock();
    advanceMotionClock(clock, 5000);
    const allowedMs = clampDt(5000);

    assert.ok(clock.elapsedMs <= allowedMs, `stall advanced ${clock.elapsedMs} ms; clamp allows ${allowedMs} ms`);
    assert.equal(clock.elapsedMs, allowedMs);
});

// ---------------------------------------------------------------------------
// C3 — IsometricRenderer source contract
// ---------------------------------------------------------------------------

test('C3: the renderer owns one shared motion clock and no frame accumulator', () => {
    // The renderer is browser-coupled, so source contracts protect its wiring without a DOM shim or dependency.
    assert.doesNotMatch(rendererSource, /waterFrame\s*\+=/);
    assert.equal(occurrenceCount(rendererSource, 'advanceMotionClock('), 1);
    assert.equal(occurrenceCount(rendererSource, 'createMotionClock('), 1);
    assert.match(rendererSource, /get\s+motionTimeMs\s*\(\s*\)/);
});

test('C2: the live semantic summary keeps errors and quota as separate buckets', () => {
    const agents = [
        { id: 'blocked', status: AgentStatus.WAITING_ON_USER },
        { id: 'errored', status: AgentStatus.ERRORED },
        { id: 'quota', status: AgentStatus.RATE_LIMITED },
        { id: 'waiting', status: AgentStatus.WAITING },
        { id: 'working', status: AgentStatus.WORKING },
        { id: 'idle', status: AgentStatus.IDLE },
    ];
    const counts = bucketCounts(agents);

    assert.deepEqual(
        {
            needsYou: counts.needsYou,
            errors: counts.errors,
            quota: counts.quota,
            watchlist: counts.watchlist,
            working: counts.working,
        },
        {
            needsYou: 1,
            errors: 1,
            quota: 1,
            watchlist: 1,
            working: 1,
        },
    );
    assert.equal(counts.errors + counts.quota, 2);
    assert.notEqual(counts.errors, counts.errors + counts.quota, 'errors must not contain the quota count');

    const summaryStart = rendererSource.indexOf('    _syncSemanticSummary()');
    const summaryEnd = rendererSource.indexOf('    _harborPendingReposSignature', summaryStart);
    assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, 'renderer summary method must remain discoverable');
    const summarySource = rendererSource.slice(summaryStart, summaryEnd);
    const mergedStatusFilter = /\.filter\([\s\S]*?(?:AgentStatus\.ERRORED[\s\S]*?AgentStatus\.RATE_LIMITED|AgentStatus\.RATE_LIMITED[\s\S]*?AgentStatus\.ERRORED)[\s\S]*?\)/;

    assert.match(summarySource, /bucketCounts\(agents\)/);
    assert.match(summarySource, /counts\.errors/);
    assert.match(summarySource, /counts\.quota/);
    assert.doesNotMatch(summarySource, mergedStatusFilter, 'summary must not merge errored and quota-limited agents in one filter');
});
