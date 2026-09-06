import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FRAME_PRESSURE_OPTIONS,
    PRESSURE_LEVELS,
    PRESSURE_PROTECTED,
    PRESSURE_SHED_ORDER,
    MarkGovernor,
    MarkTier,
    advanceFramePressure,
    appOwnedCostMs,
    createFramePressureState,
    framePressureSnapshot,
    markPolicyFor,
    ornamentPlan,
    resetFramePressureState,
    resolveCalmGate,
    sampleFramePressure,
    shedSetForLevel,
} from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import {
    ParticleSystem,
    particleRole,
    particleSpawnAllowed,
} from '../../claudeville/src/presentation/character-mode/ParticleSystem.js';
import {
    weatherEmbellishmentAllowed,
    weatherPassKeepsPrecipitation,
} from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import {
    allowAmbientMeteor,
    liveTwinkleBudget,
} from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';

const ALL_RUNGS = [0, 1, 2, 3];
const STEP_MS = 16;

function runPressure(state, inputs, frames, startMs = 0, stepMs = STEP_MS, options) {
    let current = state;
    let now = startMs;
    for (let i = 0; i < frames; i++) {
        now += stepMs;
        current = advanceFramePressure(current, inputs, now, options);
    }
    return { state: current, now };
}

function heavyApp(overrides = {}) {
    return {
        appUpdateP95: 12,
        appRenderP95: 10,
        uploadP95: 0,
        gpuMs: 1,
        hostGapP95: 2,
        ...overrides,
    };
}

function lightApp(overrides = {}) {
    return {
        appUpdateP95: 1.1,
        appRenderP95: 1.5,
        uploadP95: 0,
        gpuMs: 0.4,
        hostGapP95: 40,
        rendererCostMs: 2.6,
        ...overrides,
    };
}

test('rising app-owned cost walks the pressure rung one step at a time', () => {
    const options = FRAME_PRESSURE_OPTIONS;
    let { state, now } = runPressure(createFramePressureState(), heavyApp(), options.overBudgetFrames - 1);
    assert.equal(state.level, PRESSURE_LEVELS.FULL, 'must not degrade before the 12-frame hold');

    ({ state, now } = runPressure(state, heavyApp(), 1, now));
    assert.equal(state.level, PRESSURE_LEVELS.WEATHER_FAUNA);

    ({ state, now } = runPressure(state, heavyApp(), options.overBudgetFrames, now));
    assert.equal(state.level, PRESSURE_LEVELS.PARTICLES);

    ({ state, now } = runPressure(state, heavyApp(), options.overBudgetFrames, now));
    assert.equal(state.level, PRESSURE_LEVELS.GLYPHS);

    const snapshot = framePressureSnapshot(state, heavyApp());
    assert.equal(snapshot.level, 3);
    assert.equal(snapshot.appUpdateP95, 12);
    assert.equal(snapshot.appRenderP95, 10);
    assert.equal(snapshot.uploadP95, 0);
    assert.equal(snapshot.gpuMs, 1);
    assert.equal(snapshot.hostGapP95, 2);
    assert.ok(snapshot.dwellMs >= 0);
});

test('a large host gap with low app-owned cost does not raise the rung', () => {
    const inputs = lightApp({ hostGapP95: 140, rendererCostMs: 2.6 });
    assert.ok(appOwnedCostMs(inputs) < FRAME_PRESSURE_OPTIONS.budgetMs);
    assert.ok(inputs.hostGapP95 > 35);

    const { state } = runPressure(
        createFramePressureState(),
        inputs,
        FRAME_PRESSURE_OPTIONS.overBudgetFrames * 4,
        0,
        140,
    );
    assert.equal(state.level, PRESSURE_LEVELS.FULL);
    assert.equal(framePressureSnapshot(state, inputs).hostGapP95, 140);
});

test('host gap is evidence only even when it is the only large number present', () => {
    const inputs = {
        appUpdateP95: 0.4,
        appRenderP95: 0.8,
        uploadP95: null,
        gpuMs: null,
        hostGapP95: 90,
    };
    assert.ok(Math.abs(appOwnedCostMs(inputs) - 1.2) < 1e-9);
    const { state } = runPressure(createFramePressureState(), inputs, 40);
    assert.equal(state.level, 0);
});

