import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';

export const GPU_WORLD_RENDERER_MODES = Object.freeze({
    WEBGL: 'webgl',
    CANVAS: 'canvas',
});

// C3 effect receipts for the optional work the resident renderer ships today.
// Measured with the 0.1 per-pass sampler on `ANGLE Metal Renderer: Apple M5 Pro`,
// 1680x1026, fixed 22:00 clear, FULL, 13-24 rotating samples per pass, 2026-09-05;
// bands span the dense-24 and dense-100 observations. Bands are observed pass
// means on a shared host, not portable entitlements.
//
// `cost.scope` says how to read the band. `own-pass`: the effect is its own
// pass, so the band is what shedding returns. `shared-scene-envelope`: the
// effect is a branch inside the scene pass, so shedding it returns nothing of
// its band; where a paired A/B never resolved the branch above the host noise
// floor the band is written `[0, ceiling]` — the resolvable limit, not a claim
// of zero cost. A row prices added time as `cost.gpuMsBand` or removed time as
// `cost.gpuMsSavedBand`, never both: work that a substitution *removes* is not
// an optional effect, ships at every level, and is never shed. Attachment
// bytes stay allocated across levels (`GpuWorldRenderer._ensureTargets`);
// `bytes` prices what an effect keeps resident, not what it returns when shed.
//
// Key order is the shedding order: embellishment first, depth cues last. Every
// level entry states what ships at that ladder level, so the table is the only
// authority the renderer reads — there is no second ladder.
export const EFFECT_BUDGET = Object.freeze({
    bloom: Object.freeze({
        id: 'bloom',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'reduced', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [1.131, 2.232], cpuMsBand: [0.003, 0.085], bytes: 8830080, scope: 'own-pass' }),
        staticFallback: 'authored-emission',
        canvas: 'authored-emission',
    }),
    'weather-amplitude': Object.freeze({
        id: 'weather-amplitude',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'reduced', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [1.392, 2.155], cpuMsBand: [0.100, 0.150], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'phase-grade',
        canvas: 'canvas-weather',
    }),
    occlusion: Object.freeze({
        id: 'occlusion',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0.134, 0.608], cpuMsBand: [0.059, 0.128], bytes: 967680, scope: 'own-pass' }),
        staticFallback: 'direct-light',
        canvas: 'authored-shading',
    }),
    'cloud-courses': Object.freeze({
        id: 'cloud-courses',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsBand: [1.392, 2.155], cpuMsBand: [0.100, 0.150], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'phase-grade',
        canvas: 'retained-cloud-shadow',
    }),
    'water-reflection': Object.freeze({
        id: 'water-reflection',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsBand: [1.392, 2.155], cpuMsBand: [0.100, 0.150], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'authored-water',
        canvas: 'authored-water',
    }),
    // Wave 3 rows. Same rig as the Wave 0 rows but re-measured at 1920x1080,
    // forced FULL, `dense-24-agents`, fixed 22:00 clear, 30 s per sample,
    // 32 samples per pass, 2026-09-06, on `ANGLE Metal Renderer: Apple M5 Pro`.
    // The host was shared with seven concurrent capture agents: the bands are
    // wide for that reason, and any delta under ~0.35 ms sits inside the noise
    // floor rather than being resolvable.
    //
    // 3.1 is a substitution, not an optional effect: it replaces the stacked
    // `lightBoost` x emissive-phase x beacon products and caps halo area, so
    // its row prices the work it *removes* (`gpuMsSavedBand`) and ships at
    // every ladder level — there is nothing here to shed. Before (neutral
    // envelope, uncapped halos): scene 1.197-1.731, bloom 1.511-2.040,
    // whole-frame 2.335-2.790. After: scene 1.054-1.466, bloom 1.080-1.723,
    // whole-frame 1.560-2.264, with the same 25 admitted lights and the same
    // 124,969,776 texture bytes.
    'exposure-envelope': Object.freeze({
        id: 'exposure-envelope',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsSavedBand: [0.143, 0.679], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'same-envelope',
        canvas: 'same-envelope',
    }),
    // 3.4 picks one of three authored night grade courses and, at FULL only,
    // one extra stepped water course. No band separable from the scene
    // envelope: it is a uniform selection, not new per-fragment work.
    'moon-course': Object.freeze({
        id: 'moon-course',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'ambient-course-only', MINIMAL: 'ambient-course-only' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'ambient-course-only',
        canvas: 'ambient-course-only',
    }),
    // 3.2 lays the real source hue on approved wet cobble/stone/earth. Paired
    // in-session A/B at storm 23:00 forced FULL (`storm-night-reduced-motion`):
    // on scene 0.956 / 2.091, off 2.112 / 2.431; across separate sessions on
    // 1.506-2.234, off 0.870-2.685. The branch never resolved above the host
    // noise floor, so the band is an upper bound, not a measured mean.
    'wet-reflection': Object.freeze({
        id: 'wet-reflection',
        levels: Object.freeze({ FULL: 'eight-sources', REDUCED: 'four-sources', MINIMAL: 'static-wet-darkening' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.35], cpuMsBand: [0, 0.02], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'static-wet-darkening',
        canvas: 'cached-stepped-stamps',
    }),
    // 3.5 quantizes the Command pilot's admitted light to an authored ramp.
    // The table is 11x3 RGBA (132 B) plus one extra vertex float; the resident
    // texture ceiling is unchanged because `MAX_CACHED_TEXTURE_BYTES` gives up
    // exactly those bytes. Measured at 22:00 clear FULL, zoom 3 on Command:
    // scene 1.054-1.466 with the table, 1.099-1.461 without it.
    'palette-ramp': Object.freeze({
        id: 'palette-ramp',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.005], bytes: 132, scope: 'shared-scene-envelope' }),
        staticFallback: 'authored-albedo',
        canvas: 'authored-albedo',
    }),
});

