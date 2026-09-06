#!/usr/bin/env node
// Assemble a ClaudeVille character sheet (8 dirs × 10 rows × 92px = 736×920)
// from a pixellab MCP character ZIP.
//
// Pixellab ZIP layout (verified 2026-04-27):
//   metadata.json
//   rotations/<dir>.png                                          (S × S, S = source canvas)
//   animations/animating-<uuid>/<dir>/frame_NNN.png              (S × S each)
//
// Select animations by explicit group ID, never by frame count.
// Full assembly: --walk=<animation-id> --breathingIdle=<animation-id>
// One base-sheet group: --group=walk --animation-group-id=<animation-id>
// New action groups belong in the separate actionStrip contract, not this sheet.
//
// Usage:
//   node scripts/sprites/generate-character-mcp.mjs --id=<sprite-id> --zip=<path-to-zip> --walk=<animation-id> --breathingIdle=<animation-id>
//   (or omit --zip and the script looks for output/character-mcp-cache/<id>.zip)

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import yaml from 'js-yaml';
import { blitPng, fitCenterToCell } from './pixellab-rest.mjs';
import { rewriteEntryKeys } from './manifest-utils.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cacheRoot = join(repoRoot, 'output', 'character-mcp-cache');
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites', 'characters');
const manifestPath = join(repoRoot, 'claudeville', 'assets', 'sprites', 'manifest.yaml');

const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const CELL = 92;
const WALK_FRAMES = 6;
const IDLE_FRAMES = 4;
const COLS = DIRECTIONS.length;
const ROWS = WALK_FRAMES + IDLE_FRAMES;
const args = new Set(process.argv.slice(2));
const allowUnmanifested = args.has('--allow-unmanifested');
const dryRun = args.has('--dry-run');

function arg(name, fallback) {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
}

const id = arg('id', null);
if (!id) { console.error('Missing --id=<sprite-id>'); process.exit(1); }
const zipPath = arg('zip', join(cacheRoot, `${id}.zip`));
const groupName = arg('group', null);
const animationGroupId = arg('animation-group-id', null);

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

