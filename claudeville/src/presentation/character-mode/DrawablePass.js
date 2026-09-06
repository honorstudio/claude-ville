import { normalizeMaterialMetadata } from './MaterialRegistry.js';

function finiteSortY(value) {
    return Number.isFinite(value) ? value : 0;
}

const KIND_ORDER = Object.freeze({
    'building-back': 10,
    'prop-back': 20,
    prop: 30,
    'harbor-traffic': 40,
    'bridge-lantern': 45,
    agent: 50,
    'landmark-activity': 60,
    'chronicle-monument': 70,
    chronicler: 75,
    'familiar-motes': 80,
    'building-front': 90,
    building: 95,
});
const EMPTY_SEMANTICS = Object.freeze({});

/**
 * Shared depth drawable contract for World mode overlap rendering.
 *
 * Shape:
 * - kind: stable category for diagnostics and special-case consumers.
 * - sortY: finite world-space Y used for painter ordering.
 * - drawFallback(ctx, zoom, context): current Canvas-2D implementation.
 * - buildGpuRecord(context): optional additive GPU-record seam.
 * - hitArea: optional future hit-test metadata.
 * - payload: original source object for legacy consumers.
 */
export function createDepthDrawable(kind, sortY, payload, drawFallback, semantics = EMPTY_SEMANTICS) {
    return initializeDepthDrawable({}, kind, sortY, payload, drawFallback, semantics);
}

function drawDepthDrawableFallback(ctx, zoom, context) {
    this._drawFallback?.call(undefined, ctx, zoom, context, this.payload, this);
}

function buildDepthDrawableGpuRecord(context = {}) {
    if (typeof this._gpuBuilder === 'function') {
        return this._gpuBuilder.call(undefined, context, this.payload, this);
    }
    return context.spriteRenderer?.buildGpuRecordForDrawable?.(this, context) ?? null;
}

function initializeDepthDrawable(drawable, kind, sortY, payload, drawFallback, semantics = EMPTY_SEMANTICS) {
    const materialSource = drawableMaterialSource(payload, semantics);
    const materialId = drawableMaterialId(payload, semantics, materialSource);
    let material = drawable._material;
    if (
        !material
        || drawable._materialSource !== materialSource
        || drawable._materialId !== materialId
        || drawable._materialClass !== (semantics?.materialClass ?? materialSource.materialClass)
        || drawable._elevation !== (semantics?.elevation ?? materialSource.elevation)
        || drawable._emissive !== (semantics?.emissive ?? materialSource.emissive)
        || drawable._occluder !== (semantics?.occluder ?? materialSource.occluder)
        || drawable._atlasFrame !== (semantics?.atlasFrame ?? materialSource.atlasFrame)
    ) {
        material = drawableMaterialMetadata(payload, semantics, materialSource, materialId);
        drawable._material = material;
        drawable._materialSource = materialSource;
        drawable._materialId = materialId;
        drawable._materialClass = semantics?.materialClass ?? materialSource.materialClass;
        drawable._elevation = semantics?.elevation ?? materialSource.elevation;
        drawable._emissive = semantics?.emissive ?? materialSource.emissive;
        drawable._occluder = semantics?.occluder ?? materialSource.occluder;
        drawable._atlasFrame = semantics?.atlasFrame ?? materialSource.atlasFrame;
    }
    const gpuBuilder = semantics?.buildGpuRecord || payload?.buildGpuRecord || null;
    // Every mutable/public field is assigned on every checkout. In particular,
    // category-only fields are reset here so a wrapper reused for another kind
    // cannot retain scene policy from its previous entity.
    drawable.kind = kind;
    drawable.sortY = finiteSortY(sortY);
    drawable.sortBand = Number.isFinite(Number(semantics?.sortBand))
        ? Number(semantics.sortBand)
        : KIND_ORDER[kind] ?? 50;
    drawable.stableKey = payloadStableKey(payload);
    drawable.salience = normalizeSalience(semantics?.salience ?? payload?.salience);
    drawable.materialId = material.materialId;
    drawable.materialClass = material.materialClass;
    drawable.elevation = material.elevation;
    drawable.emissive = material.emissive;
    drawable.occluder = material.occluder;
    drawable.atlasFrame = material.atlasFrame;
    drawable.hitArea = payload?.hitArea || null;
    drawable.payload = payload;
    drawable._drawFallback = drawFallback || null;
    drawable.drawFallback = drawDepthDrawableFallback;
    drawable.draw = drawDepthDrawableFallback;
    drawable._gpuBuilder = gpuBuilder;
    drawable.gpuReady = typeof gpuBuilder === 'function';
    drawable.buildGpuRecord = buildDepthDrawableGpuRecord;
    drawable.sceneCategory = null;
    drawable.overlayBand = 0;
    drawable.sequence = 0;
    return drawable;
}

