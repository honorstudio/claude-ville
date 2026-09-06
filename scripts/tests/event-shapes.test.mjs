import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_SHAPES, drawEventShape, eventShapeSvgPath } from '../../claudeville/src/presentation/shared/EventShapes.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';

test('every event and district has a distinct monochrome 16 pixel silhouette', () => {
    for (const id of ['edit-strike', 'read-page', 'shell-slate', 'message-scroll', 'incident-bracket', 'child-return', 'release-crown', 'stale-seal', 'turn-sand', ...BUILDING_DEFS.map(b => `district-${b.type}`)]) assert.ok(EVENT_SHAPES[id], id);
    const signatures = new Set();
    for (const [id, rows] of Object.entries(EVENT_SHAPES)) {
        assert.equal(rows.length, 16, id);
        for (const row of rows) assert.match(row, /^[01]{16}$/);
        const signature = rows.join('');
        assert.ok(!signatures.has(signature), `duplicate ${id}`);
        signatures.add(signature);
    }
});
test('Canvas and SVG stamp the same occupied pixels at integer scales', () => {
    for (const id of Object.keys(EVENT_SHAPES)) {
        const pixels = new Set();
        const ctx = { fillRect(x, y, w, h) { for (let a = x; a < x + w; a++) for (let b = y; b < y + h; b++) pixels.add(`${a},${b}`); } };
        drawEventShape(ctx, id, 0, 0, 1, '#fff');
        const svgPixels = new Set();
        for (const [, x, y, w] of eventShapeSvgPath(id).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+Z/g)) for (let a = Number(x); a < Number(x) + Number(w); a++) svgPixels.add(`${a},${y}`);
        assert.deepEqual(pixels, svgPixels, id);
        const scaled = [];
        drawEventShape({ fillRect(...r) { scaled.push(r); } }, id, .3, .7, 2.2, '#fff');
        assert.ok(scaled.every(r => r.every(Number.isInteger)));
        assert.equal(scaled.reduce((n, r) => n + r[2] * r[3], 0), pixels.size * 4);
    }
});
