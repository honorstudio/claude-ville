// claudeville/src/presentation/character-mode/AtmosphereState.js
//
// Local-clock atmosphere snapshots for world rendering. This module is pure
// browser-local state: no geolocation, network weather, or render-loop time is
// used to decide semantic time of day.
//
// Snapshot field layout (top-level vs nested):
//   atmosphere.phase / phaseProgress / dayProgress  — semantic time-of-day
//                                                     (dawn/day/dusk/night)
//   atmosphere.clock.{hours,minutes,seconds,label,phase,phaseProgress}
//                                                   — wall-clock readout, with
//                                                     phase fields aliased onto
//                                                     the clock for ergonomic
//                                                     external consumers
//   atmosphere.weather                              — type + intensity + wind
//   atmosphere.sky / lighting / grade / motion      — render-time tints, tones,
//                                                     and motion budget
//
// The semantic phase fields exist at both the top level (canonical) AND nested
// under `clock` (alias). Prefer the top-level fields inside this module's
// renderer consumers; the nested aliases are for downstream tooling (HUDs,
// debug overlays) that already destructure `atmosphere.clock`.

import { seasonTokenForMonth } from './SeasonalAmbience.js';
import { AUTHORED_KEY_LIGHT } from './MaterialRegistry.js';

const DAY_MINUTES = 24 * 60;
const WEATHER_TIMELINE_KNOTS = 6;
// VillageDirector still supplies a legacy global roll. Values below this floor
// represent isolated agents (for example one troubled agent among five), not a
// village-wide condition, and must not tint the shared dome.
const SHARED_SKY_INFLUENCE_FLOOR = 0.2;
export const DISTRICT_LIGHTING_BANDS = AUTHORED_KEY_LIGHT.responseBands;

const DEFAULT_DISTRICT_ATMOSPHERE_BUFFER = {
    entries: [],
    pool: [],
};

const PHASES = [
    { name: 'dawn', start: 5 * 60 + 30, end: 7 * 60 },
    { name: 'day', start: 7 * 60, end: 17 * 60 + 30 },
    { name: 'dusk', start: 17 * 60 + 30, end: 20 * 60 },
    { name: 'night', start: 20 * 60, end: 5 * 60 + 30 },
];

// 5.4 — seasonal day-length modulation. PHASES is the equinox (spring/autumn)
// baseline; winter shifts sunrise later and sunset earlier, summer the
// reverse. The season comes from the shared month→season mapping in
// SeasonalAmbience so the sky clock stays in lockstep with seasonal terrain
// and drift particles. Offsets are minutes applied to the phase boundaries.
const SEASONAL_DAY_LENGTH_OFFSETS = {
    winter: { sunrise: 40, sunset: -55 },
    summer: { sunrise: -40, sunset: 55 },
};

const SOLAR_SHADOW_ANGLES = Object.freeze({
    dawnHorizon: -0.78,
    dawnMidpoint: -0.68,
    noon: 0.28,
    duskMidpoint: 0.72,
    duskHorizon: 0.82,
});

function phasesForSeason(seasonToken) {
    const offsets = SEASONAL_DAY_LENGTH_OFFSETS[seasonToken];
    if (!offsets) return PHASES;
    return PHASES.map((phase) => {
        let { start, end } = phase;
        if (phase.name === 'dawn') { start += offsets.sunrise; end += offsets.sunrise; }
        else if (phase.name === 'day') { start += offsets.sunrise; end += offsets.sunset; }
        else if (phase.name === 'dusk') { start += offsets.sunset; end += offsets.sunset; }
        else if (phase.name === 'night') { start += offsets.sunset; end += offsets.sunrise; }
        return { name: phase.name, start, end };
    });
}

// 1.8 — shared phase resolution for non-world surfaces (dashboard ambience
// sync): one canonical table + seasonal day-length logic, so the dashboard
// clock can never drift from the world sky. Returns the phase name only;
// render consumers keep using the full snapshot's phase/phaseProgress.
export function phaseNameForDate(date) {
    const minute = minutesSinceMidnight(date);
    const phases = phasesForSeason(seasonTokenForMonth(date.getMonth()));
    return resolvePhase(minute, phases).phase;
}

export const WEATHER_TYPES = ['clear', 'partly-cloudy', 'overcast', 'rain', 'fog', 'storm'];
const WEATHER_TYPE_SET = new Set(WEATHER_TYPES);

export const WEATHER_PRESETS = {
    clear: {
        intensity: 0.18,
        cloudAlpha: 0.12,
        cloudDensity: 0.16,
        cloudCover: 0.10,
        precipitation: 0,
        fog: 0,
        starOcclusion: 0,
        sunOcclusion: 0,
    },
    'partly-cloudy': {
        intensity: 0.48,
        cloudAlpha: 0.42,
        cloudDensity: 0.52,
        cloudCover: 0.42,
        precipitation: 0,
        fog: 0.02,
        starOcclusion: 0.28,
        sunOcclusion: 0.12,
    },
    overcast: {
        intensity: 0.68,
        cloudAlpha: 0.70,
        cloudDensity: 0.88,
        cloudCover: 0.86,
        precipitation: 0.04,
        fog: 0.08,
        starOcclusion: 0.94,
        sunOcclusion: 0.58,
    },
    rain: {
        intensity: 0.78,
        cloudAlpha: 0.76,
        cloudDensity: 0.96,
        cloudCover: 0.94,
        precipitation: 0.68,
        fog: 0.14,
        starOcclusion: 0.98,
        sunOcclusion: 0.68,
    },
    fog: {
        intensity: 0.58,
        cloudAlpha: 0.38,
        cloudDensity: 0.62,
        cloudCover: 0.60,
        precipitation: 0,
        fog: 0.78,
        starOcclusion: 0.72,
        sunOcclusion: 0.34,
    },
    storm: {
        intensity: 0.88,
        cloudAlpha: 0.84,
        cloudDensity: 1,
        cloudCover: 1,
        precipitation: 0.92,
        fog: 0.18,
        starOcclusion: 1,
        sunOcclusion: 0.82,
    },
};

const PALETTES = {
    dawn: {
        zenith: '#203c66',
        upperBand: '#537aa4',
        midBand: '#9eb7cf',
        horizon: '#e8b99f',
        horizonGlow: '234, 185, 159',
        starWarm: '#eaf3ff',
        starHot: '#b9d8ff',
    },
    day: {
        zenith: '#236eb8',
        upperBand: '#4aa0dd',
        midBand: '#86cdf0',
        horizon: '#d5f3ff',
        horizonGlow: '196, 235, 255',
        starWarm: '#eaf3ff',
        starHot: '#ffffff',
    },
    dusk: {
        zenith: '#1d325a',
        upperBand: '#566487',
        midBand: '#9b8199',
        horizon: '#d7a98e',
        horizonGlow: '215, 169, 142',
        starWarm: '#dbeaff',
        starHot: '#a9c7ff',
    },
    night: {
        zenith: '#040913',
        upperBand: '#08162d',
        midBand: '#102642',
        horizon: '#1d3f60',
        horizonGlow: '86, 139, 180',
        starWarm: '#c9ddff',
        starHot: '#f2f7ff',
    },
};

