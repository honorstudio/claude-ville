#!/usr/bin/env node
// Manifest-driven bulk bake (visual-quality plan cross-cutting): rebake sprite
// PNGs straight from manifest.yaml entries — prompt = style.anchor + entry
// prompt, dimensions from the entry, output at the manifest-implied path.
//
// This is the supported bulk-rebake path the repo was missing (broken assets
// lingered because regenerating meant hand-writing one-off scripts).
//
//   node scripts/sprites/bake-manifest.mjs --ids=prop.well,prop.runestone
//   node scripts/sprites/bake-manifest.mjs --ids=building.portal.portalGlow --force
//   node scripts/sprites/bake-manifest.mjs --ids=prop.well --dry-run
//
// Building overlay layers are addressed as `<building-id>.<layer-name>` and
// land at buildings/<building-id>/<layer>.png. Raw API responses are cached in
// output/pixellab-cache/bake/ so prompt tweaks + re-runs stay free; --force
// ignores the cache. Characters and terrain tilesets are intentionally out of
// scope (different generation surfaces).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
    collectSpriteEntries,
    expectedPathsForEntry,
    loadSpriteManifest,
    spritesRoot,
} from './manifest-utils.mjs';
import {
    hashSeed,
    keyOutEdgeBackground,
    pixflux,
    readPixellabToken,
    repoRoot,
    resizeNearest,
    sleep,
    writePng,
} from './pixellab-rest.mjs';

const cacheRoot = join(repoRoot, 'output', 'pixellab-cache', 'bake');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const ids = idsArg
    ? idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean)
    : [];

if (!ids.length) {
    console.error('usage: node scripts/sprites/bake-manifest.mjs --ids=<manifest-id>[,<manifest-id>...] [--force] [--dry-run]');
    console.error('building overlay layers: --ids=building.<id>.<layerName>');
    process.exit(1);
}

const manifest = loadSpriteManifest();
const styleAnchor = manifest?.style?.anchor || '';
const entries = collectSpriteEntries(manifest);

const specs = ids.map((id) => resolveSpec(id));
if (dryRun) {
    console.log(`[bake] dry run: ${specs.length} bake(s)`);
    for (const spec of specs) {
        console.log(`[bake] ${spec.id}`);
        console.log(`       path: ${spec.relPath}  (${spec.width}x${spec.height})  seed ${spec.seed}`);
        console.log(`       prompt: ${spec.description}`);
    }
    process.exit(0);
}

const token = readPixellabToken();
const results = [];
for (const spec of specs) {
    try {
        results.push(await bakeOne(token, spec));
    } catch (err) {
        console.error(`[bake] FAILED ${spec.id}: ${err.message}`);
        results.push({ id: spec.id, ok: false, error: err.message });
    }
    // Gentle pacing so a bulk run does not trip the concurrency limits.
    await sleep(1200);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
    console.log(`[bake] ${r.ok ? 'OK  ' : 'FAIL'} ${r.id}${r.ok ? ` -> ${r.relPath} (${r.bytes}B)` : ` (${r.error})`}`);
}
console.log(`[bake] done: ${results.length - failed.length} ok, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

function resolveSpec(id) {
    const direct = entries.find((entry) => entry.id === id);
    if (direct) {
        const relPath = expectedPathsForEntry(direct)[0];
        if (!relPath) throw new Error(`${id}: manifest entry has no implied PNG path`);
        const { width, height } = dimensionsFor(direct, id);
        return {
            id,
            relPath,
            width,
            height,
            seed: hashSeed(id),
            description: joinPrompt(direct.prompt),
        };
    }

    // Building overlay layer addressing: <building-id>.<layer-name>.
    const building = entries.find((entry) => entry.id?.startsWith('building.') && id.startsWith(`${entry.id}.`));
    if (building) {
        const layerName = id.slice(building.id.length + 1);
        const layer = building.layers?.[layerName];
        if (!layer) throw new Error(`${id}: building ${building.id} has no layer "${layerName}"`);
        const { width, height } = dimensionsFor(layer, id);
        return {
            id,
            relPath: `buildings/${building.id}/${layerName}.png`,
            width,
            height,
            seed: hashSeed(id),
            description: joinPrompt(layer.prompt),
        };
    }

    throw new Error(`${id}: no such manifest id (or building layer)`);
}

function dimensionsFor(entry, id) {
    if (id.startsWith('agent.')) {
        throw new Error(`${id}: character sheets are out of scope for bake-manifest (use the character pipeline)`);
    }
    if (entry.tool === 'tileset') {
        throw new Error(`${id}: terrain tilesets are out of scope for bake-manifest (Wang sets need create_topdown_tileset)`);
    }
    const width = Number(entry.width ?? entry.size);
    const height = Number(entry.height ?? entry.size);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`${id}: manifest entry needs size or width/height to bake`);
    }
    if (width > 400 || height > 400) {
        throw new Error(`${id}: pixflux caps at 400px (${width}x${height} requested)`);
    }
    return { width, height };
}

function joinPrompt(prompt) {
    if (!prompt) throw new Error('manifest entry has no prompt to bake from');
    return [styleAnchor, prompt].filter(Boolean).join(', ');
}

async function bakeOne(token, spec) {
    const cacheKey = `${spec.id}.raw.png`;
    const cachePath = join(cacheRoot, cacheKey);
    let raw;
    if (!force && existsSync(cachePath)) {
        raw = PNG.sync.read(readFileSync(cachePath));
        console.log(`[bake] cached raw for ${spec.id}`);
    } else {
        console.log(`[bake] generating ${spec.id} (${spec.width}x${spec.height})`);
        raw = await pixflux(token, {
            description: spec.description,
            width: spec.width,
            height: spec.height,
            transparent: true,
            seed: spec.seed,
            label: spec.id,
        });
        writePng(cachePath, raw);
    }
    const keyed = keyOutEdgeBackground(raw);
    const final = resizeNearest(keyed, spec.width, spec.height);
    const outPath = join(spritesRoot, spec.relPath);
    writePng(outPath, final);
    const { size } = statSync(outPath);
    return { id: spec.id, ok: true, relPath: spec.relPath, bytes: size };
}
