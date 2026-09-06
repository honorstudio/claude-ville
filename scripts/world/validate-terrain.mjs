import { loadConfigExports } from './config-loader.mjs';
import {
    buildingRect,
    createReporter,
    inTileBounds,
    isFiniteNumber,
    isPositiveNumber,
    rectInsideMap,
    rectsOverlap,
    tileKey,
    walkExclusionRect,
} from './validation-utils.mjs';

const WATER_KINDS = new Set(['river', 'moat', 'sea', 'harbor', 'lagoon']);
const ORIENTATIONS = new Set(['NS', 'EW']);
const TERRAIN_CACHE_MARGIN = 360;
const TERRAIN_CACHE_CHUNK_SIZE = 16;
const TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS = 7_000_000;

function bboxIntersectsMap({ minX, minY, maxX, maxY }, mapSize) {
    return maxX >= 0 && minX < mapSize && maxY >= 0 && minY < mapSize;
}

function sourcePath(kind, index) {
    return `${kind}[${index}]`;
}

function validatePointTuple(reporter, path, point, mapSize, { loose = false } = {}) {
    if (!Array.isArray(point) || point.length !== 2) {
        reporter.error(path, 'must be a [tileX, tileY] tuple');
        return false;
    }
    const [x, y] = point;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        reporter.error(path, 'coordinates must be finite numbers');
        return false;
    }
    const limitMin = loose ? -mapSize : 0;
    const limitMax = loose ? mapSize * 2 : mapSize - 1;
    if (Number(x) < limitMin || Number(x) > limitMax || Number(y) < limitMin || Number(y) > limitMax) {
        reporter.error(path, `coordinates ${x},${y} are outside rough bounds ${limitMin}..${limitMax}`);
    }
    return true;
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(x - ax, y - ay);
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(x - cx, y - cy);
}

function distanceToPolyline(x, y, points) {
    let best = Infinity;
    for (let index = 0; index < points.length - 1; index++) {
        best = Math.min(best, distanceToSegment(x, y, points[index], points[index + 1]));
    }
    return best;
}

function isHarborWaterSource(source) {
    return source?.kind === 'harbor'
        || source?.region === 'harbor'
        || source?.surface === 'harbor'
        || source?.weatherProfile === 'harbor';
}

function tileNearWater(tile, polylines, basins, filterSource = () => true, padding = 1) {
    const x = Number(tile.tileX) + 0.5;
    const y = Number(tile.tileY) + 0.5;
    for (const polyline of polylines) {
        if (!filterSource(polyline) || !Array.isArray(polyline.points) || polyline.points.length < 2) continue;
        if (distanceToPolyline(x, y, polyline.points) <= Number(polyline.width) + padding) return true;
    }
    for (const basin of basins) {
        if (!filterSource(basin)) continue;
        const radiusX = Number(basin.radiusX);
        const radiusY = Number(basin.radiusY);
        if (!isPositiveNumber(radiusX) || !isPositiveNumber(radiusY)) continue;
        const nx = (x - Number(basin.centerX)) / radiusX;
        const ny = (y - Number(basin.centerY)) / radiusY;
        const tolerance = padding / Math.max(radiusX, radiusY);
        if (nx * nx + ny * ny <= 1 + tolerance) return true;
    }
    return false;
}