test('hysteresis at a budget boundary does not oscillate', () => {
    const options = { ...FRAME_PRESSURE_OPTIONS, dwellMs: 0 };
    let state = createFramePressureState(options);
    let now = 0;
    const over = { appUpdateP95: FRAME_PRESSURE_OPTIONS.budgetMs + 0.2, appRenderP95: 0 };
    const under = { appUpdateP95: FRAME_PRESSURE_OPTIONS.budgetMs - 0.2, appRenderP95: 0 };

    for (let i = 0; i < 40; i++) {
        now += STEP_MS;
        state = advanceFramePressure(state, i % 2 === 0 ? over : under, now, options);
    }
    assert.equal(state.level, PRESSURE_LEVELS.FULL);
    assert.ok(state.overBudgetFrames < FRAME_PRESSURE_OPTIONS.overBudgetFrames);
});

test('twelve over-budget frames with one healthy probe reset stay on the current rung', () => {
    const options = FRAME_PRESSURE_OPTIONS;
    let { state, now } = runPressure(createFramePressureState(), heavyApp(), options.overBudgetFrames - 1);
    ({ state, now } = runPressure(state, lightApp(), 1, now));
    ({ state, now } = runPressure(state, heavyApp(), options.overBudgetFrames - 1, now));
    assert.equal(state.level, PRESSURE_LEVELS.FULL);
});

test('minimum dwell blocks a rung change in both directions', () => {
    const options = {
        ...FRAME_PRESSURE_OPTIONS,
        overBudgetFrames: 1,
        probeMs: 40,
        dwellMs: 500,
        budgetMs: 8,
        healthyMs: 5,
    };
    let state = createFramePressureState(options);
    state = advanceFramePressure(state, heavyApp(), 16, options);
    assert.equal(state.level, 0, 'dwell on rung 0 has not elapsed');

    state = advanceFramePressure(state, heavyApp(), 500, options);
    assert.equal(state.level, 1);
    assert.equal(framePressureSnapshot(state).dwellMs, 0);

    state = advanceFramePressure(state, heavyApp(), 516, options);
    assert.equal(state.level, 1, 'dwell must hold before climbing again');

    state = advanceFramePressure(state, heavyApp(), 1000, options);
    assert.equal(state.level, 2);

    state = advanceFramePressure(state, lightApp(), 1040, options);
    assert.equal(state.level, 2, 'healthy probe plus dwell must both elapse before recovery');

    state = advanceFramePressure(state, lightApp(), 1500, options);
    assert.equal(state.level, 1, 'recovery drops exactly one rung');
});

test('recovery is gradual through the healthy-probe window', () => {
    const options = {
        ...FRAME_PRESSURE_OPTIONS,
        dwellMs: 0,
        probeMs: 100,
    };
    let { state, now } = runPressure(
        createFramePressureState(options),
        heavyApp(),
        options.overBudgetFrames * 3,
        0,
        STEP_MS,
        options,
    );
    assert.equal(state.level, PRESSURE_LEVELS.GLYPHS);

    ({ state, now } = runPressure(state, lightApp(), 5, now, STEP_MS, options));
    assert.equal(state.level, PRESSURE_LEVELS.GLYPHS, 'still inside the probe window');

    const needed = Math.ceil(options.probeMs / STEP_MS) + 1;
    ({ state, now } = runPressure(state, lightApp(), needed, now, STEP_MS, options));
    assert.equal(state.level, PRESSURE_LEVELS.PARTICLES);

    ({ state, now } = runPressure(state, lightApp(), needed, now, STEP_MS, options));
    assert.equal(state.level, PRESSURE_LEVELS.WEATHER_FAUNA);

    ({ state, now } = runPressure(state, lightApp(), needed, now, STEP_MS, options));
    assert.equal(state.level, PRESSURE_LEVELS.FULL);
});

