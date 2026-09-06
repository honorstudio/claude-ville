#!/usr/bin/env node
// Terrain Wang tileset rebake driver (visual-quality plan 2.5).
//
// Regenerates the six `tool: tileset` terrain sheets via the PixelLab v2 REST
// endpoint POST /create-tileset (async; polled via GET /tilesets/{id}). Each
// generation returns 16 corner-labelled Wang tiles (wang_0..wang_15, corner
// bits SE=1 SW=2 NE=4 NW=8) which are stitched into the app's 128x128 sheet:
// 16 cells of 32px, cell index = the app's Wang 4-bit edge mask
// (bit 0 = N upper neighbour, 1 = E, 2 = S, 3 = W; see TerrainTileset.js).
//
// Mask → corner-tile mapping (edge-OR rule): a corner is upper iff either of
// its adjacent edge bits is set (NW = N|W, NE = N|E, SW = S|W, SE = S|E).
// Rationale, verified against live captures: a lower tile beside upper gets
// the upper band encroaching from that edge, an upper tile with mostly upper
// neighbours collapses to the full-upper tile, and shared edges then always
// agree on terrain colour (seamless straight boundaries; bends carry their
// fringe on the neighbouring lower tiles).
//
// Usage:
//   node scripts/sprites/bake-terrain.mjs                 # bake all six (cache-aware)
//   node scripts/sprites/bake-terrain.mjs --ids=terrain.grass-dirt
//   node scripts/sprites/bake-terrain.mjs --force         # ignore raw cache, regenerate
//   node scripts/sprites/bake-terrain.mjs --dry-run       # print plan, no API calls
//   node scripts/sprites/bake-terrain.mjs --seed-offset=1 # shift seeds (retry variation)
//
// Raw API responses cache to output/pixellab-cache/terrain/<id>.json so
// re-assembly/validation never costs a second generation. Review the printed
// per-sheet checks; reject (re-run with --force --seed-offset=N) sheets with
// flat fills, off-palette hues, transparent patches, or corner/grid mismatch.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
    createTopdownTileset,
    hashSeed,
    readPixellabToken,
    repoRoot,
    writePng,
} from './pixellab-rest.mjs';
import { loadSpriteManifest } from './manifest-utils.mjs';

const CACHE_DIR = join(repoRoot, 'output', 'pixellab-cache', 'terrain');
const SPRITES_ROOT = join(repoRoot, 'claudeville', 'assets', 'sprites');
const TILE = 32;
const GRID = 4;

// Family reference colours sampled from the pre-rebake sheets (cell 0 = lower,
// cell 15 = upper, 24px centre patch). On-family guard: mean colour of the
// homogeneous tiles must stay within HUE_TOLERANCE of these references.
const FAMILY_REFS = {
    'terrain.grass-dirt': { lower: [86, 99, 49], upper: [114, 72, 42] },
    'terrain.grass-cobble': { lower: [74, 108, 71], upper: [86, 91, 90] },
    'terrain.grass-shore': { lower: [118, 139, 83], upper: [177, 152, 103] },
    'terrain.shore-shallow': { lower: [121, 162, 130], upper: [46, 165, 157] },
    'terrain.shallow-deep': { lower: [41, 121, 135], upper: [24, 69, 111] },
    'terrain.cobble-square': { lower: [101, 101, 91], upper: [128, 120, 99] },
};
const HUE_TOLERANCE = 60;
const FLAT_STDDEV_MIN = 12;      // luminance stddev below this reads as a flat fill
const MIN_OPAQUE_FRACTION = 0.98;

// Driver-side prompt steering per id (manifest descriptions stay untouched).
// Appended after the manifest lower/upper text on retries to pull generations
// away from observed failure modes: masonry/brick patterning on organic
// ground, blue-violet hue drift on stone, dark flat grass, flat water, and
// tiled wave-crest pictograms on open water (detailed shading bevels each
// motif into wallpaper — water sets drop to medium shading instead).
const PROMPT_SUFFIXES = {
    'terrain.grass-dirt': {
        lower: ', vivid bright olive-green meadow, varied painterly texture',
    },
    'terrain.grass-cobble': {
        lower: ', vivid bright olive-green meadow, varied painterly texture',
        upper: ', muted soft grey-blue stone hues, irregular rounded organic cobbles, avoid brick pattern, avoid purple and blue-violet hues',
    },
    'terrain.grass-shore': {
        lower: ', vivid bright olive-green meadow, varied painterly texture',
        upper: ', smooth uniform pale golden beach sand, fine sand grain only, no pebbles, no stones, no mosaic, warm tan hues',
    },
    'terrain.cobble-square': {
        lower: ', muted soft grey-blue stone hues, irregular rounded organic cobbles, avoid brick pattern, avoid red hues',
        upper: ', large irregular worn flagstones, soft warm grey-tan hues, low-contrast joints, avoid brick pattern, avoid red hues',
    },
};

