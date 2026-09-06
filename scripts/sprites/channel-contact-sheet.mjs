#!/usr/bin/env node

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import {
    MATERIAL_CHANNELS,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    collectSpriteEntries,
    loadSpriteManifest,
    pathForEntry,
    repoRoot,
    spritesRoot,
} from './manifest-utils.mjs';
import { resolveAtlasDefinition } from './atlas-layout.mjs';
import {
    channelsForManifest,
    companionPathForChannel,
    companionChannels,
} from './channel-registry.mjs';

const CELL_CAP = 96;
const GAP = 6;
const MARGIN = 8;
const MATERIAL_PREVIEW = [
    [96, 96, 96], [138, 144, 154], [137, 90, 54], [184, 196, 208],
    [82, 146, 78], [144, 90, 155], [111, 80, 52], [123, 126, 134],
    [58, 152, 196], [170, 106, 230], [242, 132, 48],
];
const CHANNEL_PREVIEWERS = new Map([
    [MATERIAL_CHANNELS[1], previewMaterial],
    [MATERIAL_CHANNELS[3], previewOccluder],
]);
const CHANNEL_ALPHA_SCALES = new Map([
    [MATERIAL_CHANNELS[2], 4],
]);
const args = process.argv.slice(2);
const atlasId = args.find((arg) => arg.startsWith('--atlas='))?.slice('--atlas='.length) || 'world-pilot';
const sidecars = args.includes('--sidecars');
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const reviewedIds = idsArg
    ? new Set(idsArg.slice('--ids='.length).split(',').map((value) => value.trim()).filter(Boolean))
    : null;
const manifest = loadSpriteManifest();
const registeredChannels = channelsForManifest(manifest);
const channelArg = args.find((arg) => arg.startsWith('--channels='));
const channels = channelArg
    ? channelArg.slice('--channels='.length).split(',').map((value) => value.trim()).filter(Boolean)
    : registeredChannels;
const invalid = channels.filter((channel) => !registeredChannels.includes(channel));
if (invalid.length) {
    console.error(`[channel-contact-sheet] unknown channels: ${invalid.join(', ')}`);
    process.exit(1);
}

const outRoot = args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
    || join(repoRoot, 'output', 'sprite-channel-sheets');
mkdirSync(outRoot, { recursive: true });

if (sidecars) renderSidecarSheets();
else renderAtlasSheets();

function renderAtlasSheets() {
    const atlas = resolveAtlasDefinition(manifest, atlasId);
    const metadataPath = absoluteSpritePath(atlas.metadata);
    if (!existsSync(metadataPath)) {
        console.error(`[channel-contact-sheet] missing metadata ${metadataPath}; run atlas-bake first`);
        process.exit(1);
    }
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    for (const channel of channels) {
        const sourcePath = absoluteSpritePath(atlas.channels[channel]);
        const source = PNG.sync.read(readFileSync(sourcePath));
        const tiles = metadata.packOrder.map((key) => ({ key, source, rect: metadata.frames[key].rect }));
        writeSheet(`${atlas.id}.${channel}.png`, tiles, channel);
    }
}

function renderSidecarSheets() {
    const entries = collectSpriteEntries(manifest)
        .filter((entry) => !reviewedIds || reviewedIds.has(entry.id));
    for (const channel of companionChannels(registeredChannels).filter((candidate) => channels.includes(candidate))) {
        const tiles = [];
        for (const entry of entries) {
            const albedoPath = pathForEntry(entry);
            const sidecarPath = companionPathForChannel(entry, channel, albedoPath);
            if (!sidecarPath) continue;
            const absolute = absoluteSpritePath(sidecarPath);
            if (!existsSync(absolute)) continue;
            const source = PNG.sync.read(readFileSync(absolute));
            tiles.push({ key: entry.id, source, rect: { x: 0, y: 0, w: source.width, h: source.height } });
        }
        if (!tiles.length) {
            console.log(`[channel-contact-sheet] sidecars:${channel}: no declared companions, skipped`);
            continue;
        }
        writeSheet(`sidecars.${channel}.png`, tiles, channel);
    }
}

