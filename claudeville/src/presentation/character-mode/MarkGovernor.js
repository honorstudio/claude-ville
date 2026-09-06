export const MarkTier = Object.freeze({ PRIMARY: 'primary', RECENT: 'recent', WORKING: 'working', SECONDARY: 'working', AMBIENT: 'ambient' });
export const SALIENCE_ORDER = Object.freeze([MarkTier.PRIMARY, MarkTier.RECENT, MarkTier.WORKING, MarkTier.AMBIENT]);
const POLICY = Object.freeze({ primary: { alphaCap: 1, soft: Infinity, hard: Infinity }, recent: { alphaCap: .92, soft: 4, hard: 8 }, working: { alphaCap: .78, soft: 3, hard: 7 }, ambient: { alphaCap: .5, soft: 2, hard: 5 } });
const DEFAULT_REGION_SIZE = 200;

export const PRESSURE_LEVELS = Object.freeze({
    FULL: 0,
    WEATHER_FAUNA: 1,
    PARTICLES: 2,
    GLYPHS: 3,
});

export const PRESSURE_SHED_ORDER = Object.freeze([
    'ambient-weather-embellishment',
    'fauna-cadence',
    'ambient-particles',
    'secondary-glyphs-glows',
]);

export const PRESSURE_PROTECTED = Object.freeze([
    'primary-marks',
    'attention-lights',
    'selected-state',
    'provider-identity',
    'primary-route',
    'canvas-fallback',
]);

export const FRAME_PRESSURE_OPTIONS = Object.freeze({
    budgetMs: 8,
    healthyMs: 5,
    overBudgetFrames: 12,
    probeMs: 1500,
    dwellMs: 192,
});

const TIGHT_SECONDARY_POLICY = Object.freeze({
    recent: Object.freeze({ alphaCap: .92, soft: 2, hard: 4 }),
    working: Object.freeze({ alphaCap: .78, soft: 1, hard: 3 }),
    ambient: Object.freeze({ alphaCap: 0, soft: 0, hard: 0 }),
});

let calmSceneHints = { weatherType: null, attention: false, recentEvent: false };
let sharedPressure = null;
let lastSampleQuant = NaN;
let lastSnapshot = null;

export function salienceTierFor({ selected = false, status = '', recent = false, working = false } = {}) {
    if (selected || ['waiting_on_user', 'errored', 'rate_limited'].includes(status)) return MarkTier.PRIMARY;
    if (recent) return MarkTier.RECENT;
    if (working || status === 'working' || status === 'waiting') return MarkTier.WORKING;
    return MarkTier.AMBIENT;
}

export function calculateScenePressure({ sprites = [], viewport = {}, zoom = 1, overlayArea = 0, collisions = 0 } = {}) {
    const area = Math.max(1, Number(viewport.width) * Number(viewport.height) || 1);
    const z = Math.max(1, Number(zoom) || 1);
    let spriteArea = 0;
    for (const sprite of sprites || []) {
        if (!sprite || sprite.isArrivalPending?.()) continue;
        spriteArea += (Number(sprite.projectedWidth) || 34 * z) * (Number(sprite.projectedHeight) || 54 * z);
    }
    const occupancy = Math.min(1.5, spriteArea / area);
    const overlays = Math.min(1.5, Math.max(0, Number(overlayArea) || 0) / area);
    const collisionLoad = Math.min(1, Math.max(0, Number(collisions) || 0) / Math.max(1, sprites.length));
    const populationLoad = Math.min(1, sprites.length / Math.max(12, area / 42000));
    return Math.max(0, Math.min(1, occupancy * .34 + overlays * .2 + collisionLoad * .16 + populationLoad * .3));
}

export function annotationModeForPressure(pressure, previous = 'full') {
    const p = Math.max(0, Math.min(1, Number(pressure) || 0));
    if (previous === 'minimal' && p >= .66) return 'minimal';
    if (previous === 'compact' && p >= .37 && p < .78) return 'compact';
    return p >= .72 ? 'minimal' : p >= .42 ? 'compact' : 'full';
}

export function markPolicyFor(tier, level = 0) {
    const key = POLICY[tier] ? tier : MarkTier.AMBIENT;
    if (key === MarkTier.PRIMARY) return POLICY.primary;
    if (clampLevel(level) < PRESSURE_LEVELS.GLYPHS) return POLICY[key];
    return TIGHT_SECONDARY_POLICY[key] || POLICY[key];
}

export function shedSetForLevel(level = 0) {
    const rung = clampLevel(level);
    if (rung <= 0) return [];
    return PRESSURE_SHED_ORDER.slice(0, rung + 1);
}

