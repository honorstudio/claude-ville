// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

import { AtmosphereState } from './AtmosphereState.js';
import { canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
import { mapWorldCorners } from './Projection.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    ornamentPlan,
    resolveCalmGate,
    setCalmSceneHints,
} from './MarkGovernor.js';

// 5.2 — star density scales with viewport area: 90 stars was tuned for a
// 1280×720 sky and read sparse/dead at 1440p+. The baked starfield and the
// live twinkle walk the same deterministic PRNG sequence, so both derive the
// count from the canvas via starCountForCanvas() below.
const STAR_BASE_COUNT = 90;
const STAR_BASE_AREA = 1280 * 720;
const STAR_MIN_COUNT = 90;
const STAR_MAX_COUNT = 320;
const STAR_CEILING_FRAC = 0.60;
// Live twinkle: this many hot stars are redrawn per frame over the cached
// (static) night sky with staggered sinusoidal alpha. Positions come from the
// same deterministic PRNG walk as _drawStars, so they land on baked hot stars.
const LIVE_TWINKLE_STARS = 12;
// 5.2 — rare ambient meteors on clear nights (no event needed): one every
// ~90–180s while the sky is clear enough to read as a starfield.
const AMBIENT_METEOR_MIN_MS = 90000;
const AMBIENT_METEOR_SPAN_MS = 90000;
const AMBIENT_METEOR_MIN_STARS_ALPHA = 0.45;
const AMBIENT_METEOR_MAX_CLOUD_COVER = 0.35;
// 0.6 — optional whole-village warm grade pulse on push: one cheap
// full-screen gradient wash for 2s, drawn unclipped after the canopy pass.
const PUSH_GRADE_DURATION_MS = 2000;
const PUSH_GRADE_FADE_IN_MS = 320;
const PUSH_GRADE_HOLD_MS = 680;
const PUSH_GRADE_COOLDOWN_MS = 45000;
const FALLBACK_CLOUD_IDS = ['atmosphere.cloud.cumulus', 'atmosphere.cloud.wisp'];
const FALLBACK_MOON_ID = 'atmosphere.moon.crescent';
// 5.3 — manifest hook for a generated pixel-art sun. When `atmosphere.sun`
// lands in manifest.yaml it renders as-is; until then _getSunStamp() bakes a
// quantized stepped-disc fallback (pixel doctrine: no soft gradient orb).
const FALLBACK_SUN_ID = 'atmosphere.sun';
const SUN_STAMP_CELL_PX = 2;
const MOON_PHASE_ASSETS = {
    crescent: 'atmosphere.moon.crescent.cool',
    half: 'atmosphere.moon.half.cool',
    gibbous: 'atmosphere.moon.gibbous.cool',
};
const CLOUD_DRIFT_PX_PER_MS = 0.0012;
const CANOPY_HEIGHT_FRAC = 0.52;
const CANOPY_MIN_HEIGHT = 240;
const CANOPY_MAX_HEIGHT = 520;
const AURORA_DURATION_MS = 12000;
const AURORA_FADE_IN_MS = 2000;
const AURORA_HOLD_MS = 6000;
const AURORA_COOLDOWN_MS = 5 * 60 * 1000;
const SUN_MAP_CLEARANCE_RADIUS = 2.15;
const SUN_MIN_SCREEN_RADIUS = 3.0;
const SHOOTING_STAR_DURATION_MS = 1200;
// Slow sky layers (stars, sun, moon, godrays, clouds) are composed into one
// cached frame and refreshed at this cadence instead of repainting several
// full-screen gradients every animation frame. Cloud drift is ~0.0012 px/ms,
// so a refresh moves clouds well under a pixel — invisible at 5 Hz.
const SKY_FRAME_REFRESH_MS = 200;
const FAST_SKY_CSS_PIXELS = 800_000;
const FAST_SKY_FRAME_REFRESH_MS = 1000;
const FAST_SKY_CAMERA_QUANT_PX = 64;
const SHOOTING_STAR_MAX = 3;
const SHOOTING_STAR_COOLDOWN_MS = 4000;
const SHOOTING_STAR_NIGHT_PHASES = new Set(['night', 'dusk']);
// Daytime counterparts of the night-only aurora / shooting-star rewards so
// push & subagent hero moments stay visible in daytime sessions (most of them).
const DAY_REWARD_PHASES = new Set(['day', 'dawn', 'dusk']);
const SKY_FLARE_DURATION_MS = 4200;
const SKY_FLARE_FADE_IN_MS = 700;
const SKY_FLARE_HOLD_MS = 1600;
const SKY_FLARE_COOLDOWN_MS = 5 * 60 * 1000;
const SUN_GLINT_DURATION_MS = 1500;
const SUN_GLINT_COOLDOWN_MS = 4000;
const SUN_GLINT_MAX = 3;
// Below this cloud cover the sky is clear enough for god-rays / daytime
// rewards to break through; above it the overcast plate swallows them.
const DAY_REWARD_CLOUD_COVER_MAX = 0.74;

const CONSTELLATIONS = [
    {
        anchor: [0.15, 0.20],
        points: [[0, 0], [0.035, -0.030], [0.072, -0.018], [0.104, -0.055], [0.137, -0.024]],
    },
    {
        anchor: [0.53, 0.16],
        points: [[0, 0], [0.028, 0.026], [0.057, 0.006], [0.090, 0.034], [0.119, 0.016]],
    },
    {
        anchor: [0.74, 0.29],
        points: [[0, 0], [0.026, -0.034], [0.052, -0.003], [0.079, -0.034]],
    },
    {
        anchor: [0.33, 0.38],
        points: [[0, 0], [0.024, -0.024], [0.054, -0.016], [0.081, -0.045], [0.112, -0.038]],
    },
];

const CLOUD_LAYER_DEFAULTS = [
    { fy: 0.20, parallax: 0.03, driftMul: 0.55, alphaMul: 0.72 },
    { fy: 0.30, parallax: 0.07, driftMul: 0.92, alphaMul: 0.46 },
    { fy: 0.40, parallax: 0.11, driftMul: 1.20, alphaMul: 0.32 },
];
const LIVE_TWINKLE_STARS_CALM = 3;
const LIVE_TWINKLE_RATE_SCALE_CALM = 0.28;

export function liveTwinkleBudget({ calm = false, motionScale = 1 } = {}) {
    const plan = ornamentPlan({ calm, motionScale, level: 0 });
    if (plan.liveTwinkle === 'off') return { count: 0, rateScale: 0 };
    if (plan.liveTwinkle === 'sparse') {
        return { count: LIVE_TWINKLE_STARS_CALM, rateScale: LIVE_TWINKLE_RATE_SCALE_CALM };
    }
    return { count: LIVE_TWINKLE_STARS, rateScale: 1 };
}

export function allowAmbientMeteor({ calm = false, motionScale = 1 } = {}) {
    return ornamentPlan({ calm, motionScale, level: 0 }).ambientMeteors === 'on';
}

