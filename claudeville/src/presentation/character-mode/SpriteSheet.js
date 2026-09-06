// SpriteSheet locates the right cell within a character sheet PNG.
// Sheet layout: 8 columns (directions S, SE, E, NE, N, NW, W, SW),
// rows 0-5 walk (6 frames), rows 6-9 idle (4 frames). Each cell is `cellSize` px square.

export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const WALK_FRAMES = 6;
export const IDLE_FRAMES = 4;
export const DEFAULT_CELL = 92;

export class SpriteSheet {
    constructor(image, cellSize = DEFAULT_CELL) {
        this.image = image;
        this.cellSize = cellSize;
    }

    // animState: 'walk' | 'idle', dir: 0..7, frame: int
    cell(animState, dir, frame) {
        const col = dir;                                   // 0..7
        const baseRow = animState === 'idle' ? WALK_FRAMES : 0;
        const row = baseRow + (frame % (animState === 'idle' ? IDLE_FRAMES : WALK_FRAMES));
        return {
            sx: col * this.cellSize,
            sy: row * this.cellSize,
            sw: this.cellSize,
            sh: this.cellSize,
        };
    }
}

// C2 action strips: an optional per-character PNG of 8 direction columns by N
// rows of the same engine cell as the base sheet, with named groups instead of
// frame-count identity. `sheetMeta` is the manifest `actionStrip` record:
//   { path, cell, groups: { read: { rows: [0, 3], hold: 3 } }, grip, provenance }
// `direction` is a DIRECTIONS index or key; `frame` is a group-relative index
// (wrapping) or the literal 'hold' for the most legible static row. Returns
// null for a missing strip, unknown group, or malformed metadata so callers
// fall back to the procedural overlay.
export function resolveActionFrame(sheetMeta, group, direction, frame = 0) {
    const cell = Number(sheetMeta?.cell);
    if (!Number.isInteger(cell) || cell <= 0) return null;
    const groupMeta = sheetMeta?.groups?.[group];
    const rows = groupMeta?.rows;
    if (!Array.isArray(rows) || rows.length !== 2) return null;
    const first = Number(rows[0]);
    const last = Number(rows[1]);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return null;
    const col = typeof direction === 'number' ? direction : DIRECTIONS.indexOf(direction);
    if (!Number.isInteger(col) || col < 0 || col >= DIRECTIONS.length) return null;
    let row;
    if (frame === 'hold') {
        const hold = Number(groupMeta.hold);
        row = Number.isInteger(hold) && hold >= first && hold <= last ? hold : last;
    } else {
        const index = Number(frame);
        if (!Number.isFinite(index)) return null;
        const span = last - first + 1;
        row = first + (((Math.trunc(index) % span) + span) % span);
    }
    return {
        sx: col * cell,
        sy: row * cell,
        sw: cell,
        sh: cell,
    };
}

// Velocity → direction index. Returns 0..7 matching DIRECTIONS order.
// DIRECTIONS = ['s','se','e','ne','n','nw','w','sw'].
// In screen space: vy > 0 means moving south (down). atan2(vy, vx) is 0 at East,
// π/2 at South. We want South → 0, SE → 1, E → 2, NE → 3, N → 4, NW → 5, W → 6, SW → 7.
export function dirFromVelocity(vx, vy) {
    if (vx === 0 && vy === 0) return null;
    const angle = Math.atan2(vy, vx);                       // -π..π, 0 at East, π/2 at South
    // Map: East(0°)→2, South(90°)→0, West(180°)→6, North(270°)→4.
    // Formula: 2 - angle/(π/4), then modulo 8.
    const stepped = Math.round(2 - angle / (Math.PI / 4));
    return ((stepped % 8) + 8) % 8;
}
