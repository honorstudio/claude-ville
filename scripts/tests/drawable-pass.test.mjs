import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDepthDrawable,
    drawDepthSortedDrawableKinds,
} from '../../claudeville/src/presentation/character-mode/DrawablePass.js';

test('GPU overlay replay draws only the requested Canvas-only categories', () => {
    const calls = [];
    const drawables = [
        createDepthDrawable('building', 10, { id: 'keep' }, () => calls.push('building')),
        createDepthDrawable('harbor-traffic', 20, { id: 'ship-1' }, (_ctx, zoom, context) => {
            calls.push(`harbor:${zoom}:${context.renderNow}`);
        }),
        createDepthDrawable('agent', 30, { id: 'agent-1' }, () => calls.push('agent')),
    ];

    drawDepthSortedDrawableKinds({}, drawables, ['harbor-traffic'], {
        zoom: 1.25,
        renderNow: 1234,
    });

    assert.deepEqual(calls, ['harbor:1.25:1234']);
});

test('GPU overlay replay is a no-op without requested categories', () => {
    let draws = 0;
    const drawable = createDepthDrawable('harbor-traffic', 20, { id: 'ship-1' }, () => draws++);

    drawDepthSortedDrawableKinds({}, [drawable], []);

    assert.equal(draws, 0);
});