export function ornamentPlan({
    level = 0,
    motionScale = 1,
    calm = false,
} = {}) {
    const reduced = Number(motionScale) <= 0;
    const shed = new Set(shedSetForLevel(level));
    const motionState = (on, off = 'off') => {
        if (reduced) return on ? 'static' : 'off';
        return on ? 'on' : off;
    };
    return {
        ambientWeatherEmbellishment: motionState(!shed.has('ambient-weather-embellishment')),
        faunaCadence: reduced
            ? 'static'
            : (shed.has('fauna-cadence') ? 'off' : 'on'),
        ambientParticles: reduced
            ? 'static'
            : (shed.has('ambient-particles') ? 'off' : (calm ? 'quiet' : 'on')),
        secondaryGlyphsGlows: motionState(!shed.has('secondary-glyphs-glows')),
        primaryMarks: reduced ? 'static' : 'on',
        selectedState: reduced ? 'static' : 'on',
        providerIdentity: 'on',
        primaryRoute: 'on',
        canvasFallback: 'on',
        weather: reduced ? 'static' : 'on',
        attentionCues: reduced ? 'static' : 'on',
        eventCues: reduced ? 'static' : 'on',
        ambientMeteors: reduced || calm ? 'off' : 'on',
        liveTwinkle: reduced ? 'off' : (calm ? 'sparse' : 'on'),
        ambientSparkle: reduced || calm || shed.has('ambient-particles') ? 'off' : 'on',
        staticStars: 'on',
        lanterns: 'on',
        completionRewards: reduced ? 'static' : 'on',
    };
}

export function appOwnedCostMs(inputs = {}) {
    const update = finiteOrNull(inputs.appUpdateP95);
    const render = finiteOrNull(inputs.appRenderP95);
    const upload = finiteOrNull(inputs.uploadP95);
    const gpu = finiteOrNull(inputs.gpuMs);
    const rendererCost = finiteOrNull(inputs.rendererCostMs);
    let cost = 0;
    let attributed = false;
    if (update !== null || render !== null) {
        cost += (update || 0) + (render || 0);
        attributed = true;
    } else if (rendererCost !== null) {
        cost += rendererCost;
        attributed = true;
    }
    if (upload !== null) {
        cost += upload;
        attributed = true;
    }
    if (gpu !== null) {
        cost += gpu;
        attributed = true;
    }
    if (!attributed) return 0;
    return cost;
}

export function createFramePressureState(options = {}) {
    return normalizePressureState({}, options);
}

export function advanceFramePressure(state = {}, inputs = {}, nowMs = 0, options = {}) {
    const current = normalizePressureState(state, options);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
    const cost = appOwnedCostMs(inputs);
    const config = current.options;
    const snapshotFields = {
        appUpdateP95: finiteOrNull(inputs.appUpdateP95),
        appRenderP95: finiteOrNull(inputs.appRenderP95),
        uploadP95: finiteOrNull(inputs.uploadP95),
        gpuMs: finiteOrNull(inputs.gpuMs),
        hostGapP95: finiteOrNull(inputs.hostGapP95),
        lastNowMs: now,
        lastCostMs: cost,
    };

    let level = current.level;
    let overBudgetFrames = current.overBudgetFrames;
    let healthySinceMs = current.healthySinceMs;
    let enteredAtMs = current.enteredAtMs;
    const dwellReady = now - enteredAtMs >= config.dwellMs;

    if (cost > config.budgetMs) {
        overBudgetFrames += 1;
        healthySinceMs = null;
        if (dwellReady && overBudgetFrames >= config.overBudgetFrames && level < PRESSURE_LEVELS.GLYPHS) {
            level += 1;
            overBudgetFrames = 0;
            enteredAtMs = now;
        }
    } else {
        overBudgetFrames = 0;
        if (cost < config.healthyMs && level > PRESSURE_LEVELS.FULL) {
            if (healthySinceMs === null) healthySinceMs = now;
            if (dwellReady && now - healthySinceMs >= config.probeMs) {
                level -= 1;
                healthySinceMs = now;
                enteredAtMs = now;
            }
        } else {
            healthySinceMs = null;
        }
    }

    return {
        ...current,
        ...snapshotFields,
        level,
        overBudgetFrames,
        healthySinceMs,
        enteredAtMs,
    };
}

