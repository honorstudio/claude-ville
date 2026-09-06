#!/usr/bin/env node
// Validates that every PNG path implied by manifest.yaml exists, and that no
// orphan PNGs sit in assets/sprites/ outside _placeholder/.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { PNG } from 'pngjs';
import {
    collectSpriteEntries,
    expectedPathsForEntry,
    loadSpriteManifest,
    palettesPath,
    pathForEntry,
    repoRoot,
    spritesRoot,
} from './manifest-utils.mjs';
import {
    materialExpectedPngPaths,
    validateMaterialContract,
} from './channel-validation.mjs';

const args = process.argv.slice(2);
const orphanAllowlist = new Set([
    ...args
        .filter((arg) => arg.startsWith('--allow-orphan='))
        .flatMap((arg) => arg.slice('--allow-orphan='.length).split(','))
        .map((rel) => rel.trim())
        .filter(Boolean),
]);
const duplicatePngAllowlist = new Set();

// Heuristic thresholds for the "is it a cube?" warnings below. Calibrated
// 2026-07-17 against the four shipped block-cube defects (banner/watchfire/
// portalGlow fill ≈ 0.77-0.78) and healthy isolated sprites (≤0.63).
const CUBE_FILL_RATIO_WARN = 0.72;
const CUBE_OPAQUE_CORNERS_WARN = 2;
const CUBE_CHECK_GROUPS = ['props', 'vegetation', 'accessories', 'statusOverlays', 'equipment'];
const DIMENSION_CHECK_GROUPS = ['props', 'vegetation', 'accessories', 'statusOverlays', 'bridges'];
const REFERENCE_CHECK_GROUPS = ['props', 'vegetation', 'bridges', 'atmosphere'];
// Deliberately unreferenced today (documented keeps); everything else in the
// reference-checked groups should have a live code path. monument.* is wired
// into ChronicleMonuments (plan 6.1) and intentionally NOT allowlisted.
const UNREFERENCED_ALLOWLIST = new Set([
    'bridge.ew', // reserved for a future EW plank crossing (manifest comment)
    // 4.1 inspection interior kit: the six props are baked into
    // buildings/building.command/interior.png rather than drawn at runtime, so
    // no code path names them; they stay inventoried for the next aperture.
    'prop.interior.readingDesk',
    'prop.interior.anvilBench',
    'prop.interior.planningTable',
    'prop.interior.archiveShelf',
    'prop.interior.instrumentStand',
    'prop.interior.cargoBench',
]);
// Visually verified non-cubes that the fill heuristic still flags (bulky by
// design); keeps the warning channel free of explained noise.
const CUBE_FILL_ALLOWLIST = new Set([
    'prop.flowerCart', // 75% fill — the cart crate body is boxy by design; re-hued in 6.5
]);

const manifest = loadSpriteManifest();
const palettes = yaml.load(readFileSync(palettesPath, 'utf8'));

const expected = new Set();
const characterEntries = [];
const equipmentEntries = [];
const manifestEntries = [];
const CHARACTER_DIRECTIONS = 8;
const CHARACTER_DIRECTION_KEYS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const CHARACTER_WALK_FRAMES = 6;
const CHARACTER_IDLE_FRAMES = 4;
const CHARACTER_ROWS = CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES;
const CHARACTER_CELL = 92;
const ALPHA_THRESHOLD = 16;
const MIN_NORMALIZED_WALK_DELTA = 32;
const REQUIRED_EQUIPMENT_MIN_PIXELS = Object.freeze({
    dagger: 8,
    multitool: 10,
    sword: 12,
    greatsword: 18,
    wrench: 18,
    polearm: 16,
    shield: 24,
    swordShield: 32,
});
const CHARACTER_GENERATION_MODES = new Set(['standard', 'pro']);
const REQUIRED_PRO_CHARACTER_IDS = new Set([
    'agent.codex.gpt53spark',
    'agent.codex.gpt54',
    'agent.codex.gpt55',
]);

for (const e of collectSpriteEntries(manifest)) {
    manifestEntries.push(e);
    if (e.id?.startsWith('agent.')) characterEntries.push(e);
    if (e.id?.startsWith('equipment.')) equipmentEntries.push(e);
    for (const p of expectedPathsForEntry(e)) expected.add(p);
}
const expectedMaterialPngPaths = materialExpectedPngPaths(manifest);
for (const path of expectedMaterialPngPaths) expected.add(path);

let invalidManifest = 0;
for (const entry of manifestEntries) {
    invalidManifest += validateManifestEntry(entry);
}

let missing = 0;
for (const rel of expected) {
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) {
        console.error(`MISSING: ${rel}`);
        missing++;
    }
}

const found = new Set();
function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === '_placeholder') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.png')) found.add(relative(spritesRoot, p));
    }
}
walk(spritesRoot);

