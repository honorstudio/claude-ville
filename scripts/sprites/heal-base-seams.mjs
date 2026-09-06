#!/usr/bin/env node
// Heal the building-base/terrain seam (visual-quality plan 1.10): the nine
// building base.png files ship with a baked grass ramp on the old style-
// contract hue (#355408/#456F03/#567A16, H ~ 82, S up to 0.95), while the live
// terrain grass reads greener and quieter (H ~ 100-110, S ~ 0.40). Every base
// edge therefore shows a yellow-green halo against the ground it sits on.
//
// This pass pulls each base's masked grass pixels toward the terrain tone,
// preserving per-pixel lightness so the baked shading steps survive. The
// terrain tone is sampled fresh from terrain.grass-dirt/sheet.png so the heal
// tracks the current bake; masked pixels blend 75% of the way in hue and 65%
// in saturation (a full overwrite would flatten each ramp's internal spread).
//
// Mask (measured on the shipped PNGs, see histogram notes below):
//   H in [60, 100], S >= 0.25, L <= 0.50, alpha > 0
// catches the contract grass ramp (H 80-100) while DODGING:
//   - cyan ore crystals on the mine (H 170-180)
//   - violet portal glow / archive window violet (H 240-300)
//   - slate-blue roofs and rock (H 200-230)
//   - warm lantern glow + yellow blooms (H <= 59)
//   - cream/white sunlit highlights on wood + stone (L >= 0.8)
//   - near-grey paving and bark (S < 0.25)
//
// Deterministic: no randomness; same inputs -> same output.
//
// Usage:
//   node scripts/sprites/heal-base-seams.mjs [--dry-run] [--file=<base.png>]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { spritesRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find((arg) => arg.startsWith('--file='));

const BUILDING_IDS = [
    'building.archive',
    'building.command',
    'building.forge',
    'building.harbor',
    'building.mine',
    'building.observatory',
    'building.portal',
    'building.taskboard',
    'building.watchtower',
];

const targets = fileArg
    ? [fileArg.slice('--file='.length)]
    : BUILDING_IDS.map((id) => join(spritesRoot, 'buildings', id, 'base.png'));

// Grass mask.
const HUE_MIN = 60;
const HUE_MAX = 100;
const SAT_MIN = 0.25;
const LIGHT_MAX = 0.50;
// Blend toward the terrain tone (1 = overwrite, 0 = keep baked ramp).
const HUE_BLEND = 0.75;
const SAT_BLEND = 0.65;

const terrainTone = sampleTerrainGrass();
console.log(
    `[heal-base-seams] terrain grass sample: H=${terrainTone.h.toFixed(1)} S=${terrainTone.s.toFixed(2)} (${terrainTone.count} px)`
);

let totalChanged = 0;
for (const target of targets) {
    const png = PNG.sync.read(readFileSync(target));
    let masked = 0;
    for (let i = 0; i < png.width * png.height; i++) {
        const p = i * 4;
        if (png.data[p + 3] === 0) continue;
        const { h, s, l } = rgbToHsl(png.data[p], png.data[p + 1], png.data[p + 2]);
        if (h < HUE_MIN || h > HUE_MAX || s < SAT_MIN || l > LIGHT_MAX) continue;
        masked++;
        const nh = h + (terrainTone.h - h) * HUE_BLEND;
        const ns = s + (terrainTone.s - s) * SAT_BLEND;
        const [nr, ng, nb] = hslToRgb(nh, Math.min(1, Math.max(0, ns)), l);
        png.data[p] = nr;
        png.data[p + 1] = ng;
        png.data[p + 2] = nb;
    }
    totalChanged += masked;
    console.log(`[heal-base-seams] ${target}: healed ${masked} px${dryRun ? ' (dry run — not written)' : ''}`);
    if (!dryRun && masked > 0) writeFileSync(target, PNG.sync.write(png));
}
console.log(`[heal-base-seams] total healed ${totalChanged} px across ${targets.length} base(s)`);

// Dominant grass tone of the live terrain: mean over the green band of the
// grass-dirt Wang sheet, excluding dirt (H ~ 25) and dark blend edges.
function sampleTerrainGrass() {
    const sheetPath = join(spritesRoot, 'terrain', 'terrain.grass-dirt', 'sheet.png');
    const sheet = PNG.sync.read(readFileSync(sheetPath));
    let hSum = 0;
    let sSum = 0;
    let count = 0;
    for (let i = 0; i < sheet.width * sheet.height; i++) {
        const p = i * 4;
        if (sheet.data[p + 3] < 200) continue;
        const { h, s, l } = rgbToHsl(sheet.data[p], sheet.data[p + 1], sheet.data[p + 2]);
        if (h < 90 || h > 130 || s < 0.25 || l < 0.25 || l > 0.65) continue;
        hSum += h;
        sSum += s;
        count++;
    }
    if (count === 0) throw new Error(`no grass pixels sampled from ${sheetPath}`);
    return { h: hSum / count, s: sSum / count, count };
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0; let g = 0; let b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}
