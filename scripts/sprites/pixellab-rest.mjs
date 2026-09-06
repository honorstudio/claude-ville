#!/usr/bin/env node
// Shared PixelLab REST helpers for sprite bake scripts.
//
// Single-sourced here so new bake drivers do not copy/paste the pixflux call,
// the edge-background key-out, or the .dev.vars token read from
// generate-pixellab-revamp.mjs (which keeps its own legacy copies).
//
// Usage: import { pixflux, keyOutEdgeBackground, ... } from './pixellab-rest.mjs';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const API_BASE = 'https://api.pixellab.ai/v2';

export function readPixellabToken(envPath = join(repoRoot, '.dev.vars')) {
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

// Synchronous REST create-image-pixflux call (the endpoint returns the image
// inline). `size` is { width, height }; both must be <= 400. Retries bounded
// by `retries` on transport / 5xx / 429 with linear backoff; 4xx parameter
// errors are not retried. Returns a decoded PNG.
export async function pixflux(token, {
    description,
    width,
    height,
    transparent = true,
    seed = 0,
    retries = 2,
    label = 'pixflux',
} = {}) {
    const body = {
        description,
        image_size: { width, height },
        text_guidance_scale: 8,
        outline: 'single color black outline',
        shading: 'medium shading',
        // pixflux enum is 'low detail' | 'medium detail' | 'highly detailed'
        // (422-verified; the generic MCP enum docs list 'high detail' instead).
        detail: 'highly detailed',
        view: 'low top-down',
        isometric: true,
        no_background: transparent,
        seed,
    };
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const waitMs = 4000 * attempt;
            console.log(`[pixellab] retry ${attempt}/${retries} for ${label} in ${waitMs}ms`);
            await sleep(waitMs);
        }
        let response;
        try {
            response = await fetch(`${API_BASE}/create-image-pixflux`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            lastError = new Error(`PixelLab transport error for ${label}: ${err.message}`);
            continue;
        }
        const json = await response.json().catch(() => null);
        if (!response.ok) {
            const status = response.status;
            lastError = new Error(`PixelLab ${status} for ${label}: ${JSON.stringify(json)}`);
            // 429/5xx are worth a retry; 4xx parameter problems are not.
            if (status === 429 || status >= 500) continue;
            throw lastError;
        }
        const image = json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0];
        if (!image?.base64) {
            lastError = new Error(`PixelLab response for ${label} did not include an image`);
            continue;
        }
        return PNG.sync.read(Buffer.from(image.base64, 'base64'));
    }
    throw lastError;
}

// Async REST create-topdown-tileset call: POST /create-tileset returns 202
// with { background_job_id, tileset_id }; poll GET /tilesets/{tileset_id}
// until the job completes (200) — 423/404 while still processing. 422
// validation errors are thrown immediately (they are free and indicate a
// caller bug). Returns the decoded tileset payload { tiles, metadata, usage }
// where each tile carries { name, corners, original_position, image }.
export async function createTopdownTileset(token, {
    lowerDescription,
    upperDescription,
    transitionDescription = '',
    tileSize = 32,
    seed = null,
    shading = 'detailed shading',
    outline = 'lineless',
    detail = 'highly detailed',
    lowerReferenceImage = null,
    upperReferenceImage = null,
    label = 'tileset',
    pollIntervalMs = 8000,
    maxWaitMs = 6 * 60 * 1000,
    retries = 1,
} = {}) {
    const body = {
        lower_description: lowerDescription,
        upper_description: upperDescription,
        transition_description: transitionDescription,
        tile_size: { width: tileSize, height: tileSize },
        mode: 'standard',
        transition_size: 0,
        text_guidance_scale: 8,
        outline,
        shading,
        // Same enum family as pixflux: 'low detail' | 'medium detail' | 'highly detailed'.
        detail,
        view: 'high top-down',
    };
    if (lowerReferenceImage) body.lower_reference_image = { type: 'base64', base64: lowerReferenceImage, format: 'png' };
    if (upperReferenceImage) body.upper_reference_image = { type: 'base64', base64: upperReferenceImage, format: 'png' };
    if (seed != null) body.seed = seed;

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            console.log(`[pixellab] retry ${attempt}/${retries} for ${label}`);
            await sleep(5000 * attempt);
        }
        let response;
        try {
            response = await fetch(`${API_BASE}/create-tileset`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            lastError = new Error(`PixelLab transport error for ${label}: ${err.message}`);
            continue;
        }
        const json = await response.json().catch(() => null);
        if (!response.ok) {
            lastError = new Error(`PixelLab ${response.status} for ${label}: ${JSON.stringify(json)}`);
            if (response.status === 429 || response.status >= 500) continue;
            throw lastError;
        }
        const tilesetId = json?.tileset_id;
        if (!tilesetId) {
            lastError = new Error(`PixelLab response for ${label} did not include a tileset_id`);
            continue;
        }
        try {
            return await pollTileset(token, tilesetId, { label, pollIntervalMs, maxWaitMs });
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

async function pollTileset(token, tilesetId, { label, pollIntervalMs, maxWaitMs }) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
        const response = await fetch(`${API_BASE}/tilesets/${tilesetId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
            const json = await response.json();
            const tiles = json?.tileset?.tiles;
            if (!Array.isArray(tiles) || tiles.length === 0) {
                throw new Error(`PixelLab tileset ${tilesetId} for ${label} returned no tiles`);
            }
            return {
                tiles,
                metadata: json.metadata || null,
                usage: json.usage || null,
                tilesetId,
            };
        }
        // 423 Locked / 404 Not Found: still processing. Anything else is fatal.
        if (response.status !== 423 && response.status !== 404) {
            const json = await response.json().catch(() => null);
            throw new Error(`PixelLab poll ${response.status} for ${label}: ${JSON.stringify(json)}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`PixelLab tileset ${tilesetId} for ${label} timed out after ${maxWaitMs}ms`);
        }
        await sleep(pollIntervalMs);
    }
}