let orphans = 0;
let allowlistedOrphans = 0;
for (const f of found) {
    if (!expected.has(f)) {
        if (orphanAllowlist.has(f)) {
            console.warn(`ORPHAN ALLOWLISTED: ${f}`);
            allowlistedOrphans++;
        } else {
            console.error(`ORPHAN: ${f}`);
            orphans++;
        }
    }
}

const { duplicatePngs, allowlistedDuplicatePngGroups } = validateDuplicatePngs(found);

let invalidCharacters = 0;
for (const entry of characterEntries) {
    invalidCharacters += validateCharacterSheet(entry);
}

let invalidEquipment = 0;
for (const entry of equipmentEntries) {
    invalidEquipment += validateEquipmentPng(entry);
}

let invalidAtmosphere = 0;
for (const entry of manifest.atmosphere || []) {
    invalidAtmosphere += validateAtmospherePng(entry);
}

const invalidPalettes = validatePaletteParity();
const materialValidation = validateMaterialContract(manifest);
const invalidMaterialAssets = materialValidation.errors;

// Warnings (non-fatal): dimension drift, block-cube heuristic, dead inventory.
// These catch the defect classes that shipped silently before (cube layers,
// 64px PNG under a 32px manifest size, manifest ids nothing references).
let warnings = 0;
warnings += warnOnDimensionDrift();
warnings += warnOnBlockCubes();
warnings += warnOnUnreferencedIds();

console.log(`expected: ${expected.size}  missing: ${missing}  orphan PNGs: ${orphans}  allowlisted orphan PNGs: ${allowlistedOrphans}  duplicate PNG groups: ${duplicatePngs}  allowlisted duplicate PNG groups: ${allowlistedDuplicatePngGroups}  invalid manifest entries: ${invalidManifest}  invalid palette mirrors: ${invalidPalettes}  invalid character sheets: ${invalidCharacters}  invalid equipment PNGs: ${invalidEquipment}  invalid atmosphere PNGs: ${invalidAtmosphere}  invalid material/atlas assets: ${invalidMaterialAssets}  warnings: ${warnings + materialValidation.warnings}`);
process.exit(missing > 0 || orphans > 0 || duplicatePngs > 0 || invalidManifest > 0 || invalidPalettes > 0 || invalidCharacters > 0 || invalidEquipment > 0 || invalidAtmosphere > 0 || invalidMaterialAssets > 0 ? 1 : 0);

function duplicateGroupKey(paths) {
    return [...paths].sort().join('|');
}

function validateDuplicatePngs(files) {
    const groups = new Map();
    let errors = 0;
    for (const rel of files) {
        if (!expected.has(rel)) continue;
        // Companion channels are semantic data, not albedo art. Empty
        // emissive masks and flat occluders are intentionally byte-identical;
        // validate them through the material contract instead of the art-copy
        // detector below.
        if (expectedMaterialPngPaths.has(rel)) continue;
        const abs = join(spritesRoot, rel);
        try {
            const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
            const paths = groups.get(hash) || [];
            paths.push(rel);
            groups.set(hash, paths);
        } catch (err) {
            console.error(`INVALID PNG: ${rel} cannot be hashed (${err.message})`);
            errors++;
        }
    }

    let duplicates = errors;
    let allowlisted = 0;
    for (const [hash, paths] of groups) {
        if (paths.length < 2) continue;
        const key = duplicateGroupKey(paths);
        if (duplicatePngAllowlist.has(key)) {
            console.warn(`DUPLICATE PNG ALLOWLISTED: ${paths.join(', ')}`);
            allowlisted++;
            continue;
        }
        console.error(`DUPLICATE PNG: ${paths.join(', ')} share ${hash}`);
        duplicates++;
    }

    return { duplicatePngs: duplicates, allowlistedDuplicatePngGroups: allowlisted };
}

function validateManifestEntry(entry) {
    if (!entry?.id) return 0;

    let errors = 0;
    if (entry.id.startsWith('agent.')) {
        if (!Number.isInteger(entry.generationSize)
            || entry.generationSize < 32
            || entry.generationSize > 128) {
            console.error(`INVALID MANIFEST: ${entry.id} generationSize must be an integer from 32 through 128`);
            errors++;
        }

        const mode = entry.generationMode === undefined ? 'standard' : String(entry.generationMode);
        if (!CHARACTER_GENERATION_MODES.has(mode)) {
            console.error(`INVALID MANIFEST: ${entry.id} has unsupported generationMode "${entry.generationMode}"`);
            errors++;
        }
        errors += validateCharacterLedger(entry);
        errors += validateActionStrip(entry);
    }

    if (REQUIRED_PRO_CHARACTER_IDS.has(entry.id) && entry.generationMode !== 'pro') {
        console.error(`INVALID MANIFEST: ${entry.id} must set generationMode: pro for Codex equipment coherence bakes`);
        errors++;
    }

    if (entry.id.startsWith('building.')) {
        errors += validateBuildingManifestEntry(entry);
    }

    return errors;
}

