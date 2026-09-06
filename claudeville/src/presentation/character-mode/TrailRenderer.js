import { eventBus } from '../../domain/events/DomainEvent.js';
import { CANVAS_BUDGET, canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
import { tileToWorld, worldToTile } from './Projection.js';

const CAPTURE_INTERVAL_MS = 1000;
const FLUSH_INTERVAL_MS = 30000;
const REPAINT_INTERVAL_MS = 2000;
const PRUNE_INTERVAL_MS = 60000;
const RETAIN_MS = 60 * 60 * 1000;
const MIN_SAMPLE_DISTANCE_TILES = 0.2;
const MAX_SAMPLES_PER_AGENT = 720;
const MAX_TOTAL_SAMPLES = 12000;
const MAX_PENDING_SAMPLES = 4000;
const COMPACT_TO_RATIO = 0.8;
const MAX_RENDER_SAMPLES_PER_AGENT = 240;
const MAX_RENDER_SAMPLES_TOTAL = 4000;
const MAX_SELECTED_RENDER_SAMPLES = 24;
const MAX_ACTION_RENDER_SAMPLES = 12;
const DIRECT_RENDER_SAMPLE_LIMIT = 512;
// Historical trails are intentionally half-resolution. They are faint ground
// context, while selected/action-needed recent paths render directly at full
// resolution. This keeps the camera-stable cache cheap to composite.
const WORLD_CACHE_SCALE = 0.5;
const ACTION_NEEDED_STATUSES = new Set(['waiting_on_user', 'errored', 'rate_limited']);
const CAMERA_MOTION_MODES = Object.freeze([
    'stationary',
    'manual-pan',
    'follow',
    'director-glide',
]);
const PHASE_COLORS = {
    morning: '255, 218, 128',
    afternoon: '232, 224, 194',
    dusk: '255, 164, 96',
    night: '112, 174, 255',
};

function sampleId(agentId, ts) {
    return `${agentId}:${Math.floor(ts / 1000)}`;
}

function pageIsVisible() {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function viewportMetrics(viewport = {}) {
    const dpr = viewport.dpr || viewport._claudeVilleDpr || 1;
    const taggedCssViewport = viewport._claudeVilleDpr && !viewport._claudeVilleCssWidth;
    const width = viewport._claudeVilleCssWidth || viewport.clientWidth || (taggedCssViewport ? viewport.width : Math.round((viewport.width || 0) / dpr)) || viewport.width || 0;
    const height = viewport._claudeVilleCssHeight || viewport.clientHeight || (taggedCssViewport ? viewport.height : Math.round((viewport.height || 0) / dpr)) || viewport.height || 0;
    return { dpr, width, height };
}

function sampleListToLimit(samples, limit) {
    const target = Math.max(1, Math.floor(limit));
    if (!Array.isArray(samples) || samples.length <= target) return samples;
    if (target === 1) return [samples.at(-1)];
    if (target === 2) return [samples[0], samples.at(-1)];

    // Keep a denser recent tail while preserving evenly spaced history so the
    // one-hour route remains recognizable after compaction.
    const recentCount = Math.min(Math.floor(target / 4), 120);
    const historyCount = target - recentCount;
    const historyEnd = samples.length - recentCount;
    const compacted = [];
    for (let index = 0; index < historyCount; index++) {
        const sourceIndex = historyCount === 1
            ? 0
            : Math.round(index * Math.max(0, historyEnd - 1) / (historyCount - 1));
        compacted.push(samples[sourceIndex]);
    }
    compacted.push(...samples.slice(-recentCount));
    return compacted;
}

function timerNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function cameraPose(camera) {
    return {
        x: Number(camera?.x) || 0,
        y: Number(camera?.y) || 0,
        zoom: Number(camera?.zoom) || 1,
    };
}

export function classifyTrailCameraMotion(camera, previousPose = null) {
    if (camera?.isDirectorGliding?.() || camera?._directorGlide) return 'director-glide';
    if (camera?.followTarget) return 'follow';
    const pose = cameraPose(camera);
    const moved = previousPose && (
        Math.abs(pose.x - previousPose.x) > 0.01
        || Math.abs(pose.y - previousPose.y) > 0.01
        || Math.abs(pose.zoom - previousPose.zoom) > 0.0001
    );
    if (camera?.dragging || camera?._momentum || moved) return 'manual-pan';
    return 'stationary';
}

export function resolveTrailRenderPolicy({
    totalSamples = 0,
    selectedAgentId = null,
    cameraMotion = 'stationary',
} = {}) {
    void totalSamples;
    void cameraMotion;
    return Object.freeze({
        historicalMode: 'none',
        cacheSpace: 'none',
        repaintOnCameraMotion: false,
        historicalVisibility: 'hidden',
        selectedMode: selectedAgentId ? 'recent-direct-overlay' : 'none',
        actionNeededMode: 'recent-direct-overlay',
    });
}

function createCameraMotionStats() {
    return Object.fromEntries(CAMERA_MOTION_MODES.map(mode => [mode, {
        frames: 0,
        drawTimeMs: 0,
        repaintCount: 0,
        repaintTimeMs: 0,
    }]));
}

// Shared trail-stroke vocabulary (plan 3.10 — one trail language). Both the
// persisted hour-trails below and the director's live replay trails in
// VillageDirectorOverlay stroke through here: round-capped per-segment
// polylines whose alpha decays with sample age. Color semantics stay with the
// caller (phase palette vs status/team palette); `points` are screen/world
// `{ x, y, ts }` in the caller's current transform.
export function strokeAgedTrailSegments(ctx, points, {
    now = Date.now(),
    maxAgeMs = RETAIN_MS,
    baseAlpha = 0.18,
    width = 1,
    rgbForPoint = null,
} = {}) {
    if (!ctx || !Array.isArray(points) || points.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const current = points[i];
        const age = Math.max(0, now - (Number(current.ts) || now));
        const alpha = Math.max(0.02, 1 - age / maxAgeMs) * baseAlpha;
        const color = rgbForPoint ? rgbForPoint(current, i) : '232, 224, 194';
        ctx.strokeStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(Math.round(previous.x), Math.round(previous.y));
        ctx.lineTo(Math.round(current.x), Math.round(current.y));
        ctx.stroke();
    }
    ctx.restore();
}

export class TrailRenderer {
    constructor({ store = null, world = null, sprites = null, motionScale = 1 } = {}) {
        this.store = store;
        this.world = world;
        this.sprites = sprites;
        this.motionScale = motionScale;
        this.samplesByAgent = new Map();
        this.pending = [];
        this.cache = null;
        this.cacheKey = '';
        this.cacheBounds = null;
        this._lastCameraPose = null;
        this._lastCameraMotion = 'stationary';
        this.lastCaptureAt = 0;
        this.lastFlushAt = 0;
        this.lastRepaintAt = 0;
        this.lastPruneAt = 0;
        this.selectedAgentId = null;
        this.lease = null;
        this._loaded = false;
        this._paused = false;
        this._needsRepaint = true;
        this._totalSamples = 0;
        this._flushPromise = null;
        this._drainPromise = null;
        this._disposePromise = null;
        this._disposed = false;
        this._lifecycleGeneration = 0;
        this._stats = {
            capturedSamples: 0,
            hydratedSamples: 0,
            duplicateDrops: 0,
            malformedDrops: 0,
            pendingDrops: 0,
            compactedSamples: 0,
            prunedSamples: 0,
            pruneRuns: 0,
            repaintCount: 0,
            repaintTimeMs: 0,
            directDrawCount: 0,
            directDrawTimeMs: 0,
            cacheDrawCount: 0,
            cacheDrawTimeMs: 0,
            selectedOverlayDraws: 0,
            actionOverlayDraws: 0,
            highWaterSamples: 0,
            highWaterCachePixels: 0,
            oversizedCacheFallbacks: 0,
            cameraMotion: createCameraMotionStats(),
        };
        this._unsubscribers = [
            eventBus.on('agent:selected', (agent) => this.setSelectedAgent(agent?.id || null)),
            eventBus.on('agent:deselected', () => this.setSelectedAgent(null)),
        ];
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        this._needsRepaint = true;
    }

    setSelectedAgent(agentId) {
        if (this.selectedAgentId === agentId) return;
        this.selectedAgentId = agentId;
    }

    async hydrate(now = Date.now()) {
        if (this._disposed || this._paused || !this.store || this._loaded) return;
        const generation = this._lifecycleGeneration;
        try {
            const records = await this.store.queryRange('trailSamples', {
                index: 'ts',
                lower: now - RETAIN_MS,
                upper: now,
                limit: MAX_TOTAL_SAMPLES,
                direction: 'prev',
            });
            if (this._disposed || this._paused || generation !== this._lifecycleGeneration) return;
            let hydrated = 0;
            for (const record of Array.isArray(records) ? records.slice().reverse() : []) {
                if (this._addSample(record, false)) hydrated++;
            }
            this._stats.hydratedSamples += hydrated;
            this._enforceGlobalCap();
        } catch { /* empty trail on storage failures */ }
        if (this._disposed || this._paused || generation !== this._lifecycleGeneration) return;
        this._loaded = true;
        this._needsRepaint = true;
    }

    async update(agents, now = Date.now(), atmosphere = null) {
        if (this._disposed || this._paused) return;
        const generation = this._lifecycleGeneration;
        await this.hydrate(now);
        if (this._disposed || this._paused || generation !== this._lifecycleGeneration) return;
        const visible = pageIsVisible();
        if (!visible && this.lease) {
            this.releaseLease();
        }
        if (visible && !this.lease && this.store) {
            try {
                const lease = this.store.acquireCaptureLease();
                if (lease.acquired) this.lease = lease;
            } catch { /* read-only fallback */ }
        }
        if (this.lease && !this.lease.renew()) this.lease = null;

        if (visible && this.lease && now - this.lastCaptureAt >= CAPTURE_INTERVAL_MS) {
            this.capture(agents, now, atmosphere);
        }
        if (visible && this.lease && now - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
            await this.flush(now);
            if (this._disposed || this._paused || generation !== this._lifecycleGeneration) return;
        }
        this._pruneMemory(now);
    }

    capture(agents, now = Date.now(), atmosphere = null) {
        if (this._disposed || this._paused) return;
        this.lastCaptureAt = now;
        const list = agents?.values ? agents.values() : (agents || []);
        for (const agent of list) {
            const position = this._capturePosition(agent);
            if (!agent?.id || !position) continue;
            const tileX = Number(position.tileX);
            const tileY = Number(position.tileY);
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const sample = {
                id: sampleId(agent.id, now),
                agentId: agent.id,
                provider: agent.provider || '',
                model: agent.model || '',
                ts: now,
                tileX,
                tileY,
                dayProgress: Number(atmosphere?.dayProgress ?? 0),
                phase: atmosphere?.phase || this._phaseFromDate(now),
            };
            if (this._addSample(sample, true)) this._stats.capturedSamples++;
        }
        this._enforceGlobalCap();
    }

    async flush(now = Date.now()) {
        this.lastFlushAt = now;
        if (this._flushPromise) {
            await this._flushPromise;
        }
        if (!this.pending.length || !this.store) return 0;
        const batch = this.pending.splice(0, this.pending.length);
        const store = this.store;
        const operation = Promise.resolve()
            .then(() => store.bulkPut('trailSamples', batch))
            .catch(() => 0);
        this._flushPromise = operation;
        try {
            return await operation;
        } finally {
            if (this._flushPromise === operation) this._flushPromise = null;
        }
    }

    drain(now = Date.now()) {
        if (this._drainPromise) return this._drainPromise;
        const drain = (async () => {
            let flushed = 0;
            while (this._flushPromise || (this.pending.length && this.store)) {
                if (this._flushPromise) await this._flushPromise;
                if (this.pending.length && this.store) flushed += Number(await this.flush(now)) || 0;
            }
            return flushed;
        })();
        const wrapped = drain.finally(() => {
            if (this._drainPromise === wrapped) this._drainPromise = null;
        });
        this._drainPromise = wrapped;
        return wrapped;
    }

    draw(ctx, camera, viewport, now = Date.now(), preserveTransform = false) {
        if (this._disposed || this._paused || !ctx || !camera || !viewport) return;
        const drawStartedAt = timerNow();
        const motionMode = classifyTrailCameraMotion(camera, this._lastCameraPose);
        const policy = resolveTrailRenderPolicy({
            totalSamples: this._totalSamples,
            selectedAgentId: this.selectedAgentId,
            cameraMotion: motionMode,
        });
        this._lastCameraMotion = motionMode;
        try {
            if (this.cache) this.releaseCache();
            // Ambient history is deliberately invisible. Only a short recent
            // route for selection or action-needed state survives, preventing
            // long-lived paths from webbing over the authored village.
            this._drawSemanticTrailOverlays(ctx, camera, now, preserveTransform);
        } finally {
            this._recordCameraMotionDraw(motionMode, drawStartedAt);
            this._lastCameraPose = cameraPose(camera);
        }
    }

    dispose() {
        if (this._disposePromise) return this._disposePromise;
        this._disposed = true;
        this._paused = true;
        this._lifecycleGeneration++;
        this._disposePromise = this.drain();
        this.releaseLease();
        for (const off of this._unsubscribers) off?.();
        this._unsubscribers = [];
        this.releaseCache();
        return this._disposePromise;
    }

    pause() {
        if (this._disposed) return;
        if (!this._paused) {
            this._paused = true;
            this._lifecycleGeneration++;
        }
        this.releaseLease();
        this.releaseCache();
    }

    resume() {
        if (this._disposed || !this._paused) return;
        this._paused = false;
        this._lifecycleGeneration++;
        this._needsRepaint = true;
    }

    releaseLease() {
        this.lease?.release?.();
        this.lease = null;
    }

    releaseCache() {
        releaseCanvasBackingStore(this.cache);
        this.cache = null;
        this.cacheKey = '';
        this.cacheBounds = null;
        this._needsRepaint = true;
    }

    getCanvasBudget() {
        return {
            volatilePixels: canvasPixelCount(this.cache),
            cacheKey: this.cacheKey,
            pendingSamples: this.pending.length,
            flushInFlight: this._flushPromise !== null,
            ...this.getDiagnostics(),
        };
    }

    getDiagnostics() {
        const cameraMotion = Object.fromEntries(Object.entries(this._stats.cameraMotion).map(([mode, stats]) => [
            mode,
            { ...stats },
        ]));
        return {
            ...this._stats,
            cameraMotion,
            totalSamples: this._totalSamples,
            agentsWithSamples: this.samplesByAgent.size,
            pendingSamples: this.pending.length,
            paused: this._paused,
            loaded: this._loaded,
            perAgentLimit: MAX_SAMPLES_PER_AGENT,
            globalLimit: MAX_TOTAL_SAMPLES,
            pendingLimit: MAX_PENDING_SAMPLES,
            renderPerAgentLimit: MAX_RENDER_SAMPLES_PER_AGENT,
            renderGlobalLimit: MAX_RENDER_SAMPLES_TOTAL,
            directRenderLimit: DIRECT_RENDER_SAMPLE_LIMIT,
            actionRenderLimit: MAX_ACTION_RENDER_SAMPLES,
            minimumDistanceTiles: MIN_SAMPLE_DISTANCE_TILES,
            cacheSpace: this.cache ? 'world' : 'none',
            cacheBounds: this.cacheBounds ? { ...this.cacheBounds } : null,
            cameraMotionMode: this._lastCameraMotion,
            renderPolicy: resolveTrailRenderPolicy({
                totalSamples: this._totalSamples,
                selectedAgentId: this.selectedAgentId,
                cameraMotion: this._lastCameraMotion,
            }),
        };
    }

    _addSample(sample, pending) {
        const agentId = String(sample?.agentId || '');
        const ts = Number(sample?.ts);
        const tileX = Number(sample?.tileX);
        const tileY = Number(sample?.tileY);
        if (!agentId || !Number.isFinite(ts) || !Number.isFinite(tileX) || !Number.isFinite(tileY)) {
            this._stats.malformedDrops++;
            return false;
        }
        const normalized = sample.agentId === agentId
            && sample.ts === ts
            && sample.tileX === tileX
            && sample.tileY === tileY
            ? sample
            : { ...sample, agentId, ts, tileX, tileY };
        let list = this.samplesByAgent.get(agentId) || [];
        const last = list.at(-1);
        if (last) {
            const dx = tileX - last.tileX;
            const dy = tileY - last.tileY;
            if (
                Math.floor(last.ts / 1000) === Math.floor(ts / 1000)
                || dx * dx + dy * dy < MIN_SAMPLE_DISTANCE_TILES * MIN_SAMPLE_DISTANCE_TILES
            ) {
                this._stats.duplicateDrops++;
                return false;
            }
        }
        list.push(normalized);
        this._totalSamples++;
        if (list.length > MAX_SAMPLES_PER_AGENT) {
            const target = Math.max(2, Math.floor(MAX_SAMPLES_PER_AGENT * COMPACT_TO_RATIO));
            const compacted = sampleListToLimit(list, target);
            this._recordCompaction(list.length - compacted.length);
            this._totalSamples -= list.length - compacted.length;
            list = compacted;
        }
        this.samplesByAgent.set(agentId, list);
        if (pending && this.store) {
            this.pending.push(normalized);
            if (this.pending.length > MAX_PENDING_SAMPLES) {
                const excess = this.pending.length - MAX_PENDING_SAMPLES;
                this.pending.splice(0, excess);
                this._stats.pendingDrops += excess;
            }
        }
        this._stats.highWaterSamples = Math.max(this._stats.highWaterSamples, this._totalSamples);
        this._needsRepaint = true;
        return true;
    }

    _shouldRepaint(now) {
        if (!this.cache) return true;
        if (this.motionScale === 0) return this._needsRepaint;
        return this._needsRepaint && now - this.lastRepaintAt >= REPAINT_INTERVAL_MS;
    }

    _drawDirect(ctx, camera, viewport, now) {
        const startedAt = timerNow();
        const { dpr } = viewportMetrics(viewport);
        const bounds = camera.getViewportTileBounds?.(3);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (const [agentId, samples] of this.samplesByAgent) {
            if (samples.length < 2) continue;
            const visible = !bounds || samples.some(sample => (
                sample.tileX >= bounds.startX && sample.tileX <= bounds.endX
                && sample.tileY >= bounds.startY && sample.tileY <= bounds.endY
            ));
            if (!visible) continue;
            const limit = agentId === this.selectedAgentId
                ? MAX_SELECTED_RENDER_SAMPLES
                : MAX_RENDER_SAMPLES_PER_AGENT;
            const renderSamples = samples.length > limit
                ? sampleListToLimit(samples, limit)
                : samples;
            this._drawTrailPoints(
                ctx,
                this._trailPoints(renderSamples, camera),
                now,
                this._trailImportance(agentId),
            );
        }
        ctx.restore();
        this._stats.directDrawCount++;
        this._stats.directDrawTimeMs += Math.max(0, timerNow() - startedAt);
    }

    _repaintWorldCache(now, motionMode = this._lastCameraMotion) {
        const repaintStartedAt = timerNow();
        const trails = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const cacheTrails = [];
        for (const [agentId, samples] of this.samplesByAgent) {
            if (samples.length < 2) continue;
            cacheTrails.push({ agentId, samples });
        }

        const ordinaryCount = Math.max(1, cacheTrails.length);
        const ordinaryLimit = Math.max(
            2,
            Math.min(
                MAX_RENDER_SAMPLES_PER_AGENT,
                Math.floor(MAX_RENDER_SAMPLES_TOTAL / ordinaryCount),
            ),
        );
        for (const { samples } of cacheTrails) {
            const renderSamples = samples.length > ordinaryLimit
                ? sampleListToLimit(samples, ordinaryLimit)
                : samples;
            const points = this._worldTrailPoints(renderSamples);
            if (points.length < 2) continue;
            trails.push(points);
            for (const point of points) {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }
        }

        const pad = 6;
        const left = Math.floor(minX - pad);
        const top = Math.floor(minY - pad);
        const right = Math.ceil(maxX + pad);
        const bottom = Math.ceil(maxY + pad);
        if (!trails.length || right <= left || bottom <= top) {
            releaseCanvasBackingStore(this.cache);
            this.cache = null;
            this.cacheBounds = null;
            this.cacheKey = '';
            this._needsRepaint = false;
            this.lastRepaintAt = now;
            this._recordRepaint(repaintStartedAt, motionMode);
            return;
        }

        const cacheWidth = right - left;
        const cacheHeight = bottom - top;
        const uncappedPixels = cacheWidth * cacheHeight * WORLD_CACHE_SCALE * WORLD_CACHE_SCALE;
        const scale = Math.max(
            0.25,
            Math.min(WORLD_CACHE_SCALE, Math.sqrt(CANVAS_BUDGET.maxTrailCachePixels / Math.max(1, uncappedPixels))),
        );
        if (scale < WORLD_CACHE_SCALE) this._stats.oversizedCacheFallbacks++;
        const canvas = this.cache || document.createElement('canvas');
        const backingWidth = Math.max(1, Math.ceil(cacheWidth * scale));
        const backingHeight = Math.max(1, Math.ceil(cacheHeight * scale));
        if (canvas.width !== backingWidth) canvas.width = backingWidth;
        if (canvas.height !== backingHeight) canvas.height = backingHeight;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
        ctx.clearRect(left, top, cacheWidth, cacheHeight);
        for (const points of trails) {
            this._drawTrailPoints(ctx, points, now, 'ambient', {
                coordinateSpace: 'world-cache',
                cacheScale: scale,
            });
        }

        this.cache = canvas;
        this.cacheBounds = { x: left, y: top, width: cacheWidth, height: cacheHeight, scale };
        this.cacheKey = `world|${this._totalSamples}|${left},${top},${cacheWidth},${cacheHeight}|${scale.toFixed(3)}`;
        this._stats.highWaterCachePixels = Math.max(
            this._stats.highWaterCachePixels,
            canvasPixelCount(canvas),
        );
        this._needsRepaint = false;
        this.lastRepaintAt = now;
        this._recordRepaint(repaintStartedAt, motionMode);
    }

    _drawSemanticTrailOverlays(ctx, camera, now, preserveTransform = false) {
        const zoom = Math.max(0.25, Number(camera?.zoom) || 1);
        let drewAny = false;
        ctx.save();
        if (!preserveTransform) camera.applyTransform?.(ctx);
        for (const [agentId, samples] of this.samplesByAgent) {
            if (samples.length < 2) continue;
            const importance = this._trailImportance(agentId);
            if (importance === 'ambient') continue;
            const limit = importance === 'selected'
                ? MAX_SELECTED_RENDER_SAMPLES
                : MAX_ACTION_RENDER_SAMPLES;
            const renderSamples = samples.slice(-limit);
            this._drawTrailPoints(ctx, this._worldTrailPoints(renderSamples), now, importance, {
                coordinateSpace: 'world',
                zoom,
            });
            if (importance === 'selected') this._stats.selectedOverlayDraws++;
            else this._stats.actionOverlayDraws++;
            drewAny = true;
        }
        ctx.restore();
        return drewAny;
    }

    _trailImportance(agentId) {
        if (agentId === this.selectedAgentId) return 'selected';
        const status = String(this.world?.agents?.get?.(agentId)?.status || '').toLowerCase();
        return ACTION_NEEDED_STATUSES.has(status) ? 'action-needed' : 'ambient';
    }

    _trailPoints(samples, camera) {
        const points = [];
        for (const sample of samples) {
            const world = tileToWorld(sample.tileX, sample.tileY);
            const p = camera.worldToScreen(world.x, world.y);
            points.push({ x: p.x, y: p.y, ts: sample.ts, phase: sample.phase });
        }
        return points;
    }

    _worldTrailPoints(samples) {
        const points = [];
        for (const sample of samples) {
            const world = tileToWorld(sample.tileX, sample.tileY);
            points.push({ x: world.x, y: world.y, ts: sample.ts, phase: sample.phase });
        }
        return points;
    }

    _drawTrailPoints(ctx, points, now, importance = 'ambient', {
        coordinateSpace = 'screen',
        zoom = 1,
        cacheScale = 1,
    } = {}) {
        if (points.length < 2) return;
        const selected = importance === 'selected';
        const actionNeeded = importance === 'action-needed';
        let width = selected ? 2 : actionNeeded ? 1.5 : 1;
        if (coordinateSpace === 'world') width /= Math.max(0.25, zoom);
        if (coordinateSpace === 'world-cache') width /= Math.max(0.25, cacheScale);
        strokeAgedTrailSegments(ctx, points, {
            now,
            maxAgeMs: RETAIN_MS,
            baseAlpha: selected ? 0.30 : actionNeeded ? 0.28 : 0,
            width,
            rgbForPoint: (point) => PHASE_COLORS[point.phase] || PHASE_COLORS.afternoon,
        });
    }

    _pruneMemory(now, { force = false } = {}) {
        if (!force && now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
        this.lastPruneAt = now;
        this._stats.pruneRuns++;
        const cutoff = now - RETAIN_MS;
        for (const [agentId, samples] of this.samplesByAgent) {
            let firstKept = 0;
            while (firstKept < samples.length && samples[firstKept].ts < cutoff) firstKept++;
            if (firstKept === 0) continue;
            samples.splice(0, firstKept);
            this._totalSamples -= firstKept;
            this._stats.prunedSamples += firstKept;
            if (!samples.length) this.samplesByAgent.delete(agentId);
            this._needsRepaint = true;
        }
    }

    _capturePosition(agent) {
        if (!agent?.id) return null;
        const sprite = this.sprites?.get?.(agent.id);
        if (sprite) {
            const x = Number(sprite.x);
            const y = Number(sprite.y);
            if (Number.isFinite(x) && Number.isFinite(y)) return worldToTile(x, y);
            return null;
        }
        return agent.position || null;
    }

    _enforceGlobalCap() {
        if (this._totalSamples <= MAX_TOTAL_SAMPLES) return;
        const targetPerAgent = Math.max(
            2,
            Math.floor(MAX_TOTAL_SAMPLES * COMPACT_TO_RATIO / Math.max(1, this.samplesByAgent.size)),
        );
        for (const [agentId, samples] of this.samplesByAgent) {
            if (samples.length <= targetPerAgent) continue;
            const compacted = sampleListToLimit(samples, targetPerAgent);
            const removed = samples.length - compacted.length;
            this.samplesByAgent.set(agentId, compacted);
            this._totalSamples -= removed;
            this._recordCompaction(removed);
        }
        if (this._totalSamples > MAX_TOTAL_SAMPLES) {
            for (const [agentId, samples] of this.samplesByAgent) {
                if (this._totalSamples <= MAX_TOTAL_SAMPLES) break;
                const remove = Math.min(samples.length - 1, this._totalSamples - MAX_TOTAL_SAMPLES);
                if (remove <= 0) continue;
                samples.splice(0, remove);
                this._totalSamples -= remove;
                this._recordCompaction(remove);
                if (!samples.length) this.samplesByAgent.delete(agentId);
            }
        }
        this._needsRepaint = true;
    }

    _recordCompaction(removed) {
        if (removed > 0) this._stats.compactedSamples += removed;
    }

    _recordRepaint(startedAt, motionMode = this._lastCameraMotion) {
        const elapsed = Math.max(0, timerNow() - startedAt);
        this._stats.repaintCount++;
        this._stats.repaintTimeMs += elapsed;
        const bucket = this._stats.cameraMotion[motionMode] || this._stats.cameraMotion.stationary;
        bucket.repaintCount++;
        bucket.repaintTimeMs += elapsed;
    }

    _recordCameraMotionDraw(motionMode, startedAt) {
        const elapsed = Math.max(0, timerNow() - startedAt);
        const bucket = this._stats.cameraMotion[motionMode] || this._stats.cameraMotion.stationary;
        bucket.frames++;
        bucket.drawTimeMs += elapsed;
    }

    _phaseFromDate(now) {
        const hour = new Date(now).getHours();
        if (hour < 6 || hour >= 21) return 'night';
        if (hour < 12) return 'morning';
        if (hour < 18) return 'afternoon';
        return 'dusk';
    }
}
