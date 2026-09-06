#!/usr/bin/env node

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { getBuildingVisual } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import {
    defaultChannelPixel,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    createAtlasPlan,
    resolveAtlasDefinition,
    stableJson,
} from './atlas-layout.mjs';
import {
    collectSpriteEntries,
    loadSpriteManifest,
    spritesRoot,
} from './manifest-utils.mjs';

const args = process.argv.slice(2);
const atlasArg = args.find((arg) => arg.startsWith('--atlas='));
const atlasId = atlasArg?.slice('--atlas='.length) || 'world-pilot';
const dryRun = args.includes('--dry-run');
if (args.some((arg) => arg.startsWith('--ids='))) {
    console.error('[atlas-bake] --ids is intentionally unsupported: bake the reviewed ids declared by the atlas manifest entry');
    process.exit(1);
}

const manifest = loadSpriteManifest();
const atlas = resolveAtlasDefinition(manifest, atlasId);
const plan = createAtlasPlan(manifest, atlas);
const channels = Object.keys(plan.channels);
const primaryChannel = channels[0];
const emissiveChannel = channels[2];
const occluderChannel = channels[3];
if (dryRun) {
    console.log(`[atlas-bake] dry run ${plan.id}: ${plan.ids.length} ids, ${Object.keys(plan.frames).length} frames, ${plan.width}x${plan.height}`);
    for (const [channel, path] of Object.entries(plan.channels)) {
        console.log(`  ${channel}: ${path}`);
    }
    process.exit(0);
}

const entriesById = new Map(collectSpriteEntries(manifest).map((entry) => [entry.id, entry]));
const sourceCache = new Map();
const sourceHashes = new Map();
const outputs = Object.fromEntries(channels.map((channel) => [
    channel,
    new PNG({ width: plan.width, height: plan.height, colorType: 6 }),
]));

for (const key of plan.packOrder) {
    const frame = plan.frames[key];
    const albedo = readSource(frame.sourcePath);
    assertSourceDimensions(key, albedo, frame.sourceSize);
    const companions = {};
    for (const channel of channels) {
        if (channel === primaryChannel) continue;
        const path = frame.sidecars?.[channel];
        if (!path) continue;
        if (!existsSync(join(spritesRoot, path))) {
            throw new Error(`${key} declares missing ${channel} sidecar ${path}`);
        }
        companions[channel] = readSource(path);
        assertSourceDimensions(`${key}:${channel}`, companions[channel], frame.sourceSize);
    }
    for (const channel of channels) {
        blitFrame({
            destination: outputs[channel],
            source: channel === primaryChannel ? albedo : companions[channel] || null,
            albedo,
            frame,
            channel,
            primaryChannel,
            emissiveChannel,
            occluderChannel,
            entry: entriesById.get(frameAssetId(key, frame, plan)),
            padding: plan.padding,
        });
    }
    frame.sourceSha256 = sourceHash(frame.sourcePath);
}

const channelHashes = {};
for (const channel of channels) {
    const declaredPath = plan.channels[channel];
    if (!declaredPath) throw new Error(`atlas ${plan.id} does not declare ${channel} output`);
    const bytes = PNG.sync.write(outputs[channel], { colorType: 6 });
    const outputPath = absoluteSpritePath(declaredPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes);
    channelHashes[channel] = sha256(bytes);
    console.log(`[atlas-bake] ${channel}: ${relativeSpritePath(declaredPath)} (${bytes.length} bytes)`);
}

for (const [id, asset] of Object.entries(plan.assets)) {
    asset.sourceSha256 = sourceHash(asset.sourcePath);
    asset.emissiveSources = (entriesById.get(id)?.emissive?.sources || []).map((source) => source.id);
}
plan.channelSha256 = channelHashes;
plan.generator = 'scripts/sprites/atlas-bake.mjs';
const metadataPath = absoluteSpritePath(atlas.metadata);
mkdirSync(dirname(metadataPath), { recursive: true });
writeFileSync(metadataPath, stableJson(plan));
console.log(`[atlas-bake] metadata: ${relativeSpritePath(atlas.metadata)}`);
console.log(`[atlas-bake] done: ${plan.ids.length} ids, ${Object.keys(plan.frames).length} frames, ${plan.width}x${plan.height}`);

function blitFrame({ destination, source, albedo, frame, channel, primaryChannel, emissiveChannel, occluderChannel, entry, padding }) {
    const { rect } = frame;
    for (let y = -padding; y < rect.h + padding; y++) {
        for (let x = -padding; x < rect.w + padding; x++) {
            const localX = clamp(x, 0, rect.w - 1);
            const localY = clamp(y, 0, rect.h - 1);
            const sourceX = frame.sourceRect.x + localX;
            const sourceY = frame.sourceRect.y + localY;
            const albedoPixel = pixelAt(albedo, sourceX, sourceY);
            const rgba = source
                ? pixelAt(source, sourceX, sourceY)
                : generatedChannelPixel(channel, frame, entry, sourceX, sourceY, albedoPixel, {
                    primaryChannel,
                    emissiveChannel,
                    occluderChannel,
                });
            setPixel(destination, rect.x + x, rect.y + y, rgba);
        }
    }
}