function validateCharacterLedger(entry) {
    let errors = 0;
    const invalid = (message) => {
        console.error(`INVALID MANIFEST: ${entry.id} ${message}`);
        errors++;
    };
    const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (entry.animationGroups !== undefined) {
        if (!record(entry.animationGroups)) invalid('animationGroups must be a named mapping');
        else {
            const occupied = new Set();
            for (const [name, group] of Object.entries(entry.animationGroups)) {
                const rows = group?.rows;
                if (!name.trim() || !record(group) || !Array.isArray(rows) || rows.length !== 2
                    || !rows.every(Number.isInteger) || rows[0] < 0 || rows[1] < rows[0] || rows[1] >= CHARACTER_ROWS) {
                    invalid(`animationGroups.${name} rows must be an inclusive range inside 0–${CHARACTER_ROWS - 1}`);
                    continue;
                }
                for (let row = rows[0]; row <= rows[1]; row++) {
                    if (occupied.has(row)) invalid(`animationGroups.${name} overlaps row ${row}`);
                    occupied.add(row);
                }
            }
        }
    }
    if (entry.provenance !== undefined) {
        if (!record(entry.provenance)) invalid('provenance must be a mapping');
        else {
            for (const key of ['characterId', 'animationGroupId']) {
                if (entry.provenance[key] !== undefined
                    && (typeof entry.provenance[key] !== 'string' || !entry.provenance[key].trim())) {
                    invalid(`provenance.${key} must be a non-empty string`);
                }
            }
            const size = entry.provenance.generationSize;
            if (size !== undefined && (!Number.isInteger(size) || size < 32 || size > 128)) {
                invalid('provenance.generationSize must be an integer from 32 through 128 (including 76 and 92)');
            }
            const mode = entry.provenance.generationMode;
            if (mode !== undefined && !CHARACTER_GENERATION_MODES.has(mode)) invalid('provenance.generationMode must be standard or pro');
        }
    }
    // Optional head-and-shoulders crop, in cell-local pixels of the composed
    // south idle frame, consumed by the Dashboard/panel avatar surfaces.
    if (entry.portraitCrop !== undefined) {
        const crop = entry.portraitCrop;
        if (!record(crop)) invalid('portraitCrop must be a mapping of x, y, w, h');
        else {
            const cell = Number(entry.size) || CHARACTER_CELL;
            const values = ['x', 'y', 'w', 'h'].map((key) => crop[key]);
            if (!values.every(Number.isInteger) || values.some((value) => value < 0)) {
                invalid('portraitCrop x, y, w, h must be non-negative integers');
            } else if (crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > cell || crop.y + crop.h > cell) {
                invalid(`portraitCrop must be a positive rectangle inside the ${cell}px cell`);
            }
        }
    }
    return errors;
}

// C2: the strip is optional, but a declared strip must be servable — 8 direction
// columns of the engine cell, named groups inside the PNG's real row count, and
// a hold row inside its own group.
function validateActionStrip(entry) {
    if (entry.actionStrip === undefined) return 0;
    let errors = 0;
    const invalid = (message) => {
        console.error(`INVALID MANIFEST: ${entry.id} actionStrip ${message}`);
        errors++;
    };
    const strip = entry.actionStrip;
    if (strip === null || typeof strip !== 'object' || Array.isArray(strip)) {
        invalid('must be a mapping');
        return errors;
    }
    const expectedPath = `characters/${entry.id}/actions.png`;
    if (strip.path !== expectedPath) invalid(`path must be ${expectedPath}`);
    if (strip.cell !== CHARACTER_CELL) invalid(`cell must be ${CHARACTER_CELL}`);
    if (strip.grip !== undefined) {
        if (!['right', 'left', 'both'].includes(strip.grip?.hand)) invalid('grip.hand must be right, left or both');
        if (typeof strip.grip?.sheathe !== 'boolean') invalid('grip.sheathe must be a boolean');
    }
    if (strip.provenance !== undefined) {
        const { characterId, animationGroupId, generationSize } = strip.provenance || {};
        if (typeof characterId !== 'string' || !characterId.trim()) invalid('provenance.characterId must be a non-empty string');
        if (animationGroupId !== undefined && (typeof animationGroupId !== 'string' || !animationGroupId.trim())) {
            invalid('provenance.animationGroupId must be a non-empty string');
        }
        // v3 animates at the source rig's export canvas, which can exceed the
        // 128px character request range and is capped at 256px.
        if (!Number.isInteger(generationSize) || generationSize < 16 || generationSize > 256) {
            invalid('provenance.generationSize must be an integer from 16 through 256');
        }
    }

    const abs = join(spritesRoot, expectedPath);
    let png = null;
    if (existsSync(abs)) {
        try {
            png = PNG.sync.read(readFileSync(abs));
        } catch (err) {
            invalid(`PNG cannot be decoded (${err.message})`);
        }
    }
    const cell = Number.isInteger(strip.cell) && strip.cell > 0 ? strip.cell : CHARACTER_CELL;
    if (png) {
        if (png.width !== CHARACTER_DIRECTIONS * cell) {
            invalid(`PNG is ${png.width}px wide, expected ${CHARACTER_DIRECTIONS * cell}`);
        }
        if (png.height < cell || png.height % cell !== 0) {
            invalid(`PNG height ${png.height} is not whole ${cell}px rows`);
        }
    }
    const rows = png && png.height % cell === 0 ? png.height / cell : null;
    const groups = strip.groups;
    if (groups === null || typeof groups !== 'object' || Array.isArray(groups) || !Object.keys(groups).length) {
        invalid('groups must be a non-empty named mapping');
        return errors;
    }
    const occupied = new Set();
    for (const [name, group] of Object.entries(groups)) {
        const range = group?.rows;
        if (!name.trim() || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)
            || range[0] < 0 || range[1] < range[0] || (rows !== null && range[1] >= rows)) {
            invalid(`groups.${name} rows must be an inclusive range inside the strip's ${rows ?? 'declared'} rows`);
            continue;
        }
        for (let row = range[0]; row <= range[1]; row++) {
            if (occupied.has(row)) invalid(`groups.${name} overlaps row ${row}`);
            occupied.add(row);
        }
        const hold = group.hold;
        if (hold !== undefined && (!Number.isInteger(hold) || hold < range[0] || hold > range[1])) {
            invalid(`groups.${name} hold must be a row inside ${range.join('–')}`);
        }
    }
    return errors;
}

