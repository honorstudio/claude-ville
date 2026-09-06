import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';

function gridWith(tiles) {
    const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (const [tileX, tileY] of tiles) {
        grid[tileY * MAP_SIZE + tileX] = 1;
    }
    return grid;
}

function corridorTo(tileX, tileY) {
    const tiles = [];
    for (let y = 0; y <= tileY; y++) tiles.push([0, y]);
    for (let x = 1; x <= tileX; x++) tiles.push([x, tileY]);
    return tiles;
}

for (const weighted of [false, true]) {
    test(`blocked targets reject endpoints beyond one tile (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 8 };
        const pathfinder = new Pathfinder(gridWith(corridorTo(8, 10)));
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );

        assert.deepEqual(path, []);
    });

    test(`blocked targets stop at the nearest walkable radius (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 10 };
        const grid = gridWith([
            ...corridorTo(10, 12),
            [11, 10],
        ]);
        const pathfinder = new Pathfinder(grid);
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );

        assert.deepEqual(path, [], 'a reachable farther ring must not replace an unreachable nearest ring');
    });

    test(`reachable blocked targets finish within one tile (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 10 };
        const pathfinder = new Pathfinder(gridWith(corridorTo(9, 10)));
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );
        const endpoint = path.at(-1);

        assert.ok(endpoint);
        assert.ok(Math.max(
            Math.abs(endpoint.tileX - target.tileX),
            Math.abs(endpoint.tileY - target.tileY),
        ) <= 1);
    });
}
