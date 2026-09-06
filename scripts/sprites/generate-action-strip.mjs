#!/usr/bin/env node
// Generate and assemble a C2 action strip: 8 direction columns × N rows of the
// 92px engine cell, one named group per row range, stored beside the base sheet
// as `characters/<id>/actions.png`. The base sheet is never widened.
//
// PixelLab MCP is unauthenticated in this harness, so every call goes through
// REST with the `.dev.vars` token (`scripts/sprites/pixellab-rest.mjs`).
// `provenance.characterId` on the manifest entry is the source rig; the rig's
// own export canvas (not the manifest `generationSize`) is what v3 animation is
// billed and assembled at.
//
// Usage:
//   node scripts/sprites/generate-action-strip.mjs --ids=agent.claude.sonnet --plan
//   node scripts/sprites/generate-action-strip.mjs --ids=agent.claude.sonnet,agent.codex.gpt6astra
//   node scripts/sprites/generate-action-strip.mjs --ids=<id> --groups=wait --force
//   node scripts/sprites/generate-action-strip.mjs --ids=<id> --assemble-only --contact-sheet=/tmp/x.png

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import {
    blitPng,
    createCharacterAnimation,
    fetchPng,
    characterAnimationFrames,
    fitCenterToCell,
    getBalance,
    getCharacter,
    readPixellabToken,
    sleep,
    waitForCharacterAnimation,
} from './pixellab-rest.mjs';
import {
    collectSpriteEntries,
    loadSpriteManifest,
    manifestPath,
    rewriteEntryKeys,
    spritesRoot,
} from './manifest-utils.mjs';

const CELL = 92;
// Strip columns follow SpriteSheet.DIRECTIONS: s, se, e, ne, n, nw, w, sw.
const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

// Named groups, never identified by frame count. `keep` selects which generated
// frames become strip rows: `read` keeps the whole four-frame beat, `wait` keeps
// only the settled held pose (v3 requires an even 4–16 frame request).
const GROUPS = Object.freeze({
    read: {
        rows: [0, 3],
        hold: 3,
        frameCount: 4,
        keep: [0, 1, 2, 3],
        animationName: 'claudeville-read-v1',
        action: 'brings an open book up into both hands at chest height, glances down at the page, turns one page with the near hand, then holds the open book still and reads it; feet planted, body upright, no walking, no weapon drawn',
    },
    wait: {
        rows: [4, 4],
        hold: 4,
        frameCount: 4,
        keep: [3],
        // v1 kept the source rotation's prop in the working hand and produced
        // detached objects on the back views; v2 states the hand transfer
        // explicitly and names the empty palm as the subject of the frame.
        animationName: 'claudeville-wait-v2',
        action: 'moves any held staff, tool or weapon into the far hand and lets it rest upright against the shoulder, then lifts the near hand up to chest height and opens it — bare empty palm turned toward the viewer, fingers spread, nothing in that hand and nothing floating beside the body; feet planted, shoulders square, head level, eyes open, standing perfectly still and waiting for an answer; not sleeping, not bowing, not afraid, not casting, not celebrating, no walking',
    },
});
const REPAIR_ROUNDS = 2;
// A strip is exactly as tall as the groups it actually carries: a group that
// review rejected is not shipped as dead rows.
const rowsNeededFor = (names) => Math.max(...names.map((name) => GROUPS[name].rows[1])) + 1;

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const ids = (option('ids') || '').split(',').map((id) => id.trim()).filter(Boolean);
const groupNames = (option('groups') || Object.keys(GROUPS).join(',')).split(',').map((n) => n.trim()).filter(Boolean);
const plan = flag('plan') || flag('dry-run');
const assembleOnly = flag('assemble-only');
const force = flag('force');
const contactSheetPath = option('contact-sheet');
const directionsOption = (option('directions') || '')
    .split(',').map((name) => name.trim()).filter(Boolean);
const characterIdOverride = option('character-id');
const cacheRoot = join(spritesRoot, '..', '..', '..', 'output', 'action-strip-cache');