// 5.3 — `sun` is the manifest hook for a generated pixel-art sun asset. The
// SkyRenderer gates the lookup on assets.has(), so no manifest entry is
// required until the asset is actually baked (stepped-disc fallback till then).
const SKY_ASSETS = {
    clear: {
        clouds: ['atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
    'partly-cloudy': {
        clouds: ['atmosphere.cloud.cumulus.day', 'atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
    overcast: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
    rain: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
    storm: {
        clouds: ['atmosphere.cloud.storm-shelf', 'atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
    fog: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
        sun: 'atmosphere.sun',
    },
};

const CLOUD_LAYER_BANDS = [
    { yFrac: 0.16, parallax: 0.025, driftMul: 0.46, alphaMul: 0.62, scaleBase: 0.86 },
    { yFrac: 0.25, parallax: 0.060, driftMul: 0.78, alphaMul: 0.54, scaleBase: 1.05 },
    { yFrac: 0.35, parallax: 0.105, driftMul: 1.08, alphaMul: 0.38, scaleBase: 1.22 },
];

// Bounded descriptor cache. Several keys are live during a weather cross-fade
// window (incoming set, outgoing set, merged blend), so this is a small Map
// with oldest-entry eviction instead of a single slot. Keys are deterministic
// (date | type | cloud bucket [| weight bucket]), so rebuilds are rare and the
// map cannot grow across sessions.
const CLOUD_LAYER_CACHE_MAX = 8;
const _cloudLayerCache = new Map();

function cloudLayerCacheSet(key, layers) {
    _cloudLayerCache.set(key, layers);
    if (_cloudLayerCache.size > CLOUD_LAYER_CACHE_MAX) {
        const oldest = _cloudLayerCache.keys().next().value;
        _cloudLayerCache.delete(oldest);
    }
    return layers;
}

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
    const t = clamp(value);
    return t * t * (3 - 2 * t);
}

function minutesSinceMidnight(date) {
    return date.getHours() * 60
        + date.getMinutes()
        + date.getSeconds() / 60
        + date.getMilliseconds() / 60000;
}

function isWithinInterval(minute, start, end) {
    if (end >= start) return minute >= start && minute < end;
    return minute >= start || minute < end;
}

export function progressInInterval(minute, start, end) {
    let adjustedMinute = minute;
    let adjustedEnd = end;
    if (end < start) {
        adjustedEnd += DAY_MINUTES;
        if (adjustedMinute < start) adjustedMinute += DAY_MINUTES;
    }
    return clamp((adjustedMinute - start) / (adjustedEnd - start));
}

function easedSolarAngle(minute, start, end, fromAngle, toAngle) {
    return fromAngle + (toAngle - fromAngle) * smoothstep(progressInInterval(minute, start, end));
}

// One clock-derived solar pose for every directional-light consumer. The
// authored dawn, noon, and dusk angles remain calibration knots; smoothstep
// only eases travel between them, while elevation follows the sky's sine arc.
export function solarVectorForMinute(minuteOfDay, seasonToken = '') {
    const minuteValue = Number(minuteOfDay);
    const finiteMinute = Number.isFinite(minuteValue) ? minuteValue : 0;
    const minute = ((finiteMinute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    const phases = phasesForSeason(seasonToken);
    const dawn = phases[0];
    const dusk = phases[2];
    const sunriseMinute = dawn.start;
    const dawnMidpointMinute = (dawn.start + dawn.end) / 2;
    const sunsetMinute = dusk.end;
    const duskMidpointMinute = (dusk.start + dusk.end) / 2;
    const solarNoonMinute = (sunriseMinute + sunsetMinute) / 2;
    const isDaylight = minute >= sunriseMinute && minute <= sunsetMinute;

    let shadowAngleRad;
    if (isDaylight) {
        if (minute <= dawnMidpointMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                sunriseMinute,
                dawnMidpointMinute,
                SOLAR_SHADOW_ANGLES.dawnHorizon,
                SOLAR_SHADOW_ANGLES.dawnMidpoint,
            );
        } else if (minute <= solarNoonMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                dawnMidpointMinute,
                solarNoonMinute,
                SOLAR_SHADOW_ANGLES.dawnMidpoint,
                SOLAR_SHADOW_ANGLES.noon,
            );
        } else if (minute <= duskMidpointMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                solarNoonMinute,
                duskMidpointMinute,
                SOLAR_SHADOW_ANGLES.noon,
                SOLAR_SHADOW_ANGLES.duskMidpoint,
            );
        } else {
            shadowAngleRad = easedSolarAngle(
                minute,
                duskMidpointMinute,
                sunsetMinute,
                SOLAR_SHADOW_ANGLES.duskMidpoint,
                SOLAR_SHADOW_ANGLES.duskHorizon,
            );
        }
    } else {
        shadowAngleRad = easedSolarAngle(
            minute,
            sunsetMinute,
            sunriseMinute,
            SOLAR_SHADOW_ANGLES.duskHorizon,
            SOLAR_SHADOW_ANGLES.dawnHorizon,
        );
    }

    const daylightProgress = progressInInterval(minute, sunriseMinute, sunsetMinute);
    const elevation = isDaylight ? Math.sin(daylightProgress * Math.PI) : 0;
    return {
        sunDirIso: {
            x: Math.cos(shadowAngleRad + Math.PI),
            y: Math.sin(shadowAngleRad + Math.PI),
        },
        shadowAngleRad,
        elevation,
        sunriseMinute,
        solarNoonMinute,
        sunsetMinute,
    };
}

function localDateKey(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = Math.imul(1664525, state) + 1013904223;
        return (state >>> 0) / 4294967296;
    };
}

function random01(seed, salt) {
    let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
}

function weatherTypeFromRoll(roll, minute) {
    const hour = minute / 60;
    const fogBias = hour < 7 || hour >= 21 ? 0.08 : 0;
    const stormBias = hour >= 13 && hour <= 20 ? 0.018 : 0.004;
    if (roll < 0.42 - fogBias * 0.4) return 'clear';
    if (roll < 0.72 - fogBias * 0.2) return 'partly-cloudy';
    if (roll < 0.86) return 'overcast';
    if (roll < 0.94 + fogBias) return 'fog';
    if (roll < 0.992 - stormBias) return 'rain';
    return 'storm';
}

function buildWeatherKnot(type, minute, random, seed) {
    const preset = WEATHER_PRESETS[type] || WEATHER_PRESETS.clear;
    const jitter = (random() - 0.5) * 0.18;
    const intensity = clamp(preset.intensity + jitter, 0, 1);
    return {
        minute,
        type,
        intensity,
        cloudCover: clamp(preset.cloudCover + jitter * 0.75, 0, 1),
        precipitation: clamp(preset.precipitation * (0.82 + random() * 0.36), 0, 1),
        fog: clamp(preset.fog * (0.78 + random() * 0.44), 0, 1),
        windX: random() < 0.18 ? -1 : 1,
        seed,
    };
}

export function buildWeatherTimeline(date, seedOverride = null) {
    const dateKey = localDateKey(date);
    const seed = Number.isFinite(Number(seedOverride))
        ? Number(seedOverride) >>> 0
        : hashString(`${dateKey}|weather-timeline`);
    const random = seededRandom(seed);
    const knots = [];

    for (let i = 0; i < WEATHER_TIMELINE_KNOTS; i++) {
        const baseMinute = Math.round((DAY_MINUTES / WEATHER_TIMELINE_KNOTS) * i);
        const jitter = i === 0 ? 0 : Math.round((random() - 0.5) * 90);
        const minute = clamp(baseMinute + jitter, 0, DAY_MINUTES - 1);
        knots.push(buildWeatherKnot(weatherTypeFromRoll(random(), minute), minute, random, seed + i * 997));
    }

    knots.sort((a, b) => a.minute - b.minute);
    knots[0] = { ...knots[0], minute: 0 };
    return {
        seed,
        dateKey,
        knots,
    };
}

function interpolateNumber(from, to, weight) {
    return from + (to - from) * weight;
}

export function resolveWeatherAt(minute, timeline) {
    const knots = timeline?.knots || [];
    if (!knots.length) return normalizeWeatherOverride({ type: 'clear' }, timeline?.seed);

    let previous = knots[knots.length - 1];
    let next = knots[0];
    let adjustedMinute = minute;

    for (let i = 0; i < knots.length; i++) {
        const current = knots[i];
        const candidate = knots[(i + 1) % knots.length];
        const candidateMinute = candidate.minute <= current.minute
            ? candidate.minute + DAY_MINUTES
            : candidate.minute;
        const localMinute = minute < current.minute ? minute + DAY_MINUTES : minute;
        if (localMinute >= current.minute && localMinute < candidateMinute) {
            previous = current;
            next = candidate;
            adjustedMinute = localMinute;
            break;
        }
    }

    const nextMinute = next.minute <= previous.minute ? next.minute + DAY_MINUTES : next.minute;
    const rawProgress = clamp((adjustedMinute - previous.minute) / Math.max(1, nextMinute - previous.minute));
    const transitionProgress = smoothstep(rawProgress);
    const intensity = clamp(interpolateNumber(previous.intensity, next.intensity, transitionProgress));
    const cloudCover = clamp(interpolateNumber(previous.cloudCover, next.cloudCover, transitionProgress));
    const precipitation = clamp(interpolateNumber(previous.precipitation, next.precipitation, transitionProgress));
    const fog = clamp(interpolateNumber(previous.fog, next.fog, transitionProgress));
    let type = transitionProgress < 0.5 ? previous.type : next.type;
    if (previous.type === 'storm' || next.type === 'storm') {
        if (precipitation > 0.34 && cloudCover > 0.78) type = 'storm';
    } else if (precipitation > 0.18) {
        type = 'rain';
    } else if (fog > 0.24) {
        type = 'fog';
    } else if (cloudCover > 0.74) {
        type = 'overcast';
    }
    const windX = transitionProgress < 0.5 ? previous.windX : next.windX;

    return {
        type,
        previousType: previous.type,
        nextType: next.type,
        transitionProgress,
        intensity,
        cloudCover,
        precipitation,
        fog,
        windX,
        seed: timeline.seed,
        cause: 'timeline',
        timelineMode: 'auto',
        timeline: knots.map(knot => ({
            minute: knot.minute,
            type: knot.type,
            intensity: Number(knot.intensity.toFixed(3)),
            windX: knot.windX,
        })),
    };
}

function deterministicWeather(date, seedOverride = null) {
    const minute = minutesSinceMidnight(date);
    const seed = Number.isFinite(Number(seedOverride))
        ? Number(seedOverride) >>> 0
        : hashString(`${localDateKey(date)}|weather|fixed`);
    const random = seededRandom(seed);
    const roll = random();
    return normalizeWeatherOverride(buildWeatherKnot(weatherTypeFromRoll(roll, minute), minute, random, seed), seed);
}

function resolvePhase(minute, phases = PHASES) {
    for (const phase of phases) {
        if (isWithinInterval(minute, phase.start, phase.end)) {
            return {
                phase: phase.name,
                phaseProgress: progressInInterval(minute, phase.start, phase.end),
            };
        }
    }
    return { phase: 'day', phaseProgress: 0 };
}

function phaseTransition(phase, phaseProgress) {
    const index = PHASES.findIndex(item => item.name === phase);
    const previous = PHASES[(index - 1 + PHASES.length) % PHASES.length] || PHASES[PHASES.length - 1];
    const next = PHASES[(index + 1) % PHASES.length] || PHASES[0];
    const edgeWindow = phase === 'day' || phase === 'night' ? 0.08 : 0.22;
    if (phaseProgress < edgeWindow) {
        return {
            from: previous.name,
            to: phase,
            weight: smoothstep(phaseProgress / edgeWindow),
            edge: `enter-${phase}`,
        };
    }
    if (phaseProgress > 1 - edgeWindow) {
        return {
            from: phase,
            to: next.name,
            weight: smoothstep((phaseProgress - (1 - edgeWindow)) / edgeWindow),
            edge: `exit-${phase}`,
        };
    }
    return {
        from: phase,
        to: phase,
        weight: 1,
        edge: `in-${phase}`,
    };
}

function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '').trim();
    if (value.length !== 6) return { r: 255, g: 255, b: 255 };
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    };
}