export function framePressureSnapshot(state = {}, inputs = {}) {
    const current = normalizePressureState(state);
    const src = { ...current, ...inputs };
    return {
        appUpdateP95: finiteOrNull(src.appUpdateP95),
        appRenderP95: finiteOrNull(src.appRenderP95),
        uploadP95: finiteOrNull(src.uploadP95),
        gpuMs: finiteOrNull(src.gpuMs),
        hostGapP95: finiteOrNull(src.hostGapP95),
        level: current.level,
        dwellMs: Math.max(0, (Number(current.lastNowMs) || 0) - (Number(current.enteredAtMs) || 0)),
    };
}

export function sampleFramePressure(nowMs, inputs) {
    ensureSharedPressure();
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : defaultNow();
    const resolvedInputs = inputs && typeof inputs === 'object'
        ? inputs
        : readFrameHealthInputs();
    const quant = Math.floor(now / 8);
    if (Number.isFinite(lastSampleQuant) && quant === lastSampleQuant && inputs == null) {
        return lastSnapshot;
    }
    lastSampleQuant = quant;
    sharedPressure = advanceFramePressure(sharedPressure, resolvedInputs, now);
    lastSnapshot = framePressureSnapshot(sharedPressure, resolvedInputs);
    return lastSnapshot;
}

export function getFramePressureSnapshot() {
    ensureSharedPressure();
    return lastSnapshot;
}

export function resetFramePressureState(options = {}) {
    sharedPressure = createFramePressureState(options);
    lastSampleQuant = NaN;
    lastSnapshot = framePressureSnapshot(sharedPressure);
    calmSceneHints = { weatherType: null, attention: false, recentEvent: false };
    return lastSnapshot;
}

export function setCalmSceneHints(hints = {}) {
    calmSceneHints = {
        weatherType: hints.weatherType ?? calmSceneHints.weatherType,
        attention: Boolean(hints.attention),
        recentEvent: Boolean(hints.recentEvent),
    };
    return getCalmSceneHints();
}

export function getCalmSceneHints() {
    return { ...calmSceneHints };
}

export function readCalmGateOverride(globalRef = typeof globalThis !== 'undefined' ? globalThis : null) {
    const root = globalRef?.window && globalRef.window.__claudeVillePerf
        ? globalRef.window
        : globalRef;
    const perfValue = root?.__claudeVillePerf?.calmGate
        ?? root?.window?.__claudeVillePerf?.calmGate;
    if (perfValue === 'full' || perfValue === 'quiet') return perfValue;
    const search = root?.location?.search
        ?? root?.window?.location?.search
        ?? '';
    if (typeof search === 'string' && search) {
        try {
            const value = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('calmGate');
            if (value === 'full' || value === 'quiet') return value;
        } catch { /* visual-QA override only */ }
    }
    return null;
}

export function resolveCalmGate(context = {}) {
    const override = Object.prototype.hasOwnProperty.call(context, 'override')
        ? context.override
        : readCalmGateOverride();
    if (override === 'full') return false;
    if (override === 'quiet') return true;
    const weatherType = context.weatherType ?? calmSceneHints.weatherType;
    if (weatherType !== 'clear') return false;
    const attention = context.attention ?? calmSceneHints.attention;
    const recentEvent = context.recentEvent ?? calmSceneHints.recentEvent;
    return !attention && !recentEvent;
}

