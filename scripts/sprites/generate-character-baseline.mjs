#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import yaml from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
const manifestPath = join(spritesRoot, 'manifest.yaml');
const CELL = 92;
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const WALK_FRAMES = 6;
const IDLE_FRAMES = 4;
const args = new Set(process.argv.slice(2));
const onlyCharacters = args.has('--characters-only');
const onlyOverlays = args.has('--overlays-only');
const allowUnmanifested = args.has('--allow-unmanifested');
const dryRun = args.has('--dry-run');
const idsArg = process.argv.slice(2).find((arg) => arg.startsWith('--ids='));
const idFilter = idsArg
    ? new Set(idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean))
    : null;

const SPECS = [
    {
        id: 'agent.claude.opus',
        family: 'claude',
        model: 'opus',
        robe: '#8f4f21',
        robeDark: '#5b2f18',
        trim: '#ffe7a8',
        accent: '#c8a3ff',
        metal: '#f2d36b',
        skin: '#d69b72',
        hair: '#3a2418',
    },
    {
        id: 'agent.claude.sonnet',
        family: 'claude',
        model: 'sonnet',
        robe: '#a85f24',
        robeDark: '#673718',
        trim: '#f2d36b',
        accent: '#b7ccff',
        metal: '#e9b85f',
        skin: '#d69b72',
        hair: '#3a2418',
    },
    {
        id: 'agent.codex.gpt55',
        family: 'codex',
        model: 'gpt55',
        robe: '#116466',
        robeDark: '#0b3840',
        trim: '#fff1b8',
        accent: '#7be3d7',
        metal: '#f8c45f',
        skin: '#c98f67',
        hair: '#1f2a30',
    },
    {
        id: 'agent.codex.gpt54',
        family: 'codex',
        model: 'gpt54',
        robe: '#1f6f8b',
        robeDark: '#12353b',
        trim: '#8bd6ff',
        accent: '#7be3d7',
        metal: '#b58b4f',
        skin: '#c98f67',
        hair: '#1f2a30',
    },
    {
        id: 'agent.codex.gpt53spark',
        family: 'codex',
        model: 'spark',
        robe: '#1b6069',
        robeDark: '#102f3a',
        trim: '#f8e36f',
        accent: '#55e7ff',
        metal: '#c5ff72',
        skin: '#c98f67',
        hair: '#1f2a30',
    },
    {
        id: 'agent.claude.base',
        family: 'claude',
        model: 'base',
        robe: '#8f4f21',
        robeDark: '#5b2f18',
        trim: '#f2d36b',
        accent: '#ffd98a',
        metal: '#e9b85f',
        skin: '#d69b72',
        hair: '#3a2418',
    },
    {
        id: 'agent.codex.base',
        family: 'codex',
        model: 'base',
        robe: '#116466',
        robeDark: '#0b3840',
        trim: '#7be3d7',
        accent: '#55c7f0',
        metal: '#b58b4f',
        skin: '#c98f67',
        hair: '#1f2a30',
    },
    {
        id: 'agent.gemini.base',
        family: 'gemini',
        model: 'base',
        robe: '#42316d',
        robeDark: '#251b45',
        trim: '#7fc7ff',
        accent: '#d7b8ff',
        metal: '#f2d36b',
        skin: '#c99172',
        hair: '#2b2440',
    },
    {
        id: 'agent.kimi.base',
        family: 'kimi',
        model: 'base',
        robe: '#f2e4df',
        robeDark: '#8f4150',
        trim: '#f5c36a',
        accent: '#ff8da8',
        metal: '#d8893d',
        skin: '#d9aa82',
        hair: '#4d1f24',
    },
];

const EFFORTS = [
    { id: 'overlay.status.effortLow', kind: 'low', color: '#b98948', glow: '#f2d36b' },
    { id: 'overlay.status.effortMedium', kind: 'medium', color: '#b7ccff', glow: '#7be3d7' },
    { id: 'overlay.status.effortHigh', kind: 'high', color: '#f2d36b', glow: '#fff1b8' },
    { id: 'overlay.accessory.effortXhigh', kind: 'xhigh', color: '#fff1b8', glow: '#c8a3ff' },
];

