#!/usr/bin/env node
// Re-hue the flowerCart crate body (visual-quality plan 6.5): the baked body
// panels are saturated magenta/violet, which clashes with the village wood
// tones. This remaps the violet-magenta hue family to a weathered-oak ramp,
// preserving per-pixel lightness so the shading steps survive, and leaves the
// gold trim, red/yellow blooms, and green foliage untouched.
//
// Hue mask (sampled from the shipped PNG): H in [235, 350], S >= 0.55 catches
// the magenta body (H 300-345), its violet shading (H 255-280), and the dark
// navy-violet shadow rows (H 235-250) while excluding gold trim (~45), blooms
// (~0-20), leaves (~110-156), and the teal wheel paint (~200).
//
// Usage:
//   node scripts/sprites/rehue-flowercart.mjs [--dry-run] [--file=<path>]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find((arg) => arg.startsWith('--file='));
const target = fileArg
    ? fileArg.slice('--file='.length)
    : join(repoRoot, 'claudeville', 'assets', 'sprites', 'props', 'prop.flowerCart.png');

const HUE_MIN = 235;
const HUE_MAX = 350;
const SAT_MIN = 0.55;
const OAK_HUE = 27;        // weathered oak mid-brown
const OAK_SAT_SCALE = 0.58; // de-saturate toward a weathered, not toy, brown

const png = PNG.sync.read(readFileSync(target));
let changed = 0;
let eligible = 0;

for (let i = 0; i < png.width * png.height; i++) {
    const p = i * 4;
    if (png.data[p + 3] === 0) continue;
    const r = png.data[p];
    const g = png.data[p + 1];
    const b = png.data[p + 2];
    const { h, s, l } = rgbToHsl(r, g, b);
    if (h < HUE_MIN || h > HUE_MAX || s < SAT_MIN) continue;
    eligible++;
    const [nr, ng, nb] = hslToRgb(OAK_HUE, Math.min(1, s * OAK_SAT_SCALE), l);
    png.data[p] = nr;
    png.data[p + 1] = ng;
    png.data[p + 2] = nb;
    changed++;
}

console.log(`[rehue-flowercart] ${target}`);
console.log(`[rehue-flowercart] masked ${eligible} px, re-hued ${changed} px${dryRun ? ' (dry run — not written)' : ''}`);
if (!dryRun) writeFileSync(target, PNG.sync.write(png));

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