function drawAgent(ctx, zoom, context, sprite) {
    sprite?.draw?.(ctx, zoom, context.agentRenderMode || 'full');
}

function drawBuilding(ctx, zoom, context, drawable) {
    context.buildingRenderer?.drawDrawable?.(ctx, drawable);
}

function drawProp(ctx, zoom, context, payload) {
    payload?.sprite?.drawPart?.(ctx, payload.part || 'whole', zoom);
}


function drawChronicleMonument(ctx, zoom, context, drawable) {
    context.chronicleMonuments?.draw?.(ctx, drawable, zoom, context.renderNow);
}

function drawChronicler(ctx, zoom, context, drawable) {
    context.chronicler?.draw?.(ctx, drawable, zoom);
}


function drawFamiliarMotes(ctx, zoom, context, drawable) {
    drawable?.draw?.(ctx, zoom, context);
}

function drawSceneCategory(ctx, zoom, context, payload, drawable) {
    drawable.sceneCategory?.canvasFallback(ctx, payload, zoom, context);
}

const _framePools = new WeakMap();
const _sceneCategorySemantics = new WeakMap();

function sceneCategorySemantics(category) {
    let semantics = _sceneCategorySemantics.get(category);
    if (!semantics) {
        semantics = { sortBand: category.sortBand };
        _sceneCategorySemantics.set(category, semantics);
    } else {
        semantics.sortBand = category.sortBand;
    }
    return semantics;
}

function pooledDepthDrawable(target, kind, sortY, payload, drawFallback, semantics) {
    let pool = _framePools.get(target);
    if (!pool) {
        pool = {
            byEntity: new WeakMap(),
            stableCurrent: new Map(),
            stablePrevious: new Map(),
            fallback: [],
            fallbackCursor: 0,
            generation: 0,
        };
        _framePools.set(target, pool);
    }
    let drawable = null;
    const entity = payload?.building || payload?.agent || payload?.sprite || null;
    if (entity && (typeof entity === 'object' || typeof entity === 'function')) {
        let byKind = pool.byEntity.get(entity);
        if (!byKind) {
            byKind = new Map();
            pool.byEntity.set(entity, byKind);
        }
        drawable = byKind.get(kind);
        if (!drawable) {
            drawable = {};
            byKind.set(kind, drawable);
        }
    } else {
        const stableKey = payloadStableKey(payload);
        if (stableKey) {
            let byKind = pool.stableCurrent.get(stableKey);
            if (!byKind) {
                byKind = new Map();
                pool.stableCurrent.set(stableKey, byKind);
            }
            drawable = byKind.get(kind);
            if (!drawable) {
                drawable = pool.stablePrevious.get(stableKey)?.get(kind) || {};
                byKind.set(kind, drawable);
            }
        } else {
            const index = pool.fallbackCursor++;
            drawable = pool.fallback[index] || (pool.fallback[index] = {});
        }
    }
    if (drawable && drawable._poolGeneration === pool.generation) {
        const index = pool.fallbackCursor++;
        drawable = pool.fallback[index] || (pool.fallback[index] = {});
    }
    drawable._poolGeneration = pool.generation;
    return initializeDepthDrawable(drawable, kind, sortY, payload, drawFallback, semantics);
}

