#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { API_BASE, readPixellabToken } from './pixellab-rest.mjs';
import {
    collectSpriteEntries,
    dimensionsForEntry,
    expectedPathsForEntry,
    inferSpriteTool,
    loadSpriteManifest,
    manifestPath,
} from './manifest-utils.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
    const index = args.findIndex((value) => value === `--${name}` || value.startsWith(`--${name}=`));
    if (index < 0) return fallback;
    return args[index].includes('=') ? args[index].slice(name.length + 3) : args[index + 1];
}
const group = option('group', 'read');
const frames = Number(option('frames', '4'));
if (!group || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(group) || !Number.isInteger(frames) || frames < 4 || frames > 16) {
    console.error('Use --group <name> --frames <integer 4–16> for a v3 production plan');
    process.exit(1);
}
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const manifest = loadSpriteManifest(manifestPath);
const entries = collectSpriteEntries(manifest);
const selectedIds = idsArg
    ? idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean)
    : entries.map((entry) => entry.id);
const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
const missing = selectedIds.filter((id) => !entriesById.has(id));
const CHARACTER_ENGINE_CELL = 92;
const CHARACTER_DIRECTIONS = 8;
const CHARACTER_ROWS = 10;
const source = readFileSync(manifestPath, 'utf8');
const inheritedIds = new Set();
let sourceId = null;
for (const line of source.split('\n')) {
    if (line.startsWith('  - id: ')) sourceId = line.slice(8).trim();
    if (/generationSize:.*unverified.*inherited default/.test(line)) inheritedIds.add(sourceId);
}
let directionJobs = 0;
let generationCost = 0;

if (missing.length) {
    console.error(`unknown manifest sprite IDs: ${missing.join(', ')}`);
    process.exit(1);
}

console.log(`Sprite plan: ${selectedIds.length} manifest-backed ID(s)`);
console.log(`Style anchor: ${manifest.style?.anchor || '(none)'}`);

for (const id of selectedIds) {
    const entry = entriesById.get(id);
    console.log('');
    console.log(id);
    console.log(`  tool: ${entry.tool || inferSpriteTool(id)}`);
    console.log(`  dimensions: ${dimensionsForEntry(entry)}`);
    if (id.startsWith('agent.')) {
        console.log(`  generation size: ${entry.generationSize}`);
        console.log(`  generation mode: ${entry.generationMode || 'standard'}`);
        console.log(`  engine cell: ${CHARACTER_ENGINE_CELL}`);
        console.log(`  expected sheet: ${CHARACTER_ENGINE_CELL * CHARACTER_DIRECTIONS}x${CHARACTER_ENGINE_CELL * CHARACTER_ROWS}`);
        for (const [name, value] of Object.entries(entry.animationGroups || {})) {
            console.log(`  group ${name}: rows ${value.rows[0]}–${value.rows[1]}`);
        }
        if (inheritedIds.has(id)) console.log('  WARNING: generation size is an unverified inherited default; verify the source record before any bake.');
        const size = entry.provenance?.generationSize ?? entry.generationSize;
        const perDirection = Math.ceil(size * size * frames / 65536);
        console.log(`  production group ${group}: ${frames} frames, ${CHARACTER_DIRECTIONS} direction jobs (s, se, e, ne, n, nw, w, sw)`);
        console.log(`  v3 generation cost: ceil(${size}*${size}*${frames}/65536) = ${perDirection}/direction; ${perDirection * CHARACTER_DIRECTIONS} generations${inheritedIds.has(id) ? ' (provisional)' : ''}`);
        console.log(`  template cost: 1/direction; ${CHARACTER_DIRECTIONS} generations (if a matching template exists)`);
        directionJobs += CHARACTER_DIRECTIONS;
        generationCost += perDirection * CHARACTER_DIRECTIONS;
    }
    for (const path of expectedPathsForEntry(entry)) {
        console.log(`  path: claudeville/assets/sprites/${path}`);
    }
    if (entry.prompt) {
        console.log(`  prompt: ${[manifest.style?.anchor, entry.prompt].filter(Boolean).join(', ')}`);
    } else if (entry.lower || entry.upper) {
        if (entry.lower) console.log(`  lower: ${[manifest.style?.anchor, entry.lower].filter(Boolean).join(', ')}`);
        if (entry.upper) console.log(`  upper: ${[manifest.style?.anchor, entry.upper].filter(Boolean).join(', ')}`);
    } else {
        console.log('  prompt: (no prompt in manifest)');
    }
}

if (directionJobs) {
    console.log(`\nProduction total: ${directionJobs} direction jobs; ${generationCost} v3 generations; ${directionJobs} template generations`);
    try {
        const response = await fetch(`${API_BASE}/balance`, {
            headers: { Authorization: `Bearer ${readPixellabToken()}` },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const balance = await response.json();
        const subscription = balance.subscription;
        if (!Number.isFinite(subscription?.generations)) throw new Error('remaining generations absent from balance response');
        console.log(`Live PixelLab balance: ${subscription.generations} / ${subscription.total} generations remaining (${subscription.plan})`);
    } catch (error) {
        console.error(`Live PixelLab balance unavailable: ${error.message}`);
        process.exitCode = 1;
    }
}
