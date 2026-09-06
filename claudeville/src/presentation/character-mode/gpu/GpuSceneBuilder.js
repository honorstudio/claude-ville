import { materialClassId } from './GpuWorldPolicy.js';
import { tileToWorld, TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from '../Projection.js';
import {
    atlasSourceRect,
    shouldUseAtlasForCategory,
} from '../AssetManager.js';
import { getBuildingVisual } from '../BuildingVisualRegistry.js';

const PILOT_PROP_IDS = Object.freeze(['prop.lantern', 'prop.runeBrazier']);
const TERRAIN_TILE_SOURCES = Object.freeze([
    Object.freeze({ tiles: 'deepWaterTiles', id: 'terrain.shallow-deep' }),
    Object.freeze({ tiles: 'waterTiles', id: 'terrain.shore-shallow' }),
    Object.freeze({ tiles: 'shoreTiles', id: 'terrain.grass-shore' }),
    Object.freeze({ tiles: 'townSquareTiles', id: 'terrain.cobble-square' }),
    Object.freeze({ tiles: 'mainAvenueTiles', id: 'terrain.grass-cobble' }),
    Object.freeze({ tiles: 'pathTiles', id: 'terrain.grass-dirt' }),
    Object.freeze({ tiles: 'dirtPathTiles', id: 'terrain.grass-dirt' }),
    Object.freeze({ tiles: 'bridgeTiles', id: null, materialClass: 'timber' }),
]);

const MATERIAL_BY_BUILDING = Object.freeze({
    command: 'stone',
    taskboard: 'timber',
    archive: 'stone',
    mine: 'stone',
    forge: 'stone',
    harbor: 'timber',
    watchtower: 'stone',
    observatory: 'stone',
    portal: 'rune',
});

// Provider identity is layered over authored sprite channels. These profiles
// are only deterministic defaults for agent records that do not name a
// material; authored record/atlas values remain authoritative. Unknown
// providers use the material contract's safe albedo-only fallback.
export const DEFAULT_PROVIDER_MATERIAL_CLASS = 'unlit';
export const PROVIDER_MATERIAL_PROFILES = Object.freeze({
    claude: Object.freeze({ defaultMaterialClass: 'fabric' }),
    codex: Object.freeze({ defaultMaterialClass: 'metal' }),
    gemini: Object.freeze({ defaultMaterialClass: 'glass-rune' }),
    git: Object.freeze({ defaultMaterialClass: 'unlit' }),
    grok: Object.freeze({ defaultMaterialClass: 'fabric' }),
    kimi: Object.freeze({ defaultMaterialClass: 'fabric' }),
    omp: Object.freeze({ defaultMaterialClass: 'fabric' }),
    opencode: Object.freeze({ defaultMaterialClass: 'fabric' }),
    deepseek: Object.freeze({ defaultMaterialClass: 'earth' }),
    zai: Object.freeze({ defaultMaterialClass: 'fabric' }),
});

export function gpuMaterialNameForProvider(provider) {
    const key = String(provider || '').trim().toLowerCase();
    return PROVIDER_MATERIAL_PROFILES[key]?.defaultMaterialClass
        || DEFAULT_PROVIDER_MATERIAL_CLASS;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function materialForProp(sprite = {}) {
    const id = String(sprite.id || '').toLowerCase();
    if (/tree|bush|flower|reed|lilypad|hedge|root|mangrove/.test(id)) return 'foliage';
    if (/ship|boat|crate|cart|stall|rack|gate|wall|bridge|dock|sign|board/.test(id)) return 'timber';
    if (/lantern|brazier|beacon|fire/.test(id)) return 'fire';
    if (/ore|metal|crane/.test(id)) return 'metal';
    if (/stone|boulder|monument|well|fountain|shrine|rune/.test(id)) return 'stone';
    return 'earth';
}

function sidecarFor(assets, id, kind = 'material') {
    if (!assets || !id) return null;
    return assets.getSidecar?.(id, kind)
        || assets.getMaterialSidecar?.(id, kind)
        || assets.get?.(`${id}.${kind}`)
        || null;
}

// The material/occluder map has four packed bytes. Authored emissive RGB does
// not fit beside material id, strength, and occluder height, so it remains a
// separate frame-local RGBA channel while the existing packed map stays stable.
export function packGpuSidecarPixels({ material = null, emissive = null, occluder = null, pixelCount = null } = {}) {
    const largestChannel = Math.max(
        Number(material?.length) || 0,
        Number(emissive?.length) || 0,
        Number(occluder?.length) || 0,
    );
    const requestedPixels = Number(pixelCount);
    const pixels = Number.isFinite(requestedPixels)
        ? Math.max(0, Math.floor(requestedPixels))
        : Math.ceil(largestChannel / 4);
    const packed = new Uint8ClampedArray(pixels * 4);
    const authoredEmissive = emissive ? new Uint8ClampedArray(pixels * 4) : null;
    for (let index = 0; index < packed.length; index += 4) {
        packed[index] = material?.[index] || 0;
        packed[index + 1] = emissive?.[index + 3] || 0;
        // The packed map keeps material in R and emissive contribution in G;
        // preserve the authored occluder R/G pair in B/A instead of reducing
        // all four source bytes to one mask value.
        packed[index + 2] = occluder?.[index] || 0;
        packed[index + 3] = occluder?.[index + 1] || 0;
        if (authoredEmissive) {
            authoredEmissive[index] = emissive[index] || 0;
            authoredEmissive[index + 1] = emissive[index + 1] || 0;
            authoredEmissive[index + 2] = emissive[index + 2] || 0;
            authoredEmissive[index + 3] = emissive[index + 3] || 0;
        }
    }
    return { packed, emissive: authoredEmissive };
}

function packedLandmarkChannels(renderer, id, { crop = false } = {}) {
    const assets = renderer?.assets;
    const resolved = assets?.resolveMaterialChannels?.(id, null, {
        crop,
        kind: 'landmark',
        onScreen: true,
    });
    if (resolved?.ready && resolved.origin !== 'fallback') {
        if (crop && resolved.layout === 'atlas-rect') return null;
        return {
            material: resolved.material,
            occluder: resolved.occluder,
            emissive: resolved.emissive,
            revision: resolved.revision,
            origin: resolved.origin,
            layout: resolved.layout,
            frame: resolved.frame,
        };
    }
    const material = sidecarFor(assets, id, 'material');
    const emissive = sidecarFor(assets, id, 'emissive');
    if (!material && !emissive) return null;
    return {
        material,
        emissive,
        occluder: sidecarFor(assets, id, 'occluder'),
        revision: `${assets?.assetVersion || ''}:${id}:sidecars`,
        origin: 'sidecar',
        layout: 'sidecar',
    };
}

// The material/emissive sidecar cache key is scoped to the atlas page, because
// one whole-page channel image is shared by every frame packed into that page.
// Its revision must be scoped identically: a per-record revision makes
// GpuWorldRenderer._textureFor see a mismatch on every batch that binds the
// page, which re-uploads the full 2048x2048 channel image several times per
// frame (~96 MB/frame measured, uploadMs ~50) and pins the GPU quality ladder
// at "disabled:uploadMs".
function atlasChannelRevision(assets, atlasId) {
    return `${assets?.assetVersion || ''}::${atlasId}::channels`;
}

export function terrainSourceHasAuthoredChannels(assets, source) {
    if (!source?.id || !assets) return false;
    if (typeof assets.resolveMaterialChannels === 'function') {
        const resolved = assets.resolveMaterialChannels(source.id);
        return resolved?.origin === 'sidecar' || resolved?.origin === 'atlas';
    }
    return Boolean(
        sidecarFor(assets, source.id, 'material')
        || sidecarFor(assets, source.id, 'emissive')
        || assets.getAtlasFrame?.(source.id),
    );
}

function paintTerrainClassMap(ctx, renderer, cached, scale, sources) {
    const colorFor = (name) => `rgba(${materialClassId(name)},0,0,1)`;
    ctx.fillStyle = colorFor('earth');
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const drawTiles = (tiles, material) => {
        ctx.fillStyle = colorFor(material);
        for (const key of tiles || []) {
            const [tileX, tileY] = String(key).split(',').map(Number);
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const point = tileToWorld(tileX, tileY);
            const cx = (point.x - cached.bounds.x) * scale;
            const cy = (point.y - cached.bounds.y) * scale;
            const halfW = Math.max(1, TILE_HALF_WIDTH * scale + 0.5);
            const halfH = Math.max(1, TILE_HALF_HEIGHT * scale + 0.5);
            ctx.beginPath();
            ctx.moveTo(Math.round(cx), Math.round(cy - halfH));
            ctx.lineTo(Math.round(cx + halfW), Math.round(cy));
            ctx.lineTo(Math.round(cx), Math.round(cy + halfH));
            ctx.lineTo(Math.round(cx - halfW), Math.round(cy));
            ctx.closePath();
            ctx.fill();
        }
    };
    for (const source of sources) {
        const tiles = renderer[source.tiles];
        if (!tiles) continue;
        const materialName = source.materialClass
            || renderer.assets?.getMaterialMetadata?.(source.id)?.materialClass
            || 'earth';
        drawTiles(tiles, materialName);
    }
}

function composeProceduralTerrainMaterial(renderer, cached) {
    const scale = 0.25;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cached.canvas.width * scale));
    canvas.height = Math.max(1, Math.ceil(cached.canvas.height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    paintTerrainClassMap(ctx, renderer, cached, scale, [
        { tiles: 'pathTiles', materialClass: 'cobble' },
        { tiles: 'dirtPathTiles', materialClass: 'earth' },
        { tiles: 'waterTiles', materialClass: 'water' },
        { tiles: 'bridgeTiles', materialClass: 'timber' },
    ]);
    return canvas;
}

function composeAuthoredTerrainMaterial(renderer, cached) {
    const scale = 0.25;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cached.canvas.width * scale));
    canvas.height = Math.max(1, Math.ceil(cached.canvas.height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    paintTerrainClassMap(ctx, renderer, cached, scale, TERRAIN_TILE_SOURCES);
    return canvas;
}

function terrainMaterialSidecar(renderer, cached) {
    if (!cached?.canvas || !cached?.bounds || typeof document === 'undefined') return null;
    const authored = TERRAIN_TILE_SOURCES.some((source) => (
        terrainSourceHasAuthoredChannels(renderer?.assets, source)
    ));
    const cacheToken = renderer.terrainCacheKey || '';
    const authoredRevision = `${cacheToken}:terrain-material:authored`;
    const proceduralRevision = `${cacheToken}:terrain-material:procedural`;
    if (authored && renderer._gpuTerrainAuthoredMaterial?.revision === authoredRevision) {
        renderer._gpuTerrainMaterialOrigin = 'authored';
        return renderer._gpuTerrainAuthoredMaterial.canvas;
    }
    if (authored && renderer.assets?.enqueueDerivedArt) {
        const generation = renderer.assets.derivedArtGeneration;
        renderer.assets.enqueueDerivedArt({
            key: authoredRevision,
            kind: 'landmark',
            onScreen: true,
            build: () => {
                if (generation !== renderer.assets?.derivedArtGeneration) return;
                if (typeof document === 'undefined') return;
                const canvas = composeAuthoredTerrainMaterial(renderer, cached);
                if (generation !== renderer.assets?.derivedArtGeneration) {
                    canvas.width = 0;
                    canvas.height = 0;
                    return;
                }
                renderer._gpuTerrainAuthoredMaterial = { canvas, revision: authoredRevision };
            },
        });
    }
    if (renderer._gpuTerrainMaterialSidecar?.revision === proceduralRevision) {
        renderer._gpuTerrainMaterialOrigin = authored ? 'authored-pending' : 'procedural';
        return renderer._gpuTerrainMaterialSidecar.canvas;
    }
    const canvas = composeProceduralTerrainMaterial(renderer, cached);
    renderer._gpuTerrainMaterialSidecar = { canvas, revision: proceduralRevision };
    renderer._gpuTerrainMaterialOrigin = authored ? 'authored-pending' : 'procedural';
    return canvas;
}

function recordForTerrain(renderer) {
    const cached = renderer?._getTerrainCache?.();
    if (!cached?.canvas || !cached?.bounds) return null;
    const { canvas, bounds } = cached;
    const materialSource = terrainMaterialSidecar(renderer, cached);
    return {
        id: 'terrain:static',
        stableKey: 'terrain:static',
        textureKey: `terrain:${renderer.terrainCacheKey || 'static'}`,
        source: canvas,
        materialSource,
        sidecarKey: 'terrain:material',
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        sx: 0,
        sy: 0,
        sw: canvas.width,
        sh: canvas.height,
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
        material: materialClassId('earth'),
        elevation: 0,
        emissive: 0,
        occluder: 0,
        textureRevision: renderer.terrainCacheKey || null,
        sidecarRevision: renderer._gpuTerrainAuthoredMaterial?.revision
            || renderer._gpuTerrainMaterialSidecar?.revision
            || null,
        sequence: -1,
        sourceKind: 'individual',
    };
}

function recordForHaze(renderer) {
    const field = renderer?._hazeField;
    const strength = finite(renderer?._gpuHazeStrength, 0);
    const viewport = renderer?._screenViewport?.();
    const camera = renderer?.camera;
    const zoom = Math.max(0.0001, finite(camera?.zoom, 1));
    if (!field?.canvas || !(field.width > 0) || !(field.height > 0) || strength <= 0.02) return null;
    if (!(viewport?.width > 0) || !(viewport?.height > 0)) return null;
    return {
        id: 'ground:haze',
        stableKey: 'ground:haze',
        textureKey: 'ground-haze-field',
        source: field.canvas,
        sourceWidth: field.canvas.width,
        sourceHeight: field.canvas.height,
        sx: 0,
        sy: 0,
        sw: field.canvas.width,
        sh: field.canvas.height,
        x: -finite(camera?.x),
        y: -finite(camera?.y),
        width: viewport.width / zoom,
        height: viewport.height / zoom,
        alpha: Math.min(1, strength),
        blend: 'add',
        material: materialClassId('default'),
        elevation: 0,
        emissive: 0,
        occluder: 0,
        textureRevision: field.key || null,
        sequence: -0.9,
        sourceKind: 'individual',
    };
}

let sharedBuildingShadow = null;
const towerBuildingShadows = new Map();

function buildingShadowStamp() {
    if (sharedBuildingShadow || typeof document === 'undefined') return sharedBuildingShadow;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 28;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0f161e';
    const rx = 32;
    const ry = 14;
    for (let y = -ry; y < ry; y += 2) {
        const normalized = y / ry;
        const half = rx * Math.sqrt(Math.max(0, 1 - normalized * normalized));
        ctx.fillRect(
            Math.round(32 - half),
            Math.round(14 + y),
            Math.max(1, Math.round(half * 2)),
            2,
        );
    }
    sharedBuildingShadow = canvas;
    return sharedBuildingShadow;
}

function buildingShadowAngle(lighting = {}) {
    if (Number.isFinite(lighting.shadowAngleRad)) return lighting.shadowAngleRad;
    const sunX = Number(lighting.sunDirIso?.x);
    const sunY = Number(lighting.sunDirIso?.y);
    if (Number.isFinite(sunX) && Number.isFinite(sunY) && Math.hypot(sunX, sunY) > 0) {
        return Math.atan2(-sunY, -sunX);
    }
    return 0.28;
}

function towerBuildingShadow(stamp, buildingId, contact, shadowAngle, shadowLength) {
    const castLength = finite(contact.castLength) * Math.max(0.45, shadowLength);
    const stampCount = Math.max(3, Math.min(4, Math.round(finite(contact.castLength) / 28) + 1));
    const stamps = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < stampCount; index++) {
        const t = index / stampCount;
        const width = Math.max(1, Math.round(contact.width * (index ? 1 - t * 0.68 : 1)));
        const height = Math.max(4, Math.round(contact.depth * (index ? 1 - t * 0.76 : 1)));
        const x = Math.round(index ? Math.cos(shadowAngle) * castLength * t : 0);
        const y = Math.round(index ? Math.sin(shadowAngle) * castLength * 0.55 * t : 0);
        const alpha = index ? (1 - t) * 0.48 : 1;
        stamps.push({ x, y, width, height, alpha });
        minX = Math.min(minX, x - Math.ceil(width / 2));
        minY = Math.min(minY, y - Math.ceil(height / 2));
        maxX = Math.max(maxX, x + Math.ceil(width / 2));
        maxY = Math.max(maxY, y + Math.ceil(height / 2));
    }
    const revision = stamps
        .map(({ x, y, width, height, alpha }) => `${x},${y},${width},${height},${alpha.toFixed(3)}`)
        .join('|');
    let cached = towerBuildingShadows.get(buildingId);
    if (!cached) {
        cached = { canvas: document.createElement('canvas'), revision: '' };
        towerBuildingShadows.set(buildingId, cached);
    }
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    if (cached.revision !== revision || cached.canvas.width !== width || cached.canvas.height !== height) {
        cached.canvas.width = width;
        cached.canvas.height = height;
        const ctx = cached.canvas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        for (const course of stamps) {
            ctx.globalAlpha = course.alpha;
            ctx.drawImage(
                stamp,
                Math.round(course.x - course.width / 2 - minX),
                Math.round(course.y - course.height / 2 - minY),
                course.width,
                course.height,
            );
        }
        ctx.globalAlpha = 1;
        cached.revision = revision;
    }
    cached.offsetX = minX;
    cached.offsetY = minY;
    return cached;
}

function buildingShadowRecords(renderer, drawable, sequence) {
    if (drawable?.kind === 'building-front') return [];
    const stamp = buildingShadowStamp();
    const building = drawable?.building;
    const grounding = getBuildingVisual(building?.type)?.grounding;
    const contact = grounding?.contact;
    if (!stamp || grounding?.shadow === 'none' || !(contact?.width > 0) || !(contact?.depth > 0)) return [];

    const lighting = renderer?._lastAtmosphere?.lighting || renderer?.buildingRenderer?.lightingState || {};
    const shadowLength = finite(lighting.shadowLength, 1);
    const shadowAngle = buildingShadowAngle(lighting);
    const shadowAlpha = finite(lighting.shadowAlpha, 0.22) * finite(contact.opacity, 0.75);
    const towerCast = grounding.shadow === 'tower-cast' && contact.castLength > 0;
    const offsetScale = towerCast ? 0.72 : 0.3;
    const baseX = finite(drawable.wx)
        + finite(contact.offsetX)
        + Math.cos(shadowAngle) * 12 * shadowLength * offsetScale;
    const baseY = finite(drawable.wy)
        + finite(contact.offsetY)
        + Math.sin(shadowAngle) * 7 * shadowLength * offsetScale;
    const buildingId = String(building?.type || drawable?.entry?.id || sequence).replace(/^building\./, '');
    const towerSource = towerCast
        ? towerBuildingShadow(stamp, buildingId, contact, shadowAngle, shadowLength)
        : null;
    const source = towerSource?.canvas || stamp;
    const width = towerSource?.canvas.width || contact.width;
    const height = towerSource?.canvas.height || contact.depth;
    return [{
        id: `ground:building:${buildingId}`,
        stableKey: `ground:building:${buildingId}`,
        textureKey: towerCast ? `building-ground-shadow:${buildingId}` : 'building-ground-shadow',
        source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        sx: 0,
        sy: 0,
        sw: source.width,
        sh: source.height,
        x: Math.round(baseX + (towerSource?.offsetX ?? -width / 2)),
        y: Math.round(baseY + (towerSource?.offsetY ?? -height / 2)),
        width,
        height,
        alpha: shadowAlpha,
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence: sequence - 0.5,
        textureRevision: towerSource?.revision || null,
        sourceKind: 'individual',
    }];
}

function recordForBuilding(renderer, drawable, sequence) {
    const assets = renderer?.assets;
    const id = drawable?.entry?.id;
    if (!id) return null;
    const individual = assets?.get?.(id);
    const dims = assets?.getDims?.(id) || (individual ? { w: individual.width, h: individual.height } : null);
    if (!dims) return null;
    const [ax, ay] = assets.getAnchor(id) || [dims.w / 2, dims.h];
    const split = drawable.kind === 'building-back' || drawable.kind === 'building-front';
    const horizon = split
        ? Math.max(1, Math.min(finite(drawable.horizonY, dims.h / 2), dims.h - 1))
        : null;
    const front = drawable.kind === 'building-front';
    const atlasFrame = assets.getAtlasFrame?.(id);
    const atlasAlbedo = atlasFrame?.atlas ? assets.getAtlas?.(atlasFrame.atlas, 'albedo') : null;
    const useAtlas = Boolean(renderer._gpuAtlasDecision?.building && atlasAlbedo && atlasFrame?.rect);
    let source;
    let sourceWidth;
    let sourceHeight;
    let sx;
    let sy;
    let sw;
    let sh;
    let textureKey;
    if (useAtlas) {
        source = atlasAlbedo;
        sourceWidth = atlasAlbedo.width;
        sourceHeight = atlasAlbedo.height;
        const rect = atlasSourceRect(atlasFrame.rect, { split, front, horizonY: horizon });
        sx = rect.sx;
        sy = rect.sy;
        sw = rect.sw;
        sh = rect.sh;
        textureKey = atlasFrame.atlas;
    } else {
        source = individual;
        if (!source) return null;
        sourceWidth = dims.w;
        sourceHeight = dims.h;
        sx = 0;
        sy = split && front ? horizon : 0;
        sw = dims.w;
        sh = split ? (front ? dims.h - horizon : horizon) : dims.h;
        textureKey = id;
    }
    const buildingType = drawable.building?.type || id.replace(/^building\./, '');
    const materialMeta = drawable.entry?.material || drawable.entry?.gpuMaterial || {};
    const materialName = materialMeta.class || drawable.entry?.materialClass || MATERIAL_BY_BUILDING[buildingType] || 'stone';
    const occupied = renderer?.buildingRenderer?._buildingOccupancyInfo?.(drawable.building)?.state;
    const active = occupied && occupied !== 'idle';
    const emissiveGate = renderer?.buildingRenderer?._emissiveGateFor?.(drawable.building) ?? 1;
    // Material/emissive are sampled with the albedo's UVs (see the GL fragment
    // shaders), so a channel source must share the albedo's geometry. When the
    // albedo comes from an atlas page the channels must be that page's channel
    // pages; a per-landmark sidecar keyed under the shared `<atlas>:channels`
    // key sampled the wrong pixels and made every batch rebind the key with a
    // different source, re-uploading the full 2048x2048 page several times per
    // frame.
    const resolved = useAtlas ? null : packedLandmarkChannels(renderer, id, { crop: true });
    const materialSource = (useAtlas
        ? assets.getAtlas?.(atlasFrame.atlas, 'material')
        : resolved?.material) || null;
    const emissiveSource = (useAtlas
        ? assets.getAtlas?.(atlasFrame.atlas, 'emissive')
        : resolved?.emissive) || null;
    const sidecarKey = useAtlas
        ? `${atlasFrame.atlas}:channels`
        : `${id}:material`;
    const record = {
        id: `${id}:${drawable.kind}`,
        stableKey: `${id}:${drawable.kind}`,
        textureKey,
        sidecarKey,
        source,
        materialSource,
        emissiveSource,
        occluderSource: useAtlas ? assets.getAtlas?.(atlasFrame.atlas, 'occluder') : resolved?.occluder,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
        sw,
        sh,
        x: Math.round(drawable.wx - ax),
        y: Math.round(drawable.wy - ay + (split && front ? horizon : 0)),
        width: useAtlas ? sw : dims.w,
        height: sh,
        material: materialClassId(materialName),
        elevation: finite(materialMeta.elevation, 0.82),
        // Never bloom an entire albedo sprite. Without an authored packed
        // material map, local semantic lights still illuminate the landmark;
        // emissive bloom begins only when the companion identifies its pixels.
        emissive: materialSource
            ? (active ? finite(materialMeta.activeEmissive, 0.12) : finite(materialMeta.emissive, 0.03))
            : 0,
        emissiveGate,
        // 3.5 pilot opt-in: only Command's authored material pixels quantize
        // admitted local light to the palette ramp. Every other landmark keeps
        // today's additive response, so the ramp cannot leak through a shared
        // atlas batch.
        paletteRamp: buildingType === 'command',
        occluder: finite(materialMeta.occluder, 0.86),
        textureRevision: assets.assetVersion || null,
        sidecarRevision: useAtlas && atlasFrame?.atlas
            ? atlasChannelRevision(assets, atlasFrame.atlas)
            : (resolved?.revision || `${assets.assetVersion || ''}:${id}`),
        sequence,
        sourceKind: useAtlas ? 'atlas' : 'individual',
    };
    const shadows = buildingShadowRecords(renderer, drawable, sequence);
    return shadows.length ? [...shadows, record] : record;
}

function recordForProp(renderer, drawable, sequence) {
    const sprite = drawable?.payload?.sprite || drawable?.sprite;
    if (!sprite?._getCachedCanvas) return null;
    const cached = sprite._getCachedCanvas(renderer?.camera?.zoom || 1);
    if (!cached?.canvas) return null;
    const part = drawable?.payload?.part || 'whole';
    const cachedW = cached.canvas.width;
    const cachedH = cached.canvas.height;
    let destY = cached.y;
    let destW = cachedW;
    let destH = cachedH;
    let splitLocalY = 0;
    const split = Boolean(sprite.splitForOcclusion && part !== 'whole');
    if (split) {
        const splitWorldY = sprite.y + finite(sprite.bounds?.splitY, -18);
        splitLocalY = Math.max(1, Math.min(cachedH - 1, Math.round(splitWorldY - cached.y)));
        if (part === 'back') destH = splitLocalY;
        else {
            destY += splitLocalY;
            destH = cachedH - splitLocalY;
        }
    }
    const assets = renderer?.assets;
    const propId = sprite.id || '';
    const isPilot = PILOT_PROP_IDS.includes(propId);
    const atlasFrame = isPilot ? assets?.getAtlasFrame?.(propId) : null;
    const atlasAlbedo = atlasFrame?.atlas ? assets?.getAtlas?.(atlasFrame.atlas, 'albedo') : null;
    const useAtlas = Boolean(isPilot && renderer._gpuAtlasDecision?.prop && atlasAlbedo && atlasFrame?.rect);
    let source = cached.canvas;
    let sourceWidth = cachedW;
    let sourceHeight = cachedH;
    let sx = 0;
    let sy = 0;
    let sw = cachedW;
    let sh = cachedH;
    let textureKey = `prop-cache:${propId || 'procedural'}:${sprite.tileX},${sprite.tileY}`;
    let sourceKind = 'individual';
    if (useAtlas) {
        source = atlasAlbedo;
        sourceWidth = atlasAlbedo.width;
        sourceHeight = atlasAlbedo.height;
        const native = atlasSourceRect(atlasFrame.rect);
        sx = native.sx;
        sy = native.sy;
        sw = native.sw;
        sh = native.sh;
        textureKey = atlasFrame.atlas;
        sourceKind = 'atlas';
        if (split) {
            const splitSrc = Math.max(1, Math.min(native.sh - 1, Math.round(splitLocalY * native.sh / cachedH)));
            if (part === 'back') sh = splitSrc;
            else {
                sy += splitSrc;
                sh = native.sh - splitSrc;
            }
        }
    } else if (split) {
        if (part === 'back') sh = splitLocalY;
        else {
            sy = splitLocalY;
            sh = cachedH - splitLocalY;
        }
    }
    // Same UV-space rule as landmarks: an atlas albedo takes the atlas channel
    // pages, never a per-prop sidecar.
    const resolved = isPilot && !useAtlas
        ? assets?.resolveMaterialChannels?.(propId, null, {
            crop: true,
            kind: 'prop',
            onScreen: true,
        })
        : null;
    const authoredClass = isPilot && (useAtlas || (resolved && resolved.origin !== 'fallback'))
        ? assets.getMaterialMetadata?.(propId)?.materialClass
        : null;
    const materialName = sprite.materialClass || authoredClass || materialForProp(sprite);
    const elevated = Math.max(0, finite(sprite.bounds?.bottom) - finite(sprite.bounds?.top));
    const materialSource = (useAtlas
        ? assets?.getAtlas?.(atlasFrame.atlas, 'material')
        : (isPilot && resolved?.origin !== 'fallback' ? resolved.material : null)) || null;
    const emissiveSource = (useAtlas
        ? assets?.getAtlas?.(atlasFrame.atlas, 'emissive')
        : (isPilot && resolved?.origin !== 'fallback' ? resolved.emissive : null)) || null;
    return {
        id: `prop:${propId || `${sprite.tileX},${sprite.tileY}`}:${part}`,
        stableKey: drawable.stableKey || propId || `${sprite.tileX},${sprite.tileY}`,
        textureKey,
        sidecarKey: materialSource
            ? (useAtlas && atlasFrame?.atlas ? `${atlasFrame.atlas}:channels` : `${propId}:channels`)
            : '',
        source,
        materialSource,
        emissiveSource,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
        sw,
        sh,
        x: cached.x,
        y: destY,
        width: destW,
        height: destH,
        material: materialClassId(materialName),
        elevation: materialName === 'foliage' ? 0.64 : elevated > 70 ? 0.58 : 0.34,
        emissive: emissiveSource ? 0 : (materialName === 'fire' ? 0.35 : 0),
        occluder: elevated > 36 ? 0.58 : 0.2,
        textureRevision: useAtlas ? (assets.assetVersion || 0) : (sprite._gpuCacheRevision || 0),
        sidecarRevision: useAtlas && atlasFrame?.atlas
            ? atlasChannelRevision(assets, atlasFrame.atlas)
            : (resolved?.revision || null),
        sequence,
        sourceKind,
    };
}

function recordsForAgent(drawable, sequence) {
    const sprite = drawable?.payload || drawable;
    if (!sprite) return [];
    const direct = sprite.getGpuWorldRecords?.() || sprite._gpuWorldRecords || sprite._gpuFrameRecord;
    const records = Array.isArray(direct) ? direct : direct ? [direct] : [];
    const baseRecords = records.map((record, index) => ({
        ...record,
        id: record.id || `agent:${sprite.agent?.id || sequence}:${index}`,
        stableKey: record.stableKey || sprite.agent?.id || `agent:${sequence}`,
        textureKey: record.textureKey || `agent:${sprite._spriteProfileKey || sprite.agent?.id || sequence}`,
        material: record.material ?? materialClassId(gpuMaterialNameForProvider(sprite.agent?.provider)),
        elevation: record.elevation ?? 0.52,
        occluder: record.occluder ?? 0.58,
        sequence: sequence + index / 100,
    }));
    if (!baseRecords.length) return baseRecords;
    const shadow = groundShadowRecord(sprite, sequence - 0.01);
    return shadow ? [shadow, ...baseRecords] : baseRecords;
}

let sharedGroundShadow = null;

function groundShadowRecord(sprite, sequence) {
    if (typeof document === 'undefined') return null;
    if (!sharedGroundShadow) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 24;
        const ctx = canvas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        // Stepped, contact-heavy shadow: dense core at the feet and two
        // quantized falloff courses. It belongs to the GPU scene so the body
        // no longer reads as a sticker floating over the terrain.
        ctx.fillStyle = 'rgba(9, 8, 7, 0.14)';
        ctx.fillRect(8, 7, 48, 10);
        ctx.fillRect(13, 4, 38, 16);
        ctx.fillStyle = 'rgba(8, 7, 6, 0.24)';
        ctx.fillRect(15, 7, 34, 10);
        ctx.fillRect(20, 5, 24, 14);
        ctx.fillStyle = 'rgba(6, 5, 4, 0.32)';
        ctx.fillRect(22, 8, 20, 8);
        sharedGroundShadow = canvas;
    }
    const status = sprite.agent?.status;
    const primary = status === 'waiting_on_user' || status === 'errored' || sprite.selected;
    return {
        id: `ground:${sprite.agent?.id || sequence}`,
        stableKey: `ground:${sprite.agent?.id || sequence}`,
        textureKey: 'agent-ground-shadow',
        source: sharedGroundShadow,
        sourceWidth: sharedGroundShadow.width,
        sourceHeight: sharedGroundShadow.height,
        sx: 0,
        sy: 0,
        sw: sharedGroundShadow.width,
        sh: sharedGroundShadow.height,
        x: Math.round(sprite.x - sharedGroundShadow.width / 2),
        y: Math.round(sprite.y - sharedGroundShadow.height / 2 + 2),
        width: sharedGroundShadow.width,
        height: sharedGroundShadow.height,
        alpha: primary ? 1 : 0.82,
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence,
    };
}

