import {
    MATERIAL_CHANNELS,
    normalizeAtlasFrame,
    normalizeMaterialClass,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    collectSpriteEntries,
    pathForEntry,
} from './manifest-utils.mjs';
import {
    canonicalize,
    DEFAULT_ATLAS_PAGE_SIZE,
    packFrames,
    stableJson,
} from './atlas-packing.mjs';
import {
    channelsForManifest,
    companionPathForChannel,
} from './channel-registry.mjs';

export { canonicalize, packFrames, stableJson } from './atlas-packing.mjs';

export const CHARACTER_DIRECTIONS = Object.freeze(['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw']);
export const CHARACTER_WALK_FRAMES = 6;
export const CHARACTER_IDLE_FRAMES = 4;
export const TERRAIN_GRID_SIZE = 4;

export function resolveAtlasDefinition(manifest, atlasId) {
    const definitions = Array.isArray(manifest?.atlases) ? manifest.atlases : [];
    const atlas = definitions.find((candidate) => candidate?.id === atlasId);
    if (!atlas) throw new Error(`unknown atlas "${atlasId}"`);
    return atlas;
}

export function createAtlasPlan(manifest, atlasDefinition) {
    const entries = collectSpriteEntries(manifest);
    const channels = channelsForManifest(manifest);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const ids = [...new Set(atlasDefinition?.ids || [])];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`atlas ${atlasDefinition.id} has unknown ids: ${unknown.join(', ')}`);

    const frames = [];
    const assets = {};
    for (const id of ids) {
        const entry = byId.get(id);
        const specs = frameSpecsForEntry(entry, channels);
        frames.push(...specs);
        assets[id] = assetMetadata(entry, specs);
    }

    const layout = packFrames(frames, {
        maxWidth: positiveInteger(atlasDefinition.maxWidth, DEFAULT_ATLAS_PAGE_SIZE),
        maxHeight: positiveInteger(atlasDefinition.maxHeight, DEFAULT_ATLAS_PAGE_SIZE),
        padding: nonNegativeInteger(atlasDefinition.padding, 2),
        powerOfTwo: atlasDefinition.powerOfTwo !== false,
    });
    const frameMap = {};
    for (const frame of [...layout.frames].sort((a, b) => a.key.localeCompare(b.key))) {
        frameMap[frame.key] = {
            rect: frame.rect,
            paddedRect: frame.paddedRect,
            sourceRect: frame.sourceRect,
            sourceSize: frame.sourceSize,
            sourcePath: frame.sourcePath,
            anchor: frame.anchor,
            materialClass: frame.materialClass,
            emissive: frame.emissive,
            occluder: frame.occluder,
            tags: frame.tags,
            sidecars: frame.sidecars,
        };
    }

    return {
        schemaVersion: 1,
        id: atlasDefinition.id,
        width: layout.width,
        height: layout.height,
        contentHeight: layout.contentHeight,
        padding: layout.padding,
        sampling: 'nearest',
        channels: Object.fromEntries(channels.map((channel) => [
            channel,
            atlasDefinition.channels?.[channel] || null,
        ])),
        ids,
        assets,
        frames: frameMap,
        packOrder: layout.frames.map((frame) => frame.key),
    };
}