function rgbStringToRgb(value) {
    const parts = String(value || '').split(',').map(part => Number(part.trim()));
    return {
        r: Number.isFinite(parts[0]) ? parts[0] : 255,
        g: Number.isFinite(parts[1]) ? parts[1] : 255,
        b: Number.isFinite(parts[2]) ? parts[2] : 255,
    };
}

function blendChannel(from, to, weight) {
    return Math.round(interpolateNumber(from, to, clamp(weight)));
}

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map(channel => blendChannel(channel, channel, 0).toString(16).padStart(2, '0')).join('')}`;
}

function blendRgb(from, to, weight) {
    return {
        r: blendChannel(from.r, to.r, weight),
        g: blendChannel(from.g, to.g, weight),
        b: blendChannel(from.b, to.b, weight),
    };
}

// #29 — Weather-coupled sky palette. Under rain/storm the zenith bruises
// toward purple-grey and the horizon turns sickly olive, weighted by how much
// of the sky the storm actually covers. Pure color transform, no time
// component, so it is identical under prefers-reduced-motion.
const STORM_ZENITH = '#3d3050';
const STORM_HORIZON = '#8a8b5c';
const STORM_WORLD_TINT = 'rgba(60, 45, 80, 0.28)';
const STORM_BIAS = { rain: 0.42, storm: 0.62 };

function stormPaletteShift(weather) {
    const bias = STORM_BIAS[weather?.type];
    if (!bias) return 0;
    const cloudCover = clamp(Number(weather.cloudCover) || 0);
    return clamp(cloudCover * bias);
}

// Lerp two `rgba(...)` strings (including alpha) by weight, returning an
// `rgba(...)` string. Falls back to the source on unparseable input.
function lerpRgbaString(from, to, weight) {
    const a = parseRgbaString(from);
    const b = parseRgbaString(to);
    if (!a || !b) return from;
    const w = clamp(weight);
    const r = Math.round(interpolateNumber(a.r, b.r, w));
    const g = Math.round(interpolateNumber(a.g, b.g, w));
    const bl = Math.round(interpolateNumber(a.b, b.b, w));
    const al = Number(interpolateNumber(a.a, b.a, w).toFixed(3));
    return `rgba(${r}, ${g}, ${bl}, ${al})`;
}

function blendPalette(phase, phaseProgress, weather) {
    const transition = phaseTransition(phase, phaseProgress);
    const from = PALETTES[transition.from] || PALETTES[phase] || PALETTES.day;
    const to = PALETTES[transition.to] || PALETTES[phase] || PALETTES.day;
    const weight = transition.weight;
    const storm = stormPaletteShift(weather);
    const zenith = blendRgb(hexToRgb(from.zenith), hexToRgb(to.zenith), weight);
    const horizon = blendRgb(hexToRgb(from.horizon), hexToRgb(to.horizon), weight);
    return {
        zenith: rgbToHex(storm > 0 ? blendRgb(zenith, hexToRgb(STORM_ZENITH), storm) : zenith),
        upperBand: rgbToHex(blendRgb(hexToRgb(from.upperBand), hexToRgb(to.upperBand), weight)),
        midBand: rgbToHex(blendRgb(hexToRgb(from.midBand), hexToRgb(to.midBand), weight)),
        horizon: rgbToHex(storm > 0 ? blendRgb(horizon, hexToRgb(STORM_HORIZON), storm) : horizon),
        horizonGlow: Object.values(blendRgb(rgbStringToRgb(from.horizonGlow), rgbStringToRgb(to.horizonGlow), weight)).join(', '),
        starWarm: rgbToHex(blendRgb(hexToRgb(from.starWarm), hexToRgb(to.starWarm), weight)),
        starHot: rgbToHex(blendRgb(hexToRgb(from.starHot), hexToRgb(to.starHot), weight)),
    };
}

function applyHourOverride(date, hourNumber) {
    if (!Number.isFinite(hourNumber)) return date;
    const normalized = ((hourNumber % 24) + 24) % 24;
    const wholeHour = Math.floor(normalized);
    const minuteFloat = (normalized - wholeHour) * 60;
    const wholeMinute = Math.floor(minuteFloat);
    const secondFloat = (minuteFloat - wholeMinute) * 60;
    const wholeSecond = Math.floor(secondFloat);
    const millisecond = Math.round((secondFloat - wholeSecond) * 1000);
    const copy = new Date(date.getTime());
    copy.setHours(wholeHour, wholeMinute, wholeSecond, millisecond);
    return copy;
}

function normalizeDate(value) {
    return value?.getTime ? new Date(value.getTime()) : new Date(value);
}

function preferredMotionScale(fallback) {
    if (Number.isFinite(fallback)) return fallback;
    if (typeof window === 'undefined') return 1;
    try {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 0 : 1;
    } catch {
        return 1;
    }
}

function normalizeWeatherType(type) {
    const value = String(type || 'clear').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (value === 'cloudy') return 'overcast';
    if (value === 'stormy' || value === 'thunderstorm') return 'storm';
    if (value === 'partlycloudy') return 'partly-cloudy';
    return WEATHER_TYPE_SET.has(value) ? value : 'clear';
}

function isKnownWeatherTypeInput(type) {
    const value = String(type || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    return WEATHER_TYPE_SET.has(value)
        || value === 'cloudy'
        || value === 'stormy'
        || value === 'thunderstorm'
        || value === 'partlycloudy';
}

function normalizeWeatherOverride(override, fallbackSeed = null) {
    const type = normalizeWeatherType(override?.type);
    const base = WEATHER_PRESETS[type];
    const intensity = Number.isFinite(Number(override?.intensity))
        ? clamp(Number(override.intensity))
        : base.intensity;
    const windValue = Number(override?.windX);
    return {
        type,
        previousType: normalizeWeatherType(override?.previousType || type),
        nextType: normalizeWeatherType(override?.nextType || type),
        transitionProgress: Number.isFinite(Number(override?.transitionProgress))
            ? clamp(Number(override.transitionProgress))
            : 1,
        intensity,
        cloudCover: Number.isFinite(Number(override?.cloudCover))
            ? clamp(Number(override.cloudCover))
            : clamp(base.cloudCover * (0.72 + intensity * 0.5)),
        precipitation: Number.isFinite(Number(override?.precipitation))
            ? clamp(Number(override.precipitation))
            : clamp(base.precipitation * (0.72 + intensity * 0.5)),
        fog: Number.isFinite(Number(override?.fog))
            ? clamp(Number(override.fog))
            : clamp(base.fog * (0.72 + intensity * 0.5)),
        windX: Number.isFinite(windValue) ? clamp(windValue, -1.4, 1.4) : 1,
        seed: Number.isFinite(Number(override?.seed))
            ? Number(override.seed) >>> 0
            : Number.isFinite(Number(fallbackSeed))
                ? Number(fallbackSeed) >>> 0
                : hashString(`weather-override|${type}`),
        cause: 'timeline',
        timelineMode: 'fixed',
    };
}

function resolveWeather(date, override, { seedOverride = null, timelineMode = 'auto' } = {}) {
    if (override) return normalizeWeatherOverride(override, seedOverride);
    if (timelineMode === 'fixed') return deterministicWeather(date, seedOverride);
    return resolveWeatherAt(minutesSinceMidnight(date), buildWeatherTimeline(date, seedOverride));
}

/**
 * Blend a shared-sky event influence (see application/MoodService.js
 * `deriveWeatherInfluence`) into resolved weather. Storminess pushes cloud
 * cover/precipitation/intensity toward rain/storm; clearing pulls them back
 * toward clear skies. The weather type is only escalated when the influence
 * is storm-biased and only de-escalated when clearing-biased, so the
 * timeline's own narrative stays in charge for neutral influences.
 *
 * 5.5 — cause legibility: when error-storminess dominates, the weather is
 * marked `cause: 'fleet'` so renderers can cast the storm subtly violet
 * (storm canopy + lightning), making "storm = fleet struggling" readable.
 * Otherwise the timeline owns the weather (`cause: 'timeline'`). The cause is
 * folded into atmosphere.cacheKey so baked storm plates re-bake on the flip.
 */
function applyWeatherEventInfluence(weather, influence) {
    if (!weather || !influence) return weather;
    const rawStorminess = clamp(Number(influence.storminess) || 0);
    const rawClearing = clamp(Number(influence.clearing) || 0);
    const storminess = rawStorminess < SHARED_SKY_INFLUENCE_FLOOR ? 0 : rawStorminess;
    const clearing = rawClearing < SHARED_SKY_INFLUENCE_FLOOR ? 0 : rawClearing;
    if (storminess <= 0 && clearing <= 0) return weather;

    const cloudCover = clamp(weather.cloudCover + storminess * 0.45 - clearing * 0.45 * weather.cloudCover);
    const precipitation = clamp(weather.precipitation + storminess * 0.40 - clearing * 0.55 * weather.precipitation);
    const intensity = clamp(weather.intensity + storminess * 0.28 - clearing * 0.25 * weather.intensity);
    const fog = clamp(weather.fog * (1 - clearing * 0.4));

    let type = weather.type;
    if (storminess > clearing) {
        if (precipitation > 0.5 && cloudCover > 0.85) type = 'storm';
        else if (precipitation > 0.18) type = 'rain';
        else if (cloudCover > 0.74) type = 'overcast';
        else if (cloudCover > 0.38 && type === 'clear') type = 'partly-cloudy';
    } else if (clearing > storminess && type !== 'fog') {
        if (type === 'storm' && (precipitation <= 0.5 || cloudCover <= 0.85)) type = 'rain';
        if (type === 'rain' && precipitation <= 0.18) type = 'overcast';
        if (type === 'overcast' && cloudCover <= 0.74) type = 'partly-cloudy';
        if (type === 'partly-cloudy' && cloudCover <= 0.34) type = 'clear';
    }

    const cause = storminess > clearing && storminess > 0.12
        ? 'fleet'
        : weather.cause || 'timeline';
    return { ...weather, type, intensity, cloudCover, precipitation, fog, cause };
}

export function createDistrictAtmosphereBuffer() {
    return { entries: [], pool: [] };
}

function roundDistrictValue(value) {
    return Math.round(value * 1000) / 1000;
}

// A district's lighting response selects an authored palette band. It is not
// a continuous multiplier: zero means no local lighting response, while the
// non-zero values are the material contract's four response bands.
export function quantizeDistrictLightingBand(value, direction = 'dim') {
    const strength = clamp(Number(value) || 0);
    if (strength < 0.02) return 0;
    if (direction === 'warm') return DISTRICT_LIGHTING_BANDS[3];
    return strength >= 0.66
        ? DISTRICT_LIGHTING_BANDS[0]
        : DISTRICT_LIGHTING_BANDS[1];
}

function districtDescriptor(pool, index) {
    return pool[index] ||= {
        project: 'unknown',
        agentIds: [],
        storminess: 0,
        clearing: 0,
        groundHaze: { alpha: 0, tint: '' },
        lightingBias: { cool: 0, warm: 0, dim: 0 },
        falloff: { shape: 'smoothstep', innerRadiusTiles: 2.5, outerRadiusTiles: 7 },
    };
}

/**
 * Convert project-scoped mood influence into renderer-neutral ground effects.
 * Haze keeps a smooth feather between the inner and outer radii. Lighting is
 * a discrete response-band selection so it cannot become a soft PBR factor on
 * top of the finished world pixels.
 */
export function buildDistrictAtmosphere(influences = [], buffer = null) {
    const target = buffer?.entries && buffer?.pool
        ? buffer
        : DEFAULT_DISTRICT_ATMOSPHERE_BUFFER;
    const entries = target.entries;
    const pool = target.pool;
    entries.length = 0;
    if (!Array.isArray(influences)) return entries;

    let count = 0;
    for (const influence of influences) {
        const storminess = clamp(Number(influence?.storminess) || 0);
        const clearing = clamp(Number(influence?.clearing) || 0);
        const strength = Math.max(storminess, clearing);
        if (strength < 0.02) continue;

        const descriptor = districtDescriptor(pool, count);
        descriptor.project = String(influence?.project || 'unknown');
        const agentIds = descriptor.agentIds;
        agentIds.length = 0;
        if (Array.isArray(influence?.agentIds)) {
            for (const agentId of influence.agentIds) agentIds.push(agentId);
        }
        descriptor.storminess = storminess;
        descriptor.clearing = clearing;
        descriptor.groundHaze.alpha = roundDistrictValue(storminess * 0.24);
        descriptor.groundHaze.tint = storminess > clearing ? '76, 68, 94' : '210, 226, 205';
        descriptor.lightingBias.cool = quantizeDistrictLightingBand(storminess, 'cool');
        descriptor.lightingBias.warm = quantizeDistrictLightingBand(clearing, 'warm');
        descriptor.lightingBias.dim = quantizeDistrictLightingBand(storminess, 'dim');
        descriptor.falloff.shape = 'smoothstep';
        descriptor.falloff.innerRadiusTiles = 2.5;
        descriptor.falloff.outerRadiusTiles = 7;
        entries[count++] = descriptor;
    }
    entries.length = count;
    return entries;
}

function phaseLight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return smoothstep(phaseProgress);
    if (phase === 'dusk') return 1 - smoothstep(phaseProgress);
    return 0;
}

function starAlpha(phase, phaseProgress, weather) {
    let base = 0;
    if (phase === 'night') base = 0.92;
    else if (phase === 'dawn') base = 0.78 * (1 - smoothstep(phaseProgress));
    else if (phase === 'dusk') base = 0.78 * smoothstep(phaseProgress);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    return clamp(base * (1 - preset.starOcclusion * clamp(weather.intensity + 0.22)));
}

function celestialHorizonState(yFrac, horizonFrac) {
    const proximity = smoothstep((yFrac - (horizonFrac - 0.085)) / 0.14);
    return {
        horizonOcclusion: clamp(proximity * 0.52),
        squashY: clamp(1 - proximity * 0.26, 0.72, 1),
        horizonFade: clamp(1 - proximity * 0.42, 0.58, 1),
    };
}

function buildSun(minute, phase, phaseProgress, weather, phases = PHASES) {
    const progress = progressInInterval(minute, phases[0].start, phases[2].end);
    const light = phaseLight(phase, phaseProgress);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const alpha = clamp(light * (1 - preset.sunOcclusion * clamp(weather.intensity + 0.16)));
    const yFrac = 0.50 - Math.sin(progress * Math.PI) * 0.38;
    const horizon = celestialHorizonState(yFrac, 0.49);
    return {
        visible: alpha > 0.02,
        alpha: alpha * horizon.horizonFade,
        xFrac: 0.08 + progress * 0.84,
        yFrac,
        ...horizon,
    };
}

function moonPhaseForDate(date) {
    const synodicMonth = 29.530588853;
    const referenceNewMoon = Date.UTC(2000, 0, 6, 18, 14);
    const localNoon = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0);
    const age = ((localNoon - referenceNewMoon) / 86400000 % synodicMonth + synodicMonth) % synodicMonth;
    const illumination = (1 - Math.cos((age / synodicMonth) * Math.PI * 2)) / 2;
    let phaseName = 'crescent';
    if (illumination < 0.08) phaseName = 'new';
    else if (illumination < 0.34) phaseName = 'crescent';
    else if (illumination < 0.66) phaseName = 'half';
    else phaseName = 'gibbous';
    const waxing = age < synodicMonth / 2;
    return {
        phaseName,
        illumination: clamp(illumination),
        waxing,
        age: Number(age.toFixed(2)),
    };
}

function buildMoon(minute, phase, phaseProgress, weather, date, phases = PHASES) {
    const progress = progressInInterval(minute, phases[3].start, phases[3].end);
    let base = phase === 'night' ? 0.92 : 0;
    if (phase === 'dusk') base = 0.34 * smoothstep(phaseProgress);
    if (phase === 'dawn') base = 0.34 * (1 - smoothstep(phaseProgress));
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const phaseState = moonPhaseForDate(date);
    const moonBodyAlpha = 0.34 + phaseState.illumination * 0.66;
    const alpha = clamp(base * moonBodyAlpha * (1 - preset.sunOcclusion * clamp(weather.intensity)));
    const yFrac = 0.44 - Math.sin(progress * Math.PI) * 0.30;
    const horizon = celestialHorizonState(yFrac, 0.43);
    return {
        visible: alpha > 0.02,
        alpha: alpha * horizon.horizonFade,
        xFrac: 0.08 + progress * 0.84,
        yFrac,
        ...horizon,
        phase: phaseState,
    };
}

function buildCloudLayers({ date, weather, assetIds, cloudDensity, cloudAlpha }) {
    const ids = assetIds?.clouds?.length ? assetIds.clouds : SKY_ASSETS.clear.clouds;
    const seed = Number.isFinite(Number(weather.seed))
        ? Number(weather.seed) >>> 0
        : hashString(`${localDateKey(date)}|${weather.type}|clouds`);
    const density = clamp(cloudDensity ?? 0.3);
    const alpha = clamp(cloudAlpha ?? 0.28);
    const layerCount = Math.max(3, Math.min(14, Math.round(3 + density * 11)));
    const out = [];

    for (let i = 0; i < layerCount; i++) {
        const band = CLOUD_LAYER_BANDS[i % CLOUD_LAYER_BANDS.length];
        const row = Math.floor(i / CLOUD_LAYER_BANDS.length);
        const rowOffset = random01(seed, row * 313 + 17) * 0.32;
        const xFrac = (random01(seed, i * 97 + 11) + rowOffset) % 1;
        const yNoise = (random01(seed, i * 101 + 23) - 0.5) * 0.075;
        const scaleNoise = 0.72 + random01(seed, i * 103 + 37) * 0.72;
        out.push({
            assetId: ids[i % ids.length],
            xFrac,
            yFrac: clamp(band.yFrac + row * 0.075 + yNoise, 0.08, 0.55),
            scale: Number((band.scaleBase * scaleNoise).toFixed(3)),
            alpha: Number(clamp(alpha * band.alphaMul * (0.74 + random01(seed, i * 107 + 41) * 0.46), 0, 0.86).toFixed(3)),
            parallax: band.parallax,
            driftMul: band.driftMul,
        });
    }
    return out;
}

function memoizedCloudLayers(key, args) {
    const cached = _cloudLayerCache.get(key);
    if (cached) return cached;
    return cloudLayerCacheSet(key, buildCloudLayers(args));
}

function cloudSetKeyFor(type) {
    return (SKY_ASSETS[type] || SKY_ASSETS.clear).clouds.join(',');
}

// 5.6 — cloud-set cross-fade during weather transitions. The timeline flips
// `weather.type` at the transition midpoint; instead of hard-swapping cloud
// shapes there, the outgoing set fades out over CLOUD_CROSSFADE_WINDOW of
// transition progress while the incoming set fades in. Both sets are memoized
// descriptors; only the merged (alpha-weighted) list is built per weight
// bucket, so the steady-state path allocates nothing.
const CLOUD_CROSSFADE_WINDOW = 0.25;

function blendedCloudLayers({ date, weather, cloudDensity, cloudAlpha, cloudBucket }) {
    const dateKey = localDateKey(date);
    const currentAssets = SKY_ASSETS[weather.type] || SKY_ASSETS.clear;
    const currentKey = `${dateKey}|${weather.type}|${cloudBucket}`;
    const transitionProgress = clamp(Number(weather.transitionProgress) || 0);
    const previousType = weather.previousType;
    const blending = previousType
        && previousType !== weather.type
        && transitionProgress >= 0.5
        && cloudSetKeyFor(previousType) !== cloudSetKeyFor(weather.type);
    if (!blending) {
        return memoizedCloudLayers(currentKey, { date, weather, assetIds: currentAssets, cloudDensity, cloudAlpha });
    }
    const weight = clamp((transitionProgress - 0.5) / CLOUD_CROSSFADE_WINDOW);
    if (weight >= 1) {
        return memoizedCloudLayers(currentKey, { date, weather, assetIds: currentAssets, cloudDensity, cloudAlpha });
    }
    const weightBucket = Math.round(weight * 10) / 10;
    const mergedKey = `${dateKey}|xf:${previousType}>${weather.type}|${cloudBucket}|w${weightBucket}`;
    const cached = _cloudLayerCache.get(mergedKey);
    if (cached) return cached;
    const outgoing = memoizedCloudLayers(`${dateKey}|prev:${previousType}|${cloudBucket}`, {
        date, weather, assetIds: SKY_ASSETS[previousType] || SKY_ASSETS.clear, cloudDensity, cloudAlpha,
    });
    const incoming = memoizedCloudLayers(currentKey, { date, weather, assetIds: currentAssets, cloudDensity, cloudAlpha });
    const merged = [
        ...outgoing.map(layer => ({ ...layer, alpha: Number((layer.alpha * (1 - weight)).toFixed(3)) })),
        ...incoming.map(layer => ({ ...layer, alpha: Number((layer.alpha * weight).toFixed(3)) })),
    ];
    return cloudLayerCacheSet(mergedKey, merged);
}

function parseRgbaString(value) {
    const match = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return null;
    return {
        r: clamp(parts[0] ?? 255, 0, 255),
        g: clamp(parts[1] ?? 255, 0, 255),
        b: clamp(parts[2] ?? 255, 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3]) : 1,
    };
}

/**
 * #3 — Grade authority. Lerp a `#rrggbb` overlay color toward the active
 * `grade.worldTint` so halos, tethers, and harbor glows pick up the
 * time-of-day cast (golden dusk, cool night) instead of floating day-cold
 * above the scene. The tint's own alpha is the lerp strength, scaled by
 * `strength` for callers that want a gentler pull. Returns a `#rrggbb` hex;
 * non-hex inputs are returned unchanged so callers can pass through. This is a
 * pure color transform with no time component — identical under reduced motion.
 */
