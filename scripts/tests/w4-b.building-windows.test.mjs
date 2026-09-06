import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BUILDING_VISUAL_REGISTRY,
    getBuildingDoorSpillDescriptor,
    getBuildingWindowRects,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';

const EXISTING_WINDOW_RECTS = {
    command: [
        { at: [80, 127], w: 7, h: 10 },
        { at: [210, 120], w: 7, h: 10 },
        { at: [150, 90], w: 8, h: 8, shape: 'ellipse' },
    ],
    taskboard: [
        { at: [48, 62], w: 6, h: 8, shape: 'ellipse' },
        { at: [182, 62], w: 6, h: 8, shape: 'ellipse' },
    ],
    forge: [
        { at: [157, 143], w: 9, h: 10 },
        { at: [172, 143], w: 9, h: 10 },
    ],
    archive: [
        { at: [139, 130], w: 5, h: 9 },
        { at: [204, 130], w: 5, h: 9 },
    ],
    observatory: [
        { at: [74, 182], w: 13, h: 27 },
        { at: [169, 149], w: 20, h: 29 },
        { at: [137, 203], w: 13, h: 20 },
    ],
    watchtower: [
        { at: [145, 168], w: 9, h: 13 },
        { at: [153, 219], w: 9, h: 13 },
        { at: [140, 270], w: 9, h: 13 },
    ],
    harbor: [
        { at: [155, 70], w: 4, h: 8 },
        { at: [181, 80], w: 4, h: 8 },
        { at: [195, 89], w: 8, h: 7 },
        { at: [222, 90], w: 4, h: 7 },
        { at: [102, 110], w: 4, h: 9 },
        { at: [179, 107], w: 4, h: 7 },
        { at: [232, 110], w: 4, h: 8 },
        { at: [122, 129], w: 4, h: 8 },
        { at: [180, 136], w: 4, h: 8 },
        { at: [167, 148], w: 4, h: 8 },
        { at: [183, 155], w: 4, h: 8 },
        { at: [190, 158], w: 4, h: 7 },
    ],
};

test('mine and portal windows stay inside their native sprite dimensions', () => {
    for (const type of ['mine', 'portal']) {
        const visual = BUILDING_VISUAL_REGISTRY[type];
        assert.ok(visual.windowRects.length >= 2 && visual.windowRects.length <= 4);
        for (const rect of visual.windowRects) {
            const [x, y] = rect.at;
            assert.ok(x - rect.w / 2 >= 0, `${type} window crosses the left edge`);
            assert.ok(x + rect.w / 2 <= visual.nativeSize.w, `${type} window crosses the right edge`);
            assert.ok(y - rect.h / 2 >= 0, `${type} window crosses the top edge`);
            assert.ok(y + rect.h / 2 <= visual.nativeSize.h, `${type} window crosses the bottom edge`);
        }
    }
});

test('existing calibrated building windows remain unchanged', () => {
    for (const [type, rects] of Object.entries(EXISTING_WINDOW_RECTS)) {
        assert.deepEqual(BUILDING_VISUAL_REGISTRY[type].windowRects, rects, type);
    }
});

test('calibrated windows never select the legacy radial warmth fallback', () => {
    for (const [type, visual] of Object.entries(BUILDING_VISUAL_REGISTRY)) {
        assert.ok(visual.windowRects?.length, `${type} has no calibrated windows`);
        assert.strictEqual(getBuildingWindowRects(type), visual.windowRects, type);
    }
});

test('door spill is zero when empty and scales monotonically with occupancy', () => {
    for (const type of ['mine', 'portal']) {
        const alphaAt = (occupancy) => getBuildingDoorSpillDescriptor(type, {
            occupancy,
            beaconIntensity: 0.8,
            weatherWetness: 0.6,
        }).alpha;
        const samples = [0, 0.25, 0.5, 0.75, 1].map(alphaAt);
        assert.equal(samples[0], 0, type);
        for (let i = 1; i < samples.length; i++) {
            assert.ok(samples[i] >= samples[i - 1], `${type} spill fell at sample ${i}`);
        }
    }
});

test('reduced motion keeps door spill alpha static with no animation phase', () => {
    const options = {
        occupancy: 0.7,
        beaconIntensity: 0.8,
        weatherWetness: 0.4,
        atmosphereWarmth: 0.9,
    };
    const descriptor = getBuildingDoorSpillDescriptor('portal', options);
    const reducedMotion = getBuildingDoorSpillDescriptor('portal', {
        ...options,
        reducedMotion: true,
    });
    assert.deepEqual(reducedMotion, descriptor);
    assert.equal(reducedMotion.staticAlpha, true);
    assert.equal('phase' in reducedMotion, false);
    assert.equal('pulse' in reducedMotion, false);
});

test('portal rune light stays distinct from mine fire', () => {
    assert.notEqual(BUILDING_VISUAL_REGISTRY.portal.windowColor, BUILDING_VISUAL_REGISTRY.mine.windowColor);
    assert.notEqual(BUILDING_VISUAL_REGISTRY.portal.doorSpill.color, BUILDING_VISUAL_REGISTRY.mine.doorSpill.color);
});
