// claudeville/src/presentation/character-mode/WeatherRenderer.js
//
// Screen-space foreground weather. Intended to run after world sprites and
// particles, before labels and status badges, with the canvas transform reset.

import {
    DISTRICT_LIGHTING_BANDS,
    WEATHER_PRESETS,
    WEATHER_TYPES,
    quantizeDistrictLightingBand,
} from './AtmosphereState.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { ornamentPlan, sampleFramePressure } from './MarkGovernor.js';

export function weatherEmbellishmentAllowed(level = 0) {
    return ornamentPlan({ level, motionScale: 1 }).ambientWeatherEmbellishment !== 'off';
}

export function weatherPassKeepsPrecipitation(level = 0) {
    const moving = ornamentPlan({ level, motionScale: 1 });
    const reduced = ornamentPlan({ level, motionScale: 0 });
    return moving.weather === 'on' && reduced.weather === 'static';
}

const CLEAR_TYPES = new Set(['clear', 'partly-cloudy']);
const RAIN_TYPES = new Set(['rain', 'storm']);
const WEATHER_TYPE_SET = new Set(WEATHER_TYPES);

const LOOP_MS = 60000;
const MAX_FRAME_DT = 80;
const RAIN_AREA_DENSITY = 5200;
const RAIN_MAX_STREAKS = 180;
const RAIN_MIN_STREAKS = 24;
const SNOW_AREA_DENSITY = 3200;
const SNOW_MAX_FLAKES = 420;
const SNOW_MIN_FLAKES = 24;
const FOG_MAX_BANDS = 9;
const FOG_MIN_BANDS = 3;
// Aerial fog only. Spatial ground haze is WorldFrameRenderer's field.
export const FOG_BAND_Y_RANGE = Object.freeze({ min: 0.10, max: 0.40 });

const RAIN_SPLASH_SPRITE_ID = 'atmosphere.rain.splash';
const RAIN_RIPPLE_SPRITE_ID = 'atmosphere.water.ripple.rain';
const SPLASH_PRECIP_THRESHOLD = 0.15;
const SPLASH_STAMP_INTERVAL_MS = 120;
const SPLASH_STAMP_MIN_COUNT = 6;
const SPLASH_STAMP_MAX_COUNT = 18;
const SPLASH_STATIC_GRID_COUNT = 12;
const RIPPLE_TILE_THROTTLE_MS = 2000;
const RIPPLE_TILE_TRACK_LIMIT = 256;
const DISTRICT_TEXTURE_SIZE = 128;
const DISTRICT_TEXTURE_CACHE_LIMIT = 12;
const DISTRICT_COOL_TINT = '76, 104, 150';
const DISTRICT_WARM_TINT = '226, 181, 112';
const DISTRICT_DIM_TINT = '10, 14, 24';
const DISTRICT_TILE_RADIUS_X = TILE_WIDTH / 2;
const DISTRICT_TILE_RADIUS_Y = TILE_HEIGHT / 2;

const DEFAULT_INTENSITY = {
    overcast: 0.38,
    rain: 0.64,
    fog: 0.58,
    storm: 0.82,
};

function normalizedDistrictLightingBand(value, direction) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    for (const band of DISTRICT_LIGHTING_BANDS) {
        if (numeric === band) return band;
    }
    return quantizeDistrictLightingBand(numeric, direction);
}

function districtLightingStrength(band) {
    if (!band || band === DISTRICT_LIGHTING_BANDS[2]) return 0;
    return Math.abs(1 - band);
}

// Parallax rain: the streak budget is split across three depth layers so rain
// stops reading as one rigid sheet. Fractions sum to 1 so total segment count
// stays ~equal to the old single-layer pass. Each layer scrolls on its own
// fall offset (speedMul) with distinct length/alpha/lineWidth and a slightly
// different wind multiplier. saltOffset keeps the seeded streak positions
// disjoint between layers.
const RAIN_LAYERS = [
    { frac: 0.45, speedMul: 0.72, lengthMul: 0.78, alphaMul: 0.56, lineWidth: 1, windMul: 0.82, saltOffset: 0 },
    { frac: 0.35, speedMul: 1.0, lengthMul: 1.0, alphaMul: 0.82, lineWidth: 1, windMul: 1.0, saltOffset: 1300 },
    { frac: 0.2, speedMul: 1.4, lengthMul: 1.34, alphaMul: 1.0, lineWidth: 1.6, windMul: 1.18, saltOffset: 2600 },
];

export class WeatherRenderer {
    constructor({ assets = null, canvasFactory = null } = {}) {
        this.assets = assets;
        this.districtContext = null;
        this._canvasFactory = typeof canvasFactory === 'function'
            ? canvasFactory
            : () => (typeof document !== 'undefined' ? document.createElement('canvas') : null);
        this._districtWashTextures = new Map();
        this._lastDistrictDrawCount = 0;
        this.elapsedMs = 0;
        this._lastSplashStamp = 0;
        this._splashStampSeed = 0;
        this._rippleStampTimes = new Map();
        this._washStrip = null;
        this._washStripKey = '';
        this._allowEmbellishment = true;
    }

    setAssets(assets) {
        this.assets = assets || null;
    }

    setDistrictContext(context) {
        this.districtContext = context || null;
    }