export function gradeColor(hex, grade, strength = 1) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return text;
    const tint = parseRgbaString(grade?.worldTint);
    if (!tint) return text;
    const weight = clamp(tint.a * clamp(strength, 0, 2), 0, 1);
    if (weight <= 0) return text;
    const blended = blendRgb(hexToRgb(text), { r: tint.r, g: tint.g, b: tint.b }, weight);
    return rgbToHex(blended);
}

function buildGrade(phase, phaseProgress, weather) {
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const weatherWeight = weather.type === 'rain' || weather.type === 'overcast' || weather.type === 'storm'
        ? weather.intensity * 0.24
        : weather.type === 'fog'
            ? weather.intensity * 0.16
            : 0;

    const baseTint = phase === 'night'
        ? 'rgba(50, 92, 140, 0.22)'
        : phase === 'dawn'
            ? 'rgba(140, 175, 210, 0.10)'
            : phase === 'dusk'
                ? 'rgba(130, 116, 160, 0.13)'
                : 'rgba(160, 215, 245, 0.05)';
    // #29 — under rain/storm the world tint agrees with the bruised sky, pulled
    // toward the storm cast by how much of the sky the storm covers.
    const storm = stormPaletteShift(weather);
    const worldTint = storm > 0 ? lerpRgbaString(baseTint, STORM_WORLD_TINT, storm) : baseTint;

    return {
        overlayAlpha: clamp(dark * 0.30 + weatherWeight, 0, 0.46),
        vignetteAlpha: clamp(dark * 0.34 + weatherWeight * 0.6, 0.04, 0.52),
        worldTint,
        horizonWash: clamp((phase === 'day' ? 0.10 : 0.18) + weatherWeight, 0, 0.28),
        buildingGlowScale: clamp(0.55 + dark * 0.85 + weatherWeight, 0.45, 1.5),
    };
}

