// Pixel-art invariant: the browser may only ever scale a canvas backing store
// to the display by an exact integer factor. `image-rendering: pixelated`
// then replicates pixels instead of resampling them, so authored art and
// canvas text keep hard edges. Any fractional factor shreds the 1px strokes
// of a pixel font — that was the "blurry/unreadable on a big screen" report.
//
// So the backing DPR is always `deviceDpr / n` for an integer n: one backing
// pixel covers exactly n x n device pixels, whatever the device ratio is
// (2 on Retina, 2.5 at 125% browser zoom, 1 elsewhere). n only grows when the
// viewport would otherwise blow the per-surface pixel budget, and a coarser
// rung stays pixel-exact — it never resamples, it just gets chunkier.
const MIN_BACKING_DPR = 0.25;
// Screen-surface equivalents that scale with the backing DPR: the visible 2D
// canvas, the UI overlay, the WebGL drawing buffer, the two full-resolution
// GPU scene attachments, and headroom for the PostFX/atmosphere surfaces. The
// sky and trail caches are deliberately excluded — the sky cache is pinned at
// CSS resolution (SkyRenderer._skyCacheDpr) and the trail cache is world-space.
const SCREEN_SURFACE_COUNT = 7;
// Per screen-surface backing ceiling, the one knob that decides the rung.
// 7.5M backing px keeps native device resolution through ~1.87M CSS px, which
// covers every built-in MacBook display and the 1440p range; 5K/6K viewports
// drop to the next integer rung instead of quadrupling into ~350MB.
const MAX_MAIN_CANVAS_PIXELS = 7_500_000;
const WORLD_CACHE_PIXEL_RESERVE = 7_000_000;
const LIGHT_CACHE_PIXEL_RESERVE = 1_250_000;
const AUX_CACHE_PIXEL_RESERVE = 250_000;
const BYTES_PER_RGBA_PIXEL = 4;
const MAX_RENDERER_CANVAS_PIXELS = MAX_MAIN_CANVAS_PIXELS * SCREEN_SURFACE_COUNT
    + WORLD_CACHE_PIXEL_RESERVE + LIGHT_CACHE_PIXEL_RESERVE + AUX_CACHE_PIXEL_RESERVE;
// Native-Retina GPU cost measured at 1488x946 CSS: ~42.5MB of cached source
// textures plus ~54.5MB of full-resolution scene attachments.
const MAX_GPU_RESOURCE_BYTES = 128 * 1024 * 1024;
const RESOURCE_ESTIMATE_PROVIDERS = new Set();

export const RESOURCE_OWNERSHIP = Object.freeze({
    CPU_DECODED: 'CPU-decoded',
    CPU_DERIVED: 'CPU-derived',
    CANVAS_VISIBLE: 'Canvas-visible',
    GPU_OWNED: 'GPU-owned',
});

export const CANVAS_BUDGET = Object.freeze({
    maxRendererCanvasPixels: MAX_RENDERER_CANVAS_PIXELS,
    maxMainCanvasPixels: MAX_MAIN_CANVAS_PIXELS,
    maxScreenCachePixels: MAX_MAIN_CANVAS_PIXELS,
    maxWorldCachePixels: WORLD_CACHE_PIXEL_RESERVE,
    maxLightCachePixels: LIGHT_CACHE_PIXEL_RESERVE,
    // Persisted trails are cached once in world space. The current 40x40 map
    // projects to roughly 3.3M pixels, leaving margin without allowing a future
    // map expansion to create an unbounded backing store.
    maxTrailCachePixels: 4_000_000,
    maxGpuResourceBytes: MAX_GPU_RESOURCE_BYTES,
    // One accounting ceiling for Canvas backing stores plus GPU-owned textures,
    // attachments, and buffers. This is diagnostic policy, not an allocator.
    maxUnifiedRendererBytes: MAX_RENDERER_CANVAS_PIXELS * BYTES_PER_RGBA_PIXEL + MAX_GPU_RESOURCE_BYTES,
});