export function frameSpecsForEntry(entry, channels = MATERIAL_CHANNELS) {
    const sourcePath = pathForEntry(entry);
    if (!sourcePath) throw new Error(`${entry?.id || '(unknown)'} has no albedo path`);
    const atlasFrame = normalizeAtlasFrame(entry.atlasFrame);
    const materialClass = normalizeMaterialClass(entry.materialClass);
    const anchor = normalizeAnchor(entry.anchor);
    const base = {
        assetId: entry.id,
        sourcePath,
        materialClass,
        anchor,
        emissive: entry.emissive || null,
        occluder: entry.occluder || null,
        sidecars: sidecarPaths(entry, sourcePath, channels),
    };

    if (entry.id.startsWith('agent.')) {
        const cell = positiveInteger(entry.size, 92);
        const sourceSize = { w: cell * CHARACTER_DIRECTIONS.length, h: cell * 10 };
        const prefix = atlasFrame?.keyPrefix || entry.id;
        const frames = [];
        for (let row = 0; row < CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES; row++) {
            const animation = row < CHARACTER_WALK_FRAMES ? 'walk' : 'idle';
            const frameIndex = row < CHARACTER_WALK_FRAMES ? row : row - CHARACTER_WALK_FRAMES;
            for (let direction = 0; direction < CHARACTER_DIRECTIONS.length; direction++) {
                const directionName = CHARACTER_DIRECTIONS[direction];
                frames.push({
                    ...base,
                    key: `${prefix}/${animation}/${directionName}/${frameIndex}`,
                    w: cell,
                    h: cell,
                    sourceRect: { x: direction * cell, y: row * cell, w: cell, h: cell },
                    sourceSize,
                    tags: { animation, direction: directionName, frame: frameIndex },
                });
            }
        }
        return frames;
    }

    if (entry.id.startsWith('terrain.')) {
        const cell = positiveInteger(entry.size, 32);
        const sourceSize = { w: cell * TERRAIN_GRID_SIZE, h: cell * TERRAIN_GRID_SIZE };
        const prefix = atlasFrame?.keyPrefix || entry.id;
        const frames = [];
        for (let mask = 0; mask < TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE; mask++) {
            frames.push({
                ...base,
                key: `${prefix}/wang/${mask}`,
                w: cell,
                h: cell,
                sourceRect: {
                    x: (mask % TERRAIN_GRID_SIZE) * cell,
                    y: Math.floor(mask / TERRAIN_GRID_SIZE) * cell,
                    w: cell,
                    h: cell,
                },
                sourceSize,
                tags: { animation: 'wang', mask },
            });
        }
        return frames;
    }

    const dims = declaredDimensions(entry);
    const frames = [{
        ...base,
        key: atlasFrame?.key || entry.id,
        w: dims.w,
        h: dims.h,
        sourceRect: { x: 0, y: 0, w: dims.w, h: dims.h },
        sourceSize: dims,
        tags: { layer: 'base' },
    }];

    if (entry.id.startsWith('building.') && entry.layers) {
        for (const name of Object.keys(entry.layers).sort()) {
            if (name === 'base') continue;
            const layer = entry.layers[name];
            const layerDims = declaredDimensions(layer);
            const layerPath = `buildings/${entry.id}/${name}.png`;
            frames.push({
                assetId: entry.id,
                key: `${entry.id}.${name}`,
                sourcePath: layerPath,
                w: layerDims.w,
                h: layerDims.h,
                sourceRect: { x: 0, y: 0, w: layerDims.w, h: layerDims.h },
                sourceSize: layerDims,
                anchor: normalizeAnchor(layer.anchor),
                materialClass: normalizeMaterialClass(layer.materialClass || entry.materialClass),
                emissive: layer.emissive || null,
                occluder: layer.occluder || entry.occluder || null,
                sidecars: sidecarPaths(layer, layerPath, channels),
                tags: { layer: name },
            });
        }
    }
    return frames;
}

function assetMetadata(entry, specs) {
    const base = specs.find((frame) => frame.tags?.layer === 'base') || specs[0];
    return {
        id: entry.id,
        sourcePath: base.sourcePath,
        sourceSize: base.sourceSize,
        anchor: normalizeAnchor(entry.anchor),
        materialClass: normalizeMaterialClass(entry.materialClass),
        atlasFrame: normalizeAtlasFrame(entry.atlasFrame),
        structureMask: entry.structureMask || null,
        frameCount: specs.length,
        baseFrameCount: entry.id.startsWith('agent.')
            ? CHARACTER_DIRECTIONS.length * (CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES)
            : entry.id.startsWith('terrain.')
                ? TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE
                : 1,
        frames: specs.map((frame) => frame.key),
    };
}

function sidecarPaths(entry, albedoPath, channels = MATERIAL_CHANNELS) {
    return Object.fromEntries(channels
        .slice(1)
        .map((channel) => [channel, normalizeSpritePath(companionPathForChannel(entry, channel, albedoPath))]));
}

function normalizeSpritePath(path) {
    return path ? String(path).replace(/^assets\/sprites\//, '') : null;
}

function declaredDimensions(entry) {
    const width = Number(entry?.width ?? entry?.size);
    const height = Number(entry?.height ?? entry?.size);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error(`${entry?.id || '(layer)'} needs positive size or width/height`);
    }
    return { w: width, h: height };
}

function normalizeAnchor(value) {
    return Array.isArray(value) && value.length >= 2
        ? [Number(value[0]) || 0, Number(value[1]) || 0]
        : [0, 0];
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
}