const plannedIds = [
    ...(!onlyOverlays ? SPECS.map((spec) => spec.id) : []),
    ...(!onlyCharacters ? EFFORTS.map((effort) => effort.id) : []),
].filter((id) => !idFilter || idFilter.has(id));
assertManifested(plannedIds);
if (dryRun) {
    console.log(`[baseline] dry run: ${plannedIds.length} manifest-backed sprite IDs selected`);
    for (const id of plannedIds) console.log(`[baseline] ${id}`);
    process.exit(0);
}

if (!onlyOverlays) {
    for (const spec of SPECS) {
        if (idFilter && !idFilter.has(spec.id)) continue;
        const png = new PNG({ width: CELL * DIRECTIONS.length, height: CELL * (WALK_FRAMES + IDLE_FRAMES) });
        for (let row = 0; row < WALK_FRAMES + IDLE_FRAMES; row++) {
            for (let col = 0; col < DIRECTIONS.length; col++) {
                const frame = row < WALK_FRAMES ? row : row - WALK_FRAMES;
                drawCharacter(png, col * CELL, row * CELL, spec, DIRECTIONS[col], row < WALK_FRAMES, frame);
            }
        }
        writePng(join(spritesRoot, 'characters', spec.id, 'sheet.png'), png);
    }
}

if (!onlyCharacters) {
    for (const effort of EFFORTS) {
        if (idFilter && !idFilter.has(effort.id)) continue;
        const png = new PNG({ width: 32, height: 32 });
        drawEffortOverlay(png, effort);
        writePng(join(spritesRoot, 'overlays', `${effort.id}.png`), png);
    }
}

function drawCharacter(png, x0, y0, spec, direction, walking, frame) {
    const front = ['s', 'se', 'sw'].includes(direction);
    const back = ['n', 'ne', 'nw'].includes(direction);
    const side = ['e', 'w'].includes(direction);
    const sideSign = ['e', 'ne', 'se'].includes(direction) ? 1 : ['w', 'nw', 'sw'].includes(direction) ? -1 : 0;
    const step = walking ? [0, 4, 7, 3, -4, -7][frame % 6] : 0;
    const bob = walking ? (frame % 3 === 2 ? -1 : 0) : Math.round(Math.sin(frame * Math.PI / 2) * 1);
    const cx = x0 + 46;
    const feetY = y0 + 78 + bob;
    const headY = y0 + 28 + bob;

    ellipse(png, cx, feetY + 2, 17, 5, '#05080c', 82);
    rect(png, cx - 5 + step, feetY - 13, 5, 14, spec.robeDark);
    rect(png, cx + 1 - step, feetY - 13, 5, 14, spec.robeDark);
    rect(png, cx - 7 + step, feetY - 2, 7, 3, '#151515');
    rect(png, cx + 1 - step, feetY - 2, 7, 3, '#151515');

    const capeShift = sideSign * 4;
    polygon(png, [
        [cx - 15 - capeShift, y0 + 39 + bob],
        [cx + 15 - capeShift, y0 + 39 + bob],
        [cx + 12 - capeShift, feetY - 6],
        [cx - 12 - capeShift, feetY - 6],
    ], spec.robeDark, 235);

    if (spec.family === 'claude') drawClaudeBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob);
    else if (spec.family === 'gemini') drawGeminiBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob);
    else if (spec.family === 'kimi') drawKimiBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob);
    else drawCodexBody(png, cx, y0, feetY, headY, spec, front, back, side, sideSign, step, bob);
}

function assertManifested(ids) {
    const manifestIds = collectManifestIds();
    const unmanifested = ids.filter((id) => !manifestIds.has(id));
    if (!unmanifested.length) return;

    const message = `unmanifested sprite IDs: ${unmanifested.join(', ')}`;
    if (!allowUnmanifested) {
        throw new Error(`${message}; pass --allow-unmanifested only for scratch assets`);
    }
    console.warn(`[baseline] WARNING: ${message}`);
}