function buildLighting(minute, seasonToken, phase, phaseProgress, weather) {
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const dawnWarmth = phase === 'dawn' ? 1 - smoothstep(phaseProgress) : 0;
    const duskWarmth = phase === 'dusk' ? smoothstep(phaseProgress) : 0;
    const sunWarmth = clamp(Math.max(dawnWarmth * 0.75, duskWarmth));
    const weatherDim = weather.type === 'rain' || weather.type === 'overcast' || weather.type === 'storm'
        ? weather.intensity * 0.35
        : weather.type === 'fog'
            ? weather.intensity * 0.20
            : 0;
    const solar = solarVectorForMinute(minute, seasonToken);
    const shadowLength = clamp(0.72 + dark * 1.10 + sunWarmth * 0.72 + weatherDim * 0.28, 0.62, 2.35);

    return normalizeLightingState({
        sunDirIso: solar.sunDirIso,
        sunWarmth,
        ambientLight: clamp(light - weatherDim * 0.45),
        ambientTint: phase === 'night'
            ? '86, 139, 180'
            : phase === 'dusk'
                ? '215, 169, 142'
                : phase === 'dawn'
                    ? '234, 185, 159'
                    : '196, 235, 255',
        shadowAngleRad: solar.shadowAngleRad,
        shadowLength,
        shadowAlpha: clamp(0.18 + light * 0.10 + sunWarmth * 0.18 - weatherDim * 0.08, 0.12, 0.42),
        lightWarmth: clamp(0.72 + sunWarmth * 0.32),
        lightBoost: clamp(0.75 + dark * 0.85 + sunWarmth * 0.35 + weatherDim * 0.35, 0.65, 1.8),
        sunBloomScale: clamp(0.85 + sunWarmth * 0.95 - weatherDim * 0.35, 0.65, 1.85),
        beaconIntensity: clamp(dark * 0.9 + sunWarmth * 0.25 + weatherDim * 0.25, 0, 1),
        waterGlintScale: clamp(0.64 + light * 0.28 + sunWarmth * 0.48 - weatherDim * 0.22, 0.32, 1.42),
    });
}