function validateBuildingTerrain(reporter, buildings, mapSize) {
    const rects = [];
    for (const building of buildings) {
        const rect = buildingRect(building);
        if (!rectInsideMap(rect, mapSize)) {
            reporter.error(`building.${building.type}`, `footprint ${rect.x0},${rect.y0}..${rect.x1},${rect.y1} is outside 0..${mapSize - 1}`);
        }
        for (const tile of building.visitTiles || []) {
            if (!inTileBounds(tile.tileX, tile.tileY, mapSize)) {
                reporter.error(`building.${building.type}.visitTiles`, `tile ${tile.tileX},${tile.tileY} is outside 0..${mapSize - 1}`);
            }
        }
        if (building.entrance && !inTileBounds(building.entrance.tileX, building.entrance.tileY, mapSize)) {
            reporter.error(`building.${building.type}.entrance`, `tile ${building.entrance.tileX},${building.entrance.tileY} is outside 0..${mapSize - 1}`);
        }
        for (const exclusion of building.walkExclusion || []) {
            const walkRect = walkExclusionRect(building, exclusion);
            if (!rectInsideMap(walkRect, mapSize)) {
                reporter.error(`building.${building.type}.walkExclusion`, `rect ${walkRect.x0},${walkRect.y0}..${walkRect.x1},${walkRect.y1} is outside 0..${mapSize - 1}`);
            }
        }
        for (const previous of rects) {
            if (rectsOverlap(rect, previous.rect)) {
                reporter.error(`building.${building.type}`, `footprint overlaps building.${previous.type}`);
            }
        }
        rects.push({ type: building.type, rect });
    }
}

