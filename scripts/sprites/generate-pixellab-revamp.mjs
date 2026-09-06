#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import yaml from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
const manifestPath = join(spritesRoot, 'manifest.yaml');
const cacheRoot = join(repoRoot, 'output', 'pixellab-cache');
const API_BASE = 'https://api.pixellab.ai/v2';
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const CELL = 92;
const WALK_ROWS = 6;
const IDLE_ROWS = 4;

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const skipApi = args.has('--skip-api');
const dryRun = args.has('--dry-run');
const allowUnmanifested = args.has('--allow-unmanifested');
const onlyMap = args.has('--map-only');
const onlyBuildings = args.has('--buildings-only');
const onlyCharacters = args.has('--characters-only');
const idsArg = process.argv.slice(2).find((arg) => arg.startsWith('--ids='));
const idFilter = idsArg
    ? new Set(idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean))
    : null;

// Style anchor is single-sourced from manifest.yaml — no divergent hardcoded
// style constant (the manifest is the one source of truth). Per generate.md,
// the anchor is prepended to each entry's subject-only prompt.
const MANIFEST = yaml.load(readFileSync(manifestPath, 'utf8'));
const STYLE = MANIFEST?.style?.anchor
    || 'high-fantasy pixel art, transparent background, no text, no logo, no UI';

// Buildings are read from the manifest: subject-only prompt + target dims taken
// from the current on-disk base.png. All buildings are single-image (composeGrid
// retired), so a regen preserves the sprite footprint.
const BUILDINGS = buildBuildingSpecsFromManifest(MANIFEST);

const CHARACTERS = [
    character('agent.claude.opus', 'Claude Opus archmage scholar, ivory and amber robe, broad gold rune mantle, high collar, glowing tome, short staff, powerful mage silhouette'),
    character('agent.claude.sonnet', 'Claude Sonnet scribe mage, amber scholar cloak, silver quill, open tome, nimble robe silhouette, calm bardic scholar energy'),
    character('agent.codex.gpt55', 'Codex GPT-5.5 master artificer, teal engineer coat, gold arcane lens, luminous chest core, tool belt, elite inventor silhouette'),
    character('agent.codex.gpt54', 'Codex GPT-5.4 senior engineer, blue teal coat, brass goggles, gear pauldron, blueprint scroll, sturdy artificer silhouette'),
    character('agent.codex.gpt53spark', 'Codex GPT-5.3 Spark scout artificer, yellow cyan lightning sash, light runner coat, compact fast engineer silhouette'),
    character('agent.kimi.base', 'Kimi celestial horned executor, ivory ceremonial robe panels, rose-pink cloak tails, ornate gold chest armor, tall twin horn crown, glowing pale mask eyes, heroic high-fantasy RPG silhouette, no handheld staff, no handheld weapon, 8-direction pixel art'),
];

main().catch((err) => {
    console.error(`[pixellab-revamp] ${err.stack || err.message}`);
    process.exit(1);
});

async function main() {
    if (!idFilter) {
        throw new Error('legacy PixelLab revamp generation requires an explicit --ids=<manifest-id[,manifest-id...]> list');
    }
    const plannedIds = plannedSpriteIds();
    assertManifested(plannedIds);
    if (dryRun) {
        console.log(`[pixellab-revamp] dry run: ${plannedIds.length} manifest-backed sprite IDs selected`);
        for (const id of plannedIds) console.log(`[pixellab-revamp] ${id}`);
        return;
    }

    mkdirSync(cacheRoot, { recursive: true });
    const token = skipApi ? null : readToken();

    if (!onlyBuildings && !onlyCharacters && !idFilter) {
        await generateMapConcept(token);
    }
    if (!onlyMap && !onlyCharacters) {
        for (const spec of BUILDINGS) {
            if (idFilter && !idFilter.has(spec.id)) continue;
            await generateBuilding(token, spec);
        }
    }
    if (!onlyMap && !onlyBuildings) {
        for (const spec of CHARACTERS) {
            if (idFilter && !idFilter.has(spec.id)) continue;
            await generateCharacter(token, spec);
        }
    }
}

// Build single-image building specs from the manifest: subject-only prompt from
// the entry, target dims from the current on-disk base.png (falls back to 256²).
function buildBuildingSpecsFromManifest(manifest) {
    const specs = [];
    for (const entry of manifest?.buildings || []) {
        if (!entry?.id || !entry.prompt) continue;
        const dims = baseDimsFor(entry.id);
        specs.push({
            id: entry.id,
            kind: 'standard',
            description: entry.prompt,
            width: dims?.w || 256,
            height: dims?.h || 256,
        });
    }
    return specs;
}

function baseDimsFor(id) {
    const path = join(spritesRoot, 'buildings', id, 'base.png');
    if (!existsSync(path)) return null;
    try {
        const png = PNG.sync.read(readFileSync(path));
        return { w: png.width, h: png.height };
    } catch {
        return null;
    }
}

function character(id, description) {
    return { id, kind: 'character', description, width: CELL, height: CELL };
}