function ensureAgentChannelAtlas(renderer, property, width, height, state) {
    let atlas = renderer[property];
    let resized = false;
    if (!atlas && typeof document !== 'undefined') {
        atlas = document.createElement('canvas');
        renderer[property] = atlas;
        resized = true;
    }
    if (!atlas) {
        state.atlas = null;
        state.resized = false;
        return state;
    }
    if (atlas.width !== width || atlas.height !== height) {
        atlas.width = width;
        atlas.height = height;
        resized = true;
    }
    state.atlas = atlas;
    state.resized = resized;
    return state;
}

function drawAgentChannelFrame(ctx, record, channel, x, y) {
    const source = record[channel];
    if (!source) return;
    const srcW = source.width || 0;
    const srcH = source.height || 0;
    if (srcW === record.sw && srcH === record.sh) {
        ctx.drawImage(source, 0, 0, srcW, srcH, x, y, record.sw, record.sh);
        return;
    }
    if (srcW >= (record.sx || 0) + record.sw && srcH >= (record.sy || 0) + record.sh) {
        ctx.drawImage(
            source,
            record.sx,
            record.sy,
            record.sw,
            record.sh,
            x,
            y,
            record.sw,
            record.sh,
        );
        return;
    }
    const ox = Math.max(0, Math.floor((record.sw - srcW) / 2));
    const oy = Math.max(0, Math.floor((record.sh - srcH) / 2));
    ctx.drawImage(source, 0, 0, srcW, srcH, x + ox, y + oy, srcW, srcH);
}