// Per-id full description overrides, used only where the manifest wording
// repeatedly steered the tileset model into failure modes (documented in
// output/pixellab-cache/terrain/*.json request history). The style anchor
// still prefixes these. Water sets: the manifest's "sandy bed / wavelets"
// language made the model render beige mosaic (bed showing through) and
// tiled wave pictograms; these overrides ask for one continuous painterly
// water surface instead.
const DESCRIPTION_OVERRIDES = {
    'terrain.grass-dirt': {
        // Manifest "pebble specks / wheel-worn" text kept rolling brick
        // masonry (rounds 1 & 3); ask for one continuous soil surface.
        upper: 'soft bare earth ground, loose soil with fine painterly grain, warm tan-brown tones, subtle footprints and rake marks, continuous natural ground, no stones, no pattern',
    },
    'terrain.shore-shallow': {
        lower: 'pale wet harbor sand, smooth glossy sand bar, soft cream and tan tones, subtle painterly texture, continuous surface',
        // Mirrors the winning cobalt phrasing (round 3/4 deep water) in a
        // pale turquoise register; "ripple/wave" wording rolled scallop and
        // bubble pictograms in rounds 1-4.
        upper: 'pale clear turquoise sea, smooth continuous water surface, subtle lighter current streaks, soft painterly shading, calm muted tones',
    },
    'terrain.shallow-deep': {
        lower: 'light turquoise sea, smooth continuous water surface, subtle lighter current streaks, soft painterly shading, calm muted tones',
        upper: 'deep cobalt open sea, smooth continuous water surface, subtle darker current streaks, soft painterly wave shading, calm muted tones',
    },
};

// Per-id reference images (winning tiles salvaged from earlier rounds, cached
// under output/pixellab-cache/terrain/refs/). They pin the texture style and
// hue family that the text-only prompts kept missing, per terrain family.
const REFERENCE_IMAGES = {
    'terrain.grass-dirt': {
        lower: 'grass-dirt-tiles/wang_0.png',   // round-1 rich flower meadow
        upper: 'refs/soil-brown.png',           // round-5 grain, hue-shifted to warm soil
    },
    'terrain.grass-shore': {
        lower: 'grass-dirt-tiles/wang_0.png',   // round-1 rich flower meadow
        upper: 'refs/sand-warm-tan.png',        // round-4 fine-grain sand
    },
    'terrain.shore-shallow': {
        lower: 'refs/sand-cream.png',           // round-4 pale sand bar
        upper: 'refs/water-turquoise.png',      // round-5 calm turquoise shallows
    },
    'terrain.shallow-deep': {
        upper: 'refs/water-cobalt.png',         // round-4 calm cobalt
    },
};

// Per-id request overrides (none currently: detailed shading won on land and
// the medium-shading water experiment produced geometric motif tiles, so all
// sets bake with the helper defaults).
const SETTINGS_OVERRIDES = {};

const args = process.argv.slice(2);
const argValue = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const IDS = argValue('ids')?.split(',').map((s) => s.trim()).filter(Boolean) || null;
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const SEED_OFFSET = Number(argValue('seed-offset') || 0);

// Corner bits in PixelLab's wang_N packing.
const CORNER_BITS = { SE: 1, SW: 2, NE: 4, NW: 8 };
// App edge-mask bits (TerrainTileset.js): N=1, E=2, S=4, W=8.
const EDGE_TO_CORNERS = [
    ['N', ['NW', 'NE']],
    ['E', ['NE', 'SE']],
    ['S', ['SW', 'SE']],
    ['W', ['NW', 'SW']],
];

function wangIndexFromCorners(corners) {
    let index = 0;
    for (const [corner, bit] of Object.entries(CORNER_BITS)) {
        if (corners?.[corner] === 'upper') index |= bit;
    }
    return index;
}

// Edge-OR rule: cell mask m → wang index whose corners cover the set edges.
function wangIndexForMask(mask) {
    let index = 0;
    EDGE_TO_CORNERS.forEach(([, corners], edgeBit) => {
        if (!(mask & (1 << edgeBit))) return;
        for (const corner of corners) index |= CORNER_BITS[corner];
    });
    return index;
}

