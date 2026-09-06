import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
    AUTHORED_KEY_LIGHT,
    MATERIAL_CHANNELS,
    MATERIAL_CLASS_NAMES,
    isKnownMaterialClass,
    normalizeAtlasFrame,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    canonicalize,
    createAtlasPlan,
    frameSpecsForEntry,
    resolveAtlasDefinition,
} from './atlas-layout.mjs';
import {
    collectSpriteEntries,
    pathForEntry,
    spritesRoot,
} from './manifest-utils.mjs';
import {
    MATERIAL_CONTRACT_VERSION,
    channelContractMatchesRegistry,
    channelsForManifest,
    companionChannels,
    companionPathForChannel,
    sidecarFieldFor,
} from './channel-registry.mjs';

const ALPHA_THRESHOLD = 0;

export function materialExpectedPngPaths(manifest) {
    const expected = new Set();
    const channels = channelsForManifest(manifest);
    for (const atlas of manifest?.atlases || []) {
        for (const path of Object.values(atlas?.channels || {})) {
            if (path) expected.add(relativeSpritePath(path));
        }
    }
    for (const entry of collectSpriteEntries(manifest)) {
        for (const frame of frameSpecsForEntry(entry, channels)) {
            for (const path of Object.values(frame.sidecars || {})) {
                if (path) expected.add(relativeSpritePath(path));
            }
        }
        // An optional C2 action strip carries its own companions against the
        // strip path under the same sidecar declarations; they are semantic
        // data like every other companion, not albedo art.
        const stripPath = entry.id?.startsWith('agent.') ? entry.actionStrip?.path : null;
        if (stripPath) {
            for (const channel of channels.slice(1)) {
                const path = companionPathForChannel(entry, channel, stripPath);
                if (path) expected.add(relativeSpritePath(path));
            }
        }
    }
    return expected;
}

export function validateMaterialContract(manifest, {
    root = spritesRoot,
    logger = console,
} = {}) {
    let errors = 0;
    let warnings = 0;
    const entries = collectSpriteEntries(manifest);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const atlases = Array.isArray(manifest?.atlases) ? manifest.atlases : [];
    const atlasIds = new Set(atlases.map((atlas) => atlas?.id).filter(Boolean));
    const channels = channelsForManifest(manifest);
    const sidecarFields = companionChannels(channels).map(sidecarFieldFor);

    if (manifest?.materialContract) {
        const contract = manifest.materialContract;
        if (Number(contract.version) !== MATERIAL_CONTRACT_VERSION) {
            errors += fail(logger, `INVALID MATERIAL CONTRACT: version must be ${MATERIAL_CONTRACT_VERSION}`);
        }
        if (contract.sampling !== 'nearest') errors += fail(logger, 'INVALID MATERIAL CONTRACT: sampling must be nearest');
        if (contract.keyLight !== 'warm-upper-left') errors += fail(logger, 'INVALID MATERIAL CONTRACT: keyLight must be warm-upper-left');
        if (!deepEqual(contract.responseBands, AUTHORED_KEY_LIGHT.responseBands)) {
            errors += fail(logger, `INVALID MATERIAL CONTRACT: responseBands must be ${AUTHORED_KEY_LIGHT.responseBands.join(', ')}`);
        }
        if (!channelContractMatchesRegistry(contract.channels)) {
            errors += fail(logger, `INVALID MATERIAL CONTRACT: channels must be ${MATERIAL_CHANNELS.join(', ')}`);
        }
    }

    for (const entry of entries) {
        const hasEntryMaterial = entry.materialClass || entry.atlasFrame
            || sidecarFields.some((field) => entry[field]);
        const hasLayerMaterial = Object.values(entry.layers || {}).some((layer) => (
            layer?.materialClass || sidecarFields.some((field) => layer?.[field])
        ));
        if (!hasEntryMaterial && !hasLayerMaterial) continue;
        if (hasEntryMaterial) {
            if (!isKnownMaterialClass(entry.materialClass)) {
                errors += fail(logger, `INVALID MATERIAL: ${entry.id} has unknown materialClass "${entry.materialClass}"`);
            }
            const atlasFrame = normalizeAtlasFrame(entry.atlasFrame);
            if (entry.atlasFrame && !atlasFrame) {
                errors += fail(logger, `INVALID MATERIAL: ${entry.id} has invalid atlasFrame`);
            } else if (atlasFrame && !atlasIds.has(atlasFrame.atlas)) {
                errors += fail(logger, `INVALID MATERIAL: ${entry.id} references unknown atlas ${atlasFrame.atlas}`);
            }
            errors += validateElevation(entry, logger);
            errors += validateEmissive(entry, logger);
            errors += validateOccluder(entry, logger);
        }
        errors += validateDeclaredSidecars(entry, root, logger, channels);
        for (const [name, layer] of Object.entries(entry.layers || {})) {
            const layerEntry = { ...layer, id: `${entry.id}.${name}` };
            if (layer.materialClass && !isKnownMaterialClass(layer.materialClass)) {
                errors += fail(logger, `INVALID MATERIAL: ${layerEntry.id} has unknown materialClass "${layer.materialClass}"`);
            }
            errors += validateElevation(layerEntry, logger);
            errors += validateEmissive(layerEntry, logger);
            errors += validateOccluder(layerEntry, logger);
        }
    }

    const seenAtlasIds = new Set();
    for (const atlas of atlases) {
        if (!atlas?.id || seenAtlasIds.has(atlas.id)) {
            errors += fail(logger, `INVALID ATLAS: missing or duplicate id ${atlas?.id || '(none)'}`);
            continue;
        }
        seenAtlasIds.add(atlas.id);
        const unknown = (atlas.ids || []).filter((id) => !byId.has(id));
        if (unknown.length) errors += fail(logger, `INVALID ATLAS: ${atlas.id} has unknown ids ${unknown.join(', ')}`);
        if (!Number.isInteger(Number(atlas.padding)) || Number(atlas.padding) < 1) {
            errors += fail(logger, `INVALID ATLAS: ${atlas.id} padding must be at least 1px to prevent bleeding`);
        }
        for (const channel of channels) {
            if (!atlas.channels?.[channel]) errors += fail(logger, `INVALID ATLAS: ${atlas.id} missing ${channel} channel path`);
        }
        const result = validateAtlasOutputs(manifest, atlas, { root, logger });
        errors += result.errors;
        warnings += result.warnings;
    }

    return {
        errors,
        warnings,
        expectedPngPaths: materialExpectedPngPaths(manifest),
    };
}

