// The ladder intentionally knows nothing about WebGL. Keeping the timing policy
// here makes it deterministic in unit tests and prevents renderer state from
// leaking into the hysteresis decisions.

// Every active level uploads and presents the full-resolution source each
// frame; levels reduce only optional effect work.
export const POST_FX_LEVELS = Object.freeze({
    FULL: 0,
    REDUCED: 1,
    MINIMAL: 2,
    DISABLED: 3,
});

export const POST_FX_LADDER_REASONS = Object.freeze({
    INITIAL: 'initial',
    WITHIN_BUDGET: 'within-budget',
    HEALTHY_PROBE: 'healthy-probe',
    HEALTHY_RECOVERY: 'healthy-recovery',
    UPLOAD_GRACE: 'upload-grace',
    UPLOAD_IDLE_RECOVERY: 'upload-idle-recovery',
    MINIMAL_RESIDENT: 'minimal-resident',
    OVERRIDE: 'override',
});

const DEFAULT_OPTIONS = Object.freeze({
    budgetMs: 4,
    healthyRatio: 0.75,
    overBudgetMs: 1000,
    scoreWindowFrames: 15,
    unhealthyResetFrames: 3,
    probeMs: 3000,
    uploadGraceMs: 3000,
    uploadIdleFullMs: 1000,
});

function clampLevel(value) {
    if (value === null || value === undefined || value === '') return null;
    const level = Number(value);
    if (!Number.isFinite(level)) return null;
    return Math.max(0, Math.min(3, Math.round(level)));
}

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positive(value, fallback) {
    const number = finite(value, fallback);
    return number > 0 ? number : fallback;
}

function normalizeOptions(options = {}) {
    const budgetMs = positive(options.budgetMs, DEFAULT_OPTIONS.budgetMs);
    const healthyRatio = DEFAULT_OPTIONS.healthyRatio;
    const normalized = {
        ...DEFAULT_OPTIONS,
        ...options,
        budgetMs,
        healthyRatio,
        healthyMs: budgetMs * healthyRatio,
        overBudgetMs: positive(options.overBudgetMs, DEFAULT_OPTIONS.overBudgetMs),
        scoreWindowFrames: Math.max(1, Math.floor(positive(
            options.scoreWindowFrames,
            DEFAULT_OPTIONS.scoreWindowFrames,
        ))),
        unhealthyResetFrames: Math.max(1, Math.floor(positive(
            options.unhealthyResetFrames,
            DEFAULT_OPTIONS.unhealthyResetFrames,
        ))),
        probeMs: positive(options.probeMs, DEFAULT_OPTIONS.probeMs),
        uploadGraceMs: Math.max(0, finite(options.uploadGraceMs, DEFAULT_OPTIONS.uploadGraceMs)),
        uploadIdleFullMs: positive(options.uploadIdleFullMs, DEFAULT_OPTIONS.uploadIdleFullMs),
    };
    delete normalized.overBudgetFrames;
    return normalized;
}

export function assessPostFxTimings(metrics = {}) {
    if (Number.isFinite(Number(metrics.totalMs))
        && !Number.isFinite(Number(metrics.uploadMs))
        && !Number.isFinite(Number(metrics.cpuMs))
        && !Number.isFinite(Number(metrics.shaderCpuMs))) {
        return {
            score: Math.max(0, Number(metrics.totalMs)),
            driver: 'total',
            components: { totalMs: Math.max(0, Number(metrics.totalMs)) },
        };
    }
    const upload = finite(metrics.uploadMs);
    const auxiliaryUpload = finite(metrics.auxUploadMs);
    const setupCpu = finite(metrics.setupCpuMs);
    const cpu = Number.isFinite(Number(metrics.shaderCpuMs))
        ? Number(metrics.shaderCpuMs)
        : finite(metrics.cpuMs);
    const gpu = Number.isFinite(Number(metrics.gpuMs)) ? Number(metrics.gpuMs) : 0;
    const components = {
        uploadMs: Math.max(0, upload),
        auxUploadMs: Math.max(0, auxiliaryUpload),
        setupCpuMs: Math.max(0, setupCpu),
        shaderCpuMs: Math.max(0, cpu),
        gpuMs: Math.max(0, gpu),
        frameGapPenaltyMs: 0,
    };
    let score = components.uploadMs
        + components.auxUploadMs
        + components.setupCpuMs
        + components.shaderCpuMs
        + components.gpuMs;
    let driver = Object.entries(components)
        .filter(([name]) => name !== 'frameGapPenaltyMs')
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'combined';
    // Driver stalls (e.g. canvas-producer readbacks) can land outside the
    // instrumented windows: an oversized gap between consecutive renders is
    // the only visible symptom, so fold the excess above ~30 FPS pacing in.
    const frameGap = finite(metrics.frameGapMs);
    if (frameGap > 35) {
        components.frameGapPenaltyMs = frameGap - 33;
        if (components.frameGapPenaltyMs > score) driver = 'frameGapMs';
        score = Math.max(score, components.frameGapPenaltyMs);
    }
    return { score: Math.max(0, score), driver, components };
}