export function normalizeLightingState(state = {}) {
    return {
        sunDirIso: state.sunDirIso || { x: -0.96, y: -0.28 },
        sunWarmth: clamp(state.sunWarmth ?? 0),
        ambientLight: clamp(state.ambientLight ?? 1),
        ambientTint: state.ambientTint || '196, 235, 255',
        shadowAngleRad: Number.isFinite(state.shadowAngleRad) ? state.shadowAngleRad : 0.28,
        shadowLength: Number.isFinite(state.shadowLength) ? state.shadowLength : 1,
        shadowAlpha: clamp(state.shadowAlpha ?? 0.22, 0, 1),
        lightWarmth: clamp(state.lightWarmth ?? 1, 0, 2),
        lightBoost: clamp(state.lightBoost ?? 1, 0, 2),
        sunBloomScale: clamp(state.sunBloomScale ?? 1, 0, 2),
        beaconIntensity: clamp(state.beaconIntensity ?? 0, 0, 1),
        waterGlintScale: clamp(state.waterGlintScale ?? 1, 0, 2),
    };
}

// #33 — convert an atmosphere snapshot's wind into a signed horizontal drift
// velocity (world units / 16ms frame) for rising smoke columns. Single source
// of truth so chimney smoke, mine dust, and the harbor cookfire all lean by the
// same amount. `weather.windX` is the canonical signed wind (~-1.4..1.4); we
// scale it to a gentle sub-pixel lean. Returns 0 when particle motion is off
// (the snapshot's `motion.particleEnabled === false`) so the reduced-motion
// static wisp never inherits drift.
const SMOKE_WIND_DRIFT_SCALE = 0.26;
export function smokeWindDrift(atmosphere) {
    if (!atmosphere || atmosphere.motion?.particleEnabled === false) return 0;
    const windX = Number(atmosphere.weather?.windX ?? atmosphere.motion?.windX);
    if (!Number.isFinite(windX)) return 0;
    return clamp(windX, -1.4, 1.4) * SMOKE_WIND_DRIFT_SCALE;
}

