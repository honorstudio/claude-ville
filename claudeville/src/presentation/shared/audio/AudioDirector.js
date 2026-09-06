// The soundscape brain. Once per second it reads the world — atmosphere
// snapshot (time-of-day phase, weather, season) and agent stats — and steers
// each ambience layer's intensity with slow slews. Discrete village moments
// arrive over the event bus and become one-shot cues behind the governor.
//
// Atmosphere source: the World renderer broadcasts its per-frame snapshot as
// `atmosphere:updated` (so debug overrides and village weather influence are
// heard, not just seen). When that stream goes quiet — Dashboard mode stops
// the render loop — the director computes its own snapshot; AtmosphereState
// is pure local-clock, so ambience keeps tracking time and weather anywhere.

import { eventBus } from '../../../domain/events/DomainEvent.js';
import {
    actionableAgents,
    bucketCounts,
    bucketForStatus,
} from '../../../domain/services/SignalLedger.js';
import { MAP_SIZE, TILE_WIDTH } from '../../../config/constants.js';
import { createAtmosphereSnapshot } from '../../character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '../../character-mode/SeasonalAmbience.js';
import { clamp01, rand } from './AudioEngine.js';
import { scaleForPhase } from './MusicalScale.js';
import {
    CUE_LANES,
    CueGovernor,
    cueLifecycleDecision,
    updateQuietFloor,
} from './CueGovernor.js';
import { CueKit } from './cues/CueKit.js';
import { WindLayer } from './layers/WindLayer.js';
import { RainLayer } from './layers/RainLayer.js';
import { BirdsLayer } from './layers/BirdsLayer.js';
import { CricketsLayer } from './layers/CricketsLayer.js';
import { VillageHumLayer } from './layers/VillageHumLayer.js';
import { TonalBedLayer } from './layers/TonalBedLayer.js';
import { MusicLayer } from './layers/MusicLayer.js';

const TICK_MS = 1000;
const ATMO_FRESH_MS = 3000;
const AGENT_CUE_DEDUPE_MS = 2500;
const QUIET_ENTER_MS = 30000;
const QUIET_LEAVE_MS = 4000;
const SPATIAL_CUES = new Set(['arrival', 'departure', 'distress', 'recovery', 'summons']);
const WORLD_TILE_SPAN = Math.max(1, MAP_SIZE - 1);
const WORLD_SCREEN_X_HALF_SPAN = WORLD_TILE_SPAN * (TILE_WIDTH / 2);

const BED_LEVEL_BY_PHASE = { dawn: 0.55, day: 0.15, dusk: 0.6, night: 0.32 };
const BIRD_SEASON = { winter: 0.25, spring: 1, summer: 1, autumn: 0.7 };
const CRICKET_SEASON = { winter: 0, spring: 0.45, summer: 1, autumn: 0.55 };

// Daylight 0..1: 1 through the day, ramping through dawn/dusk, 0 at night.
function daylight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return phaseProgress;
    if (phase === 'dusk') return 1 - phaseProgress;
    return 0;
}

function copyPosition(position) {
    if (!position || typeof position !== 'object') return null;
    return {
        ...(Number.isFinite(Number(position.tileX)) ? { tileX: Number(position.tileX) } : {}),
        ...(Number.isFinite(Number(position.tileY)) ? { tileY: Number(position.tileY) } : {}),
        ...(Number.isFinite(Number(position.x)) ? { x: Number(position.x) } : {}),
        ...(Number.isFinite(Number(position.y)) ? { y: Number(position.y) } : {}),
        ...(Number.isFinite(Number(position.screenX)) ? { screenX: Number(position.screenX) } : {}),
    };
}

function normalizedScreenValue(value, width = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 1) return clamp01(n);
    const viewport = Number(width);
    if (Number.isFinite(viewport) && viewport > 1) return clamp01(n / viewport);
    return null;
}

function normalizedWorldX(worldX) {
    const x = Number(worldX);
    if (!Number.isFinite(x) || WORLD_SCREEN_X_HALF_SPAN <= 0) return null;
    return clamp01((x + WORLD_SCREEN_X_HALF_SPAN) / (WORLD_SCREEN_X_HALF_SPAN * 2));
}

