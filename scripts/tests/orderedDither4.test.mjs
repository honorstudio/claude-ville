import assert from 'node:assert/strict';
import test from 'node:test';

import { orderedDither4 } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

// This is the GLSL mod implementation used by GpuWorldRenderer's wetness
// shader. JavaScript % is a remainder operation for negative values, whereas
// GLSL mod returns the non-negative modulo that the shader uses here.
function gpuWetnessDither4(x, y) {
    const px = Math.floor(Number(x) || 0);
    const py = Math.floor(Number(y) || 0);
    const sum = px + 2 * py;
    const modulo = sum - 4 * Math.floor(sum / 4);
    return modulo / 3;
}

test('orderedDither4 is deterministic for repeated coordinates', () => {
    const first = orderedDither4(-17.25, 29.75);
    assert.equal(orderedDither4(-17.25, 29.75), first);
    assert.equal(orderedDither4(-17.25, 29.75), first);
});

test('orderedDither4 produces every bucket in its four-cell pattern', () => {
    const values = [
        orderedDither4(0, 0),
        orderedDither4(1, 0),
        orderedDither4(0, 1),
        orderedDither4(1, 1),
    ];

    assert.deepEqual(values, [0, 1 / 3, 2 / 3, 1]);
    assert.deepEqual(
        [...new Set(values.map(value => Math.round(value * 3)))].sort((a, b) => a - b),
        [0, 1, 2, 3],
    );
});

test('orderedDither4 matches the GPU wetness shader formula', () => {
    const coordinates = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [12.9, 8.1],
        [-3.2, 4.8],
        [1_000_003.75, -2_000_001.25],
    ];

    for (const [x, y] of coordinates) {
        assert.equal(orderedDither4(x, y), gpuWetnessDither4(x, y), `formula mismatch at (${x}, ${y})`);
    }
});

test('orderedDither4 wraps negative and large coordinates predictably', () => {
    const coordinates = [
        [-1, 0],
        [0, -1],
        [-1, -1],
        [-1025, 2047],
        [4_294_967_297, -4_294_967_299],
        [1_000_000_001, 2_000_000_003],
    ];

    for (const [x, y] of coordinates) {
        const value = orderedDither4(x, y);
        assert.ok(value >= 0 && value <= 1, `bucket must stay normalized at (${x}, ${y})`);
        assert.equal(value, gpuWetnessDither4(x, y), `unexpected wrap at (${x}, ${y})`);
    }
    assert.equal(orderedDither4(-1, 0), orderedDither4(3, 0));
    assert.equal(orderedDither4(4_294_967_297, 0), orderedDither4(1, 0));
});