function buildReactions(phase, phaseProgress, weather, lighting) {
    const precipitation = clamp(weather.precipitation ?? 0);
    const fog = clamp(weather.fog ?? 0);
    const cloudCover = clamp(weather.cloudCover ?? 0);
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const warmEdge = phase === 'dawn'
        ? 1 - smoothstep(phaseProgress)
        : phase === 'dusk'
            ? smoothstep(phaseProgress)
            : 0;
    const storm = weather.type === 'storm' ? clamp(weather.intensity) : 0;
    const overcast = Math.max(0, cloudCover - 0.62) / 0.38;
    return {
        puddleAlpha: clamp(precipitation * 0.38),
        roofGlintAlpha: clamp((precipitation * 0.18 + warmEdge * 0.16) * (lighting.waterGlintScale ?? 1)),
        waterRippleScale: clamp(0.24 + precipitation * 0.72 + storm * 0.36, 0, 1.35),
        windowWarmth: clamp(dark * 0.82 + warmEdge * 0.22 + overcast * 0.26 + precipitation * 0.22),
        fogNearWaterAlpha: clamp(fog * 0.34 + precipitation * 0.06),
        waterFogAlpha: clamp(fog * 0.30),
        stormRoughness: clamp(storm * 0.9 + precipitation * 0.22),
        warmGlint: clamp(warmEdge * (1 - overcast * 0.52)),
        nightReflection: clamp(dark * 0.58 + (phase === 'night' ? 0.20 : 0)),
        // B3 — midday sun glitter on open water. `light*light` peaks at solar
        // noon and falls off through dawn/dusk to 0 at night; cloud cover and
        // fog dim the sparkle. Mirrors nightReflection so the sea-glitter pass
        // can cross-fade warm-white daytime specks into pale-blue moonlit ones.
        dayGlitter: clamp((light * light) * (1 - overcast * 0.55) * (1 - fog * 0.4)),
        distantContrast: clamp(1 - fog * 0.32 - overcast * 0.12, 0.55, 1),
    };
}

function buildClock(date, minute, phase, phaseProgress) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const label = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return {
        date,
        localDate: localDateKey(date),
        hours,
        minutes,
        seconds,
        minuteOfDay: minute,
        label,
        // Aliases of the top-level semantic phase fields. Top-level
        // atmosphere.phase / phaseProgress remain the canonical source; these
        // exist so consumers that already destructure `atmosphere.clock` can
        // read time-of-day without reaching back to the parent snapshot.
        phase,
        phaseProgress,
    };
}