test('sampleFramePressure prefers app attribution from frameHealth and ignores host gap', () => {
    resetFramePressureState();
    const previousWindow = globalThis.window;
    globalThis.window = {
        __claudeVillePerf: {
            frameHealth() {
                return {
                    p95AppUpdateMs: 1.2,
                    p95AppRenderMs: 1.4,
                    p95HostGapMs: 80,
                    gpuMs: 0.3,
                    attribution: { rendererCostMs: 2.6 },
                };
            },
        },
    };
    try {
        let snapshot = null;
        for (let i = 1; i <= 20; i++) {
            snapshot = sampleFramePressure(i * 16);
        }
        assert.equal(snapshot.level, 0);
        assert.equal(snapshot.hostGapP95, 80);
        assert.equal(snapshot.appUpdateP95, 1.2);
        assert.equal(snapshot.appRenderP95, 1.4);
        assert.equal(snapshot.gpuMs, 0.3);
    } finally {
        resetFramePressureState();
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

for (const level of ALL_RUNGS) {
    test(`rung ${level} sheds in declared order and never sheds primary meaning`, () => {
        const shed = shedSetForLevel(level);
        // Rung 1 sheds the first two named actuators together.
        const combined = PRESSURE_SHED_ORDER.slice(0, level === 0 ? 0 : level + 1);
        assert.deepEqual(shed, combined);
        for (const protectedName of PRESSURE_PROTECTED) {
            assert.equal(shed.includes(protectedName), false, `${protectedName} must survive rung ${level}`);
        }
        assert.equal(shed.includes('postfx-ladder'), false);
        assert.equal(shed.includes('primary-marks'), false);
        assert.equal(shed.includes('canvas-fallback'), false);
    });
}

test('declared shed order is weather+fauna, then ambient particles, then secondary glyphs', () => {
    assert.deepEqual(PRESSURE_SHED_ORDER, [
        'ambient-weather-embellishment',
        'fauna-cadence',
        'ambient-particles',
        'secondary-glyphs-glows',
    ]);
    assert.deepEqual(shedSetForLevel(1), [
        'ambient-weather-embellishment',
        'fauna-cadence',
    ]);
    assert.deepEqual(shedSetForLevel(2), [
        'ambient-weather-embellishment',
        'fauna-cadence',
        'ambient-particles',
    ]);
    assert.deepEqual(shedSetForLevel(3), [
        'ambient-weather-embellishment',
        'fauna-cadence',
        'ambient-particles',
        'secondary-glyphs-glows',
    ]);
    assert.equal(weatherEmbellishmentAllowed(0), true);
    assert.equal(weatherEmbellishmentAllowed(1), false);
    assert.equal(weatherPassKeepsPrecipitation(3), true);
});

test('actuators honor the shed order as the rung rises', () => {
    const fauna = 'butterfly';
    const ambient = 'sparkle';
    const semantic = 'forgeEmber';
    assert.equal(particleRole(fauna), 'fauna');
    assert.equal(particleRole(ambient), 'ambient');
    assert.equal(particleRole(semantic), 'semantic');

    assert.equal(particleSpawnAllowed(fauna, { level: 0 }), true);
    assert.equal(particleSpawnAllowed(fauna, { level: 1 }), false);
    assert.equal(particleSpawnAllowed(ambient, { level: 1 }), true);
    assert.equal(particleSpawnAllowed(ambient, { level: 2 }), false);
    assert.equal(particleSpawnAllowed(semantic, { level: 3 }), true);

    const system = new ParticleSystem();
    system.spawn(fauna, 0, 0, 4, { pressureLevel: 1 });
    assert.equal(system.particles.length, 0);
    system.spawn(ambient, 0, 0, 3, { pressureLevel: 1 });
    assert.ok(system.particles.length > 0);
    system.clear();
    system.spawn(ambient, 0, 0, 3, { pressureLevel: 2 });
    assert.equal(system.particles.length, 0);
    system.spawn(semantic, 0, 0, 2, { pressureLevel: 3 });
    assert.equal(system.particles.length, 2);

    for (const level of ALL_RUNGS) {
        const governor = new MarkGovernor();
        governor.beginFrame({ pressureLevel: level, motionScale: 1 });
        for (let i = 0; i < 24; i++) {
            const admitted = governor.admit(MarkTier.PRIMARY, i * 10, 0);
            assert.equal(admitted.draw, true);
            assert.equal(admitted.alpha, 1);
        }
        const policy = markPolicyFor(MarkTier.PRIMARY, level);
        assert.equal(policy.soft, Infinity);
        assert.equal(policy.hard, Infinity);
        const ambientMark = governor.admit(MarkTier.AMBIENT, 4, 4);
        if (level >= PRESSURE_LEVELS.GLYPHS) {
            assert.equal(ambientMark.draw, false);
        } else {
            assert.equal(ambientMark.draw, true);
        }
    }
});

test('calm gate suppresses only named ornament and never weather, attention, or event cues', () => {
    assert.equal(resolveCalmGate({ weatherType: 'clear', attention: false, recentEvent: false, override: null }), true);
    assert.equal(resolveCalmGate({ weatherType: 'rain', attention: false, recentEvent: false, override: null }), false);
    assert.equal(resolveCalmGate({ weatherType: 'clear', attention: true, recentEvent: false, override: null }), false);
    assert.equal(resolveCalmGate({ weatherType: 'clear', attention: false, recentEvent: true, override: null }), false);
    assert.equal(resolveCalmGate({ weatherType: 'clear', attention: false, recentEvent: false, override: 'full' }), false);
    assert.equal(resolveCalmGate({ weatherType: 'storm', attention: true, recentEvent: true, override: 'quiet' }), true);

    const quiet = ornamentPlan({ calm: true, level: 0, motionScale: 1 });
    assert.equal(quiet.ambientMeteors, 'off');
    assert.equal(quiet.liveTwinkle, 'sparse');
    assert.equal(quiet.ambientSparkle, 'off');
    assert.equal(quiet.weather, 'on');
    assert.equal(quiet.attentionCues, 'on');
    assert.equal(quiet.eventCues, 'on');
    assert.equal(quiet.staticStars, 'on');
    assert.equal(quiet.lanterns, 'on');
    assert.equal(quiet.completionRewards, 'on');
    assert.equal(quiet.primaryMarks, 'on');
    assert.equal(quiet.canvasFallback, 'on');

    const storm = ornamentPlan({ calm: false, level: 0, motionScale: 1 });
    assert.equal(storm.ambientMeteors, 'on');
    assert.equal(storm.liveTwinkle, 'on');
    assert.equal(storm.weather, 'on');

    assert.equal(allowAmbientMeteor({ calm: true, motionScale: 1 }), false);
    assert.equal(allowAmbientMeteor({ calm: false, motionScale: 1 }), true);
    assert.equal(liveTwinkleBudget({ calm: true, motionScale: 1 }).count < liveTwinkleBudget({
        calm: false,
        motionScale: 1,
    }).count, true);
    assert.ok(liveTwinkleBudget({ calm: true, motionScale: 1 }).rateScale < 1);

    const system = new ParticleSystem();
    system.spawn('sparkle', 0, 0, 4, { pressureLevel: 0, calm: true });
    assert.equal(system.particles.length, 0);
    system.spawn('forgeEmber', 0, 0, 2, { pressureLevel: 0, calm: true });
    assert.equal(system.particles.length, 2);
    system.clear();
    system.spawn('rainSplash', 0, 0, 2, { pressureLevel: 0, calm: true });
    assert.equal(system.particles.length, 2);
});

test('visual-QA override can force full or quiet ambience without changing the default', () => {
    assert.equal(resolveCalmGate({ weatherType: 'clear', attention: false, recentEvent: false, override: null }), true);
    const previous = globalThis.window;
    globalThis.window = { __claudeVillePerf: {}, location: { search: '' } };
    try {
        assert.equal(resolveCalmGate({ weatherType: 'clear' }), true);
        globalThis.window.__claudeVillePerf.calmGate = 'full';
        assert.equal(resolveCalmGate({ weatherType: 'clear' }), false);
        globalThis.window.__claudeVillePerf.calmGate = 'quiet';
        assert.equal(resolveCalmGate({ weatherType: 'storm', attention: true }), true);
        globalThis.window.__claudeVillePerf.calmGate = undefined;
        globalThis.window.location.search = '?calmGate=full';
        assert.equal(resolveCalmGate({ weatherType: 'clear' }), false);
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
});

for (const level of ALL_RUNGS) {
    test(`reduced-motion output stays static at rung ${level}`, () => {
        const plan = ornamentPlan({ level, motionScale: 0, calm: false });
        const animated = [
            'ambientWeatherEmbellishment',
            'faunaCadence',
            'ambientParticles',
            'secondaryGlyphsGlows',
            'weather',
            'attentionCues',
            'eventCues',
            'ambientMeteors',
            'liveTwinkle',
            'ambientSparkle',
            'primaryMarks',
            'completionRewards',
        ];
        for (const key of animated) {
            assert.ok(plan[key] === 'static' || plan[key] === 'off', `${key} must not animate at rung ${level}`);
            assert.notEqual(plan[key], 'on');
            assert.notEqual(plan[key], 'sparse');
        }
        assert.equal(plan.canvasFallback, 'on');
        assert.equal(plan.staticStars, 'on');
        assert.equal(plan.lanterns, 'on');
        assert.equal(weatherPassKeepsPrecipitation(level), true);

        const system = new ParticleSystem();
        system.setMotionEnabled(false);
        system.spawn('butterfly', 0, 0, 4, { pressureLevel: level });
        system.spawn('sparkle', 0, 0, 4, { pressureLevel: level });
        system.spawn('forgeEmber', 0, 0, 4, { pressureLevel: level });
        assert.equal(system.particles.length, 0);

        const governor = new MarkGovernor();
        governor.beginFrame({ pressureLevel: level, motionScale: 0 });
        const primary = governor.admit(MarkTier.PRIMARY, 0, 0);
        assert.equal(primary.draw, true);
        assert.equal(primary.alpha, 1);

        assert.equal(liveTwinkleBudget({ calm: false, motionScale: 0 }).count, 0);
        assert.equal(allowAmbientMeteor({ calm: false, motionScale: 0 }), false);
        assert.equal(particleSpawnAllowed('forgeEmber', { level, motionEnabled: false }), false);
    });
}
