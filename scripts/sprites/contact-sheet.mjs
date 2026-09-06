#!/usr/bin/env node
// Contact-sheet evidence step (visual-quality plan cross-cutting): one montage
// PNG per sprite family so a bulk bake can be reviewed at a glance without
// opening 150 files. pngjs-only — no ImageMagick dependency.
//
//   node scripts/sprites/contact-sheet.mjs                  # all families
//   node scripts/sprites/contact-sheet.mjs --groups=props,vegetation
//
// Sheets land in output/sprite-contact-sheets/<family>.png. Assets are drawn
// in manifest order (building overlay layers follow their base) on an 8px
// dark checkerboard so alpha is visible; anything wider than CELL_CAP is
// downscaled by an integer factor to keep pixels crisp.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
    collectSpriteEntries,
    expectedPathsForEntry,
    loadSpriteManifest,
    repoRoot,
    spritesRoot,
} from './manifest-utils.mjs';

const CELL_CAP = 128;
const GAP = 10;
const MARGIN = 12;
const CHECKER = 8;
const BG_A = [22, 18, 14];
const BG_B = [30, 25, 19];

const args = process.argv.slice(2);
const groupsArg = args.find((arg) => arg.startsWith('--groups='));
const outDirArg = args.find((arg) => arg.startsWith('--out='));
const outRoot = outDirArg
    ? outDirArg.slice('--out='.length)
    : join(repoRoot, 'output', 'sprite-contact-sheets');

const manifest = loadSpriteManifest();
const families = groupsArg
    ? groupsArg.slice('--groups='.length).split(',').map((g) => g.trim()).filter(Boolean)
    : ['characters', 'equipment', 'accessories', 'statusOverlays', 'buildings', 'props', 'vegetation', 'terrain', 'bridges', 'atmosphere'];

mkdirSync(outRoot, { recursive: true });
let written = 0;
for (const family of families) {
    const entries = collectSpriteEntries(manifest, [family]);
    const tiles = [];
    for (const entry of entries) {
        for (const rel of expectedPathsForEntry(entry)) {
            const abs = join(spritesRoot, rel);
            if (!existsSync(abs)) continue;
            try {
                tiles.push({ rel, png: PNG.sync.read(readFileSync(abs)) });
            } catch {
                console.warn(`[contact-sheet] SKIP undecodable ${rel}`);
            }
        }
    }
    if (!tiles.length) {
        console.log(`[contact-sheet] ${family}: no PNGs, skipped`);
        continue;
    }
    const out = montage(family, tiles);
    const outPath = join(outRoot, `${family}.png`);
    writeFileSync(outPath, PNG.sync.write(out.png));
    console.log(`[contact-sheet] ${family}: ${tiles.length} asset(s), ${out.cols}x${out.rows} grid -> ${outPath}`);
    written++;
}
console.log(`[contact-sheet] done: ${written} sheet(s) written to ${outRoot}`);

function montage(family, tiles) {
    // Per-tile integer downscale so the largest dimension fits CELL_CAP.
    const cells = tiles.map(({ rel, png }) => {
        const scale = Math.max(1, Math.ceil(Math.max(png.width, png.height) / CELL_CAP));
        return {
            rel,
            png,
            scale,
            w: Math.ceil(png.width / scale),
            h: Math.ceil(png.height / scale),
        };
    });
    const cellW = Math.max(...cells.map((c) => c.w));
    const cellH = Math.max(...cells.map((c) => c.h));
    const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length * (cellW + GAP) / (cellH + GAP))));
    const rows = Math.ceil(cells.length / cols);
    const width = MARGIN * 2 + cols * cellW + (cols - 1) * GAP;
    const height = MARGIN * 2 + rows * cellH + (rows - 1) * GAP;
    const out = new PNG({ width, height, colorType: 6 });

    // Checkerboard backdrop so transparent regions stay visible.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const on = (Math.floor(x / CHECKER) + Math.floor(y / CHECKER)) % 2 === 0;
            const [r, g, b] = on ? BG_A : BG_B;
            const i = (width * y + x) << 2;
            out.data[i] = r;
            out.data[i + 1] = g;
            out.data[i + 2] = b;
            out.data[i + 3] = 255;
        }
    }

    cells.forEach((cell, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const ox = MARGIN + col * (cellW + GAP) + Math.floor((cellW - cell.w) / 2);
        const oy = MARGIN + row * (cellH + GAP) + Math.floor((cellH - cell.h) / 2);
        blitNearest(out, cell.png, ox, oy, cell.scale);
    });

    return { png: out, cols, rows };
}

// Nearest-neighbor blit with alpha-over compositing (source over checker bg).
function blitNearest(dst, src, ox, oy, scale) {
    for (let y = 0; y < Math.ceil(src.height / scale); y++) {
        for (let x = 0; x < Math.ceil(src.width / scale); x++) {
            const sx = Math.min(src.width - 1, x * scale);
            const sy = Math.min(src.height - 1, y * scale);
            const si = (src.width * sy + sx) << 2;
            const a = src.data[si + 3];
            if (a === 0) continue;
            const dx = ox + x;
            const dy = oy + y;
            if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
            const di = (dst.width * dy + dx) << 2;
            if (a === 255) {
                dst.data[di] = src.data[si];
                dst.data[di + 1] = src.data[si + 1];
                dst.data[di + 2] = src.data[si + 2];
                dst.data[di + 3] = 255;
            } else {
                const t = a / 255;
                dst.data[di] = Math.round(src.data[si] * t + dst.data[di] * (1 - t));
                dst.data[di + 1] = Math.round(src.data[si + 1] * t + dst.data[di + 1] * (1 - t));
                dst.data[di + 2] = Math.round(src.data[si + 2] * t + dst.data[di + 2] * (1 - t));
                dst.data[di + 3] = 255;
            }
        }
    }
}