function plannedSpriteIds() {
    const ids = [];
    if (!onlyMap && !onlyCharacters) {
        ids.push(...BUILDINGS.filter((spec) => !idFilter || idFilter.has(spec.id)).map((spec) => spec.id));
    }
    if (!onlyMap && !onlyBuildings) {
        ids.push(...CHARACTERS.filter((spec) => !idFilter || idFilter.has(spec.id)).map((spec) => spec.id));
    }
    return ids;
}

function assertManifested(ids) {
    const manifestIds = collectManifestIds();
    const unmanifested = ids.filter((id) => !manifestIds.has(id));
    if (!unmanifested.length) return;

    const message = `unmanifested sprite IDs: ${unmanifested.join(', ')}`;
    if (!allowUnmanifested) {
        throw new Error(`${message}; pass --allow-unmanifested only for scratch assets`);
    }
    console.warn(`[pixellab-revamp] WARNING: ${message}`);
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

function readToken() {
    const envPath = join(repoRoot, '.dev.vars');
    if (!existsSync(envPath)) throw new Error('.dev.vars not found');
    const env = Object.fromEntries(
        readFileSync(envPath, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && line.includes('='))
            .map((line) => {
                const idx = line.indexOf('=');
                return [line.slice(0, idx), line.slice(idx + 1).replace(/^["']|["']$/g, '')];
            })
    );
    const token = env.PIXELLAB_API_TOKEN || env.PIXELLAB_AUTHORIZATION?.replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('PIXELLAB_API_TOKEN or PIXELLAB_AUTHORIZATION missing in .dev.vars');
    return token;
}

async function generateMapConcept(token) {
    const out = join(cacheRoot, 'town-concept.png');
    if (!force && existsSync(out)) {
        console.log(`[pixellab-revamp] cached map concept ${relativeOut(out)}`);
        return;
    }
    if (skipApi) return;
    const png = await pixflux(token, {
        cacheKey: 'town-concept.raw.png',
        description: [
            'top-down old-school fantasy RPG village concept map for ClaudeVille',
            'central stone civic plaza with command keep, city hall, and task board',
            'river crossing through town, harbor lighthouse and docks on the east water edge',
            'forge row, token mine yard, scholars archive, observatory, sanctuary grove, arcane portal',
            'clear readable district organization, winding roads, no labels, no text',
        ].join(', '),
        width: 400,
        height: 400,
        transparent: false,
        seed: 82011,
    });
    writePng(out, png);
}

async function generateBuilding(token, spec) {
    const cacheKey = `buildings/${spec.id}.raw.png`;
    if (skipApi && !existsSync(join(cacheRoot, cacheKey))) return;
    const raw = await pixflux(token, {
        cacheKey,
        description: `${STYLE}, ${spec.description}`,
        width: spec.width,
        height: spec.height,
        transparent: true,
        seed: hashSeed(spec.id),
    });
    const png = keyOutEdgeBackground(raw);

    if (spec.kind === 'hero') {
        const normalized = resizeNearest(png, spec.width, spec.height);
        const cols = spec.cols || 3;
        const rows = spec.rows || 2;
        const cellW = Math.round(spec.width / cols);
        const cellH = Math.round(spec.height / rows);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tile = crop(normalized, c * cellW, r * cellH, cellW, cellH);
                writePng(join(spritesRoot, 'buildings', spec.id, `base-${c}-${r}.png`), tile);
            }
        }
    } else {
        writePng(join(spritesRoot, 'buildings', spec.id, 'base.png'), resizeNearest(png, spec.width, spec.height));
    }
}

async function generateCharacter(token, spec) {
    const sheet = await pixflux(token, {
        cacheKey: `characters/${spec.id}.sheet.raw.png`,
        description: [
            STYLE,
            'complete transparent character animation sprite sheet',
            `${spec.description}`,
            `exact ${DIRECTIONS.length} columns for directions ${DIRECTIONS.join(', ')}`,
            `${WALK_ROWS + IDLE_ROWS} rows total`,
            `first ${WALK_ROWS} rows are a walk cycle with alternating legs, arms, robe hem, and planted foot contact`,
            `last ${IDLE_ROWS} rows are breathing idle poses`,
            `${CELL}px square cells, no grid lines, no labels, no text`,
        ].join(', '),
        width: CELL * DIRECTIONS.length,
        height: CELL * (WALK_ROWS + IDLE_ROWS),
        transparent: true,
        seed: hashSeed(spec.id),
    });
    writePng(
        join(spritesRoot, 'characters', spec.id, 'sheet.png'),
        resizeNearest(sheet, CELL * DIRECTIONS.length, CELL * (WALK_ROWS + IDLE_ROWS))
    );
}

function keyOutEdgeBackground(src) {
    const out = clonePng(src);
    const edgeSeedColors = sampleEdgeBackgroundColors(out);
    if (edgeSeedColors.length === 0) return out;

    const visited = new Uint8Array(out.width * out.height);
    const queue = [];
    const enqueue = (x, y) => {
        if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
        const idx = y * out.width + x;
        if (visited[idx]) return;
        visited[idx] = 1;
        if (!isBackgroundPixel(out, x, y, edgeSeedColors)) return;
        queue.push([x, y]);
    };

    for (let x = 0; x < out.width; x++) {
        enqueue(x, 0);
        enqueue(x, out.height - 1);
    }
    for (let y = 0; y < out.height; y++) {
        enqueue(0, y);
        enqueue(out.width - 1, y);
    }

    while (queue.length) {
        const [x, y] = queue.pop();
        const i = (out.width * y + x) << 2;
        out.data[i + 3] = 0;
        enqueue(x + 1, y);
        enqueue(x - 1, y);
        enqueue(x, y + 1);
        enqueue(x, y - 1);
    }

    return trimAlphaFringe(out);
}

function sampleEdgeBackgroundColors(png) {
    const samples = [];
    const points = [
        [0, 0],
        [Math.floor(png.width / 2), 0],
        [png.width - 1, 0],
        [0, Math.floor(png.height / 2)],
        [png.width - 1, Math.floor(png.height / 2)],
        [0, png.height - 1],
        [Math.floor(png.width / 2), png.height - 1],
        [png.width - 1, png.height - 1],
    ];

    for (const [x, y] of points) {
        const i = (png.width * y + x) << 2;
        if (png.data[i + 3] < 220) continue;
        samples.push([png.data[i], png.data[i + 1], png.data[i + 2]]);
    }

    return samples;
}

function isBackgroundPixel(png, x, y, seedColors) {
    const i = (png.width * y + x) << 2;
    if (png.data[i + 3] < 8) return true;
    let best = Infinity;
    for (const [r, g, b] of seedColors) {
        const dr = png.data[i] - r;
        const dg = png.data[i + 1] - g;
        const db = png.data[i + 2] - b;
        best = Math.min(best, dr * dr + dg * dg + db * db);
    }
    return best <= 85 * 85 * 3;
}

function trimAlphaFringe(png) {
    const out = clonePng(png);
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (png.width * y + x) << 2;
            if (png.data[i + 3] === 0) continue;
            let transparentNeighbor = false;
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
                if (nx < 0 || ny < 0 || nx >= png.width || ny >= png.height) continue;
                const ni = (png.width * ny + nx) << 2;
                if (png.data[ni + 3] === 0) transparentNeighbor = true;
            }
            if (!transparentNeighbor) continue;
            out.data[i] = Math.max(0, Math.round(out.data[i] * 0.82));
            out.data[i + 1] = Math.max(0, Math.round(out.data[i + 1] * 0.82));
            out.data[i + 2] = Math.max(0, Math.round(out.data[i + 2] * 0.82));
        }
    }
    return out;
}

