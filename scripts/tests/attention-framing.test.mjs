import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAttentionFrame } from '../../claudeville/src/presentation/character-mode/AttentionFraming.js';

const candidates = Array.from({ length: 9 }, (_, i) => ({
    id: `wait-${i}`, x: i * 240, y: (i % 3) * 180,
    awaitingSince: i === 0 ? null : 1000 + i,
    bounds: { minX: i * 240 - 40, maxX: i * 240 + 40, minY: (i % 3) * 180 - 100, maxY: (i % 3) * 180 + 20 },
}));

test('nine spread decisions are all included when geometry permits, unknown wait age last', () => {
    const frame = fitAttentionFrame(candidates, { width: 2400, height: 1000 });
    assert.equal(frame.included.length, 9);
    assert.deepEqual(frame.excluded, []);
    assert.equal(frame.included[0], 'wait-1');
    assert.equal(frame.included.at(-1), 'wait-0');
});

test('minimum-tier no-fit frame reports exact exclusions and centers the oldest decision', () => {
    const frame = fitAttentionFrame(candidates, { width: 600, height: 600 });
    assert.equal(frame.zoom, 1);
    assert.equal(frame.bias, 'center');
    assert.deepEqual(frame.included, ['wait-1', 'wait-2', 'wait-0']);
    assert.deepEqual(frame.excluded, ['wait-3', 'wait-4', 'wait-5', 'wait-6', 'wait-7', 'wait-8']);
});

test('thirds never sacrifice a fitting padded body or bubble', () => {
    const frame = fitAttentionFrame([
        { id: 'old', awaitingSince: 1, bounds: { minX: 0, maxX: 80, minY: 0, maxY: 60 } },
        { id: 'new', awaitingSince: 2, bounds: { minX: 440, maxX: 520, minY: 0, maxY: 60 } },
    ], { width: 560, height: 200 });
    assert.equal(frame.bias, 'center');
    assert.deepEqual(frame.excluded, []);
});

test('a one-third anchor is taken when every default sprite footprint still fits', () => {
    const frame = fitAttentionFrame([
        { id: 'new', x: 200, y: 0, awaitingSince: 2000 },
        { id: 'old', x: 0, y: 0, awaitingSince: 1000 },
    ], { width: 1200, height: 800 });
    assert.equal(frame.bias, 'third');
    assert.deepEqual(frame.included, ['old', 'new']);
    assert.ok(frame.center.x > 0 && frame.center.x < 100,
        'the camera leans toward the oldest decision instead of the cohort midpoint');
});
