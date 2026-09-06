// Authored town structure for the isometric village.
// Building positions remain in buildings.js; this file owns the readable
// settlement shape: district masses and the roads that connect them.

export const VILLAGE_GATE = Object.freeze({
    id: 'prop.villageGate',
    tileX: 19.0,
    tileY: 39.1,
    widthTiles: 9.0,
    outside: { tileX: 18.4, tileY: 39.25 },
    inside: { tileX: 20.5, tileY: 37.85 },
});

export const VILLAGE_GATE_BOUNDS = Object.freeze({
    left: -236,
    right: 236,
    top: -180,
    bottom: 96,
    splitY: -42,
});

// Center of Portal Gate footprint (origin 2,29 size 4x4). Subagents spawn here
// so dispatch reads as "child stepped through the portal" rather than the
// generic Village Gate arrival used by top-level sessions.
export const PORTAL_SPAWN_TILE = Object.freeze({ tileX: 4, tileY: 32 });

export const VILLAGE_WALL_ROUTES = Object.freeze([
    {
        id: 'west',
        points: [
            { tileX: 0.0, tileY: 39.1 },
            { tileX: 14.5, tileY: 39.1 },
        ],
    },
    {
        id: 'east',
        points: [
            { tileX: 23.5, tileY: 39.1 },
            { tileX: 35.8, tileY: 39.1 },
        ],
    },
]);

export const TOWN_ROAD_ROUTES = Object.freeze([
    {
        id: 'north-bank-promenade',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [10, 20], [14, 21], [16, 20], [23, 18], [28, 16], [29, 13]],
    },
    {
        id: 'production-row',
        material: 'dirt',
        width: 1,
        points: [[6, 34], [13, 34], [18, 38], [22, 37], [28, 37], [28, 31], [25, 29]],
    },
    {
        id: 'west-production-road',
        material: 'avenue',
        width: 1,
        points: [[6, 34], [14, 31], [18, 27]],
    },
    {
        id: 'central-river-bridge',
        material: 'avenue',
        width: 1,
        points: [[16, 20], [18, 21], [18, 26], [22, 31], [22, 37]],
    },
    {
        id: 'archive-walk',
        material: 'avenue',
        width: 1,
        points: [[7, 23], [8, 20], [8, 17]],
    },
    {
        id: 'clock-walk',
        material: 'avenue',
        width: 1,
        points: [[23, 18], [23, 16]],
    },
    {
        id: 'lighthouse-quay',
        material: 'dock',
        width: 1,
        points: [[29, 19], [29, 16], [29, 13]],
    },
    {
        id: 'harbor-berths',
        material: 'dock',
        width: 1,
        points: [[30, 20], [32, 21], [35, 22], [38, 22], [40, 20], [39, 18]],
    },
    {
        id: 'gate-avenue',
        material: 'avenue',
        width: 1,
        points: [[18, 26], [18, 32], [19, 36], [19, 39]],
    },
]);
