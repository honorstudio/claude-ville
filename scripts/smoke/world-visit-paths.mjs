#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = (process.env.CLAUDEVILLE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const browser = await chromium.launch({ headless: true });

try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(`${baseUrl}/?sim=1&scenario=world-visit-paths`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
    });
    await page.waitForFunction(
        () => window.__claudeVilleApp?._bootState === 'ready'
            && window.__claudeVilleApp?.renderer?.pathfinder,
        null,
        { timeout: 60_000 },
    );

    const result = await page.evaluate(async () => {
        const { BUILDING_DEFS, VISIT_OVERFLOW_TILES } = await import('/src/config/buildings.js');
        const { VILLAGE_GATE } = await import('/src/config/townPlan.js');
        const renderer = window.__claudeVilleApp.renderer;
        const pathfinder = renderer.pathfinder;
        const gate = pathfinder.nearestWalkable(
            VILLAGE_GATE.inside.tileX,
            VILLAGE_GATE.inside.tileY,
            8,
        );
        const seen = new Set();
        const violations = [];
        let configuredSlots = 0;
        let usableSlots = 0;

        for (const building of BUILDING_DEFS) {
            const entranceKey = `${building.entrance.tileX},${building.entrance.tileY}`;
            const baseKeys = new Set((building.visitTiles || [])
                .map(tile => `${tile.tileX},${tile.tileY}`));
            if (!baseKeys.has(entranceKey)) {
                violations.push(`${building.type} entrance ${entranceKey} is not a base visit slot`);
            }
            for (const [group, tiles] of [
                ['base', building.visitTiles || []],
                ['overflow', VISIT_OVERFLOW_TILES[building.type] || []],
            ]) {
                for (const tile of tiles) {
                    configuredSlots++;
                    const key = `${tile.tileX},${tile.tileY}`;
                    if (seen.has(key)) {
                        violations.push(`${building.type} ${group} slot duplicates ${key}`);
                        continue;
                    }
                    seen.add(key);
                    if (!pathfinder.isWalkable(tile.tileX, tile.tileY)) {
                        violations.push(`${building.type} ${group} slot ${key} is blocked`);
                        continue;
                    }
                    const path = pathfinder.findPath(gate, tile, renderer.bridgeTiles);
                    const endpoint = path.at(-1);
                    if (!endpoint || endpoint.tileX !== tile.tileX || endpoint.tileY !== tile.tileY) {
                        violations.push(`${building.type} ${group} slot ${key} is unreachable from the gate`);
                        continue;
                    }
                    usableSlots++;
                }
            }
        }

        return { gate, configuredSlots, usableSlots, violations };
    });

    assert.ok(result.gate, 'village gate must resolve to a walkable tile');
    assert.deepEqual(result.violations, []);
    assert.equal(result.usableSlots, result.configuredSlots);
    console.log(
        `world visit paths smoke: PASS (${result.usableSlots} unique walkable slots from gate ${result.gate.tileX},${result.gate.tileY})`,
    );
} finally {
    await browser.close();
}