async function main() {
    const entry = characterManifestEntry(id);
    if (!existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
    if (dryRun) {
        console.log(`[character-mcp] dry run: ${id} is manifest-backed; generation=${entry.generationSize}px/${entry.generationMode || 'standard'}; engine=${CELL}px; ZIP exists at ${zipPath}`);
        return;
    }
    let extractDir = zipPath;
    if (!statSync(zipPath).isDirectory()) {
        extractDir = join(cacheRoot, `${id}-extracted`);
        mkdirSync(extractDir, { recursive: true });
        const unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], { stdio: 'inherit' });
        if (unzip.error) throw unzip.error;
        if (unzip.status !== 0) throw new Error(`unzip failed with exit code ${unzip.status}`);
    }

    const parsed = JSON.parse(readFileSync(join(extractDir, 'metadata.json'), 'utf8'));
    // Pixellab export schema bump: character/frames are now nested under
    // states[0]. Fall back to the legacy flat layout for older ZIPs.
    const meta = Array.isArray(parsed.states) ? parsed.states[0] : parsed;
    // Pro mode (2026-09) returns frames at exactly generationSize with no
    // auto-padding; older exports padded ~40%. Either way the content lands
    // centred in the 92px cell.
    const SOURCE = meta.character.size.width;

    const groups = entry.animationGroups || { walk: { rows: [0, 5] }, breathingIdle: { rows: [6, 9] } };
    if (groupName && !Object.hasOwn(groups, groupName)) {
        throw new Error(`Unknown base-sheet group ${groupName}; new action groups require a separate actionStrip`);
    }
    const selected = groupName ? [groupName] : ['walk', 'breathingIdle'];
    const characterId = arg('character-id', entry.provenance?.characterId || meta.character.id);
    const generationSize = Number(arg('generation-size', entry.provenance?.generationSize || entry.generationSize));
    if (!arg('generation-size', null) && !entry.provenance?.generationSize) {
        const source = readFileSync(manifestPath, 'utf8');
        const block = source.split(`  - id: ${id}\n`)[1]?.split(/\n  - id:|\n[^\s#]/)[0] || '';
        if (/generationSize:.*unverified/.test(block)) throw new Error('Unverified inherited size: supply --generation-size after checking the source character record');
    }
    if (typeof characterId !== 'string' || !characterId.trim()) throw new Error('Provide --character-id=<PixelLab character id>');
    if (!Number.isInteger(generationSize) || generationSize < 32 || generationSize > 128) throw new Error('Invalid generation size');
    const selections = selected.map((name) => {
        const animationId = groupName ? animationGroupId : arg(name, null);
        if (!animationId || !Object.hasOwn(meta.frames.animations, animationId)) throw new Error(`Provide an exported animation ID for ${name}`);
        return { name, animationId, rows: groups[name].rows, dirs: meta.frames.animations[animationId] };
    });

    const outPath = join(spritesRoot, id, 'sheet.png');
    const sheet = groupName ? readPng(outPath) : new PNG({ width: CELL * COLS, height: CELL * ROWS });
    if (sheet.width !== CELL * COLS || sheet.height !== CELL * ROWS) throw new Error('Existing sheet dimensions do not match base-sheet contract');
    for (const selection of selections) {
        const [start, end] = selection.rows;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= ROWS) throw new Error('Invalid group row range');
        for (let col = 0; col < COLS; col++) {
            const dir = DIRECTIONS[col];
            const frames = selection.dirs[dir];
            if (!frames || frames.length !== end - start + 1) throw new Error(`${selection.name} missing direction ${dir} or wrong frame count`);
            for (let f = 0; f < frames.length; f++) {
                const frame = fitCenter(readPng(join(extractDir, frames[f])), SOURCE);
                blitPng(frame, sheet, col * CELL, (start + f) * CELL);
            }
        }
    }
    const provenance = {
        characterId,
        ...(groupName ? { animationGroupId: selections[0].animationId } : {}),
        generationSize,
        generationMode: entry.generationMode || 'standard',
    };
    const updatedManifest = manifestLedgerUpdate(id, groups, provenance);

    // Commit ledger only after all direction frames have assembled successfully.
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(sheet));
    if (updatedManifest !== null) writeFileSync(manifestPath, updatedManifest);
    console.log(`wrote ${outPath} (${CELL * COLS}×${CELL * ROWS}, generation=${entry.generationSize}px/${entry.generationMode || 'standard'}, source=${SOURCE})`);
}

function readPng(p) {
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return PNG.sync.read(readFileSync(p));
}

function characterManifestEntry(spriteId) {
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
    const entry = (manifest.characters || []).find((candidate) => candidate?.id === spriteId);
    if (entry) {
        if (!Number.isInteger(entry.generationSize)) {
            throw new Error(`manifest character ${spriteId} has invalid generationSize`);
        }
        return entry;
    }

    const message = `unmanifested character ID: ${spriteId}`;
    if (!allowUnmanifested) {
        throw new Error(`${message}; pass --allow-unmanifested only for scratch assets`);
    }
    console.warn(`[character-mcp] WARNING: ${message}`);
    return { generationSize: '(unmanifested)', generationMode: null };
}

function manifestLedgerUpdate(spriteId, animationGroups, provenance) {
    const metadata = yaml.dump({ animationGroups, provenance }, { lineWidth: -1, noRefs: true })
        .trimEnd().split('\n').map((line) => `    ${line}`);
    // null for the explicit scratch-only --allow-unmanifested path.
    return rewriteEntryKeys(
        readFileSync(manifestPath, 'utf8'),
        spriteId,
        ['animationGroups', 'provenance'],
        metadata,
    );
}

// Assert the export canvas the metadata declared, then centre it in the cell.
function fitCenter(src, source) {
    if (src.width !== source || src.height !== source) {
        throw new Error(`expected ${source}×${source}, got ${src.width}×${src.height}`);
    }
    return fitCenterToCell(src, CELL);
}
