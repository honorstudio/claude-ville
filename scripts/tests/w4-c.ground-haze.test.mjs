import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PRESSURE_LEVELS,
    PRESSURE_PROTECTED,
    PRESSURE_SHED_ORDER,
} from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import {
    weatherEmbellishmentAllowed,
    FOG_BAND_Y_RANGE,
} from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { SKY_WEATHER_PLATE_SPACE } from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';
import {
    HAZE_ALPHA_CAP,
    HAZE_FIELD_BYTES_PER_SAMPLE,
    HAZE_FIELD_SCALE,
    WETNESS_ATTACK_MS,
    WETNESS_RELEASE_MS,
    advanceSurfaceWetness,
    applySurfaceWetnessToReactions,
    collectDampMarks,
    collectHazeAnchors,
    collectRoadCarvePoints,
    dampMarkAlpha,
    dampMaterialMultiplier,
    hazeDensityAtWorld,
    hazeFieldCacheKey,
    hazeFieldMemoryBytes,
    hazeOccupancyAtWorld,
    hazePlanForPressure,
    isoFromTile,
    projectHazeField,
    projectWorldToScreen,
    sampleHazeField,
    shouldRebuildHazeField,
} from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';

const CHARACTER_MODE = '../../claudeville/src/presentation/character-mode/';

function readSource(file) {
    return readFileSync(new URL(CHARACTER_MODE + file, import.meta.url), 'utf8');
}

function waterAnchors(keys = ['2,2']) {
    return collectHazeAnchors({
        waterTiles: keys,
        lowlandPoints: [{ x: 40, y: 220 }],
    }).anchors;
}

test('haze field occupancy follows water and lowland world inputs, not screen position', () => {
    const anchors = waterAnchors(['2,2']);
    const water = isoFromTile(2, 2);
    const occupancyAtWater = hazeOccupancyAtWorld(water.x, water.y, { anchors });
    const occupancyFar = hazeOccupancyAtWorld(water.x + 800, water.y + 800, { anchors });
    assert.ok(occupancyAtWater > 0.8, 'water tile must seed the field');
    assert.ok(occupancyFar < 0.08, 'far land stays clear of water haze');
    const lowlandOccupancy = hazeOccupancyAtWorld(40, 220, { anchors });
    assert.ok(lowlandOccupancy > 0.5, 'lowland anchors must also seed the field');

    const camA = { x: 0, y: 0, zoom: 1 };
    const camB = { x: 300, y: 0, zoom: 1 };
    const viewport = { width: 400, height: 240 };
    const fieldA = projectHazeField({ anchors, camera: camA, viewport });
    const fieldB = projectHazeField({ anchors, camera: camB, viewport });
    const screenA = projectWorldToScreen(camA, water.x, water.y);
    const screenB = projectWorldToScreen(camB, water.x, water.y);
    assert.ok(sampleHazeField(fieldA, screenA.x, screenA.y) > 0.7);
    assert.ok(sampleHazeField(fieldB, screenB.x, screenB.y) > 0.7);
    assert.ok(
        sampleHazeField(fieldB, screenA.x, screenA.y) < sampleHazeField(fieldA, screenA.x, screenA.y) * 0.5,
        'a fixed screen pixel must not keep the haze when the camera pans',
    );
    assert.equal(hazeOccupancyAtWorld(water.x, water.y, { anchors }), occupancyAtWater);
});

test('ground haze alpha is capped', () => {
    const anchors = waterAnchors();
    const water = isoFromTile(2, 2);
    const density = hazeDensityAtWorld(water.x, water.y, { anchors, alphaCap: HAZE_ALPHA_CAP });
    assert.ok(
        density <= HAZE_ALPHA_CAP,
        `ground haze alpha exceeded the hard cap: actual alpha=${density}, cap=${HAZE_ALPHA_CAP}`,
    );
    assert.equal(HAZE_ALPHA_CAP, 0.16, 'documented ground haze alpha cap changed');
    assert.equal(
        density,
        HAZE_ALPHA_CAP,
        `maximum-density ground haze did not reach the cap: actual alpha=${density}, cap=${HAZE_ALPHA_CAP}`,
    );
});