export const RENDERER_RESOURCE_BYTES_PER_PIXEL = BYTES_PER_RGBA_PIXEL;

// Largest `deviceDpr / n` rung whose backing store fits the per-surface budget.
// `requestedDpr` is never clamped from above: capping it would make the
// backing-to-display ratio fractional again on a hypothetical >4x display,
// which is exactly the artefact this ladder exists to prevent. Oversized
// viewports are handled by growing `n`, not by capping the device ratio.
//
// `MIN_BACKING_DPR` is a hard floor, not a budget rung: a viewport would need
// ~120M CSS pixels to reach it, and rendering the village below quarter
// resolution is worse than exceeding a diagnostic ceiling.
export function effectiveCanvasDpr(cssWidth, cssHeight, requestedDpr = 1) {
    const width = Math.max(1, Number(cssWidth) || 1);
    const height = Math.max(1, Number(cssHeight) || 1);
    const cssPixels = width * height;
    const reported = Number(requestedDpr);
    const device = Number.isFinite(reported) && reported > 0
        ? Math.max(MIN_BACKING_DPR, reported)
        : 1;
    const screenBudget = Math.max(
        1,
        CANVAS_BUDGET.maxRendererCanvasPixels -
            CANVAS_BUDGET.maxWorldCachePixels -
            CANVAS_BUDGET.maxLightCachePixels -
            AUX_CACHE_PIXEL_RESERVE,
    );
    const perSurfacePixels = Math.min(
        CANVAS_BUDGET.maxMainCanvasPixels,
        screenBudget / SCREEN_SURFACE_COUNT,
    );
    let dpr = device;
    for (let divisor = 1; ; divisor++) {
        const candidate = device / divisor;
        if (candidate < MIN_BACKING_DPR) break;
        dpr = candidate;
        if (cssPixels * candidate * candidate <= perSurfacePixels) break;
    }
    return dpr;
}

export function releaseCanvasBackingStore(canvas) {
    if (!canvas) return;
    const backingCanvas = canvas.canvas || canvas;
    try {
        backingCanvas.width = 0;
        backingCanvas.height = 0;
    } catch {
        // Some browser-owned canvases may reject resizing during teardown.
    }
}

export function canvasPixelCount(canvas) {
    if (!canvas) return 0;
    const backingCanvas = canvas.canvas || canvas;
    const width = Number(backingCanvas.width) || 0;
    const height = Number(backingCanvas.height) || 0;
    return Math.max(0, width * height);
}

export function canvasByteCount(canvas, bytesPerPixel = BYTES_PER_RGBA_PIXEL) {
    return canvasPixelCount(canvas) * Math.max(0, Number(bytesPerPixel) || 0);
}

function normalizedResourceGroup(group = {}) {
    const out = {};
    if (!group || typeof group !== 'object') return out;
    for (const [name, value] of Object.entries(group)) {
        const bytes = Number(value);
        out[name] = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
    }
    return out;
}

function normalizedEstimateEntries(entries, ownershipClass) {
    if (!entries) return [];
    const source = Array.isArray(entries)
        ? entries
        : Object.entries(entries).map(([key, estimateBytes]) => ({ key, estimateBytes }));
    return source.map((entry, index) => ({
        key: String(entry?.key ?? index),
        estimateBytes: Math.max(0, Math.round(Number(entry?.estimateBytes) || 0)),
        ownershipClass,
    }));
}

/**
 * Sum estimated backing bytes once per ownership class and artifact key.
 * CPU backing and a GL upload intentionally use different ownership classes:
 * they can coexist, but can never silently collapse into one ambiguous value.
 */