function drawAgentChannelAtlas(atlas, records, slots, columns, cell, channel) {
    if (!atlas) return;
    const ctx = atlas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    for (const record of records) {
        const slot = slots.get(record.id) || 0;
        const slotX = (slot % columns) * cell;
        const slotY = Math.floor(slot / columns) * cell;
        ctx.clearRect(slotX, slotY, cell, cell);
        drawAgentChannelFrame(ctx, record, channel, slotX, slotY);
    }
}

function buildAgentAtlasTextureUpdates(renderer, poolProperty, records, slots, columns, cell, channel) {
    const updates = [];
    if (!records.length || typeof document === 'undefined') return updates;
    const pool = renderer[poolProperty] ||= new Map();
    const liveIds = new Set();
    for (const record of records) {
        liveIds.add(record.id);
        let canvas = pool.get(record.id);
        if (!canvas) {
            canvas = document.createElement('canvas');
            pool.set(record.id, canvas);
        }
        if (canvas.width !== cell || canvas.height !== cell) {
            canvas.width = cell;
            canvas.height = cell;
        }
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, cell, cell);
        drawAgentChannelFrame(ctx, record, channel, 0, 0);
        const slot = slots.get(record.id) || 0;
        updates.push({
            x: (slot % columns) * cell,
            y: Math.floor(slot / columns) * cell,
            width: cell,
            height: cell,
            source: canvas,
        });
    }
    for (const id of pool.keys()) {
        if (!liveIds.has(id) && !slots.has(id)) pool.delete(id);
    }
    return updates;
}