const EFFECT_LEVEL_NAMES = ['FULL', 'REDUCED', 'MINIMAL'];

/**
 * What the named effect does at a resident quality level: `on`, a named
 * degraded mode, or `off`. Levels beyond MINIMAL (the minimal-resident probe)
 * keep MINIMAL's row; the renderer never renders below it.
 */
export function effectBudgetMode(id, level) {
    const effect = EFFECT_BUDGET[id];
    if (!effect) throw new Error(`unknown effect budget: ${id}`);
    const index = Math.min(EFFECT_LEVEL_NAMES.length - 1, Math.max(0, Math.round(Number(level) || 0)));
    return effect.levels[EFFECT_LEVEL_NAMES[index]];
}

/** Effects not at their FULL mode, in declared shedding order. */
export function shedEffectsForLevel(level) {
    const shed = [];
    for (const effect of Object.values(EFFECT_BUDGET)) {
        const mode = effectBudgetMode(effect.id, level);
        if (mode !== effect.levels.FULL) shed.push({ id: effect.id, mode });
    }
    return shed;
}

// One authored grade contract for the direct GPU world, hybrid PostFx, and
// Canvas fallback. Normalized channels can be uploaded as uniforms directly;
// the Canvas path converts the same values to byte-space CSS colors.
export const WORLD_PHASE_GRADES = Object.freeze({
    day: Object.freeze({
        base: Object.freeze([1, 0.996, 0.98]),
        edge: Object.freeze([0.84, 0.88, 0.91]),
        edgeAlpha: 0.28,
        fog: Object.freeze([0.55, 0.68, 0.74]),
    }),
    // 3.4 — `night` is the middle of three reviewed night ambient courses;
    // `moonFill` picks between them (see `worldPhaseGrade`). The courses differ
    // by one authored step in base/edge/fog, never by a continuous fade, and
    // the darkest keeps enough base to read unlit ground.
    night: Object.freeze({
        base: Object.freeze([0.50, 0.59, 0.77]),
        edge: Object.freeze([0.32, 0.42, 0.60]),
        edgeAlpha: 0.46,
        fog: Object.freeze([0.08, 0.12, 0.22]),
    }),
    'night-new-moon': Object.freeze({
        base: Object.freeze([0.43, 0.51, 0.69]),
        edge: Object.freeze([0.28, 0.37, 0.55]),
        edgeAlpha: 0.50,
        fog: Object.freeze([0.06, 0.10, 0.19]),
    }),
    'night-moonlit': Object.freeze({
        base: Object.freeze([0.58, 0.68, 0.85]),
        edge: Object.freeze([0.37, 0.48, 0.66]),
        edgeAlpha: 0.42,
        fog: Object.freeze([0.11, 0.16, 0.27]),
    }),
    dusk: Object.freeze({
        base: Object.freeze([0.93, 0.75, 0.62]),
        edge: Object.freeze([0.59, 0.38, 0.38]),
        edgeAlpha: 0.42,
        fog: Object.freeze([0.38, 0.29, 0.34]),
    }),
    dawn: Object.freeze({
        base: Object.freeze([0.89, 0.79, 0.78]),
        edge: Object.freeze([0.49, 0.46, 0.59]),
        edgeAlpha: 0.40,
        fog: Object.freeze([0.44, 0.46, 0.58]),
    }),
});