function validateBuildingManifestEntry(entry) {
    let errors = 0;
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        console.error(`INVALID BUILDING: ${entry.id} must declare positive integer width and height`);
        return 1;
    }
    if (!Array.isArray(entry.anchor) || entry.anchor.length !== 2) {
        console.error(`INVALID BUILDING: ${entry.id} must declare anchor: [x, y]`);
        errors++;
    } else {
        const [x, y] = entry.anchor.map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) {
            console.error(`INVALID BUILDING: ${entry.id} anchor [${entry.anchor.join(', ')}] is outside ${width}x${height}`);
            errors++;
        }
    }
    if (entry.splitForOcclusion) {
        const horizon = Number(entry.horizonY);
        if (!Number.isFinite(horizon) || horizon <= 0 || horizon >= height) {
            console.error(`INVALID BUILDING: ${entry.id} splitForOcclusion requires horizonY inside 1..${height - 1}`);
            errors++;
        }
    }

    const png = readPngQuietly(pathForEntry(entry));
    if (png && (png.width !== width || png.height !== height)) {
        console.error(`INVALID BUILDING: ${entry.id} PNG is ${png.width}x${png.height}, manifest declares ${width}x${height}`);
        errors++;
    }
    errors += validateStructureMask(entry, width, height);
    return errors;
}

function validateStructureMask(entry, width, height) {
    const mask = entry.structureMask;
    if (mask == null) return 0;
    const shapes = mask.shapes;
    if (!Array.isArray(shapes) || shapes.length === 0) {
        console.error(`INVALID BUILDING: ${entry.id} structureMask must declare at least one shape`);
        return 1;
    }
    let errors = 0;
    const inBounds = (x, y) => Number.isFinite(x) && Number.isFinite(y)
        && x >= 0 && y >= 0 && x <= width && y <= height;
    for (const [index, shape] of shapes.entries()) {
        if (Array.isArray(shape?.rect) && shape.rect.length === 4) {
            const [x, y, w, h] = shape.rect.map(Number);
            if (!inBounds(x, y) || !Number.isFinite(w) || !Number.isFinite(h)
                || w <= 0 || h <= 0 || x + w > width || y + h > height) {
                console.error(`INVALID BUILDING: ${entry.id} structureMask.shapes[${index}].rect is outside ${width}x${height}`);
                errors++;
            }
            continue;
        }
        if (Array.isArray(shape?.polygon) && shape.polygon.length >= 3) {
            if (shape.polygon.some((point) => !Array.isArray(point) || point.length !== 2
                || !inBounds(Number(point[0]), Number(point[1])))) {
                console.error(`INVALID BUILDING: ${entry.id} structureMask.shapes[${index}].polygon is outside ${width}x${height}`);
                errors++;
            }
            continue;
        }
        console.error(`INVALID BUILDING: ${entry.id} structureMask.shapes[${index}] must declare rect or polygon geometry`);
        errors++;
    }
    if (mask.siteColorCutout != null) {
        const family = mask.siteColorCutout.family;
        const fromY = Number(mask.siteColorCutout.fromY);
        const validFamily = family === 'grass' || family === 'grass-and-retaining';
        const lipFromY = Number(mask.siteColorCutout.lipFromY);
        const invalidLip = family === 'grass-and-retaining'
            && (!Number.isFinite(lipFromY) || lipFromY < fromY || lipFromY >= height);
        const eraseFromY = Number(mask.siteColorCutout.eraseOutsideProtectFromY);
        const hasErase = mask.siteColorCutout.eraseOutsideProtectFromY != null;
        const protectShapes = mask.siteColorCutout.protectShapes;
        const invalidProtect = hasErase && (
            !Number.isFinite(eraseFromY)
            || eraseFromY < fromY
            || eraseFromY >= height
            || !Array.isArray(protectShapes)
            || protectShapes.length === 0
        );
        if (!validFamily || !Number.isFinite(fromY) || fromY < 0 || fromY >= height || invalidLip || invalidProtect) {
            console.error(`INVALID BUILDING: ${entry.id} has invalid structureMask.siteColorCutout`);
            errors++;
        }
    }
    return errors;
}