function normalizeSample(sample) {
    if (!sample || typeof sample !== 'object') return null;
    const score = Math.max(0, finite(sample.score));
    return {
        score,
        driver: typeof sample.driver === 'string' ? sample.driver : 'none',
        components: sample.components && typeof sample.components === 'object'
            ? { ...sample.components }
            : {},
    };
}

function medianAssessment(samples) {
    const sorted = [...samples].sort((a, b) => a.score - b.score);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    const lower = sorted[middle - 1];
    const upper = sorted[middle];
    return {
        ...(upper.score >= lower.score ? upper : lower),
        score: (lower.score + upper.score) / 2,
    };
}

function normalizeState(state = {}, options = {}) {
    const config = normalizeOptions({ ...(state.options || {}), ...options });
    const scoreWindow = Array.isArray(state.scoreWindow)
        ? state.scoreWindow.map(normalizeSample).filter(Boolean).slice(-config.scoreWindowFrames)
        : [];
    return {
        level: clampLevel(state.level) ?? 0,
        override: clampLevel(state.override),
        overBudgetMs: Math.max(0, finite(state.overBudgetMs)),
        overBudgetSinceMs: state.overBudgetSinceMs !== null
            && state.overBudgetSinceMs !== undefined
            && Number.isFinite(Number(state.overBudgetSinceMs))
            ? Number(state.overBudgetSinceMs)
            : null,
        healthySinceMs: state.healthySinceMs !== null
            && state.healthySinceMs !== undefined
            && Number.isFinite(Number(state.healthySinceMs))
            ? Number(state.healthySinceMs)
            : null,
        overHealthyFrames: Math.max(0, Math.floor(finite(state.overHealthyFrames))),
        uploadGraceUntilMs: state.uploadGraceUntilMs !== null
            && state.uploadGraceUntilMs !== undefined
            && Number.isFinite(Number(state.uploadGraceUntilMs))
            ? Number(state.uploadGraceUntilMs)
            : null,
        uploadIdleSinceMs: state.uploadIdleSinceMs !== null
            && state.uploadIdleSinceMs !== undefined
            && Number.isFinite(Number(state.uploadIdleSinceMs))
            ? Number(state.uploadIdleSinceMs)
            : null,
        lastSampleAtMs: state.lastSampleAtMs !== null
            && state.lastSampleAtMs !== undefined
            && Number.isFinite(Number(state.lastSampleAtMs))
            ? Number(state.lastSampleAtMs)
            : null,
        scoreWindow,
        lastScore: Math.max(0, finite(state.lastScore)),
        lastDriver: typeof state.lastDriver === 'string' ? state.lastDriver : 'none',
        lastDecisionReason: typeof state.lastDecisionReason === 'string'
            ? state.lastDecisionReason
            : POST_FX_LADDER_REASONS.INITIAL,
        lastDegradationReason: typeof state.lastDegradationReason === 'string'
            ? state.lastDegradationReason
            : null,
        lastTransitionAtMs: state.lastTransitionAtMs !== null
            && state.lastTransitionAtMs !== undefined
            && Number.isFinite(Number(state.lastTransitionAtMs))
            ? Number(state.lastTransitionAtMs)
            : null,
        lastTransitionMetrics: state.lastTransitionMetrics && typeof state.lastTransitionMetrics === 'object'
            ? { ...state.lastTransitionMetrics }
            : null,
        options: config,
    };
}

/**
 * Advance the ladder by one frame. The returned object is a new state, which
 * keeps callers free to retain snapshots for diagnostics or tests.
 */