// 3.4 — reviewed night courses keyed by `lighting.moonFill`. Two thresholds,
// no interpolation: a full moon reads one course brighter and a new moon one
// course darker than the shipped night, and every backend selects with this
// function so resident, hybrid, and Canvas agree.
export const NIGHT_MOON_COURSE_THRESHOLDS = Object.freeze({ dark: 0.14, bright: 0.5 });

export function nightMoonCourse(moonFill = 0) {
    const fill = Math.max(0, Math.min(1, finite(moonFill, 0)));
    if (fill < NIGHT_MOON_COURSE_THRESHOLDS.dark) return 'night-new-moon';
    if (fill >= NIGHT_MOON_COURSE_THRESHOLDS.bright) return 'night-moonlit';
    return 'night';
}

/** The authored grade for a phase, including the night moon course. */
export function worldPhaseGrade(phase = 'day', moonFill = 0) {
    if (phase === 'night') return WORLD_PHASE_GRADES[nightMoonCourse(moonFill)];
    return WORLD_PHASE_GRADES[phase] || WORLD_PHASE_GRADES.day;
}

// Ambient sources currently use the registry default (0). Keeping attention
// in an explicit high band makes the operator signal stable if ambient source
// priorities grow later.
export const GPU_ATTENTION_LIGHT_PRIORITY = 1_000_000;

// Compatibility aliases stay public for focused renderer tests, while the
// manifest/tooling registry is the single numeric authority.
export const GPU_MATERIAL_CLASSES = Object.freeze({
    ...MATERIAL_CLASS_IDS,
    default: MATERIAL_CLASS_IDS.unlit,
    rune: MATERIAL_CLASS_IDS['glass-rune'],
});

const VALID_MODES = new Set(Object.values(GPU_WORLD_RENDERER_MODES));

// PostFxFeed and the direct GPU renderer share this slot shape. Colors stay in
// 0-255 byte space until the renderer stages normalized uniforms; keeping the
// conversion here prevents a string-vs-channel contract drift from silently
// replacing authored light colors with a fallback.
export const GPU_LIGHT_COLOR_ENCODING = 'rgb-255';

export function setGpuLightColor(slot, rgb = []) {
    if (!slot || !Array.isArray(rgb) || rgb.length < 3) return slot;
    slot.r = Math.max(0, Math.min(255, finite(rgb[0], 255)));
    slot.g = Math.max(0, Math.min(255, finite(rgb[1], 255)));
    slot.b = Math.max(0, Math.min(255, finite(rgb[2], 255)));
    return slot;
}