function validatePaletteParity() {
    if (!deepEqualCanonical(manifest.palettes || {}, palettes || {})) {
        console.error(`INVALID PALETTES: palettes.yaml must exactly mirror the palettes block in manifest.yaml`);
        return 1;
    }
    return 0;
}

function deepEqualCanonical(left, right) {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key])])
    );
}

function validateCharacterSheet(entry) {
    const rel = pathForEntry(entry);
    if (!rel) return 0;
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return 0;

    const cell = Number(entry.size) || CHARACTER_CELL;
    const expectedWidth = CHARACTER_DIRECTIONS * cell;
    const expectedHeight = (CHARACTER_WALK_FRAMES + CHARACTER_IDLE_FRAMES) * cell;
    let png;
    try {
        png = PNG.sync.read(readFileSync(abs));
    } catch (err) {
        console.error(`INVALID CHARACTER: ${rel} cannot be decoded (${err.message})`);
        return 1;
    }

    let errors = 0;
    if (png.width !== expectedWidth || png.height !== expectedHeight) {
        console.error(`INVALID CHARACTER: ${rel} is ${png.width}x${png.height}, expected ${expectedWidth}x${expectedHeight}`);
        errors++;
    }

    if (cell !== CHARACTER_CELL) {
        console.error(`INVALID CHARACTER: ${entry.id} uses ${cell}px cells, expected canonical ${CHARACTER_CELL}px cells`);
        errors++;
    }

    if (!hasRealWalkMotion(png, cell)) {
        console.error(`INVALID CHARACTER: ${rel} walk frames look like a bobbed duplicate pose; regenerate real gait frames`);
        errors++;
    }
    errors += validateRequiredEquipment(entry, png, cell, rel);
    return errors;
}

function validateEquipmentPng(entry) {
    const rel = pathForEntry(entry);
    if (!rel) return 0;
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return 0;

    const expected = expectedEquipmentDimensions(entry);
    let png;
    try {
        png = PNG.sync.read(readFileSync(abs));
    } catch (err) {
        console.error(`INVALID EQUIPMENT: ${rel} cannot be decoded (${err.message})`);
        return 1;
    }

    let errors = 0;
    if (expected && (png.width !== expected.width || png.height !== expected.height)) {
        console.error(`INVALID EQUIPMENT: ${rel} is ${png.width}x${png.height}, expected ${expected.width}x${expected.height}`);
        errors++;
    }

    const anchor = entry.anchor;
    if (!Array.isArray(anchor) || anchor.length < 2) {
        console.error(`INVALID EQUIPMENT: ${entry.id} must define anchor: [x, y] for the grip point`);
        errors++;
    } else {
        const [x, y] = anchor.map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= png.width || y >= png.height) {
            console.error(`INVALID EQUIPMENT: ${entry.id} anchor [${anchor.join(', ')}] is outside ${png.width}x${png.height}`);
            errors++;
        }
    }

    return errors;
}

function expectedEquipmentDimensions(entry) {
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
        return { width, height };
    }

    const size = Number(entry.size);
    if (!Number.isFinite(size)) return null;
    return { width: size, height: size };
}

function validateAtmospherePng(entry) {
    const rel = pathForEntry(entry);
    if (!rel) return 0;
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return 0;

    const expected = expectedAtmosphereDimensions(entry);
    if (!expected) return 0;

    let png;
    try {
        png = PNG.sync.read(readFileSync(abs));
    } catch (err) {
        console.error(`INVALID ATMOSPHERE: ${rel} cannot be decoded (${err.message})`);
        return 1;
    }

    if (png.width === expected.width && png.height === expected.height) return 0;
    console.error(`INVALID ATMOSPHERE: ${rel} is ${png.width}x${png.height}, expected ${expected.width}x${expected.height}`);
    return 1;
}