function writeSheet(filename, tiles, channel) {
    const sheet = montage(tiles, channel);
    const outputPath = join(outRoot, filename);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, PNG.sync.write(sheet));
    console.log(`[channel-contact-sheet] ${channel}: ${tiles.length} frames -> ${outputPath}`);
}

function montage(tiles, channelName) {
    const cells = tiles.map(({ key, source, rect }) => {
        const scale = Math.max(1, Math.ceil(Math.max(rect.w, rect.h) / CELL_CAP));
        return {
            key,
            source,
            rect,
            scale,
            w: Math.ceil(rect.w / scale),
            h: Math.ceil(rect.h / scale),
        };
    });
    const cellW = Math.max(...cells.map((cell) => cell.w));
    const cellH = Math.max(...cells.map((cell) => cell.h));
    const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length * cellW / cellH)));
    const rows = Math.ceil(cells.length / cols);
    const width = MARGIN * 2 + cols * cellW + (cols - 1) * GAP;
    const height = MARGIN * 2 + rows * cellH + (rows - 1) * GAP;
    const output = new PNG({ width, height, colorType: 6 });
    paintChecker(output);
    cells.forEach((cell, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = MARGIN + col * (cellW + GAP) + Math.floor((cellW - cell.w) / 2);
        const y = MARGIN + row * (cellH + GAP) + Math.floor((cellH - cell.h) / 2);
        blitNearest(output, cell.source, cell.rect, x, y, cell.scale, channelName);
    });
    return output;
}

function paintChecker(png) {
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const bright = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
            const value = bright ? 30 : 20;
            const index = (png.width * y + x) * 4;
            png.data[index] = value;
            png.data[index + 1] = value - 3;
            png.data[index + 2] = value - 6;
            png.data[index + 3] = 255;
        }
    }
}

function blitNearest(destination, source, rect, ox, oy, scale, channelName) {
    for (let y = 0; y < Math.ceil(rect.h / scale); y++) {
        for (let x = 0; x < Math.ceil(rect.w / scale); x++) {
            const sx = rect.x + Math.min(rect.w - 1, x * scale);
            const sy = rect.y + Math.min(rect.h - 1, y * scale);
            const sourceIndex = (source.width * sy + sx) * 4;
            const encodedAlpha = source.data[sourceIndex + 3];
            // Sparse authored channels can be difficult to inspect on a
            // checkerboard, so their registry preview may amplify alpha.
            const alphaScale = CHANNEL_ALPHA_SCALES.get(channelName) || 1;
            const alpha = Math.min(255, encodedAlpha * alphaScale);
            if (alpha === 0) continue;
            const destinationIndex = (destination.width * (oy + y) + ox + x) * 4;
            const t = alpha / 255;
            const preview = previewRgb(source, sourceIndex, channelName);
            for (let channel = 0; channel < 3; channel++) {
                destination.data[destinationIndex + channel] = Math.round(
                    preview[channel] * t
                    + destination.data[destinationIndex + channel] * (1 - t),
                );
            }
            destination.data[destinationIndex + 3] = 255;
        }
    }
}

function previewRgb(source, index, channelName) {
    return (CHANNEL_PREVIEWERS.get(channelName) || previewRaw)(source, index);
}

function previewRaw(source, index) {
    return [source.data[index], source.data[index + 1], source.data[index + 2]];
}

function previewMaterial(source, index) {
    return MATERIAL_PREVIEW[source.data[index]] || [255, 0, 255];
}

function previewOccluder(source, index) {
    const strength = source.data[index + 1];
    const height = source.data[index];
    return [Math.max(strength, height), strength, strength];
}

function absoluteSpritePath(path) {
    return join(spritesRoot, String(path || '').replace(/^assets\/sprites\//, ''));
}