if (!ids.length) {
    console.error('Usage: --ids=<sprite-id>[,<sprite-id>] [--groups=read,wait] [--directions=north,west]'
        + ' [--plan] [--force] [--assemble-only] [--contact-sheet=<path>]');
    process.exit(1);
}
for (const name of groupNames) {
    if (!GROUPS[name]) {
        console.error(`Unknown group ${name}; known groups: ${Object.keys(GROUPS).join(', ')}`);
        process.exit(1);
    }
}
for (const name of directionsOption) {
    if (!DIRECTIONS.includes(name)) {
        console.error(`Unknown direction ${name}; known directions: ${DIRECTIONS.join(', ')}`);
        process.exit(1);
    }
}

const token = readPixellabToken();
const entries = new Map(collectSpriteEntries(loadSpriteManifest())
    .filter((entry) => entry.id?.startsWith('agent.'))
    .map((entry) => [entry.id, entry]));

const balanceBefore = await getBalance(token);
console.log(`[action-strip] balance before: ${balanceBefore.subscription?.generations}/${balanceBefore.subscription?.total} generations (${balanceBefore.subscription?.plan})`);

const failures = [];
for (const id of ids) {
    try {
        await runCharacter(id);
    } catch (err) {
        failures.push(`${id}: ${err.message}`);
        console.error(`[action-strip] FAILED ${id}: ${err.message}`);
    }
}

const balanceAfter = await getBalance(token);
console.log(`[action-strip] balance after: ${balanceAfter.subscription?.generations}/${balanceAfter.subscription?.total} generations`
    + ` (spent ${Number(balanceBefore.subscription?.generations) - Number(balanceAfter.subscription?.generations)})`);