function validateWaterPolylines(reporter, polylines, mapSize) {
    for (const [index, polyline] of polylines.entries()) {
        const path = sourcePath('WATER_POLYLINES', index);
        if (!WATER_KINDS.has(polyline.kind)) {
            reporter.error(`${path}.kind`, `unknown water kind "${polyline.kind}"`);
        }
        if (!isPositiveNumber(polyline.width)) {
            reporter.error(`${path}.width`, 'must be a positive number');
        }
        if (!Array.isArray(polyline.points) || polyline.points.length < 2) {
            reporter.error(`${path}.points`, 'must contain at least two points');
            continue;
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        polyline.points.forEach((point, pointIndex) => {
            if (!validatePointTuple(reporter, `${path}.points[${pointIndex}]`, point, mapSize, { loose: true })) return;
            minX = Math.min(minX, Number(point[0]));
            minY = Math.min(minY, Number(point[1]));
            maxX = Math.max(maxX, Number(point[0]));
            maxY = Math.max(maxY, Number(point[1]));
        });
        const pad = Number(polyline.width || 0);
        if (!bboxIntersectsMap({ minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }, mapSize)) {
            reporter.error(path, 'water polyline does not intersect the map');
        }
    }
}

function validateWaterBasins(reporter, basins, mapSize) {
    for (const [index, basin] of basins.entries()) {
        const path = sourcePath('WATER_BASINS', index);
        if (!WATER_KINDS.has(basin.kind)) {
            reporter.error(`${path}.kind`, `unknown water kind "${basin.kind}"`);
        }
        for (const field of ['centerX', 'centerY', 'radiusX', 'radiusY']) {
            if (!isFiniteNumber(basin[field])) {
                reporter.error(`${path}.${field}`, 'must be a finite number');
            }
        }
        if (!isPositiveNumber(basin.radiusX) || !isPositiveNumber(basin.radiusY)) {
            reporter.error(path, 'radiusX and radiusY must be positive');
            continue;
        }
        const bbox = {
            minX: Number(basin.centerX) - Number(basin.radiusX),
            minY: Number(basin.centerY) - Number(basin.radiusY),
            maxX: Number(basin.centerX) + Number(basin.radiusX),
            maxY: Number(basin.centerY) + Number(basin.radiusY),
        };
        if (!bboxIntersectsMap(bbox, mapSize)) {
            reporter.error(path, 'water basin does not intersect the map');
        }
    }
}

function validateBridgeHints(reporter, bridgeHints, polylines, basins, mapSize, source = 'BRIDGE_HINTS') {
    const ids = new Set();
    for (const [index, bridge] of bridgeHints.entries()) {
        const path = sourcePath(source, index);
        if (!bridge.id || typeof bridge.id !== 'string') {
            reporter.error(`${path}.id`, 'must be a non-empty string');
        } else if (ids.has(bridge.id)) {
            reporter.error(`${path}.id`, `duplicates bridge id "${bridge.id}"`);
        } else {
            ids.add(bridge.id);
        }
        if (!inTileBounds(bridge.tileX, bridge.tileY, mapSize)) {
            reporter.error(path, `tile ${bridge.tileX},${bridge.tileY} is outside 0..${mapSize - 1}`);
        }
        if ((source === 'PLANK_BRIDGES' || bridge.orientation) && !ORIENTATIONS.has(bridge.orientation)) {
            reporter.error(`${path}.orientation`, 'must be NS or EW');
        }
        if (!tileNearWater(bridge, polylines, basins, () => true, 1.2)) {
            reporter.error(path, 'bridge hint is not near any rough water source');
        }
    }
}

function validateDockTiles(reporter, dockTiles, buildings, polylines, basins, mapSize) {
    if (!dockTiles.length) {
        reporter.error('HARBOR_DOCK_TILES', 'must contain at least one dock tile');
        return;
    }
    const tileSet = new Set();
    for (const [index, tile] of dockTiles.entries()) {
        const path = sourcePath('HARBOR_DOCK_TILES', index);
        if (!inTileBounds(tile.tileX, tile.tileY, mapSize)) {
            reporter.error(path, `tile ${tile.tileX},${tile.tileY} is outside 0..${mapSize - 1}`);
        }
        if (!ORIENTATIONS.has(tile.orientation)) {
            reporter.error(`${path}.orientation`, 'must be NS or EW');
        }
        if (!tileNearWater(tile, polylines, basins, isHarborWaterSource, 1.5)) {
            reporter.error(path, 'dock tile is not near any rough harbor water source');
        }
        tileSet.add(tileKey(tile.tileX, tile.tileY));
    }
    const harbor = buildings.find((building) => building.type === 'harbor');
    if (!harbor) {
        reporter.error('building.harbor', 'missing harbor building required by dock checks');
    } else if (!tileSet.has(tileKey(harbor.entrance?.tileX, harbor.entrance?.tileY))) {
        reporter.error('building.harbor.entrance', 'harbor entrance must sit on an authored dock tile');
    }

    const [first] = dockTiles;
    const queue = [tileKey(first.tileX, first.tileY)];
    const seen = new Set(queue);
    while (queue.length) {
        const [x, y] = queue.shift().split(',').map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next = tileKey(x + dx, y + dy);
            if (tileSet.has(next) && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    if (seen.size !== tileSet.size) {
        reporter.error('HARBOR_DOCK_TILES', 'dock tiles must form one connected cardinal cluster');
    }
}

function validateTileObjects(reporter, label, items, mapSize) {
    for (const [index, item] of items.entries()) {
        const path = sourcePath(label, index);
        if (!inTileBounds(item.tileX, item.tileY, mapSize)) {
            reporter.error(path, `tile ${item.tileX},${item.tileY} is outside 0..${mapSize - 1}`);
        }
        if (Object.prototype.hasOwnProperty.call(item, 'scale') && !isPositiveNumber(item.scale)) {
            reporter.error(`${path}.scale`, 'must be a positive number');
        }
    }
}

function validateRegions(reporter, label, items, mapSize) {
    for (const [index, item] of items.entries()) {
        const path = sourcePath(label, index);
        for (const field of ['centerX', 'centerY']) {
            if (!isFiniteNumber(item[field])) {
                reporter.error(`${path}.${field}`, 'must be a finite number');
            }
        }
        for (const field of ['radiusX', 'radiusY', 'radius']) {
            if (Object.prototype.hasOwnProperty.call(item, field) && !isPositiveNumber(item[field])) {
                reporter.error(`${path}.${field}`, 'must be a positive number');
            }
        }
        if (Object.prototype.hasOwnProperty.call(item, 'density')) {
            const density = Number(item.density);
            if (!Number.isFinite(density) || density < 0 || density > 1) {
                reporter.error(`${path}.density`, 'must be between 0 and 1');
            }
        }
        const looseLimit = mapSize * 2;
        if (Math.abs(Number(item.centerX)) > looseLimit || Math.abs(Number(item.centerY)) > looseLimit) {
            reporter.error(path, `center ${item.centerX},${item.centerY} is outside rough bounds +/-${looseLimit}`);
        }
    }
}

function terrainCacheFootprint(mapSize, tileWidth, tileHeight) {
    const last = mapSize - 1;
    const halfTileWidth = tileWidth / 2;
    const halfTileHeight = tileHeight / 2;
    const minX = Math.floor((-last * halfTileWidth - halfTileWidth) - TERRAIN_CACHE_MARGIN);
    const maxX = Math.ceil((last * halfTileWidth + halfTileWidth) + TERRAIN_CACHE_MARGIN);
    const minY = Math.floor(-halfTileHeight - TERRAIN_CACHE_MARGIN);
    const maxY = Math.ceil((last * tileHeight + halfTileHeight) + TERRAIN_CACHE_MARGIN);
    const width = maxX - minX;
    const height = maxY - minY;
    return {
        width,
        height,
        pixels: width * height,
    };
}

function validateTerrainCacheScalability(reporter, mapSize, tileWidth, tileHeight) {
    if (!Number.isInteger(Number(mapSize)) || Number(mapSize) <= 0) {
        reporter.error('MAP_SIZE', 'must be a positive integer');
        return null;
    }
    if (!isPositiveNumber(tileWidth) || !isPositiveNumber(tileHeight)) {
        reporter.error('terrain.cache', 'TILE_WIDTH and TILE_HEIGHT must be positive numbers');
        return null;
    }
    const footprint = terrainCacheFootprint(Number(mapSize), Number(tileWidth), Number(tileHeight));
    const chunksX = Math.ceil(Number(mapSize) / TERRAIN_CACHE_CHUNK_SIZE);
    const chunksY = Math.ceil(Number(mapSize) / TERRAIN_CACHE_CHUNK_SIZE);
    const chunkCount = chunksX * chunksY;
    if (footprint.pixels > TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS) {
        reporter.warn(
            'terrain.cache',
            `single-surface estimate ${footprint.pixels} px exceeds ${TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS}; chunked caches are required before raising MAP_SIZE`
        );
    }
    return {
        ...footprint,
        chunkSize: TERRAIN_CACHE_CHUNK_SIZE,
        chunksX,
        chunksY,
        chunkCount,
    };
}

const reporter = createReporter('world terrain validation');
const { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } = await loadConfigExports('claudeville/src/config/constants.js', ['MAP_SIZE', 'TILE_WIDTH', 'TILE_HEIGHT']);
const { BUILDING_DEFS } = await loadConfigExports('claudeville/src/config/buildings.js', ['BUILDING_DEFS']);
const {
    WATER_POLYLINES,
    WATER_BASINS,
    BRIDGE_HINTS,
    PLANK_BRIDGES,
    HARBOR_DOCK_TILES,
    FOREST_FLOOR_REGIONS,
    TREE_CLUSTERS,
    TROPICAL_PALMS,
    TROPICAL_BROADLEAF_TREES,
    BOULDERS,
    VEGETATION_DISTRICTS,
    SHORELINE_VEGETATION,
    SCENERY_CLEARINGS,
    TROPICAL_WATERFALLS,
    DISTRICT_PROPS,
    MARINE_FISH_SCHOOLS,
    BUSH_DENSITY,
    GRASS_TUFT_DENSITY,
} = await loadConfigExports('claudeville/src/config/scenery.js', [
    'WATER_POLYLINES',
    'WATER_BASINS',
    'BRIDGE_HINTS',
    'PLANK_BRIDGES',
    'HARBOR_DOCK_TILES',
    'FOREST_FLOOR_REGIONS',
    'TREE_CLUSTERS',
    'TROPICAL_PALMS',
    'TROPICAL_BROADLEAF_TREES',
    'BOULDERS',
    'VEGETATION_DISTRICTS',
    'SHORELINE_VEGETATION',
    'SCENERY_CLEARINGS',
    'TROPICAL_WATERFALLS',
    'DISTRICT_PROPS',
    'MARINE_FISH_SCHOOLS',
    'BUSH_DENSITY',
    'GRASS_TUFT_DENSITY',
]);

const terrainCachePlan = validateTerrainCacheScalability(reporter, MAP_SIZE, TILE_WIDTH, TILE_HEIGHT);
validateBuildingTerrain(reporter, BUILDING_DEFS, MAP_SIZE);
validateWaterPolylines(reporter, WATER_POLYLINES, MAP_SIZE);
validateWaterBasins(reporter, WATER_BASINS, MAP_SIZE);
validateBridgeHints(reporter, BRIDGE_HINTS, WATER_POLYLINES, WATER_BASINS, MAP_SIZE);
validateBridgeHints(reporter, PLANK_BRIDGES, WATER_POLYLINES, WATER_BASINS, MAP_SIZE, 'PLANK_BRIDGES');
validateDockTiles(reporter, HARBOR_DOCK_TILES, BUILDING_DEFS, WATER_POLYLINES, WATER_BASINS, MAP_SIZE);
validateRegions(reporter, 'FOREST_FLOOR_REGIONS', FOREST_FLOOR_REGIONS, MAP_SIZE);
validateRegions(reporter, 'TREE_CLUSTERS', TREE_CLUSTERS, MAP_SIZE);
validateRegions(reporter, 'VEGETATION_DISTRICTS', VEGETATION_DISTRICTS, MAP_SIZE);
validateRegions(reporter, 'SCENERY_CLEARINGS', SCENERY_CLEARINGS, MAP_SIZE);
validateTileObjects(reporter, 'TROPICAL_PALMS', TROPICAL_PALMS, MAP_SIZE);
validateTileObjects(reporter, 'TROPICAL_BROADLEAF_TREES', TROPICAL_BROADLEAF_TREES, MAP_SIZE);
validateTileObjects(reporter, 'BOULDERS', BOULDERS, MAP_SIZE);
validateTileObjects(reporter, 'DISTRICT_PROPS', DISTRICT_PROPS, MAP_SIZE);
validateTileObjects(reporter, 'MARINE_FISH_SCHOOLS', MARINE_FISH_SCHOOLS, MAP_SIZE);
validateTileObjects(reporter, 'TROPICAL_WATERFALLS', TROPICAL_WATERFALLS, MAP_SIZE);

for (const [index, waterfall] of TROPICAL_WATERFALLS.entries()) {
    if (!inTileBounds(waterfall.poolTileX, waterfall.poolTileY, MAP_SIZE)) {
        reporter.error(`TROPICAL_WATERFALLS[${index}].pool`, `pool tile ${waterfall.poolTileX},${waterfall.poolTileY} is outside 0..${MAP_SIZE - 1}`);
    }
}

for (const [label, density] of [['BUSH_DENSITY', BUSH_DENSITY], ['GRASS_TUFT_DENSITY', GRASS_TUFT_DENSITY]]) {
    if (!density || !isFiniteNumber(density.min) || !isFiniteNumber(density.max)) {
        reporter.error(label, 'min and max must be finite numbers');
    } else if (Number(density.min) < 0 || Number(density.max) > 1 || Number(density.min) > Number(density.max)) {
        reporter.error(label, 'min/max must satisfy 0 <= min <= max <= 1');
    }
}

if (!isPositiveNumber(SHORELINE_VEGETATION?.maxWaterDistance)) {
    reporter.error('SHORELINE_VEGETATION.maxWaterDistance', 'must be a positive number');
}

const harborSourceCount = [...WATER_POLYLINES, ...WATER_BASINS].filter(isHarborWaterSource).length;
if (harborSourceCount === 0) {
    reporter.error('WATER_*', 'at least one harbor water source is required for dock checks');
}

const terrainCacheSummary = terrainCachePlan
    ? ` terrain cache plan: ${terrainCachePlan.chunksX}x${terrainCachePlan.chunksY} chunks (${terrainCachePlan.chunkCount}) at ${terrainCachePlan.chunkSize} tiles, ${terrainCachePlan.pixels} px single-surface estimate.`
    : '';
reporter.finish(`${BUILDING_DEFS.length} building(s), ${WATER_POLYLINES.length} water polyline(s), ${WATER_BASINS.length} basin(s), ${PLANK_BRIDGES.length} plank bridge(s), and ${HARBOR_DOCK_TILES.length} dock tile(s) checked.${terrainCacheSummary}`);
