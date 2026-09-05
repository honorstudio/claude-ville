// BuildingSprite replaces BuildingRenderer. Draws buildings from sprites,
// exposes emitter points for particles, supports occlusion split for hero
// buildings. Reimplements the full BuildingRenderer external surface
// (setBuildings, setAgentSprites, setMotionScale, update, drawShadows,
// drawBubbles, getLightSources, hitTest, hoveredBuilding-as-setHovered).
//
// Roof-fade behaviour is intentionally dropped per spec §3.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { BUILDING_DEFS } from '../../config/buildings.js';
import { STATUS_VISUALS, WORLD_BODY_FONT } from '../../config/theme.js';
import { drawPixelFlame, fillPixelEllipse, strokePixelEllipse } from './PixelShapes.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { BUILDING_EVENTS, eventBus } from '../../domain/events/DomainEvent.js';
import { classifyTool } from '../../domain/services/ToolIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { normalizeLightingState, smokeWindDrift } from './AtmosphereState.js';
import { SMOKE_COOL_COLORS, SMOKE_WARM_COLORS } from './ParticleSystem.js';
import { getActiveMarkGovernor, MarkTier } from './MarkGovernor.js';
import { pulseBand01Frame } from './PulsePolicy.js';
import { buildingCenterToWorld, tileToWorld, worldToTile } from './Projection.js';
import {
    TaskboardBoardModel,
    taskboardBoardLayout,
} from './TaskboardBoardModel.js';
import {
    advanceNightOccupancyGate,
    buildingEmissiveGate,
    lightsBuildingWindows,
    nightWindowGate,
} from './NightOccupancyGate.js';
import {
    BUILDING_EMITTER_FALLBACKS,
    BUILDING_LIGHT_FALLBACKS,
    EMITTER_LIGHTS,
    getBuildingBeaconBase,
    getBuildingDoorSpillDescriptor,
    getBuildingEffectAnchor,
    getBuildingLabelAccent,
    getBuildingLabelEmblem,
    getBuildingLabelPriority,
    getBuildingOccupancyState,
    getBuildingPennantAnchor,
    getBuildingVisual,
    getBuildingWindowColor,
    getBuildingWindowRects,
    LIGHT_SOURCE_REGISTRY,
} from './BuildingVisualRegistry.js';

// READ translates canonical classifier reasons, never tool names or input text.
const READ_VERBS = Object.freeze({
    'edit-file': 'WRITING', 'write-file': 'WRITING', 'patch-file': 'WRITING',
    'edit-notebook': 'WRITING', 'generate-asset': 'WRITING', 'edit-docs': 'WRITING',
    'modify-files': 'WRITING',
    'read-local': 'READING', 'search-local': 'READING', 'find-local': 'READING',
    'list-local': 'READING', 'read-docs': 'READING', 'inspect-code': 'READING',
    'inspect-validation': 'READING', 'web-search': 'READING', 'web-fetch': 'READING',
    'web-tool': 'READING', 'external-research': 'READING',
    'plan-task': 'PLANNING', 'update-task': 'PLANNING', 'review-tasks': 'PLANNING',
    'plan-work': 'PLANNING', 'plan-mode-enter': 'PLANNING', 'plan-mode-exit': 'PLANNING',
});
const LANDMARK_LABEL_TYPES = new Set(
    BUILDING_DEFS
        .filter((b) => b.labelPriority === 'landmark')
        .map((b) => b.type),
);
const LABEL_VISIBLE_ZOOM = 1;
const LABEL_DETAIL_ZOOM = 3;
// #14 — below this zoom, parked occupants fold into a per-building status tally
// chip under the label instead of each drawing an individual name pill.
const TALLY_FOLD_ZOOM = 1.5;
// Order the status pips read, worst-to-best so the errored count anchors left.
const TALLY_STATUS_ORDER = [AgentStatus.ERRORED, AgentStatus.WAITING_ON_USER, AgentStatus.WORKING];
const LABEL_OVERLAP_TOLERANCE = 0.45;
const LABEL_COMPACT_OVERLAP_TOLERANCE = 0.62;
const MAX_TASKBOARD_PAPERS = 4;
const FORGE_GLOW_BASELINE = 0.22;
const FORGE_GLOW_DECAY_PER_SECOND = 0.32;
const LABEL_SHORT_TEXT = Object.fromEntries(
    BUILDING_DEFS
        .filter((building) => typeof building.shortLabel === 'string' && building.shortLabel.trim())
        .map((building) => [building.type, building.shortLabel.trim().toUpperCase()]),
);
const WATCHTOWER_LANTERN_FIRE = Object.freeze(getBuildingEffectAnchor('watchtower', 'lanternFire', {
    flame: [200, 68],
    light: [200, 66],
    particle: [200, 66],
}));
// #17 — Pharos searchlight: rotating distress beam pivot/length/width.
const WATCHTOWER_SEARCHLIGHT = Object.freeze(getBuildingEffectAnchor('watchtower', 'searchlight', {
    pivot: [200, 68],
    length: 320,
    width: 58,
}));
// Sweep angular velocity (rad/s) scales from calm→distressed across this range.
const SEARCHLIGHT_SPIN_CALM_RAD_PER_S = 0.45;
const SEARCHLIGHT_SPIN_DISTRESS_RAD_PER_S = 1.7;
const PARTICLE_ALIASES = {
    sparkle2: 'sparkle',
    sparkle3: 'sparkle',
    torch2: 'torch',
    torch3: 'torch',
    torch4: 'torch',
};
const OBSERVATORY_CLOCK_FACE = Object.freeze(getBuildingEffectAnchor('observatory', 'clockFace', {
    // Calibrated against the generated 256x288 single-image clock observatory base.
    // Composite reference is asserted at first draw so a regenerated sprite
    // with different dimensions logs a visible warning instead of silently
    // misplacing the clock hands.
    compositeRef: Object.freeze({ w: 256, h: 288 }),
    center: [80, 155],
    radius: 13,
    sourceSize: 40,
    sourceCenter: 20,
    sourceRadius: 18,
    hourHandLength: 10,
    minuteHandLength: 15,
}));
const MINE_SEAM_COLORS = ['#ffc15a', '#ff8a33', '#ff4528'];
const MINE_CARGO_CRYSTAL_COLORS = ['#bfe9ff', '#8fd0f4', '#e6f8ff'];
const MINE_CARGO_ORE_COLORS = ['#5c554b', '#3f3a33', '#7e6a50'];
// Presence tier -> (emitter chance ×, light radius ×, occupancy scalar 0..1).
// Occupancy feeds window warmth via 0.45 + 0.55 * scalar.
const PRESENCE_TIER_TABLE = Object.freeze({
    dormant:  { emitter: 0.3, radius: 0.85, occupancy: 0 },
    occupied: { emitter: 1.0, radius: 1.0, occupancy: 0.7 },
    busy:     { emitter: 1.6, radius: 1.15, occupancy: 1 },
});
// Observatory clock spin while a WebFetch/WebSearch/web.run ritual is active.
// Spin speed is in rad/s; ease back to 0 over OBSERVATORY_SPIN_EASE_MS.
const OBSERVATORY_WEB_RITUAL_TOOLS = new Set(['WebFetch', 'WebSearch', 'web.run']);
const OBSERVATORY_SPIN_RATE_RAD_PER_S = 0.9;
const OBSERVATORY_SPIN_EASE_MS = 1500;
// #52 — dome aperture (registry-anchored): opens with the night beacon, and a
// brief star burst pays off a completed web ritual. 6.5 — the same aperture
// carries a slow idle glint sweep when nothing is happening.
const OBSERVATORY_APERTURE = Object.freeze(getBuildingEffectAnchor('observatory', 'domeAperture', {
    slit: [149, 107],
    star: [149, 101],
    glintArc: { center: [149, 104], radius: 12, from: -2.4, to: -0.7 },
}));
const OBSERVATORY_BURST_MS = 1600;
const OBSERVATORY_GLINT_PERIOD_FRAMES = 540; // ≈9s at 60fps
// #53 — occupancy pennant cloth metrics (world px at zoom 1).
const PENNANT_POLE_PX = 18;
const PENNANT_FLY_PX = 18;
const PENNANT_DROP_PX = 10;
const REPO_PROFILE_CACHE_LIMIT = 128;
const BUILDING_ACTIVITY_STATE_WEIGHT = Object.freeze({
    idle: 0,
    occupied: 0.42,
    busy: 0.72,
    full: 0.9,
    alert: 1,
});
const BUILDING_DRAWABLE_SORT_BAND = Object.freeze({
    'building-back': 10,
    'building-front': 90,
    building: 95,
});
const FOUNDATION_MATERIALS = Object.freeze({
    'civic-cobble': Object.freeze({
        base: '#727064', stone: '#aaa58f', dark: '#514f47', wear: '#b8a57d', accent: '#6c7650',
    }),
    'knowledge-terrace': Object.freeze({
        base: '#64656a', stone: '#929397', dark: '#494a51', wear: '#aca17e', accent: '#667154',
    }),
    'workshop-yard': Object.freeze({
        base: '#655b50', stone: '#8c8172', dark: '#413d39', wear: '#8b674a', accent: '#403a36',
    }),
    'mine-yard': Object.freeze({
        base: '#5c554b', stone: '#77756f', dark: '#393c3f', wear: '#7e6a50', accent: '#405c61',
    }),
    'arcane-court': Object.freeze({
        base: '#4d485a', stone: '#757080', dark: '#35313e', wear: '#8b7d72', accent: '#76619a',
    }),
});

const TASKBOARD_PHASE_MARKERS = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);
const TASKBOARD_SLATE_RECT = Object.freeze({ x: 92, y: 76, w: 77, h: 69 });

function taskboardPhaseMarker(index) {
    return TASKBOARD_PHASE_MARKERS[index] || String(index + 1);
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function compareBuildingDrawableDepth(a, b) {
    return (a.sortY - b.sortY)
        || (BUILDING_DRAWABLE_SORT_BAND[a.kind] - BUILDING_DRAWABLE_SORT_BAND[b.kind]);
}

function shadowAngleForLighting(lighting) {
    if (Number.isFinite(lighting?.shadowAngleRad)) return lighting.shadowAngleRad;
    const sunX = Number(lighting?.sunDirIso?.x);
    const sunY = Number(lighting?.sunDirIso?.y);
    if (Number.isFinite(sunX) && Number.isFinite(sunY) && Math.hypot(sunX, sunY) > 0) {
        return Math.atan2(-sunY, -sunX);
    }
    return 0.28;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function hexToRgb(hex) {
    const text = String(hex || '').replace('#', '');
    const normalized = text.length === 3
        ? text.split('').map(char => char + char).join('')
        : text.padEnd(6, '0').slice(0, 6);
    const value = parseInt(normalized, 16);
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

function mixHex(a, b, t) {
    const from = hexToRgb(a);
    const to = hexToRgb(b);
    return `rgb(${Math.round(lerp(from.r, to.r, t))}, ${Math.round(lerp(from.g, to.g, t))}, ${Math.round(lerp(from.b, to.b, t))})`;
}

// Multiply saturation and luminance of a hex color in HSL space. Used by the
// state-aware label accent boost.
function brightenHex(hex, satMult = 1.2, lumMult = 1.2) {
    const { r, g, b } = hexToRgb(hex);
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0));
        else if (max === gf) h = ((bf - rf) / d + 2);
        else h = ((rf - gf) / d + 4);
        h /= 6;
    }
    const s2 = clamp01(s * satMult);
    const l2 = clamp01(l * lumMult);
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    };
    let r2, g2, b2;
    if (s2 === 0) { r2 = g2 = b2 = l2; }
    else {
        const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2;
        const p = 2 * l2 - q;
        r2 = hue2rgb(p, q, h + 1/3);
        g2 = hue2rgb(p, q, h);
        b2 = hue2rgb(p, q, h - 1/3);
    }
    const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}