export function propDepthDrawable(sprite, part = 'whole') {
    const kind = part === 'whole' ? 'prop' : `prop-${part}`;
    const sortY = part === 'back'
        ? sprite.propBackSortY()
        : part === 'front'
            ? sprite.propFrontSortY()
            : sprite.sortY ?? sprite.y;
    return createDepthDrawable(kind, sortY, { sprite, part }, drawProp);
}

export function appendDepthSortedDrawables(target, {
    buildingDrawables = [],
    propDrawables = [],
    agentSprites = [],
    sceneCategoryFrame = null,
    chronicleMonumentDrawables = [],
    chroniclerDrawables = [],
    familiarDrawables = [],
} = {}) {
    const pool = _framePools.get(target);
    if (pool) {
        pool.fallbackCursor = 0;
        pool.generation += 1;
        const previous = pool.stablePrevious;
        pool.stablePrevious = pool.stableCurrent;
        pool.stableCurrent = previous;
        pool.stableCurrent.clear();
    }
    for (const drawable of buildingDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, drawable.kind, drawable.sortY, drawable, drawBuilding));
    }
    for (const drawable of propDrawables) {
        pushDepthDrawable(target, drawable);
    }
    for (const sprite of agentSprites) {
        pushDepthDrawable(target, pooledDepthDrawable(target, 'agent', sprite.y, sprite, drawAgent));
    }
    for (const entry of sceneCategoryFrame?.entries || []) {
        const category = entry.category;
        for (const item of entry.items) {
            const drawable = pooledDepthDrawable(
                target,
                category.id,
                item?.sortY,
                item,
                drawSceneCategory,
                sceneCategorySemantics(category),
            );
            drawable.sceneCategory = category;
            drawable.overlayBand = category.overlayBand;
            pushDepthDrawable(target, drawable);
        }
    }
    for (const drawable of chronicleMonumentDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, 'chronicle-monument', drawable.sortY, drawable, drawChronicleMonument));
    }
    for (const drawable of chroniclerDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, 'chronicler', drawable.sortY, drawable, drawChronicler));
    }
    for (const drawable of familiarDrawables) {
        pushDepthDrawable(target, pooledDepthDrawable(target, drawable.kind || 'familiar-motes', drawable.sortY, drawable, drawFamiliarMotes));
    }
    const activePool = _framePools.get(target);
    for (let index = activePool?.fallbackCursor || 0; index < (activePool?.fallback.length || 0); index++) {
        clearPooledDrawable(activePool.fallback[index]);
    }
    target.sort(compareDepthDrawables);
}

function clearPooledDrawable(drawable) {
    drawable.kind = null;
    drawable.stableKey = '';
    drawable.hitArea = null;
    drawable.payload = null;
    drawable._drawFallback = null;
    drawable._gpuBuilder = null;
    drawable.sceneCategory = null;
    drawable.elevation = null;
    drawable.emissive = null;
    drawable.occluder = null;
    drawable.atlasFrame = null;
    drawable._material = null;
    drawable._materialSource = null;
    drawable._elevation = null;
    drawable._emissive = null;
    drawable._occluder = null;
    drawable._atlasFrame = null;
}

export function drawDepthSortedDrawables(ctx, drawables, context = {}) {
    const zoom = context.zoom || 1;
    for (const drawable of drawables) {
        if (
            context.gpuWorldActive
            && (drawable.kind?.startsWith?.('building') || drawable.kind?.startsWith?.('prop'))
        ) {
            continue;
        }
        drawable.draw?.(ctx, zoom, context);
    }
}

// Legacy selective-draw helper retained for non-category callers. Scene backend
// fallback must use drawSceneCategoryOverlays() so policy stays in the registry.
export function drawDepthSortedDrawableKinds(ctx, drawables, kinds, context = {}) {
    const accepted = kinds || [];
    if (!accepted.size && !accepted.length) return;
    const zoom = context.zoom || 1;
    for (const drawable of drawables || []) {
        if (accepted instanceof Set ? !accepted.has(drawable?.kind) : !accepted.includes(drawable?.kind)) continue;
        drawable.draw?.(ctx, zoom, context);
    }
}

