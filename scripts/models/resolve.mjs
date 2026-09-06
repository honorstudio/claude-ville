#!/usr/bin/env node

import { existsSync, openSync, closeSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as browserRegistry from '../../claudeville/src/config/models.generated.js';
import {
    formatModelLabel as browserFormatModelLabel,
    getModelVisualIdentity,
} from '../../claudeville/src/presentation/shared/ModelVisualIdentity.js';

const require = createRequire(import.meta.url);
const serverRegistry = require('../../claudeville/src/config/models.generated.cjs');
const {
    formatModelLabel: serverFormatModelLabel,
    modelIdentity,
    ratesForModel: adapterRatesForModel,
} = require('../../claudeville/adapters/sessionPresentation.js');

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function usage() {
    console.error('Usage: node scripts/models/resolve.mjs <provider> <modelString> [--effort=high] [--json]');
}

function parseArguments(argv) {
    const positional = [];
    let effort = null;
    let json = false;
    for (const argument of argv) {
        if (argument === '--json') {
            json = true;
        } else if (argument.startsWith('--effort=')) {
            effort = argument.slice('--effort='.length) || null;
        } else if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 2) throw new Error('Provider and modelString are required.');
    return { provider: positional[0], model: positional[1], effort, json };
}

function pngDimensions(path) {
    const header = Buffer.alloc(24);
    const descriptor = openSync(path, 'r');
    try {
        const bytesRead = readSync(descriptor, header, 0, header.length, 0);
        const signature = '89504e470d0a1a0a';
        if (bytesRead < header.length || header.subarray(0, 8).toString('hex') !== signature || header.toString('ascii', 12, 16) !== 'IHDR') {
            throw new Error('not a valid PNG IHDR');
        }
        return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    } finally {
        closeSync(descriptor);
    }
}

function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function display(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function printTable(rows) {
    const width = Math.max(...rows.map(([name]) => name.length));
    for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${display(value)}`);
}

let options;
try {
    options = parseArguments(process.argv.slice(2));
} catch (error) {
    usage();
    console.error(error.message);
    process.exitCode = 2;
}

if (options) {
    const { provider, model, effort, json } = options;
    const browserMatch = browserRegistry.findModelRow(model, provider);
    const serverMatch = serverRegistry.findModelRow(model, provider);
    const browserPricing = browserRegistry.ratesForModel(model, provider);
    const serverPricing = adapterRatesForModel(model, provider);
    const browserContextWindow = browserRegistry.contextWindowForModel(model, provider);
    const serverContextWindow = serverRegistry.contextWindowForModel(model, provider);
    const browserIdentity = getModelVisualIdentity(model, effort, provider);
    const serverIdentity = modelIdentity(model, effort, provider);
    const browserLabel = browserFormatModelLabel(model, effort, provider);
    const serverLabel = serverFormatModelLabel(model, effort, provider);
    const resolvedRow = browserMatch.row;
    // Source adapters (omp, opencode) resolve identity through the inferred
    // model family, so check the sprite the presentation actually renders.
    const spriteId = browserIdentity.spriteId || resolvedRow?.spriteId || null;
    const sheetPath = spriteId
        ? join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters', spriteId, 'sheet.png')
        : null;
    const sheetPresent = Boolean(sheetPath && existsSync(sheetPath));
    let sheetDimensions = null;
    let sheetError = null;
    if (sheetPresent) {
        try {
            sheetDimensions = pngDimensions(sheetPath);
        } catch (error) {
            sheetError = error.message;
        }
    }

    let manifest = 'skipped (run npm ci)';
    let manifestError = null;
    try {
        const { loadSpriteManifest } = await import('../sprites/manifest-utils.mjs');
        const loadedManifest = loadSpriteManifest();
        manifest = Array.isArray(loadedManifest?.characters)
            && loadedManifest.characters.some((entry) => entry?.id === spriteId);
    } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('js-yaml')) {
            manifestError = error.message;
            manifest = false;
        }
    }

    const providerKey = String(provider || '').toLowerCase() === 'openai'
        ? 'codex'
        : String(provider || '').toLowerCase();
    const rowId = browserMatch.isDefault ? `default:${providerKey || 'unknown'}` : browserMatch.row?.id;
    const result = {
        raw: model,
        provider,
        effort,
        normalizedCandidates: browserRegistry.pricingModelCandidates(model),
        row: rowId,
        matches: {
            browser: { id: browserMatch.row?.id || null, match: browserMatch.match, isDefault: browserMatch.isDefault },
            server: { id: serverMatch.row?.id || null, match: serverMatch.match, isDefault: serverMatch.isDefault },
        },
        pricing: { browser: browserPricing, server: serverPricing },
        contextWindow: { browser: browserContextWindow, server: serverContextWindow },
        label: { browser: browserLabel, server: serverLabel },
        identity: {
            browser: { spriteId: browserIdentity.spriteId, paletteKey: browserIdentity.paletteKey },
            server: { spriteId: serverIdentity.spriteId },
            spriteId,
            paletteKey: resolvedRow?.paletteKey ?? browserIdentity.paletteKey ?? null,
            modelClass: resolvedRow?.modelClass ?? browserIdentity.modelClass ?? null,
            mood: resolvedRow?.mood ?? null,
        },
        asset: { manifest, sheetPresent, dimensions: sheetDimensions, error: sheetError || manifestError },
    };

    const disagreements = [];
    if (!sameValue(result.matches.browser, result.matches.server)) disagreements.push('registry match');
    if (!sameValue(browserPricing, serverPricing)) disagreements.push('pricing');
    if (browserContextWindow !== serverContextWindow) disagreements.push('context window');
    if (browserIdentity.spriteId !== serverIdentity.spriteId) disagreements.push('spriteId');
    if (browserLabel !== serverLabel) disagreements.push('label');
    if (manifest === false) disagreements.push('manifest entry');
    if (!sheetPresent) disagreements.push('sprite sheet');
    if (sheetError || !sheetDimensions || sheetDimensions.width !== 736 || sheetDimensions.height !== 920) {
        disagreements.push('sprite sheet dimensions');
    }
    if (manifestError) disagreements.push('manifest load');
    result.ok = disagreements.length === 0;
    result.failures = disagreements;

    if (json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printTable([
            ['raw', `${provider} / ${model}`],
            ['normalized candidates', result.normalizedCandidates.join(', ')],
            ['registry row', rowId],
            ['match (server/browser)', `${serverMatch.match} / ${browserMatch.match}`],
            ['pricing (server)', serverPricing],
            ['pricing (browser)', browserPricing],
            ['context (server/browser)', `${display(serverContextWindow)} / ${display(browserContextWindow)}`],
            ['displayModel / label', `${serverLabel} / ${browserLabel}`],
            ['spriteId (server/browser)', `${display(serverIdentity.spriteId)} / ${display(browserIdentity.spriteId)}`],
            ['paletteKey', result.identity.paletteKey],
            ['modelClass', result.identity.modelClass],
            ['mood', result.identity.mood],
            ['manifest', manifest],
            ['sheet.png', sheetPresent ? `${sheetDimensions?.width || '?'}x${sheetDimensions?.height || '?'}` : 'missing'],
        ]);
        if (disagreements.length) console.error(`Failed: ${disagreements.join(', ')}`);
    }
    if (!result.ok) process.exitCode = 1;
}
