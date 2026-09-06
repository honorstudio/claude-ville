import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';

export const TILE_HALF_WIDTH = TILE_WIDTH / 2;
export const TILE_HALF_HEIGHT = TILE_HEIGHT / 2;

function tileArgs(tileOrX, tileY) {
    if (tileOrX && typeof tileOrX === 'object') {
        return {
            tileX: tileOrX.tileX ?? tileOrX.x ?? 0,
            tileY: tileOrX.tileY ?? tileOrX.y ?? 0,
        };
    }
    return { tileX: tileOrX, tileY };
}

function pointArgs(pointOrX, y) {
    if (pointOrX && typeof pointOrX === 'object') {
        return { x: pointOrX.x ?? 0, y: pointOrX.y ?? 0 };
    }
    return { x: pointOrX, y };
}

export function tileToWorld(tileOrX, tileY) {
    const tile = tileArgs(tileOrX, tileY);
    return {
        x: (tile.tileX - tile.tileY) * TILE_HALF_WIDTH,
        y: (tile.tileX + tile.tileY) * TILE_HALF_HEIGHT,
    };
}

export function worldToTile(pointOrX, y) {
    const point = pointArgs(pointOrX, y);
    return {
        tileX: (point.x / TILE_HALF_WIDTH + point.y / TILE_HALF_HEIGHT) / 2,
        tileY: (point.y / TILE_HALF_HEIGHT - point.x / TILE_HALF_WIDTH) / 2,
    };
}

export function buildingCenterToWorld(building) {
    const position = building?.position || building || {};
    const width = building?.width ?? 1;
    const height = building?.height ?? 1;
    return tileToWorld(
        (position.tileX ?? position.x ?? 0) + width / 2,
        (position.tileY ?? position.y ?? 0) + height / 2,
    );
}

export function mapWorldCorners(mapSize = MAP_SIZE) {
    const maxTile = mapSize - 1;
    return [
        { x: 0, y: 0 },
        { x: maxTile * TILE_HALF_WIDTH, y: maxTile * TILE_HALF_HEIGHT },
        { x: -maxTile * TILE_HALF_WIDTH, y: maxTile * TILE_HALF_HEIGHT },
        { x: 0, y: maxTile * TILE_HEIGHT },
    ];
}