function collectManifestIds() {
    const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
    const ids = new Set();
    for (const key of ['characters', 'accessories', 'statusOverlays', 'buildings', 'props', 'vegetation', 'terrain', 'bridges', 'atmosphere']) {
        for (const entry of manifest[key] || []) {
            if (entry?.id) ids.add(entry.id);
        }
    }
    return ids;
}

function drawClaudeBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob) {
    polygon(png, [[cx - 13, y0 + 41 + bob], [cx + 13, y0 + 41 + bob], [cx + 10, feetY - 8], [cx - 10, feetY - 8]], spec.robe);
    rect(png, cx - 8, y0 + 45 + bob, 16, 3, spec.trim);
    line(png, cx, y0 + 43 + bob, cx, feetY - 12, spec.trim, 2);

    if (spec.model === 'opus') {
        polygon(png, [[cx - 18, y0 + 40 + bob], [cx, y0 + 31 + bob], [cx + 18, y0 + 40 + bob], [cx + 10, y0 + 50 + bob], [cx - 10, y0 + 50 + bob]], spec.trim, 220);
        diamond(png, cx, y0 + 54 + bob, 5, spec.accent);
        line(png, cx + 17, y0 + 34 + bob, cx + 20, feetY - 7, '#5b351d', 2);
        ellipse(png, cx + 18, y0 + 31 + bob, 4, 4, spec.accent, 230);
    } else {
        rect(png, cx - 9, y0 + 53 + bob, 18, 9, '#d8bd82');
        line(png, cx - 9, y0 + 53 + bob, cx + 9, y0 + 62 + bob, spec.accent, 1);
        line(png, cx + 14, y0 + 41 + bob, cx + 20, y0 + 32 + bob, '#f7efe2', 2);
        line(png, cx + 19, y0 + 31 + bob, cx + 23, y0 + 28 + bob, spec.accent, 1);
    }

    rect(png, cx - 16, y0 + 45 + bob + step / 2, 6, 16, spec.robeDark);
    rect(png, cx + 10, y0 + 45 + bob - step / 2, 6, 16, spec.robeDark);
    ellipse(png, cx, headY + 1, 10, 11, spec.skin);
    polygon(png, [[cx - 12, headY - 4], [cx, headY - 16], [cx + 12, headY - 4], [cx + 9, headY + 8], [cx - 9, headY + 8]], spec.robeDark);
    line(png, cx - 9, headY - 3, cx + 9, headY - 3, spec.trim, 2);
    if (!back) {
        rect(png, cx - 4 + sideSign, headY, 2, 2, '#1d1712');
        rect(png, cx + 3 + sideSign, headY, 2, 2, '#1d1712');
    }
}

function drawCodexBody(png, cx, y0, feetY, headY, spec, front, back, side, sideSign, step, bob) {
    rect(png, cx - 11, y0 + 42 + bob, 22, 26, spec.robe);
    rect(png, cx - 13, y0 + 50 + bob, 26, 5, spec.robeDark);
    line(png, cx - 7, y0 + 43 + bob, cx - 7, y0 + 66 + bob, spec.trim, 2);
    line(png, cx + 7, y0 + 43 + bob, cx + 7, y0 + 66 + bob, spec.accent, 2);

    if (spec.model === 'gpt55') {
        diamond(png, cx, y0 + 55 + bob, 6, spec.trim);
        ellipse(png, cx, headY - 12, 13, 4, spec.trim, 210);
        ellipse(png, cx, headY - 12, 8, 2, spec.accent, 220);
    } else if (spec.model === 'gpt54') {
        gear(png, cx + 12, y0 + 47 + bob, 7, spec.metal);
        rect(png, cx - 18, y0 + 55 + bob, 11, 8, '#d8bd82');
        line(png, cx - 17, y0 + 57 + bob, cx - 9, y0 + 57 + bob, spec.accent, 1);
    } else {
        polygon(png, [[cx - 5, y0 + 44 + bob], [cx + 8, y0 + 44 + bob], [cx + 1, y0 + 55 + bob], [cx + 9, y0 + 55 + bob], [cx - 4, y0 + 70 + bob], [cx, y0 + 58 + bob], [cx - 9, y0 + 58 + bob]], spec.trim);
        line(png, cx - 15, y0 + 42 + bob, cx - 22, y0 + 35 + bob, spec.accent, 2);
    }

    rect(png, cx - 16, y0 + 46 + bob + step / 2, 6, 16, spec.robeDark);
    rect(png, cx + 10, y0 + 46 + bob - step / 2, 6, 16, spec.robeDark);
    ellipse(png, cx, headY + 2, 10, 10, spec.skin);
    rect(png, cx - 9, headY - 7, 18, 7, spec.hair);
    if (!back) {
        rect(png, cx - 8 + sideSign, headY - 1, 7, 4, '#1e2b2f');
        rect(png, cx + 1 + sideSign, headY - 1, 7, 4, '#1e2b2f');
        rect(png, cx - 6 + sideSign, headY, 3, 2, spec.accent);
        rect(png, cx + 3 + sideSign, headY, 3, 2, spec.accent);
        line(png, cx - 1 + sideSign, headY + 1, cx + 1 + sideSign, headY + 1, spec.metal, 1);
    }
}

function drawKimiBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob) {
    const shadow = '#2a141a';
    const ivory = spec.robe;
    const rose = spec.robeDark;
    const gold = spec.trim;
    const glow = '#ffeff3';
    const side = sideSign || 1;

    // High-priest executor silhouette: cloak tails, white robe panels, gold armor.
    polygon(png, [[cx - 15, y0 + 42 + bob], [cx + 15, y0 + 42 + bob], [cx + 14, feetY - 8], [cx + 5, feetY + 1], [cx, feetY - 5], [cx - 5, feetY + 1], [cx - 14, feetY - 8]], rose, 245);
    polygon(png, [[cx - 10, y0 + 45 + bob], [cx + 10, y0 + 45 + bob], [cx + 9, feetY - 9], [cx + 2, feetY - 4], [cx, feetY - 11], [cx - 2, feetY - 4], [cx - 9, feetY - 9]], ivory, 250);
    polygon(png, [[cx - 17, y0 + 43 + bob], [cx - 7, y0 + 35 + bob], [cx - 1, y0 + 43 + bob], [cx - 10, y0 + 51 + bob]], gold, 245);
    polygon(png, [[cx + 17, y0 + 43 + bob], [cx + 7, y0 + 35 + bob], [cx + 1, y0 + 43 + bob], [cx + 10, y0 + 51 + bob]], gold, 245);
    line(png, cx - 7, y0 + 48 + bob, cx - 10, feetY - 9, spec.accent, 1, 220);
    line(png, cx + 7, y0 + 48 + bob, cx + 10, feetY - 9, spec.accent, 1, 220);

    // Ornate chest plate and sash.
    polygon(png, [[cx - 8, y0 + 46 + bob], [cx, y0 + 39 + bob], [cx + 8, y0 + 46 + bob], [cx + 5, y0 + 57 + bob], [cx - 5, y0 + 57 + bob]], gold, 250);
    diamond(png, cx, y0 + 50 + bob, 4, spec.accent, 245);
    rect(png, cx - 13, y0 + 57 + bob, 26, 4, shadow, 240);
    rect(png, cx - 4, y0 + 56 + bob, 8, 6, gold, 255);
    line(png, cx - 9, y0 + 62 + bob, cx - 4, feetY - 6, rose, 2, 230);
    line(png, cx + 9, y0 + 62 + bob, cx + 4, feetY - 6, rose, 2, 230);

    // Armored sleeves with heavy cuffs, readable even at village scale.
    polygon(png, [[cx - 16, y0 + 45 + bob + step / 2], [cx - 22, y0 + 50 + bob + step / 2], [cx - 19, y0 + 65 + bob + step / 2], [cx - 12, y0 + 58 + bob + step / 2]], rose, 245);
    polygon(png, [[cx + 16, y0 + 45 + bob - step / 2], [cx + 22, y0 + 50 + bob - step / 2], [cx + 19, y0 + 65 + bob - step / 2], [cx + 12, y0 + 58 + bob - step / 2]], rose, 245);
    rect(png, cx - 23, y0 + 59 + bob + step / 2, 7, 4, gold, 245);
    rect(png, cx + 16, y0 + 59 + bob - step / 2, 7, 4, gold, 245);
    px(png, cx - 20, y0 + 61 + bob + step / 2, glow, 220);
    px(png, cx + 20, y0 + 61 + bob - step / 2, glow, 220);

    // Boots and robe hem points.
    rect(png, cx - 12 + step, feetY - 1, 9, 6, shadow);
    rect(png, cx + 3 - step, feetY - 1, 9, 6, shadow);
    rect(png, cx - 10 + step, feetY + 3, 8, 2, gold, 190);
    rect(png, cx + 2 - step, feetY + 3, 8, 2, gold, 190);
    diamond(png, cx - 7, feetY - 10, 3, spec.accent, 200);
    diamond(png, cx + 7, feetY - 10, 3, spec.accent, 200);

    // Face, mask, and horned crown based on the reference sheet.
    ellipse(png, cx, headY + 1, 10, 11, spec.skin, back ? 100 : 255);
    polygon(png, [[cx - 11, headY - 5], [cx - 5, headY - 13], [cx, headY - 16], [cx + 5, headY - 13], [cx + 11, headY - 5], [cx + 9, headY + 8], [cx - 9, headY + 8]], rose, 245);
    polygon(png, [[cx - 10, headY - 6], [cx, headY - 14], [cx + 10, headY - 6], [cx + 6, headY + 3], [cx - 6, headY + 3]], gold, 235);
    line(png, cx - 8, headY - 2, cx + 8, headY - 2, glow, 1, 230);
    line(png, cx - 8, headY - 10, cx - 14, headY - 23, gold, 2, 245);
    line(png, cx + 8, headY - 10, cx + 14, headY - 23, gold, 2, 245);
    line(png, cx - 12, headY - 16, cx - 18, headY - 24, spec.accent, 1, 230);
    line(png, cx + 12, headY - 16, cx + 18, headY - 24, spec.accent, 1, 230);
    star(png, cx, headY - 15, 3, glow, 230);

    if (!back) {
        rect(png, cx - 7 + sideSign, headY, 14, 3, shadow, 230);
        rect(png, cx - 5 + sideSign, headY, 3, 2, glow, 245);
        rect(png, cx + 2 + sideSign, headY, 3, 2, glow, 245);
        px(png, cx + sideSign, headY + 5, spec.accent, 230);
    } else {
        line(png, cx - 6, headY + 1, cx + 6, headY + 1, gold, 1, 210);
    }
}

