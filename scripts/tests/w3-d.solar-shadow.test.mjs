import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DISTRICT_LIGHTING_BANDS,
    solarVectorForMinute,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

const SEASONS = ['winter', 'spring', 'summer', 'autumn'];
const PHASE_BOUNDARIES = {
    winter: [7 * 60 + 40, 16 * 60 + 35],
    spring: [7 * 60, 17 * 60 + 30],
    summer: [6 * 60 + 20, 18 * 60 + 25],
    autumn: [7 * 60, 17 * 60 + 30],
};

function angularDistance(a, b) {
    return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

test('solar shadow direction stays continuous across dawn/day and day/dusk boundaries', () => {
    const epsilon = 0.02;
    for (const season of SEASONS) {
        for (const boundary of PHASE_BOUNDARIES[season]) {
            for (let minute = boundary - 2; minute <= boundary + 2; minute++) {
                const current = solarVectorForMinute(minute, season);
                const next = solarVectorForMinute(minute + 1, season);
                assert.ok(
                    angularDistance(current.shadowAngleRad, next.shadowAngleRad) < epsilon,
                    `${season} jumps at minute ${minute}`,
                );
            }
        }
    }
});

test('solar angles and vectors are finite for every minute and season', () => {
    for (const season of SEASONS) {
        for (let minute = 0; minute < 24 * 60; minute++) {
            const solar = solarVectorForMinute(minute, season);
            assert.ok(Number.isFinite(solar.shadowAngleRad), `${season} angle at ${minute}`);
            assert.ok(Number.isFinite(solar.sunDirIso.x), `${season} vector x at ${minute}`);
            assert.ok(Number.isFinite(solar.sunDirIso.y), `${season} vector y at ${minute}`);
            const oppositeAngle = Math.atan2(-solar.sunDirIso.y, -solar.sunDirIso.x);
            assert.ok(angularDistance(oppositeAngle, solar.shadowAngleRad) < 1e-12);
        }
    }
});

test('daylight elevation rises to solar noon and falls toward sunset', () => {
    const epsilon = 1e-12;
    for (const season of SEASONS) {
        const reference = solarVectorForMinute(12 * 60, season);
        let previous = solarVectorForMinute(reference.sunriseMinute, season).elevation;
        assert.ok(Math.abs(previous) < epsilon, `${season} sunrise elevation`);
        for (let minute = reference.sunriseMinute + 1; minute <= Math.floor(reference.solarNoonMinute); minute++) {
            const elevation = solarVectorForMinute(minute, season).elevation;
            assert.ok(elevation + epsilon >= previous, `${season} elevation fell before noon at ${minute}`);
            previous = elevation;
        }

        previous = solarVectorForMinute(Math.ceil(reference.solarNoonMinute), season).elevation;
        for (let minute = Math.ceil(reference.solarNoonMinute) + 1; minute <= reference.sunsetMinute; minute++) {
            const elevation = solarVectorForMinute(minute, season).elevation;
            assert.ok(elevation <= previous + epsilon, `${season} elevation rose after noon at ${minute}`);
            previous = elevation;
        }
        assert.ok(
            Math.abs(solarVectorForMinute(reference.sunsetMinute, season).elevation) < epsilon,
            `${season} sunset elevation`,
        );
        assert.ok(
            Math.abs(solarVectorForMinute(reference.solarNoonMinute, season).elevation - 1) < epsilon,
            `${season} noon elevation`,
        );
    }
});

test('seasonal phase tables place winter and summer sunrise differently', () => {
    const winter = solarVectorForMinute(12 * 60, 'winter');
    const summer = solarVectorForMinute(12 * 60, 'summer');
    assert.ok(winter.sunriseMinute > summer.sunriseMinute);
    assert.notEqual(winter.sunriseMinute, summer.sunriseMinute);
});

test('solar noon preserves the authored upper-left shadow convention', () => {
    const tolerance = 1e-9;
    for (const season of SEASONS) {
        const reference = solarVectorForMinute(12 * 60, season);
        const noon = solarVectorForMinute(reference.solarNoonMinute, season);
        assert.ok(Math.abs(noon.shadowAngleRad - 0.28) < tolerance, season);
        assert.ok(noon.sunDirIso.x < 0 && noon.sunDirIso.y < 0, `${season} noon sun must remain upper-left`);
    }
});

test('directional lighting retains the four authored response bands', () => {
    assert.deepEqual([...DISTRICT_LIGHTING_BANDS], [0.72, 0.86, 1, 1.12]);
});
