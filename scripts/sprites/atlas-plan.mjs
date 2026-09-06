#!/usr/bin/env node

import { loadSpriteManifest } from './manifest-utils.mjs';
import {
    createAtlasPlan,
    resolveAtlasDefinition,
    stableJson,
} from './atlas-layout.mjs';

const args = process.argv.slice(2);
const atlasArg = args.find((arg) => arg.startsWith('--atlas='));
const atlasId = atlasArg?.slice('--atlas='.length) || 'world-pilot';
const json = args.includes('--json');
const idsArg = args.find((arg) => arg.startsWith('--ids='));

const manifest = loadSpriteManifest();
const declared = resolveAtlasDefinition(manifest, atlasId);
const atlas = idsArg
    ? {
        ...declared,
        ids: idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean),
    }
    : declared;
const plan = createAtlasPlan(manifest, atlas);

if (json) {
    process.stdout.write(stableJson(plan));
} else {
    console.log(`[atlas-plan] ${plan.id}: ${plan.ids.length} reviewed asset id(s)`);
    console.log(`[atlas-plan] ${Object.keys(plan.frames).length} frame(s), ${plan.width}x${plan.height}, padding ${plan.padding}, nearest sampling`);
    for (const id of plan.ids) {
        const asset = plan.assets[id];
        console.log(`  ${id}: ${asset.frameCount} frame(s), ${asset.materialClass}, ${asset.sourcePath}`);
    }
    console.log('[atlas-plan] channel outputs:');
    for (const [channel, path] of Object.entries(plan.channels)) {
        console.log(`  ${channel}: ${path || '(not declared)'}`);
    }
}