test('roads and the focused subject receive carved openings', () => {
    const anchors = waterAnchors();
    const water = isoFromTile(2, 2);
    const open = hazeOccupancyAtWorld(water.x, water.y, { anchors });
    const roadCarved = hazeOccupancyAtWorld(water.x, water.y, {
        anchors,
        roads: [{ x: water.x, y: water.y }],
    });
    const subjectCarved = hazeOccupancyAtWorld(water.x, water.y, {
        anchors,
        focused: { x: water.x, y: water.y },
    });
    assert.ok(
        open > 0.8,
        `maximum-density haze sample was not dense enough to test carving: actual occupancy=${open}`,
    );
    assert.ok(
        roadCarved < open * 0.25,
        `road opening was not carved deeply enough: actual carve result=${roadCarved}, uncarved occupancy=${open}`,
    );
    assert.ok(
        subjectCarved < open * 0.25,
        `focused-subject opening was not carved deeply enough: actual carve result=${subjectCarved}, uncarved occupancy=${open}`,
    );

    const roads = collectRoadCarvePoints({
        pathTiles: ['8,8', '9,8', '10,8', '11,8'],
        stride: 1,
    });
    assert.ok(
        roads.some((point) => point.key === '8,8'),
        `road carve points did not include the authored route tile: actual carve points=${JSON.stringify(roads)}`,
    );
});

test('surface wetness rises under precipitation and decays deterministically to zero', () => {
    let wetness = 0;
    wetness = advanceSurfaceWetness(wetness, {
        precipitation: 1,
        dt: WETNESS_ATTACK_MS,
        weatherType: 'rain',
    });
    assert.ok(wetness >= 0.99);

    wetness = advanceSurfaceWetness(wetness, {
        precipitation: 0,
        dt: WETNESS_RELEASE_MS,
        weatherType: 'clear',
    });
    assert.ok(wetness <= 1e-9);

    wetness = advanceSurfaceWetness(0.4, {
        precipitation: 0,
        dt: WETNESS_RELEASE_MS,
        weatherType: 'clear',
    });
    assert.equal(wetness, 0);

    const reactions = applySurfaceWetnessToReactions({ puddleAlpha: 0, roofGlintAlpha: 0 }, 0.8);
    assert.equal(reactions.surfaceWetness, 0.8);
    assert.ok(reactions.puddleAlpha > 0);
    assert.ok(reactions.roofGlintAlpha > 0);
});

test('fire and emissive materials receive exactly zero wetness response', () => {
    assert.equal(dampMaterialMultiplier('fire'), 0);
    assert.equal(dampMaterialMultiplier('emissive'), 0);
    assert.equal(dampMarkAlpha(1, 'fire', 1), 0);
    assert.equal(dampMarkAlpha(1, 'emissive', 1), 0);
    const marks = collectDampMarks({
        roofs: [{ x: 4, y: 8, seed: 1 }],
        wetness: 1,
        layer: 'all',
    });
    assert.ok(marks.every((mark) => mark.material !== 'fire' && mark.material !== 'emissive'));
    assert.ok(dampMaterialMultiplier('roof') > 0);
    assert.ok(dampMaterialMultiplier('dock') > 0);
    assert.ok(dampMaterialMultiplier('stone') > 0);
    assert.ok(dampMaterialMultiplier('road') > 0);
});

test('pressure rung 1 sheds haze density and detail before any semantic element', () => {
    assert.equal(PRESSURE_SHED_ORDER[0], 'ambient-weather-embellishment');
    assert.ok(!PRESSURE_PROTECTED.includes('ambient-weather-embellishment'));
    assert.equal(weatherEmbellishmentAllowed(PRESSURE_LEVELS.WEATHER_FAUNA), false);
    const full = hazePlanForPressure(PRESSURE_LEVELS.FULL, 1);
    const shed = hazePlanForPressure(PRESSURE_LEVELS.WEATHER_FAUNA, 1);
    assert.ok(shed.density < full.density);
    assert.ok(shed.detail < full.detail);
    assert.ok(shed.fieldScale < full.fieldScale);
    assert.ok(shed.density < 1);
    assert.equal(shed.detail, 0);
});