export function advancePostFxLadder(state = {}, metrics = {}, nowMs = Date.now(), options = {}) {
    const current = normalizeState(state, options);
    const config = current.options;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const rawAssessment = assessPostFxTimings(metrics);
    const uploadGraceUntilMs = current.uploadGraceUntilMs ?? (now + config.uploadGraceMs);
    const uploadDriven = rawAssessment.driver === 'uploadMs' || rawAssessment.driver === 'auxUploadMs';
    const inUploadGrace = uploadDriven && now < uploadGraceUntilMs;
    const assessment = inUploadGrace
        ? assessPostFxTimings({ ...metrics, uploadMs: 0, auxUploadMs: 0 })
        : rawAssessment;
    const scoreWindow = [...current.scoreWindow, assessment]
        .slice(-config.scoreWindowFrames);
    const median = medianAssessment(scoreWindow);
    const score = median.score;
    const driver = median.driver;

    // A QA override is deliberately sticky and does not poison the underlying
    // level's healthy/budget counters.
    if (current.override !== null) {
        return {
            ...current,
            uploadGraceUntilMs,
            scoreWindow,
            lastSampleAtMs: now,
            lastScore: score,
            lastDriver: driver,
            lastDecisionReason: POST_FX_LADDER_REASONS.OVERRIDE,
        };
    }

    let level = current.level;
    let overBudgetMs = current.overBudgetMs;
    let overBudgetSinceMs = current.overBudgetSinceMs;
    let healthySinceMs = current.healthySinceMs;
    let overHealthyFrames = current.overHealthyFrames;
    let uploadIdleSinceMs = current.uploadIdleSinceMs;
    let lastDecisionReason = current.lastDecisionReason;
    let lastDegradationReason = current.lastDegradationReason;
    let lastTransitionAtMs = current.lastTransitionAtMs;
    let lastTransitionMetrics = current.lastTransitionMetrics;
    const hasUploadMetric = Number.isFinite(Number(metrics.uploadMs));
    const uploadMs = Math.max(0, finite(metrics.uploadMs));

    if (hasUploadMetric && uploadMs === 0) {
        if (uploadIdleSinceMs === null) uploadIdleSinceMs = now;
    } else if (hasUploadMetric) {
        uploadIdleSinceMs = null;
    }

    if (score > config.budgetMs) {
        if (overBudgetSinceMs === null) overBudgetSinceMs = now;
        overBudgetMs = Math.max(0, now - overBudgetSinceMs);
        lastDecisionReason = `over-budget:${driver}`;
        if (overBudgetMs >= config.overBudgetMs && level < POST_FX_LEVELS.DISABLED) {
            level += 1;
            overBudgetMs = 0;
            overBudgetSinceMs = null;
            lastDegradationReason = `sustained-${driver}`;
            lastDecisionReason = `degrade:${lastDegradationReason}`;
            lastTransitionAtMs = now;
            lastTransitionMetrics = {
                score,
                driver,
                ...median.components,
            };
        } else if (level >= POST_FX_LEVELS.DISABLED) {
            lastDecisionReason = `${POST_FX_LADDER_REASONS.MINIMAL_RESIDENT}:${driver}`;
        }
    } else {
        overBudgetMs = 0;
        overBudgetSinceMs = null;
        lastDecisionReason = inUploadGrace
            ? POST_FX_LADDER_REASONS.UPLOAD_GRACE
            : POST_FX_LADDER_REASONS.WITHIN_BUDGET;
    }

    if (score < config.healthyMs) {
        overHealthyFrames = 0;
        if (level > POST_FX_LEVELS.FULL) {
            if (healthySinceMs === null) healthySinceMs = now;
            lastDecisionReason = inUploadGrace
                ? POST_FX_LADDER_REASONS.UPLOAD_GRACE
                : POST_FX_LADDER_REASONS.HEALTHY_PROBE;
        } else {
            healthySinceMs = null;
        }
    } else {
        overHealthyFrames += 1;
        if (overHealthyFrames >= config.unhealthyResetFrames) healthySinceMs = null;
    }

    const uploadIdleForMs = uploadIdleSinceMs === null ? 0 : now - uploadIdleSinceMs;
    if (level > POST_FX_LEVELS.FULL
        && hasUploadMetric
        && rawAssessment.score <= config.budgetMs
        && score <= config.budgetMs
        && uploadIdleForMs >= config.uploadIdleFullMs) {
        level = POST_FX_LEVELS.FULL;
        healthySinceMs = null;
        overHealthyFrames = 0;
        lastDecisionReason = POST_FX_LADDER_REASONS.UPLOAD_IDLE_RECOVERY;
        lastTransitionAtMs = now;
        lastTransitionMetrics = {
            score,
            driver,
            ...median.components,
        };
    } else if (level > POST_FX_LEVELS.FULL
        && score < config.healthyMs
        && healthySinceMs !== null
        && now - healthySinceMs >= config.probeMs) {
        level -= 1;
        healthySinceMs = now;
        lastDecisionReason = POST_FX_LADDER_REASONS.HEALTHY_RECOVERY;
        lastTransitionAtMs = now;
        lastTransitionMetrics = {
            score,
            driver,
            ...median.components,
        };
    }

    return {
        ...current,
        level,
        overBudgetMs,
        overBudgetSinceMs,
        healthySinceMs,
        overHealthyFrames,
        uploadGraceUntilMs,
        uploadIdleSinceMs,
        lastSampleAtMs: now,
        scoreWindow,
        lastScore: score,
        lastDriver: driver,
        lastDecisionReason,
        lastDegradationReason,
        lastTransitionAtMs,
        lastTransitionMetrics,
    };
}

export function createPostFxLadder(options = {}) {
    let state = normalizeState({}, options);

    return {
        update(metrics = {}, nowMs = Date.now()) {
            state = advancePostFxLadder(state, metrics, nowMs, state.options);
            return this.getState();
        },
        step(metrics = {}, nowMs = Date.now()) {
            return this.update(metrics, nowMs);
        },
        getLevel() {
            return state.override ?? state.level;
        },
        getState() {
            return { ...state, effectiveLevel: state.override ?? state.level };
        },
        setOverride(levelOrNull) {
            state = { ...state, override: clampLevel(levelOrNull) };
            return this.getLevel();
        },
        reset(level = 0) {
            state = normalizeState({ level, override: null }, state.options);
            return this.getState();
        },
    };
}

// Named aliases make the pure transition convenient for small diagnostics and
// tests without forcing them to instantiate the stateful facade.
export const updatePostFxLadder = advancePostFxLadder;
export const stepPostFxLadder = advancePostFxLadder;
export const createLadder = createPostFxLadder;
