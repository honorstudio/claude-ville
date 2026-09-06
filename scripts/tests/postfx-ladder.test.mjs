import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POST_FX_LEVELS,
    assessPostFxTimings,
    createPostFxLadder,
} from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import {
    EFFECT_BUDGET,
    effectBudgetMode,
    shedEffectsForLevel,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

test('resident effects shed in declared order as the ladder steps down', () => {
    const ladder = createPostFxLadder();

    ladder.setOverride(POST_FX_LEVELS.FULL);
    assert.deepEqual(shedEffectsForLevel(ladder.getLevel()), []);

    ladder.setOverride(POST_FX_LEVELS.REDUCED);
    assert.deepEqual(shedEffectsForLevel(ladder.getLevel()), [
        { id: 'bloom', mode: 'reduced' },
        { id: 'weather-amplitude', mode: 'reduced' },
        { id: 'moon-course', mode: 'ambient-course-only' },
        { id: 'wet-reflection', mode: 'four-sources' },
    ]);

    ladder.setOverride(POST_FX_LEVELS.MINIMAL);
    assert.deepEqual(shedEffectsForLevel(ladder.getLevel()), [
        { id: 'bloom', mode: 'off' },
        { id: 'weather-amplitude', mode: 'off' },
        { id: 'occlusion', mode: 'off' },
        { id: 'moon-course', mode: 'ambient-course-only' },
        { id: 'wet-reflection', mode: 'static-wet-darkening' },
        { id: 'palette-ramp', mode: 'off' },
    ]);

    // The minimal-resident probe level renders MINIMAL's composition.
    ladder.setOverride(POST_FX_LEVELS.DISABLED);
    assert.deepEqual(
        shedEffectsForLevel(ladder.getLevel()),
        shedEffectsForLevel(POST_FX_LEVELS.MINIMAL),
    );
});

test('MINIMAL admits no optional GPU pass and no optional resident bytes', () => {
    const rows = Object.values(EFFECT_BUDGET);

    // An effect that keeps bytes resident is a FULL-level luxury...
    for (const effect of rows.filter((row) => row.cost.bytes > 0)) {
        assert.equal(effectBudgetMode(effect.id, POST_FX_LEVELS.FULL), 'on');
    }
    // ...and nothing still running at MINIMAL prices any.
    const residentAtMinimal = rows
        .filter((effect) => effectBudgetMode(effect.id, POST_FX_LEVELS.MINIMAL) !== 'off')
        .reduce((bytes, effect) => bytes + effect.cost.bytes, 0);
    assert.equal(residentAtMinimal, 0);

    for (const effect of rows) {
        const { gpuMsBand, gpuMsSavedBand, scope } = effect.cost;
        assert.ok(
            Boolean(gpuMsBand) !== Boolean(gpuMsSavedBand),
            `${effect.id} prices either added time or removed time, never both`,
        );
        // Work that a substitution removes is not optional: it ships at every level.
        if (gpuMsSavedBand) {
            assert.ok(
                Object.values(effect.levels).every((mode) => mode === effect.levels.FULL),
                `${effect.id} saves time and can never be shed`,
            );
        }
        // `[0, ceiling]` is an honest noise-floor upper bound; a zero-width band is not a measurement.
        const [low, high] = gpuMsBand || gpuMsSavedBand;
        assert.ok(low >= 0 && high > low, `${effect.id} needs a measured band`);
        assert.ok(scope === 'own-pass' || scope === 'shared-scene-envelope', `${effect.id} needs a band scope`);
        assert.ok(effect.staticFallback && effect.canvas, `${effect.id} needs both fallbacks`);
    }
});

test('an unknown effect is a programming error, never a silent pass-through', () => {
    assert.throws(() => effectBudgetMode('window-spill', POST_FX_LEVELS.FULL), /unknown effect budget/);
});

function run(ladder, metrics, durationMs, startMs = 0, stepMs = 16, onFrame = null) {
    let now = startMs;
    const endMs = startMs + durationMs;
    while (now < endMs) {
        now = Math.min(endMs, now + stepMs);
        const state = ladder.update(
            typeof metrics === 'function' ? metrics(now) : metrics,
            now,
        );
        onFrame?.(state, now);
    }
    return now;
}

test('healthy timings keep the ladder at FULL', () => {
    const ladder = createPostFxLadder();
    run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 10_000);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('over-budget duration is measured in milliseconds at different frame rates', () => {
    for (const stepMs of [8, 20]) {
        const ladder = createPostFxLadder({ scoreWindowFrames: 1, uploadGraceMs: 0 });
        let now = run(ladder, { gpuMs: 6 }, 999, 0, stepMs);
        assert.equal(
            ladder.getLevel(),
            POST_FX_LEVELS.FULL,
            `must not degrade before 1000 ms at a ${stepMs} ms cadence`,
        );
        run(ladder, { gpuMs: 6 }, 25, now, stepMs);
        assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED);
    }
});

test('rolling median rejects a single over-budget frame', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 5,
        overBudgetMs: 100,
        uploadGraceMs: 0,
    });
    let now = run(ladder, { gpuMs: 1 }, 80);
    ladder.update({ gpuMs: 20 }, now += 16);
    assert.equal(ladder.getState().lastScore, 1);
    run(ladder, { gpuMs: 1 }, 200, now);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('persistent stalls walk the ladder to DISABLED by elapsed time', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        overBudgetMs: 100,
        uploadGraceMs: 0,
    });
    run(ladder, { gpuMs: 8 }, 400, 0, 10);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.DISABLED);
    assert.match(ladder.getState().lastDecisionReason, /^minimal-resident:/);
});