function decodeTileImage(tile) {
    const raw = tile.image?.base64
        || tile.image?.image_data?.replace(/^data:image\/png;base64,/, '')
        || tile.image_data?.replace(/^data:image\/png;base64,/, '');
    if (!raw) throw new Error(`tile ${tile.name} has no image payload`);
    return PNG.sync.read(Buffer.from(raw, 'base64'));
}

function meanColor(png) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
    return [r / n, g / n, b / n];
}

function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function luminanceStddev(png) {
    const values = [];
    for (let i = 0; i < png.data.length; i += 4) {
        values.push(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
    }
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    return Math.sqrt(values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / values.length);
}

function opaqueFraction(png) {
    let opaque = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 200) opaque++;
    return opaque / (png.width * png.height);
}

// Fraction of pixels in a corner patch closer to the upper reference colour
// than the lower one. Used to verify each tile honours its declared corners
// (grid alignment check — a mis-sliced tile fails here).
function cornerUpperFraction(png, corner, lowerRef, upperRef) {
    const N = 12;
    const x0 = corner.includes('E') ? png.width - N : 0;
    const y0 = corner.includes('S') ? png.height - N : 0;
    let upper = 0;
    for (let y = y0; y < y0 + N; y++) {
        for (let x = x0; x < x0 + N; x++) {
            const i = (png.width * y + x) << 2;
            const c = [png.data[i], png.data[i + 1], png.data[i + 2]];
            if (colorDistance(c, upperRef) < colorDistance(c, lowerRef)) upper++;
        }
    }
    return upper / (N * N);
}