// Flood-fill background key-out seeded from the image border (same algorithm
// as generate-pixellab-revamp.mjs / key-out-bg.mjs): clears the connected
// edge background to transparent, then darkens the 1px alpha fringe.
export function keyOutEdgeBackground(src) {
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

export function trimAlphaFringe(png) {
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

export function resizeNearest(src, width, height) {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = Math.min(src.width - 1, Math.floor(x * src.width / width));
            const sy = Math.min(src.height - 1, Math.floor(y * src.height / height));
            const si = (src.width * sy + sx) << 2;
            const di = (out.width * y + x) << 2;
            out.data[di] = src.data[si];
            out.data[di + 1] = src.data[si + 1];
            out.data[di + 2] = src.data[si + 2];
            out.data[di + 3] = src.data[si + 3];
        }
    }
    return out;
}

export function clonePng(src) {
    const out = new PNG({ width: src.width, height: src.height });
    src.data.copy(out.data);
    return out;
}

// Centre a square source frame in a `cell`×`cell` window: crop when the source
// is larger, pad with transparency when it is smaller. Shared by the character
// sheet and action-strip assemblers so both keep the same feet/anchor.
export function fitCenterToCell(src, cell) {
    if (src.width !== src.height) throw new Error(`expected a square frame, got ${src.width}×${src.height}`);
    const off = Math.floor((src.width - cell) / 2);
    const out = new PNG({ width: cell, height: cell });
    out.data.fill(0);
    for (let y = 0; y < cell; y++) {
        const sy = off + y;
        if (sy < 0 || sy >= src.height) continue;
        for (let x = 0; x < cell; x++) {
            const sx = off + x;
            if (sx < 0 || sx >= src.width) continue;
            const si = (src.width * sy + sx) << 2;
            const di = (cell * y + x) << 2;
            out.data[di] = src.data[si];
            out.data[di + 1] = src.data[si + 1];
            out.data[di + 2] = src.data[si + 2];
            out.data[di + 3] = src.data[si + 3];
        }
    }
    return out;
}

export function blitPng(src, dst, dx, dy) {
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const dxx = dx + x;
            const dyy = dy + y;
            if (dxx < 0 || dyy < 0 || dxx >= dst.width || dyy >= dst.height) continue;
            const si = (src.width * y + x) << 2;
            const di = (dst.width * dyy + dxx) << 2;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = src.data[si + 3];
        }
    }
}

// ─── Character library (REST) ────────────────────────────────────────────────
// The MCP mount in this harness carries no bearer header, so character reads
// and animation requests go through REST with the .dev.vars token.