test('reduced motion yields a static field with no rebuild', () => {
    const reduced = hazePlanForPressure(0, 0);
    assert.equal(reduced.static, true);
    assert.equal(reduced.rebuild, false);
    const movingKey = hazeFieldCacheKey({
        camera: { x: 0, y: 0, zoom: 1 },
        viewport: { width: 1280, height: 720 },
        atmosphereBucket: 'dawn',
    });
    const pannedKey = hazeFieldCacheKey({
        camera: { x: 40, y: 0, zoom: 1 },
        viewport: { width: 1280, height: 720 },
        atmosphereBucket: 'dawn',
    });
    assert.notEqual(movingKey, pannedKey);
    assert.equal(shouldRebuildHazeField(movingKey, pannedKey, { motionScale: 0, hasField: true }), false);
    assert.equal(shouldRebuildHazeField(movingKey, pannedKey, { motionScale: 1, hasField: true }), true);
    assert.equal(shouldRebuildHazeField(null, movingKey, { motionScale: 0, hasField: false }), true);
});

test('haze field is quarter-resolution at one byte per sample', () => {
    assert.equal(HAZE_FIELD_SCALE, 0.25);
    assert.equal(HAZE_FIELD_BYTES_PER_SAMPLE, 1);
    assert.equal(hazeFieldMemoryBytes(1280, 720), 320 * 180);
    const field = projectHazeField({
        anchors: waterAnchors(),
        camera: { x: 0, y: 0, zoom: 1 },
        viewport: { width: 1280, height: 720 },
    });
    assert.equal(field.width, 320);
    assert.equal(field.height, 180);
    assert.equal(field.bytes, 320 * 180);
    assert.equal(field.samples.length, 320 * 180);
});

test('no blur filter is introduced and haze draws in the ground stage, not the sky canopy', () => {
    const worldSource = readSource('WorldFrameRenderer.js');
    const skySource = readSource('SkyRenderer.js');
    const weatherSource = readSource('WeatherRenderer.js');
    const isoSource = readSource('IsometricRenderer.js');

    for (const [name, source] of [
        ['WorldFrameRenderer.js', worldSource],
        ['SkyRenderer.js', skySource],
        ['WeatherRenderer.js', weatherSource],
        ['IsometricRenderer.js', isoSource],
    ]) {
        assert.doesNotMatch(source, /ctx\.filter/, name);
        assert.doesNotMatch(source, /filter\s*[:=]\s*['"`]?blur/i, name);
    }

    const renderFn = worldSource.slice(
        worldSource.indexOf('export function renderWorldFrame'),
        worldSource.indexOf('function drawPrimaryMarksPostAtmosphere'),
    );
    assert.match(renderFn, /drawGroundFog\(/);
    assert.match(renderFn, /markFrameTiming\(frameTimer, 'ground-atmosphere'\)/);
    assert.ok(renderFn.indexOf('drawGroundFog') < renderFn.indexOf('_drawSkyCanopy'));
    assert.ok(renderFn.indexOf("'ground-atmosphere'") < renderFn.indexOf("'sky-canopy'"));
    assert.match(worldSource, /function drawHazeField/);
    assert.match(worldSource, /function ensureHazeField/);
    assert.match(worldSource, /drawPrimaryMarksPostAtmosphere/);

    assert.equal(SKY_WEATHER_PLATE_SPACE, 'vertical-canvas');
    assert.match(skySource, /createLinearGradient\(0, 0, 0, canvas\.height\)/);
    assert.ok(FOG_BAND_Y_RANGE.max <= 0.42);
    assert.ok(FOG_BAND_Y_RANGE.min >= 0.08);
    assert.match(weatherSource, /FOG_BAND_Y_RANGE/);
});