// Replays only categories selected by the registry's backend-policy resolution.
// overlayBand orders whole categories on the ungraded transparent canvas; the
// canonical depth-pass order is retained within the same band.
export function drawSceneCategoryOverlays(ctx, drawables, resolution, context = {}) {
    const accepted = resolution?.overlayCategoryIds;
    if (!(accepted instanceof Set) || !accepted.size) return;
    const selected = _sceneOverlayBuffer;
    selected.length = 0;
    for (let index = 0; index < (drawables || []).length; index++) {
        const drawable = drawables[index];
        if (!drawable?.sceneCategory || !accepted.has(drawable.sceneCategory.id)) continue;
        selected.push(drawable);
    }
    selected.sort(compareOverlayBands);
    const zoom = context.zoom || 1;
    for (const drawable of selected) drawable.draw?.(ctx, zoom, context);
}

const _sceneOverlayBuffer = [];

function compareOverlayBands(a, b) {
    return a.overlayBand - b.overlayBand;
}

// Converts the already-sorted stream without reordering painter semantics.
// Package 6 can batch only consecutive compatible records after this seam.
export function buildGpuRecordsFromDrawables(drawables, context = {}) {
    const records = [];
    for (let drawOrder = 0; drawOrder < (drawables || []).length; drawOrder++) {
        const drawable = drawables[drawOrder];
        const built = drawable?.buildGpuRecord?.(context);
        if (!built) continue;
        const candidates = Array.isArray(built) ? built : [built];
        for (const record of candidates) {
            if (!record) continue;
            records.push({
                kind: drawable.kind,
                sortY: drawable.sortY,
                sortBand: drawable.sortBand,
                stableKey: drawable.stableKey,
                salience: drawable.salience,
                materialId: drawable.materialId,
                materialClass: drawable.materialClass,
                elevation: drawable.elevation,
                emissive: drawable.emissive,
                occluder: drawable.occluder,
                atlasFrame: drawable.atlasFrame,
                ...record,
                drawOrder,
            });
        }
    }
    return records;
}

export function cullDepthSortedDrawables(drawables, camera, viewport, margin = 180, collectDiagnostics = true) {
    const rect = worldViewportRect(camera, viewport, margin, _viewportRect);
    if (!rect) {
        return collectDiagnostics
            ? { enabled: false, input: drawables.length, drawn: drawables.length, culled: 0 }
            : null;
    }

    let writeIndex = 0;
    const byKind = collectDiagnostics ? {} : null;
    for (let i = 0; i < drawables.length; i++) {
        const drawable = drawables[i];
        if (drawableVisibleInRect(drawable, rect)) {
            drawables[writeIndex++] = drawable;
            continue;
        }
        if (byKind) {
            const kind = drawable.kind || 'unknown';
            byKind[kind] = (byKind[kind] || 0) + 1;
        }
    }
    const input = drawables.length;
    drawables.length = writeIndex;
    return collectDiagnostics ? {
        enabled: true,
        input,
        drawn: writeIndex,
        culled: input - writeIndex,
        byKind,
    } : null;
}

export function summarizeDrawableLayers(drawables, culling = null) {
    const byKind = {};
    const byMaterial = {};
    let gpuReady = 0;
    let emissive = 0;
    let occluders = 0;
    for (const drawable of drawables || []) {
        const kind = drawable?.kind || 'unknown';
        byKind[kind] = (byKind[kind] || 0) + 1;
        const materialClass = drawable?.materialClass || 'unlit';
        byMaterial[materialClass] = (byMaterial[materialClass] || 0) + 1;
        if (drawable?.gpuReady) gpuReady++;
        if ((drawable?.emissive?.strength || 0) > 0) emissive++;
        if (drawable?.occluder?.mode && drawable.occluder.mode !== 'none') occluders++;
    }
    return {
        total: drawables?.length || 0,
        byKind,
        byMaterial,
        gpuReady,
        emissive,
        occluders,
        culling,
    };
}

function pushDepthDrawable(target, drawable) {
    drawable.sequence = target.length;
    drawable.sortBand = Number.isFinite(Number(drawable.sortBand))
        ? Number(drawable.sortBand)
        : KIND_ORDER[drawable.kind] ?? 50;
    target.push(drawable);
}

