#!/usr/bin/env node
// Compare deterministic all-building day/night baselines to fresh captures.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const baselineDir = join(repoRoot, 'scripts', 'sprites', 'baselines');
const buildingTypes = BUILDING_DEFS.map((building) => building.type);
const POSES = ['day', 'night'].flatMap((phase) => [
    `overview-${phase}`,
    ...buildingTypes.map((type) => `${type}-${phase}`),
]);
const THRESHOLD_PCT = 0.5;
const PIXELMATCH_THRESHOLD = 0.1;
const allowMissingBaselines = process.argv.includes('--allow-missing-baselines')
    || process.argv.includes('--allow-missing-baseline');

if (!existsSync(baselineDir)) {
    const message = `[visual-diff] baseline directory not found at ${baselineDir}`;
    if (allowMissingBaselines) {
        console.warn(`${message}; allowed by --allow-missing-baselines`);
        process.exit(0);
    }
    console.error(`${message}. Run npm run sprites:capture-baseline first, or pass --allow-missing-baselines.`);
    process.exit(1);
}

let failed = 0;
let skipped = 0;
let compared = 0;
let passed = 0;

for (const pose of POSES) {
    const basePath = join(baselineDir, `${pose}.png`);
    const freshPath = join(baselineDir, `${pose}-fresh.png`);
    const diffPath = join(baselineDir, `${pose}-diff.png`);

    if (!existsSync(basePath)) {
        const message = `[visual-diff] missing ${pose} baseline at ${basePath}`;
        if (allowMissingBaselines) {
            console.warn(`${message}; skipped by --allow-missing-baselines`);
            skipped++;
            continue;
        }
        console.error(`${message}. Run npm run sprites:capture-baseline first.`);
        failed++;
        continue;
    }
    if (!existsSync(freshPath)) {
        console.error(`[visual-diff] missing ${pose} fresh capture at ${freshPath}. Run npm run sprites:capture-fresh first.`);
        failed++;
        continue;
    }

    const base = PNG.sync.read(readFileSync(basePath));
    const fresh = PNG.sync.read(readFileSync(freshPath));
    if (base.width !== fresh.width || base.height !== fresh.height) {
        console.error(`[visual-diff] FAIL ${pose}: dimensions differ - baseline ${base.width}x${base.height}, fresh ${fresh.width}x${fresh.height}`);
        failed++;
        continue;
    }
    const { width, height } = base;
    const diff = new PNG({ width, height });
    const mismatched = pixelmatch(
        base.data,
        fresh.data,
        diff.data,
        width,
        height,
        { threshold: PIXELMATCH_THRESHOLD },
    );
    const total = width * height;
    const pct = (mismatched / total) * 100;
    writeFileSync(diffPath, PNG.sync.write(diff));
    const verdict = pct > THRESHOLD_PCT ? 'FAIL' : 'OK';
    console.log(`[visual-diff] ${verdict} ${pose}: ${mismatched}/${total} px (${pct.toFixed(3)}%)`);
    compared++;
    if (pct > THRESHOLD_PCT) failed++;
    else passed++;
}

if (compared === 0 && failed === 0 && !allowMissingBaselines) {
    console.error('[visual-diff] no sprite comparisons were run');
    failed++;
}

console.log(`[visual-diff] summary: ${passed}/${POSES.length} passing, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