async function pixflux(token, { cacheKey, description, width, height, transparent, seed }) {
    const cachePath = join(cacheRoot, cacheKey);
    if (!force && existsSync(cachePath)) {
        return PNG.sync.read(readFileSync(cachePath));
    }
    if (skipApi) throw new Error(`missing cache for ${cacheKey}`);
    mkdirSync(dirname(cachePath), { recursive: true });
    console.log(`[pixellab-revamp] generating ${cacheKey}`);
    const response = await fetch(`${API_BASE}/create-image-pixflux`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            description,
            image_size: { width, height },
            text_guidance_scale: 8,
            outline: 'single color black outline',
            shading: 'medium shading',
            detail: 'highly detailed',
            view: 'low top-down',
            isometric: true,
            no_background: transparent,
            seed,
        }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`PixelLab ${response.status} for ${cacheKey}: ${JSON.stringify(json)}`);
    }
    const image = json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0];
    if (!image?.base64) {
        throw new Error(`PixelLab response for ${cacheKey} did not include an image`);
    }
    const png = PNG.sync.read(Buffer.from(image.base64, 'base64'));
    writePng(cachePath, png);
    return png;
}

function crop(src, sx, sy, w, h) {
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            copyPixel(src, out, sx + x, sy + y, x, y);
        }
    }
    return out;
}

function resizeNearest(src, width, height) {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = Math.min(src.width - 1, Math.floor(x * src.width / width));
            const sy = Math.min(src.height - 1, Math.floor(y * src.height / height));
            copyPixel(src, out, sx, sy, x, y);
        }
    }
    return out;
}

function clonePng(src) {
    const out = new PNG({ width: src.width, height: src.height });
    src.data.copy(out.data);
    return out;
}

function copyPixel(src, dst, sx, sy, dx, dy) {
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return;
    const si = (src.width * sy + sx) << 2;
    const di = (dst.width * dy + dx) << 2;
    dst.data[di] = src.data[si];
    dst.data[di + 1] = src.data[si + 1];
    dst.data[di + 2] = src.data[si + 2];
    dst.data[di + 3] = src.data[si + 3];
}

function writePng(path, png) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(png));
    console.log(`[pixellab-revamp] wrote ${relativeOut(path)}`);
}

function hashSeed(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash % 1000000) + 1000;
}

function relativeOut(path) {
    const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
    return path.startsWith(root) ? path.slice(root.length) : path;
}