export function validateAtlasOutputs(manifest, atlas, { root = spritesRoot, logger = console } = {}) {
    let errors = 0;
    let warnings = 0;
    const channels = channelsForManifest(manifest);
    const metadataPath = absoluteSpritePath(root, atlas.metadata);
    if (!existsSync(metadataPath)) {
        return { errors: fail(logger, `MISSING ATLAS METADATA: ${relativeSpritePath(atlas.metadata)}`), warnings };
    }
    let metadata;
    try {
        metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    } catch (err) {
        return { errors: fail(logger, `INVALID ATLAS METADATA: ${atlas.id} (${err.message})`), warnings };
    }

    let expected;
    try {
        expected = createAtlasPlan(manifest, resolveAtlasDefinition(manifest, atlas.id));
    } catch (err) {
        return { errors: fail(logger, `INVALID ATLAS PLAN: ${atlas.id} (${err.message})`), warnings };
    }
    if (metadata.schemaVersion !== 1 || metadata.id !== atlas.id || metadata.sampling !== 'nearest') {
        errors += fail(logger, `INVALID ATLAS METADATA: ${atlas.id} schema/id/sampling mismatch`);
    }
    for (const field of ['width', 'height', 'padding']) {
        if (Number(metadata[field]) !== Number(expected[field])) {
            errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} ${field}=${metadata[field]}, expected ${expected[field]}`);
        }
    }
    if (!deepEqual(metadata.ids, expected.ids) || !deepEqual(metadata.packOrder, expected.packOrder)) {
        errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} reviewed ids or pack order changed; rebake`);
    }
    for (const [id, asset] of Object.entries(expected.assets)) {
        const actual = metadata.assets?.[id];
        if (!actual) {
            errors += fail(logger, `INVALID ATLAS METADATA: ${atlas.id} missing asset ${id}`);
            continue;
        }
        for (const field of ['sourcePath', 'sourceSize', 'anchor', 'materialClass', 'atlasFrame', 'structureMask', 'frameCount', 'baseFrameCount', 'frames']) {
            if (!deepEqual(actual[field], asset[field])) {
                errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} ${id}.${field} differs from manifest`);
            }
        }
        const sourcePath = absoluteSpritePath(root, asset.sourcePath);
        if (existsSync(sourcePath) && actual.sourceSha256 !== sha256(readFileSync(sourcePath))) {
            errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} ${id} source hash changed; rebake`);
        }
    }
    for (const [key, frame] of Object.entries(expected.frames)) {
        const actual = metadata.frames?.[key];
        if (!actual) {
            errors += fail(logger, `INVALID ATLAS METADATA: ${atlas.id} missing frame ${key}`);
            continue;
        }
        for (const field of ['rect', 'paddedRect', 'sourceRect', 'sourceSize', 'sourcePath', 'anchor', 'materialClass', 'emissive', 'occluder', 'tags', 'sidecars']) {
            if (!deepEqual(actual[field], frame[field])) {
                errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} frame ${key}.${field} differs from plan`);
            }
        }
        const sourcePath = absoluteSpritePath(root, frame.sourcePath);
        if (existsSync(sourcePath) && actual.sourceSha256 !== sha256(readFileSync(sourcePath))) {
            errors += fail(logger, `STALE ATLAS METADATA: ${atlas.id} frame ${key} source hash changed; rebake`);
        }
    }

    const channelPngs = {};
    for (const channel of channels) {
        const path = atlas.channels?.[channel];
        const absolute = absoluteSpritePath(root, path);
        if (!path || !existsSync(absolute)) {
            errors += fail(logger, `MISSING ATLAS CHANNEL: ${atlas.id}:${channel} ${relativeSpritePath(path)}`);
            continue;
        }
        try {
            const bytes = readFileSync(absolute);
            const png = PNG.sync.read(bytes);
            channelPngs[channel] = png;
            if (png.width !== metadata.width || png.height !== metadata.height) {
                errors += fail(logger, `INVALID ATLAS CHANNEL: ${atlas.id}:${channel} is ${png.width}x${png.height}, expected ${metadata.width}x${metadata.height}`);
            }
            if (metadata.channelSha256?.[channel] !== sha256(bytes)) {
                errors += fail(logger, `STALE ATLAS CHANNEL: ${atlas.id}:${channel} hash differs from metadata`);
            }
        } catch (err) {
            errors += fail(logger, `INVALID ATLAS CHANNEL: ${atlas.id}:${channel} cannot decode (${err.message})`);
        }
    }

    if (Object.keys(channelPngs).length === channels.length) {
        errors += validateFramePixels(metadata, channelPngs, logger, channels);
    }
    return { errors, warnings };
}

function validateFramePixels(metadata, channels, logger, channelNames) {
    let errors = 0;
    const materialClassMax = MATERIAL_CLASS_NAMES.length - 1;
    const primaryChannel = channelNames[0];
    const materialChannel = MATERIAL_CHANNELS[1];
    const companionChannelNames = companionChannels(channelNames);
    for (const [key, frame] of Object.entries(metadata.frames || {})) {
        const rect = frame.rect;
        const padded = frame.paddedRect;
        if (!rectInBounds(padded, metadata.width, metadata.height)
            || !rectInBounds(rect, metadata.width, metadata.height)) {
            errors += fail(logger, `INVALID ATLAS FRAME: ${key} is outside ${metadata.width}x${metadata.height}`);
            continue;
        }
        for (const [channel, png] of Object.entries(channels)) {
            if (!gutterMatches(png, rect, padded)) {
                errors += fail(logger, `ATLAS BLEED: ${key}:${channel} gutter does not extrude nearest edge pixels`);
            }
        }
        for (let y = 0; y < rect.h; y++) {
            for (let x = 0; x < rect.w; x++) {
                const ax = rect.x + x;
                const ay = rect.y + y;
                const primaryAlpha = alphaAt(channels[primaryChannel], ax, ay);
                for (const channel of companionChannelNames) {
                    if (alphaAt(channels[channel], ax, ay) > primaryAlpha) {
                        errors += fail(logger, `CHANNEL ALPHA: ${key}:${channel} extends outside ${primaryChannel} at ${x},${y}`);
                        return errors;
                    }
                }
                const materialIndex = channelAt(channels[materialChannel], ax, ay, 0);
                if (primaryAlpha > ALPHA_THRESHOLD && materialIndex > materialClassMax) {
                    errors += fail(logger, `CHANNEL MATERIAL: ${key} uses unknown class index ${materialIndex} at ${x},${y}`);
                    return errors;
                }
            }
        }
    }
    return errors;
}

function validateDeclaredSidecars(entry, root, logger, channels = MATERIAL_CHANNELS) {
    let errors = 0;
    const frames = frameSpecsForEntry(entry, channels);
    const checked = new Set();
    for (const frame of frames) {
        for (const [channel, path] of Object.entries(frame.sidecars || {})) {
            if (!path || checked.has(`${channel}:${path}`)) continue;
            checked.add(`${channel}:${path}`);
            const absolute = join(root, path);
            const albedoPath = join(root, frame.sourcePath);
            if (!existsSync(absolute)) {
                errors += fail(logger, `MISSING SIDECAR: ${entry.id}:${channel} ${path}`);
                continue;
            }
            try {
                const sidecar = PNG.sync.read(readFileSync(absolute));
                const albedo = PNG.sync.read(readFileSync(albedoPath));
                if (sidecar.width !== albedo.width || sidecar.height !== albedo.height) {
                    errors += fail(logger, `INVALID SIDECAR: ${entry.id}:${channel} is ${sidecar.width}x${sidecar.height}, albedo is ${albedo.width}x${albedo.height}`);
                    continue;
                }
                if (alphaExtends(sidecar, albedo)) {
                    errors += fail(logger, `INVALID SIDECAR: ${entry.id}:${channel} alpha extends outside albedo`);
                }
            } catch (err) {
                errors += fail(logger, `INVALID SIDECAR: ${entry.id}:${channel} cannot decode (${err.message})`);
            }
        }
    }
    return errors;
}

function validateElevation(entry, logger) {
    if (entry.elevation == null) return 0;
    const elevation = entry.elevation;
    const base = Number(typeof elevation === 'object' ? elevation.base : 0);
    const top = Number(typeof elevation === 'object' ? elevation.top : elevation);
    if (!Number.isFinite(base) || !Number.isFinite(top) || top < base) {
        return fail(logger, `INVALID MATERIAL: ${entry.id} elevation must have finite base <= top`);
    }
    if (typeof elevation === 'object' && !['sprite-px', 'world-px'].includes(elevation.unit)) {
        return fail(logger, `INVALID MATERIAL: ${entry.id} elevation.unit must be sprite-px or world-px`);
    }
    return 0;
}

function validateEmissive(entry, logger) {
    if (entry.emissive == null) return 0;
    let errors = 0;
    const strength = Number(entry.emissive?.strength ?? 0);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
        errors += fail(logger, `INVALID MATERIAL: ${entry.id} emissive.strength must be within 0..1`);
    }
    const sources = entry.emissive?.sources;
    if (!Array.isArray(sources)) return fail(logger, `INVALID MATERIAL: ${entry.id} emissive.sources must be an array`);
    const ids = sources.map((source) => source?.id).filter(Boolean);
    if (ids.length !== sources.length || new Set(ids).size !== ids.length) {
        errors += fail(logger, `INVALID MATERIAL: ${entry.id} emissive sources need unique non-empty ids`);
    }
    if (strength > 0 && sources.length === 0) {
        errors += fail(logger, `INVALID MATERIAL: ${entry.id} emissive strength requires a named semantic source`);
    }
    for (const source of sources) {
        const sourceStrength = Number(source?.strength ?? 1);
        if (!source?.geometry || !Number.isFinite(sourceStrength) || sourceStrength < 0 || sourceStrength > 1) {
            errors += fail(logger, `INVALID MATERIAL: ${entry.id} emissive source ${source?.id || '(unknown)'} needs geometry and strength within 0..1`);
        }
    }
    return errors;
}

function validateOccluder(entry, logger) {
    if (entry.occluder == null) return 0;
    const modes = new Set(['none', 'alpha-silhouette', 'authored-height']);
    let errors = modes.has(entry.occluder?.mode)
        ? 0
        : fail(logger, `INVALID MATERIAL: ${entry.id} has invalid occluder mode ${entry.occluder?.mode}`);
    const strength = Number(entry.occluder?.strength ?? 1);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
        errors += fail(logger, `INVALID MATERIAL: ${entry.id} occluder.strength must be within 0..1`);
    }
    return errors;
}

function gutterMatches(png, rect, padded) {
    for (let y = padded.y; y < padded.y + padded.h; y++) {
        for (let x = padded.x; x < padded.x + padded.w; x++) {
            if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) continue;
            const sx = Math.max(rect.x, Math.min(rect.x + rect.w - 1, x));
            const sy = Math.max(rect.y, Math.min(rect.y + rect.h - 1, y));
            if (!pixelEqual(png, x, y, sx, sy)) return false;
        }
    }
    return true;
}

function rectInBounds(rect, width, height) {
    return rect && rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0
        && rect.x + rect.w <= width && rect.y + rect.h <= height;
}

function pixelEqual(png, ax, ay, bx, by) {
    const a = (png.width * ay + ax) * 4;
    const b = (png.width * by + bx) * 4;
    return png.data[a] === png.data[b]
        && png.data[a + 1] === png.data[b + 1]
        && png.data[a + 2] === png.data[b + 2]
        && png.data[a + 3] === png.data[b + 3];
}

function alphaExtends(sidecar, albedo) {
    for (let index = 0; index < sidecar.width * sidecar.height; index++) {
        if (sidecar.data[index * 4 + 3] > albedo.data[index * 4 + 3]) return true;
    }
    return false;
}

function alphaAt(png, x, y) {
    return channelAt(png, x, y, 3);
}

function channelAt(png, x, y, channel) {
    return png.data[(png.width * y + x) * 4 + channel];
}

function absoluteSpritePath(root, path) {
    return join(root, relativeSpritePath(path));
}

function relativeSpritePath(path) {
    return String(path || '').replace(/^assets\/sprites\//, '');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function deepEqual(left, right) {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function fail(logger, message) {
    logger.error(message);
    return 1;
}