function expectedAtmosphereDimensions(entry) {
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
        return { width, height };
    }

    const size = Number(entry.size);
    if (!Number.isFinite(size)) return null;
    if (entry.tool === 'tileset') {
        return { width: size * 2, height: size * 2 };
    }
    return { width: size, height: size };
}

// ─── Warnings (non-fatal) ────────────────────────────────────────────────────

function declaredDimensions(entry) {
    const width = Number(entry?.width);
    const height = Number(entry?.height);
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
    const size = Number(entry?.size);
    if (Number.isFinite(size)) return { width: size, height: size };
    return null;
}

function readPngQuietly(rel) {
    const abs = join(spritesRoot, rel);
    if (!existsSync(abs)) return null;
    try {
        return PNG.sync.read(readFileSync(abs));
    } catch {
        return null;
    }
}

// PNG dimensions vs the manifest `size`/`width`/`height` declaration. Groups
// with their own hard checks (characters, equipment, atmosphere, terrain,
// building bases) are skipped here.
function warnOnDimensionDrift() {
    let warnings = 0;
    const check = (entry, rel, label) => {
        const dims = declaredDimensions(entry);
        if (!dims || !rel) return;
        const png = readPngQuietly(rel);
        if (!png) return;
        if (png.width !== dims.width || png.height !== dims.height) {
            console.warn(`WARN DIMENSION: ${label} ${rel} is ${png.width}x${png.height}, manifest declares ${dims.width}x${dims.height}`);
            warnings++;
        }
    };
    for (const group of DIMENSION_CHECK_GROUPS) {
        for (const entry of manifest[group] || []) {
            check(entry, pathForEntry(entry), entry.id);
        }
    }
    for (const building of manifest.buildings || []) {
        for (const [name, layer] of Object.entries(building.layers || {})) {
            if (name === 'base') continue;
            check(layer, `buildings/${building.id}/${name}.png`, `${building.id}.${name}`);
        }
    }
    return warnings;
}

// Corner-alpha + fill-ratio "is it a cube?" heuristic. Isolated-object sprites
// must have transparent corners and an airy silhouette; a baked block cube
// packs ~77%+ of the canvas opaque (the four shipped defects measured
// 0.77-0.78; healthy sprites sit ≤0.63). Bridges are excluded: per-tile plank
// assets legitimately fill their tile.
function warnOnBlockCubes() {
    let warnings = 0;
    const check = (rel, label) => {
        if (!rel || CUBE_FILL_ALLOWLIST.has(label)) return;
        const png = readPngQuietly(rel);
        if (!png) return;
        const stats = alphaCoverage(png);
        if (stats.opaqueCorners >= CUBE_OPAQUE_CORNERS_WARN) {
            console.warn(`WARN CUBE?: ${label} ${rel} has ${stats.opaqueCorners} opaque corners — baked background?`);
            warnings++;
        }
        if (stats.fillRatio >= CUBE_FILL_RATIO_WARN) {
            console.warn(`WARN CUBE?: ${label} ${rel} fills ${(stats.fillRatio * 100).toFixed(0)}% of its canvas — reads as a solid block; verify it is not a baked cube`);
            warnings++;
        }
    };
    for (const group of CUBE_CHECK_GROUPS) {
        for (const entry of manifest[group] || []) {
            check(pathForEntry(entry), entry.id);
        }
    }
    for (const building of manifest.buildings || []) {
        for (const [name, layer] of Object.entries(building.layers || {})) {
            if (name === 'base') continue;
            check(`buildings/${building.id}/${name}.png`, `${building.id}.${name}`);
        }
    }
    return warnings;
}

function alphaCoverage(png) {
    let opaque = 0;
    for (let i = 0; i < png.width * png.height; i++) {
        if (png.data[i * 4 + 3] > ALPHA_THRESHOLD) opaque++;
    }
    const corners = [
        [0, 0],
        [png.width - 1, 0],
        [0, png.height - 1],
        [png.width - 1, png.height - 1],
    ].filter(([x, y]) => png.data[(png.width * y + x) * 4 + 3] > ALPHA_THRESHOLD).length;
    return { fillRatio: opaque / (png.width * png.height), opaqueCorners: corners };
}

// Dead-inventory warning: manifest ids in the prop/veg/bridge/atmosphere
// families that no code path can draw. Literal fixed-string matches first,
// then the known runtime id builders (`veg.tree.${species}.${size}`,
// `bridge.${orientation}`, `dock.${orientation}`, `bridge.landmark.${...}`,
// `prop.${type}` from scenery config).
function warnOnUnreferencedIds() {
    const source = collectSourceText();
    const internalRefs = manifestInternalReferences();
    let warnings = 0;
    for (const group of REFERENCE_CHECK_GROUPS) {
        for (const entry of manifest[group] || []) {
            const id = entry?.id;
            if (!id || UNREFERENCED_ALLOWLIST.has(id)) continue;
            if (internalRefs.has(id) || isReferenced(id, source)) continue;
            console.warn(`WARN UNREFERENCED: ${id} has no code reference (dead inventory — wire it or attic it)`);
            warnings++;
        }
    }
    return warnings;
}

