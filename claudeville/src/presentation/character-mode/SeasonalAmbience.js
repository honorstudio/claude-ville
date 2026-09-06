// claudeville/src/presentation/character-mode/SeasonalAmbience.js
//
// Seasonal ambient particles for World mode. Maps the current month from the
// atmosphere snapshot's local-date string to a season and feeds drift particles
// into the shared ParticleSystem at a capped rate. Reduced-motion: emits a
// deterministic, static set of placeholder particles once and then idles.
//
// Wiring is intentionally minimal so IsometricRenderer can construct and call
// update(dt) with no other coupling:
//   this.seasonalAmbience = new SeasonalAmbience({
//       particleSystem: this.particleSystem,
//       atmosphereStateGetter: () => this._currentAtmosphereSnapshot,
//       motionScaleGetter: () => this.motionScale,
//       viewportProvider: () => ({ x: ..., y: ..., width: ..., height: ... }),
//   });
//   this.seasonalAmbience.update(dt);
//
// `viewportProvider` is optional. When omitted, spawn coordinates fall back to
// (0, 0). Seasonal particles use ParticleSystem's screen layer because the
// supplied (x, y) coordinates are canvas-space pixels.
//
// Particle types per season:
//   winter (Dec–Feb): 'snow'
//   spring (Mar–May): 'leaf'    (proxy for cherry petals; no color override)
//   summer (Jun–Aug): 'firefly'
//   autumn (Sep–Nov): 'leaf'
//
// We pass `type: 'snow'` / `'leaf'` / `'firefly'` directly. ParticleSystem supports
// per-spawn overrides, but the seasonal palettes stay restrained until a
// stronger art direction lands.

const SPAWNS_PER_SECOND = 4;
const STATIC_FALLBACK_COUNT = 14;
const FALLBACK_SCATTER_W = 1280;
const FALLBACK_SCATTER_H = 720;

// Under reduced motion the shared ParticleSystem is muted, so the static
// fallback can't go through spawn(). Each season carries a representative
// color + size pair used by the direct-canvas drawStatic() pass.
const SEASONS = {
    winter: { type: 'snow',    label: 'snow',        staticColor: '#d0eaff', staticSize: 2, token: 'winter' },
    spring: { type: 'leaf',    label: 'cherryPetal', staticColor: '#8fbf58', staticSize: 2, token: 'spring' },
    summer: { type: 'firefly', label: 'firefly',     staticColor: '#fff1a8', staticSize: 2, token: 'summer' },
    autumn: { type: 'leaf',    label: 'leaf',        staticColor: '#b8914b', staticSize: 2, token: 'autumn' },
    // Daytime variant of summer: butterflies by day, fireflies after dark. The
    // base season stays `summer`; _effectiveSeason swaps to this when the
    // atmosphere phase is not night.
    summerDay: { type: 'butterfly', label: 'butterfly', staticColor: '#f4a93c', staticSize: 3, token: 'summer' },
};

// Season token for the current atmosphere, sharing this module's month→season
// mapping so the renderer's seasonal terrain rebake stays in lockstep with the
// drift particles. Returns 'winter' | 'spring' | 'summer' | 'autumn' or '' when
// the atmosphere carries no usable date.
export function seasonTokenForAtmosphere(atmosphere) {
    const season = seasonForMonth(monthFromAtmosphere(atmosphere));
    return season ? season.token : '';
}

// 5.4 — month index (0–11) → season token, exported so AtmosphereState can
// modulate day length off the same month→season mapping (one source of truth
// for sky clock, seasonal terrain, and drift particles). '' when unknown.
export function seasonTokenForMonth(monthIndex) {
    return seasonForMonth(monthIndex)?.token || '';
}