export function packGpuAgentFrameAtlas(renderer, records) {
    const agentRecords = records.filter(record => String(record.id || '').startsWith('agent:'));
    if (!agentRecords.length || typeof document === 'undefined') return records;
    let cell = 1;
    let hasMaterialSource = false;
    let hasEmissiveSource = false;
    let hasOccluderSource = false;
    for (const record of agentRecords) {
        cell = Math.max(cell, Math.ceil(Math.max(record.sw || 1, record.sh || 1)));
        hasMaterialSource ||= Boolean(record.materialSource);
        hasEmissiveSource ||= Boolean(record.emissiveSource);
        hasOccluderSource ||= Boolean(record.occluderSource);
    }
    const capacity = Math.max(agentRecords.length, renderer?.agentSprites?.size || 0, 1);
    const columns = Math.max(1, Math.ceil(Math.sqrt(capacity)));
    const rows = Math.max(1, Math.ceil(capacity / columns));
    const width = columns * cell;
    const height = rows * cell;
    const slots = renderer._gpuAgentAtlasSlots ||= new Map();
    const roster = [...(renderer?.agentSprites?.keys?.() || [])].sort();
    const rosterSignature = roster.join('|');
    let nextSlot = renderer._gpuAgentAtlasNextSlot || 0;
    let newSlot = false;
    if (rosterSignature !== renderer._gpuAgentAtlasRosterSignature) {
        slots.clear();
        roster.forEach((id, index) => slots.set(`agent:${id}`, index));
        nextSlot = roster.length;
        renderer._gpuAgentAtlasRosterSignature = rosterSignature;
        renderer._gpuAgentAtlasFrameKeys?.clear?.();
        renderer._gpuAgentAtlasPoses?.clear?.();
        newSlot = true;
    }
    for (const record of agentRecords) {
        if (slots.has(record.id)) continue;
        slots.set(record.id, nextSlot++);
        newSlot = true;
    }
    renderer._gpuAgentAtlasNextSlot = nextSlot;
    let atlas = renderer._gpuAgentFrameAtlas;
    let resized = false;
    if (!atlas || atlas.width !== width || atlas.height !== height) {
        atlas = document.createElement('canvas');
        atlas.width = width;
        atlas.height = height;
        renderer._gpuAgentFrameAtlas = atlas;
        renderer._gpuAgentFrameAtlasSignature = '';
        renderer._gpuAgentFrameAtlasRevision = 0;
        renderer._gpuAgentAtlasFrameKeys = new Map();
        resized = true;
    }
    const frameKeys = renderer._gpuAgentAtlasFrameKeys ||= new Map();
    const poses = renderer._gpuAgentAtlasPoses ||= new Map();
    const desiredKeys = renderer._gpuAgentAtlasDesiredKeys ||= [];
    desiredKeys.length = agentRecords.length;
    let changed = resized || newSlot;
    let missingFrame = false;
    const dirtyRecords = [];
    for (let index = 0; index < agentRecords.length; index++) {
        const record = agentRecords[index];
        const key = [
            record.id,
            record.textureKey,
            record.sx,
            record.sy,
            record.sw,
            record.sh,
            record.textureRevision,
            record.channelRevision ?? record.sidecarRevision,
            record.materialSource ? 'material' : '',
            record.emissiveSource ? 'emissive' : '',
            record.occluderSource ? 'occluder' : '',
            record.poseKey || '',
        ].join(':');
        desiredKeys[index] = key;
        if (frameKeys.get(record.id) !== key) {
            changed = true;
            dirtyRecords.push(record);
        }
        if (!frameKeys.has(record.id)) missingFrame = true;
    }
    const materialAtlasState = renderer._gpuAgentMaterialAtlasState ||= { atlas: null, resized: false };
    const emissiveAtlasState = renderer._gpuAgentEmissiveAtlasState ||= { atlas: null, resized: false };
    if (hasMaterialSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentMaterialAtlas', width, height, materialAtlasState);
    } else {
        materialAtlasState.atlas = null;
        materialAtlasState.resized = false;
    }
    if (hasEmissiveSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentEmissiveAtlas', width, height, emissiveAtlasState);
    } else {
        emissiveAtlasState.atlas = null;
        emissiveAtlasState.resized = false;
    }
    const occluderAtlasState = renderer._gpuAgentOccluderAtlasState ||= { atlas: null, resized: false };
    if (hasOccluderSource) ensureAgentChannelAtlas(renderer, '_gpuAgentOccluderAtlas', width, height, occluderAtlasState);
    else { occluderAtlasState.atlas = null; occluderAtlasState.resized = false; }
    const channelsChanged = occluderAtlasState.resized || changed
        || materialAtlasState.resized
        || emissiveAtlasState.resized
        || occluderAtlasState.resized;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cadenceElapsed = now - (renderer._gpuAgentAtlasUpdatedAt || 0) >= 125;
    // Direction/tool changes and individually important actors must keep body
    // and attachment poses in the same frame. Ambient animation stays at 8 Hz.
    const immediate = new Set(dirtyRecords.filter(record => record.urgentPose
        || (poses.has(record.id) && poses.get(record.id) !== record.poseKey)));
    if (!resized && !newSlot && !missingFrame && !cadenceElapsed) {
        for (let index = dirtyRecords.length - 1; index >= 0; index--) {
            if (!immediate.has(dirtyRecords[index])) dirtyRecords.splice(index, 1);
        }
    }
    renderer._gpuAgentAlbedoTextureUpdates = [];
    renderer._gpuAgentMaterialTextureUpdates = [];
    renderer._gpuAgentEmissiveTextureUpdates = [];
    renderer._gpuAgentOccluderTextureUpdates = [];
    if (changed && (resized || newSlot || missingFrame || cadenceElapsed || immediate.size)) {
        const ctx = atlas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        for (let index = 0; index < agentRecords.length; index++) {
            const record = agentRecords[index];
            if (!resized && frameKeys.get(record.id) === desiredKeys[index]) continue;
            if (!resized && !newSlot && !missingFrame && !cadenceElapsed && !immediate.has(record)) continue;
            const slot = slots.get(record.id) || 0;
            const slotX = (slot % columns) * cell;
            const slotY = Math.floor(slot / columns) * cell;
            ctx.clearRect(slotX, slotY, cell, cell);
            ctx.drawImage(
                record.source,
                record.sx,
                record.sy,
                record.sw,
                record.sh,
                slotX,
                slotY,
                record.sw,
                record.sh,
            );
            frameKeys.set(record.id, desiredKeys[index]);
            poses.set(record.id, record.poseKey);
        }
        renderer._gpuAgentFrameAtlasSignature = desiredKeys.slice().sort().join('|');
        renderer._gpuAgentFrameAtlasRevision++;
        if (cadenceElapsed || resized || newSlot || missingFrame) renderer._gpuAgentAtlasUpdatedAt = now;
        if (!resized) {
            renderer._gpuAgentAlbedoTextureUpdates = buildAgentAtlasTextureUpdates(
                renderer,
                '_gpuAgentAlbedoUpdateCanvases',
                dirtyRecords,
                slots,
                columns,
                cell,
                'source',
            );
        }
    }
    const packNow = resized
        || newSlot
        || missingFrame
        || cadenceElapsed
        || immediate.size > 0
        || materialAtlasState.resized
        || emissiveAtlasState.resized
        || occluderAtlasState.resized;
    if (channelsChanged && packNow) {
        const geometryRecords = occluderAtlasState.resized ? agentRecords : dirtyRecords;
        drawAgentChannelAtlas(occluderAtlasState.atlas, geometryRecords, slots, columns, cell, 'occluderSource');
        if (!occluderAtlasState.resized && occluderAtlasState.atlas) {
            renderer._gpuAgentOccluderTextureUpdates = buildAgentAtlasTextureUpdates(renderer,
                '_gpuAgentOccluderUpdateCanvases', geometryRecords, slots, columns, cell, 'occluderSource');
        }
        const materialRecords = materialAtlasState.resized ? agentRecords : dirtyRecords;
        const emissiveRecords = emissiveAtlasState.resized ? agentRecords : dirtyRecords;
        drawAgentChannelAtlas(
            materialAtlasState.atlas,
            materialRecords,
            slots,
            columns,
            cell,
            'materialSource',
        );
        drawAgentChannelAtlas(
            emissiveAtlasState.atlas,
            emissiveRecords,
            slots,
            columns,
            cell,
            'emissiveSource',
        );
        renderer._gpuAgentSidecarRevision = (renderer._gpuAgentSidecarRevision || 0) + 1;
        if (!materialAtlasState.resized && materialAtlasState.atlas) {
            renderer._gpuAgentMaterialTextureUpdates = buildAgentAtlasTextureUpdates(
                renderer,
                '_gpuAgentMaterialUpdateCanvases',
                materialRecords,
                slots,
                columns,
                cell,
                'materialSource',
            );
        }
        if (!emissiveAtlasState.resized && emissiveAtlasState.atlas) {
            renderer._gpuAgentEmissiveTextureUpdates = buildAgentAtlasTextureUpdates(
                renderer,
                '_gpuAgentEmissiveUpdateCanvases',
                emissiveRecords,
                slots,
                columns,
                cell,
                'emissiveSource',
            );
        }
    }
    for (const record of agentRecords) {
        const slot = slots.get(record.id) || 0;
        record.source = atlas;
        record.sourceWidth = width;
        record.sourceHeight = height;
        record.sx = (slot % columns) * cell;
        record.sy = Math.floor(slot / columns) * cell;
        record.textureKey = 'agent-frame-atlas';
        record.textureRevision = renderer._gpuAgentFrameAtlasRevision;
        record.textureUpdates = renderer._gpuAgentAlbedoTextureUpdates;
        // Pack the authored channels into the same slot geometry as albedo so
        // the GL batch can bind one frame-local material/emissive source for
        // every agent. Empty slots stay transparent and use the profile/default
        // record values without inferring emission from albedo.
        record.materialSource = materialAtlasState.atlas;
        record.emissiveSource = emissiveAtlasState.atlas;
        record.occluderSource = occluderAtlasState.atlas;
        record.occluderTextureUpdates = renderer._gpuAgentOccluderTextureUpdates;
        record.sidecarKey = materialAtlasState.atlas || emissiveAtlasState.atlas
            ? 'agent-frame-atlas:channels'
            : '';
        record.sidecarRevision = materialAtlasState.atlas || emissiveAtlasState.atlas
            ? renderer._gpuAgentSidecarRevision || 0
            : null;
        record.materialTextureUpdates = renderer._gpuAgentMaterialTextureUpdates;
        record.emissiveTextureUpdates = renderer._gpuAgentEmissiveTextureUpdates;
    }
    return records;
}