    drawForeground(ctx, {
        canvas = ctx?.canvas,
        atmosphere = null,
        dt = 16,
        profileMark = null,
    } = {}) {
        if (!ctx || !canvas || !canvas.width || !canvas.height) return;

        // District atmosphere is a static information layer, not weather
        // motion. It remains visible under reduced motion and claims no pulse
        // band, timers, particles, or per-frame animation state.
        this._drawDistrictAtmosphere(ctx, atmosphere);

        const weather = normalizeWeather(atmosphere);
        if (!weather) return;

        const precipitation = clamp(weather.precipitation, 0, 1);
        const fog = clamp(weather.fog, 0, 1);
        const cloudCover = clamp(weather.cloudCover, 0, 1);
        const legibility = weatherLegibilityGate(weather, atmosphere);
        const hasForegroundWeather = weather.intensity > 0
            && (!CLEAR_TYPES.has(weather.type) || precipitation > 0.02 || fog > 0.04 || cloudCover > 0.72);
        if (!hasForegroundWeather) return;

        const particleEnabled = atmosphere?.motion?.particleEnabled !== false;
        const pressure = sampleFramePressure();
        this._allowEmbellishment = weatherEmbellishmentAllowed(pressure.level);
        if (particleEnabled) {
            const frameDt = Math.max(0, Math.min(MAX_FRAME_DT, Number(dt) || 0));
            this.elapsedMs = (this.elapsedMs + frameDt) % LOOP_MS;
        }

        const seed = seedFromAtmosphere(atmosphere, weather);
        const phaseMs = particleEnabled
            ? this.elapsedMs
            : Math.floor(random01(seed, 401) * LOOP_MS);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const washBudget = Math.min(1, 0.72 + (1 - fog) * 0.18) * legibility.wash;

        const overcastIntensity = weather.type === 'overcast' || cloudCover > 0.72
            ? Math.max(weather.intensity * 0.72, cloudCover * 0.54) * washBudget
            : 0;
        const fogActive = fog > 0.04 || weather.type === 'fog';
        const fogIntensity = fogActive
            ? Math.max(fog, weather.type === 'fog' ? weather.intensity : 0) * legibility.fog
            : 0;
        const rainActive = RAIN_TYPES.has(weather.type) || precipitation > 0.02;
        const rainOvercastIntensity = rainActive
            ? Math.min(
                1,
                Math.max(cloudCover, weather.intensity)
                    * (weather.type === 'storm' ? 0.56 : 0.42),
            ) * washBudget
            : 0;
        this._drawWeatherWash(
            ctx,
            canvas,
            overcastIntensity,
            fogIntensity * washBudget,
            rainOvercastIntensity,
        );
        profileMark?.('weather-wash');

        if (fogActive && this._allowEmbellishment) {
            this._drawFogBands(ctx, canvas, fogIntensity, phaseMs, seed, particleEnabled);
        }
        profileMark?.('weather-fog-bands');

        if (rainActive) {
            const storm = weather.type === 'storm';
            const rainIntensity = Math.max(precipitation, weather.intensity * (storm ? 0.86 : 0.72)) * legibility.rain;
            // Winter (Dec–Feb) swaps rain streaks for drifting snow — presentation
            // only; storm flash/lightning below still fires.
            if (isWinterMonth(atmosphere)) {
                this._drawSnow(ctx, canvas, { ...weather, intensity: rainIntensity }, phaseMs, seed, particleEnabled);
            } else {
                this._drawRain(ctx, canvas, { ...weather, intensity: rainIntensity }, phaseMs, seed, particleEnabled);
            }
            if (storm && particleEnabled) {
                this._drawStormFlash(ctx, canvas, Math.max(weather.intensity, precipitation) * legibility.flash, seed, weather.cause);
            }
        } else if (this._allowEmbellishment && weather.type === 'overcast' && fog <= 0.04) {
            this._drawFogBands(ctx, canvas, weather.intensity * 0.34, phaseMs, seed, particleEnabled);
        }
        profileMark?.('weather-precipitation');

        ctx.restore();
    }

    draw(ctx, options = {}) {
        this.drawForeground(ctx, options);
    }

    dispose() {
        this.elapsedMs = 0;
        this._lastSplashStamp = 0;
        this._splashStampSeed = 0;
        this._rippleStampTimes.clear();
        for (const ratios of this._districtWashTextures.values()) {
            for (const texture of ratios.values()) {
                texture.width = 0;
                texture.height = 0;
            }
            ratios.clear();
        }
        this._districtWashTextures.clear();
        this.districtContext = null;
        if (this._washStrip) {
            this._washStrip.width = 0;
            this._washStrip.height = 0;
        }
        this._washStrip = null;
        this._washStripKey = '';
    }

    _drawDistrictAtmosphere(ctx, atmosphere) {
        this._lastDistrictDrawCount = 0;
        const districts = atmosphere?.districtAtmosphere;
        const camera = this.districtContext?.camera;
        const sprites = this.districtContext?.agentSprites;
        if (!Array.isArray(districts) || !districts.length || !camera || !sprites?.get) return;

        const zoom = Math.max(0.1, Number(camera.zoom) || 1);
        const cameraX = Number(camera.x) || 0;
        const cameraY = Number(camera.y) || 0;
        for (let districtIndex = 0; districtIndex < districts.length; districtIndex++) {
            const district = districts[districtIndex];
            const agentIds = district?.agentIds;
            if (!Array.isArray(agentIds) || !agentIds.length) continue;

            let centerX = 0;
            let centerY = 0;
            let occupantCount = 0;
            for (let agentIndex = 0; agentIndex < agentIds.length; agentIndex++) {
                const sprite = sprites.get(agentIds[agentIndex]);
                if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
                centerX += sprite.x;
                centerY += sprite.y;
                occupantCount++;
            }
            if (!occupantCount) continue;
            centerX /= occupantCount;
            centerY /= occupantCount;

            let footprintRadius = 0;
            for (let agentIndex = 0; agentIndex < agentIds.length; agentIndex++) {
                const sprite = sprites.get(agentIds[agentIndex]);
                if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
                const distance = Math.hypot(sprite.x - centerX, sprite.y - centerY);
                if (distance > footprintRadius) footprintRadius = distance;
            }

            const innerTiles = Math.max(0, Number(district?.falloff?.innerRadiusTiles) || 0);
            const outerTiles = Math.max(innerTiles + 0.1, Number(district?.falloff?.outerRadiusTiles) || 0);
            const radiusX = (footprintRadius + outerTiles * DISTRICT_TILE_RADIUS_X) * zoom;
            const radiusY = (footprintRadius * 0.5 + outerTiles * DISTRICT_TILE_RADIUS_Y) * zoom;
            const innerRatio = clamp(
                (footprintRadius + innerTiles * DISTRICT_TILE_RADIUS_X)
                    / Math.max(1, footprintRadius + outerTiles * DISTRICT_TILE_RADIUS_X),
                0,
                0.95,
            );
            const screenX = (centerX + cameraX) * zoom;
            const screenY = (centerY + cameraY + 5) * zoom;
            const hazeAlpha = clamp(Number(district?.groundHaze?.alpha) || 0, 0, 1);
            const cool = normalizedDistrictLightingBand(district?.lightingBias?.cool, 'cool');
            const warm = normalizedDistrictLightingBand(district?.lightingBias?.warm, 'warm');
            const dim = normalizedDistrictLightingBand(district?.lightingBias?.dim, 'dim');

            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            if (hazeAlpha > 0.002) {
                this._drawDistrictWash(
                    ctx,
                    district.groundHaze?.tint || DISTRICT_COOL_TINT,
                    innerRatio,
                    hazeAlpha,
                    screenX,
                    screenY,
                    radiusX,
                    radiusY,
                );
            }
            if (cool && cool !== DISTRICT_LIGHTING_BANDS[2]) {
                this._drawDistrictLighting(
                    ctx,
                    DISTRICT_COOL_TINT,
                    innerRatio,
                    cool,
                    screenX,
                    screenY,
                    radiusX,
                    radiusY,
                );
            }
            if (warm && warm !== DISTRICT_LIGHTING_BANDS[2]) {
                this._drawDistrictLighting(
                    ctx,
                    DISTRICT_WARM_TINT,
                    innerRatio,
                    warm,
                    screenX,
                    screenY,
                    radiusX,
                    radiusY,
                );
            }
            if (dim && dim !== DISTRICT_LIGHTING_BANDS[2]) {
                this._drawDistrictLighting(
                    ctx,
                    DISTRICT_DIM_TINT,
                    innerRatio,
                    dim,
                    screenX,
                    screenY,
                    radiusX,
                    radiusY,
                );
            }
            ctx.restore();
            this._lastDistrictDrawCount++;
        }
    }

