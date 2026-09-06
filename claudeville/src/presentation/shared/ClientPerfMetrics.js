const DEFAULT_DELTA_SAMPLES = 240;
const DEFAULT_FRAME_SAMPLES = 600;
const DEFAULT_LONG_TASK_SAMPLES = 120;
const DEFAULT_INPUT_SAMPLES = 120;
const DEFAULT_INPUT_EVENT_NAMES = 32;
const DEFAULT_UPDATE_WINDOWS = 240;
const DEFAULT_RENDER_WINDOWS = 120;
const DEFAULT_PENDING_DELTAS = 128;
const RECENT_SNAPSHOT_SAMPLES = 64;
const MID_FRAME_EPSILON_MS = 0.5;
const FRAME_BUDGET_MS = 1000 / 60;
const LONG_FRAME_MS = 50;
export const FRAME_ENVELOPE_EMA_ALPHA = 0.125;
export const FRAME_ENVELOPE_RING_CAPACITY = 120;

let lastClientPerfMetrics = null;

export function getClientPerfMetrics() {
    return lastClientPerfMetrics;
}

function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function defaultRequestFrame(callback) {
    if (typeof requestAnimationFrame !== 'function') return null;
    return requestAnimationFrame(callback);
}

function defaultCancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
}

function finite(value) {
    return Number.isFinite(value) ? value : null;
}