function uniqueAssetBytes(assets, id) {
    const dims = assets?.getDims?.(id);
    if (dims) return Math.max(0, dims.w) * Math.max(0, dims.h) * 4;
    const image = assets?.get?.(id);
    return Math.max(0, image?.width || 0) * Math.max(0, image?.height || 0) * 4;
}

function decideAtlasCategories(renderer, drawables = []) {
    const assets = renderer?.assets;
    const atlas = assets?.getAtlas?.('world-pilot', 'albedo');
    const atlasBytes = atlas ? atlas.width * atlas.height * 4 : 0;
    const buildings = new Map();
    const props = new Map();
    for (const drawable of drawables || []) {
        if (drawable.kind?.startsWith?.('building')) {
            const id = drawable.payload?.entry?.id || drawable.entry?.id;
            if (!id || buildings.has(id) || !assets?.getAtlasFrame?.(id)) continue;
            buildings.set(id, uniqueAssetBytes(assets, id));
        } else if (drawable.kind?.startsWith?.('prop')) {
            const sprite = drawable.payload?.sprite || drawable.sprite;
            const id = sprite?.id;
            if (!id || !PILOT_PROP_IDS.includes(id) || props.has(id) || !assets?.getAtlasFrame?.(id)) continue;
            props.set(id, uniqueAssetBytes(assets, id));
        }
    }
    const atlasResident = Boolean(renderer._gpuAtlasResident);
    const building = shouldUseAtlasForCategory({
        category: 'building',
        atlasBytes,
        individualBytes: [...buildings.values()].reduce((sum, bytes) => sum + bytes, 0),
        recordCount: buildings.size,
        atlasResident,
    });
    const prop = shouldUseAtlasForCategory({
        category: 'prop',
        atlasBytes,
        individualBytes: [...props.values()].reduce((sum, bytes) => sum + bytes, 0),
        recordCount: props.size,
        atlasResident: atlasResident || building,
    });
    if (building || prop) renderer._gpuAtlasResident = true;
    return {
        building,
        prop,
        atlasBytes,
        buildingIds: buildings.size,
        propIds: props.size,
        buildingBytes: [...buildings.values()].reduce((sum, bytes) => sum + bytes, 0),
        propBytes: [...props.values()].reduce((sum, bytes) => sum + bytes, 0),
    };
}