export function sumUniqueResourceEstimates(entries = []) {
    const seen = new Set();
    let estimateBytes = 0;
    for (const entry of entries) {
        const ownershipClass = String(entry?.ownershipClass || '');
        const key = String(entry?.key || '');
        const identity = `${ownershipClass}\u0000${key}`;
        if (!ownershipClass || !key || seen.has(identity)) continue;
        seen.add(identity);
        estimateBytes += Math.max(0, Math.round(Number(entry?.estimateBytes) || 0));
    }
    return estimateBytes;
}

export function shouldEvictAtHighWater(currentEstimateBytes, highWaterEstimateBytes) {
    const current = Math.max(0, Number(currentEstimateBytes) || 0);
    const highWater = Math.max(0, Number(highWaterEstimateBytes) || 0);
    return highWater > 0 && current > highWater;
}

export function unpinnedCacheKeys(entries = [], pinnedKeys = new Set()) {
    const pins = pinnedKeys instanceof Set ? pinnedKeys : new Set(pinnedKeys || []);
    return entries
        .filter((entry) => entry?.key != null && !pins.has(entry.key))
        .map((entry) => entry.key);
}

/** Register a live diagnostic provider. Registration does not allocate or evict. */
export function registerRendererResourceEstimateProvider(provider) {
    if (typeof provider !== 'function') return () => {};
    RESOURCE_ESTIMATE_PROVIDERS.add(provider);
    return () => RESOURCE_ESTIMATE_PROVIDERS.delete(provider);
}

function registeredResourceEstimates() {
    const combined = {
        cpuDecoded: [],
        cpuDerived: [],
        canvasVisible: [],
        gpuOwned: [],
    };
    for (const provider of RESOURCE_ESTIMATE_PROVIDERS) {
        let estimates = null;
        try {
            estimates = provider();
        } catch {
            estimates = null;
        }
        if (!estimates) continue;
        for (const name of Object.keys(combined)) {
            combined[name].push(...(estimates[name] || []));
        }
    }
    return combined;
}

/**
 * Build one byte ledger for renderer-owned GPU resources. Callers keep named
 * leaves (rather than an opaque total) so future attachments cannot silently
 * escape diagnostics or be double-counted.
 */
export function gpuResourceAccounting({ textures = {}, attachments = {}, buffers = {} } = {}) {
    const groups = {
        textures: normalizedResourceGroup(textures),
        attachments: normalizedResourceGroup(attachments),
        buffers: normalizedResourceGroup(buffers),
    };
    const evictableBytes = Object.entries(groups.textures)
        .filter(([name]) => name.endsWith('evictableSources'))
        .reduce((sum, [, bytes]) => sum + bytes, 0);
    const groupTotals = Object.fromEntries(Object.entries(groups).map(([name, values]) => [
        name,
        Object.values(values).reduce((sum, bytes) => sum + bytes, 0),
    ]));
    return {
        ...groups,
        groupTotals,
        totalBytes: Object.values(groupTotals).reduce((sum, bytes) => sum + bytes, 0),
        // Every `evictableSources` leaf (renderers namespace their own) is the
        // idle cache; the rest of the ledger is in use this frame. Attachments
        // and buffers stay allocated across quality levels, so they are pinned.
        pinnedBytes: groupTotals.textures - evictableBytes + groupTotals.attachments + groupTotals.buffers,
        evictableBytes,
    };
}

/**
 * Combine approximate CPU backing, Canvas surfaces, and the GPU byte ledger
 * without assuming every future resource is RGBA8. Estimates remain separated
 * by ownership class so a CPU source and its GL upload are both visible.
 */