export class MarkGovernor {
    constructor() {
        this.regionSize = DEFAULT_REGION_SIZE;
        this.motionScale = 1;
        this.pressureLevel = 0;
        this._regions = new Map();
        this._occupied = [];
        this._primaryRegions = new Set();
        this._frame = 0;
    }
    beginFrame({
        regionSize = DEFAULT_REGION_SIZE,
        motionScale = 1,
        pressureLevel = null,
    } = {}) {
        this.regionSize = regionSize > 0 ? regionSize : DEFAULT_REGION_SIZE;
        this.motionScale = motionScale;
        this.pressureLevel = Number.isFinite(Number(pressureLevel))
            ? clampLevel(pressureLevel)
            : sampleFramePressure().level;
        this._regions.clear();
        this._occupied.length = 0;
        this._primaryRegions.clear();
        this._frame++;
    }
    _key(x, y) { return `${Math.floor((Number(x) || 0) / this.regionSize)},${Math.floor((Number(y) || 0) / this.regionSize)}`; }
    _region(x, y) { const key = this._key(x, y); let region = this._regions.get(key); if (!region) this._regions.set(key, region = { recent: 0, working: 0, ambient: 0 }); return { key, region }; }
    reserve(rect, tier = MarkTier.AMBIENT, stableKey = '') {
        if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
        const candidate = { ...rect, tier, stableKey: String(stableKey) };
        if (tier !== MarkTier.PRIMARY && this._occupied.some(item => item.tier === MarkTier.PRIMARY && overlaps(candidate, item))) return false;
        this._occupied.push(candidate);
        if (tier === MarkTier.PRIMARY) this._primaryRegions.add(this._key(rect.x + rect.w / 2, rect.y + rect.h / 2));
        return true;
    }
    admit(tier, x = 0, y = 0, { rect = null, stableKey = '' } = {}) {
        tier = POLICY[tier] ? tier : MarkTier.AMBIENT;
        if (rect && !this.reserve(rect, tier, stableKey)) return { draw: false, alpha: 0 };
        if (tier === MarkTier.PRIMARY) return { draw: true, alpha: 1 };
        const policy = markPolicyFor(tier, this.pressureLevel);
        if (policy.hard === 0) return { draw: false, alpha: 0 };
        if (this.motionScale <= 0) return { draw: true, alpha: policy.alphaCap };
        const { key, region } = this._region(x, y); const index = region[tier]++;
        if (index >= policy.hard) return { draw: false, alpha: 0 };
        let alpha = policy.alphaCap;
        if (index >= policy.soft) alpha *= Math.max(0, 1 - (index - policy.soft) / Math.max(1, policy.hard - policy.soft));
        if (this._primaryRegions.has(key)) alpha *= tier === MarkTier.AMBIENT ? .28 : .72;
        return { draw: alpha > .01, alpha };
    }
    alphaFor(tier, x = 0, y = 0) { const result = this.admit(tier, x, y); return result.draw ? result.alpha : 0; }
}
function overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
let activeGovernor = null;
export function setActiveMarkGovernor(governor) { activeGovernor = governor || null; }
export function getActiveMarkGovernor() { return activeGovernor; }

function clampLevel(value) {
    const level = Math.round(Number(value) || 0);
    if (!Number.isFinite(level)) return 0;
    return Math.max(0, Math.min(3, level));
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function normalizePressureState(state = {}, options = {}) {
    const config = { ...FRAME_PRESSURE_OPTIONS, ...(state.options || {}), ...options };
    return {
        level: clampLevel(state.level),
        overBudgetFrames: Math.max(0, Math.floor(Number(state.overBudgetFrames) || 0)),
        healthySinceMs: state.healthySinceMs === null || state.healthySinceMs === undefined
            ? null
            : (Number.isFinite(Number(state.healthySinceMs)) ? Number(state.healthySinceMs) : null),
        enteredAtMs: Number.isFinite(Number(state.enteredAtMs)) ? Number(state.enteredAtMs) : 0,
        lastNowMs: Number.isFinite(Number(state.lastNowMs)) ? Number(state.lastNowMs) : 0,
        lastCostMs: Number.isFinite(Number(state.lastCostMs)) ? Number(state.lastCostMs) : 0,
        appUpdateP95: finiteOrNull(state.appUpdateP95),
        appRenderP95: finiteOrNull(state.appRenderP95),
        uploadP95: finiteOrNull(state.uploadP95),
        gpuMs: finiteOrNull(state.gpuMs),
        hostGapP95: finiteOrNull(state.hostGapP95),
        options: {
            budgetMs: finiteOr(config.budgetMs, FRAME_PRESSURE_OPTIONS.budgetMs),
            healthyMs: finiteOr(config.healthyMs, FRAME_PRESSURE_OPTIONS.healthyMs),
            overBudgetFrames: Math.max(1, Math.floor(finiteOr(config.overBudgetFrames, FRAME_PRESSURE_OPTIONS.overBudgetFrames))),
            probeMs: Math.max(0, finiteOr(config.probeMs, FRAME_PRESSURE_OPTIONS.probeMs)),
            dwellMs: Math.max(0, finiteOr(config.dwellMs, FRAME_PRESSURE_OPTIONS.dwellMs)),
        },
    };
}

function readFrameHealthInputs() {
    try {
        const root = typeof globalThis !== 'undefined'
            ? (globalThis.window || globalThis)
            : null;
        const health = typeof root?.__claudeVillePerf?.frameHealth === 'function'
            ? root.__claudeVillePerf.frameHealth()
            : null;
        if (!health || typeof health !== 'object') return {};
        return {
            appUpdateP95: health.p95AppUpdateMs ?? health.appUpdateP95,
            appRenderP95: health.p95AppRenderMs ?? health.appRenderP95,
            uploadP95: health.p95UploadMs ?? health.uploadP95,
            gpuMs: health.gpuMs,
            hostGapP95: health.p95HostGapMs ?? health.hostGapP95,
            rendererCostMs: health.attribution?.rendererCostMs,
        };
    } catch {
        return {};
    }
}

function ensureSharedPressure() {
    if (sharedPressure) return;
    resetFramePressureState();
}