export function createAtmosphereSnapshot({
    now = new Date(),
    motionScale = null,
    weatherOverride = null,
    hourOverride = null,
    seedOverride = null,
    timelineMode = 'auto',
    eventInfluence = null,
    districtBuffer = null,
} = {}) {
    const effectiveDate = applyHourOverride(normalizeDate(now), hourOverride);
    const minute = minutesSinceMidnight(effectiveDate);
    // 5.4 — season-modulated phase table (day length follows the month→season
    // mapping; equinox months keep the fixed PHASES baseline).
    const seasonToken = seasonTokenForMonth(effectiveDate.getMonth());
    const phases = phasesForSeason(seasonToken);
    const { phase, phaseProgress } = resolvePhase(minute, phases);
    const dayProgress = minute / DAY_MINUTES;
    let weather = resolveWeather(effectiveDate, weatherOverride, { seedOverride, timelineMode });
    // Explicit overrides (debug helper, scenario metadata) win over the
    // village event influence.
    if (!weatherOverride) weather = applyWeatherEventInfluence(weather, eventInfluence);
    const districtAtmosphere = buildDistrictAtmosphere(eventInfluence?.districts, districtBuffer);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const intensity = clamp(weather.intensity);
    const cloudCover = Number.isFinite(weather.cloudCover) ? weather.cloudCover : preset.cloudCover;
    const cloudAlpha = clamp(preset.cloudAlpha * (0.54 + intensity * 0.32 + cloudCover * 0.42));
    const cloudDensity = clamp(preset.cloudDensity * (0.58 + intensity * 0.28 + cloudCover * 0.52));
    const transition = phaseTransition(phase, phaseProgress);
    const assetIds = SKY_ASSETS[weather.type] || SKY_ASSETS.clear;
    const lighting = buildLighting(minute, seasonToken, phase, phaseProgress, weather);
    const timeBucket = Math.floor(dayProgress * 96);
    const lightBucket = Math.round(phaseLight(phase, phaseProgress) * 100);
    const intensityBucket = Math.round(intensity * 10);
    const cloudBucket = Math.round((weather.cloudCover || 0) * 10);
    const precipitationBucket = Math.round((weather.precipitation || 0) * 10);
    const fogBucket = Math.round((weather.fog || 0) * 10);
    const cloudLayerBlend = blendedCloudLayers({ date: effectiveDate, weather, cloudDensity, cloudAlpha, cloudBucket });
    const effectiveMotionScale = preferredMotionScale(motionScale);
    const driftEnabled = effectiveMotionScale > 0;
    const clockDriftPx = Math.round(dayProgress * 4096) * weather.windX;

    return {
        phase,
        phaseProgress,
        dayProgress,
        transition,
        // 5.5 — weather.cause ('timeline' | 'fleet') is part of the key so
        // baked storm plates re-bake when a storm flips between fleet-driven
        // (violet cast) and timeline-driven.
        cacheKey: `${phase}|${weather.type}|i${intensityBucket}|c${cloudBucket}|p${precipitationBucket}|f${fogBucket}|b${timeBucket}|l${lightBucket}|${weather.cause === 'fleet' ? 'fleet' : 'timeline'}`,
        weather,
        // Additive local-atmosphere contract. The shared sky remains coherent;
        // renderers may paint these feathered effects around project occupants.
        districtAtmosphere,
        sky: {
            palette: blendPalette(phase, phaseProgress, weather),
            assetIds,
            sun: buildSun(minute, phase, phaseProgress, weather, phases),
            moon: buildMoon(minute, phase, phaseProgress, weather, effectiveDate, phases),
            starsAlpha: starAlpha(phase, phaseProgress, weather),
            cloudAlpha,
            cloudDensity,
            cloudCover,
            cloudLayers: cloudLayerBlend,
        },
        grade: buildGrade(phase, phaseProgress, weather),
        lighting,
        reactions: buildReactions(phase, phaseProgress, weather, lighting),
        motion: {
            driftEnabled,
            particleEnabled: effectiveMotionScale > 0,
            clockDriftPx,
            windX: weather.windX,
        },
        effectiveDate,
        clock: buildClock(new Date(effectiveDate.getTime()), minute, phase, phaseProgress),
    };
}

export class AtmosphereState {
    constructor({ nowProvider = () => new Date() } = {}) {
        this.nowProvider = nowProvider;
        this._ownerToken = Symbol('claude-ville-atmosphere');
        this._hourOverride = null;
        this._weatherOverride = null;
        this._seedOverride = null;
        this._timelineMode = 'auto';
        this._frozenDate = null;
        this._districtAtmosphereBuffer = createDistrictAtmosphereBuffer();
        this._lastSnapshot = null;
        this._previousHelper = null;
        this._debugHelperInstalled = false;
        this._installDebugHelper();
    }

    update({ now = null, motionScale = null, eventInfluence = null } = {}) {
        const baseNow = now
            ? new Date(now.getTime ? now.getTime() : now)
            : this._frozenDate
                ? new Date(this._frozenDate.getTime())
                : this.nowProvider();
        this._lastSnapshot = createAtmosphereSnapshot({
            now: baseNow,
            motionScale,
            weatherOverride: this._weatherOverride,
            hourOverride: this._hourOverride,
            seedOverride: this._seedOverride,
            timelineMode: this._timelineMode,
            eventInfluence,
            districtBuffer: this._districtAtmosphereBuffer,
        });
        this._lastSnapshot.timeline = {
            mode: this._timelineMode,
            hourOverride: this._hourOverride,
            frozen: this._frozenDate !== null,
        };
        return this._lastSnapshot;
    }

    setHour(hourNumber) {
        const parsed = Number(hourNumber);
        if (!Number.isFinite(parsed)) return this.snapshot();
        this._hourOverride = parsed;
        return this.snapshot();
    }

    setWeather(typeOrObject, intensity, windX) {
        const source = typeof typeOrObject === 'object' && typeOrObject
            ? typeOrObject
            : { type: typeOrObject, intensity, windX };
        if (!isKnownWeatherTypeInput(source.type)) return this.snapshot();
        const weatherType = normalizeWeatherType(source.type);
        this._weatherOverride = {
            type: weatherType,
            intensity: Number.isFinite(Number(source.intensity)) ? clamp(Number(source.intensity)) : undefined,
            windX: Number.isFinite(Number(source.windX)) ? clamp(Number(source.windX), -1.4, 1.4) : undefined,
            seed: Number.isFinite(Number(source.seed)) ? Number(source.seed) >>> 0 : undefined,
            cloudCover: Number.isFinite(Number(source.cloudCover)) ? clamp(Number(source.cloudCover)) : undefined,
            precipitation: Number.isFinite(Number(source.precipitation)) ? clamp(Number(source.precipitation)) : undefined,
            fog: Number.isFinite(Number(source.fog)) ? clamp(Number(source.fog)) : undefined,
            transitionProgress: Number.isFinite(Number(source.transitionProgress))
                ? clamp(Number(source.transitionProgress))
                : undefined,
            previousType: source.previousType,
            nextType: source.nextType,
        };
        return this.snapshot();
    }

    setSeed(seed) {
        const parsed = Number(seed);
        this._seedOverride = Number.isFinite(parsed) ? parsed >>> 0 : null;
        return this.snapshot();
    }

    setTimelineMode(mode) {
        this._timelineMode = mode === 'fixed' ? 'fixed' : 'auto';
        return this.snapshot();
    }

    freeze() {
        const snapshot = this.snapshot();
        this._frozenDate = new Date(snapshot.effectiveDate.getTime());
        return this.snapshot();
    }

    clear() {
        this._hourOverride = null;
        this._weatherOverride = null;
        this._seedOverride = null;
        this._timelineMode = 'auto';
        this._frozenDate = null;
        return this.snapshot();
    }

    snapshot() {
        return this.update();
    }

    installDebugHelper() {
        this._installDebugHelper();
    }

    dispose() {
        if (typeof window === 'undefined') return;
        const helper = window.__claudeVilleAtmosphere;
        if (helper?.__ownerToken !== this._ownerToken) {
            this._debugHelperInstalled = false;
            return;
        }
        if (this._previousHelper) {
            window.__claudeVilleAtmosphere = this._previousHelper;
        } else {
            delete window.__claudeVilleAtmosphere;
        }
        this._previousHelper = null;
        this._debugHelperInstalled = false;
    }

    _installDebugHelper() {
        if (typeof window === 'undefined') return;
        if (this._debugHelperInstalled) return;
        if (window.__claudeVilleAtmosphere?.__ownerToken === this._ownerToken) {
            this._debugHelperInstalled = true;
            return;
        }
        this._previousHelper = window.__claudeVilleAtmosphere || null;
        const helper = {
            setHour: (hourNumber) => this.setHour(hourNumber),
            setWeather: (typeOrObject, intensity, windX) => this.setWeather(typeOrObject, intensity, windX),
            setSeed: (seed) => this.setSeed(seed),
            setTimelineMode: (mode) => this.setTimelineMode(mode),
            freeze: () => this.freeze(),
            clear: () => this.clear(),
            snapshot: () => this.snapshot(),
        };
        Object.defineProperty(helper, '__ownerToken', {
            value: this._ownerToken,
            enumerable: false,
            configurable: false,
        });
        window.__claudeVilleAtmosphere = helper;
        this._debugHelperInstalled = true;
    }
}