// Ids another manifest entry points at (e.g. building `lightOverlay` values are
// consumed generically by BuildingSprite, so they never appear in source).
function manifestInternalReferences() {
    const refs = new Set();
    for (const entry of collectSpriteEntries(manifest)) {
        if (typeof entry?.lightOverlay === 'string') refs.add(entry.lightOverlay);
    }
    return refs;
}

function isReferenced(id, source) {
    if (source.includes(`'${id}'`) || source.includes(`"${id}"`) || source.includes(`\`${id}\``)) return true;
    if (/^veg\.tree\.[^.]+\.[^.]+$/.test(id) && source.includes('veg.tree.${')) return true;
    if (/^veg\.boulder\.[^.]+\.[^.]+$/.test(id) && source.includes('veg.boulder.${')) return true;
    if (/^bridge\.(ew|ns)$/.test(id) && source.includes('bridge.${')) return true;
    if (/^dock\.(ew|ns)$/.test(id) && source.includes('dock.${')) return true;
    if (/^bridge\.landmark\.[^.]+\.[^.]+$/.test(id) && source.includes('bridge.landmark.${')) return true;
    if (id.startsWith('prop.') && source.includes('prop.${')) {
        const suffix = id.slice('prop.'.length);
        if (!suffix.includes('.') && (source.includes(`'${suffix}'`) || source.includes(`"${suffix}"`))) return true;
    }
    return false;
}

function collectSourceText() {
    const parts = [];
    for (const root of ['claudeville/src', 'claudeville/config']) {
        const abs = join(repoRoot, root);
        if (!existsSync(abs)) continue;
        for (const file of walkJs(abs)) {
            try {
                parts.push(readFileSync(file, 'utf8'));
            } catch { /* unreadable files do not produce references */ }
        }
    }
    return parts.join('\n');
}

function walkJs(dir, files = []) {
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walkJs(abs, files);
        else if (name.endsWith('.js')) files.push(abs);
    }
    return files;
}

function validateRequiredEquipment(entry, png, cell, rel) {
    const required = requiredEquipmentList(entry);
    if (!required.length) return 0;

    let errors = 0;
    for (const equipment of required) {
        const minPixels = equipment.minPixels ?? REQUIRED_EQUIPMENT_MIN_PIXELS[equipment.kind];
        if (!Number.isFinite(minPixels)) {
            console.error(`INVALID CHARACTER: ${entry.id} has unsupported required_equipment "${equipment.kind}"`);
            errors++;
            continue;
        }

        const missing = [];
        for (let row = 0; row < CHARACTER_ROWS; row++) {
            for (let direction = 0; direction < CHARACTER_DIRECTIONS; direction++) {
                const count = equipmentPixelCount(png, direction, row, cell, equipment.kind);
                if (count < minPixels) missing.push(`${animationRowLabel(row)}:${CHARACTER_DIRECTION_KEYS[direction]}`);
            }
        }
        if (missing.length) {
            const sample = missing.slice(0, 16).join(', ');
            const suffix = missing.length > 16 ? `, ... +${missing.length - 16} more` : '';
            console.error(`INVALID CHARACTER: ${rel} required_equipment "${equipment.kind}" is missing or too faint in ${sample}${suffix}`);
            errors++;
        }
    }
    return errors;
}

function requiredEquipmentList(entry) {
    const raw = entry.required_equipment ?? entry.requiredEquipment;
    if (!raw) return [];

    const values = Array.isArray(raw) ? raw : [raw];
    const result = [];
    for (const value of values) {
        if (typeof value === 'string') {
            result.push({ kind: normalizeEquipmentKind(value) });
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        const kind = normalizeEquipmentKind(value.kind || value.type || value.name);
        if (!kind) continue;
        const minPixels = Number(value.min_pixels ?? value.minPixels);
        result.push({
            kind,
            minPixels: Number.isFinite(minPixels) && minPixels > 0 ? minPixels : undefined,
        });
    }
    return result;
}

function normalizeEquipmentKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase().replace(/[-_\s]+/g, '');
    const aliases = {
        dagger: 'dagger',
        multitool: 'multitool',
        sword: 'sword',
        greatsword: 'greatsword',
        wrench: 'wrench',
        polearm: 'polearm',
        shield: 'shield',
        swordshield: 'swordShield',
    };
    return aliases[normalized] || normalized;
}