async function characterApi(token, path, { method = 'GET', body = null, label = path } = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`PixelLab ${response.status} for ${label}: ${JSON.stringify(json)}`);
    return json;
}

// { credits, subscription: { generations, total, plan } }
export function getBalance(token) {
    return characterApi(token, '/balance', { label: 'balance' });
}

export function getCharacter(token, characterId) {
    return characterApi(token, `/characters/${characterId}`, { label: `character ${characterId}` });
}

export async function listCharacters(token, { pageSize = 50 } = {}) {
    const characters = [];
    for (let offset = 0; ; offset += pageSize) {
        const page = await characterApi(token, `/characters?limit=${pageSize}&offset=${offset}`, { label: 'characters' });
        const batch = page?.characters || [];
        characters.push(...batch);
        if (!batch.length || characters.length >= Number(page?.total || 0)) break;
    }
    return characters;
}

// v3 custom animation: one background job per direction. `frameCount` must be
// even, 4–16; `keepFirstFrame:false` stores exactly `frameCount` frames.
export function createCharacterAnimation(token, {
    characterId,
    animationName,
    actionDescription,
    frameCount = 4,
    directions,
    keepFirstFrame = false,
    seed = null,
}) {
    return characterApi(token, '/characters/animations', {
        method: 'POST',
        label: `animate ${animationName} on ${characterId}`,
        body: {
            character_id: characterId,
            animation_name: animationName,
            action_description: actionDescription,
            mode: 'v3',
            frame_count: frameCount,
            keep_first_frame: keepFirstFrame,
            directions,
            ...(seed === null ? {} : { seed }),
        },
    });
}

// A named group's frames, merged across every record carrying that name: a
// repaired direction arrives as its own record, so one direction's frames can
// live in a later record than the rest. Later records win per direction.
export function characterAnimationFrames(character, animationName, { frameCount = 1 } = {}) {
    const byDirection = new Map();
    const groupIds = [];
    for (const animation of character?.animations || []) {
        if (animation.display_name !== animationName && animation.animation_type !== animationName) continue;
        if (animation.animation_group_id) groupIds.push(animation.animation_group_id);
        for (const entry of animation.directions || []) {
            if ((entry.frames?.length || 0) < frameCount) continue;
            byDirection.set(entry.direction, entry.frames);
        }
    }
    return { byDirection, groupIds };
}

// Resolves once every requested direction of `animationName` carries
// `frameCount` frames. Throws after `maxWaitMs`, or after `stallMs` without a
// single new direction — a failed background job never completes, so the caller
// repairs the missing directions instead of waiting out the whole deadline.
export async function waitForCharacterAnimation(token, characterId, {
    animationName,
    directions,
    frameCount,
    pollIntervalMs = 20_000,
    maxWaitMs = 25 * 60 * 1000,
    stallMs = 6 * 60 * 1000,
    label = animationName,
} = {}) {
    const deadline = Date.now() + maxWaitMs;
    let best = -1;
    let lastProgress = Date.now();
    for (;;) {
        const character = await getCharacter(token, characterId);
        const { byDirection, groupIds } = characterAnimationFrames(character, animationName, { frameCount });
        const ready = directions.filter((direction) => byDirection.has(direction));
        if (ready.length === directions.length) return { character, byDirection, groupIds };
        if (ready.length > best) {
            best = ready.length;
            lastProgress = Date.now();
        }
        const stalled = Date.now() - lastProgress > stallMs;
        if (stalled || Date.now() > deadline) {
            const missing = directions.filter((direction) => !byDirection.has(direction));
            throw new Error(`PixelLab animation ${label} ${stalled ? 'stalled' : 'timed out'} with ${ready.length}/${directions.length} directions complete (missing ${missing.join(', ')})`);
        }
        console.log(`[pixellab] ${label}: ${ready.length}/${directions.length} directions complete`);
        await sleep(pollIntervalMs);
    }
}

export async function fetchPng(url, { retries = 2, label = 'frame' } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(2000 * attempt);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return PNG.sync.read(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
            lastError = new Error(`download failed for ${label}: ${err.message}`);
        }
    }
    throw lastError;
}

export function writePng(path, png) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(png));
}

// Deterministic per-id seed (same FNV-1a variant as generate-pixellab-revamp.mjs
// so rebakes of an id stay in the same seed family).
export function hashSeed(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash % 1000000) + 1000;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