if (failures.length) {
    console.error(`[action-strip] ${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}

async function runCharacter(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error('not a manifest character entry');
    const characterId = characterIdOverride || entry.provenance?.characterId;
    if (!characterId) throw new Error('no provenance.characterId; record the verified source rig first');

    let character = await getCharacter(token, characterId);
    const source = Number(character?.size?.width);
    if (!Number.isInteger(source) || source !== Number(character?.size?.height)) {
        throw new Error(`rig ${characterId} has a non-square export canvas ${JSON.stringify(character?.size)}`);
    }
    const perDirection = (frames) => Math.ceil((source * source * frames) / 65536);
    const quote = groupNames.map((name) => ({
        name,
        generations: perDirection(GROUPS[name].frameCount) * DIRECTIONS.length,
    }));
    const total = quote.reduce((sum, item) => sum + item.generations, 0);
    console.log(`[action-strip] ${id}: rig ${characterId} "${character.name}" canvas ${source}px;`
        + ` ${quote.map((item) => `${item.name}=${item.generations}`).join(' ')} generations (total ${total})`);
    if (plan) return;

    // Tier 1 allows 8 concurrent background jobs and one group of 8 directions
    // fills that quota, so groups are strictly serialized and a 429 waits for
    // whatever else on this account is holding job slots. A direction whose
    // background job dies never completes, so a stalled group is repaired by
    // re-requesting exactly the missing directions.
    const groupFrames = new Map();
    for (const name of groupNames) {
        const group = GROUPS[name];
        let known = characterAnimationFrames(character, group.animationName, { frameCount: group.frameCount });
        for (let round = 0; ; round++) {
            const missing = force && round === 0
                ? DIRECTIONS
                : DIRECTIONS.filter((direction) => !known.byDirection.has(direction));
            if (!missing.length) {
                console.log(`[action-strip] ${id}/${name}: ${DIRECTIONS.length}/${DIRECTIONS.length} directions ready (${known.groupIds.join(', ')})`);
                break;
            }
            if (assembleOnly) throw new Error(`${name} is missing ${missing.length} direction(s) and --assemble-only was requested`);
            if (round >= REPAIR_ROUNDS) {
                throw new Error(`${name} still missing ${missing.join(', ')} after ${round} attempt(s)`);
            }
            // Round 0 with a partially populated group is a batch still in
            // flight from an interrupted run: wait for it rather than pay twice.
            if (round === 0 && known.byDirection.size && !force) {
                console.log(`[action-strip] ${id}/${name}: ${known.byDirection.size}/${DIRECTIONS.length} already on the rig; waiting instead of re-requesting`);
            } else {
                console.log(`[action-strip] ${id}/${name}: requesting ${group.frameCount} frames × ${missing.length} direction(s)`
                    + ` (${perDirection(group.frameCount) * missing.length} generations)`);
                await requestWithJobSlotBackoff(() => createCharacterAnimation(token, {
                    characterId,
                    animationName: group.animationName,
                    actionDescription: group.action,
                    frameCount: group.frameCount,
                    directions: missing,
                    keepFirstFrame: false,
                }), `${id}/${name}`);
            }
            try {
                const settled = await waitForCharacterAnimation(token, characterId, {
                    animationName: group.animationName,
                    directions: DIRECTIONS,
                    frameCount: group.frameCount,
                    label: `${id}/${name}`,
                });
                character = settled.character;
                known = { byDirection: settled.byDirection, groupIds: settled.groupIds };
            } catch (err) {
                console.log(`[action-strip] ${id}/${name}: ${err.message}; repairing`);
                character = await getCharacter(token, characterId);
                known = characterAnimationFrames(character, group.animationName, { frameCount: group.frameCount });
            }
        }
        groupFrames.set(name, known);
    }

    // Assemble every requested group; unrequested rows keep their current pixels.
    const outPath = join(spritesRoot, 'characters', id, 'actions.png');
    const rowsNeeded = rowsNeededFor(groupNames);
    const previous = existsSync(outPath) ? PNG.sync.read(readFileSync(outPath)) : null;
    if (previous && (previous.width !== CELL * DIRECTIONS.length || previous.height % CELL !== 0)) {
        throw new Error(`existing strip ${previous.width}×${previous.height} is not whole ${CELL}px cells of 8 columns`);
    }
    const rows = Math.max(rowsNeeded, previous ? previous.height / CELL : 0);
    const strip = new PNG({ width: CELL * DIRECTIONS.length, height: CELL * rows });
    if (previous) blitPng(previous, strip, 0, 0);
    const groupProvenance = {};
    for (const name of groupNames) {
        const group = GROUPS[name];
        const { byDirection, groupIds } = groupFrames.get(name);
        groupProvenance[name] = groupIds[groupIds.length - 1] || null;
        for (let col = 0; col < DIRECTIONS.length; col++) {
            const direction = DIRECTIONS[col];
            const frames = byDirection.get(direction) || [];
            if (frames.length < group.frameCount) throw new Error(`${name}/${direction} has ${frames.length}/${group.frameCount} frames`);
            for (let i = 0; i < group.keep.length; i++) {
                const url = frames[group.keep[i]];
                const png = await cachedFrame(url, `${id}-${name}-${direction}-${group.keep[i]}`);
                // v3 sometimes exports a few pixels wider than the rig canvas
                // (76px rig → 80px frames); centring in the cell keeps feet.
                if (png.width !== png.height) {
                    throw new Error(`${name}/${direction} frame is ${png.width}×${png.height}, not square`);
                }
                if (png.width !== source) {
                    console.log(`[action-strip] ${id}/${name}/${direction}: frame canvas ${png.width}px vs rig ${source}px; centring`);
                }
                blitPng(fitCenterToCell(png, CELL), strip, col * CELL, (group.rows[0] + i) * CELL);
            }
        }
        console.log(`[action-strip] ${id}/${name}: assembled rows ${group.rows.join('–')} from ${groupProvenance[name]}`);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, PNG.sync.write(strip));
    console.log(`[action-strip] wrote ${outPath} (${strip.width}×${strip.height})`);

    // Declare only the groups this strip really carries: the ones just
    // assembled plus previously recorded ones that still fit inside the PNG.
    const manifestGroups = {};
    for (const [name, group] of Object.entries(entry.actionStrip?.groups || {})) {
        if (group?.rows?.[1] < rows) manifestGroups[name] = { rows: group.rows, hold: group.hold };
    }
    for (const name of groupNames) {
        manifestGroups[name] = { rows: GROUPS[name].rows, hold: GROUPS[name].hold };
    }
    const existingStrip = entry.actionStrip || {};
    const rendered = renderActionStrip({
        path: `characters/${id}/actions.png`,
        cell: CELL,
        groups: manifestGroups,
        grip: existingStrip.grip || { hand: 'both', sheathe: true },
        provenance: {
            characterId,
            animationGroupId: groupProvenance[groupNames[groupNames.length - 1]],
            generationSize: source,
        },
    });
    const updated = rewriteEntryKeys(readFileSync(manifestPath, 'utf8'), id, ['actionStrip'], rendered);
    if (updated === null) throw new Error('manifest entry vanished while writing actionStrip');
    writeFileSync(manifestPath, updated);
    console.log(`[action-strip] ${id}: manifest actionStrip recorded`);

    if (contactSheetPath) writeContactSheet(id, strip, contactSheetPath);
}

// The account's 8 background-job slots are shared with every other generation
// running against this token, so a concurrency 429 is a wait, not a failure.
async function requestWithJobSlotBackoff(request, label, { attempts = 30, waitMs = 60_000 } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await request();
        } catch (err) {
            const busy = /PixelLab 429/.test(err.message) && /concurrent background jobs/.test(err.message);
            if (!busy || attempt >= attempts) throw err;
            console.log(`[action-strip] ${label}: job slots busy, retrying in ${waitMs / 1000}s (${attempt}/${attempts})`);
            await sleep(waitMs);
        }
    }
}

async function cachedFrame(url, key) {
    const cached = join(cacheRoot, `${key}.png`);
    if (existsSync(cached)) return PNG.sync.read(readFileSync(cached));
    const png = await fetchPng(url, { label: key });
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, PNG.sync.write(png));
    return png;
}

// C2 style: block keys, flow-style groups/grip/provenance, matching the manifest.
function renderActionStrip(strip) {
    const flow = (record) => `{ ${Object.entries(record)
        .map(([key, value]) => `${key}: ${Array.isArray(value)
            ? `[${value.join(', ')}]`
            : (value !== null && typeof value === 'object' ? flow(value) : String(value))}`)
        .join(', ')} }`;
    return [
        '    actionStrip:',
        `      path: ${strip.path}`,
        `      cell: ${strip.cell}`,
        `      groups: ${flow(strip.groups)}`,
        `      grip: ${flow(strip.grip)}`,
        `      provenance: ${flow(strip.provenance)}`,
    ];
}

// Review evidence: every direction of every row at 1×, 2× and 3×, on a dark
// checkerboard so alpha and silhouette read. Output-only; never an asset.
function writeContactSheet(id, strip, requestedPath) {
    // One sheet per character: `{id}` if the caller placed it, else suffixed.
    const path = requestedPath.includes('{id}')
        ? requestedPath.replaceAll('{id}', id)
        : requestedPath.replace(/(\.png)?$/, `-${id}.png`);
    const scales = [1, 2, 3];
    const gap = 4;
    const width = scales.reduce((sum, scale) => sum + strip.width * scale + gap, gap);
    const height = Math.max(...scales.map((scale) => strip.height * scale)) + gap * 2;
    const sheet = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (width * y + x) << 2;
            const dark = ((x >> 3) + (y >> 3)) % 2 === 0;
            sheet.data[i] = dark ? 24 : 40;
            sheet.data[i + 1] = dark ? 24 : 40;
            sheet.data[i + 2] = dark ? 28 : 46;
            sheet.data[i + 3] = 255;
        }
    }
    let offsetX = gap;
    for (const scale of scales) {
        for (let y = 0; y < strip.height * scale; y++) {
            for (let x = 0; x < strip.width * scale; x++) {
                const si = (strip.width * Math.floor(y / scale) + Math.floor(x / scale)) << 2;
                const alpha = strip.data[si + 3];
                if (!alpha) continue;
                const di = (width * (y + gap) + (x + offsetX)) << 2;
                const blend = alpha / 255;
                for (let c = 0; c < 3; c++) {
                    sheet.data[di + c] = Math.round(strip.data[si + c] * blend + sheet.data[di + c] * (1 - blend));
                }
                sheet.data[di + 3] = 255;
            }
        }
        offsetX += strip.width * scale + gap;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(sheet));
    console.log(`[action-strip] ${id}: contact sheet ${path} (${width}×${height}, 1×/2×/3×)`);
}