test('frame-gap stalls degrade even when instrumented timings look healthy', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        overBudgetMs: 1000,
        uploadGraceMs: 0,
    });
    run(ladder, { uploadMs: 0.5, gpuMs: 0.2, frameGapMs: 140 }, 1260, 0, 140);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.REDUCED);
    assert.equal(ladder.getState().lastDegradationReason, 'sustained-frameGapMs');
});

test('healthy recovery reaches FULL within ten seconds from MINIMAL', () => {
    const ladder = createPostFxLadder({ uploadIdleFullMs: 60_000 });
    ladder.reset(POST_FX_LEVELS.MINIMAL);
    const transitions = [];
    run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 10_000, 0, 16, (state, now) => {
        if (state.lastTransitionAtMs === now) transitions.push({ level: state.level, now });
    });
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
    assert.ok(transitions.some(item => item.level === POST_FX_LEVELS.FULL && item.now <= 10_000));
});

test('healthy hardware has at most one transition in the following minute', () => {
    const ladder = createPostFxLadder({ uploadIdleFullMs: 60_000 });
    ladder.reset(POST_FX_LEVELS.MINIMAL);
    let now = run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 10_000);
    let transitions = 0;
    let previousLevel = ladder.getLevel();
    let lastSpikeBucket = -1;
    run(
        ladder,
        sampleAt => {
            const spikeBucket = Math.floor((sampleAt - now) / 10_000);
            const spike = spikeBucket > lastSpikeBucket;
            lastSpikeBucket = Math.max(lastSpikeBucket, spikeBucket);
            return { uploadMs: 0.2, gpuMs: spike ? 12 : 1 };
        },
        60_000,
        now,
        16,
        state => {
            if (state.level !== previousLevel) transitions += 1;
            previousLevel = state.level;
        },
    );
    assert.ok(transitions <= 1, `expected at most one transition, received ${transitions}`);
});