function drawGeminiBody(png, cx, y0, feetY, headY, spec, front, back, sideSign, step, bob) {
    polygon(png, [[cx - 12, y0 + 42 + bob], [cx + 12, y0 + 42 + bob], [cx + 9, feetY - 8], [cx - 9, feetY - 8]], spec.robe);
    polygon(png, [[cx - 15, y0 + 48 + bob], [cx, y0 + 39 + bob], [cx + 15, y0 + 48 + bob], [cx + 11, y0 + 58 + bob], [cx - 11, y0 + 58 + bob]], spec.robeDark, 220);
    line(png, cx, y0 + 42 + bob, cx, feetY - 10, spec.trim, 2);
    diamond(png, cx, y0 + 55 + bob, 5, spec.accent);
    ellipse(png, cx, headY - 7, 14, 6, spec.accent, 90);
    rect(png, cx - 15, y0 + 45 + bob + step / 2, 5, 16, spec.robeDark);
    rect(png, cx + 10, y0 + 45 + bob - step / 2, 5, 16, spec.robeDark);
    ellipse(png, cx, headY + 1, 10, 11, spec.skin);
    polygon(png, [[cx - 11, headY - 4], [cx, headY - 15], [cx + 11, headY - 4], [cx + 8, headY + 8], [cx - 8, headY + 8]], spec.robeDark);
    line(png, cx - 8, headY - 4, cx + 8, headY - 4, spec.trim, 2);
    if (!back) {
        rect(png, cx - 4 + sideSign, headY, 2, 2, '#1d1712');
        rect(png, cx + 3 + sideSign, headY, 2, 2, '#1d1712');
        px(png, cx, headY - 8, spec.accent, 220);
    }
    star(png, cx + 17 * (sideSign || 1), y0 + 35 + bob, 4, spec.accent);
}