function sourceKindCensus(records = [], decision = {}) {
    let atlasRecords = 0;
    let individualRecords = 0;
    let uploadBytesEstimate = 0;
    const seenTextures = new Set();
    for (const record of records) {
        const kind = record.sourceKind
            || (String(record.textureKey || '').startsWith('world-pilot') || record.textureKey === 'world-pilot'
                ? 'atlas'
                : 'individual');
        if (kind === 'atlas') atlasRecords += 1;
        else individualRecords += 1;
        const key = record.textureKey || record.id;
        if (seenTextures.has(key)) continue;
        seenTextures.add(key);
        uploadBytesEstimate += Math.max(0, record.sourceWidth || 0) * Math.max(0, record.sourceHeight || 0) * 4;
        for (const channel of [record.materialSource, record.emissiveSource, record.occluderSource]) {
            if (channel && channel !== record.source) {
                uploadBytesEstimate += Math.max(0, channel.width || 0) * Math.max(0, channel.height || 0) * 4;
            }
        }
    }
    return {
        atlasRecords,
        individualRecords,
        uploadBytesEstimate,
        batchCount: seenTextures.size,
        categories: {
            building: decision.building ? 'atlas' : 'individual',
            prop: decision.prop ? 'atlas' : 'individual',
            terrain: 'cache',
            agent: 'frame-atlas',
        },
    };
}