function compareDepthDrawables(a, b) {
    return (a.sortY - b.sortY)
        || (a.sortBand - b.sortBand)
        || String(a.kind || '').localeCompare(String(b.kind || ''))
        || String(a.stableKey || '').localeCompare(String(b.stableKey || ''))
        || ((a.sequence || 0) - (b.sequence || 0));
}

const _viewportRect = { left: 0, right: 0, top: 0, bottom: 0 };

function worldViewportRect(camera, viewport, margin, rect) {
    if (!camera || typeof camera.screenToWorld !== 'function' || !viewport?.width || !viewport?.height) return null;
    const a = camera.screenToWorld(-margin, -margin);
    const b = camera.screenToWorld(viewport.width + margin, viewport.height + margin);
    rect.left = Math.min(a.x, b.x);
    rect.right = Math.max(a.x, b.x);
    rect.top = Math.min(a.y, b.y);
    rect.bottom = Math.max(a.y, b.y);
    return rect;
}

function drawableVisibleInRect(drawable, rect) {
    const point = drawablePoint(drawable, _drawablePoint);
    if (!point) return true;
    const radius = drawableRadius(drawable);
    return point.x >= rect.left - radius
        && point.x <= rect.right + radius
        && point.y >= rect.top - radius
        && point.y <= rect.bottom + radius;
}

const _drawablePoint = { x: 0, y: 0 };

function drawablePoint(drawable, point) {
    const payload = drawable?.payload || drawable;
    if (Number.isFinite(Number(payload?.wx)) && Number.isFinite(Number(payload?.wy))) {
        point.x = Number(payload.wx);
        point.y = Number(payload.wy);
        return point;
    }
    if (Number.isFinite(Number(payload?.x)) && Number.isFinite(Number(payload?.y))) {
        point.x = Number(payload.x);
        point.y = Number(payload.y);
        return point;
    }
    if (Number.isFinite(Number(drawable?.x)) && Number.isFinite(Number(drawable?.y))) {
        point.x = Number(drawable.x);
        point.y = Number(drawable.y);
        return point;
    }
    if (Number.isFinite(Number(payload?.payload?.x)) && Number.isFinite(Number(payload?.payload?.y))) {
        point.x = Number(payload.payload.x);
        point.y = Number(payload.payload.y);
        return point;
    }
    return null;
}

function drawableRadius(drawable) {
    const kind = drawable?.kind || '';
    if (kind.startsWith('building')) return 260;
    if (kind === 'harbor-traffic') return 180;
    if (kind === 'agent') return 80;
    if (kind.includes('prop')) return 150;
    return 120;
}

function payloadStableKey(payload) {
    return payload?.id
        || payload?.entry?.id
        || payload?.building?.type
        || payload?.agent?.id
        || payload?.squadKey
        || payload?.payload?.id
        || payload?.payload?.squadKey
        || payload?.payload?.project
        || '';
}

function normalizeSalience(value) {
    return value === 'primary' || value === 'recent' || value === 'working'
        ? value
        : 'ambient';
}

function drawableMaterialSource(payload, semantics) {
    const entry = payload?.entry || payload?.sprite?.entry || null;
    return semantics?.material || payload?.material || entry || EMPTY_SEMANTICS;
}

function drawableMaterialId(payload, semantics, source) {
    const entry = payload?.entry || payload?.sprite?.entry || null;
    return semantics?.materialId
        || source.materialId
        || entry?.id
        || payload?.sprite?.id
        || payload?.id
        || 'material.default';
}

function drawableMaterialMetadata(payload, semantics, source, materialId) {
    return normalizeMaterialMetadata(source, {
        materialId,
        materialClass: semantics?.materialClass ?? source.materialClass,
        elevation: semantics?.elevation ?? source.elevation,
        emissive: semantics?.emissive ?? source.emissive,
        occluder: semantics?.occluder ?? source.occluder,
        atlasFrame: semantics?.atlasFrame ?? source.atlasFrame,
    });
}