function drawEffortOverlay(png, effort) {
    const cx = 16;
    if (effort.kind === 'low') {
        diamond(png, cx, 15, 4, effort.color);
        rect(png, cx - 1, 11, 2, 8, effort.glow, 180);
    } else if (effort.kind === 'medium') {
        ellipse(png, cx, 16, 10, 4, effort.color, 220);
        rect(png, cx - 7, 14, 14, 4, '#252018', 210);
        rect(png, cx - 4, 15, 8, 2, effort.glow, 220);
    } else if (effort.kind === 'high') {
        polygon(png, [[cx - 9, 20], [cx - 5, 10], [cx, 17], [cx + 5, 10], [cx + 9, 20]], effort.color);
        rect(png, cx - 8, 19, 16, 3, '#362818', 210);
        diamond(png, cx, 15, 4, effort.glow);
    } else {
        ellipse(png, cx, 15, 12, 7, effort.glow, 120);
        ellipse(png, cx, 15, 8, 4, effort.color, 220);
        diamond(png, cx, 15, 5, '#ffffff', 210);
        line(png, cx, 4, cx, 26, effort.glow, 1);
        line(png, 5, 15, 27, 15, effort.glow, 1);
    }
}

function writePng(path, png) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(png));
    console.log(`wrote ${path.replace(repoRoot + '/', '')}`);
}

function color(hex, alpha = 255) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
}

function px(png, x, y, hex, alpha = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const [r, g, b, a] = color(hex, alpha);
    const idx = (png.width * y + x) << 2;
    const inv = 255 - a;
    png.data[idx] = Math.round((r * a + png.data[idx] * inv) / 255);
    png.data[idx + 1] = Math.round((g * a + png.data[idx + 1] * inv) / 255);
    png.data[idx + 2] = Math.round((b * a + png.data[idx + 2] * inv) / 255);
    png.data[idx + 3] = Math.min(255, a + Math.round(png.data[idx + 3] * inv / 255));
}

function rect(png, x, y, w, h, hex, alpha = 255) {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++)
        for (let xx = Math.round(x); xx < Math.round(x + w); xx++)
            px(png, xx, yy, hex, alpha);
}

function ellipse(png, cx, cy, rx, ry, hex, alpha = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
            if (((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1)
                px(png, x, y, hex, alpha);
}

function line(png, x0, y0, x1, y1, hex, width = 1, alpha = 255) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
        rect(png, x0 - Math.floor(width / 2), y0 - Math.floor(width / 2), width, width, hex, alpha);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

function polygon(png, points, hex, alpha = 255) {
    const minY = Math.floor(Math.min(...points.map(p => p[1])));
    const maxY = Math.ceil(Math.max(...points.map(p => p[1])));
    for (let y = minY; y <= maxY; y++) {
        const xs = [];
        for (let i = 0; i < points.length; i++) {
            const [x1, y1] = points[i];
            const [x2, y2] = points[(i + 1) % points.length];
            if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
                xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i < xs.length; i += 2) {
            for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) px(png, x, y, hex, alpha);
        }
    }
}

function diamond(png, cx, cy, r, hex, alpha = 255) {
    polygon(png, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], hex, alpha);
}

function star(png, cx, cy, r, hex, alpha = 255) {
    line(png, cx - r, cy, cx + r, cy, hex, 1, alpha);
    line(png, cx, cy - r, cx, cy + r, hex, 1, alpha);
    px(png, cx - 1, cy - 1, hex, alpha);
    px(png, cx + 1, cy + 1, hex, alpha);
}

function gear(png, cx, cy, r, hex) {
    ellipse(png, cx, cy, r, r, hex, 230);
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        rect(png, cx + Math.cos(a) * r - 1, cy + Math.sin(a) * r - 1, 3, 3, hex, 240);
    }
    ellipse(png, cx, cy, Math.max(2, r - 4), Math.max(2, r - 4), '#12353b', 255);
}