function normalizedTilePosition(position) {
    if (!position || typeof position !== 'object') return null;
    const tileX = Number(position.tileX ?? position.x);
    const tileY = Number(position.tileY ?? position.y);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return clamp01((tileX - tileY + WORLD_TILE_SPAN) / (WORLD_TILE_SPAN * 2));
}

function explicitScreenX(payload) {
    const candidates = [
        [payload?.screenX, payload?.viewportWidth || payload?.screenWidth],
        [payload?.normalizedScreenX, 0],
        [payload?.screenPosition?.x, payload?.screenPosition?.width || payload?.viewportWidth],
        [payload?.agent?.screenX, payload?.agent?.viewportWidth || payload?.viewportWidth],
        [payload?.agent?.normalizedScreenX, 0],
        [payload?.agent?.position?.screenX, payload?.agent?.position?.viewportWidth || payload?.viewportWidth],
        [payload?.position?.screenX, payload?.position?.viewportWidth || payload?.viewportWidth],
    ];
    for (const [value, width] of candidates) {
        const normalized = normalizedScreenValue(value, width);
        if (normalized != null) return normalized;
    }
    return null;
}

function spatialFields(payload) {
    return {
        agent: payload?.agent,
        screenX: payload?.screenX,
        normalizedScreenX: payload?.normalizedScreenX,
        screenPosition: payload?.screenPosition,
        position: payload?.position,
        lastTile: payload?.lastTile,
        worldX: payload?.worldX,
        center: payload?.center,
    };
}

export class AudioDirector {
    constructor({ engine, world = null } = {}) {
        this.engine = engine;
        this.world = world;
        this.layers = {};
        this.governor = new CueGovernor();
        this.cueKit = new CueKit(this.engine, this.governor);
        this.running = false;
        this._interval = null;
        this._unsubscribes = [];
        this._signalUnsubscribes = [];
        this._signalRouting = true;
        this.hidden = false;
        this._hiddenSummonsHandler = null;
        this._atmosphere = null;
        this._atmosphereAt = 0;
        this._atmosphereSource = 'none';
        this._phase = 'day';
        this._levels = {};
        this._overrides = new Map();
        this._lastBellHour = null;
        this._thunderTimers = new Set();
        this._recentAgentCues = new Map();
        this._agentAudioContext = new Map();
        this._mode = 'character';
        this._quietFloor = { mode: 'active', calmSince: null, activeSince: null };
        this._framePressureLevel = 0;

        // Cue signals stay subscribed while audio is disabled so the
        // accessibility event stream remains useful without an AudioContext.
        this._subscribeSignals();
    }