function compactRitualLabel(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    return text.length > 10 ? `${text.slice(0, 8)}..` : text;
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

function chanceForDt(chancePerFrame, dt = 16) {
    const frameScale = Math.max(0, Math.min(3, dt / 16));
    return 1 - Math.pow(1 - clamp01(chancePerFrame), frameScale);
}

export class BuildingSprite {
    constructor(assets, spriteRenderer, particleSystem) {
        this.assets = assets;
        this.sprites = spriteRenderer;
        this.particles = particleSystem;
        this.buildings = [];
        this.agentSprites = [];
        this.hovered = null;
        this.frame = 0;
        this._drawablesCache = null;
        this._lightSourcesCache = null;
        this._labelMetricsCache = new Map();
        this._visitorCountByType = new Map();
        this._visitorStatusByType = new Map();
        this._clockCanvas = null;
        this._clockCanvasKey = '';
        this.clockState = null;
        this.lightingState = null;
        this.atmosphereState = null;
        this.ritualConductor = null;
        this.quotaState = null;
        this.harborStatus = { failedPushActive: false, activeWorkingCount: null };
        this._taskboardPapers = [];
        this._taskboardBoardModel = new TaskboardBoardModel();
        this._taskboardLayoutCache = new Map();
        this._seenTaskboardRituals = new Set();
        this._forgeGlow = FORGE_GLOW_BASELINE;
        this._presenceByType = new Map();
        this._litGateByType = new Map();
        this._onPresence = (map) => {
            this._presenceByType.clear();
            for (const [type, entry] of Object.entries(map || {})) {
                if (entry) this._presenceByType.set(type, entry);
            }
        };
        eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence);
        // Archive read intensity (0..1) sourced from LandmarkActivity.
        this._archiveReadIntensity = 0;
        this._onReadIntensity = (map) => {
            const next = Number(map?.archive);
            this._archiveReadIntensity = Number.isFinite(next) ? clamp01(next) : 0;
        };
        eventBus.on('building:read-intensity', this._onReadIntensity);
        // Observatory clock extra rotation while a web ritual is active.
        this._observatoryClockSpin = 0;
        // #52 — dome aperture result burst: ids of web rituals seen last tick;
        // a vanished id means the search completed and the dome star fires.
        this._observatoryWebRitualIds = new Set();
        this._observatoryBurstAt = -Infinity;
        // #53 — dominant occupant repo per building type (for pennant tint),
        // plus a bounded repoProfile cache keyed on the raw project string.
        this._visitorRepoByType = new Map();
        this._repoProfileCache = new Map();
        // #54 — last emitted village population; the empty-village tour in
        // Camera.js subscribes to the 'village:population' event we emit on
        // change. -1 forces an initial emit on the first update tick.
        this._lastAgentCount = -1;
        // #17 — watchtower searchlight sweep angle (rad), advanced in update().
        this._watchtowerSearchlightAngle = -0.34;
        // #40 — transient beam flare (0..1) kicked when an agent newly storms the
        // Pharos (errored/rate-limited); decays in _updateWatchtowerSearchlight so
        // the beam pulses brighter as a fresh incident arrives, then settles back
        // to the steady fleet-distress level. Held flat under reduced motion.
        this._watchtowerFlare = 0;
        this._onDistress = (event) => {
            if (event?.kind === 'recovered') return;
            this._watchtowerFlare = 1;
        };
        eventBus.on('distress:watchtower', this._onDistress);
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
        this._motionMq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this._onMotionChange = (e) => this.setMotionScale(e.matches ? 0 : 1);
        this._motionMq?.addEventListener?.('change', this._onMotionChange);
    }

    dispose() {
        this._motionMq?.removeEventListener?.('change', this._onMotionChange);
        eventBus.off(BUILDING_EVENTS.ACTIVE_AGENTS, this._onPresence);
        eventBus.off('building:read-intensity', this._onReadIntensity);
        eventBus.off('distress:watchtower', this._onDistress);
        this._litGateByType.clear();
    }

    _presenceTierFor(type) {
        return this._presenceByType.get(type)?.tier || 'dormant';
    }

    _nightShiftLit(type) {
        return this._litGateByType.get(type)?.value || 0;
    }

    _nightWindowGate() {
        return nightWindowGate(
            this.atmosphereState?.phase,
            this.atmosphereState?.phaseProgress,
        );
    }

    _emissiveGateFor(building) {
        return buildingEmissiveGate(
            this.atmosphereState?.phase,
            this.atmosphereState?.phaseProgress,
            this._nightShiftLit(building?.type),
        );
    }

    _buildingAlertFor(building) {
        return Boolean(this.harborStatus?.failedPushActive
            && (building?.type === 'watchtower' || building?.type === 'harbor'));
    }

    _quotaFiveHourRatio() {
        return clamp01(this.quotaState?.fiveHour ?? this.quotaState?.fiveHourRatio ?? 0);
    }

    setMotionScale(s) { this.motionScale = s; }

    setLightingState(state) {
        this.lightingState = state ? normalizeLightingState(state) : null;
    }

    setClockState(clock) {
        this.clockState = clock || null;
    }

    setAtmosphereState(atmosphere) {
        this.atmosphereState = atmosphere || null;
    }

    setRitualConductor(conductor) {
        this.ritualConductor = conductor || null;
    }

    setQuotaState(state) {
        this.quotaState = state || null;
    }

    setHarborStatus(status = {}) {
        const count = Number(status.activeWorkingCount);
        this.harborStatus = {
            failedPushActive: Boolean(status.failedPushActive),
            activeWorkingCount: Number.isFinite(count) ? Math.max(0, count) : null,
        };
    }

    setBuildings(map) {
        // Accepts a Map (preferred — matches world.buildings) or an Array.
        this.buildings = map instanceof Map ? Array.from(map.values()) : Array.from(map);
        this._drawablesCache = null;
        this._lightSourcesCache = null;
        this._labelMetricsCache.clear();
    }

    setAgentSprites(sprites) {
        this.agentSprites = sprites;
        this._taskboardBoardModel.updateAgentSprites(sprites);
        const cache = this._readAgentCache || (this._readAgentCache = new Map());
        let changed = cache.size !== sprites.length;
        const generation = this._readGeneration = (this._readGeneration || 0) + 1;
        for (const sprite of sprites) {
            const agent = sprite.agent;
            if (!agent) continue;
            const tool = agent.currentTool;
            const input = agent.currentToolInput;
            const prior = cache.get(agent.id);
            if (prior && prior.tool === tool && prior.input === input
                && prior.status === agent.status && prior.departed === agent.isDeparted) {
                sprite.readToolVerb = prior.verb;
                prior.generation = generation;
                continue;
            }
            const classified = classifyTool(tool, input);
            const entry = {
                generation,
                tool, input, status: agent.status, departed: agent.isDeparted,
                building: classified?.building || 'command',
                verb: READ_VERBS[classified?.reason] || 'OTHER',
            };
            sprite.readToolVerb = entry.verb;
            cache.set(agent.id, entry);
            changed = true;
        }
        for (const [id, entry] of cache) {
            if (entry.generation !== generation) {
                cache.delete(id);
                changed = true;
            }
        }
        if (changed) {
            const counts = this._readCounts || (this._readCounts = new Map());
            counts.clear();
            for (const entry of cache.values()) {
                if (entry.status !== AgentStatus.WORKING || entry.departed) continue;
                let verbs = counts.get(entry.building);
                if (!verbs) counts.set(entry.building, verbs = new Map());
                verbs.set(entry.verb, (verbs.get(entry.verb) || 0) + 1);
            }
            this._readPlaques = new Map(Array.from(counts, ([type, verbs]) => [
                type, Array.from(verbs, ([verb, count]) => `${verb} · ${count}`),
            ]));
        }
    }

    setTaskboardCandidates(ids) {
        this._taskboardCandidates = Array.isArray(ids)
            ? ids.filter((id) => typeof id === 'string' && id)
            : [];
    }

    setZoom(value) {
        const zoom = Number(value);
        this._zoom = Number.isFinite(zoom) ? zoom : 0;
    }

    _taskboardBoardAgent() {
        return this._taskboardBoardModel.resolve({
            candidates: this._taskboardCandidates || [],
            agentSprites: this.agentSprites,
        });
    }

    _taskboardViewFor(agent, maxItemRows) {
        if (!agent) return null;
        const signature = this._taskboardBoardModel.signatureFor(agent.id);
        const name = String(agent.displayName || agent.name || '').trim();
        const cached = this._taskboardLayoutCache.get(maxItemRows);
        if (cached?.agentId === agent.id && cached.signature === signature && cached.name === name) return cached.view;
        const layout = taskboardBoardLayout(agent.todos, { maxItemRows });
        if (!layout) return null;
        const phaseRows = layout.rows.filter((row) => row.kind === 'phase');
        const activePhase = phaseRows.find((row) => row.active) || null;
        let activeItems = layout.rows.filter((row) => row.kind === 'item');
        if (activePhase) {
            const start = layout.rows.indexOf(activePhase) + 1;
            activeItems = [];
            for (let index = start; index < layout.rows.length; index++) {
                const row = layout.rows[index];
                if (row.kind === 'phase') break;
                if (row.kind === 'item') activeItems.push(row);
            }
        }
        const currentItem = activeItems.find((row) => row.status === 'in_progress')
            || activeItems.find((row) => row.status === 'pending')
            || null;
        const currentItemText = currentItem?.text || '';
        const view = {
            layout,
            header: `${name} · ${layout.done}/${layout.total}`,
            activePhase: activePhase
                ? `${taskboardPhaseMarker(phaseRows.indexOf(activePhase))}. ${activePhase.text} · ${activePhase.done}/${activePhase.total}`
                : '',
            currentItem: currentItemText.length > 28
                ? `${currentItemText.slice(0, 27).trimEnd()}…`
                : currentItemText,
        };
        this._taskboardLayoutCache.set(maxItemRows, { agentId: agent.id, signature, name, view });
        return view;
    }

    drawGpuFunctionalOverlays(ctx) {
        const drawables = this.enumerateDrawables();
        for (let index = 0; index < drawables.length; index++) {
            const drawable = drawables[index];
            const splitPass = drawable.kind === 'building-back'
                ? 'back'
                : drawable.kind === 'building-front'
                    ? 'front'
                    : 'whole';
            this._drawFunctionalOverlay(
                ctx,
                drawable.building,
                drawable.entry,
                drawable.wx,
                drawable.wy,
                splitPass,
                drawable.horizonY ?? null,
            );
            this._drawOccupancyPennant(
                ctx,
                drawable.building,
                drawable.entry,
                drawable.wx,
                drawable.wy,
                splitPass,
                drawable.horizonY ?? null,
            );
        }
    }

    // Hover state does NOT invalidate _drawablesCache — drawDrawable reads
    // this.hovered live at draw time, so a fresh enumerate isn't required.
    setHovered(b) { this.hovered = b; }

    update(dt) {
        this.frame += (dt / 16) * (this.motionScale || 0);
        this._updateVisitorCounts();
        this._updateNightLightGates(dt);
        this._emitVillagePopulation();
        this._trackObservatoryWebRituals();
        this._syncTaskboardPapers(Date.now());
        this._updateForgeGlow(dt);
        this._updateObservatoryClockSpin(dt);
        this._updateWatchtowerSearchlight(dt);
        for (const b of this.buildings) this._spawnEmittersFor(b, dt);
    }

    // #54 — publish the live village population whenever it changes so the
    // Camera's empty-village tour can engage/yield without a renderer reference.
    // Initial tick always emits (last count starts at -1).
    _emitVillagePopulation() {
        const count = this.agentSprites?.length || 0;
        if (count === this._lastAgentCount) return;
        this._lastAgentCount = count;
        eventBus.emit('village:population', { count, empty: count === 0 });
    }

    // #52 — diff the observatory's web-ritual set tick over tick; a ritual that
    // vanished since last tick completed, so fire the dome result burst then.
    _trackObservatoryWebRituals() {
        const current = new Set();
        for (const ritual of this._ritualsFor('observatory')) {
            if (OBSERVATORY_WEB_RITUAL_TOOLS.has(ritual?.tool)) current.add(ritual);
        }
        for (const ritual of this._observatoryWebRitualIds) {
            if (!current.has(ritual)) {
                this._observatoryBurstAt = Date.now();
                this._spawnObservatoryBurstParticles();
                break;
            }
        }
        this._observatoryWebRitualIds = current;
    }

    _spawnObservatoryBurstParticles() {
        if (!this.motionScale || !this.particles) return;
        const observatory = this.buildings.find((b) => b.type === 'observatory');
        if (!observatory) return;
        const center = this._buildingScreenCenter(observatory);
        const anchor = this.assets.getAnchor('building.observatory');
        const star = OBSERVATORY_APERTURE.star;
        this.particles.spawn('sparkle',
            center.x - anchor[0] + star[0],
            center.y - anchor[1] + star[1],
            {
                count: 7,
                colors: ['#fff1a8', '#d9c7ff', '#ffffff'],
                size: [1, 2.4],
                life: [26, 48],
                speed: [0.25, 0.7],
                spread: [4, 8],
            });
    }

    // Tick the extra clock spin while a web ritual is active at the
    // Observatory; ease back to 0 within OBSERVATORY_SPIN_EASE_MS once it ends.
    // Held at 0 under reduced motion so the time-of-day hands stay still.
    _updateObservatoryClockSpin(dt) {
        if (!this.motionScale) {
            this._observatoryClockSpin = 0;
            return;
        }
        const seconds = Math.max(0, Number(dt) || 0) / 1000;
        if (this._hasObservatoryWebRitual()) {
            this._observatoryClockSpin = (this._observatoryClockSpin + seconds * OBSERVATORY_SPIN_RATE_RAD_PER_S) % (Math.PI * 2);
            return;
        }
        if (this._observatoryClockSpin <= 0) return;
        const easePerSecond = (Math.PI * 2) / (OBSERVATORY_SPIN_EASE_MS / 1000);
        this._observatoryClockSpin = Math.max(0, this._observatoryClockSpin - seconds * easePerSecond);
    }

    _hasObservatoryWebRitual() {
        const rituals = this._ritualsFor('observatory');
        for (const ritual of rituals) {
            if (OBSERVATORY_WEB_RITUAL_TOOLS.has(ritual?.tool)) return true;
        }
        return false;
    }

    // #17 — Fleet distress barometer (0..1): share of the fleet that is errored
    // or rate-limited, with a floor while a push has failed at the harbor. Drives
    // the watchtower searchlight's sweep speed and amber→red colour shift.
    _fleetDistressRatio() {
        const sprites = this.agentSprites || [];
        let total = 0;
        let distressed = 0;
        for (const sprite of sprites) {
            const status = sprite?.agent?.status;
            if (!status) continue;
            total += 1;
            if (status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED) distressed += 1;
        }
        const share = total > 0 ? distressed / total : 0;
        const floor = this.harborStatus?.failedPushActive ? 0.34 : 0;
        return clamp01(Math.max(share, floor));
    }

    // Advance the searchlight sweep; angular velocity rises with fleet distress
    // so a troubled fleet visibly spins the beam faster. Held still under reduced
    // motion (the static directional wedge is drawn at the last angle instead).
    _updateWatchtowerSearchlight(dt) {
        if (!this.motionScale) return;
        const seconds = Math.max(0, Number(dt) || 0) / 1000;
        const distress = this._fleetDistressRatio();
        const rate = lerp(SEARCHLIGHT_SPIN_CALM_RAD_PER_S, SEARCHLIGHT_SPIN_DISTRESS_RAD_PER_S, distress);
        this._watchtowerSearchlightAngle = (this._watchtowerSearchlightAngle + seconds * rate) % (Math.PI * 2);
        // #40 — ease the incident flare back to rest over ~1.4s.
        if (this._watchtowerFlare > 0) {
            this._watchtowerFlare = Math.max(0, this._watchtowerFlare - seconds / 1.4);
        }
    }

    // Static site materials are baked with terrain. They deliberately retain
    // the underlying tile texture and never draw a complete perimeter or lip.
    drawGroundFoundations(ctx) {
        for (const building of this.buildings) {
            const grounding = getBuildingVisual(building.type)?.grounding;
            if (!grounding?.foundation?.enabled) continue;
            const material = FOUNDATION_MATERIALS[grounding.material];
            if (!material) continue;
            this._drawGroundFoundation(ctx, building, grounding, material);
        }
    }

    _drawGroundFoundation(ctx, building, grounding, material) {
        const corners = this._buildingFootprintCorners(building);
        const foundation = grounding.foundation;
        const seed = hashText(`foundation:${building.type}:${building.position.tileX}:${building.position.tileY}`);
        const minX = Math.floor(Math.min(corners.nw.x, corners.ne.x, corners.se.x, corners.sw.x));
        const maxX = Math.ceil(Math.max(corners.nw.x, corners.ne.x, corners.se.x, corners.sw.x));
        const minY = Math.floor(Math.min(corners.nw.y, corners.ne.y, corners.se.y, corners.sw.y));
        const maxY = Math.ceil(Math.max(corners.nw.y, corners.ne.y, corners.se.y, corners.sw.y));
        const opacity = clamp01(foundation.opacity ?? 0.5);
        const density = clamp01(foundation.density ?? 0.45);

        ctx.save();
        this._traceFootprint(ctx, corners);
        ctx.clip();
        ctx.globalAlpha = opacity * 0.1;
        ctx.fillStyle = material.base;
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

        for (let y = minY + 2; y < maxY; y += 5) {
            for (let x = minX + ((y + seed) % 7); x < maxX; x += 7) {
                const noise = this._groundingNoise(x, y, seed);
                if (noise > density) continue;
                const variant = this._groundingNoise(y, x, seed ^ 0x45d9f3b);
                ctx.globalAlpha = opacity * (0.3 + variant * 0.42);
                ctx.fillStyle = variant > 0.76
                    ? material.accent
                    : variant > 0.42 ? material.stone : material.dark;
                const width = variant > 0.7 ? 5 : variant > 0.35 ? 3 : 2;
                ctx.fillRect(Math.round(x), Math.round(y), width, variant > 0.62 ? 2 : 1);
            }
        }
        this._drawFoundationThreshold(ctx, building, grounding, material, opacity);
        ctx.restore();
    }

    _drawFoundationThreshold(ctx, building, grounding, material, opacity) {
        const entrance = building.entrance;
        if (!Number.isFinite(entrance?.tileX) || !Number.isFinite(entrance?.tileY)) return;
        const from = this._tileToScreen(entrance.tileX, entrance.tileY);
        const center = this._buildingScreenCenter(building);
        const reach = clamp01(grounding.foundation?.thresholdReach ?? 0.55);
        const to = {
            x: from.x + (center.x - from.x) * reach,
            y: from.y + (center.y - from.y) * reach,
        };
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const steps = Math.max(4, Math.round(length / 9));
        const ux = dx / length;
        const uy = dy / length;

        if (grounding.material === 'mine-yard') {
            const nx = -uy * 5;
            const ny = ux * 5;
            ctx.globalAlpha = opacity * 0.88;
            ctx.strokeStyle = material.dark;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(from.x + nx, from.y + ny);
            ctx.lineTo(to.x + nx, to.y + ny);
            ctx.moveTo(from.x - nx, from.y - ny);
            ctx.lineTo(to.x - nx, to.y - ny);
            ctx.stroke();
            ctx.fillStyle = material.wear;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = Math.round(from.x + dx * t);
                const y = Math.round(from.y + dy * t);
                ctx.fillRect(x - 7, y - 1, 14, 2);
            }
            return;
        }

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(from.x + dx * t);
            const y = Math.round(from.y + dy * t);
            ctx.globalAlpha = opacity * (0.48 + (i % 3) * 0.12);
            ctx.fillStyle = i % 4 === 0 ? material.wear : material.stone;
            ctx.beginPath();
            ctx.moveTo(x, y - 3);
            ctx.lineTo(x + 7, y);
            ctx.lineTo(x, y + 3);
            ctx.lineTo(x - 7, y);
            ctx.closePath();
            ctx.fill();
        }
    }

    _groundingNoise(x, y, seed) {
        let value = Math.imul((Math.round(x) ^ seed) >>> 0, 0x45d9f3b);
        value = Math.imul((value ^ (value >>> 16) ^ Math.round(y)) >>> 0, 0x45d9f3b);
        value ^= value >>> 16;
        return (value >>> 0) / 4294967295;
    }

    // Physical shadows follow declared structural contact, never sprite canvas
    // width or the outer terrain apron.
    drawShadows(ctx) {
        const lighting = this.lightingState || {};
        const shadowLength = lighting.shadowLength ?? 1;
        const shadowAlpha = lighting.shadowAlpha ?? 0.22;
        const shadowAngle = shadowAngleForLighting(lighting);
        for (const b of this.buildings) {
            const grounding = getBuildingVisual(b.type)?.grounding;
            const contact = grounding?.contact;
            const c = this._buildingScreenCenter(b);
            const isLandmark = LANDMARK_LABEL_TYPES.has(b.type);
            const isHovered = this.hovered === b;
            ctx.save();
            if (grounding?.shadow !== 'none' && contact?.width > 0 && contact?.depth > 0) {
                this._drawStructureShadow(ctx, c, grounding, contact, {
                    shadowLength,
                    shadowAlpha,
                    shadowAngle,
                });
            }
            this._drawBuildingActivityFootprint(ctx, b, { isLandmark, isHovered });
            if (isHovered) this._drawBuildingHoverFootprint(ctx, b);
            ctx.restore();
        }
    }

    _drawStructureShadow(ctx, center, grounding, contact, lighting) {
        const offsetScale = grounding.shadow === 'tower-cast' ? 0.72 : 0.3;
        const offsetX = Math.cos(lighting.shadowAngle) * 12 * lighting.shadowLength * offsetScale;
        const offsetY = Math.sin(lighting.shadowAngle) * 7 * lighting.shadowLength * offsetScale;
        const cx = center.x + (contact.offsetX || 0) + offsetX;
        const cy = center.y + (contact.offsetY || 0) + offsetY;
        const rx = contact.width / 2;
        const ry = contact.depth / 2;
        ctx.fillStyle = '#0f161e';
        ctx.globalAlpha = lighting.shadowAlpha * (contact.opacity ?? 0.75);
        this._fillSteppedEllipse(ctx, cx, cy, rx, ry);

        if (grounding.shadow !== 'tower-cast' || !contact.castLength) return;
        const length = contact.castLength * Math.max(0.45, lighting.shadowLength);
        const steps = Math.max(3, Math.round(length / 9));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            ctx.globalAlpha = lighting.shadowAlpha * (contact.opacity ?? 0.75) * (1 - t) * 0.48;
            this._fillSteppedEllipse(
                ctx,
                cx + Math.cos(lighting.shadowAngle) * length * t,
                cy + Math.sin(lighting.shadowAngle) * length * 0.55 * t,
                rx * (1 - t * 0.68),
                Math.max(2, ry * (1 - t * 0.76)),
            );
        }
    }

    _fillSteppedEllipse(ctx, cx, cy, rx, ry) {
        const rowHeight = 2;
        for (let y = -ry; y <= ry; y += rowHeight) {
            const normalized = y / Math.max(1, ry);
            const half = rx * Math.sqrt(Math.max(0, 1 - normalized * normalized));
            ctx.fillRect(
                Math.round(cx - half),
                Math.round(cy + y),
                Math.max(1, Math.round(half * 2)),
                rowHeight,
            );
        }
    }

    _drawBuildingHoverFootprint(ctx, building) {
        ctx.globalAlpha = 0.82;
        ctx.strokeStyle = 'rgba(255, 232, 166, 0.82)';
        ctx.lineWidth = 2;
        this._traceFootprint(ctx, this._buildingFootprintCorners(building));
        ctx.stroke();
    }

    // Persistent building labels (parchment tag + identity badge) above each sprite.
    // Restores parity with the legacy BuildingRenderer label pass and adds a per-type
    // icon glyph so similar-looking sprites stay distinguishable. Drawn as a top overlay
    // (called from IsometricRenderer._render after drawBubbles) so labels stay readable
    // regardless of depth-sort occlusion.
    drawLabels(ctx, {
        zoom = 1,
        occupiedBoxes = [],
        harborPendingRepos = [],
        scaleMode = 'screen-fixed',
        readMode = false,
    } = {}) {
        const labelScale = 1 / Math.max(0.01, zoom);
        const occupied = [];
        const normalizedOccupiedBoxes = this._normalizeBoxes(occupiedBoxes);
        const harborLedgerRows = this._harborLedgerRows(harborPendingRepos);
        const buildingList = [...this.buildings].sort((a, b) => {
            const ac = this._buildingScreenCenter(a);
            const bc = this._buildingScreenCenter(b);
            return ac.y - bc.y;
        });

        for (const b of buildingList) {
            const rawLabel = this._resolveBuildingLabelText(b);
            if (!rawLabel) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const isHovered = this.hovered === b;
            const visual = getBuildingVisual(b.type);
            const registryLabelPriority = getBuildingLabelPriority(b.type, b.labelPriority);
            const isLandmark = registryLabelPriority === 'landmark' || b.labelPriority === 'landmark' || LANDMARK_LABEL_TYPES.has(b.type);
            const localLabelDensity = this._estimateLocalLabelDensity(occupied, center.x, center.y);

            ctx.save();
            const failedPushAlert = b.type === 'watchtower' && this.harborStatus?.failedPushActive;
            const occupancy = this._buildingOccupancyInfo(b, { alert: failedPushAlert });
            const baseAccent = getBuildingLabelAccent(b.type, '#d6a951');
            const presenceActive = occupancy.state !== 'idle';
            const accent = failedPushAlert
                ? '#ff755d'
                : this._occupancyAccent(baseAccent, occupancy.state);
            const textColor = isHovered ? '#fff6cf' : isLandmark ? '#ffe7a3' : '#e8c982';
            const anchorY = this.assets.getAnchor(`building.${b.type}`)?.[1] ?? dims.h;
            const firstOpaque = this.assets.getMask?.(`building.${b.type}`)?.indexOf(1) ?? 0;
            const spriteTop = Math.round(center.y - anchorY) + Math.floor(Math.max(0, firstOpaque) / dims.w);
            const baseY = spriteTop - (isHovered ? 34 : isLandmark ? 28 : 24) * labelScale;
            const baseX = center.x;

            const blocksAgentRectangles = true;
            const labelAttempts = this._labelRenderAttempts(b, {
                isHovered,
                isLandmark,
                zoom,
                localLabelDensity,
                harborLedgerRows,
                readRows: readMode ? this._readPlaques?.get(b.type) : null,
            });
            let chosen = null;

            for (const attempt of labelAttempts) {
                ctx.font = attempt.labelFont;
                const { displayText, width: tw } = this._labelMetrics(ctx, b, {
                    text: attempt.text,
                    labelFont: attempt.labelFont,
                    maxTextWidth: attempt.maxTextWidth,
                    zoom,
                    isHovered,
                    isLandmark,
                    scaleMode,
                });
                let displaySubText = '';
                let displaySubRows = [];
                let subTw = 0;
                if (Array.isArray(attempt.subRows) && attempt.subRows.length) {
                    ctx.font = attempt.subFont || attempt.labelFont;
                    displaySubRows = attempt.subRows.map((row) => {
                        const subMetrics = this._labelMetrics(ctx, b, {
                            text: row.label,
                            labelFont: attempt.subFont || attempt.labelFont,
                            maxTextWidth: attempt.subMaxTextWidth || attempt.maxTextWidth,
                            zoom,
                            isHovered,
                            isLandmark,
                            scaleMode,
                        });
                        subTw = Math.max(subTw, subMetrics.width);
                        return { ...row, label: subMetrics.displayText };
                    });
                } else if (attempt.subText) {
                    ctx.font = attempt.subFont || attempt.labelFont;
                    const subMetrics = this._labelMetrics(ctx, b, {
                        text: attempt.subText,
                        labelFont: attempt.subFont || attempt.labelFont,
                        maxTextWidth: attempt.subMaxTextWidth || attempt.maxTextWidth,
                        zoom,
                        isHovered,
                        isLandmark,
                        scaleMode,
                    });
                    displaySubText = subMetrics.displayText;
                    subTw = subMetrics.width;
                }
                const subIconSpace = displaySubRows.length ? 11 : 0;
                const tagW = Math.ceil(Math.max(tw, subTw + subIconSpace) + attempt.iconSize + attempt.iconGap + attempt.padX * 2 + (isLandmark ? 8 : 0));
                const tagH = attempt.tagH;
                const layout = this._resolveLabelLayout({
                    candidates: this._labelLayoutCandidates(isLandmark, isHovered).map(({ dx, dy }) => ({ dx: dx * labelScale, dy: dy * labelScale })),
                    occupied,
                    occupiedExternal: normalizedOccupiedBoxes,
                    centerX: baseX,
                    centerY: baseY,
                    tagW: tagW * labelScale,
                    tagH: tagH * labelScale,
                    isLandmark,
                    maxOverlap: attempt.overlapTolerance,
                    localLabelDensity,
                });
                if (!layout) continue;

                const bx = layout.x;
                const by = layout.y;
                const tagLeft = bx - tagW / 2;
                const tagTop = by - tagH / 2;
                const labelBox = layout.box || {
                    left: tagLeft - 4,
                    top: tagTop - 4,
                    right: tagLeft + tagW + 4,
                    bottom: tagTop + tagH + 10,
                };
                const labelOverlap = layout.overlap != null ? layout.overlap : this._boxesOverlapRatio(labelBox, occupied);
                if (labelOverlap > attempt.overlapTolerance) {
                    continue;
                }
                if (blocksAgentRectangles && attempt.blockAgents && this._boxesOverlapRatio(labelBox, normalizedOccupiedBoxes) > attempt.overlapTolerance) {
                    continue;
                }
                chosen = {
                    ...attempt,
                    displayText,
                    displaySubText,
                    displaySubRows,
                    tagW,
                    tagH,
                    bx,
                    by,
                    tagLeft,
                    tagTop,
                    labelBox,
                    layout,
                };
                break;
            }

            if (!chosen) {
                ctx.restore();
                continue;
            }
            const {
                displayText,
                displaySubText,
                displaySubRows = [],
                tagW,
                tagH,
                bx,
                by,
                tagLeft,
                tagTop,
                labelBox,
                iconSize,
                iconGap,
                padX,
                degraded = false,
                labelFont: chosenFont,
                subFont,
            } = chosen;
            occupied.push(labelBox);
            const labelAlpha = degraded ? 0.52 : 1;
            const glowAlpha = degraded ? 0.55 : (isHovered ? 1 : 0.92);

            // F5 — plaques use the same screen-fixed scale policy as agent
            // name tags. Layout remains in world space, while the tag itself
            // counter-scales around its chosen anchor. The stalk is drawn
            // after this restore so it remains world-space geometry.
            ctx.save();
            ctx.translate(bx, by);
            ctx.scale(labelScale, labelScale);
            ctx.translate(-bx, -by);

            // Banner shadow and landmark glow: deliberately map-like rather than debug UI.
            if (isHovered || isLandmark) {
                ctx.fillStyle = isHovered
                    ? 'rgba(242, 211, 107, 0.28)'
                    : `rgba(214, 169, 81, ${isLandmark ? 0.08 : 0.16})`;
                ctx.beginPath();
                ctx.ellipse(bx, by + tagH / 2 + 3, tagW / 2 + 8, isHovered ? 7 : 5, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            const notch = isHovered || isLandmark ? 6 : 4;
            const isHarborLedger = b.type === 'harbor' && (displaySubText || displaySubRows.length);
            const poleBottom = spriteTop + 2 * labelScale;

            ctx.globalAlpha = isHovered ? 1 : degraded ? labelAlpha : isLandmark ? 0.96 : 0.78;
            ctx.strokeStyle = isHovered ? 'rgba(255, 242, 197, 0.9)' : isHarborLedger ? 'rgba(113, 73, 31, 0.92)' : isLandmark ? 'rgba(242, 211, 107, 0.72)' : 'rgba(215, 185, 121, 0.62)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(tagLeft + notch, tagTop);
            ctx.lineTo(tagLeft + tagW - notch, tagTop);
            ctx.lineTo(tagLeft + tagW, by);
            ctx.lineTo(tagLeft + tagW - notch, tagTop + tagH);
            ctx.lineTo(tagLeft + notch, tagTop + tagH);
            ctx.lineTo(tagLeft, by);
            ctx.closePath();
            ctx.fillStyle = isHarborLedger
                ? (isHovered ? 'rgba(99, 62, 29, 0.98)' : 'rgba(72, 45, 24, 0.95)')
                : isHovered
                    ? 'rgba(70, 42, 22, 0.97)'
                    : isLandmark
                        ? 'rgba(58, 36, 21, 0.93)'
                        : 'rgba(42, 28, 18, 0.88)';
            ctx.fill();
            ctx.stroke();

            if (isLandmark || isHovered) {
                ctx.fillStyle = 'rgba(255, 225, 139, 0.13)';
                ctx.fillRect(tagLeft + 8, tagTop + 6, tagW - 16, 1);
                ctx.fillStyle = 'rgba(25, 15, 9, 0.22)';
                ctx.fillRect(tagLeft + 7, tagTop + tagH - 5, tagW - 14, 1);
                ctx.fillStyle = 'rgba(185, 123, 54, 0.5)';
                ctx.fillRect(tagLeft + 4, by - 1, 3, 3);
                ctx.fillRect(tagLeft + tagW - 7, by - 1, 3, 3);
            }

            if (isHovered || isLandmark) {
                ctx.fillStyle = accent;
                ctx.globalAlpha = this._pulseBandAlpha(visual, occupancy, isHovered ? 0.95 : glowAlpha);
                ctx.fillRect(tagLeft + 5, tagTop + 3, tagW - 10, 2);
                if (isHarborLedger) {
                    ctx.fillStyle = 'rgba(35, 21, 12, 0.6)';
                    ctx.fillRect(tagLeft + padX + iconSize + iconGap, by + 1, tagW - padX * 2 - iconSize - iconGap - 4, 1);
                }
                ctx.globalAlpha = isHovered ? 1 : glowAlpha;
            }

            if (!isHarborLedger && (isLandmark || isHovered)) {
                this._drawCapacityMeter(ctx, {
                    tagLeft,
                    tagTop,
                    tagW,
                    tagH,
                    padX,
                    accent,
                    occupancy,
                    isHovered,
                    isLandmark,
                });
            }

            // Identity badge: hand-drawn guild emblem, not a plain letter token.
            if (b.icon) {
                const iconCx = tagLeft + padX + iconSize / 2 + (isLandmark ? 2 : 0);
                const iconCy = by;
                this._drawLabelEmblem(ctx, b, iconCx, iconCy, iconSize, {
                    accent,
                    isHovered,
                    isLandmark,
                });
                // Presence dot: 3px accent-coloured pip immediately left of the
                // icon when the building is occupied/busy or in failed-push alert.
                if ((presenceActive || failedPushAlert) && iconSize > 0 && padX >= 5) {
                    ctx.save();
                    ctx.fillStyle = accent;
                    ctx.globalAlpha = 1;
                    ctx.beginPath();
                    ctx.arc(iconCx - iconSize / 2 - 3, iconCy, 1.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                }
            }

            // Label text.
            ctx.save();
            ctx.fillStyle = textColor;
            ctx.font = chosenFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            this._applyReadableLabelShadow(ctx);
            // Pixel-font labels (Press Start 2P) blur when drawn at fractional
            // coordinates; snap the text origin and per-row baselines to whole
            // pixels so the harbor ledger and building labels stay crisp unzoomed.
            const textX = Math.round(tagLeft + padX + iconSize + iconGap + (isLandmark ? 2 : 0));
            if (displaySubRows.length) {
                const titleY = Math.round(isHarborLedger ? by - 15 : by - 5);
                const rowStartY = Math.round(isHarborLedger ? by + 2 : by + 6);
                const rowGap = isHarborLedger ? 12 : 8;
                ctx.fillText(displayText, textX, titleY);
                ctx.font = subFont || chosenFont;
                // Departure Mono ledger rows: vertical-only shadow so the diagonal
                // offset doesn't smear the hairline strokes / the (N) commit count.
                if (isHarborLedger) ctx.shadowOffsetX = 0;
                displaySubRows.forEach((row, index) => {
                    const rowY = rowStartY + index * rowGap;
                    this._drawRepoRowIcon(ctx, textX + 3, rowY, row.profile);
                    ctx.fillStyle = row.color || '#f6d384';
                    ctx.fillText(row.label, textX + 11, rowY);
                });
            } else if (displaySubText) {
                ctx.fillText(displayText, textX, Math.round(by - 5));
                ctx.fillStyle = isHarborLedger ? '#f6d384' : textColor;
                ctx.font = subFont || chosenFont;
                ctx.fillText(displaySubText, textX, Math.round(by + 6));
            } else {
                ctx.fillText(displayText, textX, by + 0.5);
            }
            ctx.restore();

            // #14 — at low zoom, fold parked occupants into a status-tally chip
            // tucked under the label so the busy-building pill-soup stays legible.
            if (zoom < TALLY_FOLD_ZOOM) {
                this._drawStatusTallyChip(ctx, b, bx, tagTop + tagH + 3);
            }

            ctx.restore();

            ctx.strokeStyle = isHovered ? 'rgba(255, 242, 197, 0.72)' : isLandmark ? 'rgba(242, 211, 107, 0.5)' : 'rgba(215, 185, 121, 0.26)';
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(bx, by + (tagH / 2 - 1) * labelScale);
            ctx.lineTo(baseX, poleBottom);
            ctx.stroke();

            ctx.fillStyle = isHovered ? 'rgba(255, 232, 166, 0.62)' : 'rgba(151, 99, 43, 0.46)';
            ctx.beginPath();
            ctx.ellipse(baseX, poleBottom + 1, isHovered ? 5 : 3, isHovered ? 2 : 1.5, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }
    }

    // Compact working/waiting/errored tally drawn beneath a building label when
    // occupants' individual name pills are suppressed (IsometricRenderer folds
    // those slots at the same TALLY_FOLD_ZOOM threshold). Static — no motion.
    _drawStatusTallyChip(ctx, building, cx, topY) {
        const tally = this._visitorStatusByType.get(building?.type);
        if (!tally) return;
        const pips = TALLY_STATUS_ORDER
            .map((status) => ({ status, count: tally[status] || 0 }))
            .filter((pip) => pip.count > 0);
        if (!pips.length) return;

        ctx.save();
        ctx.font = '6px "Press Start 2P", monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        const dot = 4;
        const gap = 3;
        const segGap = 7;
        const padX = 4;
        const h = 11;
        // Measure each "● N" segment to size the chip.
        const segments = pips.map((pip) => {
            const text = String(pip.count);
            const tw = Math.ceil(ctx.measureText(text).width);
            return { ...pip, text, tw, w: dot + gap + tw };
        });
        const contentW = segments.reduce((sum, seg) => sum + seg.w, 0) + segGap * (segments.length - 1);
        const w = contentW + padX * 2;
        const left = Math.round(cx - w / 2);
        const top = Math.round(topY);

        ctx.fillStyle = 'rgba(28, 18, 12, 0.86)';
        ctx.strokeStyle = 'rgba(215, 185, 121, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(left, top, w, h, 3);
        else ctx.rect(left, top, w, h);
        ctx.fill();
        ctx.stroke();

        let x = left + padX;
        const midY = top + h / 2;
        for (const seg of segments) {
            const color = STATUS_VISUALS[seg.status]?.color || '#e8c982';
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(Math.round(x + dot / 2), midY, dot / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = color;
            ctx.fillText(seg.text, Math.round(x + dot + gap), midY + 0.5);
            x += seg.w + segGap;
        }
        ctx.restore();
    }

    _labelLayoutCandidates(isLandmark, isHovered) {
        const major = isLandmark || isHovered;
        const drift = major ? 9 : 7;
        return [
            { dx: 0, dy: 0 },
            { dx: -drift, dy: -9 },
            { dx: drift, dy: -9 },
            { dx: -drift, dy: 9 },
            { dx: drift, dy: 9 },
            { dx: major ? 0 : -4, dy: -14 },
            { dx: major ? 0 : 4, dy: -14 },
            { dx: 0, dy: major ? 18 : 14 },
            { dx: -drift, dy: major ? 18 : 14 },
            { dx: drift, dy: major ? 18 : 14 },
            { dx: major ? 0 : -6, dy: major ? 26 : 19 },
            { dx: major ? 0 : 6, dy: major ? 26 : 19 },
            { dx: -drift, dy: -18 },
            { dx: drift, dy: -18 },
        ];
    }

    _labelRenderAttempts(building, { isHovered, isLandmark, zoom, localLabelDensity = 0, harborLedgerRows = [], readRows = null }) {
        if (readRows?.length) {
            return [{
                text: readRows[0],
                subRows: readRows.slice(1).map(label => ({ label })),
                labelFont: `bold 11px ${WORLD_BODY_FONT}`,
                subFont: `11px ${WORLD_BODY_FONT}`,
                maxTextWidth: 180, subMaxTextWidth: 180,
                iconSize: 16, iconGap: 7, padX: 10,
                tagH: 24 + (readRows.length - 1) * 16,
                overlapTolerance: 1, blockAgents: false, degraded: false,
            }];
        }
        const baseText = this._labelTextFor(building, zoom, isHovered);
        const compactText = this._labelTextFor(building, LABEL_VISIBLE_ZOOM, false);
        const tinyText = this._labelTinyTextFor(building, compactText);
        const densityPacked = localLabelDensity >= 2;
        const widthScale = densityPacked ? 0.86 : 1;
        const scale = densityPacked ? 0.92 : 1;
        const overlapScale = densityPacked ? 1.2 : 1;
        const isHarborLedger = building.type === 'harbor' && harborLedgerRows.length > 0;
        const labelFont = isHovered || isLandmark
            ? 'bold 9px "Press Start 2P", monospace'
            : '7px "Press Start 2P", monospace';
        const attempts = [
            {
                text: isHarborLedger ? compactText : baseText,
                subRows: isHarborLedger ? harborLedgerRows : [],
                subFont: isHarborLedger ? `11px ${WORLD_BODY_FONT}` : '7px "Press Start 2P", monospace',
                subMaxTextWidth: Math.round((isHarborLedger ? (isHovered ? 214 : 184) : (isHovered ? 158 : 132)) * widthScale),
                labelFont,
                maxTextWidth: Math.round((isHarborLedger ? (isHovered ? 220 : 180) : isHovered ? 190 : isLandmark ? 132 : 96) * widthScale),
                iconSize: building.icon ? (isHarborLedger ? (isHovered || isLandmark ? 24 : 20) : (isHovered || isLandmark ? 22 : 16)) * scale : 0,
                iconGap: building.icon ? (isHarborLedger ? 9 : 7) * scale : 0,
                padX: isHarborLedger ? (isHovered || isLandmark ? 15 : 13) : (isHovered || isLandmark ? 12 : 8),
                iconFont: isHovered || isLandmark ? 9 : 8,
                tagH: Math.round((isHarborLedger ? (isHovered ? 66 : 60) : isHovered ? 30 : isLandmark ? 26 : 18) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.92, LABEL_OVERLAP_TOLERANCE * overlapScale) : 0.3,
                blockAgents: true,
                degraded: false,
            },
        ];

        const compactFont = isHovered || isLandmark
            ? 'bold 8px "Press Start 2P", monospace'
            : '6px "Press Start 2P", monospace';
        if (compactText && compactText !== baseText) {
            attempts.push({
                text: compactText,
                labelFont: compactFont,
                maxTextWidth: Math.round((isLandmark ? 92 : 76) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 19 : 13) * scale : 0,
                iconGap: building.icon ? 6 * scale : 0,
                padX: isHovered || isLandmark ? 11 : 7,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 26 : isLandmark ? 23 : 15) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.95, LABEL_COMPACT_OVERLAP_TOLERANCE * overlapScale) : 0.38,
                blockAgents: true,
                degraded: false,
            });
        }

        if (tinyText) {
            attempts.push({
                text: tinyText,
                labelFont: '6px "Press Start 2P", monospace',
                maxTextWidth: Math.round((isLandmark ? 64 : 58) * widthScale),
                iconSize: building.icon ? (isHovered || isLandmark ? 17 : 11) * scale : 0,
                iconGap: building.icon ? 5 * scale : 0,
                padX: isHovered || isLandmark ? 9 : 6,
                iconFont: isHovered || isLandmark ? 8 : 7,
                tagH: Math.round((isHovered ? 23 : isLandmark ? 20 : 13) * scale),
                overlapTolerance: isHovered || isLandmark ? Math.min(0.97, 0.78 * overlapScale) : 0.55,
                blockAgents: true,
                degraded: false,
            });
        }

        attempts.push({
            text: tinyText,
            labelFont: '5px "Press Start 2P", monospace',
            maxTextWidth: Math.round(34 * widthScale),
            iconSize: 0,
            iconGap: 0,
            padX: isHovered || isLandmark ? 4 : 3,
            iconFont: isHovered || isLandmark ? 7 : 6,
            tagH: Math.round((isHovered ? 10 : isLandmark ? 9 : 8) * scale),
            overlapTolerance: 1,
            blockAgents: false,
            degraded: true,
        });

        if (zoom <= LABEL_VISIBLE_ZOOM && tinyText) {
            const fallbackText = tinyText;
            attempts.push({
                text: fallbackText,
                labelFont: '5px "Press Start 2P", monospace',
                maxTextWidth: Math.round(38 * widthScale),
                iconSize: 0,
                iconGap: 0,
                padX: isHovered || isLandmark ? 4 : 3,
                iconFont: isHovered || isLandmark ? 7 : 6,
                tagH: Math.round((isHovered ? 12 : isLandmark ? 11 : 10) * scale),
                overlapTolerance: 0.9,
                blockAgents: true,
                degraded: true,
            });
        }

        return attempts;
    }

    _labelTinyTextFor(building, fallbackText) {
        const raw = String(fallbackText || this._resolveBuildingLabelText(building)).trim().toUpperCase();
        if (!raw) return fallbackText;
        const compact = raw.split(/\s+/).filter(Boolean);
        if (compact.length === 1) {
            return compact[0].slice(0, 4);
        }
        const acronym = compact.map((word) => word[0]).join('');
        return acronym.length >= 2 ? acronym : raw.slice(0, 4);
    }

    _resolveLabelLayout({
        candidates,
        occupied,
        occupiedExternal = [],
        centerX,
        centerY,
        tagW,
        tagH,
        maxOverlap = LABEL_OVERLAP_TOLERANCE,
        localLabelDensity = 0,
    }) {
        let best = null;
        let bestOverlap = Number.POSITIVE_INFINITY;
        const boxPad = localLabelDensity >= 2 ? 2 : 4;
        const bottomPad = Math.max(6, Math.round(tagH * 0.55) + (localLabelDensity >= 2 ? 4 : 6));

        for (const { dx, dy } of candidates) {
            const labelX = centerX + dx;
            const labelY = centerY + dy;
            const tagLeft = labelX - tagW / 2;
            const tagTop = labelY - tagH / 2;
            const box = {
                left: tagLeft - boxPad,
                top: tagTop - (boxPad - 1),
                right: tagLeft + tagW + boxPad,
                bottom: tagTop + tagH + bottomPad,
            };
            const blocked = [...occupied, ...occupiedExternal];
            const overlap = this._boxesMaxOverlapRatio(box, blocked);
            if (overlap === 0) {
                return { x: labelX, y: labelY, box };
            }
            if (overlap < bestOverlap) {
                bestOverlap = overlap;
                best = { x: labelX, y: labelY, box, overlap };
            }
        }
        if (bestOverlap > maxOverlap) return null;
        return best;
    }

    _normalizeBoxes(boxes = []) {
        return boxes.map((box) => {
            if (box && 'left' in box && 'right' in box && 'top' in box && 'bottom' in box) return box;
            if (!box || !('w' in box) || !('h' in box)) return null;
            return {
                left: box.x,
                right: box.x + box.w,
                top: box.y,
                bottom: box.y + box.h,
            };
        }).filter(Boolean);
    }

    // Vector chat bubbles preserved (parchment-style overlay).
    // Ported from BuildingRenderer.drawBubbles (legacy file lines 3215-3256),
    // swapping `style.wallHeight` for sprite `dims.h` to anchor above the sprite top.
    drawBubbles(ctx, world) {
        const occupants = this.agentSprites?.length
            ? this.agentSprites.map((sprite) => {
                const agent = sprite.agent;
                const position = this._spriteTilePosition(sprite);
                return { agent, positionedAgent: agent && position ? { ...agent, position } : null };
            })
            : Array.from(world.agents.values()).map((agent) => ({
                agent,
                positionedAgent: agent.position ? { ...agent, position: agent.position } : null,
            }));

        for (const b of this.buildings) {
            const agentsInBuilding = [];
            for (const occupant of occupants) {
                if (!occupant.positionedAgent) continue;
                const isVisiting = typeof b.isAgentVisiting === 'function'
                    ? b.isAgentVisiting(occupant.positionedAgent)
                    : b.containsPoint(occupant.positionedAgent.position.tileX, occupant.positionedAgent.position.tileY);
                if (isVisiting) {
                    agentsInBuilding.push(occupant.agent);
                }
            }
            if (agentsInBuilding.length === 0) continue;
            const center = this._buildingScreenCenter(b);
            const dims = this.assets.getDims(`building.${b.type}`);
            if (!dims) continue;
            const text = `${agentsInBuilding.length} agent${agentsInBuilding.length > 1 ? 's' : ''}`;
            ctx.save();
            ctx.font = '7px sans-serif';
            const tw = ctx.measureText(text).width + 8;
            const bx = center.x;
            const by = center.y - dims.h - 10;     // anchor above sprite top
            ctx.fillStyle = 'rgba(48, 31, 19, 0.94)';
            ctx.strokeStyle = '#d7b979';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bx - tw / 2, by - 7);
            ctx.lineTo(bx + tw / 2, by - 7);
            ctx.lineTo(bx + tw / 2 + 4, by - 3);
            ctx.lineTo(bx + tw / 2 + 4, by + 5);
            ctx.lineTo(bx + 4, by + 5);
            ctx.lineTo(bx, by + 10);
            ctx.lineTo(bx - 4, by + 5);
            ctx.lineTo(bx - tw / 2 - 4, by + 5);
            ctx.lineTo(bx - tw / 2 - 4, by - 3);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#f3e2bd';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx, by);
            ctx.restore();
        }
    }

    _spriteTilePosition(sprite) {
        if (!sprite || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) return null;
        return worldToTile(sprite.x, sprite.y);
    }

    _forgeGlowIntensity() {
        return clamp01(this._forgeGlow);
    }

    // Global beacon intensity (0..1): emitters/window-warmth/light glow all
    // breathe with it as night deepens or a storm rolls in. Slow band, driven by
    // AtmosphereState's time-of-day/weather lighting. Reduced motion holds a
    // static mid value so the village stays lit without per-frame change.
    _beaconIntensity(lightingState = this.lightingState) {
        if (!this.motionScale) return 0.5;
        const value = lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity;
        return Number.isFinite(value) ? clamp01(value) : 0.5;
    }

    // Per-building beacon multiplier (0..1) blending the global intensity with a
    // per-type base so strong emitters react fully and quiet ones hold back.
    _beaconScaleFor(buildingType, lightingState = this.lightingState) {
        if (!buildingType) return 1;
        return this._beaconIntensity(lightingState) * getBuildingBeaconBase(buildingType);
    }

    _watchtowerActiveCount() {
        const wiredCount = this.harborStatus?.activeWorkingCount;
        if (Number.isFinite(wiredCount)) return Math.max(0, wiredCount);
        return this.agentSprites.filter(sprite => sprite?.agent?.status === 'WORKING').length;
    }

    _watchtowerIntensity() {
        const active = this._watchtowerActiveCount();
        const activeBoost = Math.min(1, active / 5);
        return clamp01(activeBoost + (this.harborStatus?.failedPushActive ? 0.36 : 0));
    }

    // Light sources for water/wall additive light passes (Phase 2.5.5).
    // `overlay` is the atmosphere sprite id used for the additive reflection.
    getLightSources(lightingState = this.lightingState) {
        const lightBoost = lightingState?.lightBoost ?? 1;
        const windowWarmth = this.atmosphereState?.reactions?.windowWarmth || 0;
        const staticSources = this._staticLightSources();
        const out = [];
        for (const source of staticSources) {
            const visitors = source.building ? this._visitorCountFor(source.building) : 0;
            let activity = visitors > 0 ? 1.12 : 1;
            let alpha = source.alpha;
            let color = source.color;
            if (source.buildingType === 'forge') {
                activity = 0.58 + this._forgeGlowIntensity() * 0.74;
            } else if (source.buildingType === 'watchtower') {
                const watchIntensity = this._watchtowerIntensity();
                activity = 1 + watchIntensity * 0.48;
                if (alpha != null) alpha *= 1 + watchIntensity * 0.65;
                if (this.harborStatus?.failedPushActive) color = '#ff755d';
            }
            const warmthBoost = source.kind === 'beam' ? 0 : windowWarmth * 0.16;
            // Beacon breathing: every emitter glow brightens/widens in unison as
            // night deepens or a storm dims the world, scaled per building type.
            const beaconScale = source.kind === 'beam' ? 0 : this._beaconScaleFor(source.buildingType, lightingState);
            const beaconBoost = beaconScale * 0.34;
            const presenceRadiusMult = source.buildingType
                ? PRESENCE_TIER_TABLE[this._presenceTierFor(source.buildingType)].radius
                : 1;
            const radius = source.radius * Math.min(1.84, 0.72 + lightBoost * 0.28 + warmthBoost + beaconScale * 0.22 + (activity - 1) * 0.18) * presenceRadiusMult;
            const emissiveGate = !source.buildingType || source.buildingType === 'watchtower'
                ? 1
                : this._emissiveGateFor(source.building);
            const intensity = (activity + warmthBoost + beaconBoost) * emissiveGate;
            if (intensity < 0.02) continue;
            if (alpha != null) alpha *= (1 + beaconBoost) * emissiveGate;
            out.push(normalizeLightSource({
                ...source,
                color,
                intensity,
                radius,
                alpha,
                origin: source.origin || { x: source.x, y: source.y },
            }, {
                buildingType: source.buildingType,
                building: source.building,
            }));
        }
        for (const source of this._ritualLightSources(lightBoost)) out.push(source);
        for (const source of this._forgeSpillLightSources(lightBoost)) out.push(source);
        for (const source of this._archiveSpillLightSources(lightBoost)) out.push(source);
        return out;
    }

    // Ground-spill light from the archive doorway: when reading is busy the warm
    // lamplight bleeds out the door and across the entrance steps via the
    // screen-composite light path (overlay sprite). Brightness tracks the read
    // counter (_archiveReadIntensity); flicker rides the slow building pulse and
    // holds steady under reduced motion (#12).
    _archiveSpillLightSources(lightBoost = 1) {
        const readIntensity = this._archiveReadIntensity || 0;
        if (readIntensity <= 0.4) return [];
        const strength = clamp01((readIntensity - 0.4) / 0.6);
        const flicker = this.motionScale ? 0.9 + Math.sin(this.frame * 0.06) * 0.1 : 0.9;
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'archive') continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            sources.push(normalizeLightSource({
                id: `archive:${building.position?.tileX ?? 0}.${building.position?.tileY ?? 0}:spill`,
                kind: 'spark',
                origin: {
                    x: center.x - baseAnchor[0] + 168,
                    y: center.y - baseAnchor[1] + 142,
                },
                color: '#ffd98a',
                radius: 40 + strength * 16,
                // WorldFrameRenderer's reflection pass scales overlay alpha by
                // `intensity`; drive it from the read counter so the spill
                // brightens with reading. `alpha` is kept for any alpha-aware path.
                intensity: 0.6 + strength * 0.9,
                alpha: (0.18 + strength * 0.30) * flicker * lightBoost,
                overlay: 'atmosphere.light.lantern-glow',
                buildingType: building.type,
                building,
            }, {
                buildingType: building.type,
                building,
            }));
        }
        return sources;
    }

    // Ground-spill light from the forge molten pool: when the smithy is hot and
    // the world is dark, the apron glow bleeds onto adjacent tiles/water via the
    // screen-composite light path. Brightness tracks _forgeGlow (#11).
    _forgeSpillLightSources(lightBoost = 1) {
        const night = clamp01(this.atmosphereState?.reactions?.nightReflection ?? 0);
        const heat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
        const strength = night * heat;
        if (strength <= 0.05) return [];
        const flicker = this.motionScale ? 0.9 + Math.sin(this.frame * 0.07) * 0.1 : 0.9;
        const sources = [];
        for (const building of this.buildings) {
            if (building.type !== 'forge') continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            sources.push(normalizeLightSource({
                id: `forge:${building.position?.tileX ?? 0}.${building.position?.tileY ?? 0}:spill`,
                kind: 'spark',
                origin: {
                    x: center.x - baseAnchor[0] + 77,
                    y: center.y - baseAnchor[1] + 138,
                },
                color: '#ff9a4d',
                radius: 52 + strength * 18,
                alpha: strength * 0.4 * flicker * lightBoost,
                overlay: 'atmosphere.light.fire-glow',
                buildingType: building.type,
                building,
            }, {
                buildingType: building.type,
                building,
            }));
        }
        return sources;
    }

    _staticLightSources() {
        if (this._lightSourcesCache) return this._lightSourcesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            const c = this._buildingScreenCenter(b);
            const seen = new Set();
            const pushSource = (source) => {
                if (!source?.at) return;
                const baseAnchor = this.assets.getAnchor(entry?.id || `building.${b.type}`);
                const [lx, ly] = source.at;
                const key = `${source.kind || 'point'}|${Math.round(lx)},${Math.round(ly)}|${source.overlay || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                const origin = {
                    x: c.x - baseAnchor[0] + lx,
                    y: c.y - baseAnchor[1] + ly,
                };
                out.push(normalizeLightSource({
                    id: source.id || `building.${b.type}.${source.kind || 'point'}.${Math.round(lx)}.${Math.round(ly)}`,
                    origin,
                    color: source.color || entry?.lightColor || '#ffcc66',
                    radius: source.radius || entry?.lightRadius || 64,
                    overlay: source.overlay || entry?.lightOverlay || 'atmosphere.light.lantern-glow',
                    buildingType: b.type,
                    kind: source.kind || 'point',
                    building: b,
                    length: source.length,
                    width: source.width,
                    alpha: source.alpha,
                    ttl: source.ttl,
                    createdAt: source.createdAt,
                    endpoints: source.endpoints,
                    controlPoint: source.controlPoint,
                    parent: source.parent,
                }, {
                    buildingType: b.type,
                    building: b,
                }));
            };

            if (Array.isArray(entry?.lightSources)) {
                for (const source of entry.lightSources) pushSource(source);
            }
            if (entry?.lightSource) {
                pushSource({
                    at: b.type === 'watchtower' ? WATCHTOWER_LANTERN_FIRE.light : entry.lightSource,
                    color: entry.lightColor || 'rgba(255,210,140,0.4)',
                    radius: entry.lightRadius || 64,
                    overlay: entry.lightOverlay || 'atmosphere.light.lantern-glow',
                });
            }
            for (const source of LIGHT_SOURCE_REGISTRY[b.type] || []) {
                pushSource(source);
            }
            if (entry?.emitters) {
                for (const [name, at] of Object.entries(entry.emitters)) {
                    const baseName = name.replace(/\d+$/, '');
                    const light = EMITTER_LIGHTS[baseName] || EMITTER_LIGHTS[name];
                    if (light) pushSource({ ...light, at });
                }
            }
            const fallback = BUILDING_LIGHT_FALLBACKS[b.type];
            if (fallback) {
                pushSource(fallback);
            }
        }
        this._lightSourcesCache = out;
        return out;
    }

    // Per-pixel hit test across all buildings (front halves only).
    hitTest(worldX, worldY) {
        const drawables = this.enumerateDrawables();
        for (let i = drawables.length - 1; i >= 0; i--) {
            const d = drawables[i];
            if (d.kind === 'building-back') continue;
            const id = d.entry.id;
            const [ax, ay] = this.assets.getAnchor(id);
            if (this.sprites.hitTest(id, worldX, worldY, d.wx - ax, d.wy - ay)) {
                return d.building;
            }
        }
        return null;
    }

    // Returns drawable payloads (one per building, or two if splitForOcclusion).
    // Cached until the building list changes; hover and animation state are read
    // live by drawDrawable().
    enumerateDrawables() {
        if (this._drawablesCache) return this._drawablesCache;
        const out = [];
        for (const b of this.buildings) {
            const entry = this.assets.getEntry(`building.${b.type}`);
            if (!entry) continue;
            const center = this._buildingScreenCenter(b);
            const wx = center.x;
            const wy = center.y;
            if (entry.splitForOcclusion) {
                const dims = this.assets.getDims(entry.id);
                // Clamp manifest horizonY to a valid sub-rect inside the sprite so
                // the front half (`drawImage(... , h - horizonY, ...)`) never receives
                // a negative or zero source-rect height when manifest values drift.
                const rawHorizon = entry.horizonY ?? Math.floor(dims.h / 2);
                const horizonY = Math.max(1, Math.min(rawHorizon, dims.h - 1));
                out.push({ kind: 'building-back', building: b, entry, wx, wy, horizonY, sortY: wy - dims.h / 2 });
                out.push({ kind: 'building-front', building: b, entry, wx, wy, horizonY, sortY: this._buildingFrontSortY(b, wy) });
            } else {
                out.push({ kind: 'building', building: b, entry, wx, wy, sortY: this._buildingWholeSortY(b, wy) });
            }
        }
        out.sort(compareBuildingDrawableDepth);
        this._drawablesCache = out;
        return out;
    }

    drawDrawable(ctx, d) {
        const id = d.entry.id;
        if (d.kind === 'building') {
            this.sprites.drawSprite(ctx, id, d.wx, d.wy);
            this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'whole');
        } else {
            const dims = this.assets.getDims(id);
            const [ax, ay] = this.assets.getAnchor(id);
            const dx = Math.round(d.wx - ax);
            const dy = Math.round(d.wy - ay);
            const img = this.assets.get(id);
            if (!img) return;
            if (d.kind === 'building-back') {
                ctx.drawImage(img, 0, 0, dims.w, d.horizonY, dx, dy, dims.w, d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'back', d.horizonY);
            } else {
                ctx.drawImage(img, 0, d.horizonY, dims.w, dims.h - d.horizonY,
                                   dx, dy + d.horizonY, dims.w, dims.h - d.horizonY);
                this._drawAnimatedOverlays(ctx, d.entry, d.wx, d.wy, d.building, 'front', d.horizonY);
            }
        }
        if (this.hovered === d.building) this.sprites.drawOutline(ctx, id, d.wx, d.wy);
    }

    _drawAnimatedOverlays(ctx, entry, wx, wy, building = null, splitPass = 'whole', horizonY = null) {
        if (entry.layers) {
            this._drawManifestLayers(ctx, entry, wx, wy, splitPass, horizonY);
        }
        if (building) {
            this._drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass, horizonY);
            this._drawAtmosphereBuildingReactions(ctx, building, entry, wx, wy, splitPass, horizonY);
            this._drawOccupancyPennant(ctx, building, entry, wx, wy, splitPass, horizonY);
        }
    }

    // #53 — occupancy pennant: hero buildings fly a small roofline standard
    // tinted by the dominant occupant repo (guild-territory read). Idle
    // buildings fly nothing; busy/full stream a second tail; alert tints the
    // cloth to the alert red. AMBIENT under the mark governor (banners are the
    // doc-comment example of that tier). The wave rides the slow band; reduced
    // motion flies a static pennant.
    _drawOccupancyPennant(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const pennant = getBuildingPennantAnchor(building.type);
        if (!pennant) return;
        const [lx, ly] = pennant.at;
        if (
            splitPass !== 'whole'
            && Number.isFinite(horizonY)
            && (splitPass === 'back' ? ly >= horizonY : ly < horizonY)
        ) return;
        const occupancy = this._buildingOccupancyInfo(building);
        const dominant = this._visitorRepoByType.get(building.type);
        // Idle by count AND no semantic occupants routed here: fly nothing.
        if (occupancy.state === 'idle' && !dominant) return;

        const baseAnchor = this.assets.getAnchor(entry.id);
        const px = Math.round(wx - baseAnchor[0] + lx);
        const py = Math.round(wy - baseAnchor[1] + ly);
        const gate = getActiveMarkGovernor()?.admit(MarkTier.AMBIENT, px, py);
        if (gate && !gate.draw) return;
        const gateAlpha = gate?.alpha ?? 1;

        const profile = dominant?.profile || null;
        const alert = occupancy.state === 'alert';
        const accent = alert
            ? '#ff755d'
            : profile?.accent || getBuildingLabelAccent(building.type, '#d6a951');
        const shade = alert
            ? '#a83a2c'
            : profile
                ? `hsl(${Math.round(profile.hue)}, ${Math.round(profile.saturation)}%, ${Math.max(22, Math.round(profile.lightness) - 24)}%)`
                : 'rgba(92, 66, 32, 1)';
        const busy = occupancy.state === 'busy' || occupancy.state === 'full' || alert;
        const seed = hashText(`${building.type}|pennant`);
        const wave = this.motionScale ? Math.sin(this.frame * 0.055 + seed * 0.01) : 0;
        const lift = this.motionScale ? Math.sin(this.frame * 0.083 + seed * 0.017) * 1.6 : 0;

        const top = py - PENNANT_POLE_PX + 2;
        const seg1 = Math.round(PENNANT_FLY_PX * 0.55);
        ctx.save();
        ctx.globalAlpha = 0.92 * gateAlpha;
        // Pole + gold finial.
        ctx.fillStyle = 'rgba(38, 26, 16, 0.9)';
        ctx.fillRect(px - 1, py - PENNANT_POLE_PX, 2, PENNANT_POLE_PX);
        ctx.fillStyle = '#e8c876';
        ctx.fillRect(px - 1, py - PENNANT_POLE_PX - 2, 2, 2);
        // Cloth: hoist segment + fly segment with a notched, shaded tip.
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(px + 1, top);
        ctx.lineTo(px + 1 + seg1, top + 1 + wave * 0.8);
        ctx.lineTo(px + 1 + seg1, top + PENNANT_DROP_PX - 1 + wave * 0.8);
        ctx.lineTo(px + 1, top + PENNANT_DROP_PX);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(px + 1 + seg1, top + 1 + wave * 0.8);
        ctx.lineTo(px + 1 + PENNANT_FLY_PX, top + PENNANT_DROP_PX / 2 + lift);
        ctx.lineTo(px + 1 + seg1, top + PENNANT_DROP_PX - 1 + wave * 0.8);
        ctx.closePath();
        ctx.fill();
        // Busy/full: a second short streamer under the main cloth.
        if (busy) {
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(px + 1, top + PENNANT_DROP_PX + 1);
            ctx.lineTo(px + 1 + seg1 - 2, top + PENNANT_DROP_PX + 2 + wave * 0.6);
            ctx.lineTo(px + 1 + seg1 - 2, top + PENNANT_DROP_PX + 5 + wave * 0.6);
            ctx.lineTo(px + 1, top + PENNANT_DROP_PX + 4);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _drawAtmosphereBuildingReactions(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const reactions = this.atmosphereState?.reactions || {};
        const windowWarmth = reactions.windowWarmth || 0;
        const roofGlint = reactions.roofGlintAlpha || 0;
        const warmGlint = reactions.warmGlint || 0;
        if (windowWarmth <= 0.035 && roofGlint <= 0.025) return;
        const baseAnchor = this.assets.getAnchor(entry.id);
        const dims = this.assets.getDims(entry.id);
        if (!dims) return;
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const shouldDrawLocalY = (localY) => (
            splitPass === 'whole'
            || !Number.isFinite(horizonY)
            || (splitPass === 'back' ? localY < horizonY : localY >= horizonY)
        );
        const seed = hashText(`${building.type}|${building.position?.tileX ?? 0}|${building.position?.tileY ?? 0}`);
        const pulse = this.motionScale ? (Math.sin(this.frame * 0.045 + seed * 0.011) + 1) / 2 : 0.56;

        ctx.save();
        this._clipToSplitPass(ctx, entry, wx, wy, splitPass, horizonY, dims, baseAnchor);
        ctx.globalCompositeOperation = 'screen';
        if (windowWarmth > 0.035) {
            // Dusk crossfades legacy presence warmth into the live night-shift
            // gate; at night only a physically present working agent lights it.
            const occupancy = PRESENCE_TIER_TABLE[this._presenceTierFor(building.type)].occupancy;
            const lit = this._nightShiftLit(building.type);
            const nightGate = this._nightWindowGate();
            const buildingWarmth = windowWarmth * lerp(0.45 + 0.55 * occupancy, lit, nightGate);
            // Window warmth breathes with the building beacon so lit windows
            // brighten together as night deepens (static floor under reduced motion).
            const beaconWarm = 0.82 + this._beaconScaleFor(building.type) * 0.4;
            const warmthAlpha = Math.min(0.3, buildingWarmth * (0.12 + pulse * 0.05) * beaconWarm);
            // 6.2 — buildings with calibrated windowRects get crisp lit windows
            // instead of the generic mid-wall warmth blobs.
            const windowRects = getBuildingWindowRects(building.type);
            if (windowRects) {
                this._drawWarmthWindows(
                    ctx,
                    windowRects,
                    localPoint,
                    shouldDrawLocalY,
                    warmthAlpha,
                    getBuildingWindowColor(building.type),
                );
            } else {
                const lightPoints = this._buildingReactionLightPoints(building, entry, dims);
                for (const point of lightPoints) {
                    if (!shouldDrawLocalY(point.y)) continue;
                    const p = localPoint(point.x, point.y);
                    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, point.r || 18);
                    grad.addColorStop(0, `rgba(255, 206, 116, ${warmthAlpha})`);
                    grad.addColorStop(0.58, `rgba(255, 162, 78, ${warmthAlpha * 0.34})`);
                    grad.addColorStop(1, 'rgba(255, 162, 78, 0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.ellipse(p.x, p.y, point.r || 18, (point.r || 18) * 0.48, 0, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            const doorSpill = getBuildingDoorSpillDescriptor(building.type, {
                occupancy: lerp(occupancy, lit, nightGate),
                beaconIntensity: this._beaconScaleFor(building.type),
                weatherWetness: this.atmosphereState?.weather?.precipitation || 0,
                atmosphereWarmth: windowWarmth,
            });
            if (doorSpill?.alpha > 0) {
                this._drawDoorSpill(ctx, doorSpill, localPoint, shouldDrawLocalY);
            }
        }

        if (roofGlint > 0.025) {
            // Golden hour lays a warm rim-light along the ridgeline; a wet roof
            // adds a brighter rain sheen. `warmGlint` (dawn/dusk) tilts the hue
            // from cool wet silver toward gold and lengthens the highlight.
            // Its orientation mirrors the canonical solar vector, matching
            // the opposite cast-shadow direction without another light model.
            const goldTilt = Math.min(1, warmGlint * 1.4);
            const rimColor = goldTilt > 0.2
                ? `rgba(255, 214, 138, ${Math.min(0.30, roofGlint * (0.5 + goldTilt * 0.4 + pulse * 0.24))})`
                : `rgba(255, 231, 166, ${Math.min(0.22, roofGlint * (0.48 + pulse * 0.34))})`;
            const count = roofGlint > 0.16 || goldTilt > 0.4 ? 2 : 1;
            const span = 7 + goldTilt * 6;
            const sunDir = this.lightingState?.sunDirIso;
            const hasSunDir = Number.isFinite(sunDir?.x) && Number.isFinite(sunDir?.y);
            const shadowAngle = shadowAngleForLighting(this.lightingState);
            const glintDx = hasSunDir ? -sunDir.x * span : Math.cos(shadowAngle) * span;
            const glintDy = hasSunDir ? sunDir.y * span : -Math.sin(shadowAngle) * span;
            ctx.strokeStyle = rimColor;
            ctx.lineWidth = 1 + (goldTilt > 0.4 ? 0.6 : 0);
            ctx.lineCap = 'round';
            for (let i = 0; i < count; i++) {
                const lx = dims.w * (0.28 + ((seed >> (i * 5)) % 42) / 100);
                const ly = dims.h * (0.22 + ((seed >> (i * 7 + 3)) % 18) / 100);
                if (!shouldDrawLocalY(ly)) continue;
                const p = localPoint(lx, ly);
                ctx.beginPath();
                ctx.moveTo(p.x - glintDx, p.y - glintDy);
                ctx.lineTo(p.x + glintDx, p.y + glintDy);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _buildingReactionLightPoints(building, entry, dims) {
        const points = [];
        const push = (at, radius = 18) => {
            if (!Array.isArray(at) || !Number.isFinite(Number(at[0])) || !Number.isFinite(Number(at[1]))) return;
            points.push({ x: Number(at[0]), y: Number(at[1]), r: radius });
        };
        if (building.type === 'watchtower') {
            push(WATCHTOWER_LANTERN_FIRE.light, 20);
            return points;
        }
        if (Array.isArray(entry?.lightSources)) {
            for (const source of entry.lightSources.slice(0, 3)) push(source.at, Math.min(28, Math.max(14, (source.radius || 42) * 0.28)));
        }
        if (entry?.lightSource) push(entry.lightSource, 20);
        if (entry?.emitters) {
            for (const at of Object.values(entry.emitters).slice(0, 3)) push(at, 16);
        }
        const fallback = BUILDING_LIGHT_FALLBACKS[building.type];
        if (fallback) push(fallback.at, 20);
        if (!points.length) {
            points.push({ x: dims.w * 0.48, y: dims.h * 0.58, r: 18 });
        }
        return points.slice(0, 4);
    }

    // 6.2 — crisp lit-window stamps for buildings with calibrated windowRects.
    // Each window is a tight soft glow + a pixel-snapped warm core (rect or
    // small ellipse) + a hot center line, so the sprite reads as *lit windows*
    // at zoom 2/3 rather than a mid-wall blob. Caller already set the 'screen'
    // composite; alpha derives from the shared warmthAlpha math.
    _drawWarmthWindows(ctx, rects, localPoint, shouldDrawLocalY, warmthAlpha, color = null) {
        // Crisp cores punch much harder than the legacy blobs: the point is
        // windows that stay visibly lit through the night atmosphere multiply
        // (~50% at deep night), so the core carries an explicit night
        // compensation (the same beacon night factor the PRIMARY re-stamps
        // scale by). Only fires when windowWarmth is active (dusk/night), so
        // the strong core never shows in daylight; the occupancy factor in
        // warmthAlpha still keeps empty buildings dim.
        const night = clamp01(this.lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity ?? 0);
        const coreAlpha = Math.min(0.85, warmthAlpha * 7 * (1 + night * 1.5));
        const glowAlpha = warmthAlpha * 1.6 * (1 + night);
        const coreRgb = color ? hexToRgb(color) : { r: 255, g: 205, b: 112 };
        const glowRgb = color ? coreRgb : { r: 255, g: 190, b: 96 };
        const fadeRgb = color ? coreRgb : { r: 255, g: 162, b: 78 };
        const hotRgb = color ? {
            r: Math.round(lerp(coreRgb.r, 255, 0.58)),
            g: Math.round(lerp(coreRgb.g, 244, 0.58)),
            b: Math.round(lerp(coreRgb.b, 208, 0.58)),
        } : {
            r: 255,
            g: 236,
            b: 176,
        };
        for (const rect of rects) {
            const [lx, ly] = rect.at || [];
            if (!Number.isFinite(lx) || !Number.isFinite(ly) || !shouldDrawLocalY(ly)) continue;
            const w = Math.max(3, Math.round(rect.w || 6));
            const h = Math.max(3, Math.round(rect.h || 8));
            const p = localPoint(lx, ly);
            const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(w, h) * 1.7);
            grad.addColorStop(0, `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, ${glowAlpha})`);
            grad.addColorStop(1, `rgba(${fadeRgb.r}, ${fadeRgb.g}, ${fadeRgb.b}, 0)`);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, w * 1.7, h * 1.5, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, ${coreAlpha})`;
            const left = Math.round(p.x - w / 2);
            const top = Math.round(p.y - h / 2);
            if (rect.shape === 'ellipse') {
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, w / 2, h / 2, 0, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillRect(left, top, w, h);
            }
            ctx.fillStyle = `rgba(${hotRgb.r}, ${hotRgb.g}, ${hotRgb.b}, ${Math.min(0.8, coreAlpha * 1.35)})`;
            ctx.fillRect(Math.round(p.x - 1), Math.round(p.y - h / 2 + 1), 2, Math.max(2, Math.round(h * 0.45)));
        }
    }

    _drawDoorSpill(ctx, descriptor, localPoint, shouldDrawLocalY) {
        const [lx, ly] = descriptor.at;
        const { r, g, b } = hexToRgb(descriptor.color);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${descriptor.alpha})`;
        for (const step of descriptor.steps) {
            const offsetX = Number(step.offset?.[0]) || 0;
            const offsetY = Number(step.offset?.[1]) || 0;
            const localY = ly + offsetY;
            if (!shouldDrawLocalY(localY)) continue;
            const p = localPoint(lx + offsetX, localY);
            ctx.fillRect(p.x, p.y, Math.max(1, step.w || 1), Math.max(1, step.h || 1));
        }
    }

    _clipToSplitPass(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null, dims = null, baseAnchor = null) {
        if (splitPass === 'whole' || !Number.isFinite(horizonY)) return;
        const resolvedDims = dims || this.assets.getDims(entry.id);
        if (!resolvedDims) return;
        const anchor = baseAnchor || this.assets.getAnchor(entry.id);
        const dx = Math.round(wx - anchor[0]);
        const dy = Math.round(wy - anchor[1]);
        ctx.beginPath();
        if (splitPass === 'back') {
            ctx.rect(dx - 2, dy - 2, resolvedDims.w + 4, horizonY + 4);
        } else {
            ctx.rect(dx - 2, dy + horizonY - 2, resolvedDims.w + 4, resolvedDims.h - horizonY + 4);
        }
        ctx.clip();
    }

    _drawManifestLayers(ctx, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        for (const [name, layer] of Object.entries(entry.layers)) {
            if (name === 'base') continue;
            const localY = Array.isArray(layer.anchor) ? layer.anchor[1] : 0;
            if (
                splitPass !== 'whole' &&
                Number.isFinite(horizonY) &&
                (splitPass === 'back' ? localY >= horizonY : localY < horizonY)
            ) {
                continue;
            }
            const layerId = `${entry.id}.${name}`;
            const layerDims = this.assets.getDims(layerId);
            if (!layerDims) continue;
            // 0.1 — the manifest layer anchor is the base-sprite-local point the
            // layer's bottom-center lands on (the engine-wide anchor convention;
            // the manifest comments document beacon/watchfire/portalGlow anchors
            // this way). Draw with an explicit bottom-center anchor: the layer's
            // registered anchor mirrors the manifest value, and letting
            // drawSprite subtract it would cancel the placement entirely (the
            // pre-0.1 bug — every layer rendered at a dims-derived corner).
            const [ax, ay] = layer.anchor || [0, 0];
            const overlayWx = wx - baseAnchor[0] + ax;
            const overlayWy = wy - baseAnchor[1] + ay;
            // Animated pulse: fade alpha by sine of frame.
            // 0.08 rad/frame ≈ 1.27 Hz at 60fps (slow heartbeat).
            let alpha = 1;
            if (layer.animation === 'pulse') {
                alpha = 0.6 + 0.4 * Math.sin(this.frame * 0.08);
            }
            this.sprites.drawSprite(ctx, layerId, overlayWx, overlayWy, {
                alpha,
                anchor: [layerDims.w / 2, layerDims.h],
            });
        }
    }

    _drawFunctionalOverlay(ctx, building, entry, wx, wy, splitPass = 'whole', horizonY = null) {
        const baseAnchor = this.assets.getAnchor(entry.id);
        const localPoint = (lx, ly) => ({ x: Math.round(wx - baseAnchor[0] + lx), y: Math.round(wy - baseAnchor[1] + ly) });
        const pulse = this.motionScale ? (Math.sin(this.frame * 0.1) + 1) / 2 : 0.55;
        const shouldDrawLocalY = (localY) => (
            splitPass === 'whole'
            || !Number.isFinite(horizonY)
            || (splitPass === 'back' ? localY < horizonY : localY >= horizonY)
        );

        ctx.save();
        this._clipToSplitPass(ctx, entry, wx, wy, splitPass, horizonY, null, baseAnchor);
        if (building.type === 'observatory') {
            this._assertObservatoryClockDims(entry);
            // #52 — the dome dormer aperture sits above the clock on the roof;
            // drawn whenever its slice of the sprite is in this pass.
            if (shouldDrawLocalY(OBSERVATORY_APERTURE.slit[1])) {
                this._drawObservatoryAperture(ctx, localPoint);
            }
            if (shouldDrawLocalY(OBSERVATORY_CLOCK_FACE.center[1])) {
                this._drawObservatoryClock(ctx, localPoint);
                this._drawObservatoryRitual(ctx, localPoint, building);
            }
            ctx.restore();
            return;
        }
        if (building.type === 'forge') {
            if (shouldDrawLocalY(118)) this._drawForgeEnhancement(ctx, localPoint, pulse, building);
            // #33 — reduced-motion fallback: a single static smoke wisp above the
            // chimney, warmed by forge heat, standing in for the live column.
            if (!this.motionScale && shouldDrawLocalY(28)) {
                this._drawStaticSmokeWisp(ctx, localPoint(175, 28), { heat: this._forgeGlowIntensity() });
            }
        } else if (building.type === 'mine') {
            if (!shouldDrawLocalY(158)) {
                ctx.restore();
                return;
            }
            const mouth = localPoint(128, 158);
            const seamColor = this._mineSeamColor();
            const mineRitual = this._latestRitual('mine');
            // Cave-mouth ore glow brightens with remaining reserves: a full mine
            // catches the lantern light, a depleted one barely smoulders.
            const reserve = this._mineReserveRatio();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.14 + pulse * 0.1 + reserve * 0.16 + (mineRitual ? 0.1 : 0);
            ctx.fillStyle = seamColor;
            ctx.beginPath();
            ctx.ellipse(mouth.x, mouth.y - 1, 28, 13, -0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            // 6.5 — cart rails redrawn sprite-quality: wooden sleepers under
            // two steel rails with a pale top edge, following the yard path
            // away from the cave mouth. Static decoration (no motion claim).
            ctx.globalAlpha = 0.85;
            {
                const { railA, railB, railLen, ux, uy, nx, ny } = this._mineRailSpan(mouth);
                ctx.strokeStyle = '#4a3524';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (let d = 2; d < railLen - 2; d += 7) {
                    const sx = railA.x + ux * d;
                    const sy = railA.y + uy * d;
                    ctx.moveTo(sx - nx * 5, sy - ny * 5);
                    ctx.lineTo(sx + nx * 5, sy + ny * 5);
                }
                ctx.stroke();
                for (const offset of [-2.6, 2.6]) {
                    ctx.strokeStyle = '#3a3230';
                    ctx.lineWidth = 1.4;
                    ctx.beginPath();
                    ctx.moveTo(railA.x + nx * offset, railA.y + ny * offset);
                    ctx.lineTo(railB.x + nx * offset, railB.y + ny * offset);
                    ctx.stroke();
                    ctx.strokeStyle = '#7a6a55';
                    ctx.lineWidth = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(railA.x + nx * offset, railA.y + ny * offset - 0.7);
                    ctx.lineTo(railB.x + nx * offset, railB.y + ny * offset - 0.7);
                    ctx.stroke();
                }
            }
            this._drawMineRitual(ctx, mouth, mineRitual);
            this._drawMineReserve(ctx, mouth, building);
            // #33 — reduced-motion fallback: a single static dust wisp at the
            // cave mouth, standing in for the live dust plume.
            if (!this.motionScale) {
                this._drawStaticSmokeWisp(ctx, localPoint(128, 158), { dust: true });
            }
        } else if (building.type === 'portal') {
            if (!shouldDrawLocalY(60)) {
                ctx.restore();
                return;
            }
            const gate = localPoint(144, 60);
            const visitors = this._visitorCountFor(building);
            const portalRitual = this._latestRitual('portal');
            const activeBoost = visitors > 0 ? 0.28 : 0;
            const ritualBoost = portalRitual ? 0.24 : 0;
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.28 + pulse * 0.22 + activeBoost + ritualBoost;
            ctx.strokeStyle = '#8feaff';
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const motion = this.motionScale ? Math.sin(this.frame * 0.06 + i) * 2 : 0;
                const r = 19 + i * 8 + motion + ritualBoost * 10;
                ctx.beginPath();
                ctx.ellipse(gate.x, gate.y, r, r * 0.58, this.frame * 0.012 + i * 0.8, 0, Math.PI * 2);
                ctx.stroke();
            }
            if (visitors > 0) {
                ctx.fillStyle = '#bda7ff';
                ctx.beginPath();
                ctx.ellipse(gate.x, gate.y + 4, 34, 17, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            this._drawPortalRitual(ctx, gate, portalRitual);
        } else if (building.type === 'watchtower') {
            if (shouldDrawLocalY(WATCHTOWER_LANTERN_FIRE.flame[1])) {
                const beacon = localPoint(...WATCHTOWER_LANTERN_FIRE.flame);
                const pivot = localPoint(...WATCHTOWER_SEARCHLIGHT.pivot);
                this._drawWatchtowerSearchlight(ctx, pivot, pulse, this._fleetDistressRatio());
                this._drawWatchtowerFire(ctx, beacon, pulse);
                this._drawWatchtowerRitual(ctx, beacon);
            }
        } else if (building.type === 'harbor') {
            // Harbor effects span the roofline and foreground quay. Draw in both
            // split passes and let the active occlusion clip partition them.
            this._drawHarborMasterOffice(ctx, localPoint, pulse, building);
            // #33 — reduced-motion fallback: a single static chimney wisp in
            // place of the live steam/smoke column.
            if (!this.motionScale) {
                this._drawStaticSmokeWisp(ctx, localPoint(127, 29), { heat: 0.2 });
            }
        } else if (building.type === 'archive') {
            if (splitPass !== 'back') this._drawArchiveEnhancement(ctx, localPoint, pulse);
        } else if (building.type === 'taskboard') {
            if (splitPass !== 'front' && !this._drawTaskboardBoard(ctx, localPoint)) {
                this._drawTaskboardRitual(ctx, localPoint, building);
            }
        } else if (building.type === 'command') {
            if (splitPass !== 'back') {
                this._drawCommandActivityDetails(ctx, localPoint, building, pulse);
                this._drawCommandRitual(ctx, localPoint, building);
            }
        }
        ctx.restore();
    }

    _ritualsFor(type) {
        return this.ritualConductor?.getActiveRitualsForBuilding?.(type) || [];
    }

    _latestRitual(type, predicate = null) {
        const rituals = this._ritualsFor(type)
            .filter((ritual) => !predicate || predicate(ritual))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return rituals[0] || null;
    }

    _ritualProgress(ritual) {
        if (!ritual) return 0;
        return clamp01((ritual.elapsedMs || 0) / Math.max(1, ritual.durationMs || 1));
    }

    _ritualFade(ritual) {
        if (!ritual) return 0;
        const duration = Math.max(1, ritual.durationMs || 1);
        const age = Math.max(0, ritual.elapsedMs || 0);
        const inAlpha = ritual.motionEnabled === false ? 1 : Math.min(1, age / 180);
        const outAlpha = Math.min(1, Math.max(0, (duration - age) / 420));
        return clamp01(inAlpha * outAlpha);
    }

    _updateForgeGlow(dt = 16) {
        const rituals = this._ritualsFor('forge');
        let target = FORGE_GLOW_BASELINE;
        for (const ritual of rituals) {
            const fade = this._ritualFade(ritual);
            if (fade <= 0.03) continue;
            target = Math.max(target, 0.62 + fade * 0.34);
        }

        if (target > this._forgeGlow) {
            this._forgeGlow = target;
            return;
        }

        const decay = (Math.max(0, Number(dt) || 0) / 1000) * FORGE_GLOW_DECAY_PER_SECOND;
        this._forgeGlow = Math.max(FORGE_GLOW_BASELINE, this._forgeGlow - decay);
    }

    _syncTaskboardPapers(now) {
        const rituals = this._ritualsFor('taskboard')
            .slice()
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        for (const ritual of rituals) {
            if (!ritual?.id || this._seenTaskboardRituals.has(ritual.id)) continue;
            this._seenTaskboardRituals.add(ritual.id);
            if (ritual.action === 'complete') {
                this._completeTaskboardPaper(ritual, now);
            } else {
                this._pinTaskboardPaper(ritual, now);
            }
        }
        if (this._seenTaskboardRituals.size > 240) {
            this._seenTaskboardRituals = new Set([...this._seenTaskboardRituals].slice(-160));
        }
        this._capTaskboardPapers();
    }

    _taskboardPaperKey(ritual) {
        if (ritual.taskKey) return `${ritual.agentId || 'unknown'}|task:${ritual.taskKey}`;
        let input = '';
        if (typeof ritual.input === 'string') {
            input = ritual.input;
        } else {
            try {
                input = JSON.stringify(ritual.input || '');
            } catch {
                input = String(ritual.input || '');
            }
        }
        const label = compactRitualLabel(ritual.label, ritual.tool || 'TASK').toUpperCase();
        const source = input || ritual.tool || label;
        return `${ritual.agentId || 'unknown'}|${label}|${hashText(source)}`;
    }

    _pinTaskboardPaper(ritual, now) {
        const matchKey = this._taskboardPaperKey(ritual);
        const existing = this._taskboardPapers.find(paper => paper.matchKey === matchKey);
        if (existing) {
            existing.status = 'pinned';
            existing.label = compactRitualLabel(ritual.label, 'TASK').toUpperCase();
            existing.taskKey = ritual.taskKey || existing.taskKey || null;
            existing.updatedAt = now;
            existing.completedAt = 0;
            return;
        }

        this._taskboardPapers.push({
            id: `paper:${matchKey}:${ritual.createdAt || now}`,
            matchKey,
            taskKey: ritual.taskKey || null,
            agentId: ritual.agentId || '',
            label: compactRitualLabel(ritual.label, 'TASK').toUpperCase(),
            status: 'pinned',
            createdAt: now,
            updatedAt: now,
            completedAt: 0,
            slotSeed: hashText(`${matchKey}:${this._taskboardPapers.length}`),
        });
    }

    _completeTaskboardPaper(ritual, now) {
        const matchKey = this._taskboardPaperKey(ritual);
        const exact = this._taskboardPapers.find(paper => paper.matchKey === matchKey && paper.status !== 'completed');
        const sameAgent = this._taskboardPapers
            .filter(paper => paper.agentId === ritual.agentId && paper.status !== 'completed')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        const oldestOpen = this._taskboardPapers
            .filter(paper => paper.status !== 'completed')
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        const paper = exact || sameAgent || oldestOpen;

        if (paper) {
            paper.status = 'completed';
            paper.completedAt = now;
            paper.updatedAt = now;
            paper.label = compactRitualLabel(ritual.label || paper.label, paper.label).toUpperCase();
            return;
        }

        this._taskboardPapers.push({
            id: `paper:${matchKey}:${ritual.createdAt || now}`,
            matchKey,
            taskKey: ritual.taskKey || null,
            agentId: ritual.agentId || '',
            label: compactRitualLabel(ritual.label, 'DONE').toUpperCase(),
            status: 'completed',
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            slotSeed: hashText(`${matchKey}:complete`),
        });
    }

    _capTaskboardPapers() {
        while (this._taskboardPapers.length > MAX_TASKBOARD_PAPERS) {
            const completed = this._taskboardPapers
                .filter(paper => paper.status === 'completed')
                .sort((a, b) => a.completedAt - b.completedAt)[0];
            const oldest = completed || this._taskboardPapers
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt)[0];
            this._taskboardPapers = this._taskboardPapers.filter(paper => paper !== oldest);
        }
    }

    _ritualLightSources(lightBoost = 1) {
        const sources = [];
        for (const building of this.buildings) {
            const rituals = this._ritualsFor(building.type);
            if (!rituals.length) continue;
            const entry = this.assets.getEntry(`building.${building.type}`);
            const center = this._buildingScreenCenter(building);
            const baseAnchor = this.assets.getAnchor(entry?.id || `building.${building.type}`);
            const toOrigin = ([lx, ly]) => ({
                x: center.x - baseAnchor[0] + lx,
                y: center.y - baseAnchor[1] + ly,
            });
            for (const ritual of rituals) {
                const fade = this._ritualFade(ritual);
                if (fade <= 0.03) continue;
                if (building.type === 'forge') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:spark`,
                        kind: 'spark',
                        origin: toOrigin([195, 150]),
                        color: '#ffcf6a',
                        radius: 24 + this._ritualProgress(ritual) * 34,
                        alpha: fade * 0.5 * lightBoost,
                        overlay: 'atmosphere.light.fire-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'mine') {
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:ore`,
                        kind: 'spark',
                        origin: toOrigin([128, 158]),
                        color: ritual.cargo
                            ? mixHex(this._mineSeamColor(), '#9fd8f0', this._mineCargoMix(ritual.cargo).bucket)
                            : this._mineSeamColor(),
                        radius: 44 + fade * 24,
                        alpha: fade * 0.3 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                } else if (building.type === 'portal') {
                    const color = ritual.action === 'dismiss'
                        ? '#f08a8a'
                        : ritual.action === 'familiar-wait'
                            ? '#f2d36b'
                            : ritual.action === 'familiar-return'
                                ? '#bda7ff'
                                : '#8feaff';
                    sources.push(normalizeLightSource({
                        id: `ritual:${ritual.id}:portal`,
                        kind: 'orbit',
                        origin: toOrigin([144, 60]),
                        color,
                        radius: 58,
                        alpha: fade * 0.26 * lightBoost,
                        overlay: 'atmosphere.light.lantern-glow',
                        buildingType: building.type,
                        building,
                    }));
                }
            }
        }
        return sources;
    }

    _assertObservatoryClockDims(entry) {
        // Warn once per session if the observatory sprite drifts away from the
        // composite size that OBSERVATORY_CLOCK_FACE.center / .radius were
        // calibrated against. Silent drift would misplace the clock hands.
        if (this._observatoryDimsChecked) return;
        this._observatoryDimsChecked = true;
        const dims = entry?.id ? this.assets?.getDims?.(entry.id) : null;
        if (!dims) return;
        const ref = OBSERVATORY_CLOCK_FACE.compositeRef;
        if (dims.w !== ref.w || dims.h !== ref.h) {
            console.warn(
                `[BuildingSprite] observatory sprite is ${dims.w}x${dims.h}; clock-face calibration assumes ${ref.w}x${ref.h}. Hand placement may be off — recalibrate OBSERVATORY_CLOCK_FACE.center / .radius.`
            );
        }
    }

    _drawObservatoryClock(ctx, localPoint) {
        const config = OBSERVATORY_CLOCK_FACE;
        const [cx, cy] = config.center;
        const face = localPoint(cx, cy);
        const time = this._clockTime();
        const hourAngle = (((time.hour % 12) + time.minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
        const minuteAngle = (time.minute / 60) * Math.PI * 2 - Math.PI / 2;
        const source = this._clockSourceCanvas(config, hourAngle, minuteAngle, `${time.hour}:${time.minute}`);
        const size = config.radius * 2;
        const left = Math.round(face.x - size / 2);
        const top = Math.round(face.y - size / 2);
        const previousSmoothing = ctx.imageSmoothingEnabled;
        // Independent web-ritual spin layered on top of the time-of-day hands
        // cached inside `source`. Rotate around the face center so the disc
        // orbits in place. Reduced motion holds at 0.
        const spin = this.motionScale ? (this._observatoryClockSpin || 0) : 0;

        ctx.imageSmoothingEnabled = false;
        if (spin) {
            ctx.save();
            ctx.translate(face.x, face.y);
            ctx.rotate(spin);
            ctx.drawImage(source, -size / 2, -size / 2, size, size);
            ctx.restore();
        } else {
            ctx.drawImage(source, left, top, size, size);
        }
        ctx.imageSmoothingEnabled = previousSmoothing;
    }

    _clockSourceCanvas(config, hourAngle, minuteAngle, cacheKey) {
        if (!this._clockCanvas) {
            this._clockCanvas = document.createElement('canvas');
        }
        const canvas = this._clockCanvas;
        if (canvas.width !== config.sourceSize || canvas.height !== config.sourceSize) {
            canvas.width = config.sourceSize;
            canvas.height = config.sourceSize;
            this._clockCanvasKey = '';
        }
        if (this._clockCanvasKey === cacheKey) return canvas;

        const ctx = canvas.getContext('2d');
        const c = config.sourceCenter;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;

        ctx.fillStyle = 'rgba(19, 21, 30, 0.56)';
        this._fillPixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(229, 218, 170, 0.72)';
        this._strokePixelCircle(ctx, c, c, config.sourceRadius);
        ctx.fillStyle = 'rgba(255, 241, 190, 0.88)';
        const tickMin = c - config.sourceRadius + 1;
        const tickMax = c + config.sourceRadius - 1;
        for (const [tx, ty] of [[c, tickMin], [c, tickMax], [tickMin, c], [tickMax, c]]) {
            ctx.fillRect(tx - 1, ty - 1, 2, 2);
        }

        this._drawClockHand(ctx, c, c, hourAngle, config.hourHandLength, 3, '#1a1712');
        this._drawClockHand(ctx, c, c, minuteAngle, config.minuteHandLength, 2, '#f7de91');
        ctx.fillStyle = '#21170f';
        ctx.fillRect(c - 1, c - 1, 3, 3);
        ctx.fillStyle = '#ffe6a0';
        ctx.fillRect(c, c, 1, 1);

        this._clockCanvasKey = cacheKey;
        return canvas;
    }

    _clockTime() {
        const hour = Number(this.clockState?.hours);
        const minute = Number(this.clockState?.minutes);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
            return { hour, minute };
        }
        const now = new Date();
        return { hour: now.getHours(), minute: now.getMinutes() };
    }

    _drawClockHand(ctx, cx, cy, angle, length, width, color) {
        const x1 = Math.round(cx + Math.cos(angle) * length);
        const y1 = Math.round(cy + Math.sin(angle) * length);
        this._drawBlockLine(ctx, cx, cy, x1, y1, width, color);
    }

    _drawBlockLine(ctx, x0, y0, x1, y1, width, color) {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        const half = Math.floor(width / 2);

        ctx.fillStyle = color;
        while (true) {
            ctx.fillRect(x0 - half, y0 - half, width, width);
            if (x0 === x1 && y0 === y1) break;
            const e2 = err * 2;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    _fillPixelCircle(ctx, cx, cy, radius) {
        for (let y = -radius; y <= radius; y++) {
            const halfWidth = Math.floor(Math.sqrt(radius * radius - y * y));
            ctx.fillRect(cx - halfWidth, cy + y, halfWidth * 2 + 1, 1);
        }
    }

    _strokePixelCircle(ctx, cx, cy, radius) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
            const x = Math.round(cx + Math.cos(angle) * radius);
            const y = Math.round(cy + Math.sin(angle) * radius);
            ctx.fillRect(x, y, 1, 1);
        }
    }

    _drawHarborMasterOffice(ctx, localPoint, pulse, building = null) {
        const signal = localPoint(208, 38);
        const lantern = localPoint(181, 156);
        const quayLight = localPoint(79, 184);
        const pier = localPoint(112, 187);
        const flagLift = this.motionScale ? Math.sin(this.frame * 0.08) * 1.8 : 0;

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.14 + pulse * 0.14;
        ctx.fillStyle = '#ffd37a';
        for (const point of [signal, lantern, quayLight]) {
            ctx.beginPath();
            ctx.ellipse(point.x, point.y, 24, 13, -0.12, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.46;
        ctx.strokeStyle = 'rgba(229, 235, 203, 0.72)';
        ctx.lineWidth = 1.1;
        for (const [dx, dy, rx] of [[-27, 2, 21], [8, 7, 27], [34, -3, 18]]) {
            ctx.beginPath();
            ctx.ellipse(pier.x + dx, pier.y + dy, rx, 3.5, -0.18, 0, Math.PI);
            ctx.stroke();
        }

        // 6.5 — signal flags redrawn sprite-quality: dark hoist edge, two-tone
        // cloth with a shaded fly tip, gentle two-segment lift (the old flat
        // triangles read as paper cutouts over the painterly mast). Wave keeps
        // the existing slow-band flagLift; reduced motion holds the mid pose.
        ctx.globalAlpha = 0.86;
        for (const [dy, color] of [[-18, '#f2d36b'], [-8, '#5bc0c9'], [2, '#c23f36']]) {
            const fy = signal.y + dy + flagLift * 0.35;
            const seg = 11;
            const tipLift = flagLift * 0.5;
            // Gold hoist ring where the flag meets the mast line.
            ctx.fillStyle = '#e8c876';
            ctx.fillRect(Math.round(signal.x + 3), Math.round(fy + 1), 2, 8);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(signal.x + 5, fy);
            ctx.lineTo(signal.x + 5 + seg, fy + 2 + tipLift * 0.4);
            ctx.lineTo(signal.x + 5 + seg, fy + 8 + tipLift * 0.4);
            ctx.lineTo(signal.x + 5, fy + 10);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = mixHex(color, '#1f120c', 0.42);
            ctx.beginPath();
            ctx.moveTo(signal.x + 5 + seg, fy + 2 + tipLift * 0.4);
            ctx.lineTo(signal.x + 5 + seg + 9, fy + 5 + tipLift);
            ctx.lineTo(signal.x + 5 + seg, fy + 8 + tipLift * 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = 'rgba(31, 18, 12, 0.6)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(signal.x + 5, fy);
            ctx.lineTo(signal.x + 5 + seg, fy + 2 + tipLift * 0.4);
            ctx.lineTo(signal.x + 5 + seg + 9, fy + 5 + tipLift);
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.10 + pulse * 0.12;
        ctx.fillStyle = '#f5c964';
        ctx.beginPath();
        ctx.ellipse(pier.x, pier.y, 32, 10, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        this._drawHarborActivityMarkers(ctx, { signal, lantern, quayLight, pier }, building, pulse);
    }

    _drawHarborActivityMarkers(ctx, points, building, pulse) {
        const activity = building ? this._buildingActivityInfo(building) : { intensity: 0, occupancy: { ratio: 0 }, alert: false };
        const activeWorking = this._watchtowerActiveCount();
        const failed = this.harborStatus?.failedPushActive;
        const signal = Math.max(activity.intensity, activity.occupancy.ratio, Math.min(1, activeWorking / 6));
        if (signal <= 0.16 && !failed) return;

        const cargoCount = Math.max(1, Math.min(4, Math.ceil(signal * 4)));
        const cargoColor = failed ? '#ff755d' : '#ffd37a';
        const bob = this.motionScale ? Math.sin(this.frame * 0.11) * 1.2 : 0.5;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < cargoCount; i++) {
            const x = Math.round(points.pier.x - 28 + i * 16);
            const y = Math.round(points.pier.y - 15 + (i % 2) * 5 + bob * 0.35);
            ctx.globalAlpha = 0.78;
            ctx.fillStyle = i < activeWorking ? '#8a5a32' : '#5e4228';
            ctx.strokeStyle = 'rgba(31, 20, 12, 0.86)';
            ctx.lineWidth = 1;
            ctx.fillRect(x - 5, y - 5, 10, 8);
            ctx.strokeRect(x - 4.5, y - 4.5, 9, 7);
            ctx.globalAlpha = 0.38 + signal * 0.28;
            ctx.fillStyle = cargoColor;
            ctx.fillRect(x - 3, y - 7, 6, 2);
        }

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.12 + signal * 0.22 + pulse * 0.08;
        ctx.fillStyle = cargoColor;
        ctx.beginPath();
        ctx.ellipse(points.lantern.x, points.lantern.y, 30 + signal * 12, 14 + signal * 4, -0.2, 0, Math.PI * 2);
        ctx.fill();

        if (failed) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.92;
            ctx.strokeStyle = '#ff755d';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(points.signal.x + 29, points.signal.y - 24);
            ctx.lineTo(points.signal.x + 43, points.signal.y - 10);
            ctx.moveTo(points.signal.x + 43, points.signal.y - 24);
            ctx.lineTo(points.signal.x + 29, points.signal.y - 10);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawArchiveEnhancement(ctx, localPoint, pulse) {
        const crest = localPoint(168, 82);
        const window = localPoint(168, 88);
        const doorway = localPoint(168, 130);
        const leftLamp = localPoint(142, 128);
        const rightLamp = localPoint(194, 128);
        const ritual = this._latestRitual('archive');
        // Read-counter intensity drives the front-window overlay.
        // <0.2 keeps the existing faint baseline; 0.2-0.6 brightens the window;
        // 0.6-1.0 lights up the doorway and is reinforced by door particle bursts
        // in `_spawnEmittersFor`.
        const readIntensity = this._archiveReadIntensity || 0;

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.20;
        ctx.fillStyle = '#b3d68c';
        ctx.beginPath();
        ctx.ellipse(crest.x, crest.y, 26, 18, -0.12, 0, Math.PI * 2);
        ctx.fill();
        if (readIntensity > 0.04) {
            const windowGlow = 0.12 + Math.min(0.42, readIntensity * 0.6);
            ctx.globalAlpha = windowGlow;
            ctx.fillStyle = '#fff2b0';
            ctx.beginPath();
            ctx.ellipse(window.x, window.y, 18 + readIntensity * 6, 12 + readIntensity * 4, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        const doorwayBoost = readIntensity > 0.6 ? (readIntensity - 0.6) * 0.55 : 0;
        ctx.globalAlpha = 0.24 + (ritual ? this._ritualFade(ritual) * 0.16 : 0) + doorwayBoost;
        ctx.fillStyle = '#ffd36a';
        ctx.beginPath();
        ctx.ellipse(doorway.x, doorway.y, 32, 20, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = '#e9ffd2';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(crest.x, crest.y, 18, 11, 0.16, 0, Math.PI * 2);
        ctx.moveTo(crest.x - 18, crest.y);
        ctx.lineTo(crest.x + 18, crest.y);
        ctx.stroke();

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.18 + pulse * 0.16;
        ctx.fillStyle = '#ffd36a';
        for (const lamp of [leftLamp, rightLamp]) {
            ctx.beginPath();
            ctx.ellipse(lamp.x, lamp.y, 28, 17, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        // Warm lamplight cone spilling out the doorway onto the entrance steps
        // when reading is busy (>0.4). Screen-composite so it sits as light, not
        // paint; brightness tracks the read counter and the slow building pulse.
        // The same intensity also drifts `archiveMote` dust through the door in
        // `_spawnEmittersFor`, and registers a ground `'spark'` light in
        // `_archiveSpillLightSources` so the spill bleeds onto adjacent tiles.
        this._drawArchiveDoorwaySpill(ctx, doorway, localPoint, readIntensity, pulse);
        // Reduced motion: ParticleSystem is muted so the high-intensity
        // doorway archiveMote burst would be invisible. Stamp a small fixed
        // dot cluster so the read signal still reads at the door.
        if (!this.motionScale && readIntensity > 0.6) {
            this._drawArchiveStaticDoorBurst(ctx, doorway);
        }
        this._drawArchiveRitual(ctx, doorway, ritual);
    }

    _drawArchiveDoorwaySpill(ctx, doorway, localPoint, readIntensity, pulse) {
        if (readIntensity <= 0.4) return;
        const strength = clamp01((readIntensity - 0.4) / 0.6);
        // Slow building pulse modulates the flicker; static at reduced motion.
        const flicker = this.motionScale ? 0.88 + pulse * 0.12 : 0.92;
        const step = localPoint(168, 142);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        // A short cone fanning from the doorway down onto the steps.
        const grad = ctx.createLinearGradient(doorway.x, doorway.y, step.x, step.y + 6);
        grad.addColorStop(0, `rgba(255, 224, 150, ${(0.26 + strength * 0.34) * flicker})`);
        grad.addColorStop(0.6, `rgba(255, 206, 120, ${(0.12 + strength * 0.20) * flicker})`);
        grad.addColorStop(1, 'rgba(255, 196, 110, 0)');
        ctx.fillStyle = grad;
        const halfTop = 9 + strength * 4;
        const halfBottom = 22 + strength * 12;
        ctx.beginPath();
        ctx.moveTo(doorway.x - halfTop, doorway.y);
        ctx.lineTo(doorway.x + halfTop, doorway.y);
        ctx.lineTo(step.x + halfBottom, step.y + 6);
        ctx.lineTo(step.x - halfBottom, step.y + 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawArchiveStaticDoorBurst(ctx, doorway) {
        const dots = [
            [0, -8], [-7, -2], [7, -2], [-3, 6], [3, 6],
        ];
        ctx.save();
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = '#fff1bd';
        for (const [dx, dy] of dots) {
            ctx.fillRect(doorway.x + dx, doorway.y + dy, 2, 2);
        }
        ctx.restore();
    }

    _drawForgeEnhancement(ctx, localPoint, pulse, building = null) {
        const hearth = localPoint(75, 118);
        const chimney = localPoint(175, 28);
        const anvil = localPoint(195, 150);
        const activity = building ? this._buildingActivityInfo(building) : { intensity: 0, occupancy: { ratio: 0 } };
        const activityIntensity = Math.max(this._forgeGlowIntensity(), activity.intensity * 0.76);
        const ritual = this._latestRitual('forge');
        this._drawForgeHeatBloom(ctx, hearth, pulse, activityIntensity);

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.05 + activityIntensity * 0.10;
        ctx.fillStyle = '#9a8d7f';
        ctx.beginPath();
        ctx.ellipse(chimney.x, chimney.y - 4, 17, 9, -0.22, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.06 + activityIntensity * 0.18 + (ritual ? this._ritualFade(ritual) * 0.12 : 0);
        ctx.fillStyle = '#ffd36a';
        ctx.beginPath();
        ctx.ellipse(anvil.x, anvil.y, 22, 12, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        this._drawForgeActivityMarks(ctx, hearth, anvil, activity, pulse);
    }

    _drawForgeActivityMarks(ctx, hearth, anvil, activity, pulse) {
        const signal = Math.max(activity?.intensity || 0, activity?.occupancy?.ratio || 0);
        if (signal <= 0.14) return;
        const count = Math.max(1, Math.min(4, Math.ceil(signal * 4)));
        const shimmer = this.motionScale ? Math.sin(this.frame * 0.18) * 1.4 : 0.6;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = Math.min(0.72, 0.22 + signal * 0.36 + pulse * 0.1);
        ctx.strokeStyle = activity?.alert ? '#ff755d' : '#ffd36a';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < count; i++) {
            const x = anvil.x - 18 + i * 10;
            const y = anvil.y + 14 - i * 2;
            ctx.beginPath();
            ctx.moveTo(x - 4, y + 2);
            ctx.lineTo(x + 6, y - 4 - shimmer * 0.35);
            ctx.stroke();
        }
        if (signal > 0.68) {
            ctx.globalAlpha = 0.16 + signal * 0.18;
            ctx.fillStyle = '#ff8a33';
            ctx.beginPath();
            ctx.ellipse(hearth.x + 6, hearth.y + 9, 38, 11, -0.22, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawForgeHeatBloom(ctx, hearth, pulse, activityIntensity = 1) {
        ctx.globalCompositeOperation = 'screen';
        const intensity = clamp01(activityIntensity);
        const steady = this.motionScale ? pulse : 0.45;
        const glow = ctx.createRadialGradient(hearth.x, hearth.y, 1, hearth.x, hearth.y, 38 + intensity * 28 + steady * 3);
        glow.addColorStop(0, `rgba(255, 239, 154, ${0.22 + intensity * 0.48})`);
        glow.addColorStop(0.35, `rgba(255, 126, 39, ${0.10 + intensity * 0.24})`);
        glow.addColorStop(1, 'rgba(255, 75, 24, 0)');
        ctx.globalAlpha = 0.18 + intensity * 0.52 + steady * 0.03;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(hearth.x + 2, hearth.y - 1, 55, 32, -0.24, 0, Math.PI * 2);
        ctx.fill();
        this._drawForgeMoltenSpill(ctx, hearth, intensity);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    // Molten-glow pool that spills onto the cobble apron in front of the forge
    // when the smithy is hot and the world is dark. Brightness signals real
    // smithing activity (_forgeGlow). Flicker rides the slow building pulse
    // band; reduced motion holds a steady, non-flickering fill (#11).
    _drawForgeMoltenSpill(ctx, hearth, intensity) {
        const night = clamp01(this.atmosphereState?.reactions?.nightReflection ?? 0);
        const heat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
        const strength = night * Math.max(heat, intensity * 0.6);
        if (strength <= 0.04) return;
        const flicker = this.motionScale
            ? 0.86 + Math.sin(this.frame * 0.07) * 0.10 + Math.sin(this.frame * 0.17) * 0.04
            : 0.9;
        const cx = hearth.x + 2;
        const cy = hearth.y + 20;
        const rx = 46 + strength * 14;
        const pool = ctx.createRadialGradient(cx, cy, 1, cx, cy, rx);
        pool.addColorStop(0, `rgba(255, 178, 86, ${0.26 + strength * 0.30})`);
        pool.addColorStop(0.5, `rgba(255, 120, 40, ${0.12 + strength * 0.18})`);
        pool.addColorStop(1, 'rgba(255, 70, 20, 0)');
        ctx.globalAlpha = (0.18 + strength * 0.46) * flicker;
        ctx.fillStyle = pool;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, 16 + strength * 6, -0.18, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawStaticSmokeWisp(ctx, point, { heat = 0, dust = false } = {}) {
        if (!point) return;
        const baseColor = dust
            ? '#b79b70'
            : mixHex('#8a8076', '#a8806b', clamp01(heat) * 0.7);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = baseColor;
        const puffs = [
            { dy: 0, rx: 6, ry: 4, alpha: 0.30 },
            { dy: -9, rx: 7.5, ry: 5, alpha: 0.22 },
            { dy: -19, rx: 9, ry: 6, alpha: 0.14 },
        ];
        for (const puff of puffs) {
            ctx.globalAlpha = puff.alpha;
            ctx.beginPath();
            ctx.ellipse(point.x, point.y + puff.dy, puff.rx, puff.ry, -0.18, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _drawArchiveRitual(ctx, doorway, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const flip = ritual.motionEnabled === false
            ? 0.5
            : Math.abs(Math.sin(Math.min(1, progress / 0.42) * Math.PI));
        const pageWidth = 18 * (1 - flip * 0.72);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#5e3c25';
        ctx.strokeStyle = '#2f1d12';
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(doorway.x - 19), Math.round(doorway.y - 22), 38, 24);
        ctx.strokeRect(Math.round(doorway.x - 19) + 0.5, Math.round(doorway.y - 22) + 0.5, 38, 24);
        ctx.fillStyle = '#e9d7a7';
        ctx.fillRect(Math.round(doorway.x - 16), Math.round(doorway.y - 19), 15, 18);
        ctx.fillStyle = '#f6e8bd';
        ctx.fillRect(Math.round(doorway.x + 2), Math.round(doorway.y - 19), Math.max(2, Math.round(pageWidth)), 18);
        ctx.strokeStyle = 'rgba(78, 51, 30, 0.52)';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(doorway.x - 12, doorway.y - 15 + i * 5);
            ctx.lineTo(doorway.x - 3, doorway.y - 15 + i * 5);
            ctx.moveTo(doorway.x + 5, doorway.y - 15 + i * 5);
            ctx.lineTo(doorway.x + pageWidth - 2, doorway.y - 15 + i * 5);
            ctx.stroke();
        }
        if (ritual.label) this._drawRitualLabel(ctx, doorway.x, doorway.y - 38, ritual.label, '#b3d68c', fade);
        ctx.restore();
    }

    _mineRailSpan(mouth) {
        const railA = { x: mouth.x - 26, y: mouth.y + 23 };
        const railB = { x: mouth.x + 30, y: mouth.y + 14 };
        const rdx = railB.x - railA.x;
        const rdy = railB.y - railA.y;
        const railLen = Math.hypot(rdx, rdy) || 1;
        const ux = rdx / railLen;
        const uy = rdy / railLen;
        return { railA, railB, railLen, ux, uy, nx: -uy, ny: ux };
    }

    _mineCargoMix(cargo) {
        if (!cargo || !Number.isFinite(Number(cargo.ratio))) {
            return { ratio: 0, bucket: 0, crystalSlots: 0 };
        }
        const ratio = clamp01(cargo.ratio);
        const bucket = Math.round(ratio * 8) / 8;
        return { ratio, bucket, crystalSlots: Math.round(6 * bucket) };
    }

    _drawMineCargoHeap(ctx, x, y, cargo, alpha = 1) {
        const mix = this._mineCargoMix(cargo);
        for (let i = 0; i < 6; i++) {
            const row = i < 3 ? 0 : 1;
            const col = i % 3;
            const px = x + (col - 1) * 7 + row * 3;
            const py = y - 13 - row * 6;
            const crystal = i < mix.crystalSlots;
            const palette = crystal ? MINE_CARGO_CRYSTAL_COLORS : MINE_CARGO_ORE_COLORS;
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = alpha;
            ctx.fillStyle = palette[i % palette.length];
            ctx.strokeStyle = crystal ? '#e6f8ff' : '#7e6a50';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (crystal) {
                ctx.moveTo(px, py - 4);
                ctx.lineTo(px + 4, py);
                ctx.lineTo(px, py + 4);
                ctx.lineTo(px - 4, py);
            } else {
                ctx.moveTo(px - 4, py + 2);
                ctx.lineTo(px - 2, py - 3);
                ctx.lineTo(px + 3, py - 4);
                ctx.lineTo(px + 5, py + 2);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            if (crystal) {
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = alpha * 0.72;
                ctx.fillStyle = '#e6f8ff';
                ctx.fillRect(Math.round(px - 1), Math.round(py - 3), 1, 2);
            }
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawMineRitual(ctx, mouth, ritual) {
        if (!ritual) return;
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const swing = ritual.motionEnabled === false
            ? -0.45
            : -0.95 + Math.sin(Math.min(1, progress / 0.62) * Math.PI * 2) * 0.9;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(mouth.x - 4, mouth.y + 2);
        ctx.rotate(swing);
        ctx.strokeStyle = '#3a2819';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -21);
        ctx.lineTo(0, 5);
        ctx.stroke();
        ctx.strokeStyle = '#d7a45c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-10, -23);
        ctx.lineTo(12, -18);
        ctx.stroke();
        ctx.restore();

        const rail = this._mineRailSpan(mouth);
        const rollProgress = ritual.motionEnabled === false
            ? 0.6
            : 1 - Math.pow(1 - clamp01(progress), 3);
        const cartX = rail.railA.x + rail.ux * rail.railLen * rollProgress;
        const cartY = rail.railA.y + rail.uy * rail.railLen * rollProgress;
        ctx.save();
        ctx.globalAlpha = fade;
        if (this.assets?.get?.('prop.oreCart')) {
            this.sprites.drawSprite(ctx, 'prop.oreCart', cartX, cartY);
        } else {
            ctx.fillStyle = '#5a3927';
            ctx.fillRect(Math.round(cartX - 15), Math.round(cartY - 10), 30, 14);
            ctx.strokeStyle = '#2f2119';
            ctx.strokeRect(Math.round(cartX - 15) + 0.5, Math.round(cartY - 10) + 0.5, 29, 13);
        }
        if (ritual.cargo && (ritual.motionEnabled === false || this._zoom >= 1)) {
            this._drawMineCargoHeap(ctx, cartX, cartY, ritual.cargo, fade);
        }
        ctx.restore();

        const oreProgress = ritual.motionEnabled === false ? 0.5 : clamp01((progress - 0.18) / 0.58);
        if (oreProgress > 0 && oreProgress < 1) {
            const mix = this._mineCargoMix(ritual.cargo);
            const shardCount = ritual.cargo ? 2 : 1;
            for (let i = 0; i < shardCount; i++) {
                const shardProgress = clamp01(oreProgress - i * 0.08);
                const ox = mouth.x - 8 + shardProgress * 44;
                const oy = mouth.y + 12 - Math.sin(shardProgress * Math.PI) * (28 - i * 5);
                const crystal = ritual.cargo && i < Math.round(2 * mix.bucket);
                ctx.save();
                ctx.globalAlpha = fade;
                ctx.fillStyle = crystal
                    ? MINE_CARGO_CRYSTAL_COLORS[i % MINE_CARGO_CRYSTAL_COLORS.length]
                    : (ritual.cargo ? MINE_CARGO_ORE_COLORS[i % MINE_CARGO_ORE_COLORS.length] : this._mineSeamColor());
                ctx.strokeStyle = crystal ? '#e6f8ff' : '#4a2f1c';
                ctx.beginPath();
                ctx.moveTo(ox - 5, oy);
                ctx.lineTo(ox + 1, oy - 5);
                ctx.lineTo(ox + 7, oy - 1);
                ctx.lineTo(ox + 3, oy + 5);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        }
        if (ritual.label) this._drawRitualLabel(ctx, mouth.x, mouth.y - 40, ritual.label, this._mineSeamColor(), fade);
        if (ritual.cargo && (ritual.motionEnabled === false || this._zoom >= 1.5)) {
            const percentage = Math.round(this._mineCargoMix(ritual.cargo).ratio * 100);
            this._drawRitualLabel(ctx, cartX, cartY - 31, `${percentage}% CACHE`, '#9fd8f0', fade);
        }
    }

    // Mine reserves = remaining 5-hour quota, rendered as a stockpile of glowing
    // ore crystals (count = reserve tier 0..4) above a five-segment reserve
    // gauge. The higher the remaining limit, the richer the mine. A depleted
    // reserve raises a pulsing red warning; without quota data the mine makes no
    // reserve claim at all.
    _drawMineReserve(ctx, mouth, building) {
        if (!this._hasMineQuota()) return;

        const reserve = this._mineReserveRatio();
        const tier = this._mineReserveTier();   // 0 depleted .. 4 brimming
        const depleted = tier === 0;
        const seamColor = this._mineSeamColor(); // gold (rich) -> red (depleted)

        const barWidth = 40;
        const barX = Math.round(mouth.x - barWidth / 2);
        const barY = Math.round(mouth.y + 33);
        const fillWidth = Math.round(barWidth * reserve);

        ctx.save();

        // Ore stockpile: one crystal per filled tier, piled at the cave mouth.
        for (let i = 0; i < tier; i++) {
            const col = i % 3;
            const row = i < 3 ? 0 : 1;
            const x = mouth.x - 15 + col * 15 + row * 7;
            const y = mouth.y + 17 - row * 7;
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.8;
            this._drawActivityDiamond(ctx, x, y, 4.6, '#3a2819', 'rgba(255, 210, 128, 0.34)');
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.5 + reserve * 0.3;
            this._drawActivityDiamond(ctx, x, y - 1, 3.1, seamColor);
        }

        // Reserve gauge: dark track, four tier ticks, reserve fill.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.74;
        ctx.fillStyle = 'rgba(34, 24, 15, 0.82)';
        ctx.fillRect(barX, barY, barWidth, 4);
        ctx.strokeStyle = 'rgba(244, 214, 139, 0.38)';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, 3);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(20, 13, 7, 0.85)';
        for (let i = 1; i < 5; i++) {
            ctx.fillRect(barX + Math.round((barWidth / 5) * i), barY, 1, 4);
        }

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.58 + reserve * 0.3;
        ctx.fillStyle = seamColor;
        ctx.fillRect(barX + 1, barY + 1, Math.max(0, fillWidth - 2), 2);

        // Depleted reserves: pulsing red warning chevrons at the gauge ends.
        if (depleted) {
            ctx.globalCompositeOperation = 'source-over';
            const warn = this.motionScale ? 0.55 + Math.sin(this.frame * 0.18) * 0.27 : 0.6;
            ctx.globalAlpha = warn;
            ctx.strokeStyle = '#ff755d';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(barX - 5, barY - 2);
            ctx.lineTo(barX - 1, barY + 6);
            ctx.moveTo(barX + barWidth + 5, barY - 2);
            ctx.lineTo(barX + barWidth + 1, barY + 6);
            ctx.stroke();
        }
        ctx.restore();
    }

    // #52 — dome aperture: the round opening nearest the telescope opens with
    // the night beacon (state-driven, so the reduced-motion pose is simply the
    // same static open amount) revealing a warm slit + star point; a completed
    // web ritual pays off as a brief star burst. 6.5 — when nothing is going
    // on, a slow glint (slow band, shared with the observatory sweep — never
    // concurrent, the glint idles only while no ritual runs) crosses the dormer.
    _drawObservatoryAperture(ctx, localPoint) {
        const night = clamp01(this.lightingState?.beaconIntensity
            ?? this.atmosphereState?.lighting?.beaconIntensity ?? 0);
        // Closed by day, fully open in deep night.
        const open = clamp01((night - 0.3) / 0.5);
        const burstAge = Date.now() - this._observatoryBurstAt;
        const bursting = burstAge >= 0 && burstAge < OBSERVATORY_BURST_MS;
        // Motion fades the burst envelope out; reduced motion holds a fixed
        // alpha for the window instead (static one-shot flash).
        const burst = bursting
            ? (this.motionScale ? 1 - burstAge / OBSERVATORY_BURST_MS : 0.85)
            : 0;
        const ritualActive = this._observatoryWebRitualIds.size > 0;

        if (open > 0.02 || burst > 0) {
            const slit = localPoint(...OBSERVATORY_APERTURE.slit);
            const star = localPoint(...OBSERVATORY_APERTURE.star);
            const slitH = 1 + Math.round(open * 4);
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            const glowAlpha = Math.min(0.5, 0.10 + open * 0.2 + burst * 0.3);
            const grad = ctx.createRadialGradient(slit.x, slit.y, 0, slit.x, slit.y, 14 + burst * 10);
            grad.addColorStop(0, `rgba(255, 214, 138, ${glowAlpha})`);
            grad.addColorStop(1, 'rgba(255, 162, 78, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(slit.x, slit.y, 15 + burst * 8, 10 + burst * 6, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            ctx.save();
            // Dark frame + warm core so the slit reads as an opening, not a glow smear.
            ctx.fillStyle = 'rgba(22, 17, 26, 0.88)';
            ctx.fillRect(slit.x - 4, slit.y - Math.ceil(slitH / 2) - 1, 9, slitH + 2);
            ctx.fillStyle = `rgba(255, 216, 142, ${0.32 + open * 0.45})`;
            ctx.fillRect(slit.x - 3, slit.y - Math.floor(slitH / 2), 7, slitH);
            // Star point inside the aperture; gentle twinkle on the slow band.
            const twinkle = this.motionScale ? 0.5 + Math.sin(this.frame * 0.05) * 0.18 : 0.58;
            ctx.fillStyle = `rgba(255, 244, 196, ${Math.min(1, twinkle + burst * 0.4)})`;
            ctx.fillRect(star.x - 1, star.y - 1, 2, 2);
            if (burst > 0) {
                // 4-point result-burst star over the dormer.
                ctx.strokeStyle = `rgba(255, 241, 168, ${Math.min(1, 0.45 + burst * 0.55)})`;
                ctx.lineWidth = 1;
                const arm = 3 + Math.round(burst * 5);
                ctx.beginPath();
                ctx.moveTo(star.x - arm, star.y);
                ctx.lineTo(star.x + arm, star.y);
                ctx.moveTo(star.x, star.y - arm);
                ctx.lineTo(star.x, star.y + arm);
                ctx.stroke();
            }
            ctx.restore();
        }

        this._drawObservatoryIdleGlint(ctx, localPoint, ritualActive);
    }

    // 6.5 — idle glint: a slow bright point sweeping the dormer glass on a ~9s
    // sawtooth while the observatory has no live web ritual. Reduced motion: a
    // fixed faint glint at the arc's rest angle (no sweep, no allocations).
    _drawObservatoryIdleGlint(ctx, localPoint, ritualActive) {
        if (ritualActive) return;
        const arc = OBSERVATORY_APERTURE.glintArc || { center: [149, 104], radius: 12, from: -2.4, to: -0.7 };
        const center = localPoint(...arc.center);
        let angle;
        let alpha;
        if (this.motionScale) {
            const t = (this.frame % OBSERVATORY_GLINT_PERIOD_FRAMES) / OBSERVATORY_GLINT_PERIOD_FRAMES;
            // Sweep across the arc for the first 22% of the period, dark the rest.
            if (t > 0.22) return;
            const sweep = t / 0.22;
            angle = arc.from + (arc.to - arc.from) * sweep;
            alpha = Math.sin(sweep * Math.PI) * 0.55;
        } else {
            angle = arc.from + (arc.to - arc.from) * 0.5;
            alpha = 0.22;
        }
        const gx = Math.round(center.x + Math.cos(angle) * arc.radius);
        const gy = Math.round(center.y + Math.sin(angle) * arc.radius * 0.6);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#e8f2ff';
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillRect(gx - 2, gy, 4, 1);
        ctx.restore();
    }

    _drawObservatoryRitual(ctx, localPoint, building) {
        const ritual = this._latestRitual('observatory');
        if (!ritual) return;
        const dome = localPoint(157, 86);
        const progress = this._ritualProgress(ritual);
        const fade = this._ritualFade(ritual);
        const target = ritual.angle || -0.7;
        const angle = ritual.motionEnabled === false ? target : lerp(-1.2, target, Math.min(1, progress / 0.5));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(dome.x, dome.y);
        ctx.rotate(angle);
        ctx.fillStyle = '#6e7585';
        ctx.strokeStyle = '#252532';
        ctx.lineWidth = 1;
        ctx.fillRect(0, -4, 28, 8);
        ctx.strokeRect(0.5, -3.5, 27, 7);
        ctx.fillStyle = '#bda7ff';
        ctx.fillRect(23, -3, 5, 6);
        ctx.restore();

        if (ritual.motionEnabled !== false && progress > 0.48 && progress < 0.86) {
            ctx.save();
            ctx.globalAlpha = fade * 0.72;
            ctx.strokeStyle = '#d9c7ff';
            ctx.setLineDash([3, 5]);
            ctx.beginPath();
            ctx.arc(dome.x, dome.y, 34, -1.2, angle);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#fff1a8';
            for (let i = 0; i < 6; i++) {
                const a = -1.2 + (angle + 1.2) * (i / 5);
                ctx.fillRect(Math.round(dome.x + Math.cos(a) * 34), Math.round(dome.y + Math.sin(a) * 34), 2, 2);
            }
            ctx.restore();
        }
        if (ritual.label) this._drawRitualLabel(ctx, dome.x, dome.y + 54, ritual.label, '#bda7ff', fade);
    }

    _drawPortalRitual(ctx, gate, ritual) {
        if (!ritual) return;
        const fade = this._ritualFade(ritual);
        const action = ritual.action || 'portal';
        const progress = ritual.motionEnabled === false ? 1 : this._ritualProgress(ritual);
        // Distinguish browser-preview vs Playwright-active by re-classifying
        // the ritual's source tool. `action === 'summon'` (and other lifecycle
        // actions) keep the full-stack rings unchanged.
        const reason = action === 'portal' ? this._portalReasonFor(ritual) : null;
        const color = action === 'dismiss'
            ? '#f08a8a'
            : action === 'familiar-wait'
                ? '#f2d36b'
                : action === 'familiar-return'
                    ? '#bda7ff'
                    : reason === 'portal-preview'
                        ? '#7dd3ff'
                        : '#8feaff';

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = fade * (action === 'familiar-wait' ? 0.16 : 0.24);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        const ringPhase = ritual.motionEnabled === false ? 0.5 : progress;
        // portal-preview = single inner ring (cool blue); other states keep the
        // 3-ring stack so summon/dismiss/familiar/active read as full ceremony.
        const ringCount = reason === 'portal-preview' ? 1 : 3;
        for (let i = 0; i < ringCount; i++) {
            const offset = action === 'dismiss' ? (1 - ringPhase) * 13 : ringPhase * 12;
            const radius = 23 + i * 8 + offset;
            const tilt = this.motionScale ? this.frame * 0.012 + i * 0.7 : i * 0.7;
            ctx.beginPath();
            ctx.ellipse(gate.x, gate.y + 2, radius, radius * 0.55, tilt, 0, Math.PI * 2);
            ctx.stroke();
        }

        const targetSprite = this._targetSpriteForRitual(ritual);
        if (targetSprite && action !== 'summon') {
            const target = { x: targetSprite.x, y: targetSprite.y - 42 };
            const control = {
                x: (gate.x + target.x) / 2,
                y: Math.min(gate.y, target.y) - 46,
            };
            const travel = action === 'dismiss' || action === 'familiar-return'
                ? 1 - progress
                : progress;
            const pulseX = gate.x * (1 - travel) + target.x * travel;
            const pulseY = gate.y * (1 - travel) + target.y * travel - Math.sin(Math.PI * travel) * 22;
            ctx.globalAlpha = fade * 0.24;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(gate.x, gate.y);
            ctx.quadraticCurveTo(control.x, control.y, target.x, target.y);
            ctx.stroke();
            ctx.globalAlpha = fade * 0.78;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(pulseX, pulseY, 3.5, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalCompositeOperation = 'source-over';
        // Procedural 16x12 floating screen for portal-active. Drawn before the
        // label so the parchment tag sits above it.
        if (reason === 'portal-active') {
            this._drawPortalActiveScreen(ctx, gate, fade);
        }
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(22, 35, 48, 0.86)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect?.(gate.x - 42, gate.y - 58, 84, 24, 4);
        if (!ctx.roundRect) ctx.rect(gate.x - 42, gate.y - 58, 84, 24);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d9fbff';
        ctx.font = `9px ${WORLD_BODY_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this._portalRitualLabel(ritual), gate.x, gate.y - 46);
        ctx.restore();
    }

    // Re-classify the ritual's source tool/input to recover the
    // browser-preview vs Playwright-active reason. The conductor currently
    // does not forward `event.reason`, so derive it here from the same
    // ToolIdentity helper that produced the original event.
    _portalReasonFor(ritual) {
        if (!ritual?.tool) return null;
        try {
            const classified = classifyTool(ritual.tool, ritual.input || '');
            const reason = classified?.reason;
            if (reason === 'portal-active' || reason === 'portal-preview') return reason;
        } catch {
            return null;
        }
        return null;
    }

    // Canvas-drawn 16x12 rounded screen hovering above the gate.
    // Scanline drift uses `frame` so it pauses under reduced motion. No PixelLab.
    _drawPortalActiveScreen(ctx, gate, fade) {
        const w = 16;
        const h = 12;
        const x = Math.round(gate.x - w / 2);
        const y = Math.round(gate.y - 34);
        ctx.save();
        ctx.globalAlpha = fade * 0.9;
        ctx.fillStyle = 'rgba(18, 28, 42, 0.94)';
        ctx.strokeStyle = '#8feaff';
        ctx.lineWidth = 1;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, 2);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
        // Faint scanline that drifts top-to-bottom; static at row 5 when motion is off.
        const drift = this.motionScale ? Math.floor((this.frame * 0.18) % (h - 2)) : 5;
        ctx.globalAlpha = fade * 0.45;
        ctx.fillStyle = '#bff2ff';
        ctx.fillRect(x + 1, y + 1 + drift, w - 2, 1);
        ctx.restore();
    }

    _portalRitualLabel(ritual) {
        const lifecycle = ritual?.commandLifecycle;
        const fallback = lifecycle?.kind === 'spawn'
            ? 'SUMMON'
            : lifecycle?.kind === 'close'
                ? 'DISMISS'
                : lifecycle?.kind === 'wait'
                    ? 'ATTUNE'
                    : lifecycle?.kind === 'resume'
                        ? 'RECALL'
                        : lifecycle?.kind === 'send_input'
                            ? 'TETHER'
                            : 'PORTAL';
        return compactRitualLabel(ritual?.label, fallback).toUpperCase();
    }

    _drawTaskboardBoard(ctx, localPoint) {
        const agent = this._taskboardBoardAgent();
        const view = this._taskboardViewFor(agent, 3);
        if (!view) return false;
        const chalk = 'rgba(231, 234, 216, 0.94)';
        const dimChalk = 'rgba(211, 218, 201, 0.5)';
        const accent = '#8bd7ff';
        const inset = 3;
        const slateTopLeft = localPoint(TASKBOARD_SLATE_RECT.x, TASKBOARD_SLATE_RECT.y);
        const inner = {
            x: slateTopLeft.x + inset,
            y: slateTopLeft.y + inset,
            w: TASKBOARD_SLATE_RECT.w - inset * 2,
            h: TASKBOARD_SLATE_RECT.h - inset * 2,
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(inner.x, inner.y, inner.w, inner.h);
        ctx.clip();
        ctx.textBaseline = 'top';
        const fitText = (source, width) => {
            const text = String(source || '');
            if (ctx.measureText(text).width <= width) return text;
            let low = 0;
            let high = text.length;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= width) low = mid;
                else high = mid - 1;
            }
            return low > 0 ? `${text.slice(0, low).trimEnd()}…` : '…';
        };
        ctx.font = '6px "Press Start 2P", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = chalk;
        ctx.fillText(fitText(view.header, inner.w), inner.x, inner.y);
        ctx.fillStyle = 'rgba(139, 215, 255, 0.42)';
        ctx.fillRect(inner.x, inner.y + 8, inner.w, 1);
        const contentTop = inner.y + 11;
        const availableHeight = inner.h - 11;
        const requestedRows = view.layout.rows;
        const lineHeight = Math.max(6, Math.min(9, Math.floor(
            availableHeight / Math.max(1, requestedRows.length),
        )));
        const capacity = Math.max(1, Math.floor(availableHeight / lineHeight));
        const rows = requestedRows.length > capacity
            ? [...requestedRows.slice(0, capacity - 1), { kind: 'more', text: '…' }]
            : requestedRows;
        const fontSize = Math.max(6, Math.min(8, lineHeight));
        ctx.font = `${fontSize}px ${WORLD_BODY_FONT}`;
        ctx.textBaseline = 'middle';
        let phaseIndex = 0;
        rows.forEach((row, index) => {
            const itemIndent = row.kind === 'item' || row.kind === 'more' ? 6 : 0;
            const x = inner.x + itemIndent;
            const y = contentTop + lineHeight / 2 + index * lineHeight;
            const rowText = row.kind === 'phase'
                ? `${taskboardPhaseMarker(phaseIndex++)}. ${row.text} · ${row.done}/${row.total}`
                : row.text;
            const text = fitText(rowText, inner.w - itemIndent);
            const width = ctx.measureText(text).width;
            if ((row.kind === 'phase' && row.active) || row.status === 'in_progress') {
                ctx.fillStyle = accent;
                ctx.fillRect(x - (itemIndent ? 5 : 3), Math.round(y) - 2, 2, 4);
            }
            ctx.fillStyle = row.status === 'completed'
                ? dimChalk
                : row.status === 'in_progress'
                    ? accent
                    : chalk;
            ctx.fillText(text, x, y);
            if (row.status === 'completed') {
                ctx.strokeStyle = 'rgba(211, 218, 201, 0.66)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, Math.round(y));
                ctx.lineTo(x + width, Math.round(y));
                ctx.stroke();
            }
        });
        ctx.restore();
        return true;
    }

    _drawTaskboardRitual(ctx, localPoint) {
        const papers = this._taskboardPapers
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-MAX_TASKBOARD_PAPERS);
        if (!papers.length) return;
        const board = localPoint(128, 90);
        const now = Date.now();
        papers.forEach((paper, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const completed = paper.status === 'completed';
            const completeAge = completed ? Math.max(0, now - paper.completedAt) : 0;
            const flutter = completed && this.motionScale
                ? Math.max(0, 1 - completeAge / 2200)
                : 0;
            const drift = flutter ? Math.sin(this.frame * 0.42 + paper.slotSeed) * 3 : 0;
            const angle = flutter ? Math.sin(this.frame * 0.18 + paper.slotSeed) * 0.08 : 0;
            const x = board.x - 24 + col * 24;
            const y = board.y - 28 + row * 18 + drift;
            ctx.save();
            ctx.translate(Math.round(x + 10), Math.round(y + 7));
            ctx.rotate(angle);
            ctx.globalAlpha = completed ? 0.88 : 1;
            ctx.fillStyle = completed ? '#d7c088' : '#e8cf91';
            ctx.strokeStyle = completed ? '#3f4e38' : '#4a3420';
            ctx.lineWidth = 1;
            ctx.fillRect(-10, -7, 20, 15);
            ctx.strokeRect(-9.5, -6.5, 19, 14);
            ctx.fillStyle = completed ? '#2d6b47' : '#9e4a35';
            ctx.fillRect(-1, -9, 3, 4);

            ctx.strokeStyle = completed ? 'rgba(50, 72, 45, 0.62)' : 'rgba(68, 44, 24, 0.55)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.moveTo(-6, -2 + i * 4);
                ctx.lineTo(6, -2 + i * 4);
                ctx.stroke();
            }

            if (completed) {
                ctx.strokeStyle = '#2d6b47';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-7, 1);
                ctx.lineTo(7, -2);
                ctx.stroke();
                ctx.strokeStyle = 'rgba(58, 41, 26, 0.82)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-8, 5);
                ctx.lineTo(8, 2);
                ctx.stroke();
            }
            ctx.restore();
        });
    }

    _drawCommandActivityDetails(ctx, localPoint, building, pulse) {
        const activity = this._buildingActivityInfo(building);
        const activeWorking = this._watchtowerActiveCount();
        const signal = Math.max(activity.intensity, activity.occupancy.ratio, Math.min(1, activeWorking / 6));
        if (signal <= 0.16) return;

        const keep = localPoint(155, 34);
        const hall = localPoint(155, 98);
        const count = Math.max(1, Math.min(5, Math.ceil(signal * 5)));
        const beaconPulse = this.motionScale ? Math.sin(this.frame * 0.13) * 0.5 + 0.5 : 0.55;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.12 + signal * 0.22 + pulse * 0.08;
        ctx.fillStyle = '#f6c85f';
        ctx.beginPath();
        ctx.ellipse(hall.x, hall.y, 44 + signal * 10, 20 + signal * 4, -0.12, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#ffe59a';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.16 + signal * 0.18;
        for (let i = 0; i < 2; i++) {
            const grow = this.motionScale ? ((beaconPulse + i * 0.44) % 1) : 0.48 + i * 0.12;
            ctx.beginPath();
            ctx.ellipse(keep.x + 14, keep.y - 18, 16 + grow * 16, 8 + grow * 6, -0.18, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < count; i++) {
            const x = Math.round(hall.x - 22 + i * 11);
            const y = Math.round(hall.y + 16 + (i % 2) * 2);
            // 6.5 — hall windows redrawn sprite-quality: arched dark frame,
            // warm two-tone interior lit by activity, pale sill (replaces the
            // crude 8x7 fillRect blocks). Count still tracks the activity signal.
            const lit = i < activeWorking;
            ctx.globalAlpha = 0.9;
            // Arched frame: stepped pixel arch over a rect body.
            ctx.fillStyle = 'rgba(24, 16, 10, 0.92)';
            ctx.fillRect(x - 4, y - 3, 9, 8);
            ctx.fillRect(x - 3, y - 5, 7, 2);
            ctx.fillRect(x - 1, y - 6, 3, 1);
            // Interior glass: lit windows burn warm, unlit keep a faint ember.
            ctx.globalAlpha = lit ? 0.72 + signal * 0.22 : 0.5;
            ctx.fillStyle = lit ? '#ffe59a' : '#8a6438';
            ctx.fillRect(x - 3, y - 2, 7, 6);
            ctx.fillRect(x - 2, y - 4, 5, 2);
            if (lit) {
                ctx.fillStyle = '#fff6cf';
                ctx.fillRect(x - 1, y - 3, 2, 5);
            }
            // Sill.
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = 'rgba(214, 182, 118, 0.55)';
            ctx.fillRect(x - 4, y + 5, 9, 1);
        }
        ctx.restore();
    }

    _drawCommandRitual(ctx, localPoint) {
        const rituals = this._ritualsFor('command');
        if (!rituals.length) return;
        const keep = localPoint(155, 34);
        for (const ritual of rituals) {
            const fade = this._ritualFade(ritual);
            if (ritual.action === 'message') {
                this._drawCarrierBird(ctx, keep, ritual, fade);
                continue;
            }
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.fillStyle = '#201814';
            ctx.fillRect(Math.round(keep.x), Math.round(keep.y - 38), 2, 34);
            ctx.fillStyle = '#f2d36b';
            ctx.strokeStyle = '#3a2614';
            ctx.beginPath();
            ctx.moveTo(keep.x + 2, keep.y - 38);
            ctx.lineTo(keep.x + 28, keep.y - 31);
            ctx.lineTo(keep.x + 2, keep.y - 24);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawCarrierBird(ctx, source, ritual, fade) {
        const target = this._chatTargetForRitual(ritual) || { x: source.x + 52, y: source.y + 2 };
        const progress = ritual.motionEnabled === false ? 1 : clamp01(this._ritualProgress(ritual) / 0.72);
        const control = { x: (source.x + target.x) / 2, y: Math.min(source.y, target.y) - 70 };
        const inv = 1 - progress;
        const x = inv * inv * source.x + 2 * inv * progress * control.x + progress * progress * target.x;
        const y = inv * inv * (source.y - 24) + 2 * inv * progress * control.y + progress * progress * (target.y - 42);
        if (ritual.motionEnabled === false) {
            this._drawRitualLabel(ctx, source.x, source.y - 54, 'MSG', '#f2d36b', fade);
            return;
        }
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#f1ead0';
        ctx.strokeStyle = '#45311c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y, 7, 4, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#f2d36b';
        ctx.beginPath();
        ctx.moveTo(x - 2, y);
        ctx.quadraticCurveTo(x - 10, y - 8, x - 15, y - 2);
        ctx.moveTo(x + 2, y);
        ctx.quadraticCurveTo(x + 10, y - 8, x + 15, y - 2);
        ctx.stroke();
        ctx.restore();
    }

    _drawWatchtowerRitual(ctx, beacon) {
        const active = this._watchtowerActiveCount();
        const failed = this.harborStatus?.failedPushActive;
        if (active <= 0 && !failed) return;
        const intensity = this._watchtowerIntensity();
        const color = failed ? '#ff6d52' : '#ffd36a';
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.10 + intensity * 0.20;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 + intensity * 3;
        const flutter = this.motionScale ? Math.sin(this.frame * 0.16) : 0.4;
        for (let i = 0; i < 3; i++) {
            const radius = 19 + i * 9 + intensity * 9 + flutter * (i + 1);
            ctx.beginPath();
            ctx.ellipse(beacon.x, beacon.y + 2, radius, radius * 0.5, -0.12, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.18 + intensity * 0.18;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(beacon.x, beacon.y + 8, 28 + intensity * 12, 10 + intensity * 4, 0, 0, Math.PI * 2);
        ctx.fill();
        if (failed) {
            ctx.globalAlpha = 0.16 + intensity * 0.18;
            ctx.fillStyle = '#ff4d3f';
            ctx.beginPath();
            ctx.ellipse(beacon.x, beacon.y, 42, 20, -0.12, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // #17 — Pharos rotating searchlight: a soft wedge sweeping from the lantern
    // pivot, composited `screen`. Sweep speed (driven by _updateWatchtowerSearchlight)
    // and colour both read fleet distress — amber when calm, shifting to red as
    // errored/rate-limited agents mount. The beam is clipped to the sky above the
    // pivot so it never spills onto the terrain below the tower.
    //
    // Pulse band: slow/variable — the sweep angle is the primary motion; the glow
    // alpha breathes gently on this.frame (held static under reduced motion).
    // Reduced-motion fallback: no rotation (angle frozen at last value) and a
    // single static directional wedge at a steady alpha.
    _drawWatchtowerSearchlight(ctx, pivot, pulse, fleetDistressRatio = 0) {
        const distress = clamp01(fleetDistressRatio);
        const angle = this._watchtowerSearchlightAngle;
        const length = WATCHTOWER_SEARCHLIGHT.length || 320;
        const farWidth = WATCHTOWER_SEARCHLIGHT.width || 58;
        // Amber (calm) → red (distressed) for the lit core and the soft halo.
        const core = mixHex('#ffe6a0', '#ff5a3c', distress);
        const haze = mixHex('#ffb347', '#ff3a2a', distress);
        // Glow breathes gently; reduced motion holds a steady alpha.
        const breathe = this.motionScale ? 0.86 + pulse * 0.14 : 0.9;
        // #40 — a fresh incident flares the beam brighter for ~1.4s. Held at 0
        // under reduced motion so the static wedge keeps a steady alpha.
        const flare = this.motionScale ? clamp01(this._watchtowerFlare) : 0;
        const beamAlpha = (0.16 + distress * 0.22 + flare * 0.26) * breathe;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';

        // Clip to the sky above the pivot so the wedge never paints the ground.
        ctx.beginPath();
        ctx.rect(pivot.x - length, pivot.y - length, length * 2, length + 6);
        ctx.clip();

        const drawWedge = (theta, len, far, alpha) => {
            if (alpha <= 0) return;
            const dx = Math.cos(theta);
            const dy = Math.sin(theta);
            const px = -dy;
            const py = dx;
            const tipX = pivot.x + dx * len;
            const tipY = pivot.y + dy * len;
            const grad = ctx.createLinearGradient(pivot.x, pivot.y, tipX, tipY);
            grad.addColorStop(0, core);
            grad.addColorStop(0.5, haze);
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.globalAlpha = alpha;
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(pivot.x + px * 4, pivot.y + py * 4);
            ctx.lineTo(pivot.x - px * 4, pivot.y - py * 4);
            ctx.lineTo(tipX - px * (far / 2), tipY - py * (far / 2));
            ctx.lineTo(tipX + px * (far / 2), tipY + py * (far / 2));
            ctx.closePath();
            ctx.fill();
        };

        if (!this.motionScale) {
            // Static directional wedge — single fixed sweep, no opposing beam.
            drawWedge(angle, length, farWidth, beamAlpha);
        } else {
            drawWedge(angle, length, farWidth, beamAlpha);
            // Faint trailing counter-beam, like a real twin-lamp lighthouse.
            drawWedge(angle + Math.PI, length * 0.7, farWidth * 0.7, beamAlpha * 0.5);
        }

        // Bright pivot bloom so the lamp reads as the beam's origin.
        const bloom = ctx.createRadialGradient(pivot.x, pivot.y, 1, pivot.x, pivot.y, 16 + distress * 6);
        bloom.addColorStop(0, core);
        bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.globalAlpha = clamp01(0.5 + distress * 0.3 + flare * 0.3);
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(pivot.x, pivot.y, 16 + distress * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _drawRitualLabel(ctx, x, y, label, color, alpha = 1) {
        const text = compactRitualLabel(label);
        if (!text) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `9px ${WORLD_BODY_FONT}`;
        const width = Math.max(28, ctx.measureText(text).width + 10);
        ctx.fillStyle = 'rgba(30, 24, 18, 0.82)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(x - width / 2), Math.round(y - 7), Math.round(width), 14);
        ctx.strokeRect(Math.round(x - width / 2) + 0.5, Math.round(y - 7) + 0.5, Math.round(width) - 1, 13);
        ctx.fillStyle = '#fff0c4';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, Math.round(x), Math.round(y));
        ctx.restore();
    }

    _chatTargetForRitual(ritual) {
        const explicitTarget = this._targetSpriteForRitual(ritual);
        if (explicitTarget) return explicitTarget;
        const source = this.agentSprites.find(sprite => sprite?.agent?.id === ritual.agentId);
        return source?.chatPartner || null;
    }

    _targetSpriteForRitual(ritual) {
        const lifecycle = ritual?.commandLifecycle || null;
        const targetId = lifecycle?.targetAgentId || null;
        if (targetId) {
            const exact = this.agentSprites.find(sprite => sprite?.agent?.id === targetId);
            if (exact) return exact;
        }
        const targetRef = lifecycle?.targetRef || null;
        if (!targetRef) return null;
        const ref = String(targetRef).toLowerCase();
        return this.agentSprites.find((sprite) => {
            const agent = sprite?.agent;
            if (!agent) return false;
            return String(agent.id || '').toLowerCase() === ref
                || String(agent.agentId || '').toLowerCase() === ref
                || String(agent.agentName || '').toLowerCase() === ref
                || String(agent.name || '').toLowerCase() === ref;
        }) || null;
    }

    _mineSeamColor() {
        const ratio = this._quotaFiveHourRatio();
        if (ratio <= 0.5) return MINE_SEAM_COLORS[0];
        if (ratio <= 0.8) return mixHex(MINE_SEAM_COLORS[0], MINE_SEAM_COLORS[1], (ratio - 0.5) / 0.3);
        return mixHex(MINE_SEAM_COLORS[1], MINE_SEAM_COLORS[2], (ratio - 0.8) / 0.2);
    }

    _hasMineQuota() {
        return Number.isFinite(Number(this.quotaState?.fiveHour ?? this.quotaState?.fiveHourRatio));
    }

    // Remaining 5-hour limit as a 0..1 reserve (inverse of usage). Higher means
    // more "ore" left in the mine.
    _mineReserveRatio() {
        return clamp01(1 - this._quotaFiveHourRatio());
    }

    // Discrete reserve tier 0..4 (depleted / low / medium / high / brimming).
    // The 0.2 depleted floor mirrors the top-bar danger threshold (usage >= 0.8).
    _mineReserveTier() {
        const reserve = this._mineReserveRatio();
        if (reserve < 0.2) return 0;
        if (reserve < 0.4) return 1;
        if (reserve < 0.6) return 2;
        if (reserve < 0.8) return 3;
        return 4;
    }

    _drawWatchtowerFire(ctx, beacon, pulse) {
        const flicker = this.motionScale ? Math.sin(this.frame * 0.23) * 2.2 + Math.sin(this.frame * 0.41) * 1.1 : 0.8;
        const lean = this.motionScale ? Math.sin(this.frame * 0.13) * 2.6 : 1.2;
        const failed = this.harborStatus?.failedPushActive;
        const intensity = this._watchtowerIntensity();

        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(beacon.x, beacon.y, 1, beacon.x, beacon.y, 24 + pulse * 5 + intensity * 8);
        glow.addColorStop(0, failed ? 'rgba(255, 220, 170, 0.84)' : 'rgba(255, 236, 150, 0.78)');
        glow.addColorStop(0.36, failed ? 'rgba(255, 93, 67, 0.42)' : 'rgba(255, 142, 51, 0.34)');
        glow.addColorStop(1, failed ? 'rgba(255, 47, 39, 0)' : 'rgba(255, 91, 26, 0)');
        ctx.globalAlpha = 0.58 + pulse * 0.12 + intensity * 0.14;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(beacon.x, beacon.y, 24 + pulse * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.92;
        // Brazier bowl: a pixel pool with a rim, not an outlined vector ellipse.
        fillPixelEllipse(ctx, beacon.x, beacon.y + 7, 10, 4, '#6b351c');
        strokePixelEllipse(ctx, beacon.x, beacon.y + 7, 10, 4, '#2f1d12');

        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.92;
        // The beacon is the tallest, most-looked-at flame in the village; it was
        // two quadratic curves, which read as a smooth orange leaf.
        const beaconHeight = 20 + Math.abs(flicker) * 1.6;
        drawPixelFlame(ctx, beacon.x, beacon.y + 5, beaconHeight, 6, {
            outer: failed ? '#ff5d43' : '#ff7a2f',
            inner: failed ? '#ffd08b' : '#ffe68a',
            tip: failed ? '#ffe9c8' : '#fff3c4',
            lean,
            coreRatio: 0.55,
        });
    }

    _spawnEmittersFor(b, dt = 16) {
        const entry = this.assets.getEntry(`building.${b.type}`);
        if (!this.motionScale) return;
        const center = this._buildingScreenCenter(b);
        const entryId = entry?.id || `building.${b.type}`;
        const baseAnchor = this.assets.getAnchor(entryId);
        for (const [particleType, [lx, ly]] of Object.entries(entry?.emitters || {})) {
            const normalizedType = PARTICLE_ALIASES[particleType] || particleType;
            const at = b.type === 'watchtower' ? WATCHTOWER_LANTERN_FIRE.particle : [lx, ly];
            this._spawnBuildingParticle(normalizedType, center, baseAnchor, at, 0.035, 1, dt);
        }
        const presenceMult = PRESENCE_TIER_TABLE[this._presenceTierFor(b.type)].emitter;
        // Beacon breathing: emitter density rises with the global beacon
        // intensity so every building's fire/spark/mote flow quickens together as
        // night deepens. Held at the static-0.5 floor under reduced motion.
        const beaconMult = 0.72 + this._beaconScaleFor(b.type) * 0.5;
        // Door-region archiveMote emitters (at y≈128) burst more when read
        // intensity passes 0.6. Crest emitter (y≈82) is unaffected.
        const archiveReadIntensity = b.type === 'archive' ? (this._archiveReadIntensity || 0) : 0;
        // #33 — signed wind drift shared by the smoke-family emitters so the
        // forge chimney column, mine dust, and harbor steam all lean downwind
        // by the same amount.
        const windDrift = smokeWindDrift(this.atmosphereState);
        for (const emitter of BUILDING_EMITTER_FALLBACKS[b.type] || []) {
            let chanceBoost = b.type === 'forge'
                ? 0.7 + this._forgeGlowIntensity() * 1.1
                : this._visitorCountFor(b) > 0 ? 1.6 : 1;
            if (archiveReadIntensity > 0.6 && Array.isArray(emitter.at) && emitter.at[1] >= 120) {
                chanceBoost *= 1 + (archiveReadIntensity - 0.6) * 5;
            }
            const chance = emitter.chance * chanceBoost * presenceMult * beaconMult;
            const options = this._smokeEmitterOptions(b, emitter.type, windDrift);
            this._spawnBuildingParticle(emitter.type, center, baseAnchor, emitter.at, chance, emitter.count || 1, dt, options);
        }
    }

    // #33 — per-emitter spawn options for the volumetric smoke family. Returns
    // null for non-smoke emitters (unchanged behaviour). Smoke/dust/cookfire get
    // the shared wind drift; forge smoke additionally warms its palette and grows
    // its plume as `_forgeGlow` climbs so a hot hearth reads as a denser, browner
    // column. Wind also widens the spawn spread so a leaning column smears out.
    _smokeEmitterOptions(building, particleType, windDrift) {
        const isForgeSmoke = building.type === 'forge' && particleType === 'smoke';
        const isMineDust = building.type === 'mine' && particleType === 'mineDust';
        const isHarborSmoke = building.type === 'harbor' && particleType === 'smoke';
        if (!isForgeSmoke && !isMineDust && !isHarborSmoke) return null;

        const options = {};
        if (windDrift) options.windX = windDrift;
        const lean = Math.abs(windDrift);
        if (lean) options.spread = [2.4 + lean * 2.6, 2.4 + lean * 2.6];

        if (isForgeSmoke) {
            const heat = this._forgeGlowIntensity();
            // Banked-forge baseline grey blends toward ember-lit soot as the
            // hearth runs hot; a hot forge also pushes a bigger, taller plume.
            const warmth = clamp01((heat - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
            options.colors = SMOKE_COOL_COLORS.map((cool, i) => mixHex(cool, SMOKE_WARM_COLORS[i] || cool, warmth * 0.85));
            options.size = [3 + heat * 1.6, 6.5 + heat * 2.2];
        }
        return options;
    }

    _spawnBuildingParticle(type, center, baseAnchor, at, chance, count, dt = 16, options = null) {
        if (Math.random() > chanceForDt(chance, dt)) return;
        const [lx, ly] = at;
        const wx = center.x - baseAnchor[0] + lx;
        const wy = center.y - baseAnchor[1] + ly;
        if (options) this.particles.spawn(type, wx, wy, count, options);
        else this.particles.spawn(type, wx, wy, count);
    }

    _updateVisitorCounts() {
        this._visitorCountByType.clear();
        this._visitorStatusByType.clear();
        if (!this.agentSprites?.length) return;
        // Clear last frame's fold tags before re-tagging; IsometricRenderer
        // reads `_foldBuildingType` to suppress folded occupants' name pills.
        for (const sprite of this.agentSprites) sprite._foldBuildingType = null;
        if (!this.buildings.length) return;
        // #53 — per-building occupant repo tally, refilled in place each tick
        // and reduced below to the dominant repo per type.
        const repoTally = this._visitorRepoTally || (this._visitorRepoTally = new Map());
        for (const tally of repoTally.values()) tally.clear();

        for (const sprite of this.agentSprites) {
            const position = this._spriteTilePosition(sprite);
            if (!position) continue;
            const agentAtPosition = { ...sprite.agent, position };
            for (const building of this.buildings) {
                const isVisiting = typeof building.isAgentVisiting === 'function'
                    ? building.isAgentVisiting(agentAtPosition)
                    : building.containsPoint(position.tileX, position.tileY);
                if (!isVisiting) continue;
                this._visitorCountByType.set(building.type, (this._visitorCountByType.get(building.type) || 0) + 1);
                let tally = this._visitorStatusByType.get(building.type);
                if (!tally) {
                    tally = { working: 0, waiting_on_user: 0, errored: 0 };
                    this._visitorStatusByType.set(building.type, tally);
                }
                const status = sprite.agent?.status;
                if (lightsBuildingWindows(sprite.agent)) tally.working++;
                if (status === AgentStatus.WAITING_ON_USER) tally.waiting_on_user++;
                else if (status === AgentStatus.ERRORED) tally.errored++;
                const project = this._repoProjectKey(sprite.agent);
                if (project) {
                    let repos = repoTally.get(building.type);
                    if (!repos) {
                        repos = new Map();
                        repoTally.set(building.type, repos);
                    }
                    repos.set(project, (repos.get(project) || 0) + 1);
                }
                sprite._foldBuildingType = building.type;
            }
        }

        // Semantic occupants: agents routed to a building by the visit system
        // count toward its pennant even while they still walk there — physical
        // standers alone would leave the standards furled almost always.
        for (const sprite of this.agentSprites) {
            const targetType = String(sprite?.agent?.targetBuildingType || '').trim();
            if (!targetType) continue;
            const project = this._repoProjectKey(sprite.agent);
            if (!project) continue;
            let repos = repoTally.get(targetType);
            if (!repos) {
                repos = new Map();
                repoTally.set(targetType, repos);
            }
            repos.set(project, (repos.get(project) || 0) + 1);
        }

        this._visitorRepoByType.clear();
        for (const [type, repos] of repoTally) {
            let dominant = null;
            for (const [project, count] of repos) {
                if (!dominant || count > dominant.count) dominant = { project, count };
            }
            if (dominant) {
                this._visitorRepoByType.set(type, {
                    ...dominant,
                    profile: this._repoProfileFor(dominant.project),
                });
            }
        }
    }

    _updateNightLightGates(dt) {
        const types = new Set([
            ...this._visitorStatusByType.keys(),
            ...this._litGateByType.keys(),
        ]);
        for (const type of types) {
            const target = (this._visitorStatusByType.get(type)?.working || 0) > 0 ? 1 : 0;
            const current = this._litGateByType.get(type)?.value || 0;
            const value = advanceNightOccupancyGate(current, target, dt, this.motionScale);
            this._litGateByType.set(type, { value, target });
        }
    }

    _repoProjectKey(agent) {
        // Same fallback chain AgentSprite's repo tags use.
        return String(agent?.projectPath || agent?.project || agent?.teamName || agent?.provider || '').trim();
    }

    _repoProfileFor(project) {
        let profile = this._repoProfileCache.get(project);
        if (!profile) {
            if (this._repoProfileCache.size >= REPO_PROFILE_CACHE_LIMIT) this._repoProfileCache.clear();
            profile = repoProfile(project);
            this._repoProfileCache.set(project, profile);
        }
        return profile;
    }

    _visitorCountFor(building) {
        return this._visitorCountByType.get(building?.type) || 0;
    }

    _buildingCapacityForLabel(building) {
        const explicit = Number(building?.visitCapacity);
        if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
        const capacity = building?.capacity;
        if (capacity && typeof capacity === 'object') {
            const work = Number(capacity.work);
            if (Number.isFinite(work) && work > 0) return Math.max(1, Math.floor(work));
        }
        return Array.isArray(building?.visitTiles)
            ? Math.max(1, Math.min(6, building.visitTiles.filter((tile) => !tile.overflow || tile.role === 'work').length))
            : 0;
    }

    _buildingOccupancyInfo(building, { alert = false } = {}) {
        const presence = this._presenceByType.get(building?.type) || {};
        const count = Math.max(this._visitorCountFor(building), Number(presence.count) || 0);
        const capacity = this._buildingCapacityForLabel(building);
        const state = getBuildingOccupancyState(building?.type, { count, capacity, alert });
        return {
            count,
            capacity,
            state,
            ratio: capacity > 0 ? clamp01(count / capacity) : 0,
        };
    }

    _buildingActivityInfo(building, { alert = this._buildingAlertFor(building) } = {}) {
        const type = building?.type || '';
        const occupancy = this._buildingOccupancyInfo(building, { alert });
        const presence = this._presenceByType.get(type) || {};
        const recency = clamp01(presence.recencyScore || 0);
        let ritualFade = 0;
        for (const ritual of this._ritualsFor(type)) {
            ritualFade = Math.max(ritualFade, this._ritualFade(ritual));
        }

        const stateWeight = BUILDING_ACTIVITY_STATE_WEIGHT[occupancy.state] || 0;
        let intensity = Math.max(stateWeight, recency * 0.48, ritualFade * 0.9);

        if (type === 'forge') {
            const forgeHeat = clamp01((this._forgeGlowIntensity() - FORGE_GLOW_BASELINE) / (1 - FORGE_GLOW_BASELINE));
            intensity = Math.max(intensity, forgeHeat * 0.85);
        } else if (type === 'mine') {
            const quotaPressure = this._quotaFiveHourRatio();
            const pressureBoost = quotaPressure > 0.42 ? 0.22 + (quotaPressure - 0.42) * 1.05 : 0;
            intensity = Math.max(intensity, pressureBoost);
        } else if (type === 'archive') {
            intensity = Math.max(intensity, (this._archiveReadIntensity || 0) * 0.82);
        } else if (type === 'command') {
            intensity = Math.max(intensity, Math.min(0.82, this._watchtowerActiveCount() / 6 * 0.72));
        } else if (type === 'harbor') {
            const harborWork = Math.min(0.74, this._watchtowerActiveCount() / 6 * 0.56);
            intensity = Math.max(intensity, harborWork + (alert ? 0.24 : 0));
        } else if (type === 'watchtower') {
            intensity = Math.max(intensity, this._watchtowerIntensity());
        }

        return {
            alert,
            intensity: clamp01(intensity),
            occupancy,
            overload: occupancy.capacity > 0 ? Math.max(0, occupancy.count - occupancy.capacity) : 0,
            presence,
            recency,
            ritualFade,
        };
    }

    _occupancyAccent(baseAccent, state) {
        if (state === 'alert') return '#ff755d';
        if (state === 'full') return mixHex(brightenHex(baseAccent, 1.25, 1.18), '#ffcf6a', 0.42);
        if (state === 'busy') return brightenHex(baseAccent, 1.22, 1.2);
        if (state === 'occupied') return brightenHex(baseAccent, 1.08, 1.08);
        return baseAccent;
    }

    _pulseBandAlpha(visual, occupancy, baseAlpha) {
        const fallback = visual?.reducedMotionFallback || {};
        const pulse = this.motionScale
            // Exact legacy waveform: the working band is also 0.075 rad/frame;
            // cancel its authored phase so this migration does not retune it.
            ? pulseBand01Frame('working', this.frame, this.motionScale, -0.7)
            : Number.isFinite(fallback.pulse) ? fallback.pulse : 0.55;
        const band = visual?.pulseBand || {};
        const stateBoost = occupancy.state === 'full' || occupancy.state === 'alert'
            ? 0.22
            : occupancy.state === 'busy' ? 0.12 : 0;
        const alpha = Number.isFinite(band.alpha) ? band.alpha : 0.24;
        return Math.min(1, baseAlpha * (0.74 + alpha + pulse * 0.12 + stateBoost));
    }

    _drawCapacityMeter(ctx, { tagLeft, tagTop, tagW, tagH, padX, accent, occupancy, isHovered, isLandmark }) {
        if (!occupancy?.capacity || tagH < 18) return;
        const total = Math.max(1, Math.min(5, occupancy.capacity));
        const filled = Math.max(0, Math.min(total, Math.ceil(occupancy.ratio * total)));
        const pipW = isHovered ? 5 : 4;
        const pipH = isHovered ? 3 : 2;
        const gap = 2;
        const width = total * pipW + (total - 1) * gap;
        const x0 = Math.round(tagLeft + tagW - padX - width);
        const y0 = Math.round(tagTop + tagH - (isHovered ? 7 : 6));
        const emptyColor = isLandmark ? 'rgba(255, 225, 139, 0.18)' : 'rgba(215, 185, 121, 0.16)';
        const fillColor = occupancy.state === 'alert' ? '#ff755d' : accent;

        ctx.save();
        ctx.globalAlpha = isHovered ? 0.96 : 0.86;
        for (let i = 0; i < total; i++) {
            const x = x0 + i * (pipW + gap);
            ctx.fillStyle = i < filled ? fillColor : emptyColor;
            ctx.fillRect(x, y0, pipW, pipH);
        }
        if (occupancy.count > occupancy.capacity) {
            ctx.fillStyle = fillColor;
            ctx.fillRect(x0 + width + 2, y0, 2, pipH);
        }
        ctx.restore();
    }

    _activityPulseFor(building, visual = null) {
        const fallback = visual?.reducedMotionFallback || {};
        if (!this.motionScale) {
            return Number.isFinite(fallback.pulse) ? fallback.pulse : 0.55;
        }
        const seed = hashText(`${building?.type || 'building'}|${building?.position?.tileX ?? 0}|${building?.position?.tileY ?? 0}`);
        return (Math.sin(this.frame * 0.058 + seed * 0.013) + 1) / 2;
    }

    _drawBuildingActivityFootprint(ctx, building, { isLandmark = false, isHovered = false } = {}) {
        const info = this._buildingActivityInfo(building);
        if (info.intensity <= 0.12 && info.occupancy.state === 'idle' && !info.alert) return;

        const visual = getBuildingVisual(building.type);
        const band = visual?.pulseBand || {};
        const accent = info.alert
            ? '#ff755d'
            : (band.color || getBuildingLabelAccent(building.type, '#d6a951'));
        const pulse = this._activityPulseFor(building, visual);
        const c = this._buildingScreenCenter(building);
        const tileHalfW = (building.width + building.height) * TILE_WIDTH / 4;
        const tileHalfH = (building.width + building.height) * TILE_HEIGHT / 4;
        const ringCount = info.alert || info.intensity > 0.78 ? 2 : 1;
        const baseAlpha = Math.min(
            0.54,
            0.08 + info.intensity * 0.34 + (isHovered ? 0.06 : 0) + (isLandmark ? 0.03 : 0),
        );

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = accent;
        ctx.lineWidth = info.alert ? 2 : 1.25;
        for (let i = 0; i < ringCount; i++) {
            const phase = this.motionScale ? (pulse + i * 0.42) % 1 : 0.42 + i * 0.12;
            const grow = (info.alert ? 0.24 : 0.16) * phase + i * 0.08;
            ctx.globalAlpha = baseAlpha * (this.motionScale ? (1 - phase * 0.5) : (0.78 - i * 0.14));
            ctx.beginPath();
            ctx.ellipse(
                Math.round(c.x),
                Math.round(c.y + 4),
                tileHalfW * (1.04 + grow),
                Math.max(12, tileHalfH * (0.74 + grow * 0.45)),
                0,
                0,
                Math.PI * 2,
            );
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(0.5, 0.16 + info.intensity * 0.22 + (info.alert ? 0.08 : 0));
        ctx.strokeStyle = accent;
        ctx.lineWidth = info.alert ? 1.8 : 1.15;
        this._traceFootprint(ctx, this._buildingFootprintCorners(building));
        ctx.stroke();
        this._drawBuildingDaisRing(ctx, building, info, accent);
        ctx.restore();
    }

    // #57 — glowing dais ring (replaces the load-pip diamond row): the front
    // arc of the footprint ellipse is an intensity gauge — a dim track plus a
    // lit arc whose sweep encodes activity intensity, over a soft ground glow,
    // so occupancy reads from across the map. Governor-admitted (SECONDARY arc,
    // AMBIENT glow; banners/halos are that tier's examples). Reduced motion:
    // static arc and glow, same semantics, no breathing.
    _drawBuildingDaisRing(ctx, building, info, accent) {
        const occupancy = info.occupancy || {};
        const signal = Math.max(occupancy.ratio || 0, info.intensity, info.ritualFade || 0);
        if (signal <= 0.16 && !info.alert) return;

        const corners = this._buildingFootprintCorners(building);
        const cx = Math.round((corners.nw.x + corners.se.x) / 2);
        const cy = Math.round((corners.nw.y + corners.se.y) / 2 + 4);
        const rx = Math.max(18, Math.abs(corners.se.x - corners.nw.x) / 2 + 10);
        const ry = Math.max(10, Math.abs(corners.se.y - corners.nw.y) / 2 + 6);
        const fill = info.alert ? 1 : clamp01((signal - 0.16) / 0.84);
        const pulse = this._activityPulseFor(building, getBuildingVisual(building.type));
        // Canvas ellipse angles: 0 = east, π/2 = south (screen-down). The dais
        // spans the front (south) face; the lit arc fills east→west through it.
        const start = Math.PI * 0.08;
        const end = Math.PI * 0.92;
        const sweep = start + (end - start) * fill;

        const governor = getActiveMarkGovernor();
        const glowGate = governor?.admit(MarkTier.AMBIENT, cx, cy) || null;
        const arcGate = governor?.admit(MarkTier.SECONDARY, cx, cy) || null;

        ctx.save();
        if (!glowGate || glowGate.draw) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = (0.10 + fill * 0.13 + (this.motionScale ? pulse * 0.05 : 0.03)) * (glowGate?.alpha ?? 1);
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx * 0.94, ry * 0.9, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        if (!arcGate || arcGate.draw) {
            const gateAlpha = arcGate?.alpha ?? 1;
            ctx.globalCompositeOperation = 'source-over';
            // Dim full-track, then the lit intensity arc with a bright end gem.
            ctx.globalAlpha = 0.2 * gateAlpha;
            ctx.strokeStyle = accent;
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, start, end);
            ctx.stroke();
            ctx.globalAlpha = Math.min(0.9, 0.4 + fill * 0.38 + (this.motionScale ? pulse * 0.12 : 0.06)) * gateAlpha;
            ctx.lineWidth = info.alert ? 3 : 2.4;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, start, sweep);
            ctx.stroke();
            if (fill > 0.05) {
                const gemX = Math.round(cx + Math.cos(sweep) * rx);
                const gemY = Math.round(cy + Math.sin(sweep) * ry);
                ctx.globalAlpha = 0.9 * gateAlpha;
                ctx.fillStyle = '#fff3cf';
                ctx.fillRect(gemX - 1, gemY - 1, 2, 2);
            }
        }

        // Overload / full / alert chevrons (kept from the pips row).
        if (info.overload > 0 || info.alert || occupancy.state === 'full') {
            const edgeX = Math.round(lerp(corners.sw.x, corners.se.x, 0.82));
            const edgeY = Math.round(lerp(corners.sw.y, corners.se.y, 0.82) + 7);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = info.alert ? 0.95 : 0.76;
            ctx.strokeStyle = info.alert ? '#ff755d' : accent;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(edgeX - 5, edgeY + 3);
            ctx.lineTo(edgeX, edgeY - 2);
            ctx.lineTo(edgeX + 5, edgeY + 3);
            ctx.moveTo(edgeX - 5, edgeY + 8);
            ctx.lineTo(edgeX, edgeY + 3);
            ctx.lineTo(edgeX + 5, edgeY + 8);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawActivityDiamond(ctx, x, y, radius, fillStyle, strokeStyle = null) {
        ctx.fillStyle = fillStyle;
        if (strokeStyle) ctx.strokeStyle = strokeStyle;
        ctx.beginPath();
        ctx.moveTo(x, y - radius);
        ctx.lineTo(x + radius, y);
        ctx.lineTo(x, y + radius);
        ctx.lineTo(x - radius, y);
        ctx.closePath();
        ctx.fill();
        if (strokeStyle) ctx.stroke();
    }

    groundingDiagnostics() {
        return this.buildings.map((building) => {
            const id = `building.${building.type}`;
            const entry = this.assets.getEntry(id);
            const dims = this.assets.getDims(id);
            const anchor = this.assets.getAnchor(id);
            const center = this._buildingScreenCenter(building);
            const grounding = getBuildingVisual(building.type)?.grounding || null;
            const left = dims ? center.x - anchor[0] : center.x;
            const top = dims ? center.y - anchor[1] : center.y;
            return {
                type: building.type,
                mode: grounding?.mode || null,
                center: { ...center },
                footprint: this._buildingFootprintCorners(building),
                entrance: building.entrance ? this._tileToScreen(building.entrance.tileX, building.entrance.tileY) : null,
                sprite: dims ? { left, top, width: dims.w, height: dims.h } : null,
                anchor: { x: center.x, y: center.y, localX: anchor[0], localY: anchor[1] },
                horizonY: Number.isFinite(entry?.horizonY) ? top + entry.horizonY : null,
                contact: grounding?.contact ? {
                    x: center.x + (grounding.contact.offsetX || 0),
                    y: center.y + (grounding.contact.offsetY || 0),
                    width: grounding.contact.width || 0,
                    depth: grounding.contact.depth || 0,
                } : null,
            };
        });
    }

    drawGroundingDebug(ctx) {
        ctx.save();
        ctx.font = `10px ${WORLD_BODY_FONT}`;
        ctx.textBaseline = 'bottom';
        for (const item of this.groundingDiagnostics()) {
            const { center, footprint, entrance, sprite, contact } = item;
            ctx.globalAlpha = 0.94;
            ctx.strokeStyle = '#00e5ff';
            ctx.lineWidth = 1.4;
            this._traceFootprint(ctx, footprint);
            ctx.stroke();

            if (sprite) {
                ctx.globalAlpha = 0.72;
                ctx.strokeStyle = '#ec6cff';
                ctx.lineWidth = 1;
                ctx.strokeRect(sprite.left + 0.5, sprite.top + 0.5, sprite.width - 1, sprite.height - 1);
            }
            if (Number.isFinite(item.horizonY) && sprite) {
                ctx.strokeStyle = '#ffe066';
                ctx.beginPath();
                ctx.moveTo(sprite.left, item.horizonY + 0.5);
                ctx.lineTo(sprite.left + sprite.width, item.horizonY + 0.5);
                ctx.stroke();
            }
            if (contact?.width > 0 && contact?.depth > 0) {
                ctx.strokeStyle = '#ff6e5f';
                ctx.beginPath();
                ctx.ellipse(contact.x, contact.y, contact.width / 2, contact.depth / 2, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(Math.round(center.x) - 3, Math.round(center.y), 7, 1);
            ctx.fillRect(Math.round(center.x), Math.round(center.y) - 3, 1, 7);
            if (entrance) {
                ctx.fillStyle = '#7cff6b';
                ctx.fillRect(Math.round(entrance.x) - 3, Math.round(entrance.y) - 3, 6, 6);
                ctx.strokeStyle = 'rgba(124, 255, 107, 0.72)';
                ctx.beginPath();
                ctx.moveTo(entrance.x, entrance.y);
                ctx.lineTo(center.x, center.y);
                ctx.stroke();
            }
            const labelX = sprite?.left ?? center.x;
            const labelY = sprite?.top ?? center.y;
            const label = `${item.type} · ${item.mode || 'missing'}`;
            const width = ctx.measureText(label).width + 6;
            ctx.fillStyle = 'rgba(18, 22, 29, 0.88)';
            ctx.fillRect(labelX, labelY - 14, width, 13);
            ctx.fillStyle = '#d8f7ff';
            ctx.fillText(label, labelX + 3, labelY - 3);
        }
        ctx.restore();
    }

    _buildingFootprintCorners(building) {
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const x1 = x0 + building.width;
        const y1 = y0 + building.height;
        return {
            nw: this._tileToScreen(x0, y0),
            ne: this._tileToScreen(x1, y0),
            se: this._tileToScreen(x1, y1),
            sw: this._tileToScreen(x0, y1),
        };
    }

    _traceFootprint(ctx, corners) {
        ctx.beginPath();
        ctx.moveTo(corners.nw.x, corners.nw.y);
        ctx.lineTo(corners.ne.x, corners.ne.y);
        ctx.lineTo(corners.se.x, corners.se.y);
        ctx.lineTo(corners.sw.x, corners.sw.y);
        ctx.closePath();
    }

    _buildingFrontSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? Math.max(fallbackY, anchorY - 0.5) : fallbackY;
    }

    _buildingWholeSortY(building, fallbackY) {
        const anchorY = this._anchorSortY(building);
        return Number.isFinite(anchorY) ? anchorY - 0.5 : fallbackY;
    }

    // Depth anchor for building drawables. The minimum visit-tile screen-y
    // ensures every declared visit tile draws in front; clamping by the
    // southeast footprint corner restores standard isometric occlusion when
    // visit tiles sit south of the corner (mine, taskboard, portal, etc.) so
    // characters at the SE edge are no longer covered by the building.
    _anchorSortY(building) {
        const tiles = Array.isArray(building?.visitTiles) ? building.visitTiles : [];
        let minY = Infinity;
        for (const tile of tiles) {
            if (!Number.isFinite(tile?.tileX) || !Number.isFinite(tile?.tileY)) continue;
            const y = this._tileToScreen(tile.tileX, tile.tileY).y;
            if (y < minY) minY = y;
        }
        if (!Number.isFinite(minY) && building?.entrance) {
            const { tileX, tileY } = building.entrance;
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                minY = this._tileToScreen(tileX, tileY).y;
            }
        }
        if (!Number.isFinite(minY)) return null;
        const pos = building?.position;
        if (pos
            && Number.isFinite(pos.tileX)
            && Number.isFinite(pos.tileY)
            && Number.isFinite(building.width)
            && Number.isFinite(building.height)) {
            const seX = pos.tileX + building.width - 1;
            const seY = pos.tileY + building.height - 1;
            return Math.min(minY, this._tileToScreen(seX, seY).y);
        }
        return minY;
    }

    _tileToScreen(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _buildingScreenCenter(b) {
        return buildingCenterToWorld(b);
    }

    _harborLedgerRows(repos = []) {
        const active = (Array.isArray(repos) ? repos : [])
            .filter((repo) => Number(repo?.pendingCommits) > 0)
            .sort((a, b) => (Number(b.pendingCommits) - Number(a.pendingCommits))
                || String(a.repoName || a.shortName || '').localeCompare(String(b.repoName || b.shortName || '')));
        if (!active.length) return [];
        const visible = active.slice(0, 3).map((repo) => {
            const name = String(repo.shortName || repo.repoName || repo.project || 'Repo')
                .replace(/[-_]+/g, ' ')
                .replace(/\b\w/g, (char) => char.toUpperCase());
            return {
                label: `${name} (${Number(repo.pendingCommits)})`,
                color: repo.profile?.labelText || repo.profile?.accent || '#f6d384',
                profile: repo.profile || null,
            };
        });
        const remaining = active.length - visible.length;
        if (remaining > 0 && visible.length) {
            visible[visible.length - 1] = {
                ...visible[visible.length - 1],
                label: `${visible[visible.length - 1].label} +${remaining}`,
            };
        }
        return visible;
    }

    _applyReadableLabelShadow(ctx) {
        ctx.shadowColor = 'rgba(8, 5, 4, 0.88)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    _drawRepoRowIcon(ctx, x, y, profile = null) {
        const accent = profile?.accent || '#f6d384';
        ctx.save();
        this._applyReadableLabelShadow(ctx);
        ctx.fillStyle = accent;
        ctx.strokeStyle = 'rgba(255, 238, 180, 0.86)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + 3, y);
        ctx.lineTo(x, y + 3);
        ctx.lineTo(x - 3, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    _drawLabelEmblem(ctx, building, cx, cy, size, { accent, isHovered, isLandmark } = {}) {
        const r = size / 2;
        const emblem = getBuildingLabelEmblem(building.type, 'mark');
        ctx.save();
        ctx.fillStyle = isHovered ? 'rgba(255, 230, 148, 0.98)' : isLandmark ? accent : 'rgba(214, 169, 81, 0.82)';
        ctx.strokeStyle = 'rgba(43, 28, 17, 0.88)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * 0.78, cy - r * 0.52);
        ctx.lineTo(cx + r * 0.66, cy + r * 0.45);
        ctx.lineTo(cx, cy + r * 0.9);
        ctx.lineTo(cx - r * 0.66, cy + r * 0.45);
        ctx.lineTo(cx - r * 0.78, cy - r * 0.52);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#2a1c11';
        ctx.fillStyle = '#2a1c11';
        ctx.lineWidth = Math.max(1.2, size * 0.09);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const drawLine = (...points) => {
            ctx.beginPath();
            points.forEach((point, index) => {
                if (index === 0) ctx.moveTo(cx + point[0] * r, cy + point[1] * r);
                else ctx.lineTo(cx + point[0] * r, cy + point[1] * r);
            });
            ctx.stroke();
        };

        if (emblem === 'anchor') {
            drawLine([0, -0.55], [0, 0.42]);
            drawLine([-0.32, -0.2], [0.32, -0.2]);
            ctx.beginPath();
            ctx.arc(cx, cy - r * 0.62, r * 0.16, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy + r * 0.18, r * 0.42, 0.18 * Math.PI, 0.82 * Math.PI);
            ctx.stroke();
            drawLine([-0.45, 0.15], [-0.62, 0.02]);
            drawLine([0.45, 0.15], [0.62, 0.02]);
        } else if (emblem === 'book') {
            ctx.strokeRect(cx - r * 0.5, cy - r * 0.45, r * 0.43, r * 0.8);
            ctx.strokeRect(cx + r * 0.07, cy - r * 0.45, r * 0.43, r * 0.8);
            drawLine([0, -0.43], [0, 0.42]);
            drawLine([-0.36, -0.16], [-0.16, -0.16]);
            drawLine([0.17, -0.16], [0.36, -0.16]);
        } else if (emblem === 'hammer') {
            drawLine([-0.38, 0.42], [0.34, -0.3]);
            drawLine([0.08, -0.55], [0.55, -0.08]);
            drawLine([0.23, -0.66], [0.66, -0.23]);
        } else if (emblem === 'crown') {
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.52, cy + r * 0.18);
            ctx.lineTo(cx - r * 0.38, cy - r * 0.36);
            ctx.lineTo(cx - r * 0.08, cy + r * 0.02);
            ctx.lineTo(cx + r * 0.2, cy - r * 0.45);
            ctx.lineTo(cx + r * 0.48, cy + r * 0.18);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            drawLine([-0.45, 0.36], [0.48, 0.36]);
        } else if (emblem === 'star') {
            drawLine([0, -0.58], [0.12, -0.12], [0.58, -0.08], [0.2, 0.16], [0.32, 0.58], [0, 0.28], [-0.32, 0.58], [-0.2, 0.16], [-0.58, -0.08], [-0.12, -0.12], [0, -0.58]);
        } else if (emblem === 'rune') {
            drawLine([0, -0.58], [0.46, 0], [0, 0.58], [-0.46, 0], [0, -0.58]);
            drawLine([-0.2, 0], [0.2, 0]);
        } else if (emblem === 'pick') {
            drawLine([-0.32, 0.5], [0.32, -0.42]);
            drawLine([-0.48, -0.3], [-0.04, -0.52], [0.5, -0.34]);
        } else if (emblem === 'scroll') {
            ctx.strokeRect(cx - r * 0.42, cy - r * 0.38, r * 0.84, r * 0.62);
            ctx.beginPath();
            ctx.arc(cx - r * 0.43, cy - r * 0.07, r * 0.16, Math.PI * 0.5, Math.PI * 1.5);
            ctx.stroke();
            drawLine([-0.22, -0.15], [0.28, -0.15]);
            drawLine([-0.22, 0.08], [0.18, 0.08]);
        } else if (emblem === 'flame') {
            ctx.beginPath();
            ctx.moveTo(cx, cy - r * 0.56);
            ctx.bezierCurveTo(cx + r * 0.48, cy - r * 0.05, cx + r * 0.22, cy + r * 0.5, cx, cy + r * 0.52);
            ctx.bezierCurveTo(cx - r * 0.42, cy + r * 0.25, cx - r * 0.24, cy - r * 0.16, cx, cy - r * 0.56);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.font = `bold ${Math.max(7, Math.round(size * 0.42))}px "Press Start 2P", monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(building.icon || '?', cx, cy + 0.5);
        }
        ctx.restore();
    }

    _labelTextFor(building, zoom, isHovered) {
        const label = this._resolveBuildingLabelText(building);
        if (zoom >= LABEL_DETAIL_ZOOM) return label;
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short;
        const words = label.split(/\s+/).filter(Boolean);
        if (words.length === 1) return label;
        if (words.length === 2) return words.join(' ');
        return `${words[0]} ${words[1]}`;
    }

    _resolveBuildingLabelText(building) {
        const explicit = String(building.label || '').trim();
        if (explicit) return explicit.toUpperCase();
        const short = LABEL_SHORT_TEXT[building.type];
        if (short) return short.toUpperCase();
        if (!building.type) return '';
        const tokenized = String(building.type).replace(/[_-]/g, ' ');
        return tokenized
            .split(/\s+/)
            .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    _labelMetrics(ctx, building, {
        text,
        labelFont,
        maxTextWidth,
        zoom,
        isHovered,
        isLandmark,
        scaleMode = 'screen-fixed',
    }) {
        const zoomBucket = zoom >= LABEL_DETAIL_ZOOM ? 'detail' : zoom >= LABEL_VISIBLE_ZOOM ? 'mid' : 'far';
        const key = `${building.type}|${text}|${labelFont}|${maxTextWidth}|${zoomBucket}|${scaleMode}|${isHovered ? 1 : 0}|${isLandmark ? 1 : 0}`;
        const cached = this._labelMetricsCache.get(key);
        if (cached) return cached;

        let displayText = text;
        if (ctx.measureText(displayText).width > maxTextWidth) {
            while (displayText.length > 1 && ctx.measureText(`${displayText}…`).width > maxTextWidth) {
                displayText = displayText.slice(0, -1);
            }
            if (displayText.length < text.length) {
                displayText = `${displayText}…`;
            }
        }
        const metrics = {
            displayText,
            width: ctx.measureText(displayText).width,
        };
        this._labelMetricsCache.set(key, metrics);
        return metrics;
    }

    _boxesOverlap(a, b) {
        return a.left < b.right
            && a.right > b.left
            && a.top < b.bottom
            && a.bottom > b.top;
    }

    _boxesOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let overlapArea = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            overlapArea += overlapWidth * overlapHeight;
        }

        return Math.min(1, overlapArea / boxArea);
    }

    _boxesMaxOverlapRatio(box, boxes) {
        if (!boxes || boxes.length === 0) return 0;
        const boxArea = Math.max(0, (box.right - box.left) * (box.bottom - box.top));
        if (boxArea === 0) return 0;

        let maxOverlap = 0;
        for (const other of boxes) {
            const overlapLeft = Math.max(box.left, other.left);
            const overlapTop = Math.max(box.top, other.top);
            const overlapRight = Math.min(box.right, other.right);
            const overlapBottom = Math.min(box.bottom, other.bottom);
            const overlapWidth = overlapRight - overlapLeft;
            const overlapHeight = overlapBottom - overlapTop;
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            maxOverlap = Math.max(maxOverlap, (overlapWidth * overlapHeight) / boxArea);
        }

        return Math.min(1, maxOverlap);
    }

    _estimateLocalLabelDensity(occupiedBoxes, centerX, centerY) {
        if (!occupiedBoxes.length) return 0;
        const radius = 95;
        const radiusSq = radius * radius;
        let nearby = 0;

        for (const box of occupiedBoxes) {
            const cx = (box.left + box.right) / 2;
            const cy = (box.top + box.bottom) / 2;
            const dx = cx - centerX;
            const dy = cy - centerY;
            if (dx * dx + dy * dy <= radiusSq) {
                nearby++;
            }
        }

        return nearby;
    }
}
