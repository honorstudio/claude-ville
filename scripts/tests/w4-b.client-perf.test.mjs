import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSocketClient } from '../../claudeville/src/infrastructure/WebSocketClient.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { ClientPerfMetrics } from '../../claudeville/src/presentation/shared/ClientPerfMetrics.js';

function frameDriver() {
    let nextHandle = 1;
    let callback = null;
    return {
        requestFrame(next) {
            callback = next;
            return nextHandle++;
        },
        cancelFrame() {},
        tick(timestamp) {
            assert.ok(callback, 'a frame callback should be scheduled while profiling');
            const current = callback;
            callback = null;
            current(timestamp);
        },
    };
}

test('client perf stays inert until explicitly started', () => {
    let scheduled = 0;
    const metrics = new ClientPerfMetrics({
        requestFrame: () => {
            scheduled++;
            return 1;
        },
    });

    assert.equal(metrics.beginMessage(), null);
    assert.equal(metrics.getSnapshot().enabled, false);
    assert.equal(scheduled, 0);
    assert.deepEqual(metrics.getSnapshot().deltaToPaint, {
        count: 0,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        patchApply: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
        eventFanout: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
        samples: [],
    });
});

test('delta samples include patch, fan-out, next-frame, and mid-frame correlation', () => {
    let now = 0;
    const frames = frameDriver();
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
    });

    metrics.start();
    frames.tick(0);
    now = 16;
    frames.tick(16);

    now = 20;
    const message = metrics.beginMessage();
    now = 21;
    const delta = metrics.beginDelta(message);
    metrics.markPatchStart(delta);
    now = 24;
    metrics.markPatchApplied(delta, 2);
    metrics.markFanoutStart(delta);
    now = 29;
    metrics.markFanoutEnd(delta);
    metrics.finishDelta(delta);

    now = 40;
    frames.tick(40);
    const snapshot = metrics.getSnapshot();
    const sample = snapshot.deltaToPaint.samples[0];

    assert.equal(snapshot.deltaToPaint.count, 1);
    assert.equal(sample.parseMs, 1);
    assert.equal(sample.patchApplyMs, 3);
    assert.equal(sample.eventFanoutMs, 5);
    assert.equal(sample.messageToPaintMs, 20);
    assert.equal(sample.fanoutToPaintMs, 11);
    assert.equal(sample.framePhaseMs, 4);
    assert.equal(sample.frameGapMs, 24);
    assert.equal(sample.landedMidFrame, true);
    assert.equal(snapshot.deltaFrameCorrelation.midFrameCount, 1);
    assert.equal(snapshot.deltaFrameCorrelation.associatedFrameGap.p95Ms, 24);
    assert.equal(snapshot.deltaFrameCorrelation.baselineFrameGap.p95Ms, 16);
    assert.equal(snapshot.deltaFrameCorrelation.p95DifferenceMs, 8);

    metrics.stop();
});

