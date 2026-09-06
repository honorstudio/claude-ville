import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const spritesRoot = join(repoRoot, 'claudeville', 'assets', 'sprites');
export const manifestPath = join(spritesRoot, 'manifest.yaml');
export const palettesPath = join(spritesRoot, 'palettes.yaml');

export const SPRITE_GROUP_KEYS = Object.freeze([
    'characters',
    'equipment',
    'accessories',
    'statusOverlays',
    'buildings',
    'props',
    'vegetation',
    'terrain',
    'bridges',
    'atmosphere',
    'luts',
]);

export function loadSpriteManifest(path = manifestPath) {
    return yaml.load(readFileSync(path, 'utf8'));
}

// Replace the named keys of one character entry inside the manifest *text*, so
// every other line, comment and quoting style survives. `renderedLines` are the
// already-indented replacement lines; they land after the entry's
// `animationGroups` ledger line when it exists, otherwise under `- id:`.
// Returns null when the entry is absent (scratch/unmanifested assets).
export function rewriteEntryKeys(source, spriteId, keys, renderedLines) {
    const lines = source.split('\n');
    const start = lines.findIndex((line) => line === `  - id: ${spriteId}`);
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !/^  - id:|^[^\s#]/.test(lines[end])) end++;
    const block = lines.slice(start, end);
    for (const key of keys) {
        const index = block.findIndex((line) => line.startsWith(`    ${key}:`));
        if (index < 0) continue;
        let stop = index + 1;
        while (stop < block.length && /^      \S|^        /.test(block[stop])) stop++;
        block.splice(index, stop - index);
    }
    const ledger = block.findIndex((line) => line.startsWith('    animationGroups:'));
    block.splice(ledger < 0 ? 1 : ledger + 1, 0, ...renderedLines);
    lines.splice(start, end - start, ...block);
    return lines.join('\n');
}

export function collectSpriteEntries(manifest, groups = SPRITE_GROUP_KEYS) {
    const entries = [];
    for (const group of groups) {
        const groupEntries = manifest?.[group];
        if (!Array.isArray(groupEntries)) continue;
        entries.push(...groupEntries);
    }
    return entries;
}

export function layerNamesForEntry(entry) {
    if (!entry?.layers) return [];
    if (Array.isArray(entry.layers)) return entry.layers;
    return Object.keys(entry.layers);
}

export function pathForEntry(entryOrId) {
    const entry = typeof entryOrId === 'string' ? { id: entryOrId } : entryOrId;
    const id = entry?.id || '';
    if (entry?.assetPath) return String(entry.assetPath).replace(/^assets\/sprites\//, '');
    if (id.startsWith('agent.')) return `characters/${id}/sheet.png`;
    if (id.startsWith('equipment.')) return `equipment/${id}.png`;
    if (id.startsWith('overlay.')) return `overlays/${id}.png`;
    if (id.startsWith('building.')) return `buildings/${id}/base.png`;
    if (id.startsWith('prop.')) return `props/${id}.png`;
    if (id.startsWith('veg.')) return `vegetation/${id}.png`;
    if (id.startsWith('terrain.')) return `terrain/${id}/sheet.png`;
    if (id.startsWith('bridge.') || id.startsWith('dock.')) return `bridges/${id}.png`;
    if (id.startsWith('atmosphere.')) return `atmosphere/${id}.png`;
    // Hand-authored data images: `lut.light-ramp.command` → `luts/light-ramp.command.png`.
    if (id.startsWith('lut.')) return `luts/${id.slice('lut.'.length)}.png`;
    return null;
}

// C2 action strip: sprites-root relative albedo plus the companion channels the
// entry's existing sidecar declarations imply for it.
export function actionStripPathsForEntry(entry) {
    const declared = typeof entry?.actionStrip?.path === 'string' ? entry.actionStrip.path.trim() : '';
    if (!declared) return [];
    const albedo = declared.replace(/^\/+/, '').replace(/^assets\/sprites\//, '');
    const paths = [albedo];
    for (const channel of ['material', 'emissive', 'occluder']) {
        if (entry[`${channel}Sidecar`] === true) paths.push(albedo.replace(/\.png$/, `.${channel}.png`));
    }
    return paths;
}

export function expectedPathsForEntry(entry) {
    if (!entry) return [];
    const layerNames = layerNamesForEntry(entry);
    if (entry.composeGrid && layerNames.includes('base')) {
        const [cols, rows] = entry.composeGrid;
        const paths = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                paths.push(`buildings/${entry.id}/base-${col}-${row}.png`);
            }
        }
        for (const layer of layerNames.filter((name) => name !== 'base')) {
            paths.push(`buildings/${entry.id}/${layer}.png`);
        }
        return paths;
    }

    const base = pathForEntry(entry);
    const paths = base ? [base] : [];
    for (const layer of layerNames.filter((name) => name !== 'base')) {
        paths.push(`buildings/${entry.id}/${layer}.png`);
    }
    paths.push(...actionStripPathsForEntry(entry));
    return paths;
}

export function inferSpriteTool(id) {
    if (id.startsWith('agent.')) return 'create_character';
    if (id.startsWith('terrain.')) return 'tileset';
    return 'map_object';
}

export function dimensionsForEntry(entry) {
    if (entry.composeGrid) return `composeGrid ${entry.composeGrid.join('x')}`;
    if (entry.width && entry.height) return `${entry.width}x${entry.height}`;
    if (entry.size && entry.id.startsWith('agent.')) {
        return `${entry.size * (entry.n_directions || 8)}x${entry.size * 10} sheet (${entry.size}px cells)`;
    }
    if (entry.size) return `${entry.size}x${entry.size}`;
    return 'manifest default';
}