function duration(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const value = Number(end) - Number(start);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedPush(buffer, value, limit, onDrop = null) {
    if (buffer.length >= limit) {
        buffer.shift();
        onDrop?.();
    }
    buffer.push(value);
}

function entriesFrom(list) {
    if (Array.isArray(list)) return list;
    if (typeof list?.getEntries === 'function') return list.getEntries();
    return [];
}

function percentile(values, fraction) {
    const finiteValues = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (finiteValues.length === 0) return null;
    const position = (finiteValues.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return finiteValues[lower];
    return finiteValues[lower] + (finiteValues[upper] - finiteValues[lower]) * (position - lower);
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function summarizeValues(values) {
    const finiteValues = values.filter(Number.isFinite);
    if (finiteValues.length === 0) {
        return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
    }
    return {
        count: finiteValues.length,
        p50Ms: round(percentile(finiteValues, 0.5)),
        p95Ms: round(percentile(finiteValues, 0.95)),
        maxMs: round(Math.max(...finiteValues)),
    };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function copyRecent(buffer) {
    return buffer.slice(-RECENT_SNAPSHOT_SAMPLES).map(sample => ({ ...sample }));
}

function snapshotFrameRing(ring) {
    const samples = [];
    const gapValues = [];
    const deltaFrameValues = [];
    const baselineFrameValues = [];
    const start = ring.count < ring.capacity ? 0 : ring.index;
    for (let offset = 0; offset < ring.count; offset++) {
        const index = (start + offset) % ring.capacity;
        const gapMs = finite(ring.gapMs[index]);
        const deltaCount = ring.deltaCount[index];
        samples.push({ at: finite(ring.at[index]), gapMs, deltaCount });
        if (gapMs === null) continue;
        gapValues.push(gapMs);
        if (deltaCount > 0) deltaFrameValues.push(gapMs);
        else baselineFrameValues.push(gapMs);
    }
    return { samples, gapValues, deltaFrameValues, baselineFrameValues };
}

function summarizeFrameHealth(values, totals) {
    let overBudgetCount = 0;
    let longFrameCount = 0;
    for (const value of values) {
        if (value > FRAME_BUDGET_MS) overBudgetCount++;
        if (value > LONG_FRAME_MS) longFrameCount++;
    }
    const count = values.length;
    const totalCount = totals.count;
    return {
        windowSize: count,
        totalCount,
        budgetMs: round(FRAME_BUDGET_MS),
        longFrameThresholdMs: LONG_FRAME_MS,
        p50Ms: round(percentile(values, 0.5)),
        p95Ms: round(percentile(values, 0.95)),
        p99Ms: round(percentile(values, 0.99)),
        maxMs: count > 0 ? round(Math.max(...values)) : null,
        overBudget: {
            count: overBudgetCount,
            rate: count > 0 ? round(overBudgetCount / count) : 0,
            totalCount: totals.overBudget,
            totalRate: totalCount > 0 ? round(totals.overBudget / totalCount) : 0,
        },
        longFrames: {
            count: longFrameCount,
            rate: count > 0 ? round(longFrameCount / count) : 0,
            totalCount: totals.longFrames,
            totalRate: totalCount > 0 ? round(totals.longFrames / totalCount) : 0,
        },
    };
}

function finiteNonNeg(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Always-on frame-envelope arithmetic.
 *
 * The live path mutates a handful of scalars (and optional preallocated rings).
 * Percentiles are computed only when a snapshot is requested.
 */
export function updateEma(previous, sample, alpha = FRAME_ENVELOPE_EMA_ALPHA) {
    const value = Number(sample);
    if (!Number.isFinite(value)) return Number.isFinite(previous) ? previous : 0;
    if (!Number.isFinite(previous)) return value;
    const weight = Number(alpha);
    if (!Number.isFinite(weight) || weight <= 0) return previous;
    if (weight >= 1) return value;
    return previous + (value - previous) * weight;
}

export function hostGapMs(frameGapMs, appTotalMs) {
    const gap = Number(frameGapMs);
    if (!Number.isFinite(gap) || gap <= 0) return 0;
    const app = Number(appTotalMs);
    const owned = Number.isFinite(app) && app > 0 ? app : 0;
    const residual = gap - owned;
    return residual > 0 ? residual : 0;
}

export function percentileAtSnapshot(values, fraction, length) {
    const size = Number.isFinite(length) ? length : (values?.length || 0);
    if (!values || size <= 0) return null;
    const finiteValues = [];
    for (let i = 0; i < size; i++) {
        const value = values[i];
        if (Number.isFinite(value)) finiteValues.push(value);
    }
    if (finiteValues.length === 0) return null;
    finiteValues.sort((a, b) => a - b);
    const clamped = Math.min(1, Math.max(0, Number(fraction)));
    if (!Number.isFinite(clamped)) return finiteValues[0];
    const position = (finiteValues.length - 1) * clamped;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return finiteValues[lower];
    return finiteValues[lower] + (finiteValues[upper] - finiteValues[lower]) * (position - lower);
}

export function createBoundedRing(capacity) {
    const size = Math.max(1, Math.floor(Number(capacity) || 0));
    return {
        values: new Float64Array(size),
        index: 0,
        count: 0,
        capacity: size,
    };
}

export function writeBoundedRing(ring, value) {
    if (!ring || !ring.values) return 0;
    const dropped = ring.count >= ring.capacity ? 1 : 0;
    ring.values[ring.index] = finiteNonNeg(value);
    ring.index += 1;
    if (ring.index >= ring.capacity) ring.index = 0;
    if (ring.count < ring.capacity) ring.count += 1;
    return dropped;
}

export function createFrameEnvelope() {
    return {
        appUpdateMs: 0,
        appRenderMs: 0,
        appTotalMs: 0,
        frameGapMs: 0,
        hostGapMs: 0,
        emaUpdateMs: NaN,
        emaRenderMs: NaN,
        emaTotalMs: NaN,
        emaFrameGapMs: NaN,
        emaHostGapMs: NaN,
        sampleCount: 0,
        droppedSamples: 0,
        lastFailureStage: null,
        ringsEnabled: false,
        rings: null,
    };
}

export function enableFrameEnvelopeRings(envelope, capacity = FRAME_ENVELOPE_RING_CAPACITY) {
    if (!envelope) return envelope;
    envelope.ringsEnabled = true;
    if (envelope.rings) return envelope;
    const size = Math.max(1, Math.floor(Number(capacity) || FRAME_ENVELOPE_RING_CAPACITY));
    envelope.rings = {
        capacity: size,
        index: 0,
        count: 0,
        updateMs: new Float64Array(size),
        renderMs: new Float64Array(size),
        totalMs: new Float64Array(size),
        frameGapMs: new Float64Array(size),
        hostGapMs: new Float64Array(size),
    };
    return envelope;
}

export function recordFrameEnvelope(envelope, updateMs, renderMs, totalMs, frameGapMs, failureStage) {
    if (!envelope) return envelope;
    const nextUpdate = finiteNonNeg(updateMs);
    const nextRender = finiteNonNeg(renderMs);
    const nextTotal = finiteNonNeg(totalMs);
    const nextGap = finiteNonNeg(frameGapMs);
    const nextHost = hostGapMs(nextGap, nextTotal);
    envelope.appUpdateMs = nextUpdate;
    envelope.appRenderMs = nextRender;
    envelope.appTotalMs = nextTotal;
    envelope.frameGapMs = nextGap;
    envelope.hostGapMs = nextHost;
    envelope.emaUpdateMs = updateEma(envelope.emaUpdateMs, nextUpdate);
    envelope.emaRenderMs = updateEma(envelope.emaRenderMs, nextRender);
    envelope.emaTotalMs = updateEma(envelope.emaTotalMs, nextTotal);
    envelope.emaFrameGapMs = updateEma(envelope.emaFrameGapMs, nextGap);
    envelope.emaHostGapMs = updateEma(envelope.emaHostGapMs, nextHost);
    envelope.sampleCount += 1;
    if (typeof failureStage === 'string' && failureStage) {
        envelope.lastFailureStage = failureStage;
    }
    const rings = envelope.ringsEnabled ? envelope.rings : null;
    if (!rings) return envelope;
    if (rings.count >= rings.capacity) envelope.droppedSamples += 1;
    rings.updateMs[rings.index] = nextUpdate;
    rings.renderMs[rings.index] = nextRender;
    rings.totalMs[rings.index] = nextTotal;
    rings.frameGapMs[rings.index] = nextGap;
    rings.hostGapMs[rings.index] = nextHost;
    rings.index += 1;
    if (rings.index >= rings.capacity) rings.index = 0;
    if (rings.count < rings.capacity) rings.count += 1;
    return envelope;
}

export function snapshotFrameEnvelope(envelope, extras) {
    const gpuMs = extras && Number.isFinite(Number(extras.gpuMs)) ? Number(extras.gpuMs) : null;
    const qualityLevel = extras && extras.qualityLevel != null && Number.isFinite(Number(extras.qualityLevel))
        ? Number(extras.qualityLevel)
        : null;
    const qualityReason = extras && typeof extras.qualityReason === 'string'
        ? extras.qualityReason
        : null;
    if (!envelope) {
        return {
            appUpdateMs: 0,
            appRenderMs: 0,
            appTotalMs: 0,
            frameGapMs: 0,
            hostGapMs: 0,
            emaAppUpdateMs: null,
            emaAppRenderMs: null,
            emaAppTotalMs: null,
            emaFrameGapMs: null,
            emaHostGapMs: null,
            p95AppUpdateMs: null,
            p95AppRenderMs: null,
            p95AppTotalMs: null,
            p95FrameGapMs: null,
            p95HostGapMs: null,
            gpuMs,
            qualityLevel,
            qualityReason,
            droppedSamples: 0,
            lastFailureStage: null,
            sampleCount: 0,
            ringsEnabled: false,
            attribution: {
                appTotalMs: 0,
                frameGapMs: 0,
                hostGapMs: 0,
                rendererCostMs: 0,
            },
        };
    }
    const rings = envelope.rings;
    const count = rings ? rings.count : 0;
    const p95 = (field) => (rings && count > 0)
        ? round(percentileAtSnapshot(rings[field], 0.95, count))
        : null;
    const appTotalMs = round(envelope.appTotalMs) ?? 0;
    const frameGapMs = round(envelope.frameGapMs) ?? 0;
    const residualMs = round(envelope.hostGapMs) ?? 0;
    return {
        appUpdateMs: round(envelope.appUpdateMs) ?? 0,
        appRenderMs: round(envelope.appRenderMs) ?? 0,
        appTotalMs,
        frameGapMs,
        hostGapMs: residualMs,
        emaAppUpdateMs: round(envelope.emaUpdateMs),
        emaAppRenderMs: round(envelope.emaRenderMs),
        emaAppTotalMs: round(envelope.emaTotalMs),
        emaFrameGapMs: round(envelope.emaFrameGapMs),
        emaHostGapMs: round(envelope.emaHostGapMs),
        p95AppUpdateMs: p95('updateMs'),
        p95AppRenderMs: p95('renderMs'),
        p95AppTotalMs: p95('totalMs'),
        p95FrameGapMs: p95('frameGapMs'),
        p95HostGapMs: p95('hostGapMs'),
        gpuMs: gpuMs === null ? null : round(gpuMs),
        qualityLevel,
        qualityReason,
        droppedSamples: envelope.droppedSamples || 0,
        lastFailureStage: envelope.lastFailureStage || null,
        sampleCount: envelope.sampleCount || 0,
        ringsEnabled: Boolean(envelope.ringsEnabled),
        attribution: {
            appTotalMs,
            frameGapMs,
            hostGapMs: residualMs,
            rendererCostMs: appTotalMs,
        },
    };
}

/**
 * Opt-in browser performance measurements for the session-update path.
 *
 * No observers, animation frames, or sample buffers are created until start()
 * is called. All retained samples are fixed-size rings so a long dashboard
 * session cannot grow memory just because diagnostics were enabled.
 */
export class ClientPerfMetrics {
    constructor({
        clock = defaultNow,
        requestFrame = defaultRequestFrame,
        cancelFrame = defaultCancelFrame,
        PerformanceObserverClass = null,
        maxDeltaSamples = DEFAULT_DELTA_SAMPLES,
        maxFrameSamples = DEFAULT_FRAME_SAMPLES,
        maxLongTaskSamples = DEFAULT_LONG_TASK_SAMPLES,
        maxInputSamples = DEFAULT_INPUT_SAMPLES,
        maxInputEventNames = DEFAULT_INPUT_EVENT_NAMES,
        maxUpdateWindows = DEFAULT_UPDATE_WINDOWS,
        maxRenderWindows = DEFAULT_RENDER_WINDOWS,
        maxPendingDeltas = DEFAULT_PENDING_DELTAS,
    } = {}) {
        this._clock = typeof clock === 'function' ? clock : defaultNow;
        this._requestFrame = typeof requestFrame === 'function' ? requestFrame : defaultRequestFrame;
        this._cancelFrame = typeof cancelFrame === 'function' ? cancelFrame : defaultCancelFrame;
        this._PerformanceObserverClass = PerformanceObserverClass;
        this._limits = {
            deltaSamples: Math.max(1, Math.floor(maxDeltaSamples)),
            frameSamples: Math.max(1, Math.floor(maxFrameSamples)),
            longTaskSamples: Math.max(1, Math.floor(maxLongTaskSamples)),
            inputSamples: Math.max(1, Math.floor(maxInputSamples)),
            inputEventNames: Math.max(1, Math.floor(maxInputEventNames)),
            updateWindows: Math.max(1, Math.floor(maxUpdateWindows)),
            renderWindows: Math.max(1, Math.floor(maxRenderWindows)),
            pendingDeltas: Math.max(1, Math.floor(maxPendingDeltas)),
        };

        this.enabled = false;
        this._deltaSamples = [];
        this._frameRing = {
            at: new Float64Array(this._limits.frameSamples),
            gapMs: new Float64Array(this._limits.frameSamples),
            deltaCount: new Uint32Array(this._limits.frameSamples),
            index: 0,
            count: 0,
            capacity: this._limits.frameSamples,
        };
        this._frameTotals = { count: 0, overBudget: 0, longFrames: 0 };
        this._longTaskSamples = [];
        this._inputSamples = [];
        this._updateWindows = [];
        this._renderWindows = [];
        this._pendingDeltas = new Map();
        this._observers = [];
        this._frameHandle = null;
        this._frameScheduled = false;
        this._lastFrameAt = null;
        this._nextDeltaId = 1;
        this._nextRenderId = 1;
        this._capabilities = {
            requestAnimationFrame: false,
            longtask: false,
            event: false,
        };
        this._dropped = {
            deltaSamples: 0,
            frameSamples: 0,
            longTaskSamples: 0,
            inputSamples: 0,
            updateWindows: 0,
            renderWindows: 0,
            pendingDeltas: 0,
        };
        this._longTaskTotals = {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            attribution: { update: 0, render: 0, mixed: 0, other: 0 },
        };
        this._inputTotals = {
            count: 0,
            totalDelayMs: 0,
            maxDelayMs: 0,
            byName: {},
        };

        this._onFrame = timestamp => this._handleFrame(timestamp);
        this._debugHelpers = {
            clientPerf: () => this.getSnapshot(),
            startClientPerf: () => this.start(),
            stopClientPerf: () => this.stop(),
            resetClientPerf: () => this.reset(),
        };
        lastClientPerfMetrics = this;
    }

    getDebugHelpers() {
        return this._debugHelpers;
    }

    start({ reset = true } = {}) {
        if (this.enabled) return false;
        if (reset) this.reset();
        this.enabled = true;
        this._capabilities.requestAnimationFrame = this._canRequestFrame();
        this._installPerformanceObservers();
        this._scheduleFrame();
        return true;
    }

    stop() {
        if (!this.enabled) return false;
        this.enabled = false;
        if (this._frameScheduled && this._frameHandle !== null) {
            try { this._cancelFrame(this._frameHandle); } catch { /* diagnostics only */ }
        }
        this._frameHandle = null;
        this._frameScheduled = false;
        this._pendingDeltas.clear();
        for (const observer of this._observers) {
            try { observer.disconnect?.(); } catch { /* diagnostics only */ }
        }
        this._observers = [];
        this._lastFrameAt = null;
        return true;
    }

    reset() {
        this._deltaSamples = [];
        this._frameRing.index = 0;
        this._frameRing.count = 0;
        this._frameTotals = { count: 0, overBudget: 0, longFrames: 0 };
        this._longTaskSamples = [];
        this._inputSamples = [];
        this._updateWindows = [];
        this._renderWindows = [];
        this._pendingDeltas.clear();
        this._lastFrameAt = null;
        this._capabilities = {
            requestAnimationFrame: false,
            longtask: false,
            event: false,
        };
        this._nextDeltaId = 1;
        this._nextRenderId = 1;
        this._dropped = {
            deltaSamples: 0,
            frameSamples: 0,
            longTaskSamples: 0,
            inputSamples: 0,
            updateWindows: 0,
            renderWindows: 0,
            pendingDeltas: 0,
        };
        this._longTaskTotals = {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            attribution: { update: 0, render: 0, mixed: 0, other: 0 },
        };
        this._inputTotals = {
            count: 0,
            totalDelayMs: 0,
            maxDelayMs: 0,
            byName: {},
        };
    }

    beginMessage() {
        if (!this.enabled) return null;
        return {
            id: this._nextDeltaId++,
            arrivedAt: this._clock(),
            previousFrameAt: this._lastFrameAt,
        };
    }

    cancelMessage(message) {
        if (!this.enabled || !message) return;
        message.cancelled = true;
    }

    beginDelta(message = null) {
        if (!this.enabled) return null;
        const token = message && Number.isFinite(message.arrivedAt)
            ? message
            : this.beginMessage();
        if (!token) return null;
        token.parseMs = duration(token.arrivedAt, this._clock());
        token.patchStartedAt = null;
        token.patchAppliedAt = null;
        token.fanoutStartedAt = null;
        token.fanoutEndedAt = null;
        token.finished = false;
        return token;
    }

    markPatchStart(token) {
        if (!this.enabled || !token) return;
        token.patchStartedAt = this._clock();
    }

    markPatchApplied(token, operationCount = null) {
        if (!this.enabled || !token) return;
        token.patchAppliedAt = this._clock();
        token.operationCount = Number.isFinite(operationCount) ? operationCount : null;
        token.patchApplyMs = duration(token.patchStartedAt, token.patchAppliedAt);
        token.arrivalToPatchMs = duration(token.arrivedAt, token.patchAppliedAt);
    }

    markFanoutStart(token) {
        if (!this.enabled || !token) return;
        token.fanoutStartedAt = this._clock();
    }

    markFanoutEnd(token) {
        if (!this.enabled || !token) return;
        token.fanoutEndedAt = this._clock();
        token.eventFanoutMs = duration(token.fanoutStartedAt, token.fanoutEndedAt);
        token.arrivalToFanoutMs = duration(token.arrivedAt, token.fanoutEndedAt);
    }

    finishDelta(token, { outcome = 'painted' } = {}) {
        if (!this.enabled || !token || token.finished) return;
        token.finished = true;
        token.outcome = outcome;
        if (!Number.isFinite(token.fanoutEndedAt)) return;
        this._recordUpdateWindow(token);
        this._pendingDeltas.set(token.id, token);
        while (this._pendingDeltas.size > this._limits.pendingDeltas) {
            const oldestId = this._pendingDeltas.keys().next().value;
            this._pendingDeltas.delete(oldestId);
            this._dropped.pendingDeltas++;
        }
        this._scheduleFrame();
    }

    discardDelta(token, outcome = 'discarded') {
        if (!this.enabled || !token || token.finished) return;
        token.finished = true;
        token.outcome = outcome;
    }

    /** Record an actual render-stage window when a renderer integration exists. */
    beginRenderStage(label = 'render') {
        if (!this.enabled) return null;
        return { id: this._nextRenderId++, label, startedAt: this._clock() };
    }

    endRenderStage(token) {
        if (!this.enabled || !token) return;
        const endedAt = this._clock();
        if (!Number.isFinite(token.startedAt)) return;
        boundedPush(
            this._renderWindows,
            { startTime: token.startedAt, endTime: endedAt, label: token.label },
            this._limits.renderWindows,
            () => { this._dropped.renderWindows++; },
        );
    }

    getSnapshot() {
        const deltaPaintValues = this._deltaSamples.map(sample => sample.messageToPaintMs);
        const patchValues = this._deltaSamples.map(sample => sample.patchApplyMs);
        const fanoutValues = this._deltaSamples.map(sample => sample.eventFanoutMs);
        const frameRing = snapshotFrameRing(this._frameRing);
        const frameValues = frameRing.gapValues;
        const deltaFrameValues = frameRing.deltaFrameValues;
        const baselineFrameValues = frameRing.baselineFrameValues;
        const inputDelayValues = this._inputSamples.map(sample => sample.inputDelayMs);
        const deltaPaint = summarizeValues(deltaPaintValues);
        const deltaFrameGap = summarizeValues(deltaFrameValues);
        const baselineFrameGap = summarizeValues(baselineFrameValues);

        return {
            enabled: this.enabled,
            capabilities: { ...this._capabilities },
            limits: { ...this._limits },
            summary: {
                deltaCount: this._deltaSamples.length,
                deltaToPaintP95Ms: deltaPaint.p95Ms,
                midFrameDeltaCount: this._deltaSamples.filter(sample => sample.landedMidFrame).length,
                deltaFrameGapP95Ms: deltaFrameGap.p95Ms,
                baselineFrameGapP95Ms: baselineFrameGap.p95Ms,
                longTaskCount: this._longTaskTotals.count,
                inputDelayP95Ms: round(percentile(inputDelayValues, 0.95)),
            },
            deltaToPaint: {
                ...deltaPaint,
                patchApply: summarizeValues(patchValues),
                eventFanout: summarizeValues(fanoutValues),
                samples: copyRecent(this._deltaSamples),
            },
            frames: {
                ...summarizeValues(frameValues),
                p99Ms: round(percentile(frameValues, 0.99)),
                sampledCount: this._frameRing.count,
                associatedWithDelta: deltaFrameGap,
                withoutDelta: baselineFrameGap,
                samples: frameRing.samples.slice(-RECENT_SNAPSHOT_SAMPLES),
            },
            frameHealth: summarizeFrameHealth(frameValues, this._frameTotals),
            deltaFrameCorrelation: {
                deltaCount: this._deltaSamples.length,
                midFrameCount: this._deltaSamples.filter(sample => sample.landedMidFrame).length,
                withNextFrameCount: this._deltaSamples.filter(sample => Number.isFinite(sample.frameGapMs)).length,
                associatedFrameGap: deltaFrameGap,
                baselineFrameGap,
                p95DifferenceMs: deltaFrameGap.p95Ms === null || baselineFrameGap.p95Ms === null
                    ? null
                    : round(deltaFrameGap.p95Ms - baselineFrameGap.p95Ms),
            },
            longTasks: {
                count: this._longTaskTotals.count,
                totalMs: round(this._longTaskTotals.totalMs),
                maxMs: round(this._longTaskTotals.maxMs),
                sampledCount: this._longTaskSamples.length,
                sampledDuration: summarizeValues(this._longTaskSamples.map(sample => sample.durationMs)),
                attribution: { ...this._longTaskTotals.attribution },
                renderWindowsObserved: this._renderWindows.length,
                samples: copyRecent(this._longTaskSamples),
            },
            inputTiming: {
                count: this._inputTotals.count,
                totalDelayMs: round(this._inputTotals.totalDelayMs),
                maxDelayMs: round(this._inputTotals.maxDelayMs),
                sampledCount: this._inputSamples.length,
                delay: summarizeValues(inputDelayValues),
                byName: { ...this._inputTotals.byName },
                samples: copyRecent(this._inputSamples),
            },
            pendingDeltas: this._pendingDeltas.size,
            dropped: { ...this._dropped },
        };
    }

    _canRequestFrame() {
        return this._requestFrame === defaultRequestFrame
            ? typeof requestAnimationFrame === 'function'
            : true;
    }

    _scheduleFrame() {
        if (!this.enabled || this._frameScheduled || !this._capabilities.requestAnimationFrame) return;
        try {
            const handle = this._requestFrame(this._onFrame);
            if (handle === null || handle === undefined) {
                this._capabilities.requestAnimationFrame = false;
                return;
            }
            this._frameHandle = handle;
            this._frameScheduled = true;
        } catch {
            this._capabilities.requestAnimationFrame = false;
        }
    }

    _handleFrame(timestamp) {
        if (!this.enabled) return;
        this._frameScheduled = false;
        this._frameHandle = null;
        // The rAF timestamp is the frame's scheduled start. Use the callback's
        // actual clock time so a long task that delays this callback widens the
        // measured gap instead of being hidden by an old timestamp.
        const clockAt = this._clock();
        const frameAt = Number.isFinite(clockAt)
            ? clockAt
            : (Number.isFinite(timestamp) ? timestamp : null);
        const previousFrameAt = this._lastFrameAt;
        const frameGapMs = duration(previousFrameAt, frameAt);
        let paintedCount = 0;
        if (this._pendingDeltas.size > 0) {
            for (const [id, token] of this._pendingDeltas) {
                if (token.fanoutEndedAt <= frameAt + MID_FRAME_EPSILON_MS) {
                    this._pendingDeltas.delete(id);
                    paintedCount++;
                    this._recordPaintedDelta(token, frameAt, frameGapMs);
                }
            }
        }

        const ring = this._frameRing;
        if (ring.count >= ring.capacity) this._dropped.frameSamples++;
        ring.at[ring.index] = Number.isFinite(frameAt) ? frameAt : NaN;
        ring.gapMs[ring.index] = Number.isFinite(frameGapMs) ? frameGapMs : NaN;
        ring.deltaCount[ring.index] = paintedCount;
        ring.index = (ring.index + 1) % ring.capacity;
        if (ring.count < ring.capacity) ring.count++;
        if (Number.isFinite(frameGapMs)) {
            this._frameTotals.count++;
            if (frameGapMs > FRAME_BUDGET_MS) this._frameTotals.overBudget++;
            if (frameGapMs > LONG_FRAME_MS) this._frameTotals.longFrames++;
        }
        this._lastFrameAt = frameAt;

        this._scheduleFrame();
    }

    _recordPaintedDelta(token, frameAt, frameGapMs) {
        const framePhaseMs = duration(token.previousFrameAt, token.arrivedAt);
        const sample = {
            id: token.id,
            arrivedAt: token.arrivedAt,
            nextFrameAt: frameAt,
            parseMs: token.parseMs,
            patchApplyMs: token.patchApplyMs,
            eventFanoutMs: token.eventFanoutMs,
            arrivalToPatchMs: token.arrivalToPatchMs,
            arrivalToFanoutMs: token.arrivalToFanoutMs,
            messageToPaintMs: duration(token.arrivedAt, frameAt),
            fanoutToPaintMs: duration(token.fanoutEndedAt, frameAt),
            framePhaseMs,
            frameGapMs,
            operationCount: token.operationCount,
            landedMidFrame: Number.isFinite(framePhaseMs)
                && framePhaseMs > MID_FRAME_EPSILON_MS
                && token.arrivedAt < frameAt,
            outcome: token.outcome || 'painted',
        };
        boundedPush(
            this._deltaSamples,
            sample,
            this._limits.deltaSamples,
            () => { this._dropped.deltaSamples++; },
        );
    }

    _recordUpdateWindow(token) {
        boundedPush(
            this._updateWindows,
            { startTime: token.arrivedAt, endTime: token.fanoutEndedAt },
            this._limits.updateWindows,
            () => { this._dropped.updateWindows++; },
        );
    }

    _installPerformanceObservers() {
        const Observer = this._PerformanceObserverClass || globalThis.PerformanceObserver;
        if (typeof Observer !== 'function') return;
        const supported = Array.isArray(Observer.supportedEntryTypes)
            ? Observer.supportedEntryTypes
            : null;

        if (!supported || supported.includes('longtask')) {
            this._capabilities.longtask = this._observe(Observer, 'longtask', entries => {
                this._recordLongTasks(entriesFrom(entries));
            });
        }
        if (!supported || supported.includes('event')) {
            this._capabilities.event = this._observe(Observer, 'event', entries => {
                this._recordInputEvents(entriesFrom(entries));
            });
        }
    }

    _observe(Observer, type, callback) {
        try {
            const observer = new Observer(callback);
            const options = type === 'event'
                ? { type, buffered: true, durationThreshold: 16 }
                : { type, buffered: true };
            observer.observe(options);
            this._observers.push(observer);
            return true;
        } catch {
            return false;
        }
    }

    _recordLongTasks(entries) {
        if (!this.enabled) return;
        for (const entry of entries) {
            const startTime = finite(entry?.startTime);
            const durationMs = finite(entry?.duration);
            if (startTime === null || durationMs === null || durationMs < 0) continue;
            const attribution = this._attributeWindow(startTime, startTime + durationMs);
            this._longTaskTotals.count++;
            this._longTaskTotals.totalMs += durationMs;
            this._longTaskTotals.maxMs = Math.max(this._longTaskTotals.maxMs, durationMs);
            this._longTaskTotals.attribution[attribution]++;
            boundedPush(
                this._longTaskSamples,
                { startTime, durationMs: round(durationMs), attribution },
                this._limits.longTaskSamples,
                () => { this._dropped.longTaskSamples++; },
            );
        }
    }

    _recordInputEvents(entries) {
        if (!this.enabled) return;
        for (const entry of entries) {
            const startTime = finite(entry?.startTime);
            const processingStart = finite(entry?.processingStart);
            if (startTime === null || processingStart === null) continue;
            const inputDelayMs = Math.max(0, processingStart - startTime);
            const name = String(entry?.name || 'unknown');
            this._inputTotals.count++;
            this._inputTotals.totalDelayMs += inputDelayMs;
            this._inputTotals.maxDelayMs = Math.max(this._inputTotals.maxDelayMs, inputDelayMs);
            const knownName = Object.prototype.hasOwnProperty.call(this._inputTotals.byName, name);
            const nameKey = knownName || Object.keys(this._inputTotals.byName).length < this._limits.inputEventNames
                ? name
                : '[other]';
            this._inputTotals.byName[nameKey] = (this._inputTotals.byName[nameKey] || 0) + 1;
            boundedPush(
                this._inputSamples,
                {
                    name,
                    startTime,
                    durationMs: finite(entry?.duration),
                    inputDelayMs: round(inputDelayMs),
                },
                this._limits.inputSamples,
                () => { this._dropped.inputSamples++; },
            );
        }
    }

    _attributeWindow(startTime, endTime) {
        let update = false;
        let render = false;
        for (const window of this._updateWindows) {
            if (overlaps(startTime, endTime, window.startTime, window.endTime)) {
                update = true;
                break;
            }
        }
        for (const window of this._renderWindows) {
            if (overlaps(startTime, endTime, window.startTime, window.endTime)) {
                render = true;
                break;
            }
        }
        if (update && render) return 'mixed';
        if (update) return 'update';
        if (render) return 'render';
        return 'other';
    }
}