function generatedChannelPixel(channel, frame, entry, sourceX, sourceY, albedoPixel, {
    primaryChannel,
    emissiveChannel,
    occluderChannel,
}) {
    const alpha = albedoPixel[3];
    if (channel === emissiveChannel) {
        const strength = semanticEmissiveStrength(frame, entry, sourceX, sourceY);
        if (strength <= 0 || alpha === 0) return [0, 0, 0, 0];
        return [
            albedoPixel[0],
            albedoPixel[1],
            albedoPixel[2],
            Math.round(alpha * strength),
        ];
    }
    if (channel === occluderChannel && frame.occluder?.mode === 'none') return [0, 0, 0, 0];
    if (channel === primaryChannel) return albedoPixel;
    return defaultChannelPixel(channel, frame.materialClass, alpha);
}

// Seed masks from declared semantic sources and existing registry anchors.
// This deliberately does not infer emission from luminance.
function semanticEmissiveStrength(frame, entry, x, y) {
    const sources = frame.emissive?.sources || [];
    if (!sources.length) return frame.materialClass === 'fire' ? 1 : 0;
    let strength = 0;
    for (const source of sources) {
        const geometry = String(source.geometry || '');
        const sourceStrength = clamp(Number(source.strength ?? 1), 0, 1);
        if (geometry === 'authored-albedo') strength = Math.max(strength, sourceStrength);
        if (geometry === 'lightSource' && pointHit(entry?.lightSource, x, y, 6)) {
            strength = Math.max(strength, sourceStrength);
        }
        if (geometry.startsWith('emitters.') && pointHit(entry?.emitters?.[geometry.slice('emitters.'.length)], x, y, 5)) {
            strength = Math.max(strength, sourceStrength);
        }
        if (geometry === 'registry.windowRects') {
            const type = entry?.id?.replace(/^building\./, '');
            const rects = getBuildingVisual(type)?.windowRects || [];
            if (rects.some((candidate) => rectHit(candidate, x, y))) strength = Math.max(strength, sourceStrength);
        }
        if (geometry.startsWith('registry.effectAnchors.')) {
            const type = entry?.id?.replace(/^building\./, '');
            const key = geometry.slice('registry.effectAnchors.'.length);
            const anchor = getBuildingVisual(type)?.effectAnchors?.[key];
            if (objectPointHit(anchor, x, y, 7)) strength = Math.max(strength, sourceStrength);
        }
    }
    return strength;
}

function rectHit(candidate, x, y) {
    const at = candidate?.at;
    if (!Array.isArray(at)) return false;
    const w = Math.max(1, Number(candidate.w) || 1);
    const h = Math.max(1, Number(candidate.h) || 1);
    return x >= at[0] && x < at[0] + w && y >= at[1] && y < at[1] + h;
}

function pointHit(point, x, y, radius) {
    return Array.isArray(point)
        && Math.abs(x - Number(point[0])) <= radius
        && Math.abs(y - Number(point[1])) <= radius;
}

function objectPointHit(value, x, y, radius) {
    if (!value || typeof value !== 'object') return false;
    for (const candidate of Object.values(value)) {
        if (pointHit(candidate, x, y, radius)) return true;
        if (candidate && typeof candidate === 'object' && objectPointHit(candidate, x, y, radius)) return true;
    }
    return false;
}

function frameAssetId(key, frame, atlasPlan) {
    for (const id of atlasPlan.ids) {
        if (atlasPlan.assets[id]?.frames?.includes(key)) return id;
    }
    return frame.assetId || key;
}

function readSource(path) {
    if (sourceCache.has(path)) return sourceCache.get(path);
    const absolute = join(spritesRoot, path);
    if (!existsSync(absolute)) throw new Error(`missing source ${path}`);
    const bytes = readFileSync(absolute);
    const png = PNG.sync.read(bytes);
    sourceCache.set(path, png);
    sourceHashes.set(path, sha256(bytes));
    return png;
}

function sourceHash(path) {
    if (!sourceHashes.has(path)) readSource(path);
    return sourceHashes.get(path);
}

function assertSourceDimensions(label, png, expected) {
    if (png.width !== expected.w || png.height !== expected.h) {
        throw new Error(`${label} source is ${png.width}x${png.height}; expected ${expected.w}x${expected.h}`);
    }
}

function absoluteSpritePath(path) {
    return join(spritesRoot, relativeSpritePath(path));
}

function relativeSpritePath(path) {
    return String(path).replace(/^assets\/sprites\//, '');
}

function pixelAt(png, x, y) {
    const index = (png.width * y + x) * 4;
    return [png.data[index], png.data[index + 1], png.data[index + 2], png.data[index + 3]];
}

function setPixel(png, x, y, rgba) {
    const index = (png.width * y + x) * 4;
    png.data[index] = rgba[0];
    png.data[index + 1] = rgba[1];
    png.data[index + 2] = rgba[2];
    png.data[index + 3] = rgba[3];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
