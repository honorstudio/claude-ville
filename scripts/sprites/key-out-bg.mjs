#!/usr/bin/env node
// Key out the flat background of a building sprite PNG to transparency.
//
// MCP `create_map_object` downloads arrive FLATTENED onto a solid grey matte
// (alpha fully opaque) rather than transparent. This tool reproduces the
// edge-seeded flood-fill + fringe trim from generate-pixellab-revamp.mjs's
// keyOutEdgeBackground so MCP-baked buildings match the transparent REST ones.
//
// Usage: node scripts/sprites/key-out-bg.mjs <file.png> [<file2.png> ...]
// Edits each file in place. Flood-fill is seeded from the image border, so it
// only clears the connected background and stops at the building outline.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';

function clonePng(src) {
    const out = new PNG({ width: src.width, height: src.height });
    src.data.copy(out.data);
    return out;
}

function sampleEdgeBackgroundColors(png) {
    const samples = [];
    const points = [
        [0, 0],
        [Math.floor(png.width / 2), 0],
        [png.width - 1, 0],
        [0, Math.floor(png.height / 2)],
        [png.width - 1, Math.floor(png.height / 2)],
        [0, png.height - 1],
        [Math.floor(png.width / 2), png.height - 1],
        [png.width - 1, png.height - 1],
    ];
    for (const [x, y] of points) {
        const i = (png.width * y + x) << 2;
        if (png.data[i + 3] < 220) continue;
        samples.push([png.data[i], png.data[i + 1], png.data[i + 2]]);
    }
    return samples;
}

function isBackgroundPixel(png, x, y, seedColors) {
    const i = (png.width * y + x) << 2;
    if (png.data[i + 3] < 8) return true;
    let best = Infinity;
    for (const [r, g, b] of seedColors) {
        const dr = png.data[i] - r;
        const dg = png.data[i + 1] - g;
        const db = png.data[i + 2] - b;
        best = Math.min(best, dr * dr + dg * dg + db * db);
    }
    return best <= 85 * 85 * 3;
}

function trimAlphaFringe(png) {
    const out = clonePng(png);
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (png.width * y + x) << 2;
            if (png.data[i + 3] === 0) continue;
            let transparentNeighbor = false;
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
                if (nx < 0 || ny < 0 || nx >= png.width || ny >= png.height) continue;
                const ni = (png.width * ny + nx) << 2;
                if (png.data[ni + 3] === 0) transparentNeighbor = true;
            }
            if (!transparentNeighbor) continue;
            out.data[i] = Math.max(0, Math.round(out.data[i] * 0.82));
            out.data[i + 1] = Math.max(0, Math.round(out.data[i + 1] * 0.82));
            out.data[i + 2] = Math.max(0, Math.round(out.data[i + 2] * 0.82));
        }
    }
    return out;
}

function keyOutEdgeBackground(src) {
    const out = clonePng(src);
    const edgeSeedColors = sampleEdgeBackgroundColors(out);
    if (edgeSeedColors.length === 0) return out;

    const visited = new Uint8Array(out.width * out.height);
    const queue = [];
    const enqueue = (x, y) => {
        if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
        const idx = y * out.width + x;
        if (visited[idx]) return;
        visited[idx] = 1;
        if (!isBackgroundPixel(out, x, y, edgeSeedColors)) return;
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
        out.data[i + 3] = 0;
        cleared++;
        enqueue(x + 1, y);
        enqueue(x - 1, y);
        enqueue(x, y + 1);
        enqueue(x, y - 1);
    }

    out._clearedPixels = cleared;
    return trimAlphaFringe(out);
}

const files = process.argv.slice(2).filter(Boolean);
if (files.length === 0) {
    console.error('usage: node scripts/sprites/key-out-bg.mjs <file.png> [...]');
    process.exit(1);
}

for (const file of files) {
    if (!existsSync(file)) {
        console.error(`SKIP (missing): ${file}`);
        continue;
    }
    const src = PNG.sync.read(readFileSync(file));
    const keyed = keyOutEdgeBackground(src);
    const cleared = keyed._clearedPixels || 0;
    writeFileSync(file, PNG.sync.write(keyed));
    const pct = ((cleared / (src.width * src.height)) * 100).toFixed(1);
    console.log(`keyed ${file}  (${src.width}x${src.height}, cleared ${pct}% to transparent)`);
}