test('long tasks and event timing are bounded and attributed to observed windows', () => {
    let now = 100;
    const frames = frameDriver();
    class FakePerformanceObserver {
        static supportedEntryTypes = ['longtask', 'event'];
        static instances = [];

        constructor(callback) {
            this.callback = callback;
            this.options = null;
            this.disconnected = false;
            FakePerformanceObserver.instances.push(this);
        }

        observe(options) {
            this.options = options;
        }

        disconnect() {
            this.disconnected = true;
        }

        emit(entries) {
            this.callback({ getEntries: () => entries });
        }
    }

    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        PerformanceObserverClass: FakePerformanceObserver,
        maxLongTaskSamples: 2,
        maxInputSamples: 2,
    });
    metrics.start();
    assert.deepEqual(
        FakePerformanceObserver.instances.map(observer => observer.options.type).sort(),
        ['event', 'longtask'],
    );

    const message = metrics.beginMessage();
    now = 120;
    const delta = metrics.beginDelta(message);
    metrics.markPatchStart(delta);
    now = 125;
    metrics.markPatchApplied(delta, 1);
    metrics.markFanoutStart(delta);
    now = 140;
    metrics.markFanoutEnd(delta);
    metrics.finishDelta(delta);

    now = 160;
    const render = metrics.beginRenderStage('test-render');
    now = 170;
    metrics.endRenderStage(render);

    const longTaskObserver = FakePerformanceObserver.instances
        .find(observer => observer.options.type === 'longtask');
    const eventObserver = FakePerformanceObserver.instances
        .find(observer => observer.options.type === 'event');
    longTaskObserver.emit([
        { startTime: 130, duration: 5 },
        { startTime: 160, duration: 5 },
        { startTime: 200, duration: 5 },
    ]);
    eventObserver.emit([
        { name: 'click', startTime: 10, processingStart: 22, duration: 20 },
        { name: 'keydown', startTime: 30, processingStart: 31, duration: 5 },
        { name: 'click', startTime: 40, processingStart: 50, duration: 20 },
    ]);

    const snapshot = metrics.getSnapshot();
    assert.equal(snapshot.longTasks.count, 3);
    assert.equal(snapshot.longTasks.attribution.update, 1);
    assert.equal(snapshot.longTasks.attribution.render, 1);
    assert.equal(snapshot.longTasks.attribution.other, 1);
    assert.equal(snapshot.longTasks.sampledCount, 2);
    assert.equal(snapshot.inputTiming.count, 3);
    assert.equal(snapshot.inputTiming.delay.p95Ms, 9.55);
    assert.equal(snapshot.inputTiming.sampledCount, 2);
    assert.deepEqual(snapshot.inputTiming.byName, { click: 2, keydown: 1 });

    metrics.stop();
    assert.equal(longTaskObserver.disconnected, true);
    assert.equal(eventObserver.disconnected, true);
});

test('bounded rings retain recent samples while counters retain totals', () => {
    let now = 0;
    const frames = frameDriver();
    const metrics = new ClientPerfMetrics({
        clock: () => now,
        requestFrame: frames.requestFrame,
        cancelFrame: frames.cancelFrame,
        maxDeltaSamples: 2,
        maxFrameSamples: 2,
        maxLongTaskSamples: 2,
        maxInputSamples: 2,
    });
    metrics.start();
    frames.tick(0);

    for (let index = 0; index < 3; index++) {
        now = index * 20 + 1;
        const message = metrics.beginMessage();
        const delta = metrics.beginDelta(message);
        metrics.markPatchStart(delta);
        now++;
        metrics.markPatchApplied(delta, 1);
        metrics.markFanoutStart(delta);
        now++;
        metrics.markFanoutEnd(delta);
        metrics.finishDelta(delta);
        now = (index + 1) * 20;
        frames.tick(now);
    }

    const snapshot = metrics.getSnapshot();
    assert.equal(snapshot.deltaToPaint.samples.length, 2);
    assert.equal(snapshot.frames.samples.length, 2);
    assert.equal(snapshot.dropped.deltaSamples, 1);
    assert.ok(snapshot.limits.deltaSamples <= 2);
    assert.ok(snapshot.limits.frameSamples <= 2);
    metrics.stop();
});

test('WebSocketClient hooks surround patching and synchronous event fan-out', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    const calls = [];
    const perf = {
        beginDelta() { calls.push('beginDelta'); return {}; },
        markPatchStart() { calls.push('patchStart'); },
        markPatchApplied(token, count) {
            calls.push(`patchApplied:${count}`);
        },
        markFanoutStart() { calls.push('fanoutStart'); },
        markFanoutEnd() { calls.push('fanoutEnd'); },
        finishDelta() { calls.push('finish'); },
    };
    const client = new WebSocketClient({ performanceMetrics: perf });
    client._rememberSnapshot({
        seq: 1,
        sessions: [{ sessionId: 'one', status: 'working' }],
        teams: [],
    });

    const updates = [];
    const unsubscribe = eventBus.on('ws:update', payload => updates.push(payload));
    try {
        client._handleMessage({
            type: 'update-delta',
            baseSeq: 1,
            seq: 2,
            patch: [{ op: 'replace', path: '/sessions/0/status', value: 'waiting_on_user' }],
        });
    } finally {
        unsubscribe();
        globalThis.window = previousWindow;
    }

    assert.equal(updates[0].sessions[0].status, 'waiting_on_user');
    assert.deepEqual(calls, [
        'beginDelta',
        'patchStart',
        'patchApplied:1',
        'fanoutStart',
        'fanoutEnd',
        'finish',
    ]);
});