async function bakeEntry(entry, token) {
    const id = entry.id;
    const cachePath = join(CACHE_DIR, `${id}.json`);
    let payload = null;

    if (!FORCE && existsSync(cachePath)) {
        payload = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log(`[${id}] reusing cached raw response (${payload.tiles?.length ?? '?'} tiles)`);
        if (DRY_RUN) {
            console.log(`[${id}] DRY RUN — would assemble from cache, no write`);
            return { id, dryRun: true };
        }
    } else {
        const manifest = loadSpriteManifest();
        const anchor = manifest?.style?.anchor;
        if (!anchor) throw new Error('manifest style.anchor missing');
        const suffix = PROMPT_SUFFIXES[id] || {};
        const overrides = DESCRIPTION_OVERRIDES[id] || {};
        if (overrides.lower || overrides.upper) {
            console.log(`[${id}] using driver-side description override (manifest wording kept in manifest)`);
        }
        const references = REFERENCE_IMAGES[id] || {};
        const readReference = (rel) => readFileSync(join(CACHE_DIR, rel)).toString('base64');
        const request = {
            lowerDescription: `${anchor}, ${overrides.lower || entry.lower}${suffix.lower || ''}`,
            upperDescription: `${anchor}, ${overrides.upper || entry.upper}${suffix.upper || ''}`,
            tileSize: TILE,
            seed: hashSeed(id) + SEED_OFFSET,
            ...(SETTINGS_OVERRIDES[id] || {}),
        };
        if (references.lower) request.lowerReferenceImage = readReference(references.lower);
        if (references.upper) request.upperReferenceImage = readReference(references.upper);
        if (DRY_RUN) {
            console.log(`[${id}] DRY RUN — would POST /create-tileset`);
            console.log(`  lower: ${request.lowerDescription}`);
            console.log(`  upper: ${request.upperDescription}`);
            console.log(`  seed: ${request.seed}`);
            return { id, dryRun: true };
        }
        console.log(`[${id}] generating (1 generation, seed ${request.seed})...`);
        const result = await createTopdownTileset(token, { ...request, label: id });
        payload = { createdAt: new Date().toISOString(), request, ...result };
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(payload, null, 1));
    }

    // ── Assemble ──────────────────────────────────────────────────────────
    const tiles = payload.tiles;
    if (!Array.isArray(tiles) || tiles.length !== 16) {
        throw new Error(`${id}: expected 16 tiles, got ${tiles?.length}`);
    }
    const byWangIndex = new Map();
    for (const tile of tiles) {
        const index = wangIndexFromCorners(tile.corners);
        if (byWangIndex.has(index)) throw new Error(`${id}: duplicate corner combo in ${tile.name}`);
        byWangIndex.set(index, tile);
    }
    if (byWangIndex.size !== 16) throw new Error(`${id}: corner combos do not cover all 16 Wang variants`);

    const decoded = new Map();
    for (const [index, tile] of byWangIndex) {
        const png = decodeTileImage(tile);
        if (png.width !== TILE || png.height !== TILE) {
            throw new Error(`${id}: tile ${tile.name} is ${png.width}x${png.height}, expected ${TILE}x${TILE}`);
        }
        decoded.set(index, png);
    }

    // ── Validate ──────────────────────────────────────────────────────────
    const problems = [];
    const lowerRef = meanColor(decoded.get(0));
    const upperRef = meanColor(decoded.get(15));
    const family = FAMILY_REFS[id];
    if (family) {
        const dLower = colorDistance(lowerRef, family.lower);
        const dUpper = colorDistance(upperRef, family.upper);
        console.log(`[${id}] family distance lower ${dLower.toFixed(1)} upper ${dUpper.toFixed(1)} (tolerance ${HUE_TOLERANCE})`);
        if (dLower > HUE_TOLERANCE) problems.push(`lower tile off-palette (distance ${dLower.toFixed(1)})`);
        if (dUpper > HUE_TOLERANCE) problems.push(`upper tile off-palette (distance ${dUpper.toFixed(1)})`);
    }

    let minStddev = Infinity;
    let minOpaque = 1;
    for (const [index, png] of decoded) {
        const stddev = luminanceStddev(png);
        const opaque = opaqueFraction(png);
        minStddev = Math.min(minStddev, stddev);
        minOpaque = Math.min(minOpaque, opaque);
        if (stddev < FLAT_STDDEV_MIN) problems.push(`wang_${index} looks flat (lum stddev ${stddev.toFixed(1)})`);
        if (opaque < MIN_OPAQUE_FRACTION) problems.push(`wang_${index} has transparent patches (${(opaque * 100).toFixed(1)}% opaque)`);
        // Corner/grid alignment: declared corners must match measured content.
        for (const corner of Object.keys(CORNER_BITS)) {
            const declaredUpper = (index & CORNER_BITS[corner]) !== 0;
            const measured = cornerUpperFraction(png, corner, lowerRef, upperRef);
            if (declaredUpper && measured < 0.5) problems.push(`wang_${index} corner ${corner} declared upper but measured ${(measured * 100).toFixed(0)}%`);
            if (!declaredUpper && measured > 0.5) problems.push(`wang_${index} corner ${corner} declared lower but measured ${(measured * 100).toFixed(0)}%`);
        }
    }
    console.log(`[${id}] min lum stddev ${minStddev.toFixed(1)}, min opaque ${(minOpaque * 100).toFixed(1)}%`);

    // ── Stitch the 128x128 sheet: cell index = app edge mask ─────────────
    const sheet = new PNG({ width: TILE * GRID, height: TILE * GRID, colorType: 6 });
    for (let mask = 0; mask < 16; mask++) {
        const src = decoded.get(wangIndexForMask(mask));
        const ox = (mask % GRID) * TILE;
        const oy = Math.floor(mask / GRID) * TILE;
        for (let y = 0; y < TILE; y++) {
            for (let x = 0; x < TILE; x++) {
                const si = (src.width * y + x) << 2;
                const di = (sheet.width * (oy + y) + (ox + x)) << 2;
                sheet.data[di] = src.data[si];
                sheet.data[di + 1] = src.data[si + 1];
                sheet.data[di + 2] = src.data[si + 2];
                sheet.data[di + 3] = src.data[si + 3];
            }
        }
    }

    const outPath = join(SPRITES_ROOT, 'terrain', id, 'sheet.png');
    writePng(outPath, sheet);
    const verdict = problems.length ? 'REVIEW' : 'PASS';
    console.log(`[${id}] sheet written -> ${outPath} [${verdict}]`);
    for (const problem of problems) console.log(`  ! ${problem}`);
    return { id, problems, outPath };
}

const manifest = loadSpriteManifest();
const entries = (manifest.terrain || []).filter((e) => e.tool === 'tileset' && (!IDS || IDS.includes(e.id)));
if (!entries.length) {
    console.error('no matching terrain tileset entries' + (IDS ? ` for --ids=${IDS.join(',')}` : ''));
    process.exit(1);
}
console.log(`bake-terrain: ${entries.length} sheet(s)${FORCE ? ' [force]' : ''}${DRY_RUN ? ' [dry-run]' : ''}${SEED_OFFSET ? ` [seed-offset ${SEED_OFFSET}]` : ''}`);

const token = DRY_RUN ? null : readPixellabToken();
const results = [];
for (const entry of entries) {
    results.push(await bakeEntry(entry, token));
}
const flagged = results.filter((r) => r.problems?.length);
console.log(`done: ${results.length} sheet(s), ${flagged.length} flagged for review`);
if (flagged.length) process.exitCode = 2;