    start() {
        if (this.running || !this.engine.context) return;
        this.running = true;

        this.layers = {
            wind: new WindLayer(this.engine),
            rain: new RainLayer(this.engine),
            birds: new BirdsLayer(this.engine),
            crickets: new CricketsLayer(this.engine),
            hum: new VillageHumLayer(this.engine),
            bed: new TonalBedLayer(this.engine),
            music: new MusicLayer(this.engine),
        };
        for (const layer of Object.values(this.layers)) layer.start();

        this._subscribeRuntime();
        this._interval = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    stop() {
        this.running = false;
        this.governor.clearRoutine();
        if (this._interval) clearInterval(this._interval);
        this._interval = null;
        for (const id of this._thunderTimers) clearTimeout(id);
        this._thunderTimers.clear();
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        for (const layer of Object.values(this.layers)) layer.stop();
        this.layers = {};
    }

    destroy() {
        this.stop();
        for (const unsubscribe of this._signalUnsubscribes) unsubscribe();
        this._signalUnsubscribes = [];
        this.cueKit = null;
        this.governor.destroy();
        this._recentAgentCues.clear();
        this._agentAudioContext.clear();
    }

    setSignalRouting(enabled) {
        this._signalRouting = Boolean(enabled);
    }

    setHidden(hidden) {
        this.hidden = Boolean(hidden);
        this.governor.clearRoutine();
    }

    setHiddenSummonsHandler(handler) {
        this._hiddenSummonsHandler = typeof handler === 'function' ? handler : null;
    }

    _subscribeSignals() {
        const on = (event, handler) => {
            this._signalUnsubscribes.push(eventBus.on(event, handler));
        };

        on('mode:changed', (mode) => {
            this._mode = mode === 'dashboard' ? 'dashboard' : 'character';
            this.governor.clearRoutine();
        });
        on('agent:added', (agent) => this._rememberAgentAudioContext(agent));
        on('agent:updated', (agent) => this._rememberAgentAudioContext(agent));
        // Keep the last position/provider through the synchronous removal →
        // village:scene sequence so departures can retain their identity.
        on('agent:removed', (agent) => this._rememberAgentAudioContext(agent));

        on('village:scene', (scene) => {
            if (!this._signalRouting) return;
            const agentId = scene?.agentId ?? scene?.agent?.id ?? null;
            const label = scene?.agent?.name || scene?.agent?.agentName || scene?.label;
            const provider = this._agentProvider(scene, agentId);
            if (scene?.kind === 'arrival') {
                this.cue('arrival', { agentId, label, provider, ...spatialFields(scene) });
            }
            else if (scene?.kind === 'departure') {
                this.cue('departure', { agentId, label, provider, ...spatialFields(scene) });
                if (agentId != null) this._agentAudioContext.delete(agentId);
            }
        });

        on('distress:watchtower', (payload) => {
            if (!this._signalRouting) return;
            const kind = payload?.kind;
            const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
            if (kind === 'errored' || kind === 'rate_limited') {
                this._playDistress(payload, agentId);
            } else if (kind === 'recovered') {
                this._recentAgentCues.delete(agentId);
                this.cue('recovery', {
                    agentId,
                    label: this._agentLabel(payload, agentId),
                    provider: this._agentProvider(payload, agentId),
                    ...spatialFields(payload),
                });
            }
        });

        on('team:gather', (payload) => {
            if (!this._signalRouting) return;
            const teamSize = Array.isArray(payload?.members)
                ? payload.members.length
                : payload?.teamSize ?? payload?.size;
            this.cue('council', {
                agentId: payload?.agentId ?? null,
                teamName: payload?.teamName ?? null,
                teamSize,
            });
        });
        on('chronicle:aurora', (payload) => {
            if (this._signalRouting) this.cue('aurora', { agentId: payload?.agentId ?? null });
        });
        // The one cue that is about the listener rather than the world.
        on('attention:raised', (payload) => this._handleAttention(payload));

        // Thunder trails the visible lightning by a beat, like real distance.
        on('weather:storm-flash', (payload) => {
            if (!this._signalRouting) return;
            const intensity = clamp01(payload?.intensity, 0.6);
            const id = setTimeout(() => {
                this._thunderTimers.delete(id);
                if (this._signalRouting) this.cue('thunder', { intensity });
            }, rand(300, 1200));
            this._thunderTimers.add(id);
        });
    }

    _subscribeRuntime() {
        const on = (event, handler) => {
            this._unsubscribes.push(eventBus.on(event, handler));
        };

        on('atmosphere:updated', (snapshot) => {
            if (!snapshot) return;
            this._atmosphere = snapshot;
            this._atmosphereAt = Date.now();
            this._atmosphereSource = 'world';
        });
    }

    _agentCueIsRecent(agentId) {
        if (agentId == null) return false;
        const recent = this._recentAgentCues.get(agentId);
        if (!recent) return false;
        if (Date.now() - recent.at >= AGENT_CUE_DEDUPE_MS) {
            this._recentAgentCues.delete(agentId);
            return false;
        }
        return true;
    }

    _rememberAgentCue(agentId, kind) {
        if (agentId != null) this._recentAgentCues.set(agentId, { kind, at: Date.now() });
    }

    _rememberAgentAudioContext(agent) {
        const agentId = agent?.id;
        if (agentId == null) return;
        const previous = this._agentAudioContext.get(agentId) || {};
        this._agentAudioContext.set(agentId, {
            provider: agent?.provider || previous.provider || null,
            position: copyPosition(agent?.position) || previous.position || null,
            screenX: explicitScreenX(agent) ?? previous.screenX ?? null,
            at: Date.now(),
        });
        // A removed agent can wait briefly for its departure scene. Keep this
        // cache bounded when a long-running village cycles many sessions.
        while (this._agentAudioContext.size > 128) {
            const oldest = this._agentAudioContext.keys().next().value;
            if (oldest == null) break;
            this._agentAudioContext.delete(oldest);
        }
    }

    _agentProvider(payload, agentId) {
        return payload?.provider
            || payload?.agent?.provider
            || this._agentAudioContext.get(agentId)?.provider
            || this.world?.agents?.get?.(agentId)?.provider
            || null;
    }

    _rendererScreenX(agentId) {
        if (agentId == null) return null;
        const renderer = globalThis.window?.__claudeVilleApp?.renderer;
        const sprite = renderer?.agentSprites?.get?.(agentId);
        const camera = renderer?.camera;
        if (!sprite || !camera?.worldToScreen) return null;
        const x = Number(sprite.x);
        const y = Number(sprite.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const screen = camera.worldToScreen(x, y);
        const width = camera._viewportWidth?.()
            || renderer?.canvas?._claudeVilleCssWidth
            || renderer?.canvas?.clientWidth
            || renderer?.canvas?.width;
        return normalizedScreenValue(screen?.x, width);
    }

    _resolveScreenX(payload, agentId) {
        if (this._mode === 'dashboard') return 0.5;

        const direct = explicitScreenX(payload);
        if (direct != null) return direct;

        const rendered = this._rendererScreenX(agentId);
        if (rendered != null) return rendered;

        const worldScreen = normalizedWorldX(
            payload?.worldX
            ?? payload?.agent?.worldX
            ?? payload?.center?.x,
        );
        if (worldScreen != null) return worldScreen;

        const payloadPosition = payload?.agent?.position || payload?.position || payload?.lastTile;
        const payloadTile = normalizedTilePosition(payloadPosition);
        if (payloadTile != null) return payloadTile;

        const cached = this._agentAudioContext.get(agentId);
        const cachedScreen = normalizedScreenValue(cached?.screenX);
        if (cachedScreen != null) return cachedScreen;
        const cachedTile = normalizedTilePosition(cached?.position);
        if (cachedTile != null) return cachedTile;

        const agent = this.world?.agents?.get?.(agentId);
        const agentScreen = explicitScreenX(agent);
        if (agentScreen != null) return agentScreen;
        const agentTile = normalizedTilePosition(agent?.position);
        if (agentTile != null) return agentTile;

        return 0.5;
    }

    _playDistress(payload, agentId) {
        if (this._agentCueIsRecent(agentId)) return false;
        if (this.hidden && this._hiddenSummonsHandler) {
            this._hiddenSummonsHandler({
                ...payload,
                agentId,
                audioCueKind: 'distress',
                label: this._agentLabel(payload, agentId),
                provider: this._agentProvider(payload, agentId),
                status: payload?.kind || payload?.status,
            });
            this._rememberAgentCue(agentId, 'distress');
            return true;
        }
        const played = this.cue('distress', {
            agentId,
            label: this._agentLabel(payload, agentId),
            provider: this._agentProvider(payload, agentId),
            status: payload?.kind || payload?.status,
            ...spatialFields(payload),
        });
        if (played) this._rememberAgentCue(agentId, 'distress');
        return played;
    }

    _handleAttention(payload) {
        if (!this._signalRouting) return false;
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        if (this._agentCueIsRecent(agentId)) return false;
        if (this.hidden && this._hiddenSummonsHandler) {
            this._hiddenSummonsHandler(payload);
            return true;
        }
        return this.playSummons(payload);
    }

    playSummons(payload = {}) {
        const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
        if (this._agentCueIsRecent(agentId)) return false;
        const played = this.cue('summons', {
            agentId,
            label: this._agentLabel(payload, agentId),
            provider: this._agentProvider(payload, agentId),
            waitingCount: payload?.waitingCount,
            oldestWaitMs: payload?.oldestWaitMs,
            status: payload?.kind || payload?.status || payload?.agent?.status,
            ...spatialFields(payload),
        });
        if (played) this._rememberAgentCue(agentId, 'summons');
        return played;
    }

    _agentLabel(payload, agentId) {
        return payload?.agent?.name
            || payload?.agent?.agentName
            || this.world?.agents?.get?.(agentId)?.name
            || payload?.label
            || payload?.reason
            || null;
    }

    cue(kind, extra = {}) {
        if (!this.cueKit) return false;
        const payload = { phase: this._phase, ...extra };
        const agentId = payload.agentId ?? payload.agent?.id ?? null;
        if (agentId != null && payload.provider == null) {
            payload.provider = this._agentProvider(payload, agentId);
        }
        if (SPATIAL_CUES.has(kind)) {
            payload.screenX = this._resolveScreenX(payload, agentId);
        }
        payload.lane = this._laneForCue(kind, payload, agentId);
        if (cueLifecycleDecision({ lane: payload.lane, hidden: this.hidden }) !== 'play') {
            return false;
        }
        return this.cueKit.play(kind, payload);
    }

    _laneForCue(kind, payload, agentId) {
        if (kind === 'summons' || kind === 'distress') {
            const status = payload?.status
                || payload?.kind
                || payload?.agent?.status
                || this.world?.agents?.get?.(agentId)?.status;
            const bucket = bucketForStatus(status);
            if (bucket === 'errors') return CUE_LANES.ERRORS;
            if (bucket === 'quota') return CUE_LANES.QUOTA;
            // An attention summons is actionable even when an older producer
            // omitted its status field.
            return CUE_LANES.NEEDS_YOU;
        }
        if (kind === 'thunder' || kind === 'hourBell' || kind === 'aurora') {
            return CUE_LANES.SCENERY;
        }
        return CUE_LANES.ROUTINE;
    }

    // QA hook: pin a layer's level for `holdMs`, overriding the tick mapping.
    forceLayer(name, level, holdMs = 15000) {
        if (!this.layers[name]) return false;
        this._overrides.set(name, { level: clamp01(level), until: Date.now() + holdMs });
        this.layers[name].setLevel(clamp01(level), 0.3);
        return true;
    }

    _currentAtmosphere() {
        if (this._atmosphere && Date.now() - this._atmosphereAt < ATMO_FRESH_MS) {
            return this._atmosphere;
        }
        this._atmosphereSource = 'local';
        return createAtmosphereSnapshot({});
    }

    _tick() {
        if (!this.running) return;
        const atmosphere = this._currentAtmosphere();
        const weather = atmosphere.weather || {};
        const phase = atmosphere.phase || 'day';
        const phaseProgress = clamp01(atmosphere.phaseProgress);
        const season = seasonTokenForAtmosphere(atmosphere) || 'summer';
        const counts = bucketCounts(this.world);
        const working = Number(counts.working) || 0;
        const calm = actionableAgents(this.world).length === 0
            && working === 0
            && Number(counts.watchlist) === 0;
        this._quietFloor = updateQuietFloor(this._quietFloor, {
            calm,
            now: Date.now(),
            enterAfterMs: QUIET_ENTER_MS,
            leaveAfterMs: QUIET_LEAVE_MS,
        });

        this._phase = phase;
        const light = daylight(phase, phaseProgress);
        const intensity = clamp01(weather.intensity);
        const winter = season === 'winter';
        // Winter precipitation falls as snow on screen: hush the rain layer
        // and let the wind carry the scene instead.
        const precipitation = winter
            ? clamp01(weather.precipitation) * 0.12
            : clamp01(weather.precipitation);
        const storm = weather.type === 'storm' ? intensity : 0;

        const levels = {
            wind: clamp01(0.05 + intensity * 0.5 + (winter && weather.precipitation > 0.1 ? 0.1 : 0)),
            rain: precipitation,
            birds: clamp01(
                (phase === 'dawn' ? 0.55 + phaseProgress * 0.45
                    : phase === 'day' ? 0.3
                        : phase === 'dusk' ? 0.12 * (1 - phaseProgress) : 0)
                * (1 - precipitation * 0.9)
                * (1 - intensity * 0.35)
                * (BIRD_SEASON[season] ?? 1),
            ),
            crickets: clamp01(
                (phase === 'night' ? Math.min(phaseProgress, 1 - phaseProgress) * 10 : 0)
                * (CRICKET_SEASON[season] ?? 0.5)
                * (1 - precipitation * 0.8),
            ),
            hum: clamp01(working / 6) * (0.25 + 0.75 * light),
            bed: BED_LEVEL_BY_PHASE[phase] ?? 0.2,
            music: clamp01(0.75 * (phase === 'night' ? 0.7 : 1) * (storm > 0 ? 0.4 : 1)),
        };

        const pressure = this._readFramePressure();
        this._framePressureLevel = pressure;
        const detailScale = [1, 0.75, 0.4, 0][pressure] ?? 1;
        levels.birds *= detailScale;
        levels.crickets *= detailScale;
        levels.music *= [1, 0.85, 0.6, 0.35][pressure] ?? 1;
        if (pressure >= 2) levels.hum *= 0.6;

        if (this._quietFloor.mode === 'resting') {
            levels.wind *= 0.15;
            levels.rain *= 0.15;
            levels.birds = 0;
            levels.crickets = 0;
            levels.hum = 0;
            levels.bed *= 0.08;
            levels.music = 0;
        }

        for (const [name, override] of this._overrides) {
            if (Date.now() > override.until) this._overrides.delete(name);
            else levels[name] = override.level;
        }

        const scale = scaleForPhase(phase);
        this.layers.wind.setWind({
            strength: levels.wind,
            wind: Math.abs(Number(weather.windX) || 0),
            fog: clamp01(weather.fog),
        });
        this.layers.rain.setPrecipitation(levels.rain);
        this.layers.rain.setStorm(storm);
        this.layers.birds.setLevel(levels.birds);
        this.layers.crickets.setLevel(levels.crickets);
        this.layers.hum.setLevel(levels.hum);
        this.layers.bed.setLevel(levels.bed, 6);
        this.layers.bed.setScale(scale);
        this.layers.music.setLevel(levels.music);
        this.layers.music.setPhase(phase);
        this.layers.music.setRestScale(1 - clamp01(working / 8) * 0.35);
        this._levels = levels;

        // Hour bell during waking hours.
        const clock = atmosphere.clock || {};
        if (clock.minutes === 0 && clock.hours >= 8 && clock.hours <= 20
            && this._lastBellHour !== clock.hours) {
            if (this.cue('hourBell')) this._lastBellHour = clock.hours;
        }

        // Storm thunder fallback when the World loop (and its flash events)
        // is not running — Poisson-ish, roughly one strike per 15–25 ticks.
        if (storm > 0 && this._atmosphereSource === 'local' && Math.random() < 0.03 + storm * 0.04) {
            this.cue('thunder', { intensity: storm });
        }
    }

    snapshot() {
        return {
            running: this.running,
            state: this.hidden
                ? 'hidden'
                : (this.running ? this._quietFloor.mode : 'stopped'),
            resting: this.running && this._quietFloor.mode === 'resting',
            phase: this._phase,
            framePressureLevel: this._framePressureLevel,
            atmosphereSource: this._atmosphereSource,
            levels: { ...this._levels },
            lastCue: this.cueKit?.lastCue || null,
            nowPlaying: this.layers.music?.nowPlaying || null,
        };
    }

    _readFramePressure() {
        try {
            const snapshot = globalThis.window?.__claudeVillePerf?.frameHealth?.();
            const level = Number(snapshot?.level);
            return Number.isFinite(level) ? Math.max(0, Math.min(3, Math.round(level))) : 0;
        } catch {
            return 0;
        }
    }
}
