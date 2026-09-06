import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    FRAME_ENVELOPE_EMA_ALPHA,
    FRAME_ENVELOPE_RING_CAPACITY,
    updateEma,
    hostGapMs,
    percentileAtSnapshot,
    createBoundedRing,
    writeBoundedRing,
    createFrameEnvelope,
    enableFrameEnvelopeRings,
    recordFrameEnvelope,
    snapshotFrameEnvelope,
} from '../../claudeville/src/presentation/shared/ClientPerfMetrics.js';

const rendererUrl = new URL('../../claudeville/src/presentation/character-mode/IsometricRenderer.js', import.meta.url);
const worldFrameUrl = new URL('../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js', import.meta.url);
const metricsUrl = new URL('../../claudeville/src/presentation/shared/ClientPerfMetrics.js', import.meta.url);
const rendererSource = fs.readFileSync(rendererUrl, 'utf8');
const worldFrameSource = fs.readFileSync(worldFrameUrl, 'utf8');
const metricsSource = fs.readFileSync(metricsUrl, 'utf8');

function sliceFunction(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
    assert.ok(end > start, `${name} body must be bounded`);
    return source.slice(start, end);
}

function sliceExport(source, name, nextName) {
    const start = source.indexOf(`export function ${name}`);
    assert.ok(start >= 0, `${name} must be exported`);
    const end = nextName ? source.indexOf(`export function ${nextName}`, start + 1) : source.length;
    assert.ok(end > start, `${name} body must be bounded`);
    return source.slice(start, end);
}

test('EMA seeds on the first finite sample and then blends', () => {
    assert.equal(updateEma(NaN, 10), 10);
    assert.equal(updateEma(10, 18, 0.5), 14);
    assert.equal(updateEma(10, 18), 10 + (18 - 10) * FRAME_ENVELOPE_EMA_ALPHA);
});

test('host-gap residual floors at zero so app total never exceeds the gap', () => {
    assert.equal(hostGapMs(50, 6), 44);
    assert.equal(hostGapMs(16, 16), 0);
    assert.equal(hostGapMs(10, 24), 0);
    assert.equal(hostGapMs(0, 8), 0);
    assert.equal(hostGapMs(20, NaN), 20);
});

test('percentiles are interpolation over a snapshot copy', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentileAtSnapshot(values, 0.5), 5.5);
    assert.ok(Math.abs(percentileAtSnapshot(values, 0.95) - 9.55) < 1e-9);
    const ring = new Float64Array([9, 8, 7, 0, 0]);
    assert.equal(percentileAtSnapshot(ring, 1, 3), 9);
    assert.equal(percentileAtSnapshot([], 0.95), null);
});

test('disabled envelope is scalar-only and does not create a ring', () => {
    const env = createFrameEnvelope();
    const keys = Object.keys(env);
    assert.equal(env.rings, null);
    assert.equal(env.ringsEnabled, false);

    recordFrameEnvelope(env, 2, 3, 5, 16);
    assert.equal(env.rings, null);
    assert.equal(env.ringsEnabled, false);
    assert.deepEqual(Object.keys(env), keys);
    assert.equal('p95AppTotalMs' in env, false);

    const snap = snapshotFrameEnvelope(env);
    assert.equal(snap.appUpdateMs, 2);
    assert.equal(snap.appRenderMs, 3);
    assert.equal(snap.appTotalMs, 5);
    assert.equal(snap.frameGapMs, 16);
    assert.equal(snap.hostGapMs, 11);
    assert.equal(snap.p95AppTotalMs, null);
    assert.equal(snap.p95FrameGapMs, null);
    assert.equal(snap.ringsEnabled, false);
    assert.equal(typeof snap.appTotalMs, 'number');
    assert.equal(typeof snap.hostGapMs, 'number');
    assert.equal(Array.isArray(snap.attribution), false);
});

test('a long task outside the app window is host gap, not render', () => {
    const env = createFrameEnvelope();
    recordFrameEnvelope(env, 2, 4, 6, 50);

    assert.equal(env.appUpdateMs, 2);
    assert.equal(env.appRenderMs, 4);
    assert.equal(env.appTotalMs, 6);
    assert.equal(env.frameGapMs, 50);
    assert.equal(env.hostGapMs, 44);
    assert.ok(env.hostGapMs > env.appRenderMs);
    assert.ok(env.appTotalMs < env.frameGapMs);
    assert.equal(snapshotFrameEnvelope(env).attribution.rendererCostMs, 6);
});

test('app total larger than the frame gap still yields a zero residual', () => {
    const env = createFrameEnvelope();
    recordFrameEnvelope(env, 10, 14, 24, 12);
    assert.equal(env.appTotalMs, 24);
    assert.equal(env.frameGapMs, 12);
    assert.equal(env.hostGapMs, 0);
    assert.equal(hostGapMs(env.frameGapMs, env.appTotalMs), 0);
});