export function unifiedRendererResourceAccounting({
    visibleCanvasPixels = 0,
    volatileCanvasPixels = 0,
    retainedCanvasPixels = 0,
    gpu = null,
    cpuDecodedEstimates = [],
    cpuDerivedEstimates = [],
    canvasVisibleEstimates = [],
    gpuOwnedEstimates = [],
} = {}) {
    const registered = registeredResourceEstimates();
    const canvas = {
        visible: Math.max(0, Math.round(Number(visibleCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
        volatile: Math.max(0, Math.round(Number(volatileCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
        retained: Math.max(0, Math.round(Number(retainedCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
    };
    const gpuLedger = gpu || gpuResourceAccounting();
    const estimates = [
        ...normalizedEstimateEntries(registered.cpuDecoded, RESOURCE_OWNERSHIP.CPU_DECODED),
        ...normalizedEstimateEntries(cpuDecodedEstimates, RESOURCE_OWNERSHIP.CPU_DECODED),
        ...normalizedEstimateEntries(registered.cpuDerived, RESOURCE_OWNERSHIP.CPU_DERIVED),
        ...normalizedEstimateEntries(cpuDerivedEstimates, RESOURCE_OWNERSHIP.CPU_DERIVED),
        ...normalizedEstimateEntries(registered.canvasVisible, RESOURCE_OWNERSHIP.CANVAS_VISIBLE),
        ...normalizedEstimateEntries(canvasVisibleEstimates, RESOURCE_OWNERSHIP.CANVAS_VISIBLE),
        ...normalizedEstimateEntries(registered.gpuOwned, RESOURCE_OWNERSHIP.GPU_OWNED),
        ...normalizedEstimateEntries(gpuOwnedEstimates, RESOURCE_OWNERSHIP.GPU_OWNED),
        { key: 'legacy.visible-canvases', estimateBytes: canvas.visible, ownershipClass: RESOURCE_OWNERSHIP.CANVAS_VISIBLE },
        { key: 'legacy.volatile-canvases', estimateBytes: canvas.volatile, ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED },
        { key: 'legacy.retained-canvases', estimateBytes: canvas.retained, ownershipClass: RESOURCE_OWNERSHIP.CPU_DERIVED },
        { key: 'renderer.gl-resources', estimateBytes: gpuLedger.totalBytes, ownershipClass: RESOURCE_OWNERSHIP.GPU_OWNED },
    ];
    const ownershipLeaves = {
        cpuDecodedEstimateBytes: sumUniqueResourceEstimates(estimates.filter(
            (entry) => entry.ownershipClass === RESOURCE_OWNERSHIP.CPU_DECODED,
        )),
        cpuDerivedEstimateBytes: sumUniqueResourceEstimates(estimates.filter(
            (entry) => entry.ownershipClass === RESOURCE_OWNERSHIP.CPU_DERIVED,
        )),
        canvasVisibleEstimateBytes: sumUniqueResourceEstimates(estimates.filter(
            (entry) => entry.ownershipClass === RESOURCE_OWNERSHIP.CANVAS_VISIBLE,
        )),
        gpuOwnedBytes: sumUniqueResourceEstimates(estimates.filter(
            (entry) => entry.ownershipClass === RESOURCE_OWNERSHIP.GPU_OWNED,
        )),
    };
    const canvasBytes = ownershipLeaves.cpuDerivedEstimateBytes
        + ownershipLeaves.canvasVisibleEstimateBytes;
    const gpuBytes = ownershipLeaves.gpuOwnedBytes;
    return {
        canvas,
        canvasBytes,
        gpu: gpuLedger,
        gpuBytes,
        ownershipLeaves,
        totalBytes: Object.values(ownershipLeaves).reduce((sum, bytes) => sum + bytes, 0),
        budgetBytes: CANVAS_BUDGET.maxUnifiedRendererBytes,
    };
}

export function canvasMapPixelCount(map) {
    if (!map || typeof map.values !== 'function') return 0;
    let pixels = 0;
    for (const canvas of map.values()) pixels += canvasPixelCount(canvas);
    return pixels;
}

export function releaseCanvasMap(map) {
    if (!map || typeof map.values !== 'function') return;
    for (const canvas of map.values()) releaseCanvasBackingStore(canvas);
    map.clear();
}
