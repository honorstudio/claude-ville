// TerrainTileset maps a (tileX, tileY, classId) + neighbor mask to a Wang tile cell.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

// Wang 4-bit edge mask: bit 0 = N same, 1 = E same, 2 = S same, 3 = W same.
// Index 0..15 maps to a 4x4 grid of 32x32 cells in a 128x128 tileset PNG.

const TILESET_GRID_COLS = 4;          // 4x4 grid of 16 Wang variants
const TILESET_CELL = 32;              // each variant is 32x32

export class TerrainTileset {
    constructor(assets) {
        this.assets = assets;
        this.cell = TILESET_CELL;
    }

    // isClass(tx, ty) → boolean: tile belongs to upper class.
    drawTile(ctx, sheetId, tileX, tileY, isClass) {
        const sheet = this.assets.get(sheetId);
        if (!sheet) return;
        const mask = (isClass(tileX, tileY - 1) ? 1 : 0)
                   | (isClass(tileX + 1, tileY) ? 2 : 0)
                   | (isClass(tileX, tileY + 1) ? 4 : 0)
                   | (isClass(tileX - 1, tileY) ? 8 : 0);
        const sx = (mask % TILESET_GRID_COLS) * this.cell;
        const sy = Math.floor(mask / TILESET_GRID_COLS) * this.cell;
        const screenX = (tileX - tileY) * (TILE_WIDTH / 2);
        const screenY = (tileX + tileY) * (TILE_HEIGHT / 2);
        // Stretch the 32x32 source cell into the 64x32 iso slot, anchored on
        // the diamond center, then clip to the diamond so corners don't bleed
        // into neighbours and create a patchwork seam.
        const dx = Math.round(screenX - TILE_WIDTH / 2);
        const dy = Math.round(screenY - TILE_HEIGHT / 2);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
        ctx.clip();
        // There is one source cell per Wang mask, so every fully-interior tile
        // used to blit the identical 32x32 image — which is why a field of dirt
        // or grass reads as a stamped, regularly repeating texture at tile
        // frequency. Mirroring interior tiles on a per-tile hash doubles the
        // variety for free.
        //
        // Only mask 15 (all four neighbours the same class) is mirrored: any
        // other mask encodes which edges are transitions, and flipping those
        // would put the transition on the wrong side. Mirroring is horizontal
        // only, so the tileset art keeps its top-left light direction.
        const interior = mask === 15;
        if (interior && (hashTile(tileX, tileY) & 1)) {
            // Mirror about the diamond centre: after translate(screenX)+scale(-1,1)
            // a draw at local x spans screen [screenX - x - w, screenX - x], so
            // x = -TILE_WIDTH/2 lands the image exactly on the tile.
            ctx.translate(screenX, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(sheet, sx, sy, this.cell, this.cell,
                -TILE_WIDTH / 2, dy, TILE_WIDTH, TILE_HEIGHT);
        } else {
            ctx.drawImage(sheet, sx, sy, this.cell, this.cell, dx, dy, TILE_WIDTH, TILE_HEIGHT);
        }
        ctx.restore();
    }
}

// Deterministic per-tile hash — the same tile always picks the same variant, so
// the terrain cache stays stable across re-bakes.
function hashTile(tileX, tileY) {
    let h = (Math.imul(tileX | 0, 73856093) ^ Math.imul(tileY | 0, 19349663)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
}