test('percentiles exist only after a ring is enabled and only at snapshot time', () => {
    const env = createFrameEnvelope();
    enableFrameEnvelopeRings(env, 8);
    assert.equal(env.rings.updateMs.length, 8);
    assert.ok(env.ringsEnabled);

    for (let i = 1; i <= 8; i++) {
        recordFrameEnvelope(env, i, i * 2, i * 3, 16 + i);
    }

    assert.equal('p95AppTotalMs' in env, false);
    assert.equal(env.rings.count, 8);

    const snap = snapshotFrameEnvelope(env);
    const expectedP95 = Math.round(percentileAtSnapshot(env.rings.totalMs, 0.95, env.rings.count) * 100) / 100;
    assert.ok(Number.isFinite(snap.p95AppTotalMs));
    assert.ok(Number.isFinite(snap.p95AppRenderMs));
    assert.ok(Number.isFinite(snap.p95FrameGapMs));
    assert.ok(Number.isFinite(snap.p95HostGapMs));
    assert.equal(snap.p95AppTotalMs, expectedP95);
});

test('last failure stage sticks across later successful frames', () => {
    const env = createFrameEnvelope();
    recordFrameEnvelope(env, 1, 0, 1, 16, 'render');
    assert.equal(env.lastFailureStage, 'render');
    recordFrameEnvelope(env, 1, 2, 3, 16, null);
    assert.equal(env.lastFailureStage, 'render');
    assert.equal(snapshotFrameEnvelope(env).lastFailureStage, 'render');
});

test('bounded rings wrap without shifting and count dropped samples', () => {
    const ring = createBoundedRing(3);
    assert.equal(writeBoundedRing(ring, 1), 0);
    assert.equal(writeBoundedRing(ring, 2), 0);
    assert.equal(writeBoundedRing(ring, 3), 0);
    assert.equal(writeBoundedRing(ring, 4), 1);
    assert.equal(ring.count, 3);
    assert.equal(ring.values[0], 4);

    const env = createFrameEnvelope();
    enableFrameEnvelopeRings(env, 4);
    for (let i = 0; i < 6; i++) recordFrameEnvelope(env, 1, 1, 2, 16);
    assert.equal(env.droppedSamples, 2);
    assert.equal(env.rings.count, 4);
    assert.equal(env.rings.capacity, 4);
    assert.equal(FRAME_ENVELOPE_RING_CAPACITY, 120);
});

test('recordFrameEnvelope never computes percentiles; snapshot does', () => {
    const recordBody = sliceExport(metricsSource, 'recordFrameEnvelope', 'snapshotFrameEnvelope');
    const snapshotBody = sliceExport(metricsSource, 'snapshotFrameEnvelope');
    assert.doesNotMatch(recordBody, /percentileAtSnapshot/);
    assert.match(snapshotBody, /percentileAtSnapshot/);
});

test('WorldFrameRenderer per-frame profiling path no longer sorts, maps, or copies', () => {
    // These renderer files import canvas/DOM-backed modules, so they cannot be
    // loaded in plain Node without inventing a fake DOM. Source-contract
    // assertions over the files themselves prove the measured path no longer
    // allocates or sorts while finishing a frame.
    const perFrame = [
        sliceFunction(worldFrameSource, 'markFrameTiming', 'writeFrameTimingSample'),
        sliceFunction(worldFrameSource, 'writeFrameTimingSample', 'finishFrameTiming'),
        sliceFunction(worldFrameSource, 'finishFrameTiming'),
    ].join('\n');

    assert.doesNotMatch(perFrame, /\.sort\s*\(/);
    assert.doesNotMatch(perFrame, /\.map\s*\(/);
    assert.doesNotMatch(perFrame, /\.shift\s*\(/);
    assert.doesNotMatch(perFrame, /\.slice\s*\(/);
    assert.doesNotMatch(perFrame, /\.filter\s*\(/);
    assert.doesNotMatch(perFrame, /\.push\s*\(/);
    assert.doesNotMatch(perFrame, /\[\s*\.\.\./);
    assert.doesNotMatch(perFrame, /percentile\s*\(/);
    assert.match(perFrame, /writeBoundedRing/);
    assert.match(worldFrameSource, /createBoundedRing/);
});

test('IsometricRenderer records a frame envelope on every loop and exposes frameHealth', () => {
    const loopStart = rendererSource.indexOf('    _loop()');
    const loopEnd = rendererSource.indexOf('    _reportFrameFailure', loopStart);
    assert.ok(loopStart >= 0 && loopEnd > loopStart, '_loop must remain discoverable');
    const loopSource = rendererSource.slice(loopStart, loopEnd);

    assert.match(loopSource, /_recordFrameEnvelope\(/);
    assert.match(loopSource, /beginRenderStage\(\s*['"]world-update['"]\s*\)/);
    assert.match(loopSource, /beginRenderStage\(\s*['"]world-render['"]\s*\)/);
    assert.match(loopSource, /endRenderStage\(/);
    const profileGateStart = loopSource.indexOf('if (this._performanceSamples)');
    assert.ok(profileGateStart >= 0, 'the opt-in profile ring gate must remain discoverable');
    assert.match(
        loopSource.slice(0, profileGateStart),
        /_recordFrameEnvelope\(/,
        'the always-on envelope must be recorded before the opt-in profile ring',
    );

    assert.match(rendererSource, /frameHealth\s*\(\s*\)/);
    assert.match(rendererSource, /__claudeVillePerf/);
    assert.match(rendererSource, /frameHealth:\s*this\._frameHealthHelper/);
    assert.match(rendererSource, /createFrameEnvelope\(/);
});