export function gpuLightColorForShader(light = {}, fallback = [1, 0.78, 0.42], target = null) {
    const output = target || new Array(3);
    const r = Number(light?.r);
    const g = Number(light?.g);
    const b = Number(light?.b);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        output[0] = fallback[0];
        output[1] = fallback[1];
        output[2] = fallback[2];
        return output;
    }
    output[0] = Math.max(0, Math.min(1, r / 255));
    output[1] = Math.max(0, Math.min(1, g / 255));
    output[2] = Math.max(0, Math.min(1, b / 255));
    return output;
}

export function createGpuTimingMetricsScratch() {
    return {
        cpu: {
            source: 'cpu-fallback',
            metrics: { uploadMs: 0, frameGapMs: 0, shaderCpuMs: 0 },
        },
        gpu: {
            source: 'gpu-timer',
            metrics: { uploadMs: 0, frameGapMs: 0, gpuMs: 0 },
        },
    };
}

export function selectGpuTimingMetrics({
    uploadMs = 0,
    shaderCpuMs = 0,
    gpuMs = null,
    gpuTimerSupported = false,
    frameGapMs = 0,
} = {}, scratch = null) {
    const useGpu = Boolean(
        gpuTimerSupported
        && gpuMs !== null
        && gpuMs !== undefined
        && Number.isFinite(Number(gpuMs)),
    );
    const result = scratch?.cpu && scratch?.gpu
        ? (useGpu ? scratch.gpu : scratch.cpu)
        : scratch || null;
    if (!result) {
        return {
            source: useGpu ? 'gpu-timer' : 'cpu-fallback',
            metrics: {
                uploadMs: Math.max(0, finite(uploadMs)),
                frameGapMs: Math.max(0, finite(frameGapMs)),
                ...(useGpu
                    ? { gpuMs: Math.max(0, finite(gpuMs)) }
                    : { shaderCpuMs: Math.max(0, finite(shaderCpuMs)) }),
            },
        };
    }
    const metrics = result.metrics ||= {};
    metrics.uploadMs = Math.max(0, finite(uploadMs));
    metrics.frameGapMs = Math.max(0, finite(frameGapMs));
    if (useGpu) {
        metrics.gpuMs = Math.max(0, finite(gpuMs));
        delete metrics.shaderCpuMs;
    } else {
        metrics.shaderCpuMs = Math.max(0, finite(shaderCpuMs));
        delete metrics.gpuMs;
    }
    result.source = useGpu ? 'gpu-timer' : 'cpu-fallback';
    return result;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function resolveGpuWorldRendererMode(search = '', { webgl2 = true } = {}) {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const requested = String(params.get('renderer') || '').trim().toLowerCase();
    if (requested === GPU_WORLD_RENDERER_MODES.CANVAS) return GPU_WORLD_RENDERER_MODES.CANVAS;
    if (requested === GPU_WORLD_RENDERER_MODES.WEBGL) {
        return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
    }
    return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
}

export function materialClassId(value) {
    if (Number.isFinite(Number(value))) {
        return Math.max(0, Math.min(255, Math.round(Number(value))));
    }
    return registryMaterialClassId(value);
}

export function normalizeGpuRecord(record = {}, sequence = 0, target = null) {
    const source = record.source || record.image || null;
    const sourceWidth = Math.max(1, finite(record.sourceWidth, source?.width || 1));
    const sourceHeight = Math.max(1, finite(record.sourceHeight, source?.height || 1));
    const sx = finite(record.sx, 0);
    const sy = finite(record.sy, 0);
    const sw = Math.max(0, finite(record.sw, sourceWidth));
    const sh = Math.max(0, finite(record.sh, sourceHeight));
    const width = Math.max(0, finite(record.width ?? record.w, sw));
    const height = Math.max(0, finite(record.height ?? record.h, sh));
    const alpha = Math.max(0, Math.min(1, finite(record.alpha, 1)));
    const elevation = Math.max(0, Math.min(1, finite(record.elevation, 0)));
    const emissive = Math.max(0, Math.min(2, finite(record.emissive, 0)));
    const occluder = Math.max(0, Math.min(1, finite(record.occluder, 0)));
    const blend = record.blend === 'add' ? 'add' : 'normal';
    const textureKey = String(record.textureKey || record.stableKey || record.id || `texture:${sequence}`);
    const sidecarKey = String(record.sidecarKey || record.materialSidecarKey || '');
    const normalized = target || { ...record };
    if (target) Object.assign(normalized, record);
    normalized.source = source;
    normalized.materialSource = record.materialSource || record.sidecar || null;
    normalized.emissiveSource = record.emissiveSource || null;
    normalized.occluderSource = record.occluderSource || null;
    normalized.occluderTextureUpdates = record.occluderTextureUpdates || null;
    normalized.textureKey = textureKey;
    normalized.sidecarKey = sidecarKey;
    normalized.sourceWidth = sourceWidth;
    normalized.sourceHeight = sourceHeight;
    normalized.sx = sx;
    normalized.sy = sy;
    normalized.sw = sw;
    normalized.sh = sh;
    normalized.x = finite(record.x);
    normalized.y = finite(record.y);
    normalized.width = width;
    normalized.height = height;
    normalized.alpha = alpha;
    normalized.elevation = elevation;
    normalized.emissive = emissive;
    normalized.emissiveGate = Math.max(0, Math.min(1, finite(record.emissiveGate, 1)));
    normalized.occluder = occluder;
    normalized.material = materialClassId(record.material ?? record.materialId);
    normalized.blend = blend;
    normalized.sequence = finite(record.sequence, sequence);
    normalized.textureRevision = record.textureRevision ?? null;
    normalized.sidecarRevision = record.sidecarRevision ?? null;
    normalized.textureUpdates = record.textureUpdates ?? null;
    normalized.materialTextureUpdates = record.materialTextureUpdates ?? null;
    normalized.emissiveTextureUpdates = record.emissiveTextureUpdates ?? null;
    return normalized;
}

export function validGpuRecord(record) {
    return Boolean(
        record?.source
        && record.sw > 0
        && record.sh > 0
        && record.width > 0
        && record.height > 0
        && Number.isFinite(record.x)
        && Number.isFinite(record.y),
    );
}

export function buildStableGpuBatches(records = [], batches = [], normalizedRecords = []) {
    let batchCount = 0;
    let current = null;
    for (let index = 0; index < records.length; index++) {
        const normalized = normalizedRecords[index] || (normalizedRecords[index] = {});
        const record = normalizeGpuRecord(records[index], index, normalized);
        if (!validGpuRecord(record)) continue;
        if (!current || current.textureKey !== record.textureKey
            || current.sidecarKey !== record.sidecarKey
            || current.blend !== record.blend
            || current.source !== record.source
            || current.materialSource !== record.materialSource
            || current.emissiveSource !== record.emissiveSource
            || current.occluderSource !== record.occluderSource) {
            current = batches[batchCount];
            if (!current) {
                current = { records: [] };
                batches[batchCount] = current;
            }
            if (current.textureKey !== record.textureKey
                || current.sidecarKey !== record.sidecarKey
                || current.blend !== record.blend) {
                current.key = `${record.textureKey}|${record.sidecarKey}|${record.blend}`;
            }
            current.source = record.source;
            current.materialSource = record.materialSource;
            current.emissiveSource = record.emissiveSource;
            current.occluderSource = record.occluderSource;
            current.textureKey = record.textureKey;
            current.sidecarKey = record.sidecarKey;
            current.blend = record.blend;
            current.records.length = 0;
            current.first = 0;
            current.count = 0;
            current.occlusionFirst = 0;
            current.occlusionCount = 0;
            current.occluderMax = 0;
            batchCount++;
        }
        current.records.push(record);
    }
    batches.length = batchCount;
    normalizedRecords.length = records.length;
    return batches;
}

export function estimateGpuWorldTextureBytes({
    width = 0,
    height = 0,
    bloomScale = 0.5,
    occlusionScale = 0.5,
    cachedTextures = [],
} = {}) {
    const w = Math.max(0, Math.floor(finite(width)));
    const h = Math.max(0, Math.floor(finite(height)));
    const bloomW = Math.max(0, Math.floor(w * Math.max(0, finite(bloomScale, 0.5))));
    const bloomH = Math.max(0, Math.floor(h * Math.max(0, finite(bloomScale, 0.5))));
    const occW = Math.max(0, Math.floor(w * Math.max(0, finite(occlusionScale, 0.5))));
    const occH = Math.max(0, Math.floor(h * Math.max(0, finite(occlusionScale, 0.5))));
    const targets = (w * h + bloomW * bloomH * 2 + occW * occH) * 4;
    let textures = 0;
    for (const texture of cachedTextures || []) {
        const tw = Math.max(0, Math.floor(finite(texture?.width)));
        const th = Math.max(0, Math.floor(finite(texture?.height)));
        const copies = Math.max(1, Math.floor(finite(texture?.copies, 1)));
        textures += tw * th * 4 * copies;
    }
    return { targets, textures, total: targets + textures };
}

// 3.1 — action-needed overlays are outside the exposure budget: the renderer
// asks this before applying the envelope's spill share to a light.
export function isAttentionLight(light) {
    return Boolean(light?.attention) || String(light?.id || '').startsWith('attention:');
}

export function clampGpuLights(lights = [], limit = 16, hardLimit = limit, cache = null) {
    const cap = Math.max(0, Math.floor(finite(limit, 16)));
    const hardCap = Math.max(cap, Math.floor(finite(hardLimit, cap)));
    const source = lights || [];
    const ranked = cache?.ranked || [];
    let unchanged = Boolean(cache && cache.source === source && cache.sourceLength === source.length);
    if (unchanged) {
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            const snapshot = cache.snapshots[index];
            if (!snapshot || snapshot.light !== light
                || snapshot.x !== light?.x || snapshot.y !== light?.y
                || snapshot.priority !== light?.priority || snapshot.intensity !== light?.intensity
                || snapshot.id !== light?.id || snapshot.attention !== light?.attention) {
                unchanged = false;
                break;
            }
        }
    }
    if (!unchanged) {
        ranked.length = 0;
        if (cache) cache.snapshots.length = source.length;
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            if (Number.isFinite(Number(light?.x)) && Number.isFinite(Number(light?.y))) ranked.push(light);
            if (cache) {
                const snapshot = cache.snapshots[index] || (cache.snapshots[index] = {});
                snapshot.light = light;
                snapshot.x = light?.x;
                snapshot.y = light?.y;
                snapshot.priority = light?.priority;
                snapshot.intensity = light?.intensity;
                snapshot.id = light?.id;
                snapshot.attention = light?.attention;
            }
        }
        ranked.sort((a, b) => (
            Number(isAttentionLight(b)) - Number(isAttentionLight(a))
            || finite(b.priority, 0) - finite(a.priority, 0)
            || finite(b.intensity, 1) - finite(a.intensity, 1)
            || String(a.id || '').localeCompare(String(b.id || ''))
        ));
        if (cache) {
            cache.source = source;
            cache.sourceLength = source.length;
        }
    }
    let protectedCount = 0;
    while (protectedCount < ranked.length && isAttentionLight(ranked[protectedCount])) protectedCount++;
    const admittedCount = Math.min(ranked.length, hardCap, Math.max(cap, protectedCount));
    if (!cache) return ranked.slice(0, admittedCount);
    const admitted = cache.admitted;
    admitted.length = admittedCount;
    for (let index = 0; index < admittedCount; index++) admitted[index] = ranked[index];
    return admitted;
}

/**
 * Local point lights are a darkness response, not a second daytime sun. This
 * stays the *admission gate* only: 3.1's source-energy envelope owns how much
 * energy an admitted light, its core, and its bloom may spend, so nothing
 * multiplies this scalar into brightness any more.
 */
export function localLightPhaseForLighting(lighting = {}) {
    const ambient = Math.max(0, Math.min(1, finite(lighting?.ambientLight, 1)));
    const beacon = Math.max(0, Math.min(1, finite(lighting?.beaconIntensity, 0)));
    return Math.max(1 - ambient, beacon);
}
