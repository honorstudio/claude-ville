#!/usr/bin/env node

// Explicit channel-paint workflow. It never infers masks from luminance:
// reviewers provide exact rectangles/points and RGBA values.
//
//   node scripts/sprites/sidecar-mask-fix.mjs \
//     --id=building.command --channel=emissive \
//     --paint=rect:80:127:7:10:#ffd98aff --dry-run

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import {
    collectSpriteEntries,
    loadSpriteManifest,
    pathForEntry,
    spritesRoot,
} from './manifest-utils.mjs';
import {
    channelsForManifest,
    companionPathForChannel,
    companionChannels,
} from './channel-registry.mjs';

const args = process.argv.slice(2);
const id = option('id');
const channel = option('channel');
const dryRun = args.includes('--dry-run');
const paints = args.filter((arg) => arg.startsWith('--paint=')).map((arg) => parsePaint(arg.slice('--paint='.length)));
const manifest = loadSpriteManifest();
const registeredChannels = channelsForManifest(manifest);
const sidecarChannels = companionChannels(registeredChannels);
if (!id || !sidecarChannels.includes(channel) || !paints.length) {
    console.error(`usage: node scripts/sprites/sidecar-mask-fix.mjs --id=<manifest-id> --channel=<${sidecarChannels.join('|')}> --paint=rect:x:y:w:h:#rrggbbaa [--paint=point:x:y:#rrggbbaa] [--dry-run]`);
    process.exit(1);
}

const entry = collectSpriteEntries(manifest).find((candidate) => candidate.id === id);
if (!entry) throw new Error(`unknown manifest id ${id}`);
const albedoRel = pathForEntry(entry);
const albedo = PNG.sync.read(readFileSync(join(spritesRoot, albedoRel)));
const declared = companionPathForChannel(entry, channel, albedoRel);
const sidecarRel = normalizePath(declared || derivePath(albedoRel, channel));
const sidecarPath = join(spritesRoot, sidecarRel);
const sidecar = existsSync(sidecarPath)
    ? PNG.sync.read(readFileSync(sidecarPath))
    : new PNG({ width: albedo.width, height: albedo.height, colorType: 6 });
if (sidecar.width !== albedo.width || sidecar.height !== albedo.height) {
    throw new Error(`${sidecarRel} is ${sidecar.width}x${sidecar.height}; albedo is ${albedo.width}x${albedo.height}`);
}

for (const paint of paints) applyPaint(sidecar, paint);
console.log(`[sidecar-mask-fix] ${id}:${channel} ${paints.length} explicit operation(s) -> ${sidecarRel}`);
if (!declared) {
    console.log(`[sidecar-mask-fix] manifest opt-in required: add ${channel}Sidecar: true to ${id}`);
}
if (!dryRun) {
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, PNG.sync.write(sidecar));
} else {
    console.log('[sidecar-mask-fix] dry run; no file written');
}

function applyPaint(png, paint) {
    const points = [];
    if (paint.kind === 'point') points.push([paint.x, paint.y]);
    else {
        for (let y = paint.y; y < paint.y + paint.h; y++) {
            for (let x = paint.x; x < paint.x + paint.w; x++) points.push([x, y]);
        }
    }
    for (const [x, y] of points) {
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
            throw new Error(`paint coordinate ${x},${y} is outside ${png.width}x${png.height}`);
        }
        const index = (png.width * y + x) * 4;
        png.data[index] = paint.color[0];
        png.data[index + 1] = paint.color[1];
        png.data[index + 2] = paint.color[2];
        png.data[index + 3] = paint.color[3];
    }
}

function parsePaint(value) {
    const parts = value.split(':');
    const kind = parts.shift();
    if (kind === 'point' && parts.length === 3) {
        return { kind, x: integer(parts[0]), y: integer(parts[1]), color: color(parts[2]) };
    }
    if (kind === 'rect' && parts.length === 5) {
        return {
            kind,
            x: integer(parts[0]),
            y: integer(parts[1]),
            w: positive(parts[2]),
            h: positive(parts[3]),
            color: color(parts[4]),
        };
    }
    throw new Error(`invalid paint operation ${value}`);
}

function color(value) {
    const hex = String(value || '').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error(`color must be #rrggbbaa, got ${value}`);
    return [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function option(name) {
    return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
}

function integer(value) {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error(`expected integer, got ${value}`);
    return number;
}

function positive(value) {
    const number = integer(value);
    if (number <= 0) throw new Error(`expected positive integer, got ${value}`);
    return number;
}

function derivePath(albedoPath, channelName) {
    return albedoPath.replace(/\.png$/, `.${channelName}.png`);
}

function normalizePath(path) {
    return String(path).replace(/^assets\/sprites\//, '');
}