export class SeasonalAmbience {
    constructor({
        particleSystem = null,
        atmosphereStateGetter = null,
        motionScaleGetter = null,
        viewportProvider = null,
        suppressGetter = null,
        anchorsProvider = null,
    } = {}) {
        this.particleSystem = particleSystem;
        this.atmosphereStateGetter = typeof atmosphereStateGetter === 'function'
            ? atmosphereStateGetter
            : () => null;
        this.motionScaleGetter = typeof motionScaleGetter === 'function'
            ? motionScaleGetter
            : () => 1;
        this.viewportProvider = typeof viewportProvider === 'function'
            ? viewportProvider
            : null;
        // #39 — when this returns true (a real git event / gull scatter is on
        // screen), decorative drift spawning is suppressed so the ambient layer
        // yields to the live event.
        this.suppressGetter = typeof suppressGetter === 'function'
            ? suppressGetter
            : () => false;
        // C2 — world-anchored drift. Given a kind ('canopy' | 'flower'), returns
        // screen-space candidate points (tree canopies / flower tiles). Leaves
        // and petals emit from canopies, butterflies from flowers; snow and any
        // type with no visible anchors fall back to viewport-random spawning.
        this.anchorsProvider = typeof anchorsProvider === 'function'
            ? anchorsProvider
            : null;
        this.enabled = true;
        this._spawnAccumulator = 0;
        this._lastSeasonKey = '';
        this._staticFallbackSeeded = false;
        this._staticFallbackSeasonKey = '';
        this._staticFallbackDots = [];
    }

    setEnabled(flag) {
        this.enabled = Boolean(flag);
        if (!this.enabled) {
            this._spawnAccumulator = 0;
            this._staticFallbackSeeded = false;
            this._staticFallbackDots = [];
        }
    }

    update(dt = 16) {
        if (!this.enabled || !this.particleSystem) return;

        const atmosphere = this.atmosphereStateGetter() || null;
        const month = monthFromAtmosphere(atmosphere);
        const baseSeason = seasonForMonth(month);
        if (!baseSeason) return;
        const season = this._effectiveSeason(baseSeason, atmosphere);

        const seasonKey = `${season.type}|${season.label}`;
        if (seasonKey !== this._lastSeasonKey) {
            this._lastSeasonKey = seasonKey;
            this._staticFallbackSeeded = false;
        }

        const motionScale = clamp01(Number(this.motionScaleGetter()) || 0);

        if (motionScale === 0) {
            this._seedStaticFallback(season, seasonKey);
            return;
        }

        // suppressDuringEvents — a live git reward (the celebratory gull
        // scatter) is on screen; hold off decorative spawns and drain the
        // accumulator so nothing bursts when suppression lifts.
        if (this.suppressGetter()) {
            this._spawnAccumulator = 0;
            return;
        }

        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        const seconds = frameDt / 1000;
        this._spawnAccumulator += SPAWNS_PER_SECOND * motionScale * seconds;

        while (this._spawnAccumulator >= 1) {
            this._spawnAccumulator -= 1;
            this._spawnDriftParticle(season);
        }
    }

    // Summer splits by time of day: butterflies while the sun is up,
    // fireflies once it is night. Other seasons pass through unchanged.
    _effectiveSeason(season, atmosphere) {
        if (season !== SEASONS.summer) return season;
        const phase = atmosphere?.phase || atmosphere?.clock?.phase || 'day';
        return phase === 'night' ? SEASONS.summer : SEASONS.summerDay;
    }

    _spawnDriftParticle(season) {
        const anchor = this._sampleAnchor(season.type);
        const { x, y } = anchor || this._sampleViewport();
        this.particleSystem.spawn(season.type, x, y, 1, { layer: 'screen' });
    }

    // Pick a world-anchored spawn point for types that read as coming from the
    // scenery: leaves/petals from tree canopies, butterflies from flower tiles.
    // Returns null (→ viewport-random) for snow/fireflies or when no anchor of
    // the requested kind is currently visible.
    _sampleAnchor(type) {
        if (!this.anchorsProvider) return null;
        let kind = null;
        if (type === 'leaf') kind = 'canopy';
        else if (type === 'butterfly') kind = 'flower';
        else return null;

        let points = null;
        try {
            points = this.anchorsProvider(kind);
        } catch (_err) {
            points = null;
        }
        if (!Array.isArray(points) || points.length === 0) return null;

        const p = points[Math.floor(Math.random() * points.length)];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        return { x: Math.round(p.x), y: Math.round(p.y) };
    }