export function buildGpuWorldRecords(renderer, { drawables = [] } = {}) {
    const decision = decideAtlasCategories(renderer, drawables);
    if (renderer) renderer._gpuAtlasDecision = decision;
    const records = renderer?._gpuWorldRecordScratch || [];
    records.length = 0;
    const terrain = recordForTerrain(renderer);
    if (terrain) records.push(terrain);
    const haze = recordForHaze(renderer);
    if (haze) records.push(haze);
    const cue = renderer?._semanticGroundCanvas;
    if (cue && renderer._semanticGroundActive) {
        const camera = renderer.camera;
        records.push({ id: 'ground:semantics', source: cue, textureKey: 'ground:semantics',
            x: -camera.renderOffsetX / camera.zoom, y: -camera.renderOffsetY / camera.zoom,
            width: renderer._semanticGroundViewport.width / camera.zoom, height: renderer._semanticGroundViewport.height / camera.zoom,
            textureRevision: renderer._semanticGroundRevision, elevation: 0, occluder: 0 });
    }
    let sequence = 0;
    for (const drawable of drawables || []) {
        let next = null;
        if (drawable.kind?.startsWith?.('building')) {
            next = recordForBuilding(renderer, drawable.payload || drawable, sequence);
        } else if (drawable.kind?.startsWith?.('prop')) {
            next = recordForProp(renderer, drawable, sequence);
        } else if (drawable.kind === 'agent') {
            const agentRecords = recordsForAgent(drawable, sequence);
            for (let index = 0; index < agentRecords.length; index++) records.push(agentRecords[index]);
        } else if (typeof drawable.buildGpuRecord === 'function') {
            next = drawable.buildGpuRecord({ renderer, sequence });
        } else if (typeof drawable.payload?.buildGpuRecord === 'function') {
            next = drawable.payload.buildGpuRecord({ renderer, drawable, sequence });
        }
        if (Array.isArray(next)) {
            for (let index = 0; index < next.length; index++) records.push(next[index]);
        }
        else if (next) records.push(next);
        sequence++;
    }
    packGpuAgentFrameAtlas(renderer, records);
    const ordered = renderer?._gpuWorldOrderedRecords || [];
    ordered.length = 0;
    for (let index = 0; index < records.length; index++) {
        if (records[index].id === 'terrain:static') ordered.push(records[index]);
    }
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (record.id !== 'terrain:static' && String(record.id || '').startsWith('ground:')) ordered.push(record);
    }
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (record.id !== 'terrain:static' && !String(record.id || '').startsWith('ground:')) ordered.push(record);
    }
    if (renderer) {
        renderer._gpuWorldRecordScratch = records;
        renderer._gpuWorldOrderedRecords = ordered;
        renderer._gpuMaterialPacketDiagnostics = sourceKindCensus(ordered, decision);
        renderer._gpuMaterialPacketDiagnostics.terrainOrigin = renderer._gpuTerrainMaterialOrigin || 'procedural';
    }
    return ordered;
}

export function gpuMaterialNameForBuilding(type) {
    return MATERIAL_BY_BUILDING[type] || 'stone';
}

export function gpuMaterialNameForProp(sprite) {
    return materialForProp(sprite);
}