    _drawDistrictWash(ctx, tint, innerRatio, alpha, x, y, radiusX, radiusY) {
        const texture = this._districtWashTexture(tint, innerRatio);
        if (!texture || radiusX <= 0 || radiusY <= 0) return;
        ctx.globalAlpha = alpha;
        ctx.drawImage(texture, x - radiusX, y - radiusY, radiusX * 2, radiusY * 2);
        ctx.globalAlpha = 1;
    }

    _drawDistrictLighting(ctx, tint, innerRatio, band, x, y, radiusX, radiusY) {
        const strength = districtLightingStrength(band);
        if (!strength || radiusX <= 0 || radiusY <= 0) return;
        const texture = this._districtLightingTexture(tint, innerRatio, band);
        if (!texture) return;
        ctx.globalCompositeOperation = band < DISTRICT_LIGHTING_BANDS[2] ? 'multiply' : 'screen';
        ctx.globalAlpha = strength;
        ctx.drawImage(texture, x - radiusX, y - radiusY, radiusX * 2, radiusY * 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }

    _districtWashTexture(tint, innerRatio) {
        const ratioBucket = Math.round(clamp(innerRatio, 0, 0.95) * 20) / 20;
        let ratios = this._districtWashTextures.get(tint);
        if (!ratios) {
            ratios = new Map();
            this._districtWashTextures.set(tint, ratios);
        }
        const cached = ratios.get(ratioBucket);
        if (cached) return cached;
        const canvas = this._canvasFactory();
        if (!canvas) return null;
        canvas.width = DISTRICT_TEXTURE_SIZE;
        canvas.height = DISTRICT_TEXTURE_SIZE;
        const textureCtx = canvas.getContext?.('2d');
        if (!textureCtx?.createRadialGradient) return null;
        const radius = DISTRICT_TEXTURE_SIZE / 2;
        const gradient = textureCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        const span = 1 - ratioBucket;
        gradient.addColorStop(0, `rgba(${tint}, 1)`);
        gradient.addColorStop(ratioBucket, `rgba(${tint}, 1)`);
        // Five samples approximate 1-smoothstep across the contract's broad
        // falloff without allocating gradients in the render hot path.
        gradient.addColorStop(ratioBucket + span * 0.25, `rgba(${tint}, 0.844)`);
        gradient.addColorStop(ratioBucket + span * 0.5, `rgba(${tint}, 0.5)`);
        gradient.addColorStop(ratioBucket + span * 0.75, `rgba(${tint}, 0.156)`);
        gradient.addColorStop(1, `rgba(${tint}, 0)`);
        textureCtx.fillStyle = gradient;
        textureCtx.fillRect(0, 0, DISTRICT_TEXTURE_SIZE, DISTRICT_TEXTURE_SIZE);
        ratios.set(ratioBucket, canvas);
        this._trimDistrictTextureCache();
        return canvas;
    }

    _districtLightingTexture(tint, innerRatio, band) {
        const ratioBucket = Math.round(clamp(innerRatio, 0, 0.95) * 20) / 20;
        const tintKey = `lighting:${tint}`;
        let ratios = this._districtWashTextures.get(tintKey);
        if (!ratios) {
            ratios = new Map();
            this._districtWashTextures.set(tintKey, ratios);
        }
        const key = `${ratioBucket}|${band}`;
        const cached = ratios.get(key);
        if (cached) return cached;
        const canvas = this._canvasFactory();
        if (!canvas) return null;
        canvas.width = DISTRICT_TEXTURE_SIZE;
        canvas.height = DISTRICT_TEXTURE_SIZE;
        const textureCtx = canvas.getContext?.('2d');
        if (!textureCtx?.createRadialGradient) return null;
        const radius = DISTRICT_TEXTURE_SIZE / 2;
        const gradient = textureCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        const span = 1 - ratioBucket;
        const course = band < DISTRICT_LIGHTING_BANDS[2] ? band : 1;
        const color = alpha => `rgba(${tint}, ${alpha})`;
        gradient.addColorStop(0, color(1));
        gradient.addColorStop(ratioBucket, color(1));
        // Duplicate the stops over a tiny pixel-sized interval. The district
        // lighting response changes course in discrete rings; only haze keeps
        // the smooth five-stop falloff above.
        const addStep = (offset, from, to) => {
            const safe = clamp(offset, 0, 0.999);
            gradient.addColorStop(safe, color(from));
            gradient.addColorStop(Math.min(1, safe + 0.001), color(to));
        };
        addStep(ratioBucket + span * 0.25, 1, course);
        addStep(ratioBucket + span * 0.50, course, course);
        addStep(ratioBucket + span * 0.75, course, course);
        gradient.addColorStop(1, color(0));
        textureCtx.fillStyle = gradient;
        textureCtx.fillRect(0, 0, DISTRICT_TEXTURE_SIZE, DISTRICT_TEXTURE_SIZE);
        ratios.set(key, canvas);
        this._trimDistrictTextureCache();
        return canvas;
    }

    _trimDistrictTextureCache() {
        let count = 0;
        for (const ratios of this._districtWashTextures.values()) count += ratios.size;
        if (count <= DISTRICT_TEXTURE_CACHE_LIMIT) return;
        const firstTint = this._districtWashTextures.keys().next().value;
        const ratios = this._districtWashTextures.get(firstTint);
        const firstRatio = ratios?.keys().next().value;
        const texture = ratios?.get(firstRatio);
        if (texture) {
            texture.width = 0;
            texture.height = 0;
        }
        ratios?.delete(firstRatio);
        if (!ratios?.size) this._districtWashTextures.delete(firstTint);
    }

    _drawWeatherWash(ctx, canvas, overcastIntensity, fogIntensity, rainOvercastIntensity = 0) {
        const hasOvercast = clamp(overcastIntensity, 0, 1) * 0.14 > 0.005;
        const hasFog = clamp(fogIntensity, 0, 1) * 0.12 > 0.005;
        const hasRainOvercast = clamp(rainOvercastIntensity, 0, 1) * 0.14 > 0.005;
        if (!hasOvercast && !hasRainOvercast) {
            if (hasFog) this._drawFogWash(ctx, canvas, fogIntensity);
            return;
        }
        if ((!hasFog && !hasRainOvercast) || typeof document === 'undefined') {
            if (hasOvercast) this._drawOvercast(ctx, canvas, overcastIntensity);
            if (hasFog) this._drawFogWash(ctx, canvas, fogIntensity);
            if (hasRainOvercast) this._drawOvercast(ctx, canvas, rainOvercastIntensity);
            return;
        }

        // Both washes vary only vertically, so a 1px-wide strip preserves their
        // source-over composition while replacing two full-canvas fills with one.
        const height = Math.max(1, Math.round(canvas.height));
        const key = `${height}|${overcastIntensity}|${fogIntensity}|${rainOvercastIntensity}`;
        if (!this._washStrip || this._washStrip.height !== height) {
            this._washStrip = document.createElement('canvas');
            this._washStrip.width = 1;
            this._washStrip.height = height;
            this._washStripKey = '';
        }
        if (this._washStripKey !== key) {
            const stripCtx = this._washStrip.getContext('2d');
            stripCtx.clearRect(0, 0, 1, height);
            stripCtx.globalAlpha = 1;
            stripCtx.globalCompositeOperation = 'source-over';
            if (hasOvercast) this._drawOvercast(stripCtx, this._washStrip, overcastIntensity);
            if (hasFog) this._drawFogWash(stripCtx, this._washStrip, fogIntensity);
            if (hasRainOvercast) this._drawOvercast(stripCtx, this._washStrip, rainOvercastIntensity);
            this._washStripKey = key;
        }
        ctx.drawImage(this._washStrip, 0, 0, 1, height, 0, 0, canvas.width, canvas.height);
    }

    _drawOvercast(ctx, canvas, intensity) {
        const alpha = clamp(intensity, 0, 1) * 0.14;
        if (alpha <= 0.005) return;

        const wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
        wash.addColorStop(0, `rgba(65, 78, 88, ${alpha * 0.70})`);
        wash.addColorStop(0.45, `rgba(54, 66, 72, ${alpha * 0.42})`);
        wash.addColorStop(1, `rgba(35, 40, 44, ${alpha})`);
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawFogWash(ctx, canvas, intensity) {
        const alpha = clamp(intensity, 0, 1) * 0.12;
        if (alpha <= 0.005) return;

        const wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
        wash.addColorStop(0, 'rgba(210, 225, 224, 0)');
        wash.addColorStop(0.36, `rgba(202, 218, 216, ${alpha * 0.28})`);
        wash.addColorStop(1, `rgba(213, 225, 220, ${alpha})`);
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    _drawRain(ctx, canvas, weather, phaseMs, seed, particleEnabled) {
        const intensity = clamp(weather.intensity, 0, 1);
        const area = canvas.width * canvas.height;
        const density = weather.type === 'storm' ? 1.28 : 1;
        const animatedScale = particleEnabled ? 1 : 0.42;
        const embellishScale = this._allowEmbellishment ? 1 : 0.62;
        const count = Math.min(
            RAIN_MAX_STREAKS,
            Math.max(
                RAIN_MIN_STREAKS,
                Math.floor((area / RAIN_AREA_DENSITY) * (0.35 + intensity * 0.95) * density * animatedScale * embellishScale),
            ),
        );

        const windValue = Number(weather.windX);
        const windX = clamp(Number.isFinite(windValue) ? windValue : -0.46, -1.4, 1.4);
        const pad = 48;
        const travel = canvas.height + pad * 2;
        const speed = particleEnabled ? (0.42 + intensity * 0.34) : 0;
        const alpha = (particleEnabled ? 0.22 : 0.14) + intensity * (weather.type === 'storm' ? 0.18 : 0.12);
        const strokeAlpha = Math.min(0.48, alpha);

        ctx.save();
        if (!particleEnabled) {
            // Reduced motion: a single static streak layer (no parallax).
            this._drawRainStreakLayer(ctx, canvas, {
                count, seed, windX, pad, travel, fall: 0,
                lengthMul: 1, windMul: 1, lineWidth: 1, strokeAlpha, saltOffset: 0,
            });
        } else {
            for (const layer of RAIN_LAYERS) {
                const layerCount = Math.round(count * layer.frac);
                if (layerCount <= 0) continue;
                this._drawRainStreakLayer(ctx, canvas, {
                    count: layerCount,
                    seed,
                    windX,
                    pad,
                    travel,
                    fall: (phaseMs * speed * layer.speedMul) % travel,
                    lengthMul: layer.lengthMul,
                    windMul: layer.windMul,
                    lineWidth: layer.lineWidth,
                    strokeAlpha: Math.min(0.48, strokeAlpha * layer.alphaMul),
                    saltOffset: layer.saltOffset,
                });
            }
        }

        if (this._allowEmbellishment && weather.type === 'storm' && intensity > 0.55) {
            const fall = (phaseMs * speed) % travel;
            ctx.lineWidth = 1;
            ctx.strokeStyle = `rgba(220, 236, 244, ${Math.min(0.34, intensity * 0.18)})`;
            ctx.beginPath();
            const highlightCount = Math.floor(count * 0.18);
            for (let i = 0; i < highlightCount; i++) {
                const idx = i * 5 + 3;
                const length = 12 + Math.floor(random01(seed, idx + 317) * 12);
                const xRand = random01(seed, idx + 419);
                const yRand = random01(seed, idx + 521);
                const y = ((yRand * travel + fall * 1.12) % travel) - pad;
                const rawX = xRand * (canvas.width + pad * 2) - pad + fall * windX * 0.42;
                const x = wrap(rawX, -pad, canvas.width + pad);
                ctx.moveTo(Math.round(x), Math.round(y));
                ctx.lineTo(Math.round(x + windX * length), Math.round(y + length));
            }
            ctx.stroke();
        }

        ctx.restore();

        // Traveling rain curtains: a few broad translucent sheets drifting on
        // the wind, only in heavy storms. `intensity` here is already scaled
        // by the legibility gate (legibility.rain), so a pressured/foggy scene
        // drops below the 0.7 threshold and the curtains never draw — keeping
        // the busy scene legible. Reduced motion skips this whole branch
        // (caller gates _drawStormFlash & curtains on particleEnabled).
        if (this._allowEmbellishment && weather.type === 'storm' && intensity > 0.7 && particleEnabled) {
            this._drawRainCurtains(ctx, canvas, { intensity, windX, phaseMs, seed });
        }

        if (this._allowEmbellishment && (weather.precipitation > SPLASH_PRECIP_THRESHOLD || intensity > SPLASH_PRECIP_THRESHOLD)) {
            this._drawRainSplashes(ctx, canvas, {
                intensity,
                precipitation: clamp(weather.precipitation, 0, 1),
                particleEnabled,
                seed,
            });
        }
    }

    // One parallax streak layer: seeded streaks strokd with the layer's own
    // fall offset, length, wind drift, lineWidth and alpha. saltOffset keeps
    // each layer's streak positions disjoint from the others.
    _drawRainStreakLayer(ctx, canvas, { count, seed, windX, pad, travel, fall, lengthMul, windMul, lineWidth, strokeAlpha, saltOffset }) {
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = `rgba(190, 218, 230, ${strokeAlpha})`;
        ctx.beginPath();
        const xSpan = canvas.width + pad * 2;
        for (let i = 0; i < count; i++) {
            const s = i + saltOffset;
            const length = (8 + Math.floor(random01(seed, s + 17) * 13)) * lengthMul;
            const xRand = random01(seed, s + 101);
            const yRand = random01(seed, s + 211);
            const y = ((yRand * travel + fall) % travel) - pad;
            const drift = fall * windX * 0.34 * windMul;
            const rawX = xRand * xSpan - pad + drift;
            const x = wrap(rawX, -pad, canvas.width + pad);
            const dx = Math.round(windX * length);
            const dy = length;
            ctx.moveTo(Math.round(x), Math.round(y));
            ctx.lineTo(Math.round(x + dx), Math.round(y + dy));
        }
        ctx.stroke();
    }

    // Winter precipitation: deterministic drifting flakes with a per-flake
    // sinusoidal x-sway and slow fall. No splash stamps, no rain curtains.
    // Reduced motion (particleEnabled false) snaps to a frozen flake field
    // (fall/sway zeroed) mirroring the static rain path.
    _drawSnow(ctx, canvas, weather, phaseMs, seed, particleEnabled) {
        const intensity = clamp(weather.intensity, 0, 1);
        const area = canvas.width * canvas.height;
        const density = weather.type === 'storm' ? 1.18 : 1;
        const animatedScale = particleEnabled ? 1 : 0.5;
        const count = Math.min(
            SNOW_MAX_FLAKES,
            Math.max(
                SNOW_MIN_FLAKES,
                Math.floor((area / (SNOW_AREA_DENSITY * 1.4)) * (0.35 + intensity * 0.85) * density * animatedScale),
            ),
        );

        const windValue = Number(weather.windX);
        const windX = clamp(Number.isFinite(windValue) ? windValue : -0.3, -1.4, 1.4);
        const pad = 24;
        const travel = canvas.height + pad * 2;
        const alpha = Math.min(0.7, (particleEnabled ? 0.42 : 0.3) + intensity * 0.28);
        const xSpan = canvas.width + pad * 2;

        ctx.save();
        ctx.fillStyle = `rgba(238, 246, 255, ${alpha})`;
        for (let i = 0; i < count; i++) {
            const xRand = random01(seed, i + 101);
            const yRand = random01(seed, i + 211);
            const fallSpeed = 0.08 + random01(seed, i + 331) * 0.08; // 0.08–0.16 px/ms
            const size = random01(seed, i + 419) < 0.3 ? 1 : 2;
            const fall = particleEnabled ? phaseMs * fallSpeed : 0;
            const y = ((yRand * travel + fall) % travel) - pad;
            const swayPhase = random01(seed, i + 521) * Math.PI * 2;
            const swayAmp = 4 + random01(seed, i + 617) * 6;
            const sway = particleEnabled ? Math.sin(phaseMs * 0.0016 + swayPhase) * swayAmp : 0;
            const drift = fall * windX * 0.06;
            const rawX = xRand * xSpan - pad + sway + drift;
            const x = wrap(rawX, -pad, canvas.width + pad);
            ctx.fillRect(Math.round(x), Math.round(y), size, size);
        }
        ctx.restore();
    }

    // 2–3 broad, soft vertical sheets drifting horizontally on the wind, each
    // phase-offset, to give a storm a sense of moving weather fronts crossing
    // the viewport. Cheap (one gradient fill per curtain), screen-composited,
    // alpha-capped to stay under the labels. Storm-only, animated-only.
    _drawRainCurtains(ctx, canvas, { intensity, windX, phaseMs, seed }) {
        const count = intensity > 0.86 ? 3 : 2;
        const baseAlpha = Math.min(0.12, 0.05 + (intensity - 0.7) * 0.22);
        if (baseAlpha <= 0.005) return;
        const span = canvas.width + canvas.width * 0.6;
        const drift = clamp(Number.isFinite(windX) ? windX : -0.46, -1.4, 1.4);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < count; i++) {
            const curtainSeed = i * 311;
            const width = canvas.width * (0.32 + random01(seed, curtainSeed + 7) * 0.22);
            const speed = 0.018 + random01(seed, curtainSeed + 13) * 0.014;
            const phase = random01(seed, curtainSeed + 19);
            // Move with the wind; wrap across an extended span so a curtain
            // re-enters from the upwind edge.
            const travel = (phaseMs * speed * drift) + phase * span;
            const cx = wrap(travel, -width, span) - width * 0.5;
            const alpha = baseAlpha * (0.7 + random01(seed, curtainSeed + 29) * 0.5);
            const grad = ctx.createLinearGradient(cx, 0, cx + width, 0);
            grad.addColorStop(0, 'rgba(186, 210, 230, 0)');
            grad.addColorStop(0.5, `rgba(196, 218, 236, ${alpha})`);
            grad.addColorStop(1, 'rgba(186, 210, 230, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(Math.round(cx), 0, Math.round(width), canvas.height);
        }
        ctx.restore();
    }

    _drawRainSplashes(ctx, canvas, { intensity, precipitation, particleEnabled, seed }) {
        if (!this._hasSplashSprite()) {
            this._drawProceduralSplashFallback(ctx, canvas, { intensity, precipitation, particleEnabled, seed });
            return;
        }

        if (!particleEnabled) {
            this._drawStaticSplashGrid(ctx, canvas, seed);
            return;
        }

        if (this.elapsedMs - this._lastSplashStamp < SPLASH_STAMP_INTERVAL_MS) return;
        this._lastSplashStamp = this.elapsedMs;
        this._splashStampSeed = (this._splashStampSeed + 1) >>> 0;

        const driveT = Math.min(1, Math.max(intensity, precipitation));
        const count = Math.round(
            SPLASH_STAMP_MIN_COUNT + (SPLASH_STAMP_MAX_COUNT - SPLASH_STAMP_MIN_COUNT) * driveT,
        );
        const stampSeed = (seed + Math.imul(this._splashStampSeed + 1, 0x85ebca6b)) >>> 0;
        const alpha = Math.min(0.42, 0.18 + driveT * 0.28);

        for (let i = 0; i < count; i++) {
            const x = random01(stampSeed, i + 11) * canvas.width;
            // Bias into the lower band so splashes land on the ground rather
            // than floating in the sky.
            const y = (0.35 + random01(stampSeed, i + 29) * 0.65) * canvas.height;
            const scale = 0.55 + random01(stampSeed, i + 53) * 0.45;
            const rotation = (random01(stampSeed, i + 71) - 0.5) * 0.5;
            this._stampSpriteAt(ctx, RAIN_SPLASH_SPRITE_ID, {
                x,
                y,
                alpha,
                scale,
                rotation,
            });
        }
    }

    _drawStaticSplashGrid(ctx, canvas, seed) {
        const cols = 4;
        const rows = 3;
        const colStep = canvas.width / (cols + 1);
        const rowStep = canvas.height / (rows + 1);
        let drawn = 0;
        for (let r = 1; r <= rows; r++) {
            for (let c = 1; c <= cols; c++) {
                if (drawn >= SPLASH_STATIC_GRID_COUNT) break;
                const idx = drawn;
                drawn++;
                const jitterX = (random01(seed, idx + 113) - 0.5) * colStep * 0.18;
                const jitterY = (random01(seed, idx + 191) - 0.5) * rowStep * 0.18;
                // Ground the grid into the lower band (rows map to 0.40–0.95 of
                // canvas height) so static splashes read as sitting on terrain.
                const y = canvas.height * (0.4 + (r / (rows + 1)) * 0.55) + jitterY;
                this._stampSpriteAt(ctx, RAIN_SPLASH_SPRITE_ID, {
                    x: c * colStep + jitterX,
                    y,
                    alpha: 0.22,
                    scale: 0.62,
                    rotation: -0.12,
                });
            }
        }
    }

    _drawProceduralSplashFallback(ctx, canvas, { intensity, precipitation, particleEnabled, seed }) {
        const driveT = Math.min(1, Math.max(intensity, precipitation));
        const count = particleEnabled
            ? Math.round(SPLASH_STAMP_MIN_COUNT + (SPLASH_STAMP_MAX_COUNT - SPLASH_STAMP_MIN_COUNT) * driveT)
            : SPLASH_STATIC_GRID_COUNT;
        if (count <= 0) return;
        const stampSeed = particleEnabled
            ? (seed + Math.floor(this.elapsedMs / SPLASH_STAMP_INTERVAL_MS) * 0x9e3779b1) >>> 0
            : seed;
        if (particleEnabled && this.elapsedMs - this._lastSplashStamp < SPLASH_STAMP_INTERVAL_MS) return;
        if (particleEnabled) this._lastSplashStamp = this.elapsedMs;
        const alpha = Math.min(0.32, 0.14 + driveT * 0.22);

        ctx.save();
        ctx.strokeStyle = `rgba(204, 232, 240, ${alpha})`;
        ctx.lineWidth = 1;
        for (let i = 0; i < count; i++) {
            const x = random01(stampSeed, i + 37) * canvas.width;
            const y = (0.35 + random01(stampSeed, i + 59) * 0.65) * canvas.height;
            const radius = 2 + random01(stampSeed, i + 83) * 2;
            ctx.beginPath();
            ctx.ellipse(Math.round(x), Math.round(y), radius, radius * 0.42, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Public stamp helper for IsometricRenderer's water draw loop. Stamps a
    // single rain ripple sprite at the supplied screen coordinates, throttled
    // per tile to avoid re-stamping the same water cell within 2 seconds. The
    // caller is responsible for selecting a small fraction of water tiles per
    // frame so the global ripple budget stays bounded. No-op when the sprite
    // is missing or the throttle is still active.
    maybeStampWaterRipple(ctx, tileX, tileY, tileScreenX, tileScreenY) {
        if (!ctx || !this._hasRippleSprite()) return false;
        const key = `${tileX | 0},${tileY | 0}`;
        const now = this.elapsedMs;
        const last = this._rippleStampTimes.get(key);
        if (last !== undefined && now - last < RIPPLE_TILE_THROTTLE_MS) return false;
        this._trackRippleStamp(key, now);
        this._stampSpriteAt(ctx, RAIN_RIPPLE_SPRITE_ID, {
            x: tileScreenX,
            y: tileScreenY,
            alpha: 0.28,
            scale: 1,
        });
        return true;
    }

    _hasSplashSprite() {
        return Boolean(this.assets?.has?.(RAIN_SPLASH_SPRITE_ID));
    }

    _hasRippleSprite() {
        return Boolean(this.assets?.has?.(RAIN_RIPPLE_SPRITE_ID));
    }

    _stampSpriteAt(ctx, id, { x, y, alpha = 1, scale = 1, rotation = 0 } = {}) {
        if (!ctx || !this.assets || alpha <= 0.005) return false;
        const img = this.assets.get?.(id);
        if (!img) return false;
        const dims = this.assets.getDims?.(id) || { w: img.width || 0, h: img.height || 0 };
        if (!dims.w || !dims.h) return false;
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(Math.round(x), Math.round(y));
        if (rotation) ctx.rotate(rotation);
        if (scale !== 1) ctx.scale(scale, scale);
        ctx.drawImage(img, Math.round(-dims.w / 2), Math.round(-dims.h / 2));
        ctx.restore();
        return true;
    }

    _trackRippleStamp(key, nowMs) {
        if (this._rippleStampTimes.size >= RIPPLE_TILE_TRACK_LIMIT) {
            // Cheap GC: evict the oldest half when we hit the cap so the map
            // does not grow unbounded across long sessions.
            const cutoff = nowMs - RIPPLE_TILE_THROTTLE_MS;
            for (const [k, t] of this._rippleStampTimes) {
                if (t < cutoff) this._rippleStampTimes.delete(k);
            }
            if (this._rippleStampTimes.size >= RIPPLE_TILE_TRACK_LIMIT) {
                const drop = Math.ceil(this._rippleStampTimes.size / 2);
                let i = 0;
                for (const k of this._rippleStampTimes.keys()) {
                    if (i++ >= drop) break;
                    this._rippleStampTimes.delete(k);
                }
            }
        }
        this._rippleStampTimes.set(key, nowMs);
    }

    _drawFogBands(ctx, canvas, intensity, phaseMs, seed, particleEnabled) {
        const alphaBase = clamp(intensity, 0, 1) * (particleEnabled ? 0.12 : 0.075);
        if (alphaBase <= 0.005) return;

        const count = Math.min(
            FOG_MAX_BANDS,
            Math.max(FOG_MIN_BANDS, Math.floor(canvas.height / 150) + Math.ceil(intensity * 3)),
        );
        const drift = particleEnabled ? phaseMs * 0.012 : 0;

        ctx.save();
        for (let i = 0; i < count; i++) {
            const bandSeed = i * 97;
            const bandHeight = 18 + random01(seed, bandSeed + 11) * 42;
            const lowerBias = Math.pow(random01(seed, bandSeed + 23), 0.56);
            const yBase = canvas.height * (FOG_BAND_Y_RANGE.min
                + lowerBias * (FOG_BAND_Y_RANGE.max - FOG_BAND_Y_RANGE.min));
            const y = Math.round(yBase + Math.sin(i * 1.7 + phaseMs * 0.0008) * (particleEnabled ? 5 : 0));
            const width = canvas.width * (0.58 + random01(seed, bandSeed + 37) * 0.56);
            const xDrift = drift * (0.32 + random01(seed, bandSeed + 41) * 0.52);
            const x = wrap(
                random01(seed, bandSeed + 53) * canvas.width - width * 0.5 + xDrift,
                -width,
                canvas.width,
            );
            const labelZoneGuard = y < canvas.height * 0.34 ? 0.36 : y < canvas.height * 0.48 ? 0.68 : 1;
            const alpha = alphaBase * labelZoneGuard * (0.45 + random01(seed, bandSeed + 67) * 0.55);

            this._drawFogBand(ctx, x, y, width, bandHeight, alpha);
            if (x + width < canvas.width) {
                this._drawFogBand(ctx, x + width + canvas.width * 0.18, y, width, bandHeight, alpha * 0.72);
            }
        }
        ctx.restore();
    }

    _drawFogBand(ctx, x, y, width, height, alpha) {
        const grad = ctx.createLinearGradient(x, 0, x + width, 0);
        grad.addColorStop(0, 'rgba(218, 228, 224, 0)');
        grad.addColorStop(0.18, `rgba(218, 228, 224, ${alpha * 0.58})`);
        grad.addColorStop(0.52, `rgba(225, 232, 228, ${alpha})`);
        grad.addColorStop(0.86, `rgba(218, 228, 224, ${alpha * 0.46})`);
        grad.addColorStop(1, 'rgba(218, 228, 224, 0)');

        ctx.fillStyle = grad;
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
    }

    _drawStormFlash(ctx, canvas, intensity, seed, cause = 'timeline') {
        const cycleMs = 7200;
        const cycle = Math.floor(this.elapsedMs / cycleMs);
        const cycleT = this.elapsedMs % cycleMs;
        const chance = random01(seed, cycle + 701);
        if (chance > 0.18 + intensity * 0.10) return;

        const offset = 900 + random01(seed, cycle + 809) * 4700;
        const age = cycleT - offset;
        const secondAge = cycleT - offset - 170;
        const flashAge = age >= 0 && age < 110 ? age : secondAge >= 0 && secondAge < 70 ? secondAge : -1;
        if (flashAge < 0) return;

        const windowMs = flashAge === age ? 110 : 70;
        const flashT = 1 - flashAge / windowMs;
        const alpha = flashT * clamp(intensity, 0, 1) * 0.18;
        if (alpha <= 0.005) return;

        // Announce each strike once (on the primary flash of the pair) so the
        // ambient audio can roll thunder after the visible lightning.
        if (flashAge === age && this._lastFlashCycle !== cycle) {
            this._lastFlashCycle = cycle;
            eventBus.emit('weather:storm-flash', { intensity: clamp(intensity, 0, 1) });
        }

        // 5.5 — fleet-driven storms (weather.cause === 'fleet') flash a subtle
        // violet vs the timeline storm's cool white.
        const fleet = cause === 'fleet';
        const flash = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        flash.addColorStop(0, fleet ? `rgba(216, 196, 255, ${alpha})` : `rgba(220, 236, 255, ${alpha})`);
        flash.addColorStop(0.55, fleet ? `rgba(228, 214, 255, ${alpha * 0.58})` : `rgba(235, 242, 255, ${alpha * 0.58})`);
        flash.addColorStop(1, fleet ? 'rgba(216, 196, 255, 0)' : 'rgba(220, 236, 255, 0)');
        ctx.fillStyle = flash;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // The primary strike of each flash pair carries a forked bolt; the
        // dimmer afterglow (secondAge) is sky-glow only. Brighter at the peak
        // of the flash envelope so the bolt reads as the source of the light.
        if (flashAge === age && flashT > 0.32) {
            this._drawLightningBolt(ctx, canvas, flashT * clamp(intensity, 0, 1), seed, cycle, fleet);
        }
    }

    // Procedural forked bolt via midpoint displacement. Deterministic per
    // strike (seed + cycle) so it is identical across the brief multi-frame
    // flash window. Drawn screen-composite over the flash wash.
    _drawLightningBolt(ctx, canvas, strength, seed, cycle, fleet = false) {
        const boltSeed = (seed + Math.imul(cycle + 1, 0x27d4eb2f)) >>> 0;
        const startX = Math.round(canvas.width * (0.32 + random01(boltSeed, 11) * 0.36));
        const endX = startX + Math.round((random01(boltSeed, 23) - 0.5) * canvas.width * 0.22);
        const endY = Math.round(canvas.height * (0.46 + random01(boltSeed, 37) * 0.18));
        const points = this._displaceBolt(
            { x: startX, y: 0 },
            { x: endX, y: endY },
            boltSeed,
            5,
            canvas.width * 0.05,
        );

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Soft outer glow, then a crisp bright core.
        const drawPath = (pts) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(pts[0].x), Math.round(pts[0].y));
            for (let i = 1; i < pts.length; i++) ctx.lineTo(Math.round(pts[i].x), Math.round(pts[i].y));
            ctx.stroke();
        };

        ctx.strokeStyle = fleet
            ? `rgba(198, 168, 255, ${Math.min(0.5, strength * 0.55)})`
            : `rgba(176, 206, 255, ${Math.min(0.5, strength * 0.55)})`;
        ctx.lineWidth = 5;
        drawPath(points);

        // 2 short branches forking off interior nodes.
        const branchCount = 2 + (random01(boltSeed, 53) > 0.6 ? 1 : 0);
        for (let b = 0; b < branchCount; b++) {
            const anchor = points[1 + ((b + 1) % (points.length - 2))];
            if (!anchor) continue;
            const len = canvas.height * (0.06 + random01(boltSeed, b + 61) * 0.08);
            const ang = (random01(boltSeed, b + 71) - 0.5) * 1.4 + Math.PI / 2;
            const branch = this._displaceBolt(
                anchor,
                { x: anchor.x + Math.cos(ang) * len, y: anchor.y + Math.sin(ang) * len },
                (boltSeed + b * 131) >>> 0,
                3,
                canvas.width * 0.02,
            );
            ctx.strokeStyle = fleet
                ? `rgba(206, 182, 255, ${Math.min(0.34, strength * 0.36)})`
                : `rgba(190, 216, 255, ${Math.min(0.34, strength * 0.36)})`;
            ctx.lineWidth = 2.5;
            drawPath(branch);
        }

        ctx.strokeStyle = fleet
            ? `rgba(246, 240, 255, ${Math.min(0.92, 0.4 + strength * 0.55)})`
            : `rgba(244, 250, 255, ${Math.min(0.92, 0.4 + strength * 0.55)})`;
        ctx.lineWidth = 1.6;
        drawPath(points);
        ctx.restore();
    }

    // Recursive midpoint displacement between two endpoints.
    _displaceBolt(a, b, seed, depth, jitter) {
        let segments = [a, b];
        let amplitude = jitter;
        for (let d = 0; d < depth; d++) {
            const next = [segments[0]];
            for (let i = 0; i < segments.length - 1; i++) {
                const p = segments[i];
                const q = segments[i + 1];
                const mx = (p.x + q.x) / 2;
                const my = (p.y + q.y) / 2;
                const off = (random01(seed, d * 211 + i * 17 + 3) - 0.5) * amplitude;
                // Displace perpendicular to the segment so the bolt zig-zags.
                const dx = q.x - p.x;
                const dy = q.y - p.y;
                const len = Math.hypot(dx, dy) || 1;
                next.push({ x: mx + (-dy / len) * off, y: my + (dx / len) * off });
                next.push(q);
            }
            segments = next;
            amplitude *= 0.5;
        }
        return segments;
    }
}

function normalizeWeather(atmosphere) {
    const raw = atmosphere?.weather;
    const rawType = typeof raw === 'string'
        ? raw
        : raw?.type || atmosphere?.weatherType || atmosphere?.type || 'clear';
    const type = normalizeType(rawType);
    const rawIntensity = typeof raw === 'object' && raw
        ? raw.intensity
        : atmosphere?.intensity;
    const intensity = clamp(
        Number.isFinite(Number(rawIntensity))
            ? Number(rawIntensity)
            : DEFAULT_INTENSITY[type] || 0,
        0,
        1,
    );
    const preset = WEATHER_PRESETS[type] || WEATHER_PRESETS.clear;
    const windX = typeof raw === 'object' && raw ? raw.windX : atmosphere?.windX;
    const cloudCover = typeof raw === 'object' && raw && Number.isFinite(Number(raw.cloudCover))
        ? Number(raw.cloudCover)
        : preset.cloudCover;
    const precipitation = typeof raw === 'object' && raw && Number.isFinite(Number(raw.precipitation))
        ? Number(raw.precipitation)
        : preset.precipitation;
    const fog = typeof raw === 'object' && raw && Number.isFinite(Number(raw.fog))
        ? Number(raw.fog)
        : preset.fog;
    const seed = typeof raw === 'object' && raw ? raw.seed : null;
    // 5.5 — fleet-driven storms (error-storminess dominating the event
    // influence) carry a violet cast on flash/lightning vs timeline storms.
    const cause = typeof raw === 'object' && raw && raw.cause === 'fleet' ? 'fleet' : 'timeline';

    return {
        type,
        intensity,
        windX,
        cloudCover: clamp(cloudCover, 0, 1),
        precipitation: clamp(precipitation, 0, 1),
        fog: clamp(fog, 0, 1),
        seed,
        cause,
    };
}

function weatherLegibilityGate(weather, atmosphere) {
    const weatherIntensity = clamp(Number(weather?.intensity) || 0, 0, 1);
    const fog = clamp(Number(weather?.fog) || 0, 0, 1);
    const precipitation = clamp(Number(weather?.precipitation) || 0, 0, 1);
    const pressure = Math.max(fog * 0.95, precipitation * 0.62, weatherIntensity * (weather?.type === 'storm' ? 0.7 : 0.42));
    const configured = Number(atmosphere?.weatherLegibilityScale ?? atmosphere?.legibility?.weatherScale);
    const explicitScale = Number.isFinite(configured) ? clamp(configured, 0.45, 1.15) : null;
    const base = explicitScale ?? clamp(1 - pressure * 0.28, 0.68, 1);
    return {
        wash: base,
        fog: clamp(base + 0.06, 0.72, 1),
        rain: clamp(base + 0.08, 0.74, 1),
        flash: clamp(base + 0.16, 0.78, 1),
    };
}

function isWinterMonth(atmosphere) {
    const localDate = atmosphere?.clock?.localDate;
    let month = NaN;
    if (typeof localDate === 'string' && localDate.length >= 7) {
        month = Number(localDate.slice(5, 7));
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
        const date = atmosphere?.effectiveDate;
        if (date instanceof Date) month = date.getMonth() + 1;
    }
    return month === 12 || month === 1 || month === 2;
}

function normalizeType(type) {
    const value = String(type || 'clear').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (value === 'cloudy') return 'overcast';
    if (value === 'stormy' || value === 'thunderstorm') return 'storm';
    if (value === 'partlycloudy') return 'partly-cloudy';
    if (WEATHER_TYPE_SET.has(value)) {
        return value;
    }
    return 'clear';
}

function seedFromAtmosphere(atmosphere, weather) {
    if (Number.isFinite(Number(weather?.seed))) return Number(weather.seed) >>> 0;
    const key = [
        atmosphere?.cacheKey || '',
        atmosphere?.phase || '',
        weather.type,
    ].join('|');
    return hashString(key || weather.type);
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

function wrap(value, min, max) {
    const size = max - min;
    if (size <= 0) return min;
    return ((((value - min) % size) + size) % size) + min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