    // Reduced motion: ParticleSystem.spawn() is gated by motionEnabled and
    // would no-op. Build a deterministic dot list instead and let
    // drawStatic(ctx) render it via direct canvas calls, mirroring the
    // static-smoke fallback pattern in IsometricRenderer.
    _seedStaticFallback(season, seasonKey) {
        if (this._staticFallbackSeeded && this._staticFallbackSeasonKey === seasonKey) return;

        const viewport = this._viewport();
        const width = viewport.width || FALLBACK_SCATTER_W;
        const height = viewport.height || FALLBACK_SCATTER_H;
        const seedBase = hashString(seasonKey);
        const dots = [];

        for (let i = 0; i < STATIC_FALLBACK_COUNT; i++) {
            const u = random01(seedBase, i * 2 + 1);
            const v = random01(seedBase, i * 2 + 2);
            dots.push({
                x: viewport.x + Math.round(u * width),
                y: viewport.y + Math.round(v * height),
                color: season.staticColor || '#fff1a8',
                size: season.staticSize || 2,
            });
        }

        this._staticFallbackDots = dots;
        this._staticFallbackSeeded = true;
        this._staticFallbackSeasonKey = seasonKey;
    }

    drawStatic(ctx) {
        if (!this.enabled) return;
        const motionScale = clamp01(Number(this.motionScaleGetter()) || 0);
        if (motionScale > 0) return;
        if (!this._staticFallbackDots.length) return;
        ctx.save();
        ctx.globalAlpha = 0.72;
        for (const dot of this._staticFallbackDots) {
            ctx.fillStyle = dot.color;
            ctx.fillRect(dot.x - dot.size / 2, dot.y - dot.size / 2, dot.size, dot.size);
        }
        ctx.restore();
    }

    _sampleViewport() {
        const viewport = this._viewport();
        const u = Math.random();
        const v = Math.random();
        return {
            x: viewport.x + Math.round(u * viewport.width),
            y: viewport.y + Math.round(v * viewport.height),
        };
    }

    _viewport() {
        if (this.viewportProvider) {
            const v = this.viewportProvider();
            if (v && Number.isFinite(v.width) && Number.isFinite(v.height)) {
                return {
                    x: Number.isFinite(v.x) ? v.x : 0,
                    y: Number.isFinite(v.y) ? v.y : 0,
                    width: Math.max(0, v.width),
                    height: Math.max(0, v.height),
                };
            }
        }
        return { x: 0, y: 0, width: FALLBACK_SCATTER_W, height: FALLBACK_SCATTER_H };
    }
}

function monthFromAtmosphere(atmosphere) {
    if (!atmosphere) return null;
    const clock = atmosphere.clock || null;
    const date = clock?.date;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return date.getMonth();
    }
    const localDate = clock?.localDate || atmosphere?.effectiveDate;
    if (typeof localDate === 'string') {
        const parts = localDate.split('-');
        if (parts.length >= 2) {
            const m = Number(parts[1]);
            if (Number.isFinite(m) && m >= 1 && m <= 12) return m - 1;
        }
    }
    if (atmosphere.effectiveDate instanceof Date && !Number.isNaN(atmosphere.effectiveDate.getTime())) {
        return atmosphere.effectiveDate.getMonth();
    }
    return null;
}

function seasonForMonth(monthIndex) {
    if (monthIndex === null || monthIndex === undefined) return null;
    if (monthIndex === 11 || monthIndex === 0 || monthIndex === 1) return SEASONS.winter;
    if (monthIndex >= 2 && monthIndex <= 4) return SEASONS.spring;
    if (monthIndex >= 5 && monthIndex <= 7) return SEASONS.summer;
    if (monthIndex >= 8 && monthIndex <= 10) return SEASONS.autumn;
    return null;
}

function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function random01(seed, salt) {
    let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}