test('a single over-threshold frame does not reset recovery', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        unhealthyResetFrames: 3,
        probeMs: 1000,
        uploadGraceMs: 0,
        uploadIdleFullMs: 60_000,
    });
    ladder.reset(POST_FX_LEVELS.REDUCED);
    let now = run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 800, 0, 100);
    const healthySinceMs = ladder.getState().healthySinceMs;
    ladder.update({ uploadMs: 0.2, gpuMs: 5 }, now += 100);
    assert.equal(ladder.getState().healthySinceMs, healthySinceMs);
    run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 200, now, 100);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('three consecutive over-threshold frames reset recovery', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        unhealthyResetFrames: 3,
        uploadGraceMs: 0,
        uploadIdleFullMs: 60_000,
    });
    ladder.reset(POST_FX_LEVELS.REDUCED);
    let now = run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 500, 0, 100);
    run(ladder, { uploadMs: 0.2, gpuMs: 3 }, 300, now, 100);
    assert.equal(ladder.getState().healthySinceMs, null);
});

test('recovery threshold is always 75 percent of the budget', () => {
    const ladder = createPostFxLadder({ budgetMs: 10, healthyMs: 1 });
    assert.equal(ladder.getState().options.healthyMs, 7.5);
});

test('upload-driven boot work is ignored for the three-second grace window', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        overBudgetMs: 100,
        uploadGraceMs: 3000,
    });
    run(ladder, { uploadMs: 20, gpuMs: 1 }, 2900, 0, 100);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
    assert.equal(ladder.getState().lastDecisionReason, 'upload-grace');
});

test('one second with no uploads snaps a healthy resident ladder back to FULL', () => {
    const ladder = createPostFxLadder();
    ladder.reset(POST_FX_LEVELS.MINIMAL);
    run(ladder, { uploadMs: 0, gpuMs: 1 }, 1100, 0, 100);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
    assert.equal(ladder.getState().lastDecisionReason, 'upload-idle-recovery');
});

test('override pins the effective level and survives metric churn', () => {
    const ladder = createPostFxLadder();
    ladder.setOverride(POST_FX_LEVELS.MINIMAL);
    run(ladder, { uploadMs: 20, gpuMs: 10 }, 5000);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.MINIMAL);
    ladder.setOverride(null);
    assert.equal(ladder.getLevel(), POST_FX_LEVELS.FULL);
});

test('timing assessment attributes upload, auxiliary upload, shader, GPU, and frame-gap cost', () => {
    const upload = assessPostFxTimings({
        uploadMs: 6,
        auxUploadMs: 1,
        setupCpuMs: 0.5,
        shaderCpuMs: 1,
        gpuMs: 2,
    });
    assert.equal(upload.driver, 'uploadMs');
    assert.equal(upload.score, 10.5);

    const stall = assessPostFxTimings({ uploadMs: 0.2, shaderCpuMs: 0.2, frameGapMs: 140 });
    assert.equal(stall.driver, 'frameGapMs');
    assert.equal(stall.score, 107);
});

test('degradation diagnostics retain the concrete bottleneck reason', () => {
    const ladder = createPostFxLadder({
        scoreWindowFrames: 1,
        overBudgetMs: 100,
        probeMs: 100,
        uploadGraceMs: 0,
        uploadIdleFullMs: 60_000,
    });
    run(ladder, { uploadMs: 0.2, gpuMs: 6 }, 120, 0, 20);
    const degraded = ladder.getState();
    assert.equal(degraded.level, POST_FX_LEVELS.REDUCED);
    assert.equal(degraded.lastDecisionReason, 'degrade:sustained-gpuMs');
    assert.equal(degraded.lastDegradationReason, 'sustained-gpuMs');
    assert.equal(degraded.lastTransitionMetrics.driver, 'gpuMs');

    run(ladder, { uploadMs: 0.2, gpuMs: 1 }, 120, 120, 20);
    const recovered = ladder.getState();
    assert.equal(recovered.level, POST_FX_LEVELS.FULL);
    assert.equal(recovered.lastDecisionReason, 'healthy-recovery');
    assert.equal(
        recovered.lastDegradationReason,
        'sustained-gpuMs',
        'recovery must not erase the last degradation cause',
    );
});