function equipmentPixelCount(png, direction, row, cell, kind) {
    const x0 = direction * cell;
    const y0 = row * cell;
    const bbox = alphaBounds(png, x0, y0, cell);
    if (!bbox) return 0;

    const contentWidth = bbox.maxX - bbox.minX + 1;
    const contentHeight = bbox.maxY - bbox.minY + 1;
    const centerX = (bbox.minX + bbox.maxX) / 2;
    const coreHalfWidth = Math.max(10, contentWidth * 0.23);
    const coreTop = bbox.minY + contentHeight * 0.18;
    const coreBottom = bbox.minY + contentHeight * 0.88;

    let count = 0;
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
        for (let x = bbox.minX; x <= bbox.maxX; x++) {
            const absoluteX = x0 + x;
            const absoluteY = y0 + y;
            const p = (png.width * absoluteY + absoluteX) * 4;
            const a = png.data[p + 3];
            if (a <= ALPHA_THRESHOLD) continue;

            const inBodyCore = Math.abs(x - centerX) <= coreHalfWidth && y >= coreTop && y <= coreBottom;
            if (inBodyCore && kind !== 'shield' && kind !== 'swordShield') continue;

            const r = png.data[p];
            const g = png.data[p + 1];
            const b = png.data[p + 2];
            if (isEquipmentPixel(kind, r, g, b, a)) count++;
        }
    }
    return count;
}

function isEquipmentPixel(kind, r, g, b, a) {
    if (a <= ALPHA_THRESHOLD) return false;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const brightSteel = r > 172 && g > 172 && b > 156 && spread < 96;
    const coolSteel = r > 92 && g > 112 && b > 128 && b >= r && spread < 110;
    const cyanRune = r < 135 && g > 135 && b > 145 && Math.abs(g - b) < 72;
    const goldFitting = r > 158 && g > 98 && g < 205 && b < 112;
    const darkShaft = r > 36 && r < 132 && g > 24 && g < 112 && b < 96;
    const shieldFace = r > 70 && g > 82 && b > 86 && spread < 88;

    if (kind === 'dagger' || kind === 'multitool' || kind === 'sword' || kind === 'greatsword') {
        return brightSteel || coolSteel || cyanRune || goldFitting;
    }
    if (kind === 'wrench') {
        return coolSteel || cyanRune || goldFitting || darkShaft;
    }
    if (kind === 'polearm') {
        return brightSteel || coolSteel || cyanRune || goldFitting || darkShaft;
    }
    if (kind === 'shield') {
        return shieldFace || goldFitting || cyanRune;
    }
    if (kind === 'swordShield') {
        return brightSteel || coolSteel || cyanRune || goldFitting || shieldFace;
    }
    return false;
}

function animationRowLabel(row) {
    return row < CHARACTER_WALK_FRAMES
        ? `walk${row}`
        : `idle${row - CHARACTER_WALK_FRAMES}`;
}

function hasRealWalkMotion(png, cell) {
    if (png.width < CHARACTER_DIRECTIONS * cell || png.height < CHARACTER_WALK_FRAMES * cell) return false;

    let strongestDelta = 0;
    for (let direction = 0; direction < CHARACTER_DIRECTIONS; direction++) {
        const baseline = normalizedLowerBodyMask(png, direction, 0, cell);
        if (!baseline) continue;
        for (let frame = 1; frame < CHARACTER_WALK_FRAMES; frame++) {
            const candidate = normalizedLowerBodyMask(png, direction, frame, cell);
            if (!candidate) continue;
            strongestDelta = Math.max(strongestDelta, symmetricDeltaSize(baseline, candidate));
            if (strongestDelta >= MIN_NORMALIZED_WALK_DELTA) return true;
        }
    }
    return false;
}

function normalizedLowerBodyMask(png, direction, frame, cell) {
    const x0 = direction * cell;
    const y0 = frame * cell;
    const bbox = alphaBounds(png, x0, y0, cell);
    if (!bbox) return null;

    const lowerStart = bbox.minY + Math.floor((bbox.maxY - bbox.minY) * 0.56);
    const points = new Set();
    for (let y = lowerStart; y <= bbox.maxY; y++) {
        for (let x = bbox.minX; x <= bbox.maxX; x++) {
            if (alphaAt(png, x0 + x, y0 + y) <= ALPHA_THRESHOLD) continue;
            points.add(`${x - bbox.minX},${y - bbox.minY}`);
        }
    }
    return points;
}

function alphaBounds(png, x0, y0, cell) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
            if (alphaAt(png, x0 + x, y0 + y) <= ALPHA_THRESHOLD) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }

    if (maxX < 0 || maxY < 0) return null;
    return { minX, minY, maxX, maxY };
}

function alphaAt(png, x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
    return png.data[(png.width * y + x) * 4 + 3];
}

function symmetricDeltaSize(a, b) {
    let delta = 0;
    for (const point of a) {
        if (!b.has(point)) delta++;
    }
    for (const point of b) {
        if (!a.has(point)) delta++;
    }
    return delta;
}