// Weather plate is a vertical, canvas-wide sky condition. Spatial ground
// haze lives in WorldFrameRenderer (ground-atmosphere stage).
export const SKY_WEATHER_PLATE_SPACE = 'vertical-canvas';

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._frameCache = null;
        this._frameCacheKey = '';
        this._decorativeCloudOffset = 0;
        this._fallbackAtmosphere = null;
        this._auroraStartedAt = 0;
        this._lastAuroraTriggerAt = 0;
        this._lastShootingStarAt = 0;
        this._shootingStars = [];
        this._skyFlareStartedAt = 0;
        this._lastSkyFlareAt = 0;
        this._lastSunGlintAt = 0;
        this._sunGlints = [];
        this._pushGradeStartedAt = 0;
        this._lastPushGradeAt = 0;
        this._nextAmbientMeteorAt = 0;
        this._sunStamp = null;
        this._currentPhase = null;
        this._currentCloudCover = 0;
        this._currentMotionScale = 1;
        this._unsubscribers = [];
        this.attach();
    }

    // Subscriptions live on attach/detach so the renderer can survive mode
    // toggles: IsometricRenderer.hide() calls detach() and show() re-attaches.
    attach() {
        if (this._unsubscribers.length) this.detach();
        if (!eventBus || typeof eventBus.on !== 'function') return;
        const onPush = () => {
            // Night → aurora; daytime → golden sky-flare. One reward fires.
            if (!this.maybeTriggerAuroraForPushSuccess(this._currentPhase)) {
                this.maybeTriggerSkyFlareForPushSuccess(this._currentPhase);
            }
            // 0.6 — whole-village warm grade pulse: cheap, cooldown-gated, and
            // fires even when cloud cover blocks the sky-flare.
            const now = Date.now();
            if (now - this._lastPushGradeAt >= PUSH_GRADE_COOLDOWN_MS) {
                this._pushGradeStartedAt = now;
                this._lastPushGradeAt = now;
            }
        };
        this._unsubscribers.push(eventBus.on('git:pushed', onPush));
        this._unsubscribers.push(eventBus.on('harbor:push-success', onPush));
        this._unsubscribers.push(eventBus.on('subagent:completed', () => {
            const now = Date.now();
            // Night → shooting star; daytime → a sun-ray glint near the sun.
            if (SHOOTING_STAR_NIGHT_PHASES.has(this._currentPhase)) {
                if (now - this._lastShootingStarAt < SHOOTING_STAR_COOLDOWN_MS) return;
                const angle = Math.PI / 3 + Math.random() * (Math.PI / 6);
                const length = 0.14 + Math.random() * 0.08;
                if (this.triggerShootingStar({ angle, length })) {
                    this._lastShootingStarAt = now;
                }
                return;
            }
            if (now - this._lastSunGlintAt < SUN_GLINT_COOLDOWN_MS) return;
            if (this.triggerSunGlint()) this._lastSunGlintAt = now;
        }));
    }

    detach() {
        for (const unsubscribe of this._unsubscribers) {
            try { unsubscribe?.(); } catch { /* ignore */ }
        }
        this._unsubscribers.length = 0;
    }

    draw(ctx, arg1 = {}, arg2 = null, arg3 = 16, arg4 = 1) {
        const { canvas, camera, dt, atmosphere, motionScale } = this._normalizeDrawArgs(arg1, arg2, arg3, arg4);
        if (!canvas) return;
        const snapshot = atmosphere || this._getFallbackAtmosphere(motionScale);
        this._currentPhase = snapshot.phase || null;
        this._currentMotionScale = motionScale;
        this._currentCloudCover = clamp(snapshot.weather?.cloudCover ?? 0, 0, 1);
        if (snapshot.motion?.driftEnabled) {
            this._decorativeCloudOffset = (this._decorativeCloudOffset + dt * CLOUD_DRIFT_PX_PER_MS) % Math.max(1, canvas.width);
        }

        const frame = this._getComposedSkyFrame(canvas, camera, snapshot);
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        // Transient layers stay live: the star twinkle and fog animate per
        // frame. 0.6 — the hero rewards (aurora, shooting stars, sky-flare,
        // sun glints, push grade) ride the canopy pass (drawCanopy) so they
        // draw over terrain instead of behind the village.
        this._publishCalmSceneHints(snapshot);
        this._drawLiveStarTwinkle(ctx, canvas, snapshot, motionScale);
        this._drawBackgroundWeather(ctx, canvas, snapshot);
        this._maybeTriggerAmbientMeteor(snapshot);
    }

    _publishCalmSceneHints(atmosphere) {
        const districts = atmosphere?.eventInfluence?.districts;
        const attention = Boolean(atmosphere?.attention)
            || Number(atmosphere?.eventInfluence?.storminess) > 0
            || (Array.isArray(districts) && districts.some(entry => Number(entry?.storminess) > 0));
        const recentEvent = Boolean(
            this._auroraStartedAt
            || this._shootingStars.length
            || this._skyFlareStartedAt
            || this._sunGlints.length
            || this._pushGradeStartedAt,
        );
        setCalmSceneHints({
            weatherType: atmosphere?.weather?.type || null,
            attention,
            recentEvent,
        });
    }

    // Compose background + slow layers into one offscreen frame. Refreshes on
    // atmosphere phase change, viewport resize, camera movement (sun clamp and
    // cloud parallax read the camera), or every SKY_FRAME_REFRESH_MS.
    _getComposedSkyFrame(canvas, camera, atmosphere) {
        const dpr = this._skyCacheDpr(canvas);
        const fast = this._useFastSkyCache(canvas);
        const cameraQuant = fast ? FAST_SKY_CAMERA_QUANT_PX : 4;
        const refreshMs = fast ? FAST_SKY_FRAME_REFRESH_MS : SKY_FRAME_REFRESH_MS;
        const quantX = Math.round((camera?.x || 0) / cameraQuant);
        const quantY = Math.round((camera?.y || 0) / cameraQuant);
        const zoom = camera?.zoom || 1;
        const timeBucket = Math.floor(performance.now() / refreshMs);
        const key = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere.cacheKey}|${quantX},${quantY},${zoom}|${timeBucket}`;
        if (this._frameCache && this._frameCacheKey === key) return this._frameCache;

        const width = Math.max(1, Math.round(canvas.width * dpr));
        const height = Math.max(1, Math.round(canvas.height * dpr));
        let frame = this._frameCache;
        if (!frame || frame.width !== width || frame.height !== height) {
            releaseCanvasBackingStore(frame);
            frame = document.createElement('canvas');
            frame.width = width;
            frame.height = height;
            this._frameCache = frame;
        }
        const fctx = frame.getContext('2d');
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fctx.globalAlpha = 1;
        fctx.globalCompositeOperation = 'source-over';
        fctx.drawImage(this._getCachedBackground(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        this._drawStars(fctx, canvas, atmosphere);
        this._drawSun(fctx, camera, canvas, atmosphere);
        this._drawMoon(fctx, canvas, atmosphere);
        this._drawGodrays(fctx, camera, canvas, atmosphere);
        this._drawClouds(fctx, camera, canvas, atmosphere);
        this._frameCacheKey = key;
        return frame;
    }

    triggerAurora(now = Date.now()) {
        this._auroraStartedAt = now;
        this._lastAuroraTriggerAt = now;
    }

    maybeTriggerAuroraForPushSuccess(phase = this._currentPhase) {
        if (phase !== 'night') return false;
        const now = Date.now();
        if (now - this._lastAuroraTriggerAt < AURORA_COOLDOWN_MS) return false;
        this.triggerAurora(now);
        return true;
    }

    // Reduced motion is honored at draw time (a fixed-pose streak on a 3-step
    // envelope) so RM sessions still see the subagent/ambient cue.
    triggerShootingStar({ angle = null, length = null } = {}) {
        if (!SHOOTING_STAR_NIGHT_PHASES.has(this._currentPhase)) return false;
        if (this._shootingStars.length >= SHOOTING_STAR_MAX) return false;
        const resolvedAngle = Number.isFinite(angle)
            ? angle
            : Math.PI / 3 + Math.random() * (Math.PI / 6);
        const resolvedLength = Number.isFinite(length) ? length : 0.18;
        const startXFrac = 0.05 + Math.random() * 0.75;
        const startYFrac = Math.random() * (STAR_CEILING_FRAC * 0.7);
        this._shootingStars.push({
            angle: resolvedAngle,
            lengthFrac: resolvedLength,
            startXFrac,
            startYFrac,
            elapsed: 0,
        });
        return true;
    }

    triggerSkyFlare(now = Date.now()) {
        this._skyFlareStartedAt = now;
        this._lastSkyFlareAt = now;
    }

    // Daytime counterpart of the aurora: a brief golden flare washes the sky
    // on push success. Blocked under heavy cloud cover (no break-through).
    maybeTriggerSkyFlareForPushSuccess(phase = this._currentPhase) {
        if (!DAY_REWARD_PHASES.has(phase)) return false;
        if (this._currentCloudCover > DAY_REWARD_CLOUD_COVER_MAX) return false;
        const now = Date.now();
        if (now - this._lastSkyFlareAt < SKY_FLARE_COOLDOWN_MS) return false;
        this.triggerSkyFlare(now);
        return true;
    }

    // Daytime counterpart of the shooting star: a quick ray glint flares out
    // from the sun on subagent completion.
    triggerSunGlint() {
        if (!DAY_REWARD_PHASES.has(this._currentPhase)) return false;
        if (this._currentCloudCover > DAY_REWARD_CLOUD_COVER_MAX) return false;
        if (this._sunGlints.length >= SUN_GLINT_MAX) return false;
        this._sunGlints.push({ elapsed: 0, twist: (Math.random() - 0.5) * 0.5 });
        return true;
    }

    drawCanopy(ctx, { canvas, camera = null, dt = 16, atmosphere = null, motionScale = null } = {}) {
        if (!canvas) return;
        // motionScale arrives from the frame renderer; fall back to the value
        // tracked by draw(), which runs earlier in the same frame.
        const resolvedMotionScale = Number.isFinite(motionScale) ? motionScale : this._currentMotionScale;
        const source = atmosphere || this._getFallbackAtmosphere(resolvedMotionScale);
        this._currentPhase = source.phase || this._currentPhase;
        this._currentMotionScale = resolvedMotionScale;
        const canopy = this._buildCanopySnapshot(source);
        const height = Math.max(
            CANOPY_MIN_HEIGHT,
            Math.min(CANOPY_MAX_HEIGHT, canvas.height * CANOPY_HEIGHT_FRAC),
        );

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, height);
        ctx.clip();
        ctx.globalCompositeOperation = 'screen';
        this._drawStars(ctx, canvas, canopy);
        this._drawSun(ctx, camera, canvas, canopy, { ensureVisible: true, glowOnly: true });
        this._drawMoon(ctx, canvas, canopy);
        this._drawGodrays(ctx, camera, canvas, canopy, { alphaMul: 0.4 });
        ctx.globalCompositeOperation = 'source-over';
        this._drawClouds(ctx, camera, canvas, canopy);
        // 0.6 — hero rewards ride this canopy pass (which runs after
        // _drawTerrain) so they composite over terrain instead of behind the
        // village. They stay clipped to the sky band; the sky-flare's
        // gradient is scaled to the band so the clip leaves no hard edge.
        this._drawAurora(ctx, canvas, source, resolvedMotionScale);
        this._drawShootingStars(ctx, canvas, dt, resolvedMotionScale);
        this._drawSkyFlare(ctx, canvas, source, resolvedMotionScale, height);
        this._drawSunGlints(ctx, camera, canvas, source, dt, resolvedMotionScale);
        ctx.restore();
        // 0.6 — the push grade pulse is the whole-village moment: unclipped,
        // grading terrain and buildings too.
        this._drawPushGradePulse(ctx, canvas, resolvedMotionScale);
    }

    _buildCanopySnapshot(atmosphere) {
        const sky = atmosphere.sky || {};
        const canopy = {
            ...atmosphere,
            sky: {
                ...sky,
                starsAlpha: (sky.starsAlpha || 0) * 0.72,
                // 5.6 — canopy cloud alpha lift (was ×0.34): clouds over the
                // terrain read too faint, deadening the night canopy.
                cloudAlpha: (sky.cloudAlpha || 0) * 0.48,
                cloudDensity: Math.min(1, (sky.cloudDensity || 0) * 0.72),
                sun: sky.sun ? {
                    ...sky.sun,
                    alpha: sky.sun.alpha * 0.34,
                    canopyRescueAlpha: sky.sun.alpha * 0.9,
                } : sky.sun,
                moon: sky.moon ? { ...sky.moon, alpha: sky.moon.alpha * 0.62 } : sky.moon,
            },
        };
        if (canopy.sky.sun) {
            const horizonCut = canopy.sky.sun.yFrac > 0.42 ? 0.58 : 1;
            canopy.sky.sun.alpha *= 0.54 * horizonCut;
        }
        if (canopy.sky.cloudLayers?.length) {
            canopy.sky.cloudLayers = canopy.sky.cloudLayers
                .filter((layer, index) => index % 2 === 0 || layer.yFrac < 0.34)
                // 5.6 — matching per-layer lift (was ×0.58).
                .map(layer => ({ ...layer, alpha: layer.alpha * 0.72 }));
        }
        return canopy;
    }

    _normalizeDrawArgs(arg1, arg2, arg3, arg4) {
        if (arg1 && typeof arg1 === 'object' && arg1.canvas) {
            return {
                canvas: arg1.canvas,
                camera: arg1.camera || null,
                dt: Number.isFinite(arg1.dt) ? arg1.dt : 16,
                atmosphere: arg1.atmosphere || null,
                motionScale: Number.isFinite(arg1.motionScale) ? arg1.motionScale : 1,
            };
        }
        return {
            camera: arg1 || null,
            canvas: arg2 || null,
            dt: Number.isFinite(arg3) ? arg3 : 16,
            atmosphere: null,
            motionScale: Number.isFinite(arg4) ? arg4 : 1,
        };
    }

    _getFallbackAtmosphere(motionScale) {
        if (!this._fallbackAtmosphere) {
            this._fallbackAtmosphere = new AtmosphereState();
        }
        return this._fallbackAtmosphere.update({ motionScale });
    }

    _getCachedBackground(canvas, atmosphere) {
        const dpr = this._skyCacheDpr(canvas);
        const key = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere.cacheKey}`;
        if (this.cache && this.cacheKey === key) return this.cache;
        releaseCanvasBackingStore(this.cache);
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(canvas.width * dpr));
        off.height = Math.max(1, Math.round(canvas.height * dpr));
        const o = off.getContext('2d');
        o.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._paintGradient(o, canvas, atmosphere);
        this._paintHorizonWash(o, canvas, atmosphere);
        this._paintStaticWeatherPlate(o, canvas, atmosphere);
        this.cache = off;
        this.cacheKey = key;
        return off;
    }

    _useFastSkyCache(canvas) {
        const cssPixels = Math.max(1, Number(canvas?.width) || 1) * Math.max(1, Number(canvas?.height) || 1);
        return cssPixels >= FAST_SKY_CSS_PIXELS;
    }

    // Sky is gradients, stars, and a sun/moon disc: nothing here has 1px pixel
    // detail worth a 4x backing store. Past FAST_SKY_CSS_PIXELS the two sky
    // caches therefore stay at CSS resolution and the screen blit stretches
    // them; below it they follow the backing DPR like everything else. This is
    // where the DPR budget is deliberately not spent.
    _skyCacheDpr(canvas) {
        const dpr = canvas?._claudeVilleDpr || 1;
        return this._useFastSkyCache(canvas) ? Math.min(dpr, 1) : dpr;
    }

    _paintGradient(ctx, canvas, atmosphere) {
        const palette = atmosphere.sky?.palette || {};
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0.00, palette.zenith || '#236eb8');
        g.addColorStop(0.30, palette.upperBand || '#4aa0dd');
        g.addColorStop(0.65, palette.midBand || '#86cdf0');
        g.addColorStop(1.00, palette.horizon || '#d5f3ff');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _paintHorizonWash(ctx, canvas, atmosphere) {
        const palette = atmosphere.sky?.palette || {};
        const alpha = atmosphere.grade?.horizonWash ?? 0.12;
        const horizonGlow = palette.horizonGlow || '196, 235, 255';
        const farGlow = atmosphere.lighting?.ambientTint || horizonGlow;
        const layers = [
            { yFrac: 0.89, radius: 0.86, color: farGlow, alpha: alpha * 0.45 },
            { yFrac: 0.84, radius: 0.62, color: horizonGlow, alpha: alpha * 0.76 },
            { yFrac: 0.79, radius: 0.36, color: horizonGlow, alpha: alpha * 0.30 },
        ];
        for (const layer of layers) {
            const y = canvas.height * layer.yFrac;
            const grad = ctx.createRadialGradient(
                canvas.width * 0.5,
                y,
                0,
                canvas.width * 0.5,
                y,
                Math.max(canvas.width, canvas.height) * layer.radius,
            );
            grad.addColorStop(0, `rgba(${layer.color}, ${layer.alpha})`);
            grad.addColorStop(1, `rgba(${layer.color}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    // Sky condition only: a vertical canvas-wide gradient. This is not ground
    // fog and must not follow terrain, roads, or water.
    _paintStaticWeatherPlate(ctx, canvas, atmosphere) {
        const { weather } = atmosphere;
        if (!weather) return;
        const precipitation = clamp(weather.precipitation ?? 0, 0, 1);
        const fog = clamp(weather.fog ?? 0, 0, 1);
        const cloudCover = clamp(weather.cloudCover ?? 0, 0, 1);
        const active = weather.type === 'overcast'
            || weather.type === 'rain'
            || weather.type === 'storm'
            || weather.type === 'fog'
            || precipitation > 0.02
            || fog > 0.05
            || cloudCover > 0.72;
        if (!active) return;
        const alpha = fog > Math.max(precipitation, cloudCover * 0.45)
            ? 0.10 + Math.max(weather.intensity, fog) * 0.12
            : 0.12 + Math.max(weather.intensity, cloudCover, precipitation) * 0.18;
        const color = fog > Math.max(precipitation, cloudCover * 0.45) ? '210, 226, 236' : '72, 92, 118';
        const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
        g.addColorStop(0, `rgba(${color}, ${alpha})`);
        g.addColorStop(0.62, `rgba(${color}, ${alpha * 0.62})`);
        g.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Storm canopy: a deeper bruised zenith band baked over the plate so
        // the top of the sky reads as a heavy storm ceiling. Baked into the
        // background cache (folds into atmosphere.cacheKey) — zero per-frame
        // cost, and present regardless of motionScale (static fallback too).
        if (weather.type === 'storm') {
            const stormAlpha = 0.14 + clamp(Math.max(weather.intensity ?? 0, precipitation), 0, 1) * 0.18;
            // 5.5 — fleet-driven storms (weather.cause === 'fleet', i.e.
            // error-storminess dominating) bruise violet vs the neutral
            // blue-grey of a timeline storm. Subtle, and re-baked correctly
            // because atmosphere.cacheKey carries the cause.
            const fleet = weather.cause === 'fleet';
            const zenith = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.6);
            zenith.addColorStop(0, fleet ? `rgba(58, 44, 88, ${stormAlpha})` : `rgba(46, 50, 70, ${stormAlpha})`);
            zenith.addColorStop(0.5, fleet ? `rgba(66, 52, 96, ${stormAlpha * 0.5})` : `rgba(54, 60, 78, ${stormAlpha * 0.5})`);
            zenith.addColorStop(1, fleet ? 'rgba(66, 52, 96, 0)' : 'rgba(54, 60, 78, 0)');
            ctx.fillStyle = zenith;
            ctx.fillRect(0, 0, canvas.width, canvas.height * 0.6);
        }
    }

    _drawStars(ctx, canvas, atmosphere) {
        const alpha = atmosphere.sky?.starsAlpha ?? 0;
        if (alpha <= 0.01) return;
        const palette = atmosphere.sky?.palette || {};
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const timeOffset = (atmosphere.dayProgress || 0) * canvas.width;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };

        const starCount = starCountForCanvas(canvas);
        ctx.save();
        ctx.globalAlpha = alpha;
        for (let i = 0; i < starCount; i++) {
            const xBase = next() * canvas.width;
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            const size = hot ? 2 : 1;
            const drift = timeOffset * (0.12 + (i % 5) * 0.018);
            const x = Math.round(((xBase + drift) % canvas.width + canvas.width) % canvas.width);
            ctx.fillStyle = hot ? (palette.starHot || '#f2f7ff') : (palette.starWarm || '#c9ddff');
            ctx.fillRect(x, y, size, size);
        }
        this._drawConstellations(ctx, canvas, atmosphere, alpha, palette);
        ctx.restore();
    }

    _drawConstellations(ctx, canvas, atmosphere, alpha, palette) {
        const drift = ((atmosphere.dayProgress || 0) * 0.16) % 1;
        ctx.save();
        ctx.globalAlpha = Math.min(0.52, alpha * 0.46);
        ctx.strokeStyle = this._hexToRgba(palette.starWarm || '#c9ddff', 0.58);
        ctx.fillStyle = palette.starHot || '#f2f7ff';
        ctx.lineWidth = 1;
        for (const constellation of CONSTELLATIONS) {
            const points = constellation.points.map(([px, py]) => ({
                x: wrap((constellation.anchor[0] + px + drift) * canvas.width, -24, canvas.width + 24),
                y: Math.max(4, Math.min(canvas.height * STAR_CEILING_FRAC, (constellation.anchor[1] + py) * canvas.height)),
            }));
            if (!points.length) continue;
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(Math.round(points[i].x), Math.round(points[i].y));
            }
            ctx.stroke();
            for (const point of points) {
                ctx.fillRect(Math.round(point.x) - 1, Math.round(point.y) - 1, 2, 2);
            }
        }
        ctx.restore();
    }

    _drawSun(ctx, camera, canvas, atmosphere, options = {}) {
        const sun = atmosphere.sky?.sun;
        if (!sun?.visible || sun.alpha <= 0.01) return;
        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const position = this._resolveSunPosition(camera, canvas, sun, radius);
        const { x, y } = position;
        const visibleSun = options.ensureVisible && position.clamped && Number.isFinite(sun.canopyRescueAlpha)
            ? { ...sun, alpha: Math.max(sun.alpha, sun.canopyRescueAlpha) }
            : sun;
        const lighting = atmosphere.lighting || {};
        const warmth = lighting.sunWarmth ?? 0;
        const bloomScale = lighting.sunBloomScale ?? 1;
        const squashY = visibleSun.squashY ?? 1;
        const horizonScale = 1 - (visibleSun.horizonOcclusion || 0) * 0.35;
        const glowRadius = radius * (4.3 + warmth * 3.0) * bloomScale;
        const warmG = Math.round(232 - warmth * 42);
        const warmB = Math.round(170 - warmth * 58);
        const hazeG = Math.round(156 - warmth * 34);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
        glow.addColorStop(0, `rgba(255, ${warmth ? warmG : 238}, ${warmth ? warmB : 128}, ${0.46 * visibleSun.alpha})`);
        glow.addColorStop(0.38, warmth
            ? `rgba(255, ${hazeG}, 80, ${0.22 * visibleSun.alpha * bloomScale})`
            : `rgba(255, 222, 92, ${0.18 * visibleSun.alpha})`);
        glow.addColorStop(1, 'rgba(255, 222, 92, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const rayAlpha = Math.min(0.26, visibleSun.alpha * horizonScale * (0.16 + bloomScale * 0.08));
        ctx.strokeStyle = warmth > 0.05
            ? `rgba(255, 188, 86, ${rayAlpha})`
            : `rgba(255, 228, 90, ${rayAlpha})`;
        ctx.lineWidth = Math.max(2, Math.round(radius * 0.08));
        ctx.lineCap = 'round';
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 * i) / 12;
            const inner = radius * (1.48 + (i % 2) * 0.16);
            const outer = radius * horizonScale * (2.15 + (i % 3) * 0.18);
            ctx.beginPath();
            ctx.moveTo(
                Math.round(x + Math.cos(angle) * inner),
                Math.round(y + Math.sin(angle) * inner),
            );
            ctx.lineTo(
                Math.round(x + Math.cos(angle) * outer),
                Math.round(y + Math.sin(angle) * outer),
            );
            ctx.stroke();
        }

        // The canopy pass composites over the terrain so the hero sky rewards
        // land on top of the village. The sun's glow and rays belong there —
        // they are additive light and read as glare. Its body does not: it is
        // an opaque `source-over` disc, so drawing it in that pass plants a
        // solid ball on whatever happens to be underneath, which at close zoom
        // reads as a sticker lying on the ocean. The backdrop pass still draws
        // the full disc behind the world, so the sun is crisp wherever sky is
        // actually visible.
        if (options.glowOnly) {
            ctx.restore();
            return;
        }

        // 5.3 — pixel-integrity body. Prefer the authored `atmosphere.sun`
        // asset when the manifest provides one; otherwise draw the cached
        // quantized stepped-disc stamp. Both replace the old soft
        // radial-gradient orb (the "lamp behind trees").
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = visibleSun.alpha;
        const sunAssetId = this._firstAvailable([atmosphere.sky?.assetIds?.sun, FALLBACK_SUN_ID]);
        ctx.translate(x, y);
        if (squashY < 0.99) ctx.scale(1, squashY);
        ctx.imageSmoothingEnabled = false;
        if (sunAssetId) {
            const img = this.assets.get(sunAssetId);
            const dims = this.assets.getDims(sunAssetId);
            const scale = (radius * 2) / Math.max(dims.w, dims.h, 1);
            ctx.drawImage(
                img,
                Math.round((-dims.w * scale) / 2),
                Math.round((-dims.h * scale) / 2),
                Math.max(1, Math.round(dims.w * scale)),
                Math.max(1, Math.round(dims.h * scale)),
            );
        } else {
            const stamp = this._getSunStamp(radius, warmth);
            ctx.drawImage(stamp, Math.round(-stamp.width / 2), Math.round(-stamp.height / 2));
        }
        ctx.restore();
    }

    // 5.3 — stepped-disc sun stamp: the body is baked once per (radius,
    // warmth) bucket as flat 2px cells — a pixel-art disc with a blocky
    // highlight and rim instead of an anti-aliased gradient orb. Drawn with
    // imageSmoothingEnabled=false so the steps stay crisp at any DPR. Single
    // -slot cache; radius/warmth drift slowly, so rebuilds are rare.
    _getSunStamp(radius, warmth = 0) {
        const r = Math.max(8, Math.round(radius));
        const warmthBucket = Math.round(clamp(warmth) * 4);
        const key = `${r}|${warmthBucket}`;
        if (this._sunStamp?.key === key) return this._sunStamp.canvas;
        releaseCanvasBackingStore(this._sunStamp?.canvas);
        const cell = SUN_STAMP_CELL_PX;
        const size = Math.ceil((r * 2) / cell) * cell + cell * 2;
        const half = size / 2;
        const off = document.createElement('canvas');
        off.width = size;
        off.height = size;
        const o = off.getContext('2d');
        const base = warmthBucket > 0 ? '#ffd176' : '#ffe36b';
        const light = '#fff9bf';
        const rim = warmthBucket > 0 ? '#f3a14d' : '#ffc842';
        for (let gy = 0; gy < size; gy += cell) {
            for (let gx = 0; gx < size; gx += cell) {
                const cx = gx + cell / 2 - half;
                const cy = gy + cell / 2 - half;
                const d = Math.hypot(cx, cy);
                if (d > r) continue;
                let color = base;
                if (d > r - cell * 1.6) color = rim;
                else if (Math.hypot(cx + r * 0.26, cy + r * 0.30) < r * 0.44) color = light;
                o.fillStyle = color;
                o.fillRect(gx, gy, cell, cell);
            }
        }
        this._sunStamp = { key, canvas: off };
        return off;
    }

    _drawGodrays(ctx, camera, canvas, atmosphere, options = {}) {
        const sun = atmosphere.sky?.sun;
        const lighting = atmosphere.lighting || {};
        const warmth = lighting.sunWarmth ?? 0;
        if (!sun?.visible) return;
        // Loosened from 0.18 so rays break through on a clearing transition
        // (the warm-up before dawn/after dusk), but only under clear-enough sky.
        const cloudCover = clamp(atmosphere.weather?.cloudCover ?? 0, 0, 1);
        const warmthGate = cloudCover > DAY_REWARD_CLOUD_COVER_MAX ? 0.18 : 0.08;
        if (warmth <= warmthGate) return;
        if ((sun.alpha ?? 0) <= 0.04) return;

        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const position = this._resolveSunPosition(camera, canvas, sun, radius);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        const { x, y } = position;

        const alphaMul = Number.isFinite(options.alphaMul) ? options.alphaMul : 1;
        const baseAlpha = 0.10 * warmth * (sun.alpha ?? 0) * alphaMul;
        if (baseAlpha <= 0.002) return;

        const rayCount = 7;
        const spreadRad = 25 * Math.PI / 180;
        const length = Math.hypot(canvas.width, canvas.height) * 1.1;
        const halfWidth = Math.max(8, radius * 0.42);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < rayCount; i++) {
            const t = rayCount === 1 ? 0 : (i / (rayCount - 1)) * 2 - 1;
            const angle = Math.PI / 2 + t * spreadRad;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            const fx = x + dx * length;
            const fy = y + dy * length;
            const px = -dy * halfWidth;
            const py = dx * halfWidth;
            const widthBoost = 1 + (1 - Math.abs(t)) * 0.35;
            const rayAlpha = baseAlpha * (0.78 + (1 - Math.abs(t)) * 0.22);

            const grad = ctx.createLinearGradient(x, y, fx, fy);
            grad.addColorStop(0, `rgba(255, 226, 168, ${rayAlpha})`);
            grad.addColorStop(0.45, `rgba(255, 206, 138, ${rayAlpha * 0.45})`);
            grad.addColorStop(1, 'rgba(255, 198, 124, 0)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(x - px * 0.45 * widthBoost, y - py * 0.45 * widthBoost);
            ctx.lineTo(x + px * 0.45 * widthBoost, y + py * 0.45 * widthBoost);
            ctx.lineTo(fx + px * widthBoost, fy + py * widthBoost);
            ctx.lineTo(fx - px * widthBoost, fy - py * widthBoost);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _resolveSunPosition(camera, canvas, sun, radius) {
        const x = canvas.width * sun.xFrac;
        const skyY = canvas.height * sun.yFrac;
        const mapTopY = this._mapTopYAtScreenX(camera, x);
        if (!Number.isFinite(mapTopY)) return { x, y: skyY, clamped: false };

        const clearance = radius * SUN_MAP_CLEARANCE_RADIUS;
        const minimumY = radius * SUN_MIN_SCREEN_RADIUS;
        return {
            x,
            y: Math.max(minimumY, Math.min(skyY, mapTopY - clearance)),
            clamped: skyY > mapTopY - clearance,
        };
    }

    _mapTopYAtScreenX(camera, x) {
        if (!camera?.worldToScreen) return null;
        const corners = mapWorldCorners().map(point => camera.worldToScreen(point.x, point.y));
        if (corners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;

        const edges = [
            [corners[0], corners[1]],
            [corners[1], corners[3]],
            [corners[3], corners[2]],
            [corners[2], corners[0]],
        ];
        const candidates = [];
        for (const [a, b] of edges) {
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            if (x < minX || x > maxX) continue;
            const dx = b.x - a.x;
            if (Math.abs(dx) < 0.001) {
                candidates.push(Math.min(a.y, b.y));
                continue;
            }
            const t = (x - a.x) / dx;
            candidates.push(a.y + (b.y - a.y) * t);
        }
        return candidates.length ? Math.min(...candidates) : Math.min(...corners.map(point => point.y));
    }

    _drawMoon(ctx, canvas, atmosphere) {
        const moon = atmosphere.sky?.moon;
        if (!moon?.visible || moon.alpha <= 0.01) return;
        const phaseName = moon.phase?.phaseName || 'crescent';
        const illumination = clamp(moon.phase?.illumination ?? 0.24, 0, 1);
        const authoredPhase = phaseName === 'first-quarter' || phaseName === 'last-quarter'
            ? 'half'
            : phaseName === 'waxing-gibbous' || phaseName === 'waning-gibbous' || phaseName === 'full'
                ? 'gibbous'
                : phaseName;
        const authoredPhaseId = MOON_PHASE_ASSETS[authoredPhase];
        const id = this._firstAvailable([
            authoredPhaseId,
            phaseName === 'crescent' ? atmosphere.sky?.assetIds?.moon : null,
            authoredPhase === 'crescent' ? FALLBACK_MOON_ID : null,
        ]);
        const shouldUseAuthoredMoon = id
            && (
                (authoredPhase === 'crescent' && illumination > 0.10 && illumination < 0.31)
                || ((authoredPhase === 'half' || authoredPhase === 'gibbous') && id === authoredPhaseId)
            );
        if (shouldUseAuthoredMoon) {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            const x = canvas.width * moon.xFrac - dims.w / 2;
            const y = canvas.height * moon.yFrac - dims.h / 2;
            ctx.save();
            ctx.globalAlpha = moon.alpha;
            this._drawMoonGlow(ctx, canvas, moon, atmosphere);
            const squashY = moon.squashY ?? 1;
            if (squashY < 0.99) {
                ctx.translate(canvas.width * moon.xFrac, canvas.height * moon.yFrac);
                ctx.scale(1, squashY);
                ctx.drawImage(img, Math.round(-dims.w / 2), Math.round(-dims.h / 2));
            } else {
                ctx.drawImage(img, Math.round(x), Math.round(y));
            }
            ctx.restore();
            return;
        }
        this._drawCodeMoon(ctx, canvas, moon, atmosphere);
    }

    _drawMoonGlow(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const radius = Math.max(42, Math.min(canvas.width, canvas.height) * 0.10);
        const corona = atmosphere?.lighting?.beaconIntensity ?? 0.5;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.42);
        glow.addColorStop(0, `rgba(166, 205, 255, ${0.18 * moon.alpha})`);
        glow.addColorStop(0.56, `rgba(190, 218, 255, ${0.08 * moon.alpha * corona})`);
        glow.addColorStop(0.74, `rgba(230, 238, 255, ${0.045 * moon.alpha * corona})`);
        glow.addColorStop(1, 'rgba(166, 205, 255, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawCodeMoon(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const r = Math.max(14, Math.min(canvas.width, canvas.height) * 0.026);
        const squashY = moon.squashY ?? 1;
        const phase = moon.phase || { phaseName: 'crescent', illumination: 0.24, waxing: false };
        const illumination = clamp(phase.illumination ?? 0.24, 0, 1);
        const litWidth = r * (0.22 + illumination * 1.46);
        const shadowOffset = phase.phaseName === 'new'
            ? 0
            : (phase.waxing ? -1 : 1) * r * (0.92 - illumination * 0.84);
        ctx.save();
        ctx.globalAlpha = moon.alpha;
        this._drawMoonGlow(ctx, canvas, { ...moon, alpha: moon.alpha * (0.25 + illumination * 0.75) }, atmosphere);
        ctx.translate(x, y);
        ctx.scale(1, squashY);
        ctx.fillStyle = '#cfe4ff';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.clip();
        if (phase.phaseName === 'new') {
            ctx.fillStyle = 'rgba(8, 18, 34, 0.76)';
            ctx.fillRect(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4);
            ctx.strokeStyle = 'rgba(190, 216, 255, 0.36)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 0, r - 1, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.globalCompositeOperation = 'source-atop';
            const shadow = ctx.createRadialGradient(shadowOffset, -r * 0.08, r * 0.12, shadowOffset, 0, r * 1.34);
            shadow.addColorStop(0, 'rgba(20, 36, 58, 0.05)');
            shadow.addColorStop(0.52, 'rgba(14, 26, 44, 0.28)');
            shadow.addColorStop(1, 'rgba(4, 12, 24, 0.82)');
            ctx.fillStyle = shadow;
            const shadowX = phase.waxing ? -r - litWidth * 0.38 : litWidth * 0.38;
            ctx.fillRect(shadowX, -r - 2, r * 2.4, r * 2 + 4);
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = `rgba(238, 247, 255, ${0.06 + illumination * 0.08})`;
            ctx.beginPath();
            ctx.ellipse((phase.waxing ? 1 : -1) * r * 0.12, -r * 0.18, litWidth * 0.32, r * 0.22, -0.24, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawClouds(ctx, camera, canvas, atmosphere) {
        if (!this.assets) return;
        const layers = Array.isArray(atmosphere.sky?.cloudLayers) && atmosphere.sky.cloudLayers.length
            ? atmosphere.sky.cloudLayers
            : null;
        if (layers) {
            this._drawCloudLayerDescriptors(ctx, camera, canvas, atmosphere, layers);
            return;
        }
        const cloudIds = this._availableCloudIds(atmosphere);
        if (!cloudIds.length) return;

        const camX = camera?.x || 0;
        const density = atmosphere.sky?.cloudDensity ?? 0.3;
        const baseAlpha = atmosphere.sky?.cloudAlpha ?? 0.35;
        const clockDrift = atmosphere.motion?.clockDriftPx || 0;
        const windX = atmosphere.motion?.windX || 1;
        const seed = Number.isFinite(Number(atmosphere.weather?.seed))
            ? Number(atmosphere.weather.seed) >>> 0
            : hashString(`${atmosphere.clock?.localDate || ''}|${atmosphere.weather?.type || 'clear'}`);

        cloudIds.forEach((id, index) => {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            if (!img || !dims) return;
            const defaults = CLOUD_LAYER_DEFAULTS[index % CLOUD_LAYER_DEFAULTS.length];
            const count = Math.max(2, Math.round(2 + density * 5) - index);
            const spacing = canvas.width / count;
            const rawOffset = -camX * defaults.parallax
                + clockDrift * defaults.driftMul
                + this._decorativeCloudOffset * defaults.driftMul * windX;
            const baseOffset = ((rawOffset % spacing) + spacing) % spacing;

            ctx.save();
            ctx.globalAlpha = Math.min(0.86, baseAlpha * defaults.alphaMul);
            for (let i = -1; i <= count; i++) {
                const salt = index * 1009 + (i + 3) * 131;
                const jitter = (random01(seed, salt + 11) - 0.5) * spacing * 0.62;
                const yJitter = (random01(seed, salt + 23) - 0.5) * canvas.height * 0.055;
                const scale = 0.82 + random01(seed, salt + 37) * 0.36;
                const layerAlpha = 0.74 + random01(seed, salt + 41) * 0.34;
                const y = (defaults.fy + index * 0.045) * canvas.height + yJitter;
                const x = i * spacing + baseOffset + jitter - (dims.w * scale) / 2;
                ctx.globalAlpha = Math.min(0.86, baseAlpha * defaults.alphaMul * layerAlpha);
                ctx.drawImage(
                    img,
                    Math.round(x),
                    Math.round(y),
                    Math.round(dims.w * scale),
                    Math.round(dims.h * scale),
                );
            }
            ctx.restore();
        });
    }

    _drawCloudLayerDescriptors(ctx, camera, canvas, atmosphere, layers) {
        const camX = camera?.x || 0;
        const clockDrift = atmosphere.motion?.clockDriftPx || 0;
        const windX = atmosphere.motion?.windX || 1;
        const wrapWidth = canvas.width + 260;
        ctx.save();
        for (const layer of layers) {
            const id = this.assets.has(layer.assetId) ? layer.assetId : this._availableCloudIds(atmosphere)[0];
            if (!id) continue;
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            if (!img || !dims) continue;
            const scale = Math.max(0.45, Number(layer.scale) || 1);
            const w = dims.w * scale;
            const h = dims.h * scale;
            const parallax = Number(layer.parallax) || 0.04;
            const driftMul = Number(layer.driftMul) || 1;
            const drift = -camX * parallax
                + clockDrift * driftMul
                + this._decorativeCloudOffset * driftMul * windX;
            const y = canvas.height * clamp(layer.yFrac ?? 0.25, 0.04, 0.62);
            const baseX = (layer.xFrac ?? 0.5) * canvas.width + drift;
            const x = wrap(baseX, -w - 130, wrapWidth);
            ctx.globalAlpha = Math.min(0.88, Math.max(0, Number(layer.alpha) || 0));
            ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
            if (x + w < canvas.width + 80) {
                ctx.drawImage(img, Math.round(x + wrapWidth), Math.round(y), Math.round(w), Math.round(h));
            }
        }
        ctx.restore();
    }

    // Live star twinkle over the cached night sky. Walks the same deterministic
    // PRNG as _drawStars (same seed / next() sequence / hot test / drift) so the
    // first LIVE_TWINKLE_STARS hot stars land exactly on their baked positions,
    // then overdraws them with a staggered sinusoidal alpha. Pulse cadence is a
    // local sine, matching the aurora / shooting-star live layers (no shared
    // PulsePolicy). Skipped under reduced motion or when the sky has no stars.
    _drawLiveStarTwinkle(ctx, canvas, atmosphere, motionScale = 1) {
        if (motionScale === 0) return;
        const twinkle = liveTwinkleBudget({
            calm: resolveCalmGate(),
            motionScale,
        });
        if (twinkle.count <= 0) return;
        const starsAlpha = atmosphere.sky?.starsAlpha ?? 0;
        if (starsAlpha <= 0.01) return;
        const palette = atmosphere.sky?.palette || {};
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const timeOffset = (atmosphere.dayProgress || 0) * canvas.width;
        const time = performance.now() * 0.001;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };

        const starCount = starCountForCanvas(canvas);
        ctx.save();
        ctx.fillStyle = palette.starHot || '#f2f7ff';
        let drawn = 0;
        for (let i = 0; i < starCount && drawn < twinkle.count; i++) {
            const xBase = next() * canvas.width;
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            if (!hot) continue;
            const drift = timeOffset * (0.12 + (i % 5) * 0.018);
            const x = Math.round(((xBase + drift) % canvas.width + canvas.width) % canvas.width);
            const rate = (1.6 + (i % 4) * 0.55) * twinkle.rateScale;
            const phase = i * 1.7;
            const pulse = 0.4 + 0.6 * Math.sin(time * rate + phase);
            ctx.globalAlpha = clamp(starsAlpha * pulse, 0, 1);
            ctx.fillRect(x, y, 2, 2);
            drawn++;
        }
        ctx.restore();
    }

    _drawAurora(ctx, canvas, atmosphere, motionScale = 1) {
        if (!this._auroraStartedAt) return;
        const elapsed = Date.now() - this._auroraStartedAt;
        if (elapsed > AURORA_DURATION_MS) {
            this._auroraStartedAt = 0;
            return;
        }
        const alpha = this._auroraAlpha(elapsed, motionScale);
        if (alpha <= 0.005) return;
        const beacon = atmosphere?.lighting?.beaconIntensity ?? 0.65;
        const yBase = canvas.height * 0.23;
        const width = canvas.width;
        const time = motionScale === 0 ? 0.75 : elapsed / 1000;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = Math.min(0.22, alpha * (0.78 + beacon * 0.35));
        for (let band = 0; band < 3; band++) {
            const yOffset = band * 18;
            const hue = band === 0 ? '102, 255, 196' : band === 1 ? '104, 190, 255' : '196, 126, 255';
            const grad = ctx.createLinearGradient(0, yBase - 42 + yOffset, 0, yBase + 64 + yOffset);
            grad.addColorStop(0, `rgba(${hue}, 0)`);
            grad.addColorStop(0.42, `rgba(${hue}, ${0.38 - band * 0.07})`);
            grad.addColorStop(1, `rgba(${hue}, 0)`);
            ctx.strokeStyle = grad;
            ctx.lineWidth = 22 - band * 4;
            ctx.beginPath();
            for (let x = -20; x <= width + 20; x += 28) {
                const t = x / Math.max(1, width);
                const y = yBase + yOffset
                    + Math.cos(t * Math.PI * 2.1 + band * 0.85 + time * 0.45) * (18 + band * 5)
                    + Math.cos(t * Math.PI * 5.2 - time * 0.25) * 5;
                if (x === -20) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    _auroraAlpha(elapsed, motionScale) {
        // 5.6 — reduced motion: three static alpha steps (in/hold/out) over
        // the same window instead of a 12s fixed hold that pops off.
        if (motionScale === 0) return rmThreeStepEnvelope(elapsed / AURORA_DURATION_MS);
        if (elapsed < AURORA_FADE_IN_MS) return elapsed / AURORA_FADE_IN_MS;
        if (elapsed < AURORA_FADE_IN_MS + AURORA_HOLD_MS) return 1;
        const fadeElapsed = elapsed - AURORA_FADE_IN_MS - AURORA_HOLD_MS;
        return Math.max(0, 1 - fadeElapsed / (AURORA_DURATION_MS - AURORA_FADE_IN_MS - AURORA_HOLD_MS));
    }

    _drawShootingStars(ctx, canvas, dt, motionScale) {
        if (!this._shootingStars.length) return;
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const next = [];
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const star of this._shootingStars) {
            star.elapsed += dt;
            const t = star.elapsed / SHOOTING_STAR_DURATION_MS;
            if (t >= 1) continue;
            // 5.6 — reduced motion: the streak holds a fixed mid-flight pose
            // and steps its alpha (3-step envelope) instead of traveling.
            const alpha = motionScale === 0
                ? rmThreeStepEnvelope(t) * 0.9
                : t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
            if (alpha <= 0.01) {
                next.push(star);
                continue;
            }
            const length = canvas.width * star.lengthFrac;
            const dx = Math.cos(star.angle);
            const dy = Math.sin(star.angle);
            const x0 = canvas.width * star.startXFrac;
            const y0 = canvas.height * star.startYFrac;
            const headProgress = motionScale === 0 ? 0.62 : 0.2 + t * 0.8;
            const hx = x0 + dx * length * headProgress;
            const hy = y0 + dy * length * headProgress;
            const tx = hx - dx * length * 0.55;
            const ty = hy - dy * length * 0.55;
            if (hy > ceilingY + 4) {
                next.push(star);
                continue;
            }
            const trail = ctx.createLinearGradient(tx, ty, hx, hy);
            trail.addColorStop(0, `rgba(255, 196, 132, 0)`);
            trail.addColorStop(0.55, `rgba(255, 214, 158, ${alpha * 0.42})`);
            trail.addColorStop(1, `rgba(255, 250, 232, ${alpha * 0.88})`);
            ctx.strokeStyle = trail;
            ctx.lineWidth = 1.6;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            const head = ctx.createRadialGradient(hx, hy, 0, hx, hy, 6);
            head.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
            head.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = head;
            ctx.beginPath();
            ctx.arc(hx, hy, 6, 0, Math.PI * 2);
            ctx.fill();
            next.push(star);
        }
        ctx.restore();
        this._shootingStars = next;
    }

    // Golden sky-flare — daytime push reward. Pulse band: a single envelope
    // (fade-in → hold → fade-out) over SKY_FLARE_DURATION_MS, no looping
    // oscillation. 0.6 — drawn through the canopy pass, clipped to the sky
    // band; gradientHeight scales the wash to the band so the clip leaves no
    // hard edge. Reduced motion (motionScale 0): the same window on a 3-step
    // static envelope (step-in → hold → step-out), no continuous animation.
    _drawSkyFlare(ctx, canvas, atmosphere, motionScale = 1, gradientHeight = 0) {
        if (!this._skyFlareStartedAt) return;
        const elapsed = Date.now() - this._skyFlareStartedAt;
        if (elapsed > SKY_FLARE_DURATION_MS) {
            this._skyFlareStartedAt = 0;
            return;
        }
        const envelope = motionScale === 0
            ? 0.62 * rmThreeStepEnvelope(elapsed / SKY_FLARE_DURATION_MS)
            : this._skyFlareEnvelope(elapsed);
        if (envelope <= 0.005) return;
        const warmth = atmosphere?.lighting?.sunWarmth ?? 0;
        const peak = 0.30 * envelope;
        const gradHeight = gradientHeight > 0 ? gradientHeight : canvas.height;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const grad = ctx.createLinearGradient(0, 0, 0, gradHeight);
        const topG = Math.round(228 - warmth * 30);
        const topB = Math.round(150 - warmth * 50);
        grad.addColorStop(0, `rgba(255, ${topG}, ${topB}, ${peak})`);
        grad.addColorStop(0.45, `rgba(255, 214, 150, ${peak * 0.5})`);
        grad.addColorStop(1, 'rgba(255, 206, 138, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, gradHeight);
        ctx.restore();
    }

    _skyFlareEnvelope(elapsed) {
        if (elapsed < SKY_FLARE_FADE_IN_MS) return elapsed / SKY_FLARE_FADE_IN_MS;
        if (elapsed < SKY_FLARE_FADE_IN_MS + SKY_FLARE_HOLD_MS) return 1;
        const fadeElapsed = elapsed - SKY_FLARE_FADE_IN_MS - SKY_FLARE_HOLD_MS;
        const fadeLen = SKY_FLARE_DURATION_MS - SKY_FLARE_FADE_IN_MS - SKY_FLARE_HOLD_MS;
        return Math.max(0, 1 - fadeElapsed / fadeLen);
    }

    // Sun-ray glint — daytime subagent reward. Pulse band: a single one-shot
    // envelope per glint over SUN_GLINT_DURATION_MS (rays bloom out then fade),
    // no looping oscillation. Reduced motion: one fixed-pose rim flash whose
    // alpha steps on a 3-step envelope (no expanding sweep), then it drops.
    _drawSunGlints(ctx, camera, canvas, atmosphere, dt, motionScale = 1) {
        if (!this._sunGlints.length) return;
        const sun = atmosphere.sky?.sun;
        if (!sun?.visible || (sun.alpha ?? 0) <= 0.04) {
            this._sunGlints.length = 0;
            return;
        }
        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const position = this._resolveSunPosition(camera, canvas, sun, radius);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        const { x, y } = position;
        const sunAlpha = sun.alpha ?? 0;
        const next = [];

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const glint of this._sunGlints) {
            glint.elapsed += dt;
            // Reduced motion: hold one static rim flash at peak for the full
            // window, no expanding sweep; then drop it.
            if (motionScale === 0) {
                if (glint.elapsed >= SUN_GLINT_DURATION_MS) continue;
            } else if (glint.elapsed >= SUN_GLINT_DURATION_MS) {
                continue;
            }
            const t = motionScale === 0 ? 0.5 : glint.elapsed / SUN_GLINT_DURATION_MS;
            // 5.6 — reduced motion: 3-step alpha steps anchored to the old
            // fixed t=0.5 fade at its hold step, instead of one static hold.
            const fade = motionScale === 0
                ? 0.64 * rmThreeStepEnvelope(glint.elapsed / SUN_GLINT_DURATION_MS)
                : t < 0.22 ? t / 0.22 : 1 - (t - 0.22) / 0.78;
            const alpha = Math.max(0, fade) * sunAlpha * 0.55;
            if (alpha <= 0.01) {
                next.push(glint);
                continue;
            }
            const reach = motionScale === 0
                ? radius * 4.2
                : radius * (2.0 + t * 3.2);
            const rays = 8;
            ctx.strokeStyle = `rgba(255, 236, 178, ${alpha})`;
            ctx.lineWidth = Math.max(2, Math.round(radius * 0.1));
            ctx.lineCap = 'round';
            for (let i = 0; i < rays; i++) {
                const angle = (Math.PI * 2 * i) / rays + glint.twist;
                const inner = radius * 1.2;
                ctx.beginPath();
                ctx.moveTo(
                    Math.round(x + Math.cos(angle) * inner),
                    Math.round(y + Math.sin(angle) * inner),
                );
                ctx.lineTo(
                    Math.round(x + Math.cos(angle) * reach),
                    Math.round(y + Math.sin(angle) * reach),
                );
                ctx.stroke();
            }
            const halo = ctx.createRadialGradient(x, y, radius * 0.4, x, y, reach);
            halo.addColorStop(0, `rgba(255, 244, 198, ${alpha * 0.7})`);
            halo.addColorStop(1, 'rgba(255, 230, 170, 0)');
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(x, y, reach, 0, Math.PI * 2);
            ctx.fill();
            next.push(glint);
        }
        ctx.restore();
        this._sunGlints = next;
    }

    // 0.14 — the background rain veil is gone: it cost ~1–2.4k strokes/frame
    // for a layer hidden behind the terrain, and it slanted against the wind
    // 18% of the time. Foreground rain in WeatherRenderer carries rain now;
    // only the background fog remains here.
    _drawBackgroundWeather(ctx, canvas, atmosphere) {
        const weather = atmosphere.weather;
        if (!weather) return;
        const fog = clamp(weather.fog ?? 0, 0, 1);
        if (weather.type === 'fog' || fog > 0.05) {
            this._drawFog(ctx, canvas, weather);
        }
    }

    _drawFog(ctx, canvas, weather) {
        const alpha = Math.min(0.22, 0.06 + Math.max(weather.intensity, weather.fog ?? 0) * 0.16);
        ctx.save();
        ctx.globalAlpha = alpha;
        for (let i = 0; i < 4; i++) {
            const y = canvas.height * (0.34 + i * 0.12);
            const grad = ctx.createLinearGradient(0, y - 24, 0, y + 42);
            grad.addColorStop(0, 'rgba(220, 234, 240, 0)');
            grad.addColorStop(0.5, 'rgba(220, 234, 240, 0.55)');
            grad.addColorStop(1, 'rgba(220, 234, 240, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, y - 24, canvas.width, 66);
        }
        ctx.restore();
    }

    // 5.2 — ambient clear-night meteors: one every ~90–180s while the
    // starfield is actually visible. Shares the reward shooting-star pool
    // (cap included), so it never stacks onto a subagent celebration. The
    // first eligible clear night only arms the timer — no boot-time meteor.
    _maybeTriggerAmbientMeteor(atmosphere) {
        if (!allowAmbientMeteor({
            calm: resolveCalmGate(),
            motionScale: this._currentMotionScale,
        })) return;
        if (!SHOOTING_STAR_NIGHT_PHASES.has(this._currentPhase)) return;
        if ((atmosphere.sky?.starsAlpha ?? 0) < AMBIENT_METEOR_MIN_STARS_ALPHA) return;
        if (this._currentCloudCover > AMBIENT_METEOR_MAX_CLOUD_COVER) return;
        const now = Date.now();
        if (!this._nextAmbientMeteorAt) {
            this._nextAmbientMeteorAt = now + AMBIENT_METEOR_MIN_MS + Math.random() * AMBIENT_METEOR_SPAN_MS;
            return;
        }
        if (now < this._nextAmbientMeteorAt) return;
        this._nextAmbientMeteorAt = now + AMBIENT_METEOR_MIN_MS + Math.random() * AMBIENT_METEOR_SPAN_MS;
        const angle = Math.PI / 3 + Math.random() * (Math.PI / 6);
        const length = 0.12 + Math.random() * 0.10;
        this.triggerShootingStar({ angle, length });
    }

    // 0.6 — whole-village warm grade pulse on push: a single full-screen
    // 'screen' gradient for 2s (one gradient + one fillRect per frame,
    // cooldown-gated in the push handler). Drawn unclipped after the canopy
    // pass so it grades terrain and buildings too. Reduced motion: the same
    // window on a 3-step static envelope.
    _drawPushGradePulse(ctx, canvas, motionScale = 1) {
        if (!this._pushGradeStartedAt) return;
        const elapsed = Date.now() - this._pushGradeStartedAt;
        if (elapsed > PUSH_GRADE_DURATION_MS) {
            this._pushGradeStartedAt = 0;
            return;
        }
        const envelope = motionScale === 0
            ? rmThreeStepEnvelope(elapsed / PUSH_GRADE_DURATION_MS)
            : this._pushGradeEnvelope(elapsed);
        if (envelope <= 0.005) return;
        const peak = 0.12 * envelope;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, `rgba(255, 214, 150, ${peak})`);
        grad.addColorStop(0.55, `rgba(255, 196, 128, ${peak * 0.62})`);
        grad.addColorStop(1, `rgba(255, 186, 118, ${peak * 0.35})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
    }

    _pushGradeEnvelope(elapsed) {
        if (elapsed < PUSH_GRADE_FADE_IN_MS) return elapsed / PUSH_GRADE_FADE_IN_MS;
        if (elapsed < PUSH_GRADE_FADE_IN_MS + PUSH_GRADE_HOLD_MS) return 1;
        const fadeElapsed = elapsed - PUSH_GRADE_FADE_IN_MS - PUSH_GRADE_HOLD_MS;
        const fadeLen = PUSH_GRADE_DURATION_MS - PUSH_GRADE_FADE_IN_MS - PUSH_GRADE_HOLD_MS;
        return Math.max(0, 1 - fadeElapsed / fadeLen);
    }

    _hexToRgba(hex, alpha) {
        const value = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f').slice(0, 6);
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    _availableCloudIds(atmosphere) {
        const requested = atmosphere.sky?.assetIds?.clouds || [];
        const available = requested.filter(id => this.assets?.has(id));
        if (available.length) return available;
        return FALLBACK_CLOUD_IDS.filter(id => this.assets?.has(id));
    }

    _firstAvailable(ids) {
        if (!this.assets) return null;
        for (const id of ids) {
            if (id && this.assets.has(id)) return id;
        }
        return null;
    }

    // Drop the cached background bitmap without detaching subscriptions.
    // Used by viewport/resize cache invalidation paths that must not tear
    // down the aurora / shooting-star event wiring.
    releaseCache() {
        releaseCanvasBackingStore(this.cache);
        this.cache = null;
        this.cacheKey = '';
        releaseCanvasBackingStore(this._frameCache);
        this._frameCache = null;
        this._frameCacheKey = '';
        releaseCanvasBackingStore(this._sunStamp?.canvas);
        this._sunStamp = null;
    }

    dispose() {
        this.releaseCache();
        this._decorativeCloudOffset = 0;
        this._auroraStartedAt = 0;
        this._shootingStars.length = 0;
        this._skyFlareStartedAt = 0;
        this._sunGlints.length = 0;
        this._pushGradeStartedAt = 0;
        this._lastPushGradeAt = 0;
        this._nextAmbientMeteorAt = 0;
        this.detach();
        this._fallbackAtmosphere?.dispose?.();
        this._fallbackAtmosphere = null;
    }

    getCanvasBudget() {
        return {
            volatilePixels: canvasPixelCount(this.cache) + canvasPixelCount(this._frameCache),
            cacheKey: this.cacheKey,
        };
    }
}

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

// 5.2 — viewport-scaled star count: 90 stars per 1280×720 of sky, clamped.
// Used by both _drawStars (baked) and _drawLiveStarTwinkle (live) so the two
// PRNG walks stay in lockstep on any viewport.
function starCountForCanvas(canvas) {
    const area = Math.max(1, (Number(canvas?.width) || 0) * (Number(canvas?.height) || 0));
    return Math.max(
        STAR_MIN_COUNT,
        Math.min(STAR_MAX_COUNT, Math.round((STAR_BASE_COUNT * area) / STAR_BASE_AREA)),
    );
}

// 5.6 — reduced-motion envelope for one-shot sky rewards: three static alpha
// steps (step-in → hold → step-out) across the reward's normal duration, so
// RM sessions still get the cue without continuous per-frame interpolation.
// t is normalized 0..1.
function rmThreeStepEnvelope(t) {
    if (t < 0.25) return 0.55;
    if (t < 0.75) return 1;
    return 0.4;
}

function wrap(value, min, max) {
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0) return min;
    return ((value - min) % range + range) % range + min;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
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
