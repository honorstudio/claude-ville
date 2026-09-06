#!/usr/bin/env node
// Tight-tolerance dark-background key-out for pixflux raws.
//
// bake-manifest.mjs's shared keyOutEdgeBackground uses an ~85-euclidean color
// tolerance. That is safe for bright subjects, but pixflux sometimes returns a
// "transparent" image whose background pixels touching the border are opaque
// near-black (26,28,35); the flood fill then eats every connected DARK subject
// pixel too — dark briar branches, shaded teal willow boughs, canopy shadow
// greens (seen on the 2026-07-17 vegetation leftover rebake, where veg.bush.b
// came back almost empty).
//
// This variant is the same border-seeded flood fill with a much tighter
// tolerance (default 36 euclidean): it clears the near-black background and
// the subject's dark anti-aliased outline, but stops at real subject pixels.
// Deterministic; reads the CACHED raw from output/pixellab-cache/bake/ (or any
// --raw= path) so prompt-level re-runs stay free.
//
// Usage:
//   node scripts/sprites/key-out-dark-bg.mjs --raw=output/pixellab-cache/bake/veg.bush.b.raw.png --out=claudeville/assets/sprites/vegetation/veg.bush.b.png [--tol=36]

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { trimAlphaFringe, writePng } from './pixellab-rest.mjs';

const args = process.argv.slice(2);
const rawArg = args.find((arg) => arg.startsWith('--raw='));
const outArg = args.find((arg) => arg.startsWith('--out='));
const tolArg = args.find((arg) => arg.startsWith('--tol='));
if (!rawArg || !outArg) {
    console.error('usage: node scripts/sprites/key-out-dark-bg.mjs --raw=<raw.png> --out=<final.png> [--tol=36]');
    process.exit(1);
}
const TOLERANCE = tolArg ? Number(tolArg.slice('--tol='.length)) : 36;
const MAX_DIST_SQ = TOLERANCE * TOLERANCE;

const src = PNG.sync.read(readFileSync(rawArg.slice('--raw='.length)));
const out = new PNG({ width: src.width, height: src.height });
src.data.copy(out.data);

const seedColors = [];
const samplePoints = [
    [0, 0],
    [Math.floor(out.width / 2), 0],
    [out.width - 1, 0],
    [0, Math.floor(out.height / 2)],
    [out.width - 1, Math.floor(out.height / 2)],
    [0, out.height - 1],
    [Math.floor(out.width / 2), out.height - 1],
    [out.width - 1, out.height - 1],
];
for (const [x, y] of samplePoints) {
    const i = (out.width * y + x) << 2;
    if (out.data[i + 3] < 220) continue;
    seedColors.push([out.data[i], out.data[i + 1], out.data[i + 2]]);
}

if (seedColors.length === 0) {
    console.log('[key-out-dark-bg] no opaque border pixels — raw already clean, copied through');
    writePng(outArg.slice('--out='.length), out);
    process.exit(0);
}

const isBackground = (x, y) => {
    const i = (out.width * y + x) << 2;
    if (out.data[i + 3] < 8) return true;
    let best = Infinity;
    for (const [r, g, b] of seedColors) {
        const dr = out.data[i] - r;
        const dg = out.data[i + 1] - g;
        const db = out.data[i + 2] - b;
        best = Math.min(best, dr * dr + dg * dg + db * db);
    }
    return best <= MAX_DIST_SQ;
};

const visited = new Uint8Array(out.width * out.height);
const queue = [];
const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const idx = y * out.width + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    if (!isBackground(x, y)) return;
    queue.push([x, y]);
};
for (let x = 0; x < out.width; x++) {
    enqueue(x, 0);
    enqueue(x, out.height - 1);
}
for (let y = 0; y < out.height; y++) {
    enqueue(0, y);
    enqueue(out.width - 1, y);
}

let cleared = 0;
while (queue.length) {
    const [x, y] = queue.pop();
    const i = (out.width * y + x) << 2;
    if (out.data[i + 3] !== 0) cleared++;
    out.data[i + 3] = 0;
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
}

const final = trimAlphaFringe(out);
writePng(outArg.slice('--out='.length), final);
console.log(`[key-out-dark-bg] seeds ${seedColors.map((c) => c.join(',')).join(' | ')} tol ${TOLERANCE}: cleared ${cleared} px -> ${outArg.slice('--out='.length)}`);
