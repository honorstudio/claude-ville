import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { INCIDENT_COLORS_RGB, THEME, WORLD_BODY_FONT } from '../../config/theme.js';
import { AUTHORED_KEY_LIGHT } from './MaterialRegistry.js';

import { drawPixelFlame, fillPixelEllipse, fillTileDiamond } from './PixelShapes.js';
import { normalizeBuildingType } from '../../config/buildings.js';
import { PORTAL_SPAWN_TILE, TOWN_ROAD_ROUTES, VILLAGE_GATE, VILLAGE_GATE_BOUNDS, VILLAGE_WALL_ROUTES } from '../../config/townPlan.js';
import {
    AMBIENT_GROUND_PROPS,
    AMBIENT_SCENIC_POINTS,
    ANCIENT_RUINS,
    DISTRICT_PROPS,
    DISTRICT_WASHES,
    FOREST_FLOOR_REGIONS,
    SCENIC_POINT_PROPS,
    TROPICAL_BROADLEAF_TREES,
    TROPICAL_PALMS,
    TROPICAL_WATERFALLS,
    WATCHTOWER_BEACON_BUOY_TILES,
} from '../../config/scenery.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { Camera } from './Camera.js';
import { createMotionClock, advanceMotionClock, virtualFramesFor } from './MotionClock.js';
import {
    createFrameEnvelope,
    recordFrameEnvelope,
    enableFrameEnvelopeRings,
    snapshotFrameEnvelope,
    getClientPerfMetrics,
    percentileAtSnapshot,
} from '../shared/ClientPerfMetrics.js';
import { CameraDirector } from './CameraDirector.js';
import { ParticleSystem, WAKE_FOAM_COLORS } from './ParticleSystem.js';
import { AgentSprite, drawFamiliarMotes, familiarMoteLightSources } from './AgentSprite.js';
import { BuildingSprite } from './BuildingSprite.js';

import { SceneryEngine } from './SceneryEngine.js';
import { Pathfinder } from './Pathfinder.js';
import { constrainSteeringToTarget, laneAxisForBridgeOrientation } from './MovementSteering.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { SkyRenderer } from './SkyRenderer.js';
import { AtmosphereState } from './AtmosphereState.js';
import { WeatherRenderer } from './WeatherRenderer.js';
import { WildlifeRenderer } from './WildlifeRenderer.js';
import { FoliageRenderer } from './FoliageRenderer.js';
import { SeasonalAmbience, seasonTokenForAtmosphere } from './SeasonalAmbience.js';
import { TerrainTileset } from './TerrainTileset.js';
import { Compositor } from './Compositor.js';
import { HarborTraffic } from './HarborTraffic.js';
import { BridgeLanterns } from './BridgeLanterns.js';
import { LandmarkActivity } from './LandmarkActivity.js';
import { AgentEventStream } from './AgentEventStream.js';
import { RelationshipState } from './RelationshipState.js';
import { RitualConductor } from './RitualConductor.js';
import { VisitIntentManager } from './VisitIntentManager.js';
import VisitTileAllocator from './VisitTileAllocator.js';
import { getPulsePriority, pulseValue } from './PulsePolicy.js';
import { annotationModeForPressure, calculateScenePressure, getActiveMarkGovernor, MarkGovernor, setActiveMarkGovernor } from './MarkGovernor.js';
import { lightSourceCacheKey, normalizeLightSource } from './LightSourceRegistry.js';
import {
    applyTeamPlazaPreferences,
    getCouncilRingDiagnostics,
    releaseCouncilRingState,
    relationshipLightSources,
} from './CouncilRing.js';
import { ArrivalDepartureController } from './ArrivalDeparture.js';
import { extractRecipientName } from '../../domain/services/RecipientResolver.js';
import { bucketCounts, buckets as signalBuckets } from '../../domain/services/SignalLedger.js';
import { BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { ChronicleMonuments } from './ChronicleMonuments.js';
import { TrailRenderer } from './TrailRenderer.js';
import { Chronicler } from './Chronicler.js';
import { VillageDirector } from './VillageDirector.js';
import { tileToWorld, worldToTile, buildingCenterToWorld } from './Projection.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';
import { buildStaticPropDrawables } from './StaticPropDrawables.js';
import { createDepthDrawable, propDepthDrawable } from './DrawablePass.js';
import {
    renderWorldFrame,
    collectDampMarks,
    isoFromTileKey,
    isoFromTile,
} from './WorldFrameRenderer.js';
import { createPostFx } from './postfx/PostFx.js';
import { createPostFxFeed } from './postfx/PostFxFeed.js';
import { createGpuWorldRenderer } from './gpu/GpuWorldRenderer.js';
import {
    GPU_ATTENTION_LIGHT_PRIORITY,
    localLightPhaseForLighting,
    resolveGpuWorldRendererMode,
    WORLD_PHASE_GRADES,
} from './gpu/GpuWorldPolicy.js';
import {
    CANVAS_BUDGET,
    canvasMapPixelCount,
    canvasPixelCount,
    gpuResourceAccounting,
    releaseCanvasBackingStore,
    releaseCanvasMap,
    unifiedRendererResourceAccounting,
} from './CanvasBudget.js';

const WATER_FRAME_STEP = 0.03;
const STATIC_WATER_SHIMMER = 0.08;
// B1 — river-flow streak cadence: fraction of a full along-tile travel cycle
// advanced per unit of `waterFrame` (~1.8/s at 60fps → ~1.1s per streak pass).
const RIVER_FLOW_SPEED = 0.5;
// Staggered foam-line bands for the animated coastline surf wash (item #23).
// Band 0 is the innermost crest (also the reduced-motion static line); outer
// bands sit further into the water with lower base alpha and offset phases so
// crests roll rather than pulse in unison.
const SURF_WASH_BANDS = Object.freeze([
    { inset: 4, alpha: 0.16, width: 1.2, phase: 0, seedFloor: 0 },
    { inset: 9, alpha: 0.11, width: 1.0, phase: 9, seedFloor: 0.22 },
    { inset: 14, alpha: 0.08, width: 1.0, phase: 18, seedFloor: 0.48 },
]);
const CURRENT_WAVE_SCREEN_X = (0.42 - (-0.28)) * TILE_WIDTH / 2;
const CURRENT_WAVE_SCREEN_Y = (0.42 + (-0.28)) * TILE_HEIGHT / 2;
const CURRENT_WAVE_SCREEN_LENGTH = Math.hypot(CURRENT_WAVE_SCREEN_X, CURRENT_WAVE_SCREEN_Y) || 1;
const CURRENT_WAVE_UNIT_X = CURRENT_WAVE_SCREEN_X / CURRENT_WAVE_SCREEN_LENGTH;
const CURRENT_WAVE_UNIT_Y = CURRENT_WAVE_SCREEN_Y / CURRENT_WAVE_SCREEN_LENGTH;
const LIGHT_FADE_COLOR_CACHE_LIMIT = 1024;
const LIGHT_COLOR_RGB_CACHE_LIMIT = 256;
const LIGHT_COLOR_QUANTIZATION_STEPS = 32;
const LIGHT_COLOR_MIX_STEPS = 16;
const NICKNAME_CACHE_LIMIT = 256;
const WORLD_FRAME_ERROR_REPORT_INTERVAL_MS = 5000;
const WORLD_FRAME_MAX_CONSECUTIVE_FAILURES = 3;
const DEBUG_GLOBAL_OWNERS = new WeakMap();
const MAX_LIGHT_GRADIENT_CACHE_PIXELS = CANVAS_BUDGET.maxLightCachePixels;
const MAX_LIGHT_GRADIENT_STAMP_PIXELS = Math.floor(MAX_LIGHT_GRADIENT_CACHE_PIXELS / 5);
// Viewport-size gates for the cheap sky/atmosphere/prop paths. CSS pixels, not
// backing pixels: a sharper display is not a bigger scene.
const FAST_ATMOSPHERE_CSS_PIXELS = 800_000;
const FAST_PROP_CSS_PIXELS = 800_000;
const FAST_PROP_MIN_ZOOM = 1.5;
const FAST_PROP_AGENT_MARGIN = 36;
const FAST_PROP_SCREEN_MARGIN = 96;
// Covers the tallest selected bubble stack plus the sprite body. Agents beyond
// this screen-space apron cannot contribute pixels to the viewport.
const AGENT_SCREEN_CULL_MARGIN = 420;
const AGENT_OVERLAY_GRID_CELL = 96;
const ATTENTION_LIGHT_STYLES = Object.freeze({
    needsYou: Object.freeze({ color: THEME.waitingOnUser, radius: 88, intensity: 2.15 }),
    errors: Object.freeze({ color: THEME.error, radius: 78, intensity: 1.55 }),
    quota: Object.freeze({ color: `rgb(${INCIDENT_COLORS_RGB.quota})`, radius: 68, intensity: 0.85 }),
});
const TERRAIN_CACHE_MARGIN = 360;
const TERRAIN_CACHE_CHUNK_SIZE = 16;
const TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS = CANVAS_BUDGET.maxWorldCachePixels;
const ACTIVE_BUILDING_EMITTER_GATE = 'active-building-agents';
const WORLD_EDGE_PAD_X = TILE_WIDTH / 2;
const WORLD_EDGE_PAD_Y = TILE_HEIGHT / 2;
const KEYBOARD_PAN_STEP = 90;
const LANE_STEERING = Object.freeze({
    correctionPx: 0.55,
    denseCorrectionPx: 0.42,
    arrivalDistancePx: 18,
    minimumCorrectionPx: 0.18,
    avenueOffsetPx: 4.4,
    dirtOffsetPx: 3.4,
    plazaOffsetPx: 2.2,
});
const LOCAL_AVOIDANCE = Object.freeze({
    radiusPx: 28,
    denseRadiusPx: 26,
    strengthPx: 0.8,
    denseStrengthPx: 0.62,
    bucketPx: 40,
});

function phaseGradeForCanvas(phase = 'day') {
    return WORLD_PHASE_GRADES[phase] || WORLD_PHASE_GRADES.day;
}

function gradeColorForCanvas(channels = []) {
    return `rgb(${channels.map(channel => Math.round(channel * 255)).join(', ')})`;
}
// Scene-complexity gates: how many sprites and labels compete for screen area
// is a CSS-space property. They must never read backing pixels — a Retina
// canvas has 4x as many for the same scene, which would strip annotations off
// the world purely because the display is sharp.
const AGENT_RENDER_COMPACT_COUNT = 80;
const AGENT_RENDER_COMPACT_ZOOM = 2.2;
const AGENT_RENDER_COMPACT_CSS_PIXELS = 1_450_000;
const AGENT_RENDER_MINIMAL_COUNT = 96;
const AGENT_RENDER_MINIMAL_CSS_PIXELS = 1_700_000;
const CROWD_CLUSTER_TILE_SIZE = 4;
const CROWD_CLUSTER_TOP_LIMIT = 12;
const CROWD_BUMP_COOLDOWN_LIMIT = 512;

// Body LOD for villager sprites (AgentSprite's 28px compact silhouette). Gated
// on population and CSS viewport only; never on frame-to-frame scene pressure.
function agentBodyRenderMode(count, viewport, zoom) {
    if (count < 50) return 'full';
    const cssPixels = Math.max(0, (viewport?.width || 0) * (viewport?.height || 0));
    if (count >= AGENT_RENDER_MINIMAL_COUNT && cssPixels >= AGENT_RENDER_MINIMAL_CSS_PIXELS) {
        return 'minimal';
    }
    if (
        count >= AGENT_RENDER_COMPACT_COUNT &&
        (zoom <= AGENT_RENDER_COMPACT_ZOOM || cssPixels >= AGENT_RENDER_COMPACT_CSS_PIXELS)
    ) {
        return 'compact';
    }
    return 'full';
}
const AGENT_NAME_TAG_MAX_WIDTH = 152;
const AGENT_NAME_TAG_MIN_WIDTH = 40;
// Must track the real name-tag pill in AgentSprite._drawNameTag: Departure Mono
// at NAME_TAG_FONT_PX (11) is ~7px/char monospace, and NAME_TAG_PADDING_X is 20.
// The old 4.5/9 estimate was ~60% of the real width, so the de-overlap rects
// were too narrow and horizontally-close name tags collided on the same slot.
const AGENT_NAME_TAG_CHAR_WIDTH = 7;
const AGENT_NAME_TAG_PADDING_X = 20;
const AGENT_NAME_TAG_SINGLE_HEIGHT = 16;
const AGENT_NAME_TAG_DOUBLE_HEIGHT = 23;
const AGENT_COMPACT_NAME_MAX_WIDTH = 180;
const AGENT_COMPACT_NAME_MIN_WIDTH = 54;
const AGENT_COMPACT_NAME_CHAR_WIDTH = 5.5;
const AGENT_COMPACT_NAME_EXTRA_WIDTH = 38;
const AGENT_COMPACT_NAME_HEIGHT = 17;
const AGENT_COMPACT_NAME_SLOT_BASE_Y = 22;
const AGENT_COMPACT_NAME_SLOT_STEP_Y = 12;
// 3.4 — cell size (world px) for the static prop footprint index that keeps
// name-tag de-collision slots from landing on prop art.
const NAME_SLOT_PROP_CELL = 96;
// Full-mode speech/status bubble de-collision. Bubbles are drawn per sprite at
// a fixed head offset, so clustered agents pile unreadably; these drive the
// rect-overlap slot search that stacks bubbles and caps how many render.
const AGENT_BUBBLE_SLOT_CAP = 3;
// Floor for the reservation estimate (short status labels).
const AGENT_BUBBLE_EST_WIDTH = 104;
// Departure Mono advance at the anchored 10px body size, plus bubble padding.
// Measured against the sprite's own layout, not guessed: AgentSprite adds 18px
// of horizontal padding around the measured text at this size.
const AGENT_BUBBLE_CHAR_WIDTH = 5.4;
const AGENT_BUBBLE_PADDING = 18;
// Mirrors STATUS_BUBBLE_MAIN_MAX_WIDTH.anchored in AgentSprite.js, which is
// where the text is actually truncated to fit.
const AGENT_BUBBLE_MAX_WIDTH = 232;
const AGENT_BUBBLE_HEIGHT = 22;
const AGENT_BUBBLE_ANCHOR_Y = 58;
// Vertical step per stacked slot, in screen pixels; must match AgentSprite
// STATUS_BUBBLE_STACK_STEP so assigned slots line up with the drawn offset.
const AGENT_BUBBLE_STACK_STEP = 24;
const WATER_TOKENS = {
    lagoon: {
        shallow: 'rgb(10,180,190)',
        deep: 'rgb(22,152,160)',
        glint: '120, 230, 200',
        rainRipple: '210, 255, 242',
        fogWash: '205, 238, 228',
        wake: '206, 252, 236',
    },
    river: {
        shallow: 'rgb(12,136,166)',
        deep: 'rgb(8,92,126)',
        glint: '150, 226, 236',
        rainRipple: '202, 242, 250',
        fogWash: '202, 232, 232',
        wake: '198, 238, 246',
    },
    sea: {
        shallow: '#0e9aa5',
        deep: '#074276',
        glint: '132, 211, 240',
        rainRipple: '188, 226, 244',
        fogWash: '190, 220, 232',
        wake: '224, 249, 255',
    },
    harbor: {
        shallow: '#0a8192',
        deep: '#075274',
        glint: '154, 218, 224',
        rainRipple: '202, 236, 242',
        fogWash: '198, 226, 226',
        wake: '216, 246, 246',
    },
    water: {
        shallow: '#0e9aa5',
        deep: '#0b6c8d',
        glint: '188, 253, 246',
        rainRipple: '210, 245, 255',
        fogWash: '205, 232, 236',
        wake: '220, 248, 250',
    },
};
const ATMOSPHERE_EFFECT_ASSETS = Object.freeze({
    fogWisp: 'atmosphere.fog.wisp.low',
    rainSplash: 'atmosphere.rain.splash',
    rainRipple: 'atmosphere.water.ripple.rain',
    shoreFoam: 'atmosphere.water.foam.corner',
    harborWake: 'atmosphere.water.harbor.wake',
});
// Archive fade: keep the sprite in the draw loop for this many ms after
// `agent:removed` so the sibling AgentSprite fade/sparkle animation can play.
const ARCHIVE_FADE_DURATION_MS = 800;
// 2.4 — affinity proximity: how often ally pairs are re-evaluated, and how
// many warm pairs get a shared plaza preference per pass (keeps idle
// drift bounded in dense worlds).
const AFFINITY_PROXIMITY_INTERVAL_MS = 5000;
const MAX_AFFINITY_PROXIMITY_PAIRS = 6;
const VILLAGE_WOOD_PALETTE = Object.freeze({
    shadow: 'rgba(28, 15, 7, 0.34)',
    outline: '#1b1009',
    deep: '#2b170c',
    dark: '#3f2412',
    mid: '#62391d',
    light: '#8b542a',
    cut: '#c18345',
    rope: '#c9a15d',
    ropeDark: '#7f5b2b',
    moss: '#4f7b3d',
    tealDark: '#1f4c51',
    teal: '#347b83',
    tealLight: '#6fb1a9',
    lantern: '#ffd56a',
    glow: 'rgba(255, 202, 94, 0.26)',
});
const VILLAGE_STONE_PALETTE = Object.freeze({
    light: '#aaa6ad',
    mid: '#777480',
    shadow: '#514b5c',
    mortar: '#302b37',
    moss: '#4f7b3d',
    outline: '#1b1009',
});
const VILLAGE_GATE_TOWER_HALF_TILES = 1.55;
const VILLAGE_GATE_TOWER_SPRITE_ID = 'prop.villageGateTower';
const VILLAGE_GATE_ARCH_SPRITE_ID = 'prop.villageGateArch';
// Sample a colour ramp at t in [0,1], returning an rgba string. Used to
// quantise what were smooth linear gradients into discrete pixel-art courses.
function sampleRamp(stops, t) {
    const clamped = Math.max(0, Math.min(1, t));
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (clamped >= stops[i].t && clamped <= stops[i + 1].t) {
            lo = stops[i];
            hi = stops[i + 1];
            break;
        }
    }
    const span = hi.t - lo.t || 1;
    const k = (clamped - lo.t) / span;
    const ch = (i) => Math.round(lo.c[i] + (hi.c[i] - lo.c[i]) * k);
    const alpha = (lo.c[3] + (hi.c[3] - lo.c[3]) * k).toFixed(3);
    return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha})`;
}
// Canvas counterpart to the GPU wetness shader's four-pixel ordered dither.
// Keep the same 2x2 Bayer ordering so the two paths share the same stepped
// visual grammar without introducing a second pattern.
export function orderedDither4(x = 0, y = 0) {
    const px = Math.floor(Number(x) || 0);
    const py = Math.floor(Number(y) || 0);
    return ((px + 2 * py) & 3) / 3;
}

const CLIFF_REFLECTION_DEPTH = 60;
const CLIFF_REFLECTION_BAND_COUNT = 8;
// Three fixed alpha steps keep the reflection readable without becoming a
// translucent gradient. They are all exact 1/32 values for _withAlpha().
const CLIFF_REFLECTION_ALPHA_STEPS = Object.freeze([0.1875, 0.125, 0.0625]);
const CLIFF_REFLECTION_PHASE_PALETTES = Object.freeze({
    day: Object.freeze(['#2c4c59', '#3f5f65', '#5b706d', '#846f55']),
    dawn: Object.freeze(['#394f64', '#5a6070', '#806f76', '#a37d68']),
    dusk: Object.freeze(['#35465f', '#554f68', '#795c72', '#986a5c']),
    night: Object.freeze(['#182d49', '#283e5b', '#3b5066', '#5a4d57']),
});
const WATERLINE_DITHER_PALETTES = Object.freeze({
    day: Object.freeze([
        'rgba(208, 246, 227, 0.78)',
        'rgba(126, 202, 203, 0.66)',
        'rgba(62, 137, 150, 0.54)',
    ]),
    dawn: Object.freeze([
        'rgba(224, 237, 231, 0.78)',
        'rgba(151, 190, 203, 0.66)',
        'rgba(82, 126, 157, 0.54)',
    ]),
    dusk: Object.freeze([
        'rgba(226, 212, 220, 0.78)',
        'rgba(169, 151, 178, 0.66)',
        'rgba(93, 102, 144, 0.54)',
    ]),
    night: Object.freeze([
        'rgba(168, 206, 224, 0.72)',
        'rgba(91, 151, 181, 0.60)',
        'rgba(43, 93, 133, 0.50)',
    ]),
});


const VILLAGE_GATE_ARCH_COLUMN_SPAN = 104;
// Inscription band inside prop.villageGateArch.png, in sprite pixels. The PNG
// carries the empty burgundy band; the lettering is drawn over it at runtime.
const VILLAGE_GATE_ARCH_BAND_MID_Y = 27.5;
const VILLAGE_GATE_ARCH_BAND_WIDTH = 76;
const VILLAGE_GATE_ARCH_BAND_HEIGHT = 8;
const VILLAGE_GATE_INSCRIPTION = 'CLAUDEVILLE';
const VILLAGE_GATE_INSCRIPTION_INK = '#e2bd6b';
const VILLAGE_GATE_INSCRIPTION_SHADOW = 'rgba(38, 16, 28, 0.85)';
const VILLAGE_WALL_SEA_TOWER_SPRITE_ID = 'prop.villageWallSeaTower';
class StaticPropSprite {
    constructor({ tileX, tileY, drawFn, id = null, bounds = null, splitForOcclusion = false, sortY = null }) {
        this.tileX = tileX;
        this.tileY = tileY;
        const world = tileToWorld(tileX, tileY);
        this.x = world.x;
        this.y = world.y;
        this.sortY = Number.isFinite(Number(sortY)) ? Number(sortY) : this.y;
        this.drawFn = drawFn;
        this.id = id;
        this.bounds = bounds || { left: -32, right: 32, top: -64, bottom: 12, splitY: -18 };
        this.splitForOcclusion = splitForOcclusion;
        this._cacheCanvas = null;
    }
    draw(ctx, zoom) {
        this.drawFn(ctx, this.x, this.y, zoom);
    }
    drawPart(ctx, part, zoom) {
        if (!this.splitForOcclusion || part === 'whole') {
            this.draw(ctx, zoom);
            return;
        }
        const { left, right, top, bottom, splitY } = this.bounds;
        const clipTop = part === 'back' ? top : splitY;
        const clipBottom = part === 'back' ? splitY : bottom;
        if (clipBottom <= clipTop) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
            Math.floor(this.x + left) - 2,
            Math.floor(this.y + clipTop) - 2,
            Math.ceil(right - left) + 4,
            Math.ceil(clipBottom - clipTop) + 4
        );
        ctx.clip();
        this.draw(ctx, zoom);
        ctx.restore();
    }
    drawCached(ctx, zoom) {
        const cached = this._getCachedCanvas(zoom);
        if (!cached) {
            this.draw(ctx, zoom);
            return;
        }
        ctx.drawImage(cached.canvas, cached.x, cached.y);
    }
    drawCachedPart(ctx, part, zoom) {
        if (!this.splitForOcclusion || part === 'whole') {
            this.drawCached(ctx, zoom);
            return;
        }
        const { left, right, top, bottom, splitY } = this.bounds;
        const clipTop = part === 'back' ? top : splitY;
        const clipBottom = part === 'back' ? splitY : bottom;
        if (clipBottom <= clipTop) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
            Math.floor(this.x + left) - 2,
            Math.floor(this.y + clipTop) - 2,
            Math.ceil(right - left) + 4,
            Math.ceil(clipBottom - clipTop) + 4
        );
        ctx.clip();
        this.drawCached(ctx, zoom);
        ctx.restore();
    }
    _getCachedCanvas(zoom) {
        if (this._cacheCanvas) return this._cacheCanvas;
        if (typeof document === 'undefined') return null;
        const pad = 8;
        const { left, right, top, bottom } = this.bounds;
        const width = Math.max(1, Math.ceil(right - left + pad * 2));
        const height = Math.max(1, Math.ceil(bottom - top + pad * 2));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        SpriteRenderer.disableSmoothing(ctx);
        ctx.translate(-(this.x + left - pad), -(this.y + top - pad));
        this.drawFn(ctx, this.x, this.y, zoom);
        this._cacheCanvas = {
            canvas,
            x: Math.floor(this.x + left - pad),
            y: Math.floor(this.y + top - pad),
        };
        return this._cacheCanvas;
    }
    releaseCache() {
        releaseCanvasBackingStore(this._cacheCanvas?.canvas);
        this._cacheCanvas = null;
    }
    propBackSortY() {
        return this.sortY + Math.min(-8, this.bounds.splitY);
    }
    propFrontSortY() {
        return this.sortY + Math.max(0, this.bounds.bottom * 0.25);
    }
}

export class IsometricRenderer {
    constructor(world, options = {}) {
        this.world = world;
        this.assets = options.assets || null;
        this.sprites = this.assets ? new SpriteRenderer(this.assets) : null;
        this.terrain = this.assets ? new TerrainTileset(this.assets) : null;
        this.compositor = this.assets ? new Compositor(this.assets) : null;
        this.canvas = null;
        this.ctx = null;
        this.fxCanvas = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.postFx = null;
        this.postFxFeed = null;
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this._postFxCanvasVisible = null;
        this.camera = null;
        this.cameraDirector = null;
        this.particleSystem = new ParticleSystem();
        this.buildingRenderer = this.assets
            ? new BuildingSprite(this.assets, this.sprites, this.particleSystem)
            : null;
        this.harborTraffic = new HarborTraffic({ sprites: this.sprites });
        this.visitIntentManager = new VisitIntentManager({ world: this.world });
        this.visitTileAllocator = new VisitTileAllocator();
        this.atmosphereState = new AtmosphereState();
        this.skyRenderer = new SkyRenderer({ assets: this.assets });
        this.weatherRenderer = new WeatherRenderer();
        // Weather renderer needs the AssetManager so its sprite-stamp helpers
        // (rain splashes, water ripples) can resolve atmosphere.* asset IDs.
        // Method is defensively optional because it only landed alongside the
        // stamp helpers.
        this.weatherRenderer.setAssets?.(this.assets);
        // Seasonal ambient particles (snow/petals/fireflies/leaves) routed
        // into the shared ParticleSystem. Atmosphere snapshot is captured
        // per-frame onto _lastAtmosphere by WorldFrameRenderer; fall back to
        // the raw AtmosphereState snapshot before the first frame runs.
        this.seasonalAmbience = new SeasonalAmbience({
            particleSystem: this.particleSystem,
            atmosphereStateGetter: () => this._lastAtmosphere ?? this.atmosphereState?.snapshot?.() ?? null,
            motionScaleGetter: () => this.motionScale ?? 1,
            viewportProvider: () => ({
                x: 0,
                y: 0,
                width: (this.canvas?.width ?? 0) / (this._screenDpr?.() || 1),
                height: (this.canvas?.height ?? 0) / (this._screenDpr?.() || 1),
            }),
            // #39 — hush decorative seasonal drift while a real git reward is on
            // screen (the celebratory gull scatter window) so it doesn't compete
            // with the live event.
            suppressGetter: () => this._gullScatterActive(),
            // C2 — anchor leaf/petal drift to visible tree canopies and
            // butterflies to flower tiles; snow keeps its viewport-wide fall.
            anchorsProvider: (kind) => this._seasonalDriftAnchors(kind),
        });
        this.landmarkActivity = new LandmarkActivity({ world: this.world, sprites: this.sprites });
        this.chronicleStore = options.chronicleStore || null;
        this.modal = options.modal || null;
        // Application-layer services wired in App.js. All optional: the
        // renderer degrades to its pre-metaphor behavior when absent.
        this.moodService = options.moodService || null;
        this.biographyService = options.biographyService || null;
        this.affinityService = options.affinityService || null;
        this._nicknames = new Map(); // identityKey -> earned nickname
        this._biographyReadGeneration = 0;
        this._affinityProximityAccumulator = 0;
        this._allyTetherPairs = []; // warmest idle ally pairs, drawn as tethers

        this._chronicleChannelListener = null;
        this.agentEventStream = null;
        this.relationshipState = null;
        this.ritualConductor = null;
        this.arrivalDeparture = null;
        this.chronicleMonuments = null;
        this.trailRenderer = null;
        this.chronicler = null;
        this.villageDirector = new VillageDirector(this.world);
        this.pulsePriority = getPulsePriority();
        // #2 — value-hierarchy mark governor. Published as the active singleton
        // so the decorative draw paths (AgentSprite/CouncilRing/director overlay)
        // can consult it without the frame orchestrator threading it through.
        this.markGovernor = new MarkGovernor();
        setActiveMarkGovernor(this.markGovernor);
        this.agentSprites = new Map();
        this.gateTransits = new Map();
        this.gateDoorsOpen = false;
        this._gateDoorsOpenUntilMs = 0;
        this._sortedSprites = [];
        this._allSpritesSnapshot = [];
        this._visibleSortedSprites = [];
        this._visibleSpriteCandidates = new Set();
        this._movingSprites = [];
        this._pairBuckets = new Map();
        this._pairIds = new Map();
        this._pairVisited = new Set();
        this._spritesNeedSort = true;
        this._overlayPrioritizedSprites = [];
        this._overlayBubbleSprites = [];
        this._overlayBubbleOrder = [];
        this._overlayBubbleBaseRects = [];
        this._overlayBubbleClusters = [];
        this._overlayBubbleClusterCount = 0;
        this._overlayBubbleGroups = new Map();
        this._agentLabelHitRects = [];
        this._overlayCompactRects = [];
        this._overlayNameRects = [];
        this._overlayReservedRects = [];
        this._overlayBubbleOccupiedRects = [];
        this._overlayCompactGrid = this._createRectGrid();
        this._overlayNameGrid = this._createRectGrid();
        this._overlayBubbleGrid = this._createRectGrid();
        this._overlayClusterGrid = this._createRectGrid();
        this._laneTiles = new Map();
        this._staticPropDrawables = [];
        this._drawables = [];
        this._familiarMoteDrawables = [];
        this._harborPendingSignature = '';
        this._contextLost = false;
        this._disposed = false;
        this.running = false;
        this.frameId = null;
        this.terrainCache = null;
        this.terrainCacheBounds = null;
        this.terrainCacheKey = '';
        this.terrainCacheMeta = null;
        this._terrainCacheLimitWarningKey = '';
        this.foliageRenderer = new FoliageRenderer(this);
        this.wildlifeRenderer = new WildlifeRenderer(this);
        this.terrainSeed = [];
        this._motionClock = createMotionClock();
        this.waterFrame = 0;
        this.motionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null;
        this.motionScale = this.motionQuery?.matches ? 0 : 1;
        this.ritualConductor = new RitualConductor({ motionScale: this.motionScale });
        this.arrivalDeparture = new ArrivalDepartureController({ motionScale: this.motionScale });
        // ChronicleMonuments takes `assets` and `particles` as optional
        // injections and silently falls back to a vector path without them.
        // They were never passed, so every monument in the village drew as
        // antialiased ellipses while the four authored PixelLab sprites sat
        // unused — smooth curves in a world that is hard pixel steps everywhere
        // else. Wire both.
        this.chronicleMonuments = new ChronicleMonuments({
            store: this.chronicleStore,
            assets: this.assets,
            particles: this.particleSystem,
        });
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            sprites: this.agentSprites,
            motionScale: this.motionScale,
        });
        this.chronicler = new Chronicler({
            assets: this.assets,
            sprites: this.sprites,
            motionScale: this.motionScale,
        });
        this.particleSystem.setMotionEnabled(this.motionScale > 0);
        this._onMotionPreferenceChange = (event) => this._setMotionScale(event.matches ? 0 : 1);
        this._motionPreferenceBound = false;
        this._bindMotionPreference();
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        this.lightGradientCache = new Map();
        this.lightFadeColorCache = new Map();
        this.lightColorRgbCache = new Map();
        this._atmosphereEffectSpriteCache = new Map();
        this._lightFadeColorCacheEvictions = 0;
        this._lightColorRgbCacheEvictions = 0;
        this._frameLightSources = null;
        this.selectedAgent = null;
        this.onAgentSelect = null;
        this._chatMatchAccumulator = 250;
        this._activeAgentsSnapshot = [];
        this._crowdBumpCooldowns = new Map();
        this._stationaryOverlapAccumulator = 0;
        this._rainSplashAccumulator = 0;
        this._localAvoidanceMetrics = {
            laneCorrections: 0,
            separationPushes: 0,
            zeroDistancePairs: 0,
            progressClamps: 0,
        };
        this._crowdStats = this._emptyCrowdStats();
        this._crowdStatsAccumulator = 0;
        this._lastAgentCount = 0;
        this._ritualSyncFrame = 0;
        this._lastRitualPoseMode = 'full';
        this.behaviorMetrics = {
            stationaryRetargets: 0,
            stationaryOverlapChecks: 0,
            scenicVisits: 0,
            parentCoherentChildren: 0,
            handoffIntents: 0,
        };
        this._chroniclerPauseUntil = 0;
        this._chronicleNextUpdateAt = 0;
        this._chronicleUpdating = false;
        this._chronicleUpdatePromise = null;
        this._worldModeActive = true;
        this._worldResourcesSuspended = false;
        this._worldResourceGeneration = 0;
        this._worldResumePromise = null;
        this._worldResumeFailures = 0;
        this._worldSpritesDirty = false;
        this._idleFrameDirty = true;
        this._idleLastRenderCamera = { x: NaN, y: NaN, zoom: NaN };
        this._idleResourceWorkObserved = false;
        this._harborFailedPushState = null;
        this._activeWorkingCount = 0;
        this._onModeChanged = null;
        this._debugGlobals = new Map();
        this._frameFailureStats = {
            total: 0,
            consecutive: 0,
            lastStage: null,
            lastMessage: null,
            lastAt: 0,
            lastReportedAt: -Infinity,
            byStage: {},
            paused: false,
        };
        this._performanceSamples = null;
        this._frameEnvelope = createFrameEnvelope();
        this._frameTimer = null;
        this._frameHealthHelper = null;
        this._installFrameHealthHelper();

        // Generate deterministic terrain seed so the village keeps its geography across reloads.
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                this.terrainSeed.push(this._tileNoise(x, y));
            }
        }

        // Path tiles (near buildings)
        this.pathTiles = new Set();
        this.townSquareTiles = new Set();
        this.mainAvenueTiles = new Set();
        this.dirtPathTiles = new Set();
        this.commandCenterRoadTiles = new Set();
        this._generatePaths();

        // Scenery (water, shorelines, bridges, vegetation, rocks)
        this.scenery = new SceneryEngine({
            world: this.world,
            terrainSeed: this.terrainSeed,
            tileNoise: (x, y) => this._tileNoise(x, y),
            smoothNoise: (x, y, scale) => this._smoothNoise(x, y, scale),
        });
        this.waterTiles = this.scenery.getWaterTiles();
        this.shoreTiles = this.scenery.getShoreTiles();
        this.wetShoreTiles = this.scenery.getWetShoreTiles?.() || new Set();
        this.deepWaterTiles = this.scenery.getDeepWaterTiles();
        this.lagoonWaterTiles = this.scenery.getLagoonWaterTiles();
        this.waterMeta = this.scenery.getWaterMeta?.() || new Map();
        this.harborWaterApronTiles = this._buildHarborWaterApronTiles();

        // Bridges (Task 5): two authored river crossings only.
        this.scenery.generateBridges();
        this.bridgeTiles = this.scenery.getBridgeTiles();
        this.bridgeLanterns = new BridgeLanterns({ renderer: this });
        this.bridgeSpans = this._buildBridgeSpans();
        this._waterTileDescriptors = this._buildWaterTileDescriptors();
        this._shoreWaterEdgeDescriptors = this._buildShoreWaterEdgeDescriptors();
        this._visibleWaterFrame = [];
        this._visibleShoreFrame = [];
        this._weatherWaterFrame = [];
        this._visibleWaterCullKey = '';
        this._visibleShoreCullKey = '';
        for (const key of this.bridgeTiles.keys()) {
            this.pathTiles.add(key);
        }
        // Re-classify so newly-pathified bridge tiles inherit avenue style.
        // CRITICAL: _classifyRoadMaterials *adds* to mainAvenueTiles and
        // dirtPathTiles without clearing them, so a tile could end up in
        // BOTH sets and break _drawTile's mutually-exclusive styling.
        // Clear first.
        this.mainAvenueTiles.clear();
        this.dirtPathTiles.clear();
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);

        // Now that bridges are in pathTiles, generate terrain features so
        // bridges don't get tagged with reeds/flowers/stones/mushrooms.
        this.featureTiles = new Map();
        this._generateTerrainFeatures();

        // Flat vegetation (bushes, grass tufts) — populated after terrain features
        // so noise samples don't compete and after bridges so they're skipped.
        this.scenery.generateFlatVegetation(this.pathTiles, this.bridgeTiles);
        this.bushTiles = this.scenery.getBushTiles();
        this.grassTuftTiles = this.scenery.getGrassTuftTiles();
        this.flowerTiles = this.scenery.getFlowerTiles();

        // Trees (Y-sorted props)
        this.scenery.generateTrees(this.pathTiles, this.bridgeTiles);
        const generatedTrees = this.scenery.getTreeProps();
        const canPlaceAuthoredTree = (p) => !this.scenery.isBlockedForTallScenery(
            p.tileX,
            p.tileY,
            this.pathTiles,
            this.bridgeTiles,
        );
        const authoredPalms = TROPICAL_PALMS.filter(canPlaceAuthoredTree).map((p) => ({
            ...p,
            variant: 2,
            tropical: true,
        }));
        const authoredBroadleafTrees = TROPICAL_BROADLEAF_TREES.filter(canPlaceAuthoredTree).map((p) => ({
            ...p,
            variant: 3,
            tropical: true,
            canopy: true,
        }));
        this.treePropSprites = [...generatedTrees, ...authoredPalms, ...authoredBroadleafTrees]
            .filter((t) => !this._isInBridgeTreeExclusion(t.tileX, t.tileY))
            .map((t) => {
            // Deterministic per-tree phase seed for wind sway. Anchored to
            // tile coordinates + variant so the visual offset is stable across
            // reloads but each tree drifts on its own phase.
            const swaySeed = this.foliageRenderer.windSwaySeed(t);
            if (t.canopy || t.tropical) {
                const bounds = this.foliageRenderer.fantasyTreePropBounds(t);
                return new StaticPropSprite({
                    tileX: t.tileX,
                    tileY: t.tileY,
                    id: 'fantasy.tree',
                    bounds,
                    splitForOcclusion: true,
                    drawFn: (ctx, x, y) => this.foliageRenderer.withTreeSway(
                        ctx,
                        swaySeed,
                        () => this.foliageRenderer.drawFantasyForestTree(ctx, x, y, t),
                        t.tileX,
                    ),
                });
            }
            // variant 0 -> oak, 1 -> pine, 2 -> willow; size driven by scale threshold.
            const species = ['oak', 'pine', 'willow'][(t.variant ?? 0) % 3];
            const size = (t.scale ?? 1) >= 1.0 ? 'large' : 'small';
            const id = `veg.tree.${species}.${size}`;
            return new StaticPropSprite({
                tileX: t.tileX,
                tileY: t.tileY,
                id,
                bounds: this._assetPropBounds(id),
                splitForOcclusion: true,
                drawFn: (ctx, x, y) => this.foliageRenderer.withTreeSway(
                    ctx,
                    swaySeed,
                    () => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
                    t.tileX,
                ),
            });
        });

        // Boulders (Y-sorted props)
        this.scenery.generateBoulders(this.pathTiles, this.bridgeTiles);
        this.boulderPropSprites = this.scenery.getBoulderProps().map((b) => {
            // variant 'a' → mossy, 'b' → granite; size driven by scale threshold.
            const species = b.variant === 'b' ? 'granite' : 'mossy';
            const size = (b.scale ?? 1) >= 1.0 ? 'large' : 'small';
            const id = `veg.boulder.${species}.${size}`;
            return new StaticPropSprite({
                tileX: b.tileX,
                tileY: b.tileY,
                id,
                bounds: this._assetPropBounds(id, 0.62),
                splitForOcclusion: size === 'large',
                drawFn: (ctx, x, y) => { if (this.sprites) this.sprites.drawSprite(ctx, id, x, y); },
            });
        });
        this.districtPropSprites = this._buildDistrictPropSprites();
        this._staticPropSprites = [
            ...this.treePropSprites,
            ...this.boulderPropSprites,
            ...this.districtPropSprites,
        ];
        this._staticPropDrawables = this._buildStaticPropDrawables();
        this._staticPropFastDrawables = this._buildStaticPropFastDrawables();
        this._staticPropFastFrameDrawables = [];
        this._staticPropVisibleFrameDrawables = [];
        // 3.4 — props are static after init, so the footprint index the
        // name-tag slot clamp queries is built once here.
        this._propFootprintIndex = this._buildPropFootprintIndex(this._staticPropSprites);

        // Walkability grid + Pathfinder (Task 11)
        this.walkabilityGrid = this.scenery.getWalkabilityGrid();
        this.pathfinder = new Pathfinder(this.walkabilityGrid);
        this.visitTileAllocator.updateContext({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });

        this.commandCenterGroundProps = [];
        this._generateCommandCenterAmbience();
        this._laneTiles = this._buildLaneTileIndex();
        this.ambientEmitters = [];
        this._generateAmbientEmitters();
        // Latest building presence tiers, refreshed via building:active-agents
        // and consulted by gated emitters. Map<type, { count, recencyScore, tier }>.
        this._buildingPresenceMap = new Map();
        // Per-emitter interval timestamps for gated/intervaled emitters.
        this._emitterIntervalLastMs = new Map();

        // Event subscriptions
        this._unsubscribers = [];
        this.debugOverlay = null;
        this._debugOverlayModulePromise = null;
    }

    _generatePaths() {
        const buildingDefs = Array.from(this.world.buildings.values());
        const command = this._getCommandBuilding();
        const plazaHub = this._commandPlazaHub(command);
        for (const b of buildingDefs) {
            // Paths around buildings
            for (let x = b.position.tileX - 1; x <= b.position.tileX + b.width; x++) {
                for (let y = b.position.tileY - 1; y <= b.position.tileY + b.height; y++) {
                    if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                        this.pathTiles.add(`${x},${y}`);
                    }
                }
            }
            for (const tile of this._buildingApproachTiles(b)) {
                if (this._inMapBounds(tile.tileX, tile.tileY)) {
                    this.pathTiles.add(`${Math.round(tile.tileX)},${Math.round(tile.tileY)}`);
                }
            }
        }
        this._generateTownSquare(plazaHub.x, plazaHub.y);
        this._generatePlannedRoads();
        this._generateGateApproach();
        // Fallback connection for future buildings that are not covered by
        // the authored road plan.
        for (const bDef of buildingDefs) {
            const destination = this._buildingRoadDestination(bDef);
            const key = `${destination.x},${destination.y}`;
            if (!this.pathTiles.has(key)) {
                this._addTownRoad(plazaHub.x, plazaHub.y, destination.x, destination.y);
            }
        }
        this._classifyRoadMaterials(plazaHub.x, plazaHub.y);
    }

    _buildingApproachTiles(building) {
        const out = [];
        if (building?.entrance) out.push(building.entrance);
        if (Array.isArray(building?.visitTiles)) out.push(...building.visitTiles);
        return out;
    }

    _buildHarborWaterApronTiles() {
        const set = new Set();
        const harbor = this.world.buildings.get('harbor');
        if (!harbor) return set;
        const x0 = Math.floor(harbor.position.tileX);
        const y0 = Math.floor(harbor.position.tileY);
        for (let x = x0; x < x0 + harbor.width; x++) {
            for (let y = y0; y < y0 + harbor.height; y++) {
                set.add(`${x},${y}`);
            }
        }
        return set;
    }

    _isVisualWaterTile(tileX, tileY, key = `${tileX},${tileY}`) {
        return this.waterTiles.has(key) || this.harborWaterApronTiles?.has(key);
    }

    _waterMetaAt(tileX, tileY, key = `${tileX},${tileY}`) {
        return this.waterMeta?.get?.(key) || null;
    }

    _waterRegionAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        if (meta?.region) return meta.region;
        if (this.lagoonWaterTiles?.has(key)) return 'lagoon';
        if (this.deepWaterTiles?.has(key)) return 'sea';
        return 'water';
    }

    _waterProfileAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        if (meta?.weatherProfile) return meta.weatherProfile;
        const region = this._waterRegionAt(tileX, tileY, key);
        if (region === 'sea' || region === 'openSea') return 'openSea';
        return region;
    }

    _waterTokenAt(tileX, tileY, key = `${tileX},${tileY}`) {
        const region = this._waterRegionAt(tileX, tileY, key);
        if (region === 'openSea') return WATER_TOKENS.sea;
        return WATER_TOKENS[region] || WATER_TOKENS.water;
    }

    _isLagoonWaterTile(tileX, tileY, key = `${tileX},${tileY}`) {
        const meta = this._waterMetaAt(tileX, tileY, key);
        return meta?.region === 'lagoon' || meta?.weatherProfile === 'lagoon' || this.lagoonWaterTiles?.has(key);
    }

    _buildWaterTileDescriptors() {
        const descriptors = [];
        if (!this.waterTiles?.size) return descriptors;
        const fraction = (value) => value - Math.floor(value);
        for (const key of this.waterTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const { tileX: x, tileY: y } = tile;
            const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
            const openness = this._waterOpenness(x, y);
            const profile = this._waterProfileAt(x, y, key);
            const token = this._waterTokenAt(x, y, key);
            const meta = this._waterMetaAt(x, y, key);
            const isDeep = this.deepWaterTiles.has(key);
            const isHarbor = this._isHarborWater(x, y);
            const isLagoon = this._isLagoonWaterTile(x, y, key);
            const isOpenSea = this._isOpenSeaTile(x, y, openness);
            const flowDirX = Number(meta?.flowDirX) || 0;
            const flowDirY = Number(meta?.flowDirY) || 0;
            const flowScreenX = (flowDirX - flowDirY) * TILE_WIDTH / 2;
            const flowScreenY = (flowDirX + flowDirY) * TILE_HEIGHT / 2;
            const flowScreenLength = Math.hypot(flowScreenX, flowScreenY) || 1;
            const flowUnitX = flowScreenX / flowScreenLength;
            const flowUnitY = flowScreenY / flowScreenLength;
            const glitterCount = 2 + (Math.floor(seed * 97) % 2);
            const glitterSpecks = [];
            for (let i = 0; i < glitterCount; i++) {
                const hx = fraction(Math.sin(seed * 127.1 + i * 311.7) * 43758.5453);
                const hy = fraction(Math.sin(seed * 269.5 + i * 183.3) * 24634.6345);
                const hp = fraction(Math.sin(seed * 419.2 + i * 71.9) * 51294.1234);
                glitterSpecks.push({
                    offsetX: (hx - 0.5) * TILE_WIDTH * 0.7,
                    offsetY: (hy - 0.5) * TILE_HEIGHT * 0.7,
                    phase: hp * 6.28,
                    rate: 2.2 + hp * 1.6,
                    alphaScale: 0.14 + hy * 0.16,
                    size: hp > 0.62 ? 2 : 1,
                });
            }
            descriptors.push({
                x,
                y,
                key,
                seed,
                screenX: (x - y) * TILE_WIDTH / 2,
                screenY: (x + y) * TILE_HEIGHT / 2,
                edge: this._waterEdgeMask(x, y),
                openness,
                profile,
                token,
                isDeep,
                isHarbor,
                isLagoon,
                isOpenSea,
                animatedCurrentEligible: openness >= 0.56 || isHarbor || isOpenSea,
                glitterSpecks,
                // B1 — flowing river/current tiles carry a downstream unit vector
                // (tile space) so the flow-streak pass can drift highlights along it.
                isCurrent: meta?.surface === 'current',
                flowDirX,
                flowDirY,
                flowUnitX,
                flowUnitY,
                flowPerpendicularX: -flowUnitY,
                flowPerpendicularY: flowUnitX,
                riverSpan: TILE_WIDTH * 0.42,
                riverHalfLength: 3.5 + openness * 3,
                riverLaneSeeds: [seed % 1, (seed + 0.41) % 1],
            });
        }
        return descriptors;
    }

    _buildShoreWaterEdgeDescriptors() {
        const descriptors = [];
        if (!this.shoreTiles?.size) return descriptors;
        for (const key of this.shoreTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            const { tileX: x, tileY: y } = tile;
            const edge = this._shoreWaterEdgeMask(x, y);
            if (!edge) continue;
            const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
            const adjacent = this._firstAdjacentWaterMeta(x, y);
            descriptors.push({
                x,
                y,
                key,
                seed,
                edge,
                screenX: (x - y) * TILE_WIDTH / 2,
                screenY: (x + y) * TILE_HEIGHT / 2,
                adjacent,
                token: adjacent ? this._waterTokenAt(adjacent.x, adjacent.y, adjacent.key) : WATER_TOKENS.water,
                profile: adjacent ? this._waterProfileAt(adjacent.x, adjacent.y, adjacent.key) : 'water',
            });
        }
        return descriptors;
    }

    _visibleWaterTileDescriptors(bounds) {
        const out = this._visibleWaterFrame;
        if (!bounds || !this._waterTileDescriptors?.length) {
            out.length = 0;
            this._visibleWaterCullKey = '';
            return out;
        }
        const { startX, endX, startY, endY } = bounds;
        const key = `${startX},${endX},${startY},${endY}|${this._waterTileDescriptors.length}`;
        if (key === this._visibleWaterCullKey) return out;
        this._visibleWaterCullKey = key;
        out.length = 0;
        for (const tile of this._waterTileDescriptors) {
            if (tile.x >= startX && tile.x <= endX && tile.y >= startY && tile.y <= endY) out.push(tile);
        }
        return out;
    }

    _visibleShoreWaterEdgeDescriptors(bounds) {
        const out = this._visibleShoreFrame;
        if (!bounds || !this._shoreWaterEdgeDescriptors?.length) {
            out.length = 0;
            this._visibleShoreCullKey = '';
            return out;
        }
        const { startX, endX, startY, endY } = bounds;
        const key = `${startX},${endX},${startY},${endY}|${this._shoreWaterEdgeDescriptors.length}`;
        if (key === this._visibleShoreCullKey) return out;
        this._visibleShoreCullKey = key;
        out.length = 0;
        for (const tile of this._shoreWaterEdgeDescriptors) {
            if (tile.x >= startX && tile.x <= endX && tile.y >= startY && tile.y <= endY) out.push(tile);
        }
        return out;
    }

    _generatePlannedRoads() {
        for (const route of TOWN_ROAD_ROUTES) {
            this._addRoadPolyline(route.points, route.width || 1, route.material || 'dirt');
        }
    }

    _addRoadPolyline(points = [], width = 1, material = 'dirt') {
        if (points.length < 2) return;
        for (let i = 0; i < points.length - 1; i++) {
            this._addRoadSegment(points[i], points[i + 1], width, material);
        }
    }

    _addRoadSegment(from, to, width = 1, material = 'dirt') {
        const [fromX, fromY] = from;
        const [toX, toY] = to;
        const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1) * 2;
        const radius = Math.max(0, Math.floor(width / 2));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(fromX + (toX - fromX) * t);
            const y = Math.round(fromY + (toY - fromY) * t);
            for (let ox = -radius; ox <= radius; ox++) {
                for (let oy = -radius; oy <= radius; oy++) {
                    const tx = x + ox;
                    const ty = y + oy;
                    if (!this._inMapBounds(tx, ty)) continue;
                    const key = `${tx},${ty}`;
                    this.pathTiles.add(key);
                    this._markRoadMaterial(key, material);
                }
            }
        }
    }

    _generateGateApproach() {
        this._addRoadPolyline([[18, 38], [20, 38], [21, 38], [20, 39], [18, 39]], 1, 'dirt');
        for (let x = 18; x <= 21; x++) {
            for (let y = 38; y <= 39; y++) {
                if (!this._inMapBounds(x, y)) continue;
                const key = `${x},${y}`;
                this.pathTiles.add(key);
                this._markRoadMaterial(key, 'dirt');
            }
        }
    }

    _markRoadMaterial(key, material) {
        if (material === 'avenue' || material === 'dock') {
            this.mainAvenueTiles.add(key);
        } else {
            this.dirtPathTiles.add(key);
        }
        if (material === 'avenue') {
            this.commandCenterRoadTiles.add(key);
        }
    }

    _buildingRoadDestination(building) {
        const visit = typeof building.primaryVisitTile === 'function'
            ? building.primaryVisitTile()
            : building.entrance;
        if (visit && Number.isFinite(visit.tileX) && Number.isFinite(visit.tileY)) {
            return {
                x: Math.round(visit.tileX),
                y: Math.round(visit.tileY),
            };
        }
        return {
            x: Math.floor(building.position.tileX + building.width / 2),
            y: Math.floor(building.position.tileY + building.height / 2),
        };
    }

    _commandPlazaHub(command) {
        const visit = typeof command?.primaryVisitTile === 'function'
            ? command.primaryVisitTile()
            : command?.entrance;
        if (visit && Number.isFinite(visit.tileX) && Number.isFinite(visit.tileY)) {
            return { x: Math.round(visit.tileX), y: Math.round(visit.tileY) };
        }
        if (command) {
            return {
                x: Math.floor(command.position.tileX + command.width / 2),
                y: Math.floor(command.position.tileY + command.height),
            };
        }
        return { x: 20, y: 22 };
    }

    _generateTownSquare(centerX, centerY) {
        for (let x = centerX - 4; x <= centerX + 5; x++) {
            for (let y = centerY - 3; y <= centerY + 3; y++) {
                const dx = (x - centerX) / 4.4;
                const dy = (y - centerY) / 2.8;
                if ((dx * dx + dy * dy) <= 1.0 && this._inMapBounds(x, y)) {
                    const key = `${x},${y}`;
                    this.townSquareTiles.add(key);
                    this.pathTiles.add(key);
                }
            }
        }
    }

    _addTownRoad(fromX, fromY, toX, toY) {
        const midX = toX;
        const startX = Math.min(fromX, midX);
        const endX = Math.max(fromX, midX);
        for (let x = startX; x <= endX; x++) {
            this.pathTiles.add(`${x},${fromY}`);
            this.pathTiles.add(`${x},${fromY + 1}`);
        }
        const startY = Math.min(fromY, toY);
        const endY = Math.max(fromY, toY);
        for (let y = startY; y <= endY; y++) {
            this.pathTiles.add(`${midX},${y}`);
            this.pathTiles.add(`${midX + 1},${y}`);
        }
    }

    _classifyRoadMaterials(plazaHubX, plazaHubY) {
        for (const key of this.pathTiles) {
            if (this.townSquareTiles.has(key)) continue;
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            const dx = (x - plazaHubX) / 4.2;
            const dy = (y - plazaHubY) / 3.0;
            const nearPlaza = (dx * dx + dy * dy) <= 1.0;
            // Smooth route material field (2.1): avenue/dirt assignment forms
            // coherent stretches of road instead of per-tile confetti.
            const routeNoise = this._smoothNoise(x + 73, y + 29, 5);
            if (this.commandCenterRoadTiles?.has(key) || nearPlaza || routeNoise > 0.72) {
                this.mainAvenueTiles.add(key);
            } else if (routeNoise < 0.34 || ((x + y) % 5 === 0)) {
                this.dirtPathTiles.add(key);
            }
        }
    }

    _generateTerrainFeatures() {
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const key = `${x},${y}`;
                if (this.waterTiles.has(key) || this.pathTiles.has(key)) continue;
                // Low-frequency feature field (2.1): reeds form shoreline beds
                // and stones/mushrooms clump instead of peppering single tiles.
                const noise = this._smoothNoise(x + 41, y + 17, 3.5);
                if (this.shoreTiles.has(key) && noise > 0.46) {
                    this.featureTiles.set(key, 'reeds');
                } else if (noise < 0.045) {
                    this.featureTiles.set(key, 'flowers');
                } else if (noise > 0.948) {
                    this.featureTiles.set(key, 'stones');
                } else if (noise > 0.918 && this._smoothNoise(x - 9, y + 23, 3.5) > 0.62) {
                    this.featureTiles.set(key, 'mushrooms');
                }
            }
        }
    }

    _generateCommandCenterAmbience() {
        const command = this._getCommandBuilding();
        if (!command) return;

        const cx = command.position.tileX;
        const cy = command.position.tileY;
        const w = command.width;
        const h = command.height;

        const southY = cy + h + 0;
        const northY = cy - 1;
        const eastX = cx + w;
        const southGateX = cx + Math.floor(w / 2);

        // Processional approach lanes.
        this._addCommandRoadLine(cx - 7, southY, cx - 1, southY);
        this._addCommandRoadLine(cx - 2, southY, southGateX - 1, southY);
        this._addCommandRoadLine(cx + w - 1, southY + 1, eastX + 6, southY + 1);

        // North-side command lane.
        this._addCommandRoadLine(cx + 1, northY, cx + w + 3, northY);
        this._addCommandRoadLine(cx + w + 3, northY, cx + w + 3, cy + 1);

        // Hard guardrails at the approach mouths and northern shoulder.
        this.commandCenterRoadTiles.add(`${southGateX},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${southGateX + 1},${southY - 1}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY}`);
        this.commandCenterRoadTiles.add(`${cx + w + 2},${northY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY + 1}`);
        this.commandCenterRoadTiles.add(`${cx - 2},${southY - 1}`);

        // Reinforce the ceremonial entrance and northern gate with visible guard-posts.
        this.commandCenterGroundProps.push(
            { tileX: southGateX - 0.35, tileY: southY + 0.2, type: 'guardpost', phase: 0.2 },
            { tileX: southGateX + 0.25, tileY: southY + 0.2, type: 'guardpost', phase: 1.1 },
            { tileX: cx - 2.2, tileY: southY + 0.6, type: 'guardpost', phase: 2.8 },
            { tileX: cx + w + 2.2, tileY: northY + 0.4, type: 'guardpost', phase: 3.9 },
        );

        // Watchfires around ceremonial paths for subtle pulse signals.
        if (this._inMapBounds(cx - 3.5, southY + 0.4)) {
            this.commandCenterGroundProps.push({ tileX: cx - 3.5, tileY: southY + 0.4, type: 'watchfire', phase: 1.35 });
        }
        if (this._inMapBounds(cx + w + 2.4, cy + 0.9)) {
            this.commandCenterGroundProps.push({ tileX: cx + w + 2.4, tileY: cy + 0.9, type: 'watchfire', phase: 4.7 });
        }
    }

    _inMapBounds(tileX, tileY) {
        return tileX >= 0 && tileX <= MAP_SIZE - 1 && tileY >= 0 && tileY <= MAP_SIZE - 1;
    }

    _getCommandBuilding() {
        return this.world.buildings.get('command');
    }

    _addCommandRoadLine(startX, startY, endX, endY) {
        const x1 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(startX)));
        const y1 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(startY)));
        const x2 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(endX)));
        const y2 = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(endY)));

        if (x1 === x2) {
            const fromY = Math.min(y1, y2);
            const toY = Math.max(y1, y2);
            for (let y = fromY; y <= toY; y++) {
                this._markCommandRoadTile(x2, y);
                const key = `${x2},${y}`;
                this.pathTiles.add(key);
                this.mainAvenueTiles.add(key);
            }
            return;
        }

        if (y1 === y2) {
            const fromX = Math.min(x1, x2);
            const toX = Math.max(x1, x2);
            for (let x = fromX; x <= toX; x++) {
                this._markCommandRoadTile(x, y1);
                const key = `${x},${y1}`;
                this.pathTiles.add(key);
                this.mainAvenueTiles.add(key);
            }
            return;
        }

        // Diagonal fallback for robustness; keeps intent even if future paths shift.
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(x1 + (x2 - x1) * t);
            const y = Math.round(y1 + (y2 - y1) * t);
            this._markCommandRoadTile(x, y);
            const key = `${x},${y}`;
            this.pathTiles.add(key);
            this.mainAvenueTiles.add(key);
        }
    }

    _markCommandRoadTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return;
        const key = `${tileX},${tileY}`;
        this.commandCenterRoadTiles.add(key);
    }

    _generateAmbientEmitters() {
        const emitters = [
            { tileX: 4.8, tileY: 20.4, particleType: 'sparkle', chance: 0.018 },
            { tileX: 5.8, tileY: 21.2, particleType: 'sparkle', chance: 0.012 },
            { tileX: 28.0, tileY: 29.2, particleType: 'sparkle', chance: 0.016 },
            { tileX: 8.5, tileY: 12.0, particleType: 'sparkle', chance: 0.01 },
            { tileX: 33.0, tileY: 19.5, particleType: 'smoke', chance: 0.012 },
            { tileX: 13.4, tileY: 34.3, particleType: 'mineDust', chance: 0.016 },
            { tileX: 13.4, tileY: 34.0, particleType: 'firefly', chance: 0.014 },
            { tileX: 27.8, tileY: 29.2, particleType: 'forgeEmber', chance: 0.02 },
            { tileX: 4.8, tileY: 32.2, particleType: 'portalRune', chance: 0.022 },
            { tileX: 22.4, tileY: 33.1, particleType: 'questPing', chance: 0.014 },
            { tileX: 8.5, tileY: 16.8, particleType: 'archiveMote', chance: 0.022 },
            { tileX: 23.4, tileY: 17.8, particleType: 'sparkle', chance: 0.012 },
            { tileX: 32.5, tileY: 16.4, particleType: 'beaconMote', chance: 0.014 },
            { tileX: 9.5, tileY: 8.5, particleType: 'firefly', chance: 0.014 },
            // E7 — extra dusk/night firefly swarms along grass/water edges away
            // from buildings: the south bank of the central moat and the grassy
            // fringe of the northwest lagoon stream.
            { tileX: 13.0, tileY: 27.5, particleType: 'firefly', chance: 0.012 },
            { tileX: 5.5, tileY: 11.5, particleType: 'firefly', chance: 0.012 },
            // Building-activity gated smoke plumes. Roof anchors raise the
            // spawn point (worldY -= 22) above each building footprint and
            // the active-building gate tells _updateAmbientEffects
            // to consult the presence map (occupied/busy => spawn ~every 600ms).
            { tileX: 28, tileY: 27, particleType: 'smoke', intervalMs: 600,
              gatedBy: ACTIVE_BUILDING_EMITTER_GATE, building: 'forge', worldYOffset: -22 },
            { tileX: 12, tileY: 32, particleType: 'smoke', intervalMs: 600,
              gatedBy: ACTIVE_BUILDING_EMITTER_GATE, building: 'mine', worldYOffset: -22 },
        ];

        for (const prop of this.commandCenterGroundProps) {
            if (prop.type === 'watchfire') {
                emitters.push({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    particleType: 'torch',
                    chance: 0.022,
                });
            }
        }

        this.ambientEmitters = emitters.map(emitter => ({
            ...emitter,
            ...tileToWorld(emitter.tileX, emitter.tileY),
        }));
    }

    _tileNoise(tileX, tileY) {
        const n = Math.sin(tileX * 12.9898 + tileY * 78.233) * 43758.5453;
        return n - Math.floor(n);
    }

    // Low-frequency value noise in [0, 1]: the per-tile hash sampled on a
    // `scale`-tile lattice, bilinearly interpolated with smoothstep easing.
    // Variation comes out as coherent multi-tile masses instead of per-tile
    // confetti; deterministic and allocation-free, bake/init-side only.
    _smoothNoise(x, y, scale = 6) {
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const n00 = this._tileNoise(x0, y0);
        const n10 = this._tileNoise(x0 + 1, y0);
        const n01 = this._tileNoise(x0, y0 + 1);
        const n11 = this._tileNoise(x0 + 1, y0 + 1);
        const top = n00 + (n10 - n00) * sx;
        const bottom = n01 + (n11 - n01) * sx;
        return top + (bottom - top) * sy;
    }

    // Lerp two '#rrggbb'/'rgb(r,g,b)' colours by t, memoized in the shared
    // colour cache (same style as _withAlpha / _mixToWhite).
    _lerpColor(a, b, t) {
        const mixAmount = this._quantizedColorMix(t);
        const key = `lc|${a}|${b}|${mixAmount}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        const [ar, ag, ab] = this._parseLightColor(a);
        const [br, bg, bb] = this._parseLightColor(b);
        const mix = (u, v) => Math.round(u + (v - u) * mixAmount);
        const out = `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`;
        return this._cacheLightFadeColor(key, out);
    }

    _installDebugGlobal(name, value) {
        if (typeof window === 'undefined' || !name) return;
        if (!this._debugGlobals.has(name)) {
            this._debugGlobals.set(name, {
                hadOwn: Object.prototype.hasOwnProperty.call(window, name),
                previous: window[name],
                value,
            });
        } else {
            this._debugGlobals.get(name).value = value;
        }
        if (value && (typeof value === 'object' || typeof value === 'function')) {
            DEBUG_GLOBAL_OWNERS.set(value, this);
        }
        window[name] = value;
    }

    _installFrameHealthHelper() {
        if (typeof window === 'undefined') return;
        if (!this._frameHealthHelper) {
            this._frameHealthHelper = () => this.frameHealth();
        }
        const existing = window.__claudeVillePerf || {};
        if (existing.frameHealth === this._frameHealthHelper) return;
        window.__claudeVillePerf = {
            ...existing,
            frameHealth: this._frameHealthHelper,
        };
    }

    _releaseFrameHealthHelper() {
        if (typeof window === 'undefined') return;
        const perf = window.__claudeVillePerf;
        if (!perf || perf.frameHealth !== this._frameHealthHelper) return;
        delete perf.frameHealth;
    }

    _releaseDebugGlobals() {
        if (typeof window === 'undefined') {
            this._debugGlobals.clear();
            return;
        }
        for (const [name, entry] of this._debugGlobals) {
            if (window[name] !== entry.value) continue;
            const previousOwner = entry.previous && (typeof entry.previous === 'object' || typeof entry.previous === 'function')
                ? DEBUG_GLOBAL_OWNERS.get(entry.previous)
                : null;
            if (entry.hadOwn && (!previousOwner || previousOwner.running)) window[name] = entry.previous;
            else delete window[name];
        }
        this._debugGlobals.clear();
    }

    show(canvas) {
        if (this._disposed) {
            console.warn('[IsometricRenderer] show skipped: renderer is disposed');
            return false;
        }
        if (!canvas || typeof canvas.getContext !== 'function') {
            console.warn('[IsometricRenderer] show skipped: invalid canvas element');
            return false;
        }
        if (this.running) {
            return true;
        }

        this.canvas = canvas;
        this.fxCanvas = canvas.parentElement?.querySelector?.('#worldFxCanvas') || null;
        this.overlayCanvas = canvas.parentElement?.querySelector?.('#worldOverlayCanvas') || null;
        // alpha:false matches App.js resize; the sky pass repaints the full
        // viewport opaquely every frame (context attributes are fixed by the
        // first getContext call, so every main-canvas site must agree).
        this.ctx = canvas.getContext('2d', { alpha: false });
        if (!this.ctx) {
            console.warn('[IsometricRenderer] show skipped: failed to get 2d context');
            return false;
        }
        this._resizeAuxiliaryBackingStores(canvas.width, canvas.height);
        if (!this.overlayCtx) {
            console.warn('[IsometricRenderer] show skipped: failed to get overlay 2d context');
            return false;
        }
        // The parity, lifecycle, memory, and reference-hardware gates promote
        // the GPU-resident diorama to the default. `?renderer=canvas` keeps the
        // production fallback and `?postfx=0` is the allocation-free escape.
        const params = new URLSearchParams(window.location.search);
        const postFxEnabled = params.get('postfx') !== '0';
        const requestedMode = resolveGpuWorldRendererMode(params, { webgl2: true });
        this.gpuWorld = (postFxEnabled && requestedMode === 'webgl' && this.fxCanvas)
            ? createGpuWorldRenderer({ canvas: this.fxCanvas, enabled: true })
            : null;
        this.worldRendererMode = this.gpuWorld?.isActive?.() ? 'webgl' : 'canvas';
        this.postFx = (!this.gpuWorld && postFxEnabled && this.fxCanvas)
            ? createPostFx({ canvas: this.fxCanvas, enabled: true })
            : null;
        this.postFxFeed = createPostFxFeed();
        this.postFx?.resize?.(canvas.width, canvas.height);
        this.gpuWorld?.resize?.(canvas.width, canvas.height);
        for (const sprite of this.agentSprites.values()) {
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
        }
        this._postFxCanvasVisible = null;
        this._setPostFxCanvasVisible(
            this.gpuWorld?.isActive?.() === true || this.postFx?.isActive?.() === true,
        );
        if (!this.villageDirector) {
            this.villageDirector = new VillageDirector(this.world);
            this.villageDirector.setMotionScale?.(this.motionScale);
            if (this.quotaState) this.villageDirector.setQuotaState?.(this.quotaState);
        }
        this._ensureTrailRenderer();
        this._contextLost = false;
        this.camera = new Camera(canvas);
        this.camera.attach();
        // WeatherRenderer owns the additive Canvas atmosphere overlay. Supplying
        // stable renderer references lets it resolve project agentIds into a
        // local footprint without copying sprite positions every frame. The
        // same overlay canvas sits above both Canvas and GPU world bases.
        this.weatherRenderer?.setDistrictContext?.({
            camera: this.camera,
            agentSprites: this.agentSprites,
        });
        // #21 — cinematic director listens for VillageDirector camera cues and
        // drives time-boxed glides on the camera (abort-on-input is in Camera).
        this.cameraDirector?.dispose?.();
        this.cameraDirector = new CameraDirector(this.camera, { motionScale: this.motionScale });
        // #attract — idle attract camera defaults on; honor the persisted toggle.
        let autoCam = true;
        try { autoCam = window.localStorage?.getItem('cv-auto-camera') !== '0'; } catch (_) { /* storage unavailable */ }
        this.cameraDirector.setAutoMode(autoCam);
        // Re-arm SkyRenderer aurora/shooting-star event wiring; mode toggles
        // detach in hide() and would otherwise leave these subscriptions dead.
        this.skyRenderer?.attach?.();
        this._bindMotionPreference();
        this._setMotionScale(this.motionQuery?.matches ? 0 : 1);
        this.atmosphereState?.installDebugHelper?.();
        if (!this.ritualConductor) {
            this.ritualConductor = new RitualConductor({ motionScale: this.motionScale });
        }

        this.buildingRenderer?.setBuildings(this.world.buildings);
        this.buildingRenderer?.setRitualConductor?.(this.ritualConductor);

        // Create sprites for existing agents
        for (const agent of this.world.agents.values()) {
            this._addAgentSprite(agent);
        }
        this._syncRitualContext();

        this.agentEventStream?.dispose?.();
        this.relationshipState?.dispose?.();
        this.agentEventStream = new AgentEventStream(this.world, {
            shouldEmitToolEvent: (event, agent) => this._canAcceptToolRitual(event, agent),
            shouldEmitEvent: () => this._worldModeActive,
        });
        this.relationshipState = new RelationshipState(this.world);
        this._replayActiveToolRituals({ force: true });
        this._updateVisitSystems(Date.now());
        this._installDebugGlobal('__relationshipState', () => this.relationshipState?.getSnapshot?.());
        this._installDebugGlobal('__visitIntents', () => this.visitIntentManager?.debugSnapshot?.() || null);
        this._installDebugGlobal('__visitReservations', () => this.visitTileAllocator?.debug?.() || null);
        this._installDebugGlobal('__agentBehavior', (agentId) => this.agentSprites.get(agentId)?.getBehaviorDebugSnapshot?.() || null);
        this._installDebugGlobal('__buildingCrowds', () => this.visitTileAllocator?.getBuildingLoads?.() || {});
        this._installDebugGlobal('__agentBehaviorStats', () => this._agentBehaviorStats());
        this._installDebugGlobal('__agentCrowds', () => this._crowdStats || this._summarizeCrowdClusters());
        this._installDebugGlobal('__villageDirector', () => this.villageDirector?.getSnapshot?.() || null);
        this._installDebugGlobal('__worldPerformance', () => this.getWorldPerformanceDiagnostics());
        this._installFrameHealthHelper();

        // Subscribe to domain events
        this._unsubscribers.push(
            eventBus.on('agent:added', (agent) => {
                if (!this._worldModeActive) {
                    this._worldSpritesDirty = true;
                    return;
                }
                this._addAgentSprite(agent);
                this._beginRelationshipArrival(agent);
            }),
            eventBus.on('agent:removed', (agent) => {
                if (!this._worldModeActive) {
                    this._removeAgentSprite(agent.id);
                    this._worldSpritesDirty = true;
                    return;
                }
                const handled = this._beginRelationshipDeparture(agent);
                if (!handled) this._beginAgentGateDeparture(agent);
            }),
            eventBus.on('agent:updated', (agent) => {
                if (!this._worldModeActive) {
                    const sprite = this.agentSprites.get(agent.id);
                    if (sprite?.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                    else if (sprite) sprite.agent = agent;
                    this._worldSpritesDirty = true;
                    return;
                }
                const sprite = this.agentSprites.get(agent.id);
                if (sprite) {
                    if (sprite.applyAgentUpdate) sprite.applyAgentUpdate(agent);
                    else sprite.agent = agent;
                    this._markSpritesDirty();
                }
            }),
            eventBus.on('subagent:dispatched', (payload) => {
                this._invalidateIdleFrame();
                this._enqueueSubagentSummonRitual(payload);
            }),
            // Cache the latest building presence tiers so per-frame emitter
            // gating (forge/mine smoke) can read tier === 'occupied'|'busy'
            // without hot-path enumeration of agent sprites.
            eventBus.on(BUILDING_EVENTS.ACTIVE_AGENTS, (payload) => {
                if (!payload) return;
                this._invalidateIdleFrame();
                this._buildingPresenceMap = new Map(Object.entries(payload));
            }),
            eventBus.on(BUILDING_EVENTS.SELECTED, () => this._invalidateIdleFrame()),
            eventBus.on(BUILDING_EVENTS.DESELECTED, () => this._invalidateIdleFrame()),
            // #39 — celebratory gull scatter: a harbor push-success scatters
            // the flock skyward for a few seconds by lifting the active-gull
            // target toward GULL_MAX_ACTIVE_TARGET. Also records the moment so
            // SeasonalAmbience suppresses decorative drift while the real git
            // reward is on screen.
            eventBus.on('harbor:push-success', () => {
                this._invalidateIdleFrame();
                this._triggerGullScatter();
            }),
            eventBus.on('git:pushed', () => {
                this._invalidateIdleFrame();
                this._triggerGullScatter();
            }),
            // #attract — topbar toggle flips the idle-attract camera live.
            eventBus.on('camera:auto-camera', (payload) => this.cameraDirector?.setAutoMode?.(payload?.enabled !== false)),
            // 4.8 — earned nicknames garnish agent name tags.
            eventBus.on('biography:updated', (payload) => {
                const identityKey = payload?.identityKey;
                if (!identityKey) return;
                this._invalidateIdleFrame();
                const nickname = payload?.biography?.nickname || null;
                this._cacheNickname(identityKey, nickname);
                this._applyNicknames();
            }),
        );

        // Cross-tab nickname refresh: when another tab persists a biography,
        // AgentBiographyService drops its cached copy first (it registered on
        // the channel earlier), so this re-read sees the fresh record.
        if (this.biographyService && this.chronicleStore?.channel?.addEventListener) {
            this._chronicleChannelListener = (event) => {
                const identityKey = event?.data?.identityKey;
                if (this._disposed || event?.data?.type !== 'biography-updated' || !identityKey) return;
                const biographyService = this.biographyService;
                const generation = this._biographyReadGeneration;
                biographyService.getBiography(identityKey).then((biography) => {
                    if (this._disposed || generation !== this._biographyReadGeneration) return;
                    const nickname = biography?.nickname || null;
                    this._cacheNickname(identityKey, nickname);
                    this._applyNicknames();
                    this._invalidateIdleFrame();
                }).catch(() => {});
            };
            this.chronicleStore.channel.addEventListener('message', this._chronicleChannelListener);
        }

        // Click handler for agent selection
        this._onClick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            this._handleClick(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('click', this._onClick);

        // Hover handler for buildings + agents. 3.7 — the agent half is a
        // per-pixel hit-test, so it is rAF-throttled to at most one sweep per
        // frame; scalar fields avoid a per-mousemove allocation.
        this._hoveredAgentSprite = null;
        this._agentHoverRafId = null;
        this._agentHoverX = 0;
        this._agentHoverY = 0;
        this._onMouseMoveMain = (e) => {
            this._invalidateIdleFrame();
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const worldPos = this.camera.screenToWorld(screenX, screenY);
            const hoveredBuilding = this.buildingRenderer?.hitTest(worldPos.x, worldPos.y) ?? null;
            this.buildingRenderer?.setHovered(hoveredBuilding);
            this.villageDirector?.setHoveredBuilding?.(hoveredBuilding);
            const monument = hoveredBuilding ? null : this.chronicleMonuments?.hitTest?.(worldPos.x, worldPos.y, Date.now());
            // 3.6 — harbor lore: hovering a ship surfaces its commit subject.
            const hoveredShip = (hoveredBuilding || monument)
                ? null
                : (this.harborTraffic?.hitTestShip?.(worldPos.x, worldPos.y) ?? null);
            this.harborTraffic?.setHoveredShip?.(hoveredShip ? hoveredShip.id : null);
            const bridgeLantern = (hoveredBuilding || monument || hoveredShip)
                ? null
                : (this.bridgeLanterns?.hitTest?.(worldPos.x, worldPos.y, Date.now()) ?? null);
            this.bridgeLanterns?.setHovered?.(bridgeLantern);
            const tokenItem = (hoveredBuilding || monument || hoveredShip || bridgeLantern)
                ? null
                : (this.landmarkActivity?.hitTestTokenItem?.(worldPos.x, worldPos.y) ?? null);
            canvas.title = hoveredBuilding
                ? this._buildingVisitorTooltip(hoveredBuilding)
                : (monument
                    ? this.chronicleMonuments.tooltipFor(monument, Date.now())
                    : (hoveredShip
                        ? this.harborTraffic.shipTooltip(hoveredShip)
                        : (bridgeLantern
                            ? this.bridgeLanterns.tooltipFor(bridgeLantern, Date.now())
                            : (tokenItem ? this.landmarkActivity.tokenItemTooltip(tokenItem) : ''))));
            this._scheduleAgentHoverTest(worldPos.x, worldPos.y);
        };
        canvas.addEventListener('mousemove', this._onMouseMoveMain);
        this._onMouseLeaveMain = () => {
            if (this._agentHoverRafId !== null) {
                cancelAnimationFrame(this._agentHoverRafId);
                this._agentHoverRafId = null;
            }
            this._setHoveredAgentSprite(null);
            this.buildingRenderer?.setHovered(null);
            this.villageDirector?.setHoveredBuilding?.(null);
            this.harborTraffic?.setHoveredShip?.(null);
            this.bridgeLanterns?.setHovered?.(null);
            canvas.title = '';
        };
        canvas.addEventListener('mouseleave', this._onMouseLeaveMain);
        this._onKeyDown = (e) => {
            if (e.code === 'KeyD' && e.shiftKey) void this._toggleDebugOverlay('toggle');
            if (e.code === 'KeyP' && e.shiftKey) void this._toggleDebugOverlay('togglePathDebug');
            this._handleWorldKeyboardCommand(e);
        };
        window.addEventListener('keydown', this._onKeyDown);
        this._onReadKeyUp = (event) => {
            if (event.code === 'KeyB') this.setReadMode(false);
        };
        this._onReadBlur = () => this.setReadMode(false);
        window.addEventListener('keyup', this._onReadKeyUp);
        window.addEventListener('blur', this._onReadBlur);
        this._onModeChanged = (mode) => this.setWorldModeActive(mode !== 'dashboard');
        this._unsubscribers.push(eventBus.on('mode:changed', this._onModeChanged));

        this.running = true;
        this._startLoop();
        return true;
    }

    setReadMode(on) {
        const next = Boolean(on);
        if (this._readMode === next) return;
        this._readMode = next;
        this._invalidateIdleFrame();
    }

    getReadMode() {
        return Boolean(this._readMode);
    }

    _toggleDebugOverlay(method) {
        if (this.debugOverlay) {
            this.debugOverlay[method]?.();
            this._invalidateIdleFrame();
            return Promise.resolve(true);
        }
        if (!this._debugOverlayModulePromise) {
            this._debugOverlayModulePromise = import('./DebugOverlay.js');
        }
        return this._debugOverlayModulePromise.then((module) => {
            if (this._disposed || !module.DebugOverlay) return false;
            if (!this.debugOverlay) this.debugOverlay = new module.DebugOverlay();
            this.debugOverlay[method]?.();
            this._invalidateIdleFrame();
            return true;
        }).catch((error) => {
            console.warn('[IsometricRenderer] Debug overlay unavailable:', error.message);
            this._debugOverlayModulePromise = null;
            return false;
        });
    }

    hide() {
        if (this._disposed) return;
        this._disposed = true;
        this._biographyReadGeneration++;
        this._worldResourceGeneration++;
        this.running = false;
        this._stopLoop();
        this.postFx?.dispose?.();
        this.postFx = null;
        this.gpuWorld?.dispose?.();
        this.gpuWorld = null;
        this.worldRendererMode = 'canvas';
        this.postFxFeed?.dispose?.();
        this.postFxFeed = null;
        this._setPostFxCanvasVisible(false);
        if (this.camera) {
            this.camera.detach();
        }
        this.cameraDirector?.dispose?.();
        this.cameraDirector = null;
        this._offscreenCueState?.dispose?.();
        this._unbindMotionPreference();
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._unsubscribers = [];
        if (this.canvas) {
            this.canvas.removeEventListener('click', this._onClick);
            this.canvas.removeEventListener('mousemove', this._onMouseMoveMain);
            this.canvas.removeEventListener('mouseleave', this._onMouseLeaveMain);
            this.canvas.title = '';
        }
        if (this._agentHoverRafId !== null) {
            cancelAnimationFrame(this._agentHoverRafId);
            this._agentHoverRafId = null;
        }
        this._setHoveredAgentSprite(null);
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
        window.removeEventListener('keyup', this._onReadKeyUp);
        window.removeEventListener('blur', this._onReadBlur);
        this.setReadMode(false);
        if (this._chronicleChannelListener && this.chronicleStore?.channel?.removeEventListener) {
            this.chronicleStore.channel.removeEventListener('message', this._chronicleChannelListener);
        }
        this._chronicleChannelListener = null;
        this._onModeChanged = null;
        this.chronicler?.destroy?.();
        this._sortedSprites = [];
        this._allSpritesSnapshot.length = 0;
        this._visibleSortedSprites.length = 0;
        this._visibleSpriteCandidates.clear();
        this._overlayPrioritizedSprites.length = 0;
        this._overlayBubbleSprites.length = 0;
        this._overlayBubbleOrder.length = 0;
        this._overlayBubbleBaseRects.length = 0;
        this._agentLabelHitRects.length = 0;
        this._overlayCompactRects.length = 0;
        this._overlayNameRects.length = 0;
        this._overlayReservedRects.length = 0;
        this._overlayBubbleOccupiedRects.length = 0;
        this._overlayCompactGrid.buckets.clear();
        this._overlayNameGrid.buckets.clear();
        this._overlayBubbleGrid.buckets.clear();
        this._overlayClusterGrid.buckets.clear();
        this._spritesNeedSort = true;
        this._suspendWorldModeResources();
        this.agentSprites.clear();
        this._nicknames.clear();
        AgentSprite.releaseSharedCaches?.();
        this.compositor?.dispose?.();
        this.gateTransits.clear();
        this.particleSystem.clear();
        this.buildingRenderer?.dispose?.();
        this.releaseVolatileCaches();
        this.trailRenderer?.dispose?.();
        this.trailRenderer = null;
        this.agentEventStream?.dispose?.();
        releaseCouncilRingState(this.relationshipState);
        this.relationshipState?.dispose?.();
        this.harborTraffic?.dispose?.();
        this.landmarkActivity?.dispose?.();
        this.chronicleMonuments?.dispose?.();
        this.ritualConductor?.dispose?.();
        this.villageDirector?.dispose?.();
        if (getActiveMarkGovernor() === this.markGovernor) setActiveMarkGovernor(null);
        this._releaseFrameHealthHelper();
        this._releaseDebugGlobals();
        this.agentEventStream = null;
        this.relationshipState = null;
        this.ritualConductor = null;
        this.villageDirector = null;
        this.visitIntentManager?.dispose?.();
        this.visitTileAllocator?.dispose?.();
        this._crowdBumpCooldowns.clear();
        this._buildingPresenceMap.clear();
        this._emitterIntervalLastMs.clear();
        this.foliageRenderer?.clear?.();
        this._atmosphereEffectSpriteCache.clear();
        this.weatherRenderer?.dispose?.();
        this.skyRenderer?.detach?.();
        this.skyRenderer?.releaseCache?.();
        this.atmosphereState?.dispose?.();
        // SeasonalAmbience holds no resources today; the optional chain keeps
        // the lifecycle hook in place if a dispose method lands.
        this.seasonalAmbience?.dispose?.();
        this.overlayCtx = null;
        this.overlayCanvas = null;
        this.fxCanvas = null;
    }

    _startLoop() {
        if (
            !this.running
            || this._disposed
            || this.frameId !== null
            || !this._worldModeActive
            || this._worldResourcesSuspended
            || this._contextLost
            || this._frameFailureStats.paused
        ) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        this.frameId = requestAnimationFrame(() => this._loop());
    }

    _stopLoop() {
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this._fpsFrames = 0;
        this._fpsWindowStart = null;
        eventBus.emit('fps:updated', null);
    }

    setWorldModeActive(active) {
        const nextActive = Boolean(active);
        if (this._worldModeActive === nextActive) {
            if (!nextActive) this._suspendWorldModeResources();
            return;
        }
        this._worldModeActive = nextActive;
        this._lastFrameTime = performance.now();
        if (nextActive) {
            void this._beginWorldModeResume();
        } else {
            this._worldResourceGeneration++;
            this._stopLoop();
            this._suspendWorldModeResources();
        }
    }

    pauseForVisibility() {
        this._worldResourceGeneration++;
        this._stopLoop();
        if (this._worldResourcesSuspended) this.assets?.suspend?.();
        this.releaseVolatileCaches();
    }

    resumeFromVisibility({ active = true } = {}) {
        this._worldModeActive = Boolean(active);
        this._lastFrameTime = performance.now();
        if (this._worldModeActive) {
            void this._beginWorldModeResume();
        } else {
            this._worldResourceGeneration++;
            this._stopLoop();
            this._suspendWorldModeResources();
        }
    }

    handleContextLost() {
        this._contextLost = true;
        this._stopLoop();
        this.releaseVolatileCaches();
    }

    handleContextRestored() {
        this.ctx = this.canvas?.getContext?.('2d') || null;
        this._contextLost = false;
        if (this._worldModeActive) this.trailRenderer?.resume?.();
        this._resumeFrameFailures();
        this.invalidateViewportCaches();
        this.camera?.onViewportResize?.();
        this._lastFrameTime = performance.now();
        if (this._worldModeActive) this._startLoop();
    }

    releaseVolatileCaches() {
        releaseCanvasBackingStore(this.terrainCache);
        this.terrainCache = null;
        this.terrainCacheKey = '';
        this.terrainCacheBounds = null;
        this.terrainCacheMeta = null;
        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        releaseCanvasBackingStore(this._fastVignetteStamp);
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        releaseCanvasMap(this.lightGradientCache);
        this.lightFadeColorCache?.clear?.();
        this.lightColorRgbCache?.clear?.();
        this.skyRenderer?.releaseCache?.();
        this.trailRenderer?.pause?.();
        this.weatherRenderer?.dispose?.();
        // The water mask is a viewport-sized volatile surface like the rest of
        // this list; `fillWater` rebuilds it on the next frame. Without this it
        // survived context loss, which the lifecycle smoke reports as leaked
        // volatile pixels.
        this.postFxFeed?.dispose?.();
        releaseCanvasBackingStore(this._semanticGroundCanvas);
        this._semanticGroundCanvas = null;
        this._semanticGroundKey = null;
        releaseCanvasBackingStore(this._gpuAgentOccluderAtlas);
        this._gpuAgentOccluderAtlas = null;
        this._gpuAgentOccluderAtlasState = null;
        releaseCanvasMap(this._gpuAgentOccluderUpdateCanvases);
        this._gpuAgentOccluderUpdateCanvases = null;
        this._gpuAgentOccluderTextureUpdates = [];
        releaseCanvasBackingStore(this._gpuAgentFrameAtlas);
        this._gpuAgentFrameAtlas = null;
        releaseCanvasBackingStore(this._gpuAgentMaterialAtlas);
        this._gpuAgentMaterialAtlas = null;
        releaseCanvasBackingStore(this._gpuAgentEmissiveAtlas);
        this._gpuAgentEmissiveAtlas = null;
        this._gpuAgentMaterialAtlasState = null;
        this._gpuAgentEmissiveAtlasState = null;
        releaseCanvasMap(this._gpuAgentAlbedoUpdateCanvases);
        releaseCanvasMap(this._gpuAgentMaterialUpdateCanvases);
        releaseCanvasMap(this._gpuAgentEmissiveUpdateCanvases);
        this._gpuAgentAlbedoUpdateCanvases = null;
        this._gpuAgentMaterialUpdateCanvases = null;
        this._gpuAgentEmissiveUpdateCanvases = null;
        this._gpuAgentAlbedoTextureUpdates = [];
        this._gpuAgentMaterialTextureUpdates = [];
        this._gpuAgentEmissiveTextureUpdates = [];
        this._gpuAgentFrameAtlasSignature = '';
        this._gpuAgentFrameAtlasRevision = 0;
        this._gpuAgentAtlasSlots?.clear?.();
        this._gpuAgentAtlasFrameKeys?.clear?.();
        this._gpuAgentAtlasPoses?.clear?.();
        this._gpuAgentAtlasNextSlot = 0;
        this._gpuAgentAtlasRosterSignature = '';
        this._gpuAgentAtlasUpdatedAt = 0;
        for (const entry of this._gpuPackedMaterialSidecars?.values?.() || []) {
            releaseCanvasBackingStore(entry?.canvas);
        }
        this._gpuPackedMaterialSidecars?.clear?.();
        releaseCanvasBackingStore(this._gpuTerrainMaterialSidecar?.canvas);
        this._gpuTerrainMaterialSidecar = null;
    }

    _ensureTrailRenderer() {
        if (this.trailRenderer) return;
        this.trailRenderer = new TrailRenderer({
            store: this.chronicleStore,
            world: this.world,
            sprites: this.agentSprites,
            motionScale: this.motionScale,
        });
    }

    _suspendWorldModeResources() {
        // Always forward suspension so an in-flight decoded-asset reload is
        // aborted even when the renderer already released its own surfaces.
        this.assets?.suspend?.();
        if (this._worldResourcesSuspended) return;
        this.releaseVolatileCaches();
        for (const sprite of this.agentSprites.values()) sprite?.releaseRenderResources?.();
        AgentSprite.releaseSharedCaches?.();
        this.compositor?.releaseCache?.();
        this.foliageRenderer?.releaseCache?.();
        this._atmosphereEffectSpriteCache.clear();
        const staticSprites = new Set(
            this._staticPropDrawables.map(drawable => drawable?.payload?.sprite).filter(Boolean),
        );
        for (const sprite of staticSprites) sprite.releaseCache?.();
        this.postFxFeed?.dispose?.();
        this.postFx?.suspend?.();
        this.gpuWorld?.suspend?.();
        releaseCanvasBackingStore(this.fxCanvas);
        releaseCanvasBackingStore(this.canvas);
        // The UI surface is as volatile as the world backing store; keeping it
        // alive in Dashboard mode would retain a full-screen alpha canvas.
        releaseCanvasBackingStore(this.overlayCanvas);
        this._worldResourcesSuspended = true;
    }

    _beginWorldModeResume() {
        if (
            this._disposed
            || !this.running
            || !this._worldModeActive
            || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) return Promise.resolve(false);

        const generation = ++this._worldResourceGeneration;
        this._stopLoop();
        const operation = Promise.resolve()
            .then(() => this._resumeWorldModeResources())
            .then((ready) => {
                if (
                    !ready
                    || this._disposed
                    || !this.running
                    || !this._worldModeActive
                    || generation !== this._worldResourceGeneration
                ) return false;
                this._resumeFrameFailures();
                if (this._worldSpritesDirty) this._reconcileSpritesWithWorld();
                this.invalidateViewportCaches();
                this._startLoop();
                return this.frameId !== null;
            })
            .catch((err) => {
                if (
                    !this._disposed
                    && this._worldModeActive
                    && generation === this._worldResourceGeneration
                ) {
                    this._worldResumeFailures++;
                    console.error('[IsometricRenderer] World asset resume failed:', err);
                }
                return false;
            });
        const wrapped = operation.finally(() => {
            if (this._worldResumePromise === wrapped) this._worldResumePromise = null;
        });
        this._worldResumePromise = wrapped;
        return wrapped;
    }

    async _resumeWorldModeResources() {
        if (!this._worldResourcesSuspended) {
            this.trailRenderer?.resume?.();
            return true;
        }
        if (this.assets?.resume) {
            const assetsReady = await this.assets.resume();
            if (!assetsReady) return false;
        }
        if (this._disposed || !this._worldModeActive || !this._worldResourcesSuspended) return false;
        const width = Math.round(
            (this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || 0)
            * (this.canvas?._claudeVilleDpr || 1),
        );
        const height = Math.round(
            (this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || 0)
            * (this.canvas?._claudeVilleDpr || 1),
        );
        if (this.canvas && width > 0 && height > 0) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.ctx = this.canvas.getContext('2d', { alpha: false });
            if (this.ctx) SpriteRenderer.disableSmoothing(this.ctx);
            this._resizeAuxiliaryBackingStores(width, height);
        }
        this.postFx?.resume?.();
        this.gpuWorld?.resume?.();
        for (const sprite of this.agentSprites.values()) {
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
        }
        this.trailRenderer?.resume?.();
        this._worldResourcesSuspended = false;
        this.camera?.onViewportResize?.();
        return true;
    }

    _reconcileSpritesWithWorld() {
        const liveIds = new Set(this.world?.agents?.keys?.() || []);
        for (const agentId of Array.from(this.agentSprites.keys())) {
            if (!liveIds.has(agentId)) this._removeAgentSprite(agentId);
        }
        for (const agent of this.world?.agents?.values?.() || []) {
            this._addAgentSprite(agent);
        }
        this._worldSpritesDirty = false;
    }

    _markSpritesDirty() {
        this._spritesNeedSort = true;
        this._invalidateIdleFrame();
    }

    _snapshotAllSprites() {
        const sprites = this._allSpritesSnapshot;
        sprites.length = 0;
        for (const sprite of this.agentSprites.values()) sprites.push(sprite);
        return sprites;
    }

    _agentVisibleOnScreen(sprite, viewport = this._screenViewport(), margin = AGENT_SCREEN_CULL_MARGIN) {
        if (!sprite || !viewport || !this.camera) return true;
        const point = this.camera.worldToScreen(sprite.x, sprite.y);
        return point.x >= -margin
            && point.x <= viewport.width + margin
            && point.y >= -margin
            && point.y <= viewport.height + margin;
    }

    _snapshotSortedSprites() {
        const viewport = this._screenViewport();
        const candidates = this._visibleSpriteCandidates;
        candidates.clear();
        let rosterOrder = 0;
        for (const sprite of this.agentSprites.values()) {
            sprite._rendererRosterOrder = rosterOrder++;
            if (this._agentVisibleOnScreen(sprite, viewport)) candidates.add(sprite);
        }

        // Retain the previous visible order so the common case only needs a
        // monotonicity scan. Remove sprites that left the apron in place, then
        // append newly-visible sprites before repairing the near-sorted list.
        const visible = this._visibleSortedSprites;
        let next = 0;
        for (let i = 0; i < visible.length; i++) {
            const sprite = visible[i];
            if (!candidates.has(sprite)) continue;
            visible[next++] = sprite;
            candidates.delete(sprite);
        }
        visible.length = next;
        for (const sprite of this.agentSprites.values()) {
            if (candidates.has(sprite)) visible.push(sprite);
        }

        let ordered = true;
        for (let i = 1; i < visible.length; i++) {
            const previous = visible[i - 1];
            const current = visible[i];
            if (
                previous.y > current.y
                || (previous.y === current.y && previous._rendererRosterOrder > current._rendererRosterOrder)
            ) {
                ordered = false;
                break;
            }
        }
        if (!ordered) {
            // Agent motion is continuous, so the previous frame is almost
            // sorted. Insertion repair is linear for unchanged relative order
            // and moves only sprites that actually crossed in Y.
            for (let i = 1; i < visible.length; i++) {
                const sprite = visible[i];
                let insertAt = i;
                while (insertAt > 0) {
                    const previous = visible[insertAt - 1];
                    if (
                        previous.y < sprite.y
                        || (
                            previous.y === sprite.y
                            && previous._rendererRosterOrder <= sprite._rendererRosterOrder
                        )
                    ) break;
                    visible[insertAt] = visible[insertAt - 1];
                    insertAt--;
                }
                visible[insertAt] = sprite;
            }
        }
        this._sortedSprites = visible;
        this._spritesNeedSort = false;
        return visible;
    }

    _enumeratePropDrawables() {
        if (this._shouldUseFastStaticProps()) {
            return this._enumerateFastPropDrawables();
        }
        return this._enumerateVisibleStaticPropDrawables();
    }

    _buildStaticPropDrawables() {
        return buildStaticPropDrawables(
            this.treePropSprites,
            this.boulderPropSprites,
            this.districtPropSprites
        );
    }

    _buildStaticPropFastDrawables() {
        return (this._staticPropSprites || []).map((sprite) => ({
            sprite,
            whole: this._cachedPropDepthDrawable(sprite),
            back: sprite.splitForOcclusion ? this._cachedPropDepthDrawable(sprite, 'back') : null,
            front: sprite.splitForOcclusion ? this._cachedPropDepthDrawable(sprite, 'front') : null,
        }));
    }

    _enumerateVisibleStaticPropDrawables() {
        const viewport = this._screenViewport();
        if (!viewport || !this.camera) return this._staticPropDrawables;
        const out = this._staticPropVisibleFrameDrawables;
        out.length = 0;
        for (const drawable of this._staticPropDrawables || []) {
            const sprite = drawable?.payload?.sprite;
            if (!sprite || this._propVisibleOnScreen(sprite, viewport)) out.push(drawable);
        }
        return out;
    }

    _cachedPropDepthDrawable(sprite, part = 'whole') {
        const kind = part === 'whole' ? 'prop' : `prop-${part}`;
        const sortY = part === 'back'
            ? sprite.propBackSortY()
            : part === 'front'
                ? sprite.propFrontSortY()
                : sprite.sortY ?? sprite.y;
        return createDepthDrawable(kind, sortY, { sprite, part }, (ctx, zoom, _context, payload) => {
            payload?.sprite?.drawCachedPart?.(ctx, payload.part || 'whole', zoom);
        });
    }

    _shouldUseFastStaticProps() {
        if ((this.camera?.zoom || 1) < FAST_PROP_MIN_ZOOM) return false;
        return this._screenWidth() * this._screenHeight() >= FAST_PROP_CSS_PIXELS;
    }

    _enumerateFastPropDrawables() {
        const out = this._staticPropFastFrameDrawables;
        out.length = 0;
        const agents = this._snapshotSortedSprites();
        const viewport = this._screenViewport();
        for (const record of this._staticPropFastDrawables || []) {
            if (!this._propVisibleOnScreen(record.sprite, viewport)) continue;
            if (record.sprite?.splitForOcclusion && this._propIntersectsAgentBand(record.sprite, agents)) {
                if (record.back) out.push(record.back);
                if (record.front) out.push(record.front);
            } else if (record.whole) {
                out.push(record.whole);
            }
        }
        return out;
    }

    _propVisibleOnScreen(prop, viewport) {
        if (!prop || !viewport || !this.camera) return true;
        const bounds = prop.bounds || { left: -48, right: 48, top: -96, bottom: 24 };
        const topLeft = this.camera.worldToScreen(prop.x + bounds.left, prop.y + bounds.top);
        const bottomRight = this.camera.worldToScreen(prop.x + bounds.right, prop.y + bounds.bottom);
        const left = Math.min(topLeft.x, bottomRight.x);
        const right = Math.max(topLeft.x, bottomRight.x);
        const top = Math.min(topLeft.y, bottomRight.y);
        const bottom = Math.max(topLeft.y, bottomRight.y);
        return right >= -FAST_PROP_SCREEN_MARGIN
            && left <= viewport.width + FAST_PROP_SCREEN_MARGIN
            && bottom >= -FAST_PROP_SCREEN_MARGIN
            && top <= viewport.height + FAST_PROP_SCREEN_MARGIN;
    }

    _propIntersectsAgentBand(prop, agents) {
        const bounds = prop?.bounds;
        if (!bounds || !agents?.length) return false;
        const left = prop.x + bounds.left - FAST_PROP_AGENT_MARGIN;
        const right = prop.x + bounds.right + FAST_PROP_AGENT_MARGIN;
        const top = prop.y + bounds.top - FAST_PROP_AGENT_MARGIN;
        const bottom = prop.y + bounds.bottom + FAST_PROP_AGENT_MARGIN;
        for (const sprite of agents) {
            if (!sprite || this._isGateTransit(sprite, 'departure')) continue;
            if (sprite.x < left || sprite.x > right || sprite.y < top || sprite.y > bottom) continue;
            return true;
        }
        return false;
    }

    _bindMotionPreference() {
        if (this._motionPreferenceBound || !this.motionQuery || !this._onMotionPreferenceChange) return;
        if (this.motionQuery.addEventListener) {
            this.motionQuery.addEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery.addListener) {
            this.motionQuery.addListener(this._onMotionPreferenceChange);
        } else {
            return;
        }
        this._motionPreferenceBound = true;
    }

    _unbindMotionPreference() {
        if (!this._motionPreferenceBound || !this.motionQuery || !this._onMotionPreferenceChange) return;
        if (this.motionQuery.removeEventListener) {
            this.motionQuery.removeEventListener('change', this._onMotionPreferenceChange);
        } else if (this.motionQuery.removeListener) {
            this.motionQuery.removeListener(this._onMotionPreferenceChange);
        }
        this._motionPreferenceBound = false;
    }

    _setMotionScale(scale) {
        this._invalidateIdleFrame();
        this.motionScale = scale;
        this.buildingRenderer?.setMotionScale(scale);
        this.ritualConductor?.setMotionScale(scale);
        this.arrivalDeparture?.setMotionScale(scale);
        this.trailRenderer?.setMotionScale(scale);
        this.chronicler?.setMotionScale(scale);
        this.villageDirector?.setMotionScale(scale);
        this.harborTraffic?.setMotionScale(scale);
        this.landmarkActivity?.setMotionScale(scale);
        this.camera?.setReducedMotion?.(scale <= 0);
        this.cameraDirector?.setMotionScale?.(scale);
        this.particleSystem.setMotionEnabled(scale > 0);
        for (const sprite of this.agentSprites.values()) {
            sprite.setMotionScale(scale);
        }
        if (scale <= 0) {
            const departures = [];
            for (const [agentId, transit] of this.gateTransits.entries()) {
                if (transit.type === 'departure') {
                    departures.push(agentId);
                } else {
                    const sprite = this.agentSprites.get(agentId);
                    sprite?.setTilePosition?.(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY);
                    this.gateTransits.delete(agentId);
                }
            }
            for (const agentId of departures) this._removeAgentSprite(agentId);
        }
    }

    get motionTimeMs() {
        return this._motionClock?.elapsedMs ?? 0;
    }

    setQuotaState(state) {
        const quota = state?.quota || state || null;
        this.quotaState = quota;
        this.buildingRenderer?.setQuotaState?.(quota);
        this.villageDirector?.setQuotaState?.(quota);
    }

    setCameraPose({ x, y, camX, camY, zoom } = {}) {
        if (!this.camera) return false;
        const nextZoom = Number(zoom);
        if (Number.isFinite(nextZoom) && nextZoom > 0) {
            this.camera.zoom = this.camera.resolveRestingZoom?.(nextZoom)
                ?? Math.max(this.camera.minZoom || 1, Math.min(this.camera.maxZoom || 3, nextZoom));
            this.camera._zoomAnimation = null;
        }

        const centerX = Number.isFinite(Number(x)) ? Number(x) : Number(camX);
        const centerY = Number.isFinite(Number(y)) ? Number(y) : Number(camY);
        if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
            const viewportWidth = this.camera.canvas?._claudeVilleCssWidth
                || this.camera.canvas?.clientWidth
                || this.camera.canvas?.width
                || 0;
            const viewportHeight = this.camera.canvas?._claudeVilleCssHeight
                || this.camera.canvas?.clientHeight
                || this.camera.canvas?.height
                || 0;
            this.camera.stopFollow?.();
            this.camera.x = -centerX + viewportWidth / (2 * this.camera.zoom);
            this.camera.y = -centerY + viewportHeight / (2 * this.camera.zoom);
        }

        this.camera._clampToBounds?.();
        if (this._worldModeActive) this._startLoop();
        return {
            x: this.camera.x,
            y: this.camera.y,
            zoom: this.camera.zoom,
        };
    }

    _cameraAgentFrameWeight(sprite) {
        const agent = sprite?.agent;
        if (!agent) return 0;
        let weight = 0;
        switch (agent.status) {
            case AgentStatus.ERRORED:
            case AgentStatus.RATE_LIMITED:
            case AgentStatus.WAITING_ON_USER:
                weight = 4;
                break;
            case AgentStatus.WAITING:
                weight = 3;
                break;
            case AgentStatus.WORKING:
                weight = 2;
                break;
            default:
                weight = 0;
        }
        if (sprite?.moving) weight += 1;
        if (agent.currentTool) weight += 1;
        return weight;
    }

    _agentBuildingFramePoint(agent) {
        const type = normalizeBuildingType(
            agent?.targetBuildingType
            || agent?.lastKnownBuildingType
            || agent?.buildingType
            || agent?.building,
        );
        if (!type) return null;
        const building = this.world?.buildings?.get?.(type);
        const center = building ? buildingCenterToWorld(building) : null;
        return Number.isFinite(center?.x) && Number.isFinite(center?.y) ? center : null;
    }

    _worldBoxForCameraPoints(points) {
        const finite = (points || []).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (!finite.length) return null;
        const xs = finite.map(p => p.x);
        const ys = finite.map(p => p.y);
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    }

    _contentFrameBox() {
        const activePoints = [];
        const allAgentPoints = [];
        for (const sprite of this.agentSprites.values()) {
            if (Number.isFinite(sprite?.x) && Number.isFinite(sprite?.y)) {
                const point = { x: sprite.x, y: sprite.y };
                allAgentPoints.push(point);
                if (this._cameraAgentFrameWeight(sprite) > 0) {
                    activePoints.push(point);
                    const buildingPoint = this._agentBuildingFramePoint(sprite.agent);
                    if (buildingPoint) activePoints.push(buildingPoint);
                }
            }
        }

        const hotBuildingPoints = [];
        const buildingSignals = this.villageDirector?.getSnapshot?.()?.buildingSignals || [];
        for (const signal of buildingSignals.slice(0, 3)) {
            if ((Number(signal?.heat) || 0) < 0.18) continue;
            if (Number.isFinite(signal?.center?.x) && Number.isFinite(signal?.center?.y)) {
                hotBuildingPoints.push({ x: signal.center.x, y: signal.center.y });
            }
        }

        if (activePoints.length) {
            return this._worldBoxForCameraPoints([...activePoints, ...hotBuildingPoints.slice(0, 2)]);
        }
        if (hotBuildingPoints.length) return this._worldBoxForCameraPoints(hotBuildingPoints);
        if (allAgentPoints.length) return this._worldBoxForCameraPoints(allAgentPoints);

        const buildingPoints = [];
        if (this.world?.buildings) {
            for (const building of this.world.buildings.values()) {
                const center = buildingCenterToWorld(building);
                if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) {
                    buildingPoints.push(center);
                }
            }
        }
        return this._worldBoxForCameraPoints(buildingPoints);
    }

    // Frame the camera on live work first (fallback: hot buildings, all agents,
    // building centers, then map core) so ClaudeVille opens on the village story
    // rather than a diluted all-sprite overview.
    frameContent() {
        if (!this.camera) return;
        const targetBox = this._contentFrameBox();
        if (!targetBox) {
            this.camera.centerOnMap();
            this.camera._userAdjusted = false;
            return;
        }

        // #45 — first World paint gets a cinematic establishing shot: hold the
        // island-wide frame, then glide+zoom in to settle on the active cluster.
        // The flag is set only when the shot actually starts (5.7), so a failed
        // attempt (e.g. missing viewport) retries on the next re-frame.
        if (!this._didEstablishingShot) {
            if (this.camera.establishingShot(this._fullIslandWorldBox(), targetBox, { maxZoom: 1.5 })) {
                this._didEstablishingShot = true;
                return;
            }
        }

        // 5.7 — subsequent re-frames (resize, the F key) take a short glide
        // instead of an instant snap; glideToWorld cuts directly under reduced
        // motion, and fitToWorldBox stays as the no-viewport fallback.
        if (this.camera.glideToWorld(targetBox, { duration: 700, owner: 'system', maxZoom: 1.5 })) return;
        this.camera.fitToWorldBox(targetBox, { maxZoom: 1.5 });
        this.camera._userAdjusted = false;
    }

    // #45 — the full island's axis-aligned world box, framing the whole iso
    // diamond for the opening overview hold.
    _fullIslandWorldBox() {
        const corners = [
            tileToWorld(0, 0),
            tileToWorld(MAP_SIZE, 0),
            tileToWorld(MAP_SIZE, MAP_SIZE),
            tileToWorld(0, MAP_SIZE),
        ];
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys),
        };
    }


    applyScenarioMetadata(metadata = {}) {
        if (!metadata || typeof metadata !== 'object') return false;
        this._scenarioMetadata = JSON.parse(JSON.stringify(metadata));

        const atmosphere = metadata.atmosphere || {};
        const motionScale = Number(
            atmosphere.motion?.motionScale
            ?? metadata.motionScale
            ?? (metadata.reducedMotion ? 0 : NaN)
        );
        if (Number.isFinite(motionScale)) {
            this._setMotionScale(Math.max(0, Math.min(1, motionScale)));
        }

        const clock = atmosphere.clock || null;
        const hour = Number(clock?.hours);
        if (Number.isFinite(hour)) {
            const minutes = Number(clock?.minutes);
            const seconds = Number(clock?.seconds);
            const hourValue = hour
                + (Number.isFinite(minutes) ? minutes / 60 : 0)
                + (Number.isFinite(seconds) ? seconds / 3600 : 0);
            this.atmosphereState?.setHour?.(hourValue);
            this.atmosphereState?.setTimelineMode?.('fixed');
        }

        if (atmosphere.weather) {
            this.atmosphereState?.setWeather?.(atmosphere.weather);
        }

        const camera = metadata.camera || {};
        const centerTile = camera.centerTile || null;
        if (centerTile) {
            const tileX = Number(centerTile.tileX);
            const tileY = Number(centerTile.tileY);
            if (Number.isFinite(tileX) && Number.isFinite(tileY)) {
                const center = tileToWorld(tileX, tileY);
                this.setCameraPose({ x: center.x, y: center.y, zoom: camera.zoom });
            }
        } else if (camera.zoom != null) {
            this.setCameraPose({ zoom: camera.zoom });
        }

        this.setPinnedAgentIds(metadata.pinnedAgentIds || []);

        if (metadata.selectedAgentId) {
            this.selectAgentById(metadata.selectedAgentId);
            if (this.selectedAgent && this.onAgentSelect) this.onAgentSelect(this.selectedAgent);
        }

        const selectedBuildingType = metadata.selectedBuildingType || metadata.selectedBuilding || null;
        if (selectedBuildingType) {
            const building = this._getBuildingByType(selectedBuildingType);
            if (building) {
                this.villageDirector?.setSelectedBuilding?.(building);
                eventBus.emit(BUILDING_EVENTS.SELECTED, building);
            }
        }

        if (metadata.replayActive === true) {
            this.villageDirector?.setReplayActive?.(true);
        }
        if (metadata.releaseParade) {
            this.villageDirector?.triggerReleaseParade?.(metadata.releaseParade);
        }

        return true;
    }

    _getBuildingByType(type) {
        const normalized = normalizeBuildingType(type);
        return normalized ? this.world?.buildings?.get?.(normalized) || null : null;
    }

    _allocateVisitTile(request = {}) {
        const building = request.building || this._getBuildingByType(request.intent?.building);
        return this.visitTileAllocator?.allocate?.({
            ...request,
            building,
        }) || null;
    }

    _getAmbientDestination({ agent, recentBuildings = [], cycle = 0 } = {}) {
        if (!agent?.id) return null;
        const seed = Math.abs(Math.floor(this._tileNoise(agent.id.length + cycle * 7, cycle + String(agent.id).charCodeAt(0)) * 100000));
        const recent = new Set(recentBuildings);
        const provider = String(agent.provider || '').toLowerCase();
        const model = String(agent.model || '').toLowerCase();
        const sprite = this.agentSprites.get(agent.id);
        const sourceTile = sprite?._screenToTile?.(sprite.x, sprite.y) || agent.position || null;
        const weighted = AMBIENT_SCENIC_POINTS
            .map((point, index) => {
                let score = index * 0.1 + ((seed + index * 17) % 37);
                if (sourceTile) score += Math.hypot((sourceTile.tileX || 0) - point.tileX, (sourceTile.tileY || 0) - point.tileY) * 1.4;
                if (recent.has(`ambient:${point.id}`)) score += 80;
                if (provider === 'gemini' && point.tags?.includes('observatory')) score -= 12;
                if (provider === 'codex' && point.tags?.includes('forge')) score -= 10;
                if (provider === 'claude' && point.tags?.includes('command')) score -= 8;
                if (provider === 'kimi' && point.tags?.includes('portal')) score -= 10;
                if (provider === 'opencode' && point.tags?.includes('portal')) score -= 8;
                if (model.includes('deepseek') && point.tags?.includes('observatory')) score -= 10;
                if (model.includes('glm') && point.tags?.includes('archive')) score -= 10;
                if (agent.teamName && point.district === 'civic') score -= 6;
                if (agent.isSubagent && point.tags?.includes('command')) score -= 7;
                if (this.pathfinder && !this.pathfinder.isWalkable(Math.round(point.tileX), Math.round(point.tileY))) score += 1000;
                return { point, score };
            })
            .sort((a, b) => a.score - b.score);
        const point = weighted[0]?.point;
        if (!point || weighted[0].score >= 1000) return null;
        this.behaviorMetrics.scenicVisits++;
        return {
            type: `ambient:${point.id}`,
            label: point.reason,
            district: point.district || 'ambient',
            capacity: { ambient: 1, work: 1 },
            routeViaRoads: true,
            visitTiles: [{
                tileX: point.tileX,
                tileY: point.tileY,
                slotId: `ambient:${point.id}`,
                scenic: true,
                reason: point.reason,
            }],
            containsVisitPoint: (tileX, tileY) => Math.hypot(Number(tileX) - point.tileX, Number(tileY) - point.tileY) <= 0.8,
        };
    }

    _updateVisitSystems(now = Date.now()) {
        const agents = Array.from(this.world?.agents?.values?.() || []);
        this._activeAgentsSnapshot = agents;
        this.visitIntentManager?.reconcile?.(agents, now);
        this.visitTileAllocator?.updateContext?.({
            buildings: this.world?.buildings,
            agentSprites: this.agentSprites,
            pathfinder: this.pathfinder,
        });
        // 3.13 — feed allocator occupancy into domain congestion state.
        // Building.updateVisitLoad emits 'building:congestion' on level
        // transitions; sprites read building.congestion directly per frame.
        const buildingLoads = this.visitTileAllocator?.getBuildingLoads?.();
        if (buildingLoads) this.world?.applyVisitLoads?.(buildingLoads, now);
        return agents;
    }

    _agentBehaviorStats() {
        const intents = this.visitIntentManager?.snapshot?.()?.intents || [];
        const reservations = this.visitTileAllocator?.snapshot?.() || {};
        const byBuilding = {};
        const byState = {};
        for (const sprite of this.agentSprites.values()) {
            const snap = sprite.getBehaviorDebugSnapshot?.();
            if (!snap) continue;
            if (snap.building) byBuilding[snap.building] = (byBuilding[snap.building] || 0) + 1;
            if (snap.behaviorState) byState[snap.behaviorState] = (byState[snap.behaviorState] || 0) + 1;
        }
        const intentSources = {};
        for (const intent of intents) {
            intentSources[intent.source] = (intentSources[intent.source] || 0) + 1;
        }
        const derivedMetrics = {
            ...this.behaviorMetrics,
            parentCoherentChildren: intents.filter((intent) => intent.reason === 'follow-parent-work').length,
            handoffIntents: intents.filter((intent) => intent.source === 'handoff').length,
        };
        return {
            agentCount: this.agentSprites.size,
            metricsScope: 'since renderer start',
            byBuilding,
            byState,
            intentSources,
            behaviorMetrics: derivedMetrics,
            ritualOverflow: this.ritualConductor?.getOverflowCount?.() || 0,
            allocatorMetrics: reservations.metrics || {},
            reservationCount: reservations.reservationCount || 0,
            buildingCrowds: reservations.buildings || {},
            crowd: this._crowdStats || this._summarizeCrowdClusters(),
            localAvoidance: { ...this._localAvoidanceMetrics },
        };
    }

    _syncRitualContext() {
        this.ritualConductor?.setContext?.({
            world: this.world,
            agentSprites: this.agentSprites,
            isAgentVisible: (agentId) => {
                const sprite = this.agentSprites.get(agentId);
                return Boolean(sprite && !sprite.isArrivalPending?.() && !this._isGateTransit(sprite, 'departure'));
            },
        });
    }

    _canAcceptToolRitual(event) {
        if (!this._worldModeActive) return false;
        return this.ritualConductor?.canAccept?.(event) ?? true;
    }

    // Mirror active pose-bearing rituals onto agent sprites each frame so
    // tool-heavy states read on the character (reading / typing / thinking).
    _syncToolRitualPoses() {
        const renderMode = this._lastRenderStats?.quality?.agentRenderMode || 'full';
        if (renderMode === 'minimal') {
            if (this._lastRitualPoseMode !== 'minimal') {
                for (const sprite of this.agentSprites.values()) {
                    sprite.setToolRitualPose?.(null);
                }
            }
            this._lastRitualPoseMode = 'minimal';
            return;
        }
        if (renderMode === 'compact' && this._ritualSyncFrame % 2 !== 0) return;
        this._lastRitualPoseMode = renderMode;
        const poses = this.ritualConductor?.getAgentPoses?.() || null;
        for (const [agentId, sprite] of this.agentSprites) {
            sprite.setToolRitualPose?.(poses?.get(agentId) || null);
        }
    }

    _enqueueSubagentSummonRitual(payload) {
        if (!this._worldModeActive || !this.ritualConductor) return;
        const parentId = payload?.parentId;
        if (!parentId) return;
        // Defensive fallback: AgentEventStream._onAdded should already enrich
        // the dispatched payload, but if subagent_type was added to the world
        // agent after the event fired, surface it here so the ritual label
        // ("SUMMON: code-reviewer") still resolves.
        const childAgent = payload?.childId ? this.world?.agents?.get?.(payload.childId) : null;
        const childAgentName = payload?.childAgentName
            || childAgent?.agentName
            || childAgent?.name
            || null;
        const childSubagentType = payload?.childSubagentType
            || childAgent?.subagent_type
            || childAgent?.subagentType
            || null;
        const targetName = childAgentName || childSubagentType || null;
        this.ritualConductor.enqueue({
            agentId: parentId,
            tool: 'Task',
            input: null,
            ts: payload?.ts || Date.now(),
            building: 'portal',
            childAgentName,
            childSubagentType,
            commandLifecycle: {
                kind: 'spawn',
                targetAgentId: payload?.childId || null,
                targetName,
            },
        });
    }

    _replayActiveToolRituals({ force = false } = {}) {
        const renderMode = this._lastRenderStats?.quality?.agentRenderMode || 'full';
        if (!force && renderMode !== 'full' && this._ritualSyncFrame % 4 !== 0) return 0;
        this._syncRitualContext();
        return this.agentEventStream?.emitInitialToolEvents?.({
            force,
            shouldEmit: (event, agent) => this._canAcceptToolRitual(event, agent),
        }) || 0;
    }

    _handleWorldKeyboardCommand(event) {
        if (!event || !this._worldModeActive || !this.camera) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        if (this._isKeyboardEditTarget(activeElement)) return;
        if (this._isModalOpen()) return;
        if (event.code === 'KeyB') {
            this.setReadMode(true);
            event.preventDefault();
            return;
        }

        if (event.code === 'Tab') {
            if (this._cycleAgentSelection(event.shiftKey ? -1 : 1)) event.preventDefault();
            return;
        }

        const panDeltas = {
            ArrowLeft: { x: KEYBOARD_PAN_STEP, y: 0 },
            ArrowRight: { x: -KEYBOARD_PAN_STEP, y: 0 },
            ArrowUp: { x: 0, y: KEYBOARD_PAN_STEP },
            ArrowDown: { x: 0, y: -KEYBOARD_PAN_STEP },
        };
        const delta = panDeltas[event.code];
        if (delta) {
            this.camera.abortDirectorGlide?.();
            this.camera.stopFollow();
            this.camera.noteUserInput?.();
            this.camera.x += delta.x / Math.max(0.1, this.camera.zoom || 1);
            this.camera.y += delta.y / Math.max(0.1, this.camera.zoom || 1);
            this.camera._clampToBounds?.();
            event.preventDefault();
            return;
        }

        if (event.code === 'Equal' || event.code === 'NumpadAdd') {
            if (this._zoomByKeyboard(1)) { this.camera.abortDirectorGlide?.(); this.camera.noteUserInput?.(); event.preventDefault(); }
            return;
        }
        if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
            if (this._zoomByKeyboard(-1)) { this.camera.abortDirectorGlide?.(); this.camera.noteUserInput?.(); event.preventDefault(); }
            return;
        }
        if (event.code === 'KeyF') {
            this.camera.stopFollow();
            this.frameContent();
            event.preventDefault();
            return;
        }
        if (event.code === 'KeyR') {
            this.villageDirector?.toggleReplay?.();
            event.preventDefault();
            return;
        }
        if (event.code === 'Escape') {
            this.selectAgentById(null);
            this.onAgentSelect?.(null);
            event.preventDefault();
        }
    }

    _isKeyboardEditTarget(element) {
        if (!element) return false;
        const tagName = String(element.tagName || '').toUpperCase();
        return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || element.isContentEditable;
    }

    _isModalOpen() {
        return this.modal?.overlay?.style?.display === 'flex';
    }

    _cycleAgentSelection(direction = 1) {
        const ids = Array.from(this.agentSprites.entries())
            .filter(([, sprite]) => sprite && !this._isGateTransit(sprite, 'departure') && !sprite.isArrivalPending?.())
            .map(([id]) => id);
        if (!ids.length) return false;
        const currentIndex = this.selectedAgent?.id ? ids.indexOf(this.selectedAgent.id) : -1;
        const nextIndex = currentIndex >= 0
            ? (currentIndex + direction + ids.length) % ids.length
            : (direction < 0 ? ids.length - 1 : 0);
        this.selectAgentById(ids[nextIndex]);
        this.onAgentSelect?.(this.selectedAgent || null);
        return Boolean(this.selectedAgent);
    }

    _zoomByKeyboard(direction = 1) {
        const camera = this.camera;
        const steps = Array.isArray(camera?.zoomSteps) && camera.zoomSteps.length
            ? camera.zoomSteps
            : [camera?.minZoom || 1, camera?.maxZoom || 3];
        const zoom = camera?.zoom || 1;
        const currentIndex = steps.reduce((bestIndex, step, index) => (
            Math.abs(step - zoom) < Math.abs(steps[bestIndex] - zoom) ? index : bestIndex
        ), 0);
        const nextIndex = Math.max(0, Math.min(steps.length - 1, currentIndex + direction));
        const targetZoom = steps[nextIndex];
        if (!camera || targetZoom === zoom) return false;
        camera.stopFollow();
        camera._setZoomAboutCenter?.(targetZoom);
        return true;
    }

    invalidateViewportCaches() {
        this._invalidateIdleFrame();
        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        this.atmosphereVignetteCache = null;
        this.atmosphereVignetteCacheKey = '';
        releaseCanvasBackingStore(this._fastVignetteStamp);
        this._fastVignetteStamp = null;
        this._fastVignetteStampKey = '';
        releaseCanvasMap(this.lightGradientCache);
        this.skyRenderer?.releaseCache?.();
        this.trailRenderer?.releaseCache?.();
    }

    _screenDpr() {
        return this.canvas?._claudeVilleDpr || 1;
    }

    _screenWidth() {
        return this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || this.canvas?.width || 0;
    }

    _screenHeight() {
        return this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || this.canvas?.height || 0;
    }

    _screenViewport() {
        const width = this._screenWidth();
        const height = this._screenHeight();
        return {
            width,
            height,
            _claudeVilleCssWidth: width,
            _claudeVilleCssHeight: height,
            _claudeVilleDpr: this._screenDpr(),
        };
    }

    _resetScreenTransform(ctx) {
        const dpr = this._screenDpr();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        SpriteRenderer.disableSmoothing(ctx);
    }

    _resizeAuxiliaryBackingStores(width, height) {
        const backingWidth = Math.max(0, Math.round(Number(width) || 0));
        const backingHeight = Math.max(0, Math.round(Number(height) || 0));
        for (const surface of [this.fxCanvas, this.overlayCanvas]) {
            if (!surface) continue;
            if (surface.width !== backingWidth) surface.width = backingWidth;
            if (surface.height !== backingHeight) surface.height = backingHeight;
            surface._claudeVilleDpr = this.canvas?._claudeVilleDpr || 1;
            surface._claudeVilleCssWidth = this.canvas?._claudeVilleCssWidth || this.canvas?.clientWidth || 0;
            surface._claudeVilleCssHeight = this.canvas?._claudeVilleCssHeight || this.canvas?.clientHeight || 0;
        }
        this.overlayCtx = this.overlayCanvas?.getContext?.('2d', { alpha: true }) || null;
        if (this.overlayCtx) SpriteRenderer.disableSmoothing(this.overlayCtx);
        if (backingWidth > 0 && backingHeight > 0) {
            this.postFx?.resize?.(backingWidth, backingHeight);
            this.gpuWorld?.resize?.(backingWidth, backingHeight);
        }
    }

    _setPostFxCanvasVisible(active) {
        const visible = Boolean(active);
        if (this._postFxCanvasVisible === visible) return;
        this._postFxCanvasVisible = visible;
        if (this.fxCanvas) this.fxCanvas.style.display = visible ? 'block' : 'none';
    }

    _addAgentSprite(agent) {
        const existing = this.agentSprites.get(agent.id);
        if (existing) {
            if (existing.applyAgentUpdate) existing.applyAgentUpdate(agent);
            else existing.agent = agent;
            if (this._isGateTransit(existing, 'departure')) {
                this.gateTransits.delete(agent.id);
                this._beginAgentGateArrival(agent, existing);
            }
            this._markSpritesDirty();
            return;
        }
        if (!this.agentSprites.has(agent.id)) {
            const sprite = new AgentSprite(agent, {
                pathfinder: this.pathfinder,
                bridgeTiles: this.bridgeTiles,
                assets: this.assets,
                compositor: this.compositor,
                getIntentForAgent: (agentId) => this.visitIntentManager?.getIntentForAgent?.(agentId) || null,
                getBuilding: (type) => this._getBuildingByType(type),
                getBridgeLift: (tileX, tileY) => this.getBridgeLift(tileX, tileY),
                allocateVisitTile: (request) => this._allocateVisitTile(request),
                releaseVisitReservation: (agentId) => this.visitTileAllocator?.release?.(agentId),
                renewVisitReservation: (agentId) => this.visitTileAllocator?.renew?.(agentId),
                getAmbientDestination: (request) => this._getAmbientDestination(request),
                getRoadTiles: () => this.pathTiles,
                getTileType: (tileX, tileY) => this._surfaceMaterialAt(tileX, tileY),
            });
            sprite.setMotionScale(this.motionScale);
            sprite.setGpuWorldEnabled?.(this.gpuWorld?.isActive?.() === true);
            sprite.addedAt = performance.now();
            this._beginAgentGateArrival(agent, sprite);
            this.agentSprites.set(agent.id, sprite);
            this._primeNickname(sprite);
            this._markSpritesDirty();
        }
    }

    /** 4.8 — push cached earned nicknames onto every live sprite. */
    _applyNicknames() {
        if (!this._nicknames) return;
        for (const sprite of this.agentSprites.values()) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            sprite.setNickname?.(identityKey ? this._nicknames.get(identityKey) || null : null);
        }
    }

    _cacheNickname(identityKey, nickname) {
        if (!identityKey) return;
        this._nicknames.delete(identityKey);
        if (nickname) this._nicknames.set(identityKey, nickname);
        this._pruneNicknameCache();
    }

    _pruneNicknameCache() {
        if (this._nicknames.size <= NICKNAME_CACHE_LIMIT) return;
        const liveIdentityKeys = new Set();
        for (const sprite of this.agentSprites.values()) {
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            if (identityKey) liveIdentityKeys.add(identityKey);
        }
        for (const identityKey of this._nicknames.keys()) {
            if (this._nicknames.size <= NICKNAME_CACHE_LIMIT) break;
            if (!liveIdentityKeys.has(identityKey)) this._nicknames.delete(identityKey);
        }
    }

    /** 4.8 — seed a new sprite's nickname from its persisted biography. */
    _primeNickname(sprite) {
        if (!this.biographyService || !sprite?.agent) return;
        const identityKey = AgentBiography.identityKeyFor(sprite.agent);
        if (!identityKey) return;
        if (this._nicknames.has(identityKey)) {
            const nickname = this._nicknames.get(identityKey);
            this._cacheNickname(identityKey, nickname);
            sprite.setNickname?.(nickname);
            return;
        }
        const biographyService = this.biographyService;
        const generation = this._biographyReadGeneration;
        const agentId = sprite.agent.id;
        biographyService.getBiography(identityKey).then((biography) => {
            if (
                this._disposed
                || generation !== this._biographyReadGeneration
                || this.agentSprites.get(agentId) !== sprite
                || AgentBiography.identityKeyFor(sprite.agent) !== identityKey
            ) return;
            const nickname = biography?.nickname || null;
            if (!nickname) return;
            this._cacheNickname(identityKey, nickname);
            sprite.setNickname?.(nickname);
        }).catch(() => {});
    }

    /**
     * 2.4 — affinity-driven proximity: the warmest 'allies' pairs of idle
     * villagers share a plaza preference (same 30 s TTL mechanism as
     * parent/child clustering), so long-standing collaborators idle together
     * while strangers keep their default spread.
     */
    _applyAffinityProximity(now = Date.now()) {
        this._allyTetherPairs = [];
        const snapshot = this.affinityService?.getSnapshot?.();
        if (!snapshot?.size) return;
        const spriteByIdentity = new Map();
        for (const sprite of this.agentSprites.values()) {
            if (sprite.agent?.status !== AgentStatus.IDLE) continue;
            if (sprite.isArrivalPending?.() || this._isGateTransit(sprite)) continue;
            const identityKey = AgentBiography.identityKeyFor(sprite.agent);
            if (identityKey && !spriteByIdentity.has(identityKey)) {
                spriteByIdentity.set(identityKey, sprite);
            }
        }
        if (spriteByIdentity.size < 2) return;
        const pairs = [];
        for (const affinity of snapshot.values()) {
            if (affinity?.tier?.(now) !== 'allies') continue;
            const a = spriteByIdentity.get(affinity.identityA);
            const b = spriteByIdentity.get(affinity.identityB);
            if (!a || !b || a === b) continue;
            pairs.push({ a, b, score: affinity.decayedScore?.(now) || 0 });
        }
        if (!pairs.length) return;
        pairs.sort((x, y) => y.score - x.score);
        const top = pairs.slice(0, MAX_AFFINITY_PROXIMITY_PAIRS);
        // Hold the warmest idle pairs so the frame renderer can draw their
        // tethers; the sprite refs stay live, so endpoints track movement.
        this._allyTetherPairs = top;
        for (const { a, b } of top) {
            const tileA = worldToTile(a.x, a.y);
            const tileB = worldToTile(b.x, b.y);
            const midX = (tileA.tileX + tileB.tileX) / 2;
            const midY = (tileA.tileY + tileB.tileY) / 2;
            a.setFamilyPlazaPreference?.(midX, midY);
            b.setFamilyPlazaPreference?.(midX, midY);
        }
    }

    _parentSpriteFor(agent, { requireWorldAgent = false } = {}) {
        const parentId = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (requireWorldAgent && parentId && !this.world?.agents?.has?.(parentId)) return null;
        return parentId ? this.agentSprites.get(parentId) : null;
    }

    _beginRelationshipArrival(agent) {
        const sprite = this.agentSprites.get(agent?.id);
        if (!sprite || !this.arrivalDeparture) return false;
        const parentSprite = this._parentSpriteFor(agent);
        const portalScreenPoint = this._tileToWorld(PORTAL_SPAWN_TILE.tileX, PORTAL_SPAWN_TILE.tileY);
        const started = parentSprite
            ? this.arrivalDeparture.beginSubagentDispatch(parentSprite, sprite, {
                now: performance.now(),
                portalScreenPoint,
            })
            : this.arrivalDeparture.beginAgentArrival(agent, sprite, { parentAlive: false, now: performance.now() });
        if (started || this.motionScale <= 0) {
            this.gateTransits.delete(agent.id);
            this._markSpritesDirty();
            return true;
        }
        return false;
    }

    _beginRelationshipDeparture(agent) {
        const sprite = this.agentSprites.get(agent?.id);
        const parentSprite = this._parentSpriteFor(agent, { requireWorldAgent: true });
        const now = performance.now();

        if (parentSprite) {
            const childPoint = sprite
                ? { x: sprite.x, y: sprite.y }
                : { x: parentSprite.x, y: parentSprite.y };
            const merge = sprite
                ? this.arrivalDeparture?.beginSubagentMerge?.(
                    agent,
                    childPoint,
                    parentSprite,
                    { now },
                )
                : null;
            if (!merge) {
                this.arrivalDeparture?.recordSubagentCompletion?.(
                    agent,
                    childPoint,
                    parentSprite,
                    { now },
                );
            }
            if (sprite) this._removeAgentSprite(agent.id);
            return true;
        }

        const lastTile = sprite && typeof sprite._screenToTile === 'function'
            ? sprite._screenToTile(sprite.x, sprite.y)
            : (agent?.position ? {
                tileX: agent.position.tileX ?? agent.position.x,
                tileY: agent.position.tileY ?? agent.position.y,
            } : null);

        // Orphan subagent: parent vanished mid-flight. Animate a return wisp to
        // the Portal Gate instead of fading in place at the child's last tile.
        const parentRef = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (parentRef) {
            const portalScreenPoint = this._tileToWorld(PORTAL_SPAWN_TILE.tileX, PORTAL_SPAWN_TILE.tileY);
            this.arrivalDeparture?.recordOrphanReturn?.(agent, lastTile, portalScreenPoint, { now });
            if (sprite) this._removeAgentSprite(agent.id);
            return true;
        }

        this.arrivalDeparture?.recordDeparture?.(agent, lastTile, { now, parentAlive: false });
        return false;
    }

    _gateJitter(agent, axis = 'x', amount = 0.18) {
        const seed = String(agent?.id || '') + axis;
        let hash = 0;
        for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
        const unit = ((hash >>> 0) / 4294967295) - 0.5;
        return unit * amount;
    }

    _beginAgentGateArrival(agent, sprite) {
        if (!sprite) return;

        // Subagents step out of the Portal Gate toward their parent rather than
        // riding the carriage/boat arrival used for top-level sessions.
        const parentRef = agent?.parentSessionId || agent?.parentId || agent?.parentAgentId;
        if (parentRef) {
            const parentSprite = this.agentSprites.get(parentRef);
            const parentTile = parentSprite && typeof parentSprite._screenToTile === 'function'
                ? parentSprite._screenToTile(parentSprite.x, parentSprite.y)
                : null;
            const intent = this.visitIntentManager?.getIntentForAgent?.(parentRef) || null;
            const intentBuilding = intent?.building ? this._getBuildingByType(intent.building) : null;
            const intentVisitTile = intentBuilding && typeof intentBuilding.primaryVisitTile === 'function'
                ? intentBuilding.primaryVisitTile()
                : null;
            const destination = parentTile || intentVisitTile || null;

            sprite.setTilePosition?.(
                PORTAL_SPAWN_TILE.tileX + this._gateJitter(agent, 'portal-x', 0.32),
                PORTAL_SPAWN_TILE.tileY + this._gateJitter(agent, 'portal-y', 0.22),
            );
            if (this.motionScale <= 0 || !destination) {
                return;
            }
            sprite.walkToTile?.(destination.tileX, destination.tileY);
            this.gateTransits.set(agent.id, { type: 'arrival' });
            return;
        }

        if (this.motionScale <= 0) {
            sprite.setTilePosition?.(
                VILLAGE_GATE.inside.tileX + this._gateJitter(agent, 'arrival-x', 0.32),
                VILLAGE_GATE.inside.tileY + this._gateJitter(agent, 'arrival-y', 0.22),
            );
            return;
        }

        sprite.setTilePosition?.(
            VILLAGE_GATE.outside.tileX + this._gateJitter(agent, 'outside-x', 0.28),
            VILLAGE_GATE.outside.tileY + this._gateJitter(agent, 'outside-y', 0.18),
        );
        sprite.walkToTile?.(
            VILLAGE_GATE.inside.tileX + this._gateJitter(agent, 'inside-x', 0.42),
            VILLAGE_GATE.inside.tileY + this._gateJitter(agent, 'inside-y', 0.28),
        );
        this.gateTransits.set(agent.id, { type: 'arrival' });
    }

    _beginAgentGateDeparture(agent) {
        const sprite = this.agentSprites.get(agent.id);
        if (!sprite || this.motionScale <= 0) {
            this._removeAgentSprite(agent.id);
            return;
        }

        sprite.selected = false;
        sprite.walkToTile?.(
            VILLAGE_GATE.outside.tileX + this._gateJitter(agent, 'depart-x', 0.30),
            VILLAGE_GATE.outside.tileY + this._gateJitter(agent, 'depart-y', 0.20),
        );
        this.gateTransits.set(agent.id, { type: 'departure' });
        this._markSpritesDirty();
    }

    _removeAgentSprite(agentId) {
        const sprite = this.agentSprites.get(agentId);
        if (!sprite) return;
        if (this.selectedAgent?.id === agentId) {
            this.selectedAgent = null;
            this.camera?.stopFollow?.();
        }
        this.gateTransits.delete(agentId);
        this.visitTileAllocator?.release?.(agentId);
        // Archive fade: defer the actual sprite disposal by
        // ARCHIVE_FADE_DURATION_MS so AgentSprite.draw() fade alpha + sparkle
        // puff can play. The sprite stays in agentSprites and is collected by
        // _pruneArchiveFadedSprites(). Reduced motion (motionScale === 0)
        // short-circuits to immediate disposal — there is no fade to play.
        const motionScale = this.motionScale ?? 1;
        if (motionScale > 0 && !sprite._archiveAnim) {
            sprite._archiveAnim = {
                startedAt: Date.now(),
                total: ARCHIVE_FADE_DURATION_MS,
                agent: sprite.agent,
            };
            sprite.selected = false;
            this._markSpritesDirty();
            return;
        }
        sprite.releaseRenderResources?.();
        this.agentSprites.delete(agentId);
        this._markSpritesDirty();
    }

    // Sweep archive-fading sprites whose fade window has elapsed.
    // Called once per frame from `_update`.
    _pruneArchiveFadedSprites(nowMs = Date.now()) {
        let removed = false;
        for (const [agentId, sprite] of this.agentSprites) {
            const anim = sprite._archiveAnim;
            if (!anim) continue;
            if (nowMs - anim.startedAt >= anim.total) {
                sprite.releaseRenderResources?.();
                this.agentSprites.delete(agentId);
                removed = true;
            }
        }
        if (removed) this._markSpritesDirty();
    }

    _isGateTransit(sprite, type = null) {
        const transit = this.gateTransits.get(sprite?.agent?.id);
        return Boolean(transit && (!type || transit.type === type));
    }

    _updateGateDoorState(now = performance.now()) {
        const wantOpen = this.gateTransits.size > 0 || this._hasAgentNearGate();
        if (wantOpen) {
            this.gateDoorsOpen = true;
            this._gateDoorsOpenUntilMs = now + 1500; // 1.5s grace timer
            return;
        }
        if (now < this._gateDoorsOpenUntilMs) {
            this.gateDoorsOpen = true;
            return;
        }
        this.gateDoorsOpen = false;
    }

    // Note: when motionScale=0, _beginAgentGateArrival short-circuits BEFORE
    // adding to gateTransits, so doors stay closed during reduced-motion
    // spawns. This mirrors the no-walk policy: if the agent doesn't visibly
    // walk in, the doors don't visibly open.
    _hasAgentNearGate() {
        const minTileX = 17;
        const maxTileX = 21;
        const minTileY = 38;
        const maxTileY = 39.5;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            if (tile.tileX >= minTileX && tile.tileX <= maxTileX
                && tile.tileY >= minTileY && tile.tileY <= maxTileY) {
                return true;
            }
        }
        return false;
    }

    _handleClick(worldX, worldY) {
        if (!this.agentSprites.size && !this.buildingRenderer) return;
        this._invalidateIdleFrame();

        let clicked = null;

        // Per-pixel agent hit test (sorted: most front first)
        const sorted = Array.from(this.agentSprites.values())
            .sort((a, b) => b.y - a.y);            // front-most first
        for (const sprite of sorted) {
            if (this._isGateTransit(sprite, 'departure')) continue;
            if (sprite.hitTest(worldX, worldY)) {
                clicked = sprite;
                break;
            }
        }

        // Deselect all
        for (const sprite of this.agentSprites.values()) sprite.selected = false;

        if (clicked) {
            clicked.selected = true;
            this.selectedAgent = clicked.agent;
            this.camera.followAgent(clicked);
            if (this.onAgentSelect) this.onAgentSelect(clicked.agent);
            return;
        }

        this.selectedAgent = null;
        this.camera.stopFollow();
        if (this.onAgentSelect) this.onAgentSelect(null);

        // No agent hit; fall through to building selection. Renderer state for
        // building selection is owned downstream; we only emit.
        const building = this.buildingRenderer?.hitTest(worldX, worldY) ?? null;
        if (building) {
            eventBus.emit(BUILDING_EVENTS.SELECTED, building);
        } else {
            eventBus.emit(BUILDING_EVENTS.DESELECTED);
        }
    }

    // 3.7 — rAF-throttled agent hover hit-test. The mousemove handler records
    // the latest world position; at most one front-most-first per-pixel sweep
    // (same geometry and skip rule as _handleClick) runs per frame.
    _scheduleAgentHoverTest(worldX, worldY) {
        this._agentHoverX = worldX;
        this._agentHoverY = worldY;
        if (this._agentHoverRafId !== null) return;
        this._agentHoverRafId = requestAnimationFrame(() => {
            this._agentHoverRafId = null;
            if (this._disposed) return;
            this._applyAgentHover(this._agentHoverX, this._agentHoverY);
        });
    }

    _applyAgentHover(worldX, worldY) {
        let hit = null;
        if (this.agentSprites.size) {
            const sorted = Array.from(this.agentSprites.values())
                .sort((a, b) => b.y - a.y);            // front-most first
            for (const sprite of sorted) {
                if (this._isGateTransit(sprite, 'departure')) continue;
                if (sprite.hitTest(worldX, worldY)) {
                    hit = sprite;
                    break;
                }
            }
        }
        this._setHoveredAgentSprite(hit);
        if (hit) {
            // Agents win over buildings/ships/monuments, same precedence as
            // _handleClick: suppress the hover the synchronous pass applied.
            this.buildingRenderer?.setHovered(null);
            this.villageDirector?.setHoveredBuilding?.(null);
            this.harborTraffic?.setHoveredShip?.(null);
            // Hovering a villager surfaces where its line actually came from,
            // so the provenance badge on the bubble is legible rather than
            // merely decorative.
            if (this.canvas) this.canvas.title = hit.dialogueTooltip?.() || '';
        }
    }

    _setHoveredAgentSprite(sprite) {
        if (this._hoveredAgentSprite === sprite) return;
        this._invalidateIdleFrame();
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(false);
        this._hoveredAgentSprite = sprite || null;
        if (this._hoveredAgentSprite) this._hoveredAgentSprite.setHovered(true);
    }

    _buildingVisitorTooltip(building) {
        if (!building?.type) return '';
        const type = building.type;
        const stats = this.visitTileAllocator?.snapshot?.()?.buildings?.[type] || null;
        const intents = this.visitIntentManager?.snapshot?.()?.intents
            ?.filter((intent) => intent.building === type)
            ?.slice(0, 4) || [];
        const label = building.shortLabel || building.label || type;
        const enRoute = stats ? Math.max(0, (stats.reserved || 0) - (stats.occupied || 0)) : intents.length;
        const count = stats ? `${stats.occupied} visiting, ${enRoute} en route` : `${intents.length} active`;
        if (!this.debugOverlay?.enabled) return `${label}: ${count}`;
        const reasons = intents.map((intent) => intent.reason).filter(Boolean);
        return reasons.length ? `${label}: ${count} - ${reasons.join(', ')}` : `${label}: ${count}`;
    }

    _invalidateIdleFrame() {
        this._idleFrameDirty = true;
    }

    _cameraIdleStable() {
        const camera = this.camera;
        if (!camera) return false;
        if (
            camera.dragging
            || camera.followTarget
            || camera._momentum
            || camera._snapZoom
            || camera._zoomAnimation
            || camera._directorGlide
            || camera._idleDrift
            || camera._villageTour
            || camera._followEase
            || camera.isDirectorGliding?.()
        ) return false;
        const last = this._idleLastRenderCamera;
        return camera.x === last.x && camera.y === last.y && camera.zoom === last.zoom;
    }

    _hasTimedIdleTransition(now = Date.now()) {
        if (this.debugOverlay?.enabled || this.debugOverlay?.pathDebugEnabled) return true;
        // AgentSprite.update owns routing, dwelling, reservation renewal, chat
        // convergence and movement even under reduced motion. Only departed
        // tableaux are truly static enough to stop advancing.
        for (const sprite of this.agentSprites.values()) {
            if (!sprite.agent?.isDeparted) return true;
            if (sprite._archiveAnim || sprite.moving || sprite.chatting || sprite.chatPartner) return true;
        }
        if (this.gateTransits.size || this.gateDoorsOpen || now < this._gateDoorsOpenUntilMs) return true;
        const arrival = this.arrivalDeparture;
        if (
            arrival?.arrivals?.size
            || arrival?.dispatches?.size
            || arrival?.merges?.size
            || arrival?.sigils?.length
            || arrival?.completionCues?.length
            || arrival?.orphanReturns?.length
        ) return true;
        if (this.ritualConductor?.rituals?.length || this.particleSystem?.particles?.length) return true;
        if (this._gullScatterActive()) return true;

        const chronicler = this.chronicler;
        if (
            chronicler?._activeErrand
            || chronicler?._errandQueue?.length
            || (chronicler?.phase && chronicler.phase !== 'home')
        ) return true;
        if (now >= this._chronicleNextUpdateAt) return true;

        const director = this.villageDirector;
        if (
            director?.replayActive
            || director?.scenes?.length
            || director?._recoveries?.size
            || director?._pendingBiographyBanners?.length
            || director?.buildingPresence?.size
            || director?.toolEvents?.length
        ) return true;
        if (this.moodService?.getWeatherInfluence?.(now)) return true;
        const harbor = this.harborTraffic;
        if (
            harbor?._hasTimedLifecycle
            || harbor?.storageTransfers?.size
            || harbor?.harborCrates?.size
            || harbor?.state?.pushEvents?.size
            || harbor?._pendingRepoSummaries?.length
        ) return true;

        // The live clock continuously changes sky, light and deterministic
        // weather. A frozen date or explicit hour is required before the scene
        // can be considered timeless.
        if (!this.atmosphereState?._frozenDate && !Number.isFinite(this.atmosphereState?._hourOverride)) {
            return true;
        }
        const atmosphere = this._lastAtmosphere;
        const weather = atmosphere?.weather;
        const weatherProgress = Number(weather?.transitionProgress);
        if (
            !atmosphere
            || (weather?.timelineMode === 'auto' && weatherProgress > 0 && weatherProgress < 1)
            || (
                weather?.previousType !== weather?.nextType
                && weatherProgress > 0
                && weatherProgress < 1
            )
            || (Number(weather?.precipitation) || 0) > 0.001
            || (Number(this._surfaceWetness) || 0) > 0.001
        ) return true;
        return false;
    }

    _pendingIdleResourceWork() {
        const assets = this.assets;
        const pending = Boolean(
            this._worldResumePromise
            || this._chronicleUpdatePromise
            || assets?._loadPromise
            || assets?._materialLoadPromise
            || assets?._characterLoads?.size
            || assets?._derivedArtQueue?.size
            || this.gpuWorld?.pendingGpuQueries?.length
        );
        if (pending) {
            this._idleResourceWorkObserved = true;
            return true;
        }
        // Resource completion can change drawable pixels without a domain
        // event. Force exactly one post-completion frame before becoming idle.
        if (this._idleResourceWorkObserved) {
            this._idleResourceWorkObserved = false;
            return true;
        }
        return false;
    }

    _canSkipIdleFrame(now = Date.now()) {
        return this.motionScale <= 0
            && !this._idleFrameDirty
            && this._cameraIdleStable()
            && !this._hasTimedIdleTransition(now)
            && !this._pendingIdleResourceWork();
    }

    _recordIdleRenderState() {
        const camera = this.camera;
        if (camera) {
            this._idleLastRenderCamera.x = camera.x;
            this._idleLastRenderCamera.y = camera.y;
            this._idleLastRenderCamera.zoom = camera.zoom;
        }
        this._idleFrameDirty = false;
    }

    _loop() {
        if (!this.running) return;
        this.frameId = null;
        if (!this._worldModeActive || this._contextLost) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const now = performance.now();
        const frameGapMs = Number.isFinite(this._lastFrameTime) ? now - this._lastFrameTime : 0;
        const dt = this._lastFrameTime ? Math.min(50, now - this._lastFrameTime) : 16;
        this._lastFrameTime = now;
        if (this._canSkipIdleFrame(Date.now())) {
            this._recordFrameEnvelope(0, 0, 0, frameGapMs, null);
            if (this._performanceSamples) this._recordPerformanceSample(0, 0, 0);
            this._trackFps(now);
            this._frameFailureStats.consecutive = 0;
            this._startLoop();
            return;
        }
        advanceMotionClock(this._motionClock, dt, this.motionScale ?? 1);
        this.waterFrame = virtualFramesFor(this.motionTimeMs) * WATER_FRAME_STEP;
        const perf = getClientPerfMetrics();
        let updateToken = null;
        let renderToken = null;
        let stage = 'update';
        let updateMs = 0;
        let renderMs = 0;
        const updateStart = now;
        let renderStart = now;
        try {
            if (perf?.enabled) updateToken = perf.beginRenderStage('world-update');
            this._update(dt);
            const afterUpdate = performance.now();
            updateMs = afterUpdate - updateStart;
            if (updateToken) {
                perf.endRenderStage(updateToken);
                updateToken = null;
            }
            stage = 'render';
            renderStart = afterUpdate;
            if (perf?.enabled) renderToken = perf.beginRenderStage('world-render');
            this._render(dt);
            const afterRender = performance.now();
            renderMs = afterRender - renderStart;
            this._recordIdleRenderState();
            if (renderToken) {
                perf.endRenderStage(renderToken);
                renderToken = null;
            }
            this._recordFrameEnvelope(updateMs, renderMs, afterRender - updateStart, frameGapMs, null);
            if (this._performanceSamples) {
                this._recordPerformanceSample(updateMs, renderMs, afterRender - updateStart);
            }
            stage = 'telemetry';
            this._trackFps(now);
            this._frameFailureStats.consecutive = 0;
        } catch (error) {
            const failedAt = performance.now();
            if (stage === 'update') {
                updateMs = failedAt - updateStart;
            } else if (stage === 'render') {
                updateMs = renderStart - updateStart;
                renderMs = failedAt - renderStart;
            }
            this._recordFrameEnvelope(updateMs, renderMs, failedAt - updateStart, frameGapMs, stage);
            this._reportFrameFailure(error, stage, now);
        } finally {
            if (updateToken) perf?.endRenderStage?.(updateToken);
            if (renderToken) perf?.endRenderStage?.(renderToken);
            this._startLoop();
        }
    }

    _reportFrameFailure(error, stage, now = performance.now()) {
        const stats = this._frameFailureStats;
        stats.total++;
        stats.consecutive++;
        stats.lastStage = stage;
        stats.lastMessage = error instanceof Error ? error.message : String(error);
        stats.lastAt = now;
        stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
        if (stage === 'render') this._resetContextAfterFrameFailure();
        const tripped = !stats.paused && stats.consecutive >= WORLD_FRAME_MAX_CONSECUTIVE_FAILURES;
        if (tripped) {
            stats.paused = true;
        }
        if (!tripped && now - stats.lastReportedAt < WORLD_FRAME_ERROR_REPORT_INTERVAL_MS) return;
        stats.lastReportedAt = now;
        const detail = {
            stage,
            message: stats.lastMessage,
            total: stats.total,
            consecutive: stats.consecutive,
            paused: stats.paused,
        };
        try { console.error(`[IsometricRenderer] ${stage} frame failed`, error); } catch (_) { /* no-op */ }
        try { eventBus.emit('world:frame-error', detail); } catch (_) { /* keep the frame loop alive */ }
    }

    _resetContextAfterFrameFailure() {
        const ctx = this.ctx;
        if (!ctx) return;
        try {
            if (typeof ctx.reset === 'function') {
                ctx.reset();
                return;
            }
            const canvas = this.canvas;
            if (canvas && canvas.width > 0 && canvas.height > 0) {
                canvas.width = canvas.width;
                this.ctx = canvas.getContext('2d', { alpha: false });
            }
        } catch { /* context recovery is best-effort */ }
    }

    _resumeFrameFailures() {
        this._frameFailureStats.paused = false;
        this._frameFailureStats.consecutive = 0;
    }

    resumeAfterFrameFailure() {
        if (this._disposed || !this.running) return false;
        this._resumeFrameFailures();
        this._lastFrameTime = performance.now();
        this._startLoop();
        return true;
    }

    // Emit a smoothed FPS reading roughly twice a second; TopBar renders it.
    _trackFps(now) {
        this._fpsFrames = (this._fpsFrames || 0) + 1;
        if (!this._fpsWindowStart) this._fpsWindowStart = now;
        const elapsed = now - this._fpsWindowStart;
        if (elapsed >= 500) {
            eventBus.emit('fps:updated', Math.round((this._fpsFrames * 1000) / elapsed));
            // Broadcast the frame's atmosphere snapshot at the same throttled
            // cadence; the ambient audio director listens so sound tracks the
            // same sky the renderer draws (including debug/mood overrides).
            if (this._lastAtmosphere) eventBus.emit('atmosphere:updated', this._lastAtmosphere);
            this._fpsFrames = 0;
            this._fpsWindowStart = now;
        }
    }

    startPerformanceProfile() {
        this._performanceSamples = {
            slots: new Array(600),
            index: 0,
            count: 0,
            capacity: 600,
        };
        this._frameTimingSamples?.clear?.();
        enableFrameEnvelopeRings(this._frameEnvelope);
        return true;
    }

    stopPerformanceProfile() {
        const profile = this.getPerformanceProfile();
        this._performanceSamples = null;
        if (!getClientPerfMetrics()?.enabled) this._frameEnvelope.ringsEnabled = false;
        return profile;
    }

    getPerformanceProfile() {
        return {
            enabled: Boolean(this._performanceSamples),
            samples: this._collectPerformanceSamples(),
            renderTimings: this._snapshotRenderTimings(),
        };
    }

    frameHealth() {
        const gpu = this.gpuWorld?.getDiagnostics?.() || null;
        const postFx = this.postFx?.getDiagnostics?.() || null;
        const gpuMs = Number.isFinite(gpu?.gpuMs)
            ? gpu.gpuMs
            : (Number.isFinite(postFx?.gpuMs) ? postFx.gpuMs : null);
        const qualityLevel = gpu?.qualityLevel ?? postFx?.ladder?.effectiveLevel ?? null;
        const qualityReason = gpu?.qualityReason ?? postFx?.ladder?.lastDecisionReason ?? null;
        return snapshotFrameEnvelope(this._frameEnvelope, {
            gpuMs,
            qualityLevel,
            qualityReason,
        });
    }

    _syncFrameEnvelopeRings() {
        const requested = Boolean(this._performanceSamples || getClientPerfMetrics()?.enabled);
        if (requested) enableFrameEnvelopeRings(this._frameEnvelope);
        else this._frameEnvelope.ringsEnabled = false;
    }

    _recordFrameEnvelope(updateMs, renderMs, totalMs, frameGapMs, failureStage) {
        this._syncFrameEnvelopeRings();
        recordFrameEnvelope(this._frameEnvelope, updateMs, renderMs, totalMs, frameGapMs, failureStage);
    }

    _recordPerformanceSample(updateMs, renderMs, totalMs) {
        const ring = this._performanceSamples;
        if (!ring) return;
        let slot = ring.slots[ring.index];
        if (!slot) {
            slot = {
                updateMs: 0,
                renderMs: 0,
                totalMs: 0,
                agentCount: 0,
                renderMode: null,
            };
            ring.slots[ring.index] = slot;
        }
        slot.updateMs = updateMs;
        slot.renderMs = renderMs;
        slot.totalMs = totalMs;
        slot.agentCount = this.agentSprites.size;
        slot.renderMode = this._lastRenderStats?.quality?.agentRenderMode || null;
        ring.index += 1;
        if (ring.index >= ring.capacity) ring.index = 0;
        if (ring.count < ring.capacity) ring.count += 1;
    }

    _collectPerformanceSamples() {
        const ring = this._performanceSamples;
        if (!ring || ring.count === 0) return [];
        const samples = new Array(ring.count);
        const start = ring.count < ring.capacity ? 0 : ring.index;
        for (let i = 0; i < ring.count; i++) {
            const slot = ring.slots[(start + i) % ring.capacity];
            samples[i] = slot
                ? {
                    updateMs: slot.updateMs,
                    renderMs: slot.renderMs,
                    totalMs: slot.totalMs,
                    agentCount: slot.agentCount,
                    renderMode: slot.renderMode,
                }
                : null;
        }
        return samples;
    }

    _snapshotRenderTimings() {
        const timer = this._frameTimer;
        const rings = this._frameTimingSamples;
        if (!timer && !rings) return this._lastRenderStats?.timings || null;
        const markCount = timer?.markCount || 0;
        const segments = [];
        for (let i = 0; i < markCount; i++) {
            const label = timer.markLabels[i];
            const ring = rings?.get(label);
            segments.push({
                label,
                ms: timer.markMs[i],
                p50: ring ? percentileAtSnapshot(ring.values, 0.5, ring.count) : null,
                p95: ring ? percentileAtSnapshot(ring.values, 0.95, ring.count) : null,
            });
        }
        if (segments.length > 1) {
            segments.sort((a, b) => (Number(b.p95) || 0) - (Number(a.p95) || 0));
        }
        const totalRing = rings?.get('total');
        return {
            totalMs: timer?.lastTotalMs ?? this._lastRenderStats?.timings?.totalMs ?? 0,
            totalP50: totalRing ? percentileAtSnapshot(totalRing.values, 0.5, totalRing.count) : null,
            totalP95: totalRing ? percentileAtSnapshot(totalRing.values, 0.95, totalRing.count) : null,
            segments,
        };
    }

    _updateChatMatching() {
        const senders = new Set();
        const spriteByRecipient = new Map();

        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            const agent = sprite.agent;
            if (!agent) continue;
            const aliases = [
                agent.name,
                agent.agentName,
                agent.agentId,
                agent.id,
            ].filter(Boolean);

            for (const alias of aliases) {
                if (!spriteByRecipient.has(alias)) {
                    spriteByRecipient.set(alias, sprite);
                }
            }
        }

        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            const agent = sprite.agent;
            if (!agent) continue;
            if (agent.status === AgentStatus.WORKING && agent.currentTool === 'SendMessage' && agent.currentToolInput) {
                senders.add(sprite);

                if (sprite.chatPartner) continue;

                const recipient = extractRecipientName(agent.currentToolInput);
                if (!recipient) continue;
                const target = spriteByRecipient.get(recipient);
                if (target && target !== sprite) {
                    sprite.startChat(target);
                }
            }
        }

        // Clear chat state for agents not using SendMessage
        for (const sprite of this.agentSprites.values()) {
            if (this._isGateTransit(sprite)) continue;
            if (sprite.chatPartner && !senders.has(sprite)) {
                // Keep it if the other side is still using SendMessage
                if (senders.has(sprite.chatPartner)) continue;
                const partner = sprite.chatPartner;
                sprite.endChat();
                if (partner.chatPartner === sprite) partner.endChat();
            }
        }
    }

    setPinnedAgentIds(ids) {
        const seen = new Set();
        this._pinnedAgentIds = Array.isArray(ids)
            ? ids.flatMap((id) => {
                const normalized = typeof id === 'string' ? id.trim() : '';
                if (!normalized || seen.has(normalized)) return [];
                seen.add(normalized);
                return [normalized];
            }).slice(0, 2)
            : [];
        this._forwardTaskboardCandidates();
        this._invalidateIdleFrame();
    }

    getPinnedAgentIds() {
        return [...(this._pinnedAgentIds || [])];
    }

    _forwardTaskboardCandidates() {
        this.buildingRenderer?.setTaskboardCandidates?.([
            this.selectedAgent?.id,
            ...(this._pinnedAgentIds || []),
        ].filter(Boolean));
    }

    selectAgentById(agentId) {
        this._invalidateIdleFrame();
        if (agentId && !this.selectedAgent) this._inspectionPose = this.camera.capturePose();
        for (const sprite of this.agentSprites.values()) {
            sprite.selected = false;
        }
        if (agentId) {
            const sprite = this.agentSprites.get(agentId);
            if (sprite && !this._isGateTransit(sprite, 'departure')) {
                sprite.selected = true;
                this.selectedAgent = sprite.agent;
                this.camera.followAgent(sprite);
                this._forwardTaskboardCandidates();
                return;
            }
        }
        this.selectedAgent = null;
        this._forwardTaskboardCandidates();
        this.camera.stopFollow();
        if (this._inspectionPose && this.camera._lastUserInputAt === this._inspectionPose.inputAt) this.camera.restorePose(this._inspectionPose);
        this._inspectionPose = null;
    }

    _update(dt = 16) {
        this._ritualSyncFrame = (this._ritualSyncFrame + 1) % 1000000;

        // Update camera follow
        if (this.camera) {
            // #attract — let the idle-attract director consider a move before the
            // camera ticks, so any glide it starts advances this same frame.
            this.cameraDirector?.update({
                now: performance.now(),
                dt,
                agentSprites: this.agentSprites,
                snapshot: this.villageDirector?.getSnapshot?.() || null,
            });
            // #50 — pass wall-clock time so the camera can measure idle duration
            // for the Ken-Burns drift independently of accumulated dt.
            this.camera.update(dt, performance.now());
            this.camera.updateFollow(dt);
        }

        // Chat matching only depends on session/tool state, not frame-perfect motion.
        this._chatMatchAccumulator += dt;
        let slowSystemsTick = false;
        if (this._chatMatchAccumulator >= 250) {
            this._chatMatchAccumulator = 0;
            slowSystemsTick = true;
            this._updateChatMatching();
            this.agentEventStream?.reconcileChatPairs?.(this.agentSprites);
        }
        const now = performance.now();
        const chronicleNow = Date.now();
        // Visit allocation and relationship clustering share the same semantic cadence.
        const agents = slowSystemsTick
            ? this._updateVisitSystems(chronicleNow)
            : this._activeAgentsSnapshot;
        if (slowSystemsTick) {
            this.relationshipState?.reconcile?.({ agentSprites: this.agentSprites, now });
            applyTeamPlazaPreferences(this.relationshipState, this.agentSprites);
        }
        this._pruneCrowdBumpCooldowns(now);
        // 2.4 — affinity proximity re-evaluates on a slow cadence; warmth
        // changes are gradual, so per-frame work would be wasted.
        this._affinityProximityAccumulator += dt;
        if (this._affinityProximityAccumulator >= AFFINITY_PROXIMITY_INTERVAL_MS) {
            this._affinityProximityAccumulator = 0;
            this._applyAffinityProximity(chronicleNow);
        }
        this.arrivalDeparture?.update?.(now);
        this.chronicler?.update?.(dt, chronicleNow);
        if (chronicleNow >= this._chronicleNextUpdateAt) {
            this._chronicleNextUpdateAt = chronicleNow + 1000;
            this._updateChronicleSystems(chronicleNow);
        }

        // Update agent sprites. Routing, reservations, chat convergence and
        // arrival/departure completion remain global: skipping those off-screen
        // would make villagers jump or arrive in the wrong state when revealed.
        // Particle emission is purely visual, so sprites beyond the generous
        // screen apron advance against a null sink while keeping all state.
        let shouldResort = false;
        const completedDepartures = [];
        const viewport = this._screenViewport();
        for (const sprite of this.agentSprites.values()) {
            const particleSink = this._agentVisibleOnScreen(sprite, viewport)
                ? this.particleSystem
                : null;
            sprite.update(particleSink, dt);
            const transit = this.gateTransits.get(sprite.agent?.id);
            if (transit && !sprite.moving && sprite.hasReachedTarget?.()) {
                if (transit.type === 'departure') {
                    completedDepartures.push(sprite.agent.id);
                } else {
                    this.gateTransits.delete(sprite.agent.id);
                }
            }
            if (sprite._lastSortedY !== sprite.y) {
                shouldResort = true;
                sprite._lastSortedY = sprite.y;
            }
        }
        for (const agentId of completedDepartures) this._removeAgentSprite(agentId);
        if (shouldResort) {
            this._markSpritesDirty();
        }

        // Steering separation: keep lane corrections and local nudges conservative
        // so AgentSprite remains the source of target ownership and arrival state.
        const movingSprites = this._movingSprites;
        movingSprites.length = 0;
        for (const sprite of this.agentSprites.values()) {
            if (sprite.moving && !sprite.chatting && !this._isGateTransit(sprite, 'departure')) {
                movingSprites.push(sprite);
            }
        }
        this._applyLaneDiscipline(movingSprites, dt);
        this._applyLocalAvoidance(movingSprites, dt);
        this._crowdStatsAccumulator += dt;
        if (this._crowdStatsAccumulator >= 250 || this.agentSprites.size !== this._lastAgentCount) {
            this._crowdStatsAccumulator = 0;
            this._lastAgentCount = this.agentSprites.size;
            this._crowdStats = this._summarizeCrowdClusters();
        }
        this._stationaryOverlapAccumulator += dt;
        if (this._stationaryOverlapAccumulator >= 420) {
            this._stationaryOverlapAccumulator = 0;
            this._resolveStationaryOverlaps();
        }

        // These consumers need every live position but do not require painter
        // order. Defer Y ordering until the render path has viewport-culled.
        const allSpritesSnapshot = this._snapshotAllSprites();
        this._replayActiveToolRituals();
        this.ritualConductor?.update?.(dt);
        this._syncToolRitualPoses();

        // Ship motion is visual and stays frame-smooth. Git/source semantics
        // only need the existing 250ms application cadence.
        this.harborTraffic?.advance?.(dt);
        if (slowSystemsTick) {
            this.harborTraffic?.reconcile?.(agents, chronicleNow);
            this._harborFailedPushState = this.harborTraffic?.getFailedPushState?.(chronicleNow) || null;
            let activeWorkingCount = 0;
            for (const agent of agents) {
                if (agent?.status === AgentStatus.WORKING) activeWorkingCount++;
            }
            this._activeWorkingCount = activeWorkingCount;
            this.villageDirector?.setHarborState?.(this._harborFailedPushState);
            this.buildingRenderer?.setHarborStatus?.({
                failedPushActive: Boolean(this._harborFailedPushState?.hasFailedPush),
                activeWorkingCount,
            });
        }
        this.landmarkActivity?.update?.(agents, allSpritesSnapshot, dt, chronicleNow);
        const updateNow = Date.now();
        this.villageDirector?.update?.(this, dt, updateNow);
        this.buildingRenderer?.setZoom?.(this.camera?.zoom);

        // Update building renderer (pass agent sprite positions)
        this.buildingRenderer?.setAgentSprites(allSpritesSnapshot);
        this.buildingRenderer?.update(dt);
        this._updateAmbientEffects(dt);

        // Reap any agent sprites whose 800ms archive-fade window has expired
        // before the particle update so the next frame draws the final state.
        this._pruneArchiveFadedSprites(Date.now());

        // Seasonal ambience emits drift particles into the shared particle
        // system, capped at ~4 spawns/sec and gated by reduced motion inside
        // SeasonalAmbience.update().
        this.seasonalAmbience?.update?.(dt);

        // Rain splashes at agent feet, gated by weather + reduced motion.
        this._updateRainSplashes(dt);

        // Update particles
        this.particleSystem.update(dt);
    }

    _updateChronicleSystems(now = Date.now()) {
        if (this._chronicleUpdating || this._disposed) return;
        this._chronicleUpdating = true;
        const agents = Array.from(this.world?.agents?.values?.() || []);
        const context = {
            waterTiles: this.waterTiles,
            blockedTiles: this._monumentBlockedTiles(),
        };
        const pending = Promise.allSettled([
            this.chronicleMonuments?.update?.(agents, context, now),
            this.trailRenderer?.update?.(agents, now, this._lastAtmosphere),
        ]);
        this._chronicleUpdatePromise = pending;
        pending.finally(() => {
            if (this._chronicleUpdatePromise === pending) this._chronicleUpdatePromise = null;
            this._chronicleUpdating = false;
            this._invalidateIdleFrame();
        });
    }

    drainChronicleUpdates() {
        return this._chronicleUpdatePromise || Promise.resolve([]);
    }

    _monumentBlockedTiles() {
        if (this._monumentBlockedTilesCache) return this._monumentBlockedTilesCache;
        const out = new Set();
        const grid = this.walkabilityGrid || [];
        if (!grid.length) {
            this._monumentBlockedTilesCache = out;
            return out;
        }
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                if (!grid[y * MAP_SIZE + x]) out.add(`${x},${y}`);
            }
        }
        this._monumentBlockedTilesCache = out;
        return out;
    }

    _isSpritePositionWalkable(sprite, x, y) {
        if (!this.pathfinder || typeof sprite?._screenToTile !== 'function') return true;
        const tile = sprite._screenToTile(x, y);
        return this.pathfinder.isWalkable(Math.round(tile.tileX), Math.round(tile.tileY));
    }

    _buildLaneTileIndex() {
        const lanes = new Map();
        if (!this.pathTiles?.size) return lanes;
        for (const key of this.pathTiles) {
            if (!this._isRoadLikeTileKey(key)) continue;
            const tile = this._parseTileKey(key);
            if (!tile) continue;
            if (this.pathfinder && !this.pathfinder.isWalkable(tile.tileX, tile.tileY)) continue;
            const bridgeAxis = laneAxisForBridgeOrientation(this.bridgeTiles?.get?.(key)?.orientation);
            const axis = bridgeAxis || this._bestRoadAxis(tile.tileX, tile.tileY);
            if (!axis) continue;
            const center = tileToWorld(tile.tileX, tile.tileY);
            const next = tileToWorld(tile.tileX + axis.dx, tile.tileY + axis.dy);
            const vx = next.x - center.x;
            const vy = next.y - center.y;
            const length = Math.hypot(vx, vy);
            if (length <= 0) continue;
            const degree = this._roadNeighborCount(tile.tileX, tile.tileY);
            const material = this._roadMaterialForKey(key);
            const plazaLike = this.townSquareTiles?.has(key) || degree >= 4;
            lanes.set(key, {
                tileKey: key,
                tileX: tile.tileX,
                tileY: tile.tileY,
                tangentX: vx / length,
                tangentY: vy / length,
                perpX: -vy / length,
                perpY: vx / length,
                laneOffset: plazaLike
                    ? LANE_STEERING.plazaOffsetPx
                    : material === 'avenue'
                        ? LANE_STEERING.avenueOffsetPx
                        : LANE_STEERING.dirtOffsetPx,
                material,
                degree,
                plazaLike,
            });
        }
        return lanes;
    }

    _parseTileKey(key) {
        const comma = String(key).indexOf(',');
        if (comma < 0) return null;
        const tileX = Number(String(key).slice(0, comma));
        const tileY = Number(String(key).slice(comma + 1));
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        return { tileX, tileY };
    }

    _isRoadLikeTileKey(key) {
        return !!(
            this.pathTiles?.has(key) &&
            (
                this.mainAvenueTiles?.has(key) ||
                this.dirtPathTiles?.has(key) ||
                this.commandCenterRoadTiles?.has(key) ||
                this.bridgeTiles?.has?.(key)
            )
        );
    }

    _roadMaterialForKey(key) {
        if (this.bridgeTiles?.has?.(key)) return 'bridge';
        if (this.mainAvenueTiles?.has(key) || this.commandCenterRoadTiles?.has(key)) return 'avenue';
        if (this.dirtPathTiles?.has(key)) return 'dirt';
        return 'path';
    }

    // #42 — surface material under a tile, used to key terrain-aware footfall
    // particles (dirt→dust, cobble→scuff, grass→motes, shallow→splash). Reuses
    // the same tile Sets the terrain bake classifies from, so footfalls match
    // the ground the renderer drew. Bridges read as cobble (planked stone deck);
    // deep water never receives footfalls (agents don't walk it).
    _surfaceMaterialAt(tileX, tileY) {
        const key = `${Math.round(tileX)},${Math.round(tileY)}`;
        if (this.waterTiles?.has(key) && !this.bridgeTiles?.has(key)) {
            return this.deepWaterTiles?.has(key) ? 'deep' : 'shallow';
        }
        if (this.bridgeTiles?.has(key)) return 'cobble';
        if (this.mainAvenueTiles?.has(key) || this.commandCenterRoadTiles?.has(key)) return 'cobble';
        if (this.dirtPathTiles?.has(key) || this.pathTiles?.has(key)) return 'dirt';
        return 'grass';
    }

    _roadNeighborCount(tileX, tileY) {
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (this._isRoadLikeTileKey(`${tileX + dx},${tileY + dy}`)) count++;
            }
        }
        return count;
    }

    _bestRoadAxis(tileX, tileY) {
        const axes = [
            { dx: 1, dy: 0 },
            { dx: 0, dy: 1 },
            { dx: 1, dy: 1 },
            { dx: 1, dy: -1 },
        ];
        let best = null;
        let bestScore = 0;
        for (const axis of axes) {
            let score = 0;
            if (this._isRoadLikeTileKey(`${tileX + axis.dx},${tileY + axis.dy}`)) score++;
            if (this._isRoadLikeTileKey(`${tileX - axis.dx},${tileY - axis.dy}`)) score++;
            if (score > bestScore) {
                best = axis;
                bestScore = score;
            }
        }
        return best;
    }

    _laneInfoForSprite(sprite) {
        if (!sprite || !this._laneTiles?.size) return null;
        const tile = worldToTile(sprite.x, sprite.y);
        if (!tile || !Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) return null;
        const roundedKey = `${Math.round(tile.tileX)},${Math.round(tile.tileY)}`;
        const direct = this._laneTiles.get(roundedKey);
        if (direct) return direct;

        let best = null;
        let bestDistance = Infinity;
        const baseX = Math.round(tile.tileX);
        const baseY = Math.round(tile.tileY);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const candidate = this._laneTiles.get(`${baseX + dx},${baseY + dy}`);
                if (!candidate) continue;
                const distance = Math.hypot(tile.tileX - candidate.tileX, tile.tileY - candidate.tileY);
                if (distance < bestDistance) {
                    best = candidate;
                    bestDistance = distance;
                }
            }
        }
        return bestDistance <= 1.15 ? best : null;
    }

    _laneSideForSprite(sprite, lane) {
        const vx = Number(sprite?.targetX) - Number(sprite?.x);
        const vy = Number(sprite?.targetY) - Number(sprite?.y);
        const along = vx * lane.tangentX + vy * lane.tangentY;
        if (Math.abs(along) > 0.05) return along >= 0 ? 1 : -1;
        return (this._stableHash(sprite?.agent?.id || sprite?.id || '') % 2) === 0 ? 1 : -1;
    }

    _applyLaneDiscipline(movingSprites, dt = 16) {
        if (!movingSprites?.length || !this._laneTiles?.size) return;
        const dense = this.agentSprites.size >= 50;
        const frameScale = Math.max(0, Math.min(2.5, dt / 16));
        const maxCorrection = (dense ? LANE_STEERING.denseCorrectionPx : LANE_STEERING.correctionPx) * frameScale;
        let corrections = 0;
        for (const sprite of movingSprites) {
            if (!sprite || sprite.chatPartner || sprite.chatting || sprite.isArrivalPending?.()) continue;
            const targetDistance = Math.hypot(
                Number(sprite.targetX) - Number(sprite.x),
                Number(sprite.targetY) - Number(sprite.y),
            );
            if (!Number.isFinite(targetDistance) || targetDistance <= LANE_STEERING.arrivalDistancePx) {
                delete sprite._laneDiscipline;
                continue;
            }
            const lane = this._laneInfoForSprite(sprite);
            if (!lane) {
                delete sprite._laneDiscipline;
                continue;
            }
            const side = this._laneSideForSprite(sprite, lane);
            const center = tileToWorld(lane.tileX, lane.tileY);
            const currentOffset = (sprite.x - center.x) * lane.perpX + (sprite.y - center.y) * lane.perpY;
            const desiredOffset = lane.laneOffset * side;
            const correction = desiredOffset - currentOffset;
            if (Math.abs(correction) < LANE_STEERING.minimumCorrectionPx) {
                sprite._laneDiscipline = { tileKey: lane.tileKey, side, offsetPx: desiredOffset };
                continue;
            }
            const step = Math.max(-maxCorrection, Math.min(maxCorrection, correction));
            const steered = constrainSteeringToTarget({
                x: sprite.x,
                y: sprite.y,
                nextX: sprite.x + lane.perpX * step,
                nextY: sprite.y + lane.perpY * step,
                targetX: sprite.targetX,
                targetY: sprite.targetY,
            });
            if (!this._isSpritePositionWalkable(sprite, steered.x, steered.y)) continue;
            if (Math.hypot(steered.x - sprite.x, steered.y - sprite.y) <= 0.001) continue;
            sprite.x = steered.x;
            sprite.y = steered.y;
            sprite._laneDiscipline = { tileKey: lane.tileKey, side, offsetPx: desiredOffset };
            if (steered.constrained) this._localAvoidanceMetrics.progressClamps++;
            corrections++;
        }
        if (corrections > 0) {
            this._localAvoidanceMetrics.laneCorrections += corrections;
            this._markSpritesDirty();
        }
    }

    _applyLocalAvoidance(movingSprites, dt = 16) {
        if (!movingSprites?.length) return;
        const dense = this.agentSprites.size >= 50;
        const radius = dense ? LOCAL_AVOIDANCE.denseRadiusPx : LOCAL_AVOIDANCE.radiusPx;
        const frameScale = Math.max(0, Math.min(2.5, dt / 16));
        const baseStrength = (dense ? LOCAL_AVOIDANCE.denseStrengthPx : LOCAL_AVOIDANCE.strengthPx) * frameScale;
        let pushes = 0;
        let zeroDistancePairs = 0;
        this._forEachNearbySpritePair(movingSprites, LOCAL_AVOIDANCE.bucketPx, (a, b) => {
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            let dist = Math.hypot(dx, dy);
            if (dist >= radius) return true;

            let nx;
            let ny;
            if (dist <= 0.001) {
                const angle = (this._stableHash(`${a.agent?.id || a.x}|${b.agent?.id || b.x}`) % 628) / 100;
                nx = Math.cos(angle);
                ny = Math.sin(angle);
                dist = 0;
                zeroDistancePairs++;
            } else {
                nx = dx / dist;
                ny = dy / dist;
            }

            const overlap = dist > 0 ? (radius - dist) / radius : 1;
            const sameLane = a._laneDiscipline?.tileKey && a._laneDiscipline.tileKey === b._laneDiscipline?.tileKey;
            const opposingLanes = sameLane && a._laneDiscipline.side !== b._laneDiscipline.side;
            const strength = baseStrength * (opposingLanes ? 0.55 : 1);
            const nextA = constrainSteeringToTarget({
                x: a.x,
                y: a.y,
                nextX: a.x + nx * overlap * strength,
                nextY: a.y + ny * overlap * strength,
                targetX: a.targetX,
                targetY: a.targetY,
            });
            const nextB = constrainSteeringToTarget({
                x: b.x,
                y: b.y,
                nextX: b.x - nx * overlap * strength,
                nextY: b.y - ny * overlap * strength,
                targetX: b.targetX,
                targetY: b.targetY,
            });

            let moved = false;
            if (
                Math.hypot(nextA.x - a.x, nextA.y - a.y) > 0.001
                && this._isSpritePositionWalkable(a, nextA.x, nextA.y)
            ) {
                a.x = nextA.x;
                a.y = nextA.y;
                if (nextA.constrained) this._localAvoidanceMetrics.progressClamps++;
                moved = true;
            }
            if (
                Math.hypot(nextB.x - b.x, nextB.y - b.y) > 0.001
                && this._isSpritePositionWalkable(b, nextB.x, nextB.y)
            ) {
                b.x = nextB.x;
                b.y = nextB.y;
                if (nextB.constrained) this._localAvoidanceMetrics.progressClamps++;
                moved = true;
            }
            if (moved) {
                pushes++;
                this._emitCrowdBumpFeedback(a, b, overlap);
            }
            return true;
        });
        if (pushes > 0) {
            this._localAvoidanceMetrics.separationPushes += pushes;
            this._markSpritesDirty();
        }
        if (zeroDistancePairs > 0) {
            this._localAvoidanceMetrics.zeroDistancePairs += zeroDistancePairs;
        }
    }

    _forEachNearbySpritePair(sprites, cellSize, visitor) {
        const size = Math.max(1, Number(cellSize) || LOCAL_AVOIDANCE.bucketPx);
        const buckets = this._pairBuckets;
        const ids = this._pairIds;
        const visited = this._pairVisited;
        buckets.clear();
        ids.clear();
        visited.clear();
        for (let index = 0; index < sprites.length; index++) {
            const sprite = sprites[index];
            if (!sprite) continue;
            ids.set(sprite, this._spriteStableId(sprite, index));
            const key = `${Math.floor(sprite.x / size)},${Math.floor(sprite.y / size)}`;
            const bucket = buckets.get(key) || [];
            bucket.push(sprite);
            buckets.set(key, bucket);
        }

        for (const [key, bucket] of buckets.entries()) {
            const [cellX, cellY] = key.split(',').map(Number);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    const other = buckets.get(`${cellX + ox},${cellY + oy}`);
                    if (!other) continue;
                    for (const a of bucket) {
                        for (const b of other) {
                            if (a === b) continue;
                            const idA = ids.get(a);
                            const idB = ids.get(b);
                            if (!idA || !idB || idA === idB) continue;
                            const pairKey = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
                            if (visited.has(pairKey)) continue;
                            visited.add(pairKey);
                            if (visitor(a, b) === false) return false;
                        }
                    }
                }
            }
        }
        return true;
    }

    _spriteStableId(sprite, fallbackIndex = 0) {
        return String(
            sprite?.agent?.id ||
            sprite?.id ||
            `${Math.round(Number(sprite?.x) || 0)}:${Math.round(Number(sprite?.y) || 0)}:${fallbackIndex}`
        );
    }

    _stableHash(value) {
        const text = String(value || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    _emptyCrowdStats() {
        return {
            agentCount: 0,
            visibleAgents: 0,
            movingAgents: 0,
            clusterCellSize: CROWD_CLUSTER_TILE_SIZE,
            minClusterSize: 3,
            denseClusterCount: 0,
            maxClusterSize: 0,
            congestedAgents: 0,
            clusters: [],
        };
    }

    _summarizeCrowdClusters() {
        const entries = [];
        let visibleAgents = 0;
        let movingAgents = 0;
        for (const sprite of this.agentSprites.values()) {
            if (!sprite || this._isGateTransit(sprite, 'departure') || sprite.isArrivalPending?.()) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            if (!tile || !Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) continue;
            visibleAgents++;
            if (sprite.moving) movingAgents++;
            entries.push({
                tileX: tile.tileX,
                tileY: tile.tileY,
                moving: !!sprite.moving,
                status: sprite.agent?.status || 'unknown',
                provider: sprite.agent?.provider || 'unknown',
                teamName: sprite.agent?.teamName || null,
            });
        }

        const summary = summarizeCrowdClusterEntries(entries, {
            cellSize: CROWD_CLUSTER_TILE_SIZE,
            topLimit: CROWD_CLUSTER_TOP_LIMIT,
            includeDominantProvider: true,
            includeStatusCounts: true,
        });

        return {
            agentCount: this.agentSprites.size,
            visibleAgents,
            movingAgents,
            clusterCellSize: CROWD_CLUSTER_TILE_SIZE,
            minClusterSize: summary.minClusterSize,
            denseClusterCount: summary.clusters.length,
            maxClusterSize: summary.maxClusterSize,
            congestedAgents: summary.congestedAgents,
            clusters: summary.clusters,
        };
    }

    _resolveStationaryOverlaps() {
        const now = Date.now();
        const candidates = Array.from(this.agentSprites.values()).filter((sprite) => (
            sprite &&
            !sprite.moving &&
            !sprite.chatting &&
            !sprite.chatPartner &&
            !sprite.selected &&
            !this._isGateTransit(sprite, 'departure') &&
            !sprite.isArrivalPending?.() &&
            this._canStationaryRetarget(sprite, now)
        ));
        this.behaviorMetrics.stationaryOverlapChecks++;
        const threshold = this.agentSprites.size >= 50 ? 26 : 24;
        const maxRetargets = this.agentSprites.size >= 50 ? 5 : 2;
        let retargets = 0;
        this._forEachNearbySpritePair(candidates, threshold + 8, (a, b) => {
            if (retargets >= maxRetargets) return false;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= 0 || dist >= threshold) return true;
            const aSnap = a.getBehaviorDebugSnapshot?.();
            const bSnap = b.getBehaviorDebugSnapshot?.();
            const sameBuilding = aSnap?.building && aSnap.building === bSnap?.building;
            if (!sameBuilding && dist > 14) return true;
            const loser = (aSnap?.behavior?.lastRerouteAt || 0) <= (bSnap?.behavior?.lastRerouteAt || 0) ? a : b;
            if (loser.retargetVisit?.()) {
                retargets++;
                this.behaviorMetrics.stationaryRetargets++;
            }
            return retargets < maxRetargets;
        });
    }

    _canStationaryRetarget(sprite, now = Date.now()) {
        const snap = sprite.getBehaviorDebugSnapshot?.();
        const state = snap?.behaviorState;
        if (['performing', 'cooldown', 'chatting', 'chat-approach', 'blocked'].includes(state)) return false;
        if (String(snap?.building || '').startsWith('ambient:') && state === 'lingering') return false;
        const arrivedAt = Number(snap?.behavior?.arrivedAt || 0);
        if (arrivedAt && now - arrivedAt < 2500) return false;
        return true;
    }

    _pruneCrowdBumpCooldowns(now = performance.now()) {
        for (const [key, expiresAt] of this._crowdBumpCooldowns) {
            if (expiresAt <= now) this._crowdBumpCooldowns.delete(key);
        }
        while (this._crowdBumpCooldowns.size > CROWD_BUMP_COOLDOWN_LIMIT) {
            this._crowdBumpCooldowns.delete(this._crowdBumpCooldowns.keys().next().value);
        }
    }

    _emitCrowdBumpFeedback(a, b, overlap = 0) {
        const now = performance.now();
        const key = [a.agent?.id || a.x, b.agent?.id || b.x].sort().join('|');
        if ((this._crowdBumpCooldowns.get(key) || 0) > now) return;
        while (this._crowdBumpCooldowns.size >= CROWD_BUMP_COOLDOWN_LIMIT) {
            this._crowdBumpCooldowns.delete(this._crowdBumpCooldowns.keys().next().value);
        }
        this._crowdBumpCooldowns.set(key, now + 650);
        a.bumpFlash = Math.max(a.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        b.bumpFlash = Math.max(b.bumpFlash || 0, Math.min(1, 0.4 + overlap));
        if (this.motionScale > 0) {
            this.particleSystem.spawn('crowdBump', (a.x + b.x) / 2, (a.y + b.y) / 2 + 6, 2);
        }
    }

    _updateAmbientEffects(dt = 16) {
        if (!this.motionScale || this.ambientEmitters.length === 0) return;

        const maxParticles = this.particleSystem.maxParticles || 240;
        const activeParticles = this.particleSystem.particles.length || 0;
        if (activeParticles > maxParticles - 40) return;

        const particleBudget = Math.max(0.22, 1 - activeParticles / maxParticles);
        let spawned = 0;
        const now = performance.now();
        for (const emitter of this.ambientEmitters) {
            // Active-building emitters use interval timing and
            // are not subject to the single-spawn-per-frame cap below.
            if (emitter.gatedBy === ACTIVE_BUILDING_EMITTER_GATE) {
                const presence = emitter.building
                    ? this._buildingPresenceMap?.get(emitter.building)
                    : null;
                const tier = presence?.tier;
                if (tier !== 'occupied' && tier !== 'busy') continue;
                const interval = Math.max(120, emitter.intervalMs || 600);
                const last = this._emitterIntervalLastMs.get(emitter) || 0;
                if (now - last < interval) continue;
                this._emitterIntervalLastMs.set(emitter, now);
                const yOffset = Number.isFinite(emitter.worldYOffset) ? emitter.worldYOffset : -18;
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y + yOffset, 1);
                continue;
            }

            if (spawned >= 1) continue;

            // E7 — fireflies only emerge after dusk and swarm hardest at night.
            let chanceScale = 1;
            if (emitter.particleType === 'firefly') {
                const phase = this._lastAtmosphere?.phase;
                if (phase !== 'dusk' && phase !== 'night') continue;
                if (phase === 'night') chanceScale = 3;
            }

            const localBudget = this._ambientEmitterBudget(emitter);
            const frameScale = Math.max(0, Math.min(3, dt / 16));
            const chance = 1 - Math.pow(1 - Math.max(0, Math.min(1, emitter.chance * particleBudget * localBudget * chanceScale)), frameScale);
            if (Math.random() < chance) {
                this.particleSystem.spawn(emitter.particleType, emitter.x, emitter.y - 18, 1);
                spawned++;
            }
        }
    }

    // Weather→agent response: while rain or storm is active, tiny splash
    // particles pop at agent feet. Atmospheric only — accumulator-rate spawns
    // capped per frame, skipped when the shared particle pool is near its
    // budget, and switched off entirely under reduced motion (motionScale 0).
    _updateRainSplashes(dt = 16) {
        if (!this.motionScale || this.agentSprites.size === 0) {
            this._rainSplashAccumulator = 0;
            return;
        }
        const weather = this._lastAtmosphere?.weather || null;
        const raining = weather && (weather.type === 'rain' || weather.type === 'storm');
        if (!raining) {
            this._rainSplashAccumulator = 0;
            return;
        }

        const maxParticles = this.particleSystem.maxParticles || 240;
        if ((this.particleSystem.particles.length || 0) > maxParticles - 60) return;

        const intensity = Math.max(0, Math.min(1, Number(weather.intensity) || 0));
        const stormBoost = weather.type === 'storm' ? 1.5 : 1;
        const agentWeight = Math.min(this.agentSprites.size, 16);
        const splashesPerSecond = (0.4 + intensity * 0.8) * stormBoost * agentWeight * this.motionScale;
        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        this._rainSplashAccumulator += splashesPerSecond * (frameDt / 1000);

        const spawns = Math.min(3, Math.floor(this._rainSplashAccumulator));
        if (spawns <= 0) return;
        this._rainSplashAccumulator -= spawns;

        const sprites = Array.from(this.agentSprites.values());
        for (let i = 0; i < spawns; i++) {
            const sprite = sprites[Math.floor(Math.random() * sprites.length)];
            if (!sprite || sprite.isArrivalPending?.()) continue;
            // Feet sit ~7px below the sprite anchor (matches footstep dust).
            this.particleSystem.spawn('rainSplash', sprite.x, sprite.y + 7, 1, { spread: 5 });
        }
    }

    _ambientEmitterBudget(emitter) {
        const nearHarbor = emitter.tileX >= 30 && emitter.tileY >= 15 && emitter.tileY <= 25;
        const nearCommand = emitter.tileX >= 16 && emitter.tileX <= 24 && emitter.tileY >= 16 && emitter.tileY <= 23;
        if (nearCommand) return 0.9;
        if (nearHarbor) return 0.45;
        return 0.65;
    }

    _render(dt = 16) {
        // #2 — reset the mark governor once per frame before any draw pass runs.
        // Region size scales with zoom so a "screen region" stays roughly fixed
        // in screen pixels regardless of the integer zoom level.
        this.markGovernor.beginFrame({
            regionSize: 200 / (this.camera?.zoom || 1),
            motionScale: this.motionScale,
        });
        this._syncSemanticSummary();
        renderWorldFrame(this, dt);
    }

    _syncSemanticSummary() {
        const el = document.getElementById('worldSemanticSummary');
        if (!el) return;
        const agents = Array.from(this.agentSprites.values()).map(sprite => sprite.agent).filter(Boolean);
        const counts = bucketCounts(agents);
        const selected = this.selectedAgent?.name ? ` Selected ${this.selectedAgent.name}.` : '';
        const text = `Village: ${agents.length} agents. ${counts.needsYou} need you, ${counts.errors} errored, ${counts.quota} quota-limited, ${counts.watchlist} waiting, ${counts.working} working.${selected}`;
        if (text !== this._semanticSummaryText) { this._semanticSummaryText = text; el.textContent = text; }
    }

    _harborPendingReposSignature(repos = []) {
        if (!Array.isArray(repos) || repos.length === 0) return '';
        return repos
            .map(repo => [
                repo.project || repo.projectPath || repo.path || repo.name || '',
                repo.branch || '',
                repo.pendingCommits ?? repo.count ?? repo.pending ?? '',
                repo.failedPushes ?? '',
                Math.floor((Number(repo.latestEventTime) || 0) / 1000),
                Math.floor((Number(repo.oldestCommitTime) || 0) / 60_000),
                repo.profile?.accent || '',
            ].join(':'))
            .sort()
            .join('|');
    }

    _drawFamiliarMotesForFamilies(ctx, _sortedSprites, atmosphere = null) {
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return;
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            drawFamiliarMotes(ctx, {
                parentSprite,
                childSprites,
                childAgents: departedChildren,
                zoom: this.camera?.zoom || 1,
                now,
                motionScale: this.motionScale,
                lighting: atmosphere?.lighting,
            });
        }
    }

    _enumerateFamiliarMoteDrawables(atmosphere = null) {
        const drawables = this._familiarMoteDrawables;
        drawables.length = 0;
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return drawables;
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            if (!childSprites.length && !departedChildren.length) continue;
            drawables.push({
                kind: 'familiar-motes',
                sortY: parentSprite.y - 50,
                draw: (ctx, zoom) => drawFamiliarMotes(ctx, {
                    parentSprite,
                    childSprites,
                    childAgents: departedChildren,
                    zoom,
                    now,
                    motionScale: this.motionScale,
                    lighting: atmosphere?.lighting,
                }),
            });
        }
        return drawables;
    }

    // Returns `{ body, annotation }`. Annotation LOD (labels, bubbles, name
    // tags) follows scene pressure as a whole-village policy so viewport
    // culling cannot visibly change label style while the camera pans.
    // Body LOD (the 28px compact silhouette in AgentSprite) is gated on the
    // population/viewport thresholds only: pressure is fed by crowd-cell
    // congestion that steps every time a walker crosses a cell boundary, and
    // letting it drive body size made whole villages flicker to mini size.
    _agentRenderMode(viewport = this._screenViewport(), _visibleSprites = this._snapshotSortedSprites()) {
        // Pressure does not depend on painter order, so the reusable unsorted
        // snapshot preserves the previous semantics without a full sort.
        const sprites = this._snapshotAllSprites();
        const count = sprites.length;
        const zoom = this.camera?.zoom || 1;
        let projectedArea = 0;
        for (const sprite of _visibleSprites) {
            const point = this.camera.worldToScreen(sprite.x, sprite.y);
            if (point.x < -60 * zoom || point.x > viewport.width + 60 * zoom
                || point.y < 0 || point.y > viewport.height + 100 * zoom) continue;
            projectedArea += 48 * 72 * zoom * zoom;
        }
        const overlayArea = Math.max(count * (zoom >= 3 ? 3900 : 2100), projectedArea);
        const collisions = Number(this._crowdStats?.congestedAgents) || 0;
        const pressure = Math.max(
            calculateScenePressure({ sprites, viewport, zoom, overlayArea, collisions }),
            collisions >= 5 && collisions > count / 2 ? 0.5 : 0,
        );
        const pressureMode = annotationModeForPressure(pressure, this._annotationMode || 'full');
        this._annotationMode = pressureMode;
        const body = agentBodyRenderMode(count, viewport, zoom);
        const annotation = body === 'minimal' || pressureMode === 'minimal'
            ? 'minimal'
            : body === 'compact' || pressureMode === 'compact'
                ? 'compact'
                : 'full';
        return { body, annotation };
    }

    _createRectGrid(cellSize = AGENT_OVERLAY_GRID_CELL) {
        return {
            cellSize,
            generation: 0,
            buckets: new Map(),
            seen: new Set(),
        };
    }

    _beginRectGridFrame(grid) {
        grid.generation++;
        if (grid.generation < 1000000000) return;
        grid.generation = 1;
        grid.buckets.clear();
    }

    _insertRectGridItem(grid, rect, item = rect) {
        if (!grid || !rect) return;
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const key = (x + 32768) * 65536 + y + 32768;
                let bucket = grid.buckets.get(key);
                if (!bucket) {
                    bucket = { generation: grid.generation, items: [] };
                    grid.buckets.set(key, bucket);
                } else if (bucket.generation !== grid.generation) {
                    bucket.generation = grid.generation;
                    bucket.items.length = 0;
                }
                bucket.items.push(item);
            }
        }
    }

    _rectGridOverlapCount(grid, rect) {
        if (!grid || !rect) return 0;
        const seen = grid.seen;
        seen.clear();
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        let overlaps = 0;
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    const itemRect = item.rect || item;
                    if (this._rectsOverlap(rect, itemRect)) overlaps++;
                }
            }
        }
        return overlaps;
    }

    _rectGridHasOverlap(grid, rect) {
        if (!grid || !rect) return false;
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (this._rectsOverlap(rect, item.rect || item)) return true;
                }
            }
        }
        return false;
    }

    _rectListOverlapCount(items, rect) {
        let overlaps = 0;
        for (const item of items) {
            if (this._rectsOverlap(rect, item.rect || item)) overlaps++;
        }
        return overlaps;
    }

    _rectListHasOverlap(items, rect) {
        for (const item of items) {
            if (this._rectsOverlap(rect, item.rect || item)) return true;
        }
        return false;
    }

    _firstRectGridOverlap(grid, rect) {
        if (!grid || !rect) return null;
        const seen = grid.seen;
        seen.clear();
        const size = grid.cellSize;
        const x0 = Math.floor(rect.x / size);
        const x1 = Math.floor((rect.x + rect.w) / size);
        const y0 = Math.floor(rect.y / size);
        const y1 = Math.floor((rect.y + rect.h) / size);
        let first = null;
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const bucket = grid.buckets.get((x + 32768) * 65536 + y + 32768);
                if (!bucket || bucket.generation !== grid.generation) continue;
                for (const item of bucket.items) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    if (!this._rectsOverlap(rect, item.rect || item)) continue;
                    if (!first || item.order < first.order) first = item;
                }
            }
        }
        return first;
    }

    _assignAgentOverlaySlots(sprites, zoom = this.camera?.zoom || 1, { agentRenderMode = 'full' } = {}) {
        const compactGrid = this._overlayCompactGrid;
        const nameGrid = this._overlayNameGrid;
        const bubbleGrid = this._overlayBubbleGrid;
        const compactRects = this._overlayCompactRects;
        const nameRects = this._overlayNameRects;
        const reservedRects = this._overlayReservedRects;
        compactRects.length = 0;
        nameRects.length = 0;
        reservedRects.length = 0;
        // Dense crowd badges carry routine identities; primary agents stay named.
        // Action labels retain a cap because they are secondary detail.
        const actionLabelCap = agentRenderMode === 'minimal'
            ? 3
            : agentRenderMode === 'compact'
                ? 4
                : Infinity;
        let actionLabels = 0;
        const namedCrowdCells = new Set();
        const denseCrowdCells = new Set(agentRenderMode === 'full' ? []
            : (this._crowdStats?.clusters || []).filter(cluster => cluster.count > 5).map(cluster => cluster.id));
        // Cull before priority sorting or allocating any label geometry. The
        // input is normally already the visible painter snapshot, but keeping
        // this guard here makes the layout contract safe for other callers.
        const viewport = this._screenViewport();
        const prioritized = this._overlayPrioritizedSprites;
        prioritized.length = 0;
        for (const sprite of sprites || []) {
            if (sprite.agent && this._agentVisibleOnScreen(sprite, viewport)) prioritized.push(sprite);
        }
        prioritized.sort((a, b) => this._agentLabelPriority(b) - this._agentLabelPriority(a));
        // A direct scan is faster for small visible sets. Above that, the grid
        // bounds each query to spatial neighbours instead of the full crowd.
        const useSpatialGrid = prioritized.length > 32;
        if (useSpatialGrid) {
            this._beginRectGridFrame(compactGrid);
            this._beginRectGridFrame(nameGrid);
            this._beginRectGridFrame(bubbleGrid);
        }

        // Primary agents reserve their label envelope before buildings and
        // routine agents request overlay space later in the frame.
        for (const sprite of prioritized) {
            const status = sprite.agent?.status;
            if (!sprite.selected && ![AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status)) continue;
            this.markGovernor.reserve(this._agentCompactSlotRect(sprite, 0), 'primary', `agent:${sprite.agent.id}`);
        }

        for (const sprite of prioritized) {
            if (!sprite.agent) continue;
            const focusId = this.selectedAgent?.id || this.cameraDirector?.attentionFrame?.focusedAgentId;
            const primary = sprite.selected || sprite.agent.id === focusId
                || [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(sprite.agent.status);
            sprite.decisionFocusMuted = Boolean(focusId && sprite.agent.id !== focusId);
            sprite.decisionFocusRoutine = sprite.decisionFocusMuted && !primary;
            sprite.readVerb = this.getReadMode() && !primary ? sprite.readToolVerb || 'OTHER' : null;

            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;
            sprite.gpuActionOverlay = false;
            sprite.labelAlpha = this._agentLabelAlpha(sprite, zoom);
            sprite.foldedIntoBuilding = false;

            if (sprite.selected || sprite.agent.id === focusId) {
                const compactRect = this._agentCompactSlotRect(sprite, 0);
                const nameRect = this._agentNameSlotRect(sprite, 0);
                if (useSpatialGrid) {
                    this._insertRectGridItem(compactGrid, compactRect);
                    this._insertRectGridItem(nameGrid, nameRect);
                    this._insertRectGridItem(bubbleGrid, compactRect);
                    this._insertRectGridItem(bubbleGrid, nameRect);
                } else {
                    compactRects.push(compactRect);
                    nameRects.push(nameRect);
                    reservedRects.push(compactRect, nameRect);
                }
                sprite.overlaySlot = 0;
                sprite.nameTagSlot = 0;
                sprite.gpuActionOverlay = true;
                continue;
            }

            if (sprite.decisionFocusRoutine) {
                sprite.labelAlpha = 0;
                continue;
            }
            if (denseCrowdCells.size && this._isRoutineFoldCandidate(sprite)) {
                const tile = worldToTile(sprite.x, sprite.y);
                const cell = `${Math.floor(tile.tileX / CROWD_CLUSTER_TILE_SIZE)},${Math.floor(tile.tileY / CROWD_CLUSTER_TILE_SIZE)}`;
                if (denseCrowdCells.has(cell)) {
                    if (namedCrowdCells.has(cell)) {
                        sprite.labelAlpha = 0;
                        continue;
                    }
                    namedCrowdCells.add(cell);
                }
            }

            const compactSlot = this._leastOverlappedCompactSlot(
                sprite,
                useSpatialGrid ? compactGrid : compactRects,
            );
            sprite.overlaySlot = compactSlot;
            const compactRect = this._agentCompactSlotRect(sprite, compactSlot);
            if (useSpatialGrid) {
                this._insertRectGridItem(compactGrid, compactRect);
                this._insertRectGridItem(bubbleGrid, compactRect);
            } else {
                compactRects.push(compactRect);
                reservedRects.push(compactRect);
            }
            if (sprite.agent?.currentTool && actionLabels < actionLabelCap) {
                sprite.gpuActionOverlay = true;
                actionLabels++;
            }

            if (agentRenderMode !== 'full' || zoom < 3) {
                sprite.nameTagSlot = null;
                continue;
            }

            let nameSlot = 0;
            let nameRect = this._agentNameSlotRect(sprite, nameSlot);
            // 3.4 — a slot is usable only when it clears both already-placed
            // tags and static prop footprints (tags stay off prop art).
            while (
                nameSlot < 7 &&
                ((useSpatialGrid
                    ? this._rectGridHasOverlap(nameGrid, nameRect)
                    : this._rectListHasOverlap(nameRects, nameRect))
                    || this._nameSlotRectHitsProp(nameRect, sprite.y))
            ) {
                nameSlot++;
                nameRect = this._agentNameSlotRect(sprite, nameSlot);
            }
            if (nameSlot >= 7) {
                sprite.nameTagSlot = null;
            } else {
                sprite.nameTagSlot = nameSlot;
                if (useSpatialGrid) {
                    this._insertRectGridItem(nameGrid, nameRect);
                    this._insertRectGridItem(bubbleGrid, nameRect);
                } else {
                    nameRects.push(nameRect);
                    reservedRects.push(nameRect);
                }
            }
        }

        const bubbleSprites = this._overlayBubbleSprites;
        bubbleSprites.length = 0;
        for (const sprite of prioritized) {
            if (sprite.decisionFocusMuted) continue;
            if (agentRenderMode === 'full') {
                bubbleSprites.push(sprite);
            } else {
                const status = sprite.agent?.status;
                if (sprite.gpuActionOverlay || sprite.selected
                    || status === AgentStatus.WAITING_ON_USER
                    || status === AgentStatus.ERRORED
                    || status === AgentStatus.RATE_LIMITED) bubbleSprites.push(sprite);
            }
        }
        this._assignAgentBubbleSlots(
            bubbleSprites,
            zoom,
            useSpatialGrid ? null : reservedRects,
            useSpatialGrid ? bubbleGrid : false,
        );
    }

    _leastOverlappedCompactSlot(sprite, occupiedGrid, slotCount = 4) {
        let bestSlot = 0;
        let bestOverlapCount = Infinity;
        for (let slot = 0; slot < slotCount; slot++) {
            const rect = this._agentCompactSlotRect(sprite, slot);
            const overlapCount = Array.isArray(occupiedGrid)
                ? this._rectListOverlapCount(occupiedGrid, rect)
                : this._rectGridOverlapCount(occupiedGrid, rect);
            if (overlapCount === 0) return slot;
            if (overlapCount < bestOverlapCount) {
                bestSlot = slot;
                bestOverlapCount = overlapCount;
            }
        }
        return bestSlot;
    }

    // Crowd bubble de-collision. Reuses the overlay-slot rect-overlap technique:
    // register each intended bubble rect and, when it overlaps an already-placed
    // one, stack it into the next free slot above; past the cap, suppress it to
    // an ellipsis dot so at most AGENT_BUBBLE_SLOT_CAP full bubbles render per
    // cluster. Deterministic priority (selected, then label priority, then stable
    // id) keeps slots from flickering frame to frame. Pure layout, no motion.
    _assignAgentBubbleSlots(
        sprites,
        zoom = this.camera?.zoom || 1,
        reservedLabels = [],
        occupiedGrid = null,
    ) {
        // Names and thoughts share one reservation plane even though their
        // anchors are deliberately below and above the character respectively.
        // This prevents one villager's thought from covering another's name.
        const useSpatialGrid = occupiedGrid !== false;
        const grid = useSpatialGrid ? (occupiedGrid || this._overlayBubbleGrid) : null;
        const occupied = this._overlayBubbleOccupiedRects;
        occupied.length = 0;
        if (useSpatialGrid && !occupiedGrid) {
            this._beginRectGridFrame(grid);
            for (const rect of reservedLabels) this._insertRectGridItem(grid, rect);
        } else if (!useSpatialGrid) {
            for (const rect of reservedLabels) occupied.push(rect);
        }
        const order = this._overlayBubbleOrder;
        order.length = 0;
        for (const sprite of sprites || []) {
            if (sprite.agent && this._spriteWantsBubble(sprite)) order.push(sprite);
        }
        order.sort((a, b) => {
            const delta = this._agentLabelPriority(b) - this._agentLabelPriority(a);
            if (delta !== 0) return delta;
            return String(a.agent.id) < String(b.agent.id) ? -1 : 1;
        });
        // 3.8 — each sprite's slot-0 rect, kept for the identical-bubble merge
        // pass below (same allocation envelope the slot loop already has).
        const baseRects = this._overlayBubbleBaseRects;
        baseRects.length = 0;
        for (const sprite of order) {
            sprite.bubbleSlot = 0;
            sprite.bubbleSuppressed = false;
            // 3.8 — merge flags reset per frame; groups are rebuilt after slots.
            sprite.bubbleMergedCount = 1;
            sprite.bubbleMergedInto = null;
            const baseRect = this._agentBubbleSlotRect(sprite, 0);
            baseRects.push(baseRect);
            let slot = 0;
            let rect = baseRect;
            const slotCap = sprite.selected ? 8 : AGENT_BUBBLE_SLOT_CAP;
            while (
                slot < slotCap &&
                (useSpatialGrid
                    ? this._rectGridHasOverlap(grid, rect)
                    : this._rectListHasOverlap(occupied, rect))
            ) {
                slot++;
                rect = this._agentBubbleSlotRect(sprite, slot);
            }
            if (slot >= slotCap && !sprite.selected) {
                sprite.bubbleSuppressed = true;
            } else {
                sprite.bubbleSlot = slot;
                if (useSpatialGrid) this._insertRectGridItem(grid, rect);
                else occupied.push(rect);
            }
        }
        this._mergeIdenticalClusterBubbles(order, baseRects, useSpatialGrid);
    }

    // 3.8 — identical-bubble merge. Within one bubble-slot cluster (sprites
    // whose slot-0 bubble rects transitively overlap), agents showing the
    // identical head line collapse into the deterministic-first sprite's
    // bubble, which draws a ×N chip (AgentSprite._drawBubble); the others skip
    // their own. Merges never cross cluster boundaries and the representative
    // comes from the stable `order` sort, so membership cannot flicker. Slot
    // assignment above is left untouched: merged members keep their slots, so
    // unmerged neighbours never reshuffle frame to frame.
    _mergeIdenticalClusterBubbles(order, baseRects, useSpatialGrid = true) {
        const clusters = this._overlayBubbleClusters;
        const clusterGrid = this._overlayClusterGrid;
        if (useSpatialGrid) this._beginRectGridFrame(clusterGrid);
        let clusterCount = 0;
        for (let i = 0; i < order.length; i++) {
            const sprite = order[i];
            if (sprite.selected) continue; // selected agents never merge
            const rect = baseRects[i];
            let cluster = useSpatialGrid ? this._firstRectGridOverlap(clusterGrid, rect) : null;
            if (!useSpatialGrid) {
                for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
                    const candidate = clusters[clusterIndex];
                    if (!this._rectsOverlap(rect, candidate.rect)) continue;
                    cluster = candidate;
                    break;
                }
            }
            if (!cluster) {
                cluster = clusters[clusterCount] || {
                    rect: { x: 0, y: 0, w: 0, h: 0 },
                    members: [],
                    order: 0,
                };
                clusters[clusterCount] = cluster;
                cluster.order = clusterCount;
                cluster.rect.x = rect.x;
                cluster.rect.y = rect.y;
                cluster.rect.w = rect.w;
                cluster.rect.h = rect.h;
                cluster.members.length = 0;
                clusterCount++;
            } else {
                // Union rect so transitively-overlapping sprites join one cluster.
                const x1 = Math.max(cluster.rect.x + cluster.rect.w, rect.x + rect.w);
                const y1 = Math.max(cluster.rect.y + cluster.rect.h, rect.y + rect.h);
                cluster.rect.x = Math.min(cluster.rect.x, rect.x);
                cluster.rect.y = Math.min(cluster.rect.y, rect.y);
                cluster.rect.w = x1 - cluster.rect.x;
                cluster.rect.h = y1 - cluster.rect.y;
            }
            cluster.members.push(sprite);
            // A union can enter new cells. Old bucket references are harmless;
            // overlap is always rechecked against the current union rect.
            if (useSpatialGrid) this._insertRectGridItem(clusterGrid, cluster.rect, cluster);
        }
        this._overlayBubbleClusterCount = clusterCount;
        const groups = this._overlayBubbleGroups;
        for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
            const cluster = clusters[clusterIndex];
            if (cluster.members.length < 2) continue;
            groups.clear();
            for (const sprite of cluster.members) {
                const key = this._bubbleMergeKey(sprite);
                if (!key) continue;
                const representative = groups.get(key);
                if (!representative) {
                    groups.set(key, sprite);
                    continue;
                }
                representative.bubbleMergedCount++;
                sprite.bubbleMergedInto = representative;
            }
            this._foldRoutineClusterNames(cluster);
        }
    }

    // F5 — under annotation pressure, a slot-0 crowd delegates routine
    // identities to the occupancy chip on the building they are visiting.
    // Primary and recent agents remain named; selection/hover therefore also
    // expands an individual immediately. Calm (`full`) scenes keep every name.
    _foldRoutineClusterNames(cluster) {
        if (!this._annotationMode || this._annotationMode === 'full' || cluster.members.length <= 5) return;
        for (const sprite of cluster.members) {
            if (!this._isRoutineFoldCandidate(sprite)) continue;
            const buildingType = sprite._foldBuildingType;
            if (!buildingType) continue;
            let building = null;
            for (const candidate of this.buildingRenderer?.buildings || []) {
                if (candidate.type !== buildingType) continue;
                building = candidate;
                break;
            }
            const occupancy = building
                ? this.buildingRenderer?._buildingOccupancyInfo?.(building)
                : null;
            if (!occupancy || occupancy.count <= 0) continue;
            sprite.foldedIntoBuilding = true;
            sprite.overlaySlot = null;
            sprite.nameTagSlot = null;
            // Canvas labels are invoked from AgentSprite even without a slot;
            // zero alpha suppresses that fallback. The GPU overlay admits
            // routine labels only when a slot survives.
            sprite.labelAlpha = 0;
        }
    }

    _isRoutineFoldCandidate(sprite) {
        if (!sprite || sprite.selected || sprite.hovered) return false;
        const status = sprite.agent?.status;
        if ([AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(status)) {
            return false;
        }
        const spawnAge = performance.now() - (sprite.addedAt || 0);
        // A burst must not grant twelve seconds of overlapping names to the whole crowd.
        if (this.agentSprites.size < 24 && spawnAge >= 0 && spawnAge < 12000) return false;
        return true;
    }

    // Merge identity = the head line the bubble will actually draw (same text,
    // same resolved accent, same confidence, so the low-confidence '?' variant
    // never merges with the confident one). Sprites without a drawable head —
    // or showing the long-wait clock bubble, which has no ×N chip path —
    // never merge.
    _bubbleMergeKey(sprite) {
        // Layout already reads the sprite's current activity snapshot. Reusing
        // it avoids rebuilding/pruning the complete activity thread solely to
        // derive a merge key.
        const archiveProgress = sprite._archiveFadeProgress?.();
        const head = archiveProgress > 0 && archiveProgress < 1
            ? { text: 'FINAL', accent: sprite._statusVisual?.()?.color || '#f2d36b' }
            : sprite._activitySnapshot;
        if (!head || !head.text) return null;
        if (sprite._shouldUseLongWaitClock?.()) return null;
        const accent = head.accent || sprite._statusVisual?.()?.color || '';
        return `${head.text}|${accent}|${head.confidence ?? ''}`;
    }

    _spriteWantsBubble(sprite) {
        if (!sprite || sprite.chatting) return false;
        if (sprite.isArrivalPending?.()) return false;
        // A silent villager draws nothing, so it must not reserve a slot and
        // push a speaking neighbour into a higher one. Reads the snapshot the
        // sprite already computed rather than rebuilding its activity thread.
        if (!sprite._activitySnapshot?.text && !sprite._shouldUseLongWaitClock?.()) return false;
        return true;
    }

    _agentBubbleSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const halfW = (this._agentBubbleWidth(sprite) / 2) * s;
        const halfH = (AGENT_BUBBLE_HEIGHT / 2) * s;
        const centerY = sprite.y - (AGENT_BUBBLE_ANCHOR_Y + slot * AGENT_BUBBLE_STACK_STEP) * s;
        return {
            x: sprite.x - halfW,
            y: centerY - halfH,
            w: halfW * 2,
            h: halfH * 2,
        };
    }

    // Reservation width for de-collision. Dialogue lines are real model text of
    // varying length, so a single fixed estimate would under-reserve for long
    // lines and let bubbles overlap. Estimating from character count at the
    // anchored 10px body font keeps this allocation-free and off the
    // measureText path, while STATUS_BUBBLE_MAIN_MAX_WIDTH caps it exactly as
    // the sprite's own pixel truncation does.
    _agentBubbleWidth(sprite) {
        const text = sprite?._activitySnapshot?.text;
        if (!text) return AGENT_BUBBLE_EST_WIDTH;
        const estimate = text.length * AGENT_BUBBLE_CHAR_WIDTH + AGENT_BUBBLE_PADDING;
        return Math.min(AGENT_BUBBLE_MAX_WIDTH, Math.max(AGENT_BUBBLE_EST_WIDTH, estimate));
    }

    _agentLabelPriority(sprite) {
        if (sprite.selected) return 1000;
        const status = sprite.agent?.status;
        const age = performance.now() - (sprite.addedAt || 0);
        const recentSpawn = age >= 0 && age < 12000;
        if (status === AgentStatus.WORKING && recentSpawn) return 760;
        if (recentSpawn) return 620;
        if (status === AgentStatus.WORKING) return 520;
        if (status === AgentStatus.WAITING) return 360;
        return 120;
    }

    // Identity labels remain fully opaque at every zoom and crowd density.
    _agentLabelAlpha() {
        return 1;
    }

    _collectAgentLabelHitRects(sprites) {
        const zoom = this.camera?.zoom || 1;
        const out = this._agentLabelHitRects;
        out.length = 0;
        for (const sprite of sprites) {
            if (!sprite.agent) continue;

            const usesNameTag = (sprite.selected || zoom >= 3) && sprite.nameTagSlot != null;
            if (usesNameTag) {
                out.push(this._agentNameSlotRect(sprite, sprite.nameTagSlot || 0));
                continue;
            }
            if (sprite.overlaySlot == null) continue;
            out.push(this._agentCompactSlotRect(sprite, sprite.overlaySlot || 0));
        }
        return out;
    }

    _agentImpostorSlotRect(sprite) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const halfW = 11 * s;
        const halfH = 13 * s;
        return {
            x: sprite.x - halfW,
            y: sprite.y - 17 * s,
            w: halfW * 2,
            h: halfH * 2,
        };
    }

    _agentCompactSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const offsetX = sprite.x;
        const offsetY = sprite.y
            + (AGENT_COMPACT_NAME_SLOT_BASE_Y + slot * AGENT_COMPACT_NAME_SLOT_STEP_Y) * s;
        const pad = 2 * s;
        const halfW = (this._estimateCompactNameTagWidth(sprite) / 2) * s;
        const halfH = (AGENT_COMPACT_NAME_HEIGHT / 2) * s;
        return {
            x: offsetX - halfW - pad,
            y: offsetY - halfH - pad,
            w: halfW * 2 + pad * 2,
            h: halfH * 2 + pad * 2,
        };
    }

    _agentNameSlotRect(sprite, slot) {
        const s = 1 / ((this.camera?.zoom) || 1);
        const offsetY = sprite.y + (38 + this._nameTagSlotYOffset(slot)) * s;
        const anchorX = sprite.x;
        const pad = 2 * s;
        const width = this._estimateNameTagWidth(sprite) * s;
        const height = this._estimateNameTagHeight(sprite) * s;
        return {
            x: anchorX - width / 2 - pad,
            y: offsetY - height / 2 - pad,
            w: width + pad * 2,
            h: height + pad * 2,
            slot,
        };
    }

    _nameTagSlotYOffset(slot) {
        const offsets = [0, -10, 10, -18, 18, -26, 26, -34];
        return offsets[Math.min(slot, offsets.length - 1)];
    }

    // 3.4 — coarse world-space index over static prop footprints (trees,
    // boulders, district props), keyed by NAME_SLOT_PROP_CELL cells. Built once
    // at init: props never move, so the name-tag slot clamp pays only a few
    // cell lookups per candidate rect instead of scanning every prop per frame.
    // A prop's "footprint" here is its occlusion FRONT band (splitY..bottom):
    // the only part that can draw over an agent's name tag. Full bounds would
    // blanket whole districts (wall segments span hundreds of world px).
    _buildPropFootprintIndex(props) {
        const index = new Map();
        for (const prop of props || []) {
            const bounds = prop?.bounds;
            if (!bounds) continue;
            const bandTop = Number.isFinite(bounds.splitY) ? bounds.splitY : bounds.bottom - 14;
            const rect = {
                x: prop.x + bounds.left,
                y: prop.y + bandTop,
                w: bounds.right - bounds.left,
                h: bounds.bottom - bandTop,
                // Occlusion front parts sort at prop.y; only props in front of
                // the agent can cover its tag (see _nameSlotRectHitsProp).
                baseY: prop.y,
            };
            if (rect.w <= 0 || rect.h <= 0) continue;
            const x0 = Math.floor(rect.x / NAME_SLOT_PROP_CELL);
            const x1 = Math.floor((rect.x + rect.w) / NAME_SLOT_PROP_CELL);
            const y0 = Math.floor(rect.y / NAME_SLOT_PROP_CELL);
            const y1 = Math.floor((rect.y + rect.h) / NAME_SLOT_PROP_CELL);
            for (let cx = x0; cx <= x1; cx++) {
                for (let cy = y0; cy <= y1; cy++) {
                    const key = `${cx},${cy}`;
                    let bucket = index.get(key);
                    if (!bucket) {
                        bucket = [];
                        index.set(key, bucket);
                    }
                    bucket.push(rect);
                }
            }
        }
        return index;
    }

    // True when a candidate name-tag rect overlaps the front band of a static
    // prop that draws IN FRONT of the agent (baseY > spriteY, matching the
    // depth sort). Props behind the agent draw under the tag and stay allowed.
    _nameSlotRectHitsProp(rect, spriteY) {
        const index = this._propFootprintIndex;
        if (!index || !index.size) return false;
        const x0 = Math.floor(rect.x / NAME_SLOT_PROP_CELL);
        const x1 = Math.floor((rect.x + rect.w) / NAME_SLOT_PROP_CELL);
        const y0 = Math.floor(rect.y / NAME_SLOT_PROP_CELL);
        const y1 = Math.floor((rect.y + rect.h) / NAME_SLOT_PROP_CELL);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = index.get(`${cx},${cy}`);
                if (!bucket) continue;
                for (const propRect of bucket) {
                    if (propRect.baseY <= spriteY) continue;
                    if (this._rectsOverlap(rect, propRect)) return true;
                }
            }
        }
        return false;
    }

    _estimateNameTagWidth(sprite) {
        const baseName = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        // Match the real pill: nickname renders as a suffix on the full tag.
        const fullName = sprite.nickname ? `${baseName} ${sprite.nickname}` : baseName;
        const rawLen = Math.min(fullName.length, 28);
        return Math.min(
            AGENT_NAME_TAG_MAX_WIDTH,
            Math.max(AGENT_NAME_TAG_MIN_WIDTH, rawLen * AGENT_NAME_TAG_CHAR_WIDTH + AGENT_NAME_TAG_PADDING_X),
        );
    }

    _estimateNameTagHeight(sprite) {
        const baseName = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        const fullName = sprite.nickname ? `${baseName} ${sprite.nickname}` : baseName;
        // The real pill wraps to two lines once it exceeds ~MAX_WIDTH (≈21 chars
        // at 7px/char), matching AgentSprite._nameTagLayout.
        const lines = fullName.length > 21 ? 2 : 1;
        return lines === 1 ? AGENT_NAME_TAG_SINGLE_HEIGHT : AGENT_NAME_TAG_DOUBLE_HEIGHT;
    }

    _estimateCompactNameTagWidth(sprite) {
        const name = String(sprite.agent?.name || sprite.agent?.displayName || '').trim() || 'Agent';
        const rawLen = Math.min(name.length, 24);
        return Math.min(
            AGENT_COMPACT_NAME_MAX_WIDTH,
            Math.max(AGENT_COMPACT_NAME_MIN_WIDTH, rawLen * AGENT_COMPACT_NAME_CHAR_WIDTH + AGENT_COMPACT_NAME_EXTRA_WIDTH),
        );
    }

    _rectsOverlap(a, b) {
        return a.x < b.x + b.w
            && a.x + a.w > b.x
            && a.y < b.y + b.h
            && a.y + a.h > b.y;
    }

    _drawTerrain(ctx, profileMark = null) {
        SpriteRenderer.disableSmoothing(ctx);
        const cached = this._getTerrainCache();
        if (cached) {
            ctx.drawImage(cached.canvas, cached.bounds.x, cached.bounds.y, cached.bounds.w, cached.bounds.h);
        } else {
            this._drawStaticTerrainSurface(ctx);
        }
        profileMark?.('terrain-surface');
        this._drawDynamicWaterHighlights(ctx);
        profileMark?.('water-highlights');
        this._drawWeatherPuddles(ctx);
        profileMark?.('weather-puddles');
        this._drawSurfaceWetnessMarks(ctx, 'ground');
        profileMark?.('surface-wetness');
        this._drawStaticBuildingSmoke(ctx);
        profileMark?.('static-building-smoke');
    }

    // Static fallback: when motionScale === 0 the particle system is disabled,
    // so we draw a single deterministic puff per occupied building.
    _drawStaticBuildingSmoke(ctx) {
        if (this.motionScale > 0) return;
        if (!this.ambientEmitters?.length) return;
        ctx.save();
        for (const emitter of this.ambientEmitters) {
            if (emitter.gatedBy !== ACTIVE_BUILDING_EMITTER_GATE) continue;
            const presence = emitter.building
                ? this._buildingPresenceMap?.get(emitter.building)
                : null;
            const tier = presence?.tier;
            if (tier !== 'occupied' && tier !== 'busy') continue;
            const yOffset = Number.isFinite(emitter.worldYOffset) ? emitter.worldYOffset : -18;
            const cx = emitter.x;
            const cy = emitter.y + yOffset;
            ctx.globalAlpha = tier === 'busy' ? 0.40 : 0.28;
            ctx.fillStyle = '#888888';
            ctx.beginPath();
            ctx.ellipse(cx, cy, 6, 3.2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha *= 0.6;
            ctx.beginPath();
            ctx.ellipse(cx + 2, cy - 4, 4.5, 2.4, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _getVisibleTileBounds(margin = 5) {
        return this.camera.getViewportTileBounds(margin);
    }

    // Season token for the live atmosphere, using SeasonalAmbience's shared
    // month→season mapping so the baked ground and the drift particles agree.
    _currentSeasonToken() {
        const atmosphere = this._lastAtmosphere ?? this.atmosphereState?.snapshot?.() ?? null;
        return seasonTokenForAtmosphere(atmosphere) || 'summer';
    }

    // C2 — screen-space spawn anchors for SeasonalAmbience drift. 'canopy'
    // returns visible tree-canopy tops (leaves/petals fall from them), 'flower'
    // returns visible flower tiles (butterflies rise from them). Memoized per
    // frame (keyed on waterFrame) so ~4 spawns/s don't re-scan the scenery each
    // time. Returns [] when nothing of that kind is on screen → the caller falls
    // back to viewport-random spawning.
    _seasonalDriftAnchors(kind) {
        const frameToken = this.waterFrame;
        if (this._driftAnchorFrame !== frameToken || !this._driftAnchorCache) {
            this._driftAnchorFrame = frameToken;
            this._driftAnchorCache = { canopy: null, flower: null };
        }
        const cache = this._driftAnchorCache;
        if (cache[kind]) return cache[kind];
        const points = kind === 'flower'
            ? this._collectFlowerAnchors()
            : this._collectCanopyAnchors();
        cache[kind] = points;
        return points;
    }

    _collectCanopyAnchors() {
        const out = [];
        const camera = this.camera;
        if (!camera) return out;
        const vp = this._screenViewport();
        const zoom = camera.zoom || 1;
        for (const tree of this.treePropSprites || []) {
            const wx = (tree.tileX - tree.tileY) * TILE_WIDTH / 2;
            const wy = (tree.tileX + tree.tileY) * TILE_HEIGHT / 2;
            const p = camera.worldToScreen(wx, wy);
            if (p.x < -20 || p.y < -20 || p.x > vp.width + 20 || p.y > vp.height + 20) continue;
            out.push({ x: p.x, y: p.y - 30 * zoom }); // offset up onto the canopy
            if (out.length >= 48) break;
        }
        return out;
    }

    _collectFlowerAnchors() {
        const out = [];
        const camera = this.camera;
        if (!camera || !this.flowerTiles) return out;
        const vp = this._screenViewport();
        for (const key of this.flowerTiles.keys()) {
            const comma = key.indexOf(',');
            if (comma < 0) continue;
            const tileX = Number(key.slice(0, comma));
            const tileY = Number(key.slice(comma + 1));
            const wx = (tileX - tileY) * TILE_WIDTH / 2;
            const wy = (tileX + tileY) * TILE_HEIGHT / 2;
            const p = camera.worldToScreen(wx, wy);
            if (p.x < -20 || p.y < -20 || p.x > vp.width + 20 || p.y > vp.height + 20) continue;
            out.push({ x: p.x, y: p.y - 6 });
            if (out.length >= 48) break;
        }
        return out;
    }

    _getTerrainCache() {
        const bounds = this._terrainCacheBounds();
        const meta = this._getTerrainCacheMeta(bounds);
        if (!meta.singleSurfaceWithinBudget) {
            releaseCanvasBackingStore(this.terrainCache);
            this.terrainCache = null;
            this.terrainCacheKey = '';
            this._emitTerrainCacheLimitWarning(meta);
            return null;
        }
        const dpr = 1;
        // C1 — a season token keyed into the cache so the ground decals rebake
        // only when the season actually changes (four discrete values), never
        // per frame. Stored for _drawGroundDecals / _drawTile to branch on.
        const season = this._currentSeasonToken();
        this._terrainSeason = season;
        // The reflection is world-anchored, so camera panning follows it through
        // the existing transform. A resting zoom tier is enough camera input to
        // preserve the pixel grammar without rebaking during a smooth glide.
        const cameraZoomTier = this.camera?.currentZoomTier?.() || 1;
        const phase = this._lastAtmosphere?.phase || 'day';
        const key = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}@${dpr}|${this.assets ? 'assets' : 'fallback'}|edge|atmo-persp|season:${season}|camera:${cameraZoomTier}|phase:${phase}`;
        if (this.terrainCache && this.terrainCacheKey === key) {
            return { canvas: this.terrainCache, bounds };
        }

        releaseCanvasBackingStore(this.terrainCache);

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bounds.w * dpr));
        canvas.height = Math.max(1, Math.round(bounds.h * dpr));
        const cacheCtx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(cacheCtx);
        cacheCtx.setTransform(dpr, 0, 0, dpr, -bounds.x * dpr, -bounds.y * dpr);

        this._drawStaticTerrainSurface(cacheCtx);

        this.terrainCache = canvas;
        this.terrainCacheBounds = bounds;
        this.terrainCacheKey = key;
        return { canvas, bounds };
    }

    _drawStaticTerrainSurface(ctx) {
        const previousMotionScale = this.motionScale;
        try {
            this.motionScale = 0;
            this._drawDioramaBackdrop(ctx);
            this._drawWorldBaseShadow(ctx);

            for (let y = 0; y < MAP_SIZE; y++) {
                for (let x = 0; x < MAP_SIZE; x++) {
                    this._drawTile(ctx, x, y);
                }
            }

            this._drawOpenWaterDepthWash(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawStaticOpenSeaStructure(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawOpenSeaBasinGradient(ctx);
            this._drawDistrictAtmosphere(ctx);
            this._drawRiverContourLines(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawWaterFoamLines(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawOpenSeaSurfBreaks(ctx, 0, MAP_SIZE - 1, 0, MAP_SIZE - 1);
            this._drawLandmarkBridgeSpans(ctx);
            this.buildingRenderer?.drawGroundFoundations?.(ctx);
            this._drawAmbientGroundProps(ctx);
            this._drawWorldEdgeRim(ctx);
            this._bakePerimeterCliffShelf(ctx);
            this._bakeAtmosphericPerspective(ctx);
        } finally {
            this.motionScale = previousMotionScale;
        }
    }

    // Atmospheric perspective: a faint top-to-bottom cool-lighter wash baked into
    // the terrain cache so far rows (low tileY, high on screen) read hazier than
    // near rows (high tileY, low on screen) — the painterly "distant things recede"
    // trick at zero per-frame cost. Clipped to the world diamond, multiply-blended,
    // ~8% at the far apex fading to 0 across the near half. No motion (baked).
    _bakeAtmosphericPerspective(ctx) {
        const points = this._worldDiamondPoints();
        const topY = points[0].y;       // far apex (tileY≈0)
        const bottomY = points[2].y;    // near apex (tileY≈MAP_SIZE)
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.clip();
        ctx.globalCompositeOperation = 'multiply';
        const haze = ctx.createLinearGradient(0, topY, 0, bottomY);
        // Cool, high-value haze tint — multiply leaves near rows untouched (white→1x)
        // and gently desaturates/cools the far rows toward atmospheric distance.
        haze.addColorStop(0, 'rgb(196, 214, 232)');
        haze.addColorStop(0.5, 'rgb(232, 240, 248)');
        haze.addColorStop(1, 'rgb(255, 255, 255)');
        ctx.fillStyle = haze;
        ctx.globalAlpha = 0.5;          // peak ~8% effective cool wash at the far apex
        ctx.fillRect(points[3].x, topY, points[1].x - points[3].x, bottomY - topY);
        ctx.restore();
    }

    _buildDistrictPropSprites() {
        if (!this.sprites) return [];
        const sprites = this._buildVillageWallSprites();
        sprites.push(...this._buildBridgeNearRailSprites());
        sprites.push(new StaticPropSprite({
            tileX: VILLAGE_GATE.tileX,
            tileY: VILLAGE_GATE.tileY,
            id: VILLAGE_GATE.id,
            bounds: VILLAGE_GATE_BOUNDS,
            splitForOcclusion: true,
            drawFn: (ctx, x, y) => this._drawVillageGatehouse(ctx, x, y),
        }));
        sprites.push(...this._buildVillageWallTerminalSprites());
        sprites.push(...this._buildWatchtowerBeaconBuoySprites());
        sprites.push(...DISTRICT_PROPS
            .filter((prop) => prop.layer === 'sorted')
            .filter((prop) => !this.scenery.isBlockedForTallScenery(prop.tileX, prop.tileY, this.pathTiles, this.bridgeTiles))
            .map((prop) => {
                const dims = this.assets?.getDims?.(prop.id);
                // 2.9 — precomputed so the per-frame drawFn does no lookup work:
                // land props get a contact shadow, water-surface props none.
                const contactShadow = !this.waterTiles.has(`${Math.floor(prop.tileX)},${Math.floor(prop.tileY)}`);
                return new StaticPropSprite({
                    tileX: prop.tileX,
                    tileY: prop.tileY,
                    id: prop.id,
                    bounds: this._assetPropBounds(prop.id),
                    splitForOcclusion: Boolean(dims && dims.h >= 56),
                    drawFn: (ctx, x, y) => {
                        if (contactShadow) this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                        this.sprites.drawSprite(ctx, prop.id, x, y);
                    },
                });
            }));
        return sprites;
    }

    _buildBridgeNearRailSprites() {
        if (!this.bridgeSpans?.length || !this.assets) return [];
        const sprites = [];
        for (const span of this.bridgeSpans) {
            const rail = span.nearRail;
            if (!rail) continue;
            const segmentCount = Math.max(1, span.lengthTiles * 2);
            for (let i = 0; i < segmentCount; i++) {
                const t0 = i / segmentCount;
                const t1 = (i + 1) / segmentCount;
                const midT = (t0 + t1) / 2;
                const quad = this._bridgeNearRailQuad(span, t0, t1);
                const propWorld = this._bridgePoint(span, midT, span.halfWidth, 0);
                const propTile = worldToTile(propWorld.x, propWorld.y);
                const localQuad = quad.map((point) => ({
                    x: point.x - propWorld.x,
                    y: point.y - propWorld.y,
                }));
                const xs = localQuad.map((point) => point.x);
                const ys = localQuad.map((point) => point.y);
                sprites.push(new StaticPropSprite({
                    tileX: propTile.tileX,
                    tileY: propTile.tileY,
                    id: `bridge.rail.${span.id}.${i}`,
                    bounds: {
                        left: Math.floor(Math.min(...xs)),
                        right: Math.ceil(Math.max(...xs)),
                        top: Math.floor(Math.min(...ys)),
                        bottom: Math.ceil(Math.max(...ys)),
                        splitY: 0,
                    },
                    splitForOcclusion: false,
                    sortY: propWorld.y,
                    drawFn: (ctx) => {
                        const clipQuad = this._bridgeNearRailQuad(span, t0, t1);
                        const placement = this._bridgeSpritePlacement(span);
                        if (!placement) return;
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(clipQuad[0].x, clipQuad[0].y);
                        for (let q = 1; q < clipQuad.length; q++) {
                            ctx.lineTo(clipQuad[q].x, clipQuad[q].y);
                        }
                        ctx.closePath();
                        ctx.clip();
                        ctx.drawImage(
                            placement.img,
                            placement.x,
                            placement.y,
                            placement.dims.w,
                            placement.dims.h
                        );
                        ctx.restore();
                    },
                }));
            }
        }
        return sprites;
    }

    _bridgeNearRailQuad(span, t0, t1) {
        const rail = span.nearRail;
        return [
            this._bridgePoint(span, t0, rail.inner, rail.top),
            this._bridgePoint(span, t1, rail.inner, rail.top),
            this._bridgePoint(span, t1, rail.outer, -rail.bottom),
            this._bridgePoint(span, t0, rail.outer, -rail.bottom),
        ];
    }

    _buildVillageWallSprites() {
        const out = [];
        for (const route of VILLAGE_WALL_ROUTES) {
            for (let i = 0; i < route.points.length - 1; i++) {
                const startTile = route.points[i];
                const endTile = route.points[i + 1];
                const visualEndTile = this._villageWallVisualEndTile(route, startTile, endTile);
                const midTile = {
                    tileX: (startTile.tileX + visualEndTile.tileX) / 2,
                    tileY: (startTile.tileY + visualEndTile.tileY) / 2,
                };
                const start = this._tileToWorld(startTile.tileX, startTile.tileY);
                const end = this._tileToWorld(visualEndTile.tileX, visualEndTile.tileY);
                const mid = this._tileToWorld(midTile.tileX, midTile.tileY);
                const localStart = { x: start.x - mid.x, y: start.y - mid.y };
                const localEnd = { x: end.x - mid.x, y: end.y - mid.y };
                const wallBounds = this._villageWallBounds(localStart, localEnd);
                out.push(new StaticPropSprite({
                    tileX: midTile.tileX,
                    tileY: midTile.tileY,
                    id: `village.wall.${route.id}.${i}`,
                    bounds: wallBounds,
                    splitForOcclusion: false,
                    sortY: Math.max(start.y, end.y) - 14,
                    drawFn: (ctx, x, y) => {
                        const isLastSegment = i === route.points.length - 2;
                        const isFirstSegment = i === 0;
                        let footingExtent = null;
                        if (route.id === 'west' && isLastSegment) {
                            footingExtent = { side: 'end', distance: 30, dither: 32 };
                        } else if (route.id === 'east' && isFirstSegment) {
                            footingExtent = { side: 'start', distance: 24, dither: 32 };
                        }
                        this._drawVillageWallSegment(ctx, x, y, localStart, localEnd, i, footingExtent);
                    },
                }));
            }
        }
        return out;
    }

    _villageWallVisualEndTile(route, startTile, endTile) {
        if (route?.id !== 'east') return endTile;
        const towerTile = this._villageWallSeaTowerTile(endTile, startTile);
        const dx = Number(endTile.tileX) - Number(startTile.tileX);
        const dy = Number(endTile.tileY) - Number(startTile.tileY);
        const length = Math.max(0.1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        return {
            tileX: towerTile.tileX - ux * 0.42,
            tileY: towerTile.tileY - uy * 0.42,
        };
    }

    // Decorative beacon buoys flanking the Pharos Lighthouse on the sea-line.
    // Authored tile positions live in WATCHTOWER_BEACON_BUOY_TILES
    // (config-near-call-site by design); they're picked to land on open water
    // away from the harbor anchorages declared in HarborTraffic.js.
    _buildWatchtowerBeaconBuoySprites() {
        const id = 'prop.harborBeaconBuoy';
        if (!this.assets?.has?.(id) || !this.sprites) return [];
        const out = [];
        for (const buoy of WATCHTOWER_BEACON_BUOY_TILES) {
            out.push(new StaticPropSprite({
                tileX: buoy.tileX,
                tileY: buoy.tileY,
                id,
                bounds: this._assetPropBounds(id, 0.58),
                splitForOcclusion: false,
                drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, id, x, y),
            }));
        }
        return out;
    }

    _buildVillageWallTerminalSprites() {
        if (!this.assets?.has?.(VILLAGE_WALL_SEA_TOWER_SPRITE_ID)) return [];
        const route = VILLAGE_WALL_ROUTES.find((candidate) => candidate.id === 'east');
        if (!route || route.points.length < 2) return [];
        const endTile = route.points[route.points.length - 1];
        const prevTile = route.points[route.points.length - 2];
        const towerTile = this._villageWallSeaTowerTile(endTile, prevTile);
        const world = this._tileToWorld(towerTile.tileX, towerTile.tileY);
        return [new StaticPropSprite({
            tileX: towerTile.tileX,
            tileY: towerTile.tileY,
            id: VILLAGE_WALL_SEA_TOWER_SPRITE_ID,
            bounds: this._assetPropBounds(VILLAGE_WALL_SEA_TOWER_SPRITE_ID, 0.66),
            splitForOcclusion: true,
            sortY: world.y - 8,
            drawFn: (ctx, x, y) => this.sprites.drawSprite(ctx, VILLAGE_WALL_SEA_TOWER_SPRITE_ID, x, y),
        })];
    }

    _villageWallSeaTowerTile(endTile, prevTile) {
        const dx = Number(endTile.tileX) - Number(prevTile.tileX);
        const dy = Number(endTile.tileY) - Number(prevTile.tileY);
        const length = Math.max(0.1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        for (const offset of [0.25, 0.55, 0.85, 1.15, 1.45]) {
            const candidate = {
                tileX: endTile.tileX - ux * offset,
                tileY: endTile.tileY - uy * offset,
            };
            const key = `${Math.round(candidate.tileX)},${Math.round(candidate.tileY)}`;
            if (!this.waterTiles?.has?.(key)) return candidate;
        }
        return {
            tileX: endTile.tileX - ux * 1.45,
            tileY: endTile.tileY - uy * 1.45,
        };
    }

    _villageWallBounds(start, end) {
        return {
            left: Math.min(start.x, end.x) - 72,
            right: Math.max(start.x, end.x) + 72,
            top: Math.min(start.y, end.y) - 126,
            bottom: Math.max(start.y, end.y) + 42,
            splitY: Math.min(start.y, end.y) - 42,
        };
    }

    _assetPropBounds(id, splitRatio = 0.58) {
        const dims = this.assets?.getDims?.(id);
        if (!dims) return { left: -32, right: 32, top: -64, bottom: 12, splitY: -18 };
        const [ax, ay] = this.assets?.getAnchor?.(id) || [Math.round(dims.w / 2), dims.h];
        return {
            left: -ax,
            right: dims.w - ax,
            top: -ay,
            bottom: dims.h - ay,
            splitY: -ay + Math.round(dims.h * splitRatio),
        };
    }

    _scaledAssetPropBounds(id, scaleX = 1, scaleY = scaleX, splitRatio = 0.58) {
        const bounds = this._assetPropBounds(id, splitRatio);
        const factorX = Number.isFinite(Number(scaleX)) ? Math.max(0.1, Number(scaleX)) : 1;
        const factorY = Number.isFinite(Number(scaleY)) ? Math.max(0.1, Number(scaleY)) : factorX;
        return {
            left: bounds.left * factorX,
            right: bounds.right * factorX,
            top: bounds.top * factorY,
            bottom: bounds.bottom * factorY,
            splitY: bounds.splitY * factorY,
        };
    }

    _drawScaledSprite(ctx, id, x, y, scaleX = 1, scaleY = scaleX) {
        const img = this.assets?.get?.(id);
        if (!img) return;
        const [ax, ay] = this.assets?.getAnchor?.(id) || [Math.round(img.width / 2), img.height];
        const factorX = Number.isFinite(Number(scaleX)) ? Math.max(0.1, Number(scaleX)) : 1;
        const factorY = Number.isFinite(Number(scaleY)) ? Math.max(0.1, Number(scaleY)) : factorX;
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y));
        ctx.scale(factorX, factorY);
        ctx.drawImage(img, Math.round(-ax), Math.round(-ay));
        ctx.restore();
    }

    _drawVillageGatehouse(ctx, originX, originY) {
        const centerTileX = VILLAGE_GATE.tileX;
        const tileY = VILLAGE_GATE.tileY;
        const halfWidth = VILLAGE_GATE.widthTiles / 2;
        const towerHalf = VILLAGE_GATE_TOWER_HALF_TILES;
        const sideStubInset = 0.3;
        const center = this._tileToWorld(centerTileX, tileY);
        const localPoint = (tileX) => {
            const p = this._tileToWorld(tileX, tileY);
            return { x: p.x - center.x, y: p.y - center.y };
        };
        const leftEnd = localPoint(centerTileX - halfWidth);
        const leftInner = localPoint(centerTileX - towerHalf - sideStubInset);
        const rightInner = localPoint(centerTileX + towerHalf + sideStubInset);
        const rightEnd = localPoint(centerTileX + halfWidth);
        const leftTower = localPoint(centerTileX - towerHalf);
        const rightTower = localPoint(centerTileX + towerHalf);

        this._drawVillageWallSegment(ctx, originX, originY, leftEnd, leftInner, 0);
        this._drawVillageWallSegment(ctx, originX, originY, rightInner, rightEnd, 1);

        const leftBase = { x: originX + leftTower.x, y: originY + leftTower.y };
        const rightBase = { x: originX + rightTower.x, y: originY + rightTower.y };
        const hasGateArchSprite = Boolean(this.assets?.get?.(VILLAGE_GATE_ARCH_SPRITE_ID));
        this._drawVillageGateThreshold(ctx, leftBase, rightBase);
        if (!hasGateArchSprite) this._drawVillageGateArch(ctx, leftBase, rightBase);
        this._drawVillageGateDoors(ctx, leftBase, rightBase);
        // Towers mask the animated door endpoints. The asset-backed connector
        // is cropped to its central masonry, so it can cap that joint cleanly.
        this._drawVillageGateTower(ctx, leftBase.x, leftBase.y, -1);
        this._drawVillageGateTower(ctx, rightBase.x, rightBase.y, 1);
        if (hasGateArchSprite) this._drawVillageGateArch(ctx, leftBase, rightBase);
        this._drawGateBrazier(ctx, leftBase.x - 9, leftBase.y + 13);
        this._drawGateBrazier(ctx, rightBase.x + 9, rightBase.y + 13);
    }

    _drawVillageGateThreshold(ctx, leftBase, rightBase) {
        // Threshold is now painted by the road tile renderer via the gate-avenue
        // route in townPlan.js. Tower foot shadows are drawn inside
        // _drawVillageGateTower. This method is intentionally a no-op; the
        // call site in _drawVillageGatehouse is kept for future hooks.
    }

    // Iron fire-basket flanking the gate mouth — frames the coastal gate with
    // warm light. Gentle flicker when motion is on; steady under reduced motion.
    _drawGateBrazier(ctx, x, y) {
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.fillStyle = '#3a2a1a';
        ctx.fillRect(Math.round(x - 2), Math.round(y - 18), 4, 18);
        ctx.fillStyle = '#4a4a52';
        ctx.beginPath();
        ctx.moveTo(Math.round(x - 7), Math.round(y - 18));
        ctx.lineTo(Math.round(x + 7), Math.round(y - 18));
        ctx.lineTo(Math.round(x + 4), Math.round(y - 24));
        ctx.lineTo(Math.round(x - 4), Math.round(y - 24));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#1a1410';
        ctx.lineWidth = 1;
        ctx.stroke();
        const flick = this.motionScale ? (Math.sin(this.waterFrame * 3.2 + x) * 0.5 + 0.5) : 0.5;
        drawPixelFlame(ctx, x, y - 24, 10 + flick * 5, 5, {
            lean: this.motionScale ? Math.sin(this.waterFrame * 1.7 + x) * 1.5 : 0,
        });
        ctx.globalCompositeOperation = 'screen';
        const glow = ctx.createRadialGradient(x, y - 26, 2, x, y - 26, 34);
        glow.addColorStop(0, 'rgba(255, 175, 75, 0.50)');
        glow.addColorStop(1, 'rgba(255, 175, 75, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(Math.round(x - 36), Math.round(y - 60), 72, 72);
        ctx.restore();
    }

    _drawVillageGateTower(ctx, x, y, side = 1) {
        const tower = this.assets?.get?.(VILLAGE_GATE_TOWER_SPRITE_ID);
        if (tower) {
            const [ax, ay] = this.assets.getAnchor(VILLAGE_GATE_TOWER_SPRITE_ID);
            ctx.save();
            SpriteRenderer.disableSmoothing(ctx);
            ctx.translate(Math.round(x), Math.round(y));
            ctx.scale(0.72, 0.72);
            ctx.drawImage(tower, Math.round(-ax), Math.round(-ay));
            ctx.restore();
            return;
        }

        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const w = 64;
        const hStone = 64;
        const hWood = 42;
        const roofH = 36;
        const outward = side >= 0 ? 1 : -1;
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Foot shadow (single ellipse, integrated with threshold)
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = stone.outline;
        ctx.beginPath();
        ctx.ellipse(Math.round(x), Math.round(y + 14), w / 2 + 14, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Side face peek (3D depth on outward side, stone material)
        const sideDepth = 14 * outward;
        const sideDrop = 8;
        const stoneTop = y - hStone;
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };

        if (outward > 0) {
            trace(
                { x: x + w / 2, y: stoneTop },
                { x: x + w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x + w / 2 + sideDepth, y: y + sideDrop },
                { x: x + w / 2, y },
            );
        } else {
            trace(
                { x: x - w / 2 + sideDepth, y: stoneTop + sideDrop },
                { x: x - w / 2, y: stoneTop },
                { x: x - w / 2, y },
                { x: x - w / 2 + sideDepth, y: y + sideDrop },
            );
        }
        ctx.fillStyle = stone.shadow;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Stone foundation front face — solid base with mortared courses
        const stoneLeft = x - w / 2;
        const stoneRight = x + w / 2;
        ctx.fillStyle = stone.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Mottled stone blocks (light/mid alternation)
        const courseH = 16;
        for (let row = 0; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = -offset; col < w; col += 24) {
                const sx = stoneLeft + col;
                const ex = Math.min(stoneLeft + col + 24, stoneRight);
                if (ex <= stoneLeft) continue;
                const seed = this._tileNoise(row * 13 + 7, col + side * 31);
                ctx.fillStyle = seed > 0.55 ? stone.light : stone.shadow;
                ctx.fillRect(Math.round(Math.max(stoneLeft, sx)), Math.round(rowY),
                             Math.round(ex - Math.max(stoneLeft, sx)), courseH);
            }
        }

        // Mortar lines (horizontal courses)
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        for (let row = 1; row < 4; row++) {
            const rowY = stoneTop + row * courseH;
            ctx.beginPath();
            ctx.moveTo(Math.round(stoneLeft), Math.round(rowY));
            ctx.lineTo(Math.round(stoneRight), Math.round(rowY));
            ctx.stroke();
        }

        // Mortar verticals (offset per course for brick-like pattern)
        for (let row = 0; row < 4; row++) {
            const rowY1 = stoneTop + row * courseH;
            const rowY2 = rowY1 + courseH;
            const offset = row % 2 ? 12 : 0;
            for (let col = 24 - offset; col < w; col += 24) {
                const cx = stoneLeft + col;
                ctx.beginPath();
                ctx.moveTo(Math.round(cx), Math.round(rowY1));
                ctx.lineTo(Math.round(cx), Math.round(rowY2));
                ctx.stroke();
            }
        }

        // Re-stroke perimeter to keep outline crisp
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(stoneTop), w, hStone);

        // Archer slit centered on stone front
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(stoneTop + hStone / 2 - 11), 8, 22);

        // Moss tuft at base
        ctx.fillStyle = stone.moss;
        ctx.fillRect(Math.round(stoneRight - 18), Math.round(y - 4), 14, 4);
        ctx.fillRect(Math.round(stoneLeft + 4), Math.round(y - 4), 10, 3);

        // Floor band — visible structural transition between stone and wood
        const woodTop = stoneTop - hWood;
        const bandH = 6;
        ctx.fillStyle = wood.deep;
        ctx.fillRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(stoneLeft - 2), Math.round(stoneTop - bandH), w + 4, bandH);

        // Wood-frame upper — vertical planks matching wall plank rule
        ctx.fillStyle = wood.mid;
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(stoneLeft), Math.round(woodTop), w, hWood - bandH);

        // Plank lines (vertical)
        ctx.strokeStyle = '#2c190d';
        ctx.lineWidth = 1;
        for (let plank = stoneLeft + 8; plank < stoneRight; plank += 12) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Highlight planks (subtle warm streaks)
        ctx.strokeStyle = 'rgba(214, 151, 78, 0.4)';
        for (let plank = stoneLeft + 14; plank < stoneRight; plank += 24) {
            ctx.beginPath();
            ctx.moveTo(Math.round(plank), Math.round(woodTop + 4));
            ctx.lineTo(Math.round(plank), Math.round(stoneTop - bandH - 2));
            ctx.stroke();
        }

        // Narrow window slit in wood
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 4), Math.round(woodTop + 10), 8, 16);

        // Eave shadow under roof
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(Math.round(stoneLeft), Math.round(woodTop), w, 3);

        // Teal pitched roof — front gable
        const roofLeft = stoneLeft - 8;
        const roofRight = stoneRight + 8;
        const ridgeY = woodTop - roofH;
        trace(
            { x: roofLeft, y: woodTop },
            { x: x, y: ridgeY },
            { x: roofRight, y: woodTop },
        );
        ctx.fillStyle = wood.teal;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Roof shadow side (the half away from the light)
        const lightSide = outward > 0 ? -1 : 1; // light comes from the inward side
        if (lightSide < 0) {
            trace(
                { x: roofLeft, y: woodTop },
                { x: x, y: ridgeY },
                { x: x, y: woodTop },
            );
        } else {
            trace(
                { x: x, y: ridgeY },
                { x: roofRight, y: woodTop },
                { x: x, y: woodTop },
            );
        }
        ctx.fillStyle = 'rgba(20, 63, 67, 0.46)';
        ctx.fill();

        // Ridge highlight
        ctx.strokeStyle = wood.tealLight;
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(Math.round(x), Math.round(ridgeY + 2));
            ctx.lineTo(Math.round(x + i * 8), Math.round(woodTop - 4));
            ctx.stroke();
        }

        // Ridge cap accent
        ctx.fillStyle = stone.outline;
        ctx.fillRect(Math.round(x - 2), Math.round(ridgeY - 4), 4, 6);

        ctx.restore();
    }

    // The town's name, carved into the gate band.
    //
    // Called inside the same sheared space as the arch masonry, so the baseline
    // follows the band while every glyph stem stays vertical. That distinction
    // is the whole fix: the old code used ctx.rotate(), which tips the stems off
    // the pixel grid and reduces a five-pixel cap height to mush. A shear keeps
    // verticals on whole columns, and because canvas text is rasterised after
    // the transform rather than resampled from a bitmap, it stays sharp at
    // every zoom. Coordinates here are sprite pixels, not screen pixels.
    _drawGateInscription(ctx, { centerX, centerY, bandWidth, bandHeight }) {
        if (!(bandWidth > 8) || !(bandHeight > 3)) return;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Fit the name to the band: never taller than the band, never wider.
        let size = Math.max(5, Math.round(bandHeight * 0.9));
        for (; size > 4; size--) {
            ctx.font = `700 ${size}px ${WORLD_BODY_FONT}`;
            if (ctx.measureText(VILLAGE_GATE_INSCRIPTION).width <= bandWidth - 3) break;
        }

        // A one-pixel dark drop reads as a chiselled edge and keeps the gold
        // legible against the burgundy at every time of day.
        ctx.fillStyle = VILLAGE_GATE_INSCRIPTION_SHADOW;
        ctx.fillText(VILLAGE_GATE_INSCRIPTION, centerX, centerY + 1);
        ctx.fillStyle = VILLAGE_GATE_INSCRIPTION_INK;
        ctx.fillText(VILLAGE_GATE_INSCRIPTION, centerX, centerY);
        ctx.restore();
    }

    _drawVillageGateArch(ctx, leftBase, rightBase) {
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const arch = this.assets?.get?.(VILLAGE_GATE_ARCH_SPRITE_ID);
        if (arch) {
            const [ax, ay] = this.assets.getAnchor(VILLAGE_GATE_ARCH_SPRITE_ID);
            const scale = length / VILLAGE_GATE_ARCH_COLUMN_SPAN;
            const midBase = {
                x: (leftBase.x + rightBase.x) / 2,
                y: (leftBase.y + rightBase.y) / 2,
            };
            ctx.save();
            SpriteRenderer.disableSmoothing(ctx);
            ctx.translate(Math.round(midBase.x), Math.round(midBase.y));
            // Preserve screen-vertical masonry while mapping the baked span
            // onto the same isometric axis as the gate threshold.
            ctx.transform(ux * scale, uy * scale, 0, scale, 0, 0);
            ctx.drawImage(arch, Math.round(-ax), Math.round(-ay));
            // Painted live inside the same shear, over an inscription band the
            // PNG now leaves empty. Baking the name into the sprite meant the
            // town's own name was resampled along with the masonry: stone
            // survives that, a five-pixel letterform does not.
            this._drawGateInscription(ctx, {
                centerX: 0,
                centerY: VILLAGE_GATE_ARCH_BAND_MID_Y - ay,
                bandWidth: VILLAGE_GATE_ARCH_BAND_WIDTH,
                bandHeight: VILLAGE_GATE_ARCH_BAND_HEIGHT,
            });
            ctx.restore();
            return;
        }

        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const lintelInset = 22;
        const lintelHeight = 26;
        const start = { x: leftBase.x + ux * lintelInset, y: leftBase.y + uy * lintelInset - 110 };
        const end = { x: rightBase.x - ux * lintelInset, y: rightBase.y - uy * lintelInset - 110 };

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Stone lintel locks the two tower bases into a single civic gateway.
        const trace = (...points) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(points[0].x), Math.round(points[0].y));
            for (const p of points.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };
        trace(
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
            { x: end.x, y: end.y + lintelHeight },
            { x: start.x, y: start.y + lintelHeight },
        );
        ctx.fillStyle = stone.mid;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Top edge highlight
        ctx.strokeStyle = stone.light;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + 1));
        ctx.stroke();

        // Bottom shadow line
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(start.x), Math.round(start.y + lintelHeight - 1));
        ctx.lineTo(Math.round(end.x), Math.round(end.y + lintelHeight - 1));
        ctx.stroke();

        // Iron straps (two evenly spaced)
        ctx.fillStyle = stone.mortar;
        for (const t of [0.32, 0.68]) {
            const sx = start.x + (end.x - start.x) * t;
            const sy = start.y + (end.y - start.y) * t;
            ctx.fillRect(Math.round(sx - 1.5), Math.round(sy), 3, lintelHeight);
        }

        // Corbel brackets at each end (carved support pieces)
        for (const corbel of [
            { x: start.x, y: start.y + lintelHeight, dir: 1 },
            { x: end.x, y: end.y + lintelHeight, dir: -1 },
        ]) {
            trace(
                { x: corbel.x, y: corbel.y },
                { x: corbel.x, y: corbel.y + 12 },
                { x: corbel.x + corbel.dir * 12, y: corbel.y },
            );
            ctx.fillStyle = wood.deep;
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Recess the village name into the masonry. The shallow arch echoes a
        // carved entrance panel and keeps the lettering clear of both doors.
        const plaqueSpan = Math.min(88, length * 0.76);
        const plaqueHeight = 15;
        const plaqueInset = (length - plaqueSpan) / 2;
        const plaqueStart = {
            x: start.x + ux * plaqueInset,
            y: start.y + uy * plaqueInset + 3,
        };
        const plaqueEnd = {
            x: end.x - ux * plaqueInset,
            y: end.y - uy * plaqueInset + 3,
        };
        const plaqueMid = {
            x: (plaqueStart.x + plaqueEnd.x) / 2,
            y: (plaqueStart.y + plaqueEnd.y) / 2,
        };
        ctx.fillStyle = stone.shadow;
        ctx.beginPath();
        ctx.moveTo(Math.round(plaqueStart.x), Math.round(plaqueStart.y + plaqueHeight));
        ctx.lineTo(Math.round(plaqueStart.x), Math.round(plaqueStart.y + 4));
        ctx.quadraticCurveTo(
            Math.round(plaqueMid.x),
            Math.round(plaqueMid.y - 4),
            Math.round(plaqueEnd.x),
            Math.round(plaqueEnd.y + 4),
        );
        ctx.lineTo(Math.round(plaqueEnd.x), Math.round(plaqueEnd.y + plaqueHeight));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = stone.light;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = stone.mortar;
        ctx.beginPath();
        ctx.moveTo(
            Math.round(plaqueStart.x + ux * 3),
            Math.round(plaqueStart.y + uy * 3 + plaqueHeight - 2),
        );
        ctx.lineTo(
            Math.round(plaqueEnd.x - ux * 3),
            Math.round(plaqueEnd.y - uy * 3 + plaqueHeight - 2),
        );
        ctx.stroke();
        // Same sheared treatment as the sprite path — see _drawGateInscription.
        ctx.save();
        ctx.translate(Math.round(plaqueMid.x), Math.round(plaqueMid.y + 9));
        ctx.transform(ux, uy, 0, 1, 0, 0);
        this._drawGateInscription(ctx, {
            centerX: 0,
            centerY: 0,
            bandWidth: plaqueSpan,
            bandHeight: plaqueHeight - 4,
        });
        ctx.restore();

        ctx.restore();
    }

    _drawVillageGateDoors(ctx, leftBase, rightBase) {
        const wood = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const dx = rightBase.x - leftBase.x;
        const dy = rightBase.y - leftBase.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        const lintelInset = 22;
        const lintelHeight = 26;
        const doorTopPad = 2;
        const doorBottomLift = 14;

        // Lintel-aligned anchors (must match _drawVillageGateArch math exactly).
        const lintelStart = { x: leftBase.x + ux * lintelInset, y: leftBase.y + uy * lintelInset - 110 };
        const lintelEnd = { x: rightBase.x - ux * lintelInset, y: rightBase.y - uy * lintelInset - 110 };

        // Door corners: trapezoid following the iso slope.
        const tl = { x: lintelStart.x, y: lintelStart.y + lintelHeight + doorTopPad };
        const tr = { x: lintelEnd.x, y: lintelEnd.y + lintelHeight + doorTopPad };
        const bl = { x: lintelStart.x, y: leftBase.y - doorBottomLift };
        const br = { x: lintelEnd.x, y: rightBase.y - doorBottomLift };
        const tc = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
        const bc = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
        const isoAngle = Math.atan2(uy, ux);

        const trace = (...pts) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(pts[0].x), Math.round(pts[0].y));
            for (const p of pts.slice(1)) ctx.lineTo(Math.round(p.x), Math.round(p.y));
            ctx.closePath();
        };
        const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        if (this.gateDoorsOpen) {
            // Open state: thin strips tucked against the inner jambs.
            const tuck = 7;
            // Left leaf strip: along the left edge of the opening.
            trace(
                tl,
                { x: tl.x + ux * tuck, y: tl.y + uy * tuck },
                { x: bl.x + ux * tuck, y: bl.y + uy * tuck },
                bl,
            );
            ctx.fillStyle = '#2c190d';
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            // Right leaf strip.
            trace(
                { x: tr.x - ux * tuck, y: tr.y - uy * tuck },
                tr,
                br,
                { x: br.x - ux * tuck, y: br.y - uy * tuck },
            );
            ctx.fillStyle = '#2c190d';
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.2;
            ctx.stroke();

            // Warm interior glow at the threshold midline (rotated with the iso slope).
            const glowRadius = Math.max(8, length / 2 - lintelInset);
            ctx.fillStyle = wood.glow;
            ctx.beginPath();
            ctx.ellipse(Math.round(bc.x), Math.round(bc.y), glowRadius, 16, isoAngle, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 212, 142, 0.32)';
            ctx.beginPath();
            ctx.ellipse(Math.round(bc.x), Math.round(bc.y - 6),
                Math.max(6, glowRadius - 4), 10, isoAngle, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Closed state: two trapezoidal leaves following the iso slope.
            const doorGradient = ctx.createLinearGradient(0, Math.min(tl.y, tr.y), 0, Math.max(bl.y, br.y));
            doorGradient.addColorStop(0, wood.light);
            doorGradient.addColorStop(0.42, wood.mid);
            doorGradient.addColorStop(1, wood.deep);
            trace(tl, tc, bc, bl);
            ctx.fillStyle = doorGradient;
            ctx.fill();
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            trace(tc, tr, br, bc);
            ctx.fillStyle = doorGradient;
            ctx.fill();
            ctx.stroke();

            // Iron bands at vertical fractions, sloping with the iso projection.
            ctx.strokeStyle = '#2c190d';
            ctx.lineWidth = 3;
            for (const t of [0.22, 0.78]) {
                const bandLeft = lerp(tl, bl, t);
                const bandRight = lerp(tr, br, t);
                ctx.beginPath();
                ctx.moveTo(Math.round(bandLeft.x), Math.round(bandLeft.y));
                ctx.lineTo(Math.round(bandRight.x), Math.round(bandRight.y));
                ctx.stroke();
            }

            // Plank lines per leaf, sloping with the door axis.
            ctx.strokeStyle = '#2c190d';
            ctx.lineWidth = 0.6;
            // Left leaf planks
            for (const f of [0.25, 0.5, 0.75]) {
                const plankTop = lerp(tl, tc, f);
                const plankBot = lerp(bl, bc, f);
                ctx.beginPath();
                ctx.moveTo(Math.round(plankTop.x), Math.round(plankTop.y + 2));
                ctx.lineTo(Math.round(plankBot.x), Math.round(plankBot.y - 2));
                ctx.stroke();
            }
            // Right leaf planks
            for (const f of [0.25, 0.5, 0.75]) {
                const plankTop = lerp(tc, tr, f);
                const plankBot = lerp(bc, br, f);
                ctx.beginPath();
                ctx.moveTo(Math.round(plankTop.x), Math.round(plankTop.y + 2));
                ctx.lineTo(Math.round(plankBot.x), Math.round(plankBot.y - 2));
                ctx.stroke();
            }

            // Heavy diagonal straps keep the closed state readable as two
            // engineered leaves instead of one broad undifferentiated slab.
            ctx.strokeStyle = '#2c190d';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(Math.round(tl.x + ux * 4), Math.round(tl.y + uy * 4 + 4));
            ctx.lineTo(Math.round(bc.x - ux * 4), Math.round(bc.y - uy * 4 - 4));
            ctx.moveTo(Math.round(tc.x - ux * 4), Math.round(tc.y - uy * 4 + 4));
            ctx.lineTo(Math.round(bl.x + ux * 4), Math.round(bl.y + uy * 4 - 4));
            ctx.moveTo(Math.round(tc.x + ux * 4), Math.round(tc.y + uy * 4 + 4));
            ctx.lineTo(Math.round(br.x - ux * 4), Math.round(br.y - uy * 4 - 4));
            ctx.moveTo(Math.round(tr.x - ux * 4), Math.round(tr.y - uy * 4 + 4));
            ctx.lineTo(Math.round(bc.x + ux * 4), Math.round(bc.y + uy * 4 - 4));
            ctx.stroke();

            // Center seam.
            ctx.strokeStyle = stone.outline;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(tc.x), Math.round(tc.y));
            ctx.lineTo(Math.round(bc.x), Math.round(bc.y));
            ctx.stroke();

            // Ring handles near the center seam at mid-height per leaf.
            ctx.fillStyle = '#9aa0a6';
            for (const dir of [-1, 1]) {
                const top = lerp(tc, dir < 0 ? tl : tr, 0.18);
                const bot = lerp(bc, dir < 0 ? bl : br, 0.18);
                const handle = lerp(top, bot, 0.5);
                ctx.beginPath();
                ctx.arc(Math.round(handle.x), Math.round(handle.y), 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        ctx.restore();
    }

    _drawVillageWallSegment(ctx, originX, originY, start, end, phase = 0, footingExtent = null) {
        const palette = VILLAGE_WOOD_PALETTE;
        const stone = VILLAGE_STONE_PALETTE;
        const x1 = Math.round(originX + start.x);
        const y1 = Math.round(originY + start.y);
        const x2 = Math.round(originX + end.x);
        const y2 = Math.round(originY + end.y);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length;
        const uy = dy / length;
        let nx = -uy;
        let ny = ux;
        if (ny < 0) {
            nx *= -1;
            ny *= -1;
        }
        const wallHeight = 56;
        const stoneBandHeight = 18;
        const capWidth = 14;
        const capLift = 5;
        const faceTop1 = { x: x1, y: y1 - wallHeight };
        const faceTop2 = { x: x2, y: y2 - wallHeight };
        const capBack1 = { x: faceTop1.x + nx * capWidth, y: faceTop1.y + ny * capWidth - capLift };
        const capBack2 = { x: faceTop2.x + nx * capWidth, y: faceTop2.y + ny * capWidth - capLift };
        const shadowDrop = 14;
        const postStep = 24;
        const stakeWidth = 10;
        const stakeHeight = 11;
        const offset = (phase % 2) * 5;

        const traceQuad = (a, b, c, d) => {
            ctx.beginPath();
            ctx.moveTo(Math.round(a.x), Math.round(a.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y));
            ctx.lineTo(Math.round(c.x), Math.round(c.y));
            ctx.lineTo(Math.round(d.x), Math.round(d.y));
            ctx.closePath();
        };

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        ctx.globalAlpha = 0.32;
        ctx.fillStyle = palette.shadow;
        traceQuad(
            { x: x1 - nx * 7, y: y1 + shadowDrop },
            { x: x2 - nx * 7, y: y2 + shadowDrop },
            { x: x2 + nx * 11, y: y2 + shadowDrop + 8 },
            { x: x1 + nx * 11, y: y1 + shadowDrop + 8 },
        );
        ctx.fill();
        ctx.globalAlpha = 1;

        traceQuad({ x: x1, y: y1 }, { x: x2, y: y2 }, faceTop2, faceTop1);
        const faceGradient = ctx.createLinearGradient(0, Math.min(y1, y2) - wallHeight, 0, Math.max(y1, y2));
        faceGradient.addColorStop(0, palette.light);
        faceGradient.addColorStop(0.46, palette.mid);
        faceGradient.addColorStop(1, palette.deep);
        ctx.fillStyle = faceGradient;
        ctx.fill();
        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 3;
        ctx.stroke();

        // A continuous masonry plinth visually carries the whole perimeter and
        // ties it to the gate towers. The previous timber-to-ground edge made
        // the long wall read as a flat fence instead of village fortification.
        const stoneTop1 = { x: x1, y: y1 - stoneBandHeight };
        const stoneTop2 = { x: x2, y: y2 - stoneBandHeight };
        traceQuad({ x: x1, y: y1 }, { x: x2, y: y2 }, stoneTop2, stoneTop1);
        const stoneGradient = ctx.createLinearGradient(0, Math.min(y1, y2) - stoneBandHeight, 0, Math.max(y1, y2));
        stoneGradient.addColorStop(0, stone.light);
        stoneGradient.addColorStop(1, stone.shadow);
        ctx.fillStyle = stoneGradient;
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1), Math.round(y1 - stoneBandHeight / 2));
        ctx.lineTo(Math.round(x2), Math.round(y2 - stoneBandHeight / 2));
        ctx.stroke();
        for (let d = 18; d < length - 8; d += 28) {
            const jointX = x1 + ux * d;
            const jointY = y1 + uy * d;
            const upperCourse = Math.floor(d / 28) % 2 === 0;
            ctx.beginPath();
            ctx.moveTo(Math.round(jointX), Math.round(jointY - (upperCourse ? stoneBandHeight : stoneBandHeight / 2)));
            ctx.lineTo(Math.round(jointX), Math.round(jointY - (upperCourse ? stoneBandHeight / 2 : 0)));
            ctx.stroke();
        }

        traceQuad(faceTop1, faceTop2, capBack2, capBack1);
        ctx.fillStyle = palette.dark;
        ctx.fill();
        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = palette.rope;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(faceTop1.x + nx * 2), Math.round(faceTop1.y + ny * 2 - 2));
        ctx.lineTo(Math.round(faceTop2.x + nx * 2), Math.round(faceTop2.y + ny * 2 - 2));
        ctx.stroke();

        ctx.save();
        traceQuad({ x: x1, y: y1 }, { x: x2, y: y2 }, faceTop2, faceTop1);
        ctx.clip();
        for (let d = 8 + offset; d < length; d += 13) {
            const baseX = x1 + ux * d;
            const baseY = y1 + uy * d;
            const plankNoise = Math.floor(d / 13) % 3;
            ctx.strokeStyle = plankNoise === 0 ? '#2c190d' : '#593317';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(baseX), Math.round(baseY - 4));
            ctx.lineTo(Math.round(baseX), Math.round(baseY - wallHeight + 7 + plankNoise * 2));
            ctx.stroke();
            if (plankNoise === 1) {
                ctx.strokeStyle = 'rgba(219, 151, 76, 0.35)';
                ctx.beginPath();
                ctx.moveTo(Math.round(baseX + ux * 2), Math.round(baseY - 8));
                ctx.lineTo(Math.round(baseX + ux * 2), Math.round(baseY - wallHeight + 12));
                ctx.stroke();
            }
        }
        for (const row of [22, 39]) {
            ctx.strokeStyle = palette.dark;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(Math.round(x1), Math.round(y1 - row));
            ctx.lineTo(Math.round(x2), Math.round(y2 - row));
            ctx.stroke();
            ctx.strokeStyle = palette.rope;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(Math.round(x1), Math.round(y1 - row - 2));
            ctx.lineTo(Math.round(x2), Math.round(y2 - row - 2));
            ctx.stroke();
        }
        for (let d = 10; d < length - 32; d += 54) {
            const next = Math.min(length - 4, d + 42);
            const ax = x1 + ux * d;
            const ay = y1 + uy * d;
            const bx = x1 + ux * next;
            const by = y1 + uy * next;
            ctx.strokeStyle = palette.dark;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(Math.round(ax), Math.round(ay - stoneBandHeight - 4));
            ctx.lineTo(Math.round(bx), Math.round(by - wallHeight + 8));
            ctx.moveTo(Math.round(ax), Math.round(ay - wallHeight + 8));
            ctx.lineTo(Math.round(bx), Math.round(by - stoneBandHeight - 4));
            ctx.stroke();
        }
        ctx.restore();

        for (let d = 7 + offset; d < length - 2; d += postStep) {
            const half = stakeWidth / 2;
            const a = { x: x1 + ux * (d - half), y: y1 + uy * (d - half) - wallHeight };
            const b = { x: x1 + ux * (d + half), y: y1 + uy * (d + half) - wallHeight };
            const cadence = Math.floor(d / postStep);
            const tip = { x: x1 + ux * d, y: y1 + uy * d - wallHeight - stakeHeight - (cadence % 3 === 0 ? 4 : 0) };
            ctx.beginPath();
            ctx.moveTo(Math.round(a.x), Math.round(a.y + 8));
            ctx.lineTo(Math.round(a.x), Math.round(a.y));
            ctx.lineTo(Math.round(tip.x), Math.round(tip.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y));
            ctx.lineTo(Math.round(b.x), Math.round(b.y + 8));
            ctx.closePath();
            ctx.fillStyle = cadence % 2 ? palette.mid : palette.dark;
            ctx.fill();
            ctx.strokeStyle = palette.outline;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        if (footingExtent) {
            this._drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, footingExtent);
        }

        for (let d = 32 + offset; d < length - 12; d += 72) {
            const p = { x: x1 + ux * d, y: y1 + uy * d };
            const w = 13;
            const h = wallHeight + 13;
            ctx.fillStyle = palette.deep;
            ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - h + 7), w, h - stoneBandHeight);
            ctx.fillStyle = stone.mid;
            ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - stoneBandHeight), w, stoneBandHeight + 7);
            ctx.strokeStyle = palette.outline;
            ctx.lineWidth = 2;
            ctx.strokeRect(Math.round(p.x - w / 2), Math.round(p.y - h + 7), w, h);
            ctx.fillStyle = palette.tealDark;
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x - 10), Math.round(p.y - h + 6));
            ctx.lineTo(Math.round(p.x), Math.round(p.y - h));
            ctx.lineTo(Math.round(p.x + 10), Math.round(p.y - h + 6));
            ctx.lineTo(Math.round(p.x), Math.round(p.y - h + 11));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = palette.tealLight;
            ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - h + 2), 4, 2);
        }

        for (let d = 18 + offset; d < length - 8; d += 38) {
            const p = { x: x1 + ux * d, y: y1 + uy * d };
            ctx.strokeStyle = palette.ropeDark;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x - nx * 6), Math.round(p.y - 18 - ny * 6));
            ctx.lineTo(Math.round(p.x + nx * 6), Math.round(p.y - 18 + ny * 6));
            ctx.moveTo(Math.round(p.x - nx * 6), Math.round(p.y - 36 - ny * 6));
            ctx.lineTo(Math.round(p.x + nx * 6), Math.round(p.y - 36 + ny * 6));
            ctx.stroke();
        }

        for (let d = 24 + offset; d < length - 12; d += 74) {
            const p = { x: x1 + ux * d, y: y1 + uy * d - 30 };
            ctx.fillStyle = palette.moss;
            ctx.fillRect(Math.round(p.x - 3), Math.round(p.y), 9, 3);
            ctx.fillStyle = '#d8c79a';
            ctx.fillRect(Math.round(p.x + 6), Math.round(p.y + 4), 2, 2);
            ctx.fillRect(Math.round(p.x - 7), Math.round(p.y + 11), 2, 2);
        }

        // Trailing ivy down the wall face — breaks up the bare planks.
        //
        // Stepped one pixel at a time rather than stroked as a polyline. A 2px
        // diagonal stroke antialiases into a soft grey-green smear that reads
        // as a marker scribble next to hard-edged planks; a stepped column of
        // rects stays on the pixel grid like everything around it.
        for (let d = 58 + offset; d < length - 16; d += 116) {
            const ix = Math.round(x1 + ux * d);
            const iy = Math.round(y1 + uy * d);
            const top = iy - wallHeight + 10;
            const drop = 46;
            const phase = d * 0.37;
            for (let k = 0; k <= drop; k++) {
                const wander = Math.round(Math.sin(k * 0.16 + phase) * 3);
                const yy = top + k;
                // Two tones: a darker core with a lit left edge, so the vine has
                // a direction of light like the masonry does.
                ctx.fillStyle = 'rgba(58, 92, 38, 0.92)';
                ctx.fillRect(ix + wander, yy, 2, 1);
                if (k % 3 === 0) {
                    ctx.fillStyle = 'rgba(96, 140, 60, 0.85)';
                    ctx.fillRect(ix + wander, yy, 1, 1);
                }
            }
            // Leaves hang off alternating sides of the stem.
            for (let k = 1; k <= 4; k++) {
                const yy = top + 4 + k * 10;
                const xx = ix + Math.round(Math.sin((yy - top) * 0.16 + phase) * 3);
                const side = k % 2 === 0 ? 1 : -1;
                ctx.fillStyle = 'rgba(96, 140, 60, 0.92)';
                ctx.fillRect(xx + (side > 0 ? 2 : -3), yy, 3, 2);
                ctx.fillStyle = 'rgba(126, 170, 78, 0.75)';
                ctx.fillRect(xx + (side > 0 ? 2 : -3), yy, 1, 1);
            }
        }

        // Low shrubs tucked against the wall footing. Stepped mounds rather
        // than ctx.ellipse, for the same reason as the ivy above.
        for (let d = 30 + offset; d < length - 10; d += 52) {
            const sx = Math.round(x1 + ux * d + nx * 4);
            const sy = Math.round(y1 + uy * d + ny * 4 + 4);
            const rows = [
                { dy: -3, half: 2 },
                { dy: -2, half: 4 },
                { dy: -1, half: 6 },
                { dy: 0, half: 7 },
                { dy: 1, half: 5 },
            ];
            ctx.fillStyle = 'rgba(44, 76, 30, 0.95)';
            for (const row of rows) ctx.fillRect(sx - row.half, sy + row.dy, row.half * 2, 1);
            ctx.fillStyle = 'rgba(74, 116, 50, 0.92)';
            ctx.fillRect(sx - 4, sy - 2, 5, 1);
            ctx.fillRect(sx - 3, sy - 3, 3, 1);
        }

        // Mounted torches — warm pools of light along the palisade. Gentle
        // flicker when motion is enabled; steady glow under reduced motion.
        for (let d = 50 + offset * 2; d < length - 18; d += 92) {
            const bx = x1 + ux * d;
            const topY = y1 + uy * d - wallHeight + 9;
            ctx.fillStyle = palette.dark;
            ctx.fillRect(Math.round(bx - 2), Math.round(topY), 4, 11);
            const flick = this.motionScale ? (Math.sin(this.waterFrame * 3 + d) * 0.5 + 0.5) : 0.5;
            drawPixelFlame(ctx, bx, topY, 7 + flick * 3, 3, {
                lean: this.motionScale ? Math.sin(this.waterFrame * 1.4 + d) * 1.2 : 0,
            });
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            const glow = ctx.createRadialGradient(bx, topY - 2, 1, bx, topY - 2, 22);
            glow.addColorStop(0, 'rgba(255, 180, 80, 0.40)');
            glow.addColorStop(1, 'rgba(255, 180, 80, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(Math.round(bx - 24), Math.round(topY - 26), 48, 48);
            ctx.restore();
        }

        ctx.strokeStyle = palette.outline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1), Math.round(y1));
        ctx.lineTo(Math.round(x2), Math.round(y2));
        ctx.stroke();
        ctx.restore();
    }

    _drawVillageWallStoneFooting(ctx, x1, y1, x2, y2, ux, uy, nx, ny, length, extent) {
        const stone = VILLAGE_STONE_PALETTE;
        // Footing is painted as a strip at the wall base on the side closest to the gate.
        const fullDist = Math.min(extent.distance ?? 30, length - 32); // stay clear of the last watchpost
        const ditherDist = extent.dither ?? 32;
        if (fullDist <= 0) return;

        // Determine which end of the segment is gate-adjacent.
        const fromEnd = extent.side === 'end';
        const startD = fromEnd ? length - fullDist : 0;
        const endD = fromEnd ? length : fullDist;
        const ditherStartD = fromEnd ? startD - ditherDist : endD;
        const ditherEndD = fromEnd ? startD : endD + ditherDist;

        const footingHeight = 18; // px, drops below the wall face
        const stoneY = (d) => ({
            x: x1 + ux * d,
            y: y1 + uy * d,
        });

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);

        // Full footing block
        const a = stoneY(startD);
        const b = stoneY(endD);
        ctx.fillStyle = stone.mid;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight));
        ctx.lineTo(Math.round(a.x), Math.round(a.y + footingHeight));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = stone.outline;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Mortar line across the middle of the footing
        ctx.strokeStyle = stone.mortar;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(a.x), Math.round(a.y + footingHeight / 2));
        ctx.lineTo(Math.round(b.x), Math.round(b.y + footingHeight / 2));
        ctx.stroke();

        // Vertical mortar joints (offset between courses)
        for (let d = startD + 16; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.stroke();
        }
        for (let d = startD + 28; d < endD; d += 24) {
            const p = stoneY(d);
            ctx.beginPath();
            ctx.moveTo(Math.round(p.x), Math.round(p.y + footingHeight / 2));
            ctx.lineTo(Math.round(p.x), Math.round(p.y + footingHeight));
            ctx.stroke();
        }

        // Moss tufts on top edge of footing (only inside the full block)
        ctx.fillStyle = stone.moss;
        for (let d = startD + 8; d < endD; d += 28) {
            const p = stoneY(d);
            ctx.fillRect(Math.round(p.x - 4), Math.round(p.y - 2), 8, 3);
        }

        // Dither stones — the footing tumbling out over half a tile.
        //
        // These were flat mid-grey squares with a hard outline on all four
        // sides: no lit edge, no shadow, no contact with the ground, so they
        // read as UI boxes dropped on the sand rather than masonry petering
        // out. Same three-tone treatment as the course above, a shadow under
        // each one, and a small stagger so they tumble instead of descending a
        // perfect staircase.
        const cubeCount = 4;
        for (let i = 0; i < cubeCount; i++) {
            const t = (i + 1) / (cubeCount + 1);
            const d = fromEnd ? startD - t * ditherDist : endD + t * ditherDist;
            const size = Math.max(3, Math.round(footingHeight * (1 - t)));
            const p = stoneY(d);
            // Deterministic per-stone wobble, so the run never looks stepped.
            const jitter = ((i * 37) % 5) - 2;
            const sx = Math.round(p.x - size / 2) + jitter;
            const sy = Math.round(p.y + footingHeight - size) + ((i * 23) % 3) - 1;

            ctx.fillStyle = 'rgba(24, 18, 14, 0.28)';
            ctx.fillRect(sx - 1, sy + size, size + 2, 1);

            ctx.fillStyle = stone.mid;
            ctx.fillRect(sx, sy, size, size);
            ctx.fillStyle = stone.light;
            ctx.fillRect(sx, sy, size, 1);
            if (size > 4) {
                ctx.fillStyle = stone.shadow;
                ctx.fillRect(sx, sy + size - 1, size, 1);
                ctx.fillRect(sx + size - 1, sy + 1, 1, size - 1);
            }
            ctx.fillStyle = stone.mortar;
            ctx.fillRect(sx, sy + size - 1, 1, 1);
        }

        ctx.restore();
    }

    _terrainCacheBounds() {
        if (this.terrainCacheBounds) return this.terrainCacheBounds;
        const points = this._worldDiamondPoints();
        const minX = Math.floor(Math.min(...points.map(p => p.x)) - TERRAIN_CACHE_MARGIN);
        const maxX = Math.ceil(Math.max(...points.map(p => p.x)) + TERRAIN_CACHE_MARGIN);
        const minY = Math.floor(Math.min(...points.map(p => p.y)) - TERRAIN_CACHE_MARGIN);
        const maxY = Math.ceil(Math.max(...points.map(p => p.y)) + TERRAIN_CACHE_MARGIN);
        this.terrainCacheBounds = {
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
        };
        return this.terrainCacheBounds;
    }

    _getTerrainCacheMeta(bounds = this._terrainCacheBounds()) {
        if (this.terrainCacheMeta?.bounds === bounds) return this.terrainCacheMeta;
        const chunksX = Math.ceil(MAP_SIZE / TERRAIN_CACHE_CHUNK_SIZE);
        const chunksY = Math.ceil(MAP_SIZE / TERRAIN_CACHE_CHUNK_SIZE);
        const chunks = [];
        for (let chunkY = 0; chunkY < chunksY; chunkY++) {
            for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                const tileX = chunkX * TERRAIN_CACHE_CHUNK_SIZE;
                const tileY = chunkY * TERRAIN_CACHE_CHUNK_SIZE;
                chunks.push({
                    key: `${chunkX},${chunkY}`,
                    chunkX,
                    chunkY,
                    tileX,
                    tileY,
                    tileWidth: Math.min(TERRAIN_CACHE_CHUNK_SIZE, MAP_SIZE - tileX),
                    tileHeight: Math.min(TERRAIN_CACHE_CHUNK_SIZE, MAP_SIZE - tileY),
                });
            }
        }
        const singleSurfacePixels = Math.max(1, Math.round(bounds.w)) * Math.max(1, Math.round(bounds.h));
        this.terrainCacheMeta = {
            bounds,
            mapSize: MAP_SIZE,
            strategy: singleSurfacePixels <= TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS
                ? 'single-surface'
                : 'uncached-over-budget',
            chunkSize: TERRAIN_CACHE_CHUNK_SIZE,
            chunksX,
            chunksY,
            chunkCount: chunks.length,
            chunks,
            singleSurfacePixels,
            maxSingleSurfacePixels: TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS,
            singleSurfaceWithinBudget: singleSurfacePixels <= TERRAIN_CACHE_MAX_SINGLE_SURFACE_PIXELS,
        };
        return this.terrainCacheMeta;
    }

    _emitTerrainCacheLimitWarning(meta) {
        const key = `${meta.mapSize}:${meta.singleSurfacePixels}`;
        if (this._terrainCacheLimitWarningKey === key) return;
        this._terrainCacheLimitWarningKey = key;
        console.warn(
            `[IsometricRenderer] terrain cache ${meta.singleSurfacePixels}px exceeds ${meta.maxSingleSurfacePixels}px; ` +
            `using uncached static terrain until chunked caches are implemented.`
        );
    }

    getTerrainCacheDiagnostics() {
        const meta = this._getTerrainCacheMeta();
        return {
            strategy: meta.strategy,
            mapSize: meta.mapSize,
            chunkSize: meta.chunkSize,
            chunksX: meta.chunksX,
            chunksY: meta.chunksY,
            chunkCount: meta.chunkCount,
            singleSurfacePixels: meta.singleSurfacePixels,
            maxSingleSurfacePixels: meta.maxSingleSurfacePixels,
            singleSurfaceWithinBudget: meta.singleSurfaceWithinBudget,
            retainedPixels: canvasPixelCount(this.terrainCache),
        };
    }

    _drawDynamicWaterHighlights(ctx) {
        const bounds = this._getVisibleTileBounds(3);
        const waterTiles = this._visibleWaterTileDescriptors(bounds);
        const shoreEdges = this._visibleShoreWaterEdgeDescriptors(bounds);
        let detailTiles = waterTiles;
        if ((this._waterWeather?.rain || 0) > 0.65) {
            detailTiles = this._weatherWaterFrame;
            detailTiles.length = 0;
            for (const tile of waterTiles) {
                if ((tile.x * 3 + tile.y * 5) % 3 === 0) detailTiles.push(tile);
            }
        }
        this._drawPhaseWaterTint(ctx, waterTiles);
        this._drawWeatherWaterRipples(ctx, waterTiles);
        this._drawWaterFogEdgeWash(ctx, shoreEdges);
        this._drawHarborWakeWaterDescriptors(ctx);
        this._drawNightWaterReflections(ctx, detailTiles);
        this._drawSeaGlitter(ctx, detailTiles);
        this._drawBuildingLightReflections(ctx, waterTiles);
        this._drawSurfWashBands(ctx, shoreEdges);
        // B1 — river-flow streaks carry their own reduced-motion static fallback,
        // so they draw before the motion gate below.
        this._drawRiverFlowStreaks(ctx, waterTiles);
        if (!this.motionScale) return;
        this._drawAnimatedCurrentBands(ctx, detailTiles);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of detailTiles) {
            if (tile.seed <= 0.82) continue;
            // B7: in storms, increase shimmer t frequency for lagoon tiles.
            const stormFreqMult = tile.isLagoon && this._stormIntensity
                ? 1 + 0.5 * this._stormIntensity
                : 1;
            const shimmerT = this.waterFrame * 2.2 * stormFreqMult + tile.seed * 10;
            const shimmer = 0.035 + Math.max(0, Math.sin(shimmerT)) * 0.045;
            const warm = this._atmosphereReactions?.warmGlint || 0;
            const glintColor = warm > 0.15 ? '255, 212, 142' : tile.token.glint;
            ctx.strokeStyle = `rgba(${glintColor}, ${shimmer * (1 + warm * 0.42)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tile.screenX - 12, tile.screenY - 2);
            ctx.lineTo(tile.screenX + 10, tile.screenY - 6);
            ctx.stroke();
        }
        this._drawShorelineReflectionShimmer(ctx, shoreEdges);
        ctx.restore();
    }

    _drawWeatherPuddles(ctx) {
        const reactions = this._atmosphereReactions || {};
        const alphaBase = reactions.puddleAlpha || 0;
        if (alphaBase <= 0.025) return;
        const { startX, endX, startY, endY } = this._getVisibleTileBounds(2);
        const pulseFrame = this.motionScale ? this.waterFrame : STATIC_WATER_SHIMMER;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                if ((x + y) % 2 !== 0) continue;
                const key = `${x},${y}`;
                const eligible = this.townSquareTiles?.has(key)
                    || this.mainAvenueTiles?.has(key)
                    || this.pathTiles?.has(key)
                    || this.dirtPathTiles?.has(key);
                if (!eligible || this._isVisualWaterTile(x, y, key) || this.bridgeTiles?.has(key)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                if (seed < 0.58) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const pulse = this.motionScale ? (Math.sin(pulseFrame * 1.4 + seed * 7.1) + 1) / 2 : 0.55;
                const warm = reactions.warmGlint || 0;
                const alpha = Math.min(0.18, alphaBase * (0.18 + seed * 0.22 + pulse * 0.12));
                ctx.fillStyle = warm > 0.12
                    ? `rgba(255, 214, 148, ${alpha * 0.72})`
                    : `rgba(180, 230, 235, ${alpha})`;
                ctx.beginPath();
                ctx.ellipse(
                    Math.round(screenX + (seed - 0.5) * 18),
                    Math.round(screenY + 2 + (seed - 0.5) * 5),
                    7 + seed * 8,
                    2.4 + seed * 2.2,
                    -0.18 + seed * 0.32,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
                if (seed > 0.74) {
                    this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.rainSplash, {
                        x: screenX + (seed - 0.5) * 18,
                        y: screenY - 1 + (seed - 0.5) * 5,
                        alpha: Math.min(0.22, alphaBase * (0.22 + pulse * 0.18)),
                        scale: 0.58 + seed * 0.28,
                        rotation: -0.18 + seed * 0.34,
                    });
                }
            }
        }
        this._drawShorePuddles(ctx, reactions, alphaBase, pulseFrame);
        ctx.restore();
    }

    // Wet-cobble shore sheen: after rain the low shore tiles glisten with a
    // cool puddle film that warms toward gold at dawn/dusk. Tiles come from the
    // deterministic SceneryEngine subset so the sheen never strobes; per-frame
    // cost is only the pulse, and `STATIC_WATER_SHIMMER` carries the reduced-
    // motion path with a steady sheen.
    _drawShorePuddles(ctx, reactions, alphaBase, pulseFrame) {
        if (!this.wetShoreTiles?.size) return;
        const { startX, endX, startY, endY } = this._getVisibleTileBounds(2);
        const warm = reactions.warmGlint || 0;
        const night = reactions.nightReflection || 0;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.wetShoreTiles.has(key)) continue;
                if (this._isVisualWaterTile(x, y, key) || this.bridgeTiles?.has(key)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const pulse = this.motionScale ? (Math.sin(pulseFrame * 1.2 + seed * 6.3) + 1) / 2 : 0.55;
                const alpha = Math.min(0.16, alphaBase * (0.14 + seed * 0.2 + pulse * 0.1) * (1 + night * 0.2));
                ctx.fillStyle = warm > 0.12
                    ? `rgba(255, 208, 142, ${alpha * 0.7})`
                    : `rgba(168, 222, 230, ${alpha})`;
                ctx.beginPath();
                ctx.ellipse(
                    Math.round(screenX + (seed - 0.5) * 16),
                    Math.round(screenY + 3 + (seed - 0.5) * 4),
                    6 + seed * 7,
                    2.1 + seed * 1.8,
                    -0.16 + seed * 0.3,
                    0,
                    Math.PI * 2,
                );
                ctx.fill();
            }
        }
    }

    _drawSurfaceWetnessMarks(ctx, layer = 'ground') {
        const wetness = this._atmosphereReactions?.surfaceWetness || 0;
        if (wetness <= 0.03) return;

        const sparseTiles = (tiles, stride, salt) => {
            const points = [];
            if (!tiles) return points;
            let index = 0;
            for (const key of tiles) {
                if ((index++ % stride) !== 0) continue;
                const iso = isoFromTileKey(key);
                if (!iso) continue;
                points.push({
                    x: iso.x,
                    y: iso.y,
                    seed: ((iso.tileX * 13 + iso.tileY * 7 + salt) % 10) / 10,
                });
            }
            return points;
        };

        const docks = [];
        if (this.bridgeTiles?.size && (layer === 'ground' || layer === 'all')) {
            for (const [key, info] of this.bridgeTiles) {
                if (info?.kind !== 'dock') continue;
                const iso = isoFromTileKey(key);
                if (!iso) continue;
                docks.push({
                    x: iso.x,
                    y: iso.y,
                    seed: ((iso.tileX * 17 + iso.tileY * 5) % 10) / 10,
                });
            }
        }

        const roofs = [];
        if ((layer === 'roofs' || layer === 'all') && this.world?.buildings) {
            for (const building of this.world.buildings.values()) {
                const type = String(building?.type || '');
                if (type === 'watchfire') continue;
                const pos = building.position;
                if (!pos || !Number.isFinite(pos.tileX) || !Number.isFinite(pos.tileY)) continue;
                const iso = isoFromTile(
                    pos.tileX + (Number(building.width) || 1) / 2,
                    pos.tileY + (Number(building.height) || 1) / 2,
                );
                if (!iso) continue;
                roofs.push({
                    x: iso.x,
                    y: iso.y - 22,
                    seed: ((iso.tileX * 11 + iso.tileY * 3) % 10) / 10,
                });
            }
        }

        const footings = [];
        if (layer === 'ground' || layer === 'all') {
            for (const route of VILLAGE_WALL_ROUTES) {
                for (const point of route.points) {
                    const iso = isoFromTile(point.tileX, point.tileY);
                    if (!iso) continue;
                    footings.push({
                        x: iso.x,
                        y: iso.y + 10,
                        seed: 0.62,
                    });
                }
            }
        }

        const marks = collectDampMarks({
            roads: layer === 'roofs' ? [] : sparseTiles(this.pathTiles, 7, 2),
            docks: layer === 'roofs' ? [] : docks,
            roofs,
            footings: layer === 'roofs' ? [] : footings,
            wetness,
            layer,
        });
        if (!marks.length) return;

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.globalCompositeOperation = 'screen';
        for (const mark of marks) {
            if (mark.alpha <= 0.01) continue;
            const cool = mark.material === 'dock' || mark.material === 'stone';
            ctx.fillStyle = cool
                ? `rgba(168, 214, 224, ${mark.alpha})`
                : `rgba(196, 220, 228, ${mark.alpha})`;
            const x = Math.round(mark.x);
            const y = Math.round(mark.y);
            ctx.fillRect(x - 2, y, 5, 1);
            if (mark.seed > 0.55) ctx.fillRect(x, y - 1, 1, 2);
        }
        ctx.restore();
    }

    _getAtmosphereEffectSprite(id) {
        if (!id || !this.assets?.has?.(id)) return null;
        const cached = this._atmosphereEffectSpriteCache.get(id);
        if (cached) return cached;
        const img = this.assets.get(id);
        if (!img) return null;
        const dims = this.assets.getDims(id) || { w: img.width, h: img.height };
        const sprite = { img, dims };
        this._atmosphereEffectSpriteCache.set(id, sprite);
        return sprite;
    }

    _drawAtmosphereEffectSprite(ctx, id, {
        x,
        y,
        alpha = 1,
        scale = 1,
        scaleX = null,
        scaleY = null,
        rotation = 0,
        flipX = false,
    } = {}) {
        const sprite = this._getAtmosphereEffectSprite(id);
        if (!sprite || alpha <= 0.005) return false;
        const sx = (scaleX ?? scale) * (flipX ? -1 : 1);
        const sy = scaleY ?? scale;
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(Math.round(x), Math.round(y));
        if (rotation) ctx.rotate(rotation);
        ctx.scale(sx, sy);
        ctx.drawImage(sprite.img, Math.round(-sprite.dims.w / 2), Math.round(-sprite.dims.h / 2));
        ctx.restore();
        return true;
    }

    _waterWeatherState(atmosphere = null) {
        const wx = atmosphere?.weather || {};
        const type = wx.type || 'clear';
        const intensity = Math.max(0, Math.min(1, Number(wx.intensity) || 0));
        const precipitation = Math.max(0, Math.min(1, Number(wx.precipitation ?? (type === 'rain' || type === 'storm' ? intensity : 0)) || 0));
        const storm = type === 'storm' || (type === 'rain' && intensity > 0.72);
        return {
            rain: precipitation,
            storm: storm ? intensity : 0,
            fog: type === 'fog' ? intensity : Math.max(0, Math.min(1, Number(wx.fog) || 0)),
            windX: Number(wx.windX) || atmosphere?.motion?.windX || 1,
            reactions: atmosphere?.reactions || {},
            phase: atmosphere?.phase || 'day',
        };
    }

    _drawWeatherWaterRipples(ctx, waterTiles) {
        const weather = this._waterWeather || {};
        const reactions = weather.reactions || {};
        const rain = weather.rain || 0;
        if (rain <= 0.08 || !waterTiles?.length) return;

        // Stamp the manifest-driven rain ripple sprite for a small random
        // fraction of visible water tiles per frame. The WeatherRenderer
        // self-throttles per tile (2s) so the global ripple budget stays
        // bounded. Skipped under reduced motion.
        const stampRipples = (this.motionScale ?? 1) > 0
            && typeof this.weatherRenderer?.maybeStampWaterRipple === 'function';

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const rippleScale = reactions.waterRippleScale || rain;
        const stride = rain > 0.65 ? 4 : 3;
        for (const tile of waterTiles) {
            const localStride = tile.profile === 'openSea' ? stride + 1 : tile.profile === 'harbor' ? stride : Math.max(1, stride - 1);
            if (((tile.x * 3 + tile.y * 5 + Math.floor(tile.seed * 11)) % localStride) !== 0) continue;
            if (stampRipples && Math.random() < 1 / 30) {
                this.weatherRenderer.maybeStampWaterRipple(ctx, tile.x, tile.y, tile.screenX, tile.screenY);
            }
            const phase = (this.motionScale ? this.waterFrame : STATIC_WATER_SHIMMER) * (1.8 + rain * 1.3) + tile.seed * 6.28;
            const pulse = (Math.sin(phase) + 1) / 2;
            const profileScale = tile.profile === 'openSea' ? 0.72 : tile.profile === 'harbor' ? 0.90 : 1.14;
            const radius = (4 + pulse * (5 + rain * 5)) * profileScale * (0.76 + rippleScale * 0.36);
            const nightReflection = reactions.nightReflection || 0;
            const alpha = (0.030 + rain * 0.078) * (1 - pulse * 0.45) * (tile.profile === 'openSea' ? 0.72 : 1) * (1 + nightReflection * 0.18);
            if (this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.rainRipple, {
                x: tile.screenX + (tile.seed - 0.5) * 18,
                y: tile.screenY - 2 + (tile.seed - 0.5) * 8,
                alpha: Math.min(0.28, alpha * 1.9),
                scaleX: (0.62 + pulse * 0.38) * profileScale,
                scaleY: (0.52 + pulse * 0.20) * profileScale,
                rotation: -0.18,
                flipX: tile.seed > 0.5,
            })) {
                continue;
            }
            ctx.strokeStyle = `rgba(${tile.token.rainRipple}, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(
                Math.round(tile.screenX + (tile.seed - 0.5) * 18),
                Math.round(tile.screenY - 2 + (tile.seed - 0.5) * 8),
                radius,
                radius * 0.38,
                -0.18,
                0,
                Math.PI * 2,
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawWaterFogEdgeWash(ctx, shoreEdges) {
        const fogAlpha = this._waterWeather?.reactions?.waterFogAlpha || this._waterWeather?.fog * 0.24 || 0;
        if (fogAlpha <= 0.025 || !shoreEdges?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of shoreEdges) {
            if ((this._waterWeather?.rain || 0) > 0.65 && (tile.x + tile.y) % 2 !== 0) continue;
            const profileAlpha = tile.profile === 'openSea' ? 0.54 : tile.profile === 'harbor' ? 1.05 : 1.16;
            ctx.strokeStyle = `rgba(${tile.token.fogWash}, ${Math.min(0.20, fogAlpha * profileAlpha * (0.34 + tile.seed * 0.44))})`;
            ctx.lineWidth = 2;
            this._strokeInsetDiamondEdges(ctx, tile.screenX, tile.screenY, tile.edge, 3 + tile.seed * 4);
            if (tile.seed > 0.58) {
                this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.fogWisp, {
                    x: tile.screenX + (tile.seed - 0.5) * 24,
                    y: tile.screenY - 5 + (tile.seed - 0.5) * 8,
                    alpha: Math.min(0.22, fogAlpha * profileAlpha * (0.24 + tile.seed * 0.20)),
                    scaleX: 0.42 + tile.seed * 0.24,
                    scaleY: 0.34 + tile.seed * 0.12,
                    rotation: -0.20 + tile.seed * 0.24,
                    flipX: tile.seed > 0.5,
                });
            }
        }
        ctx.restore();
    }

    // Phase-coupled water palette. Tint base water toward the active phase
    // palette's horizon (warm dusk/dawn) or zenith-darkened (night). At noon
    // both reactions are ~0 so this method is a near-noop and water stays teal.
    _drawPhaseWaterTint(ctx, waterTiles) {
        const reactions = this._atmosphereReactions || {};
        const warmGlint = reactions.warmGlint || 0;
        const nightReflection = reactions.nightReflection || 0;
        const warmActive = warmGlint > 0.05;
        const nightActive = nightReflection > 0.10;
        if ((!warmActive && !nightActive) || !waterTiles?.length) return;
        const palette = this._lastAtmosphere?.sky?.palette;
        if (!palette) return;
        const cap = THEME.waterTint?.alphaCap ?? 0.22;
        const tints = [];
        if (warmActive && palette.horizon) {
            const horizonMix = THEME.waterTint?.horizonMix ?? 0.55;
            tints.push({
                color: palette.horizon,
                alpha: Math.min(cap, warmGlint * horizonMix),
            });
        }
        if (nightActive && palette.zenith) {
            // Halve the zenith RGB to darken (palette.zenith * 0.5).
            const zenithMix = THEME.waterTint?.zenithMix ?? 0.45;
            tints.push({
                color: this._halfHex(palette.zenith),
                alpha: Math.min(cap, nightReflection * zenithMix),
            });
        }
        if (!tints.length) return;
        ctx.save();
        // source-over: this is a base tint, not an additive highlight.
        for (const tile of waterTiles) {
            for (const tint of tints) {
                ctx.fillStyle = this._withAlpha(tint.color, tint.alpha);
                this._drawDiamond(ctx, tile.screenX, tile.screenY);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    // Halve a #rrggbb hex toward black; used for night water zenith darkening.
    _halfHex(hex) {
        if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex;
        const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * 0.5)));
        const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * 0.5)));
        const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * 0.5)));
        const hh = (n) => n.toString(16).padStart(2, '0');
        return `#${hh(r)}${hh(g)}${hh(b)}`;
    }

    _drawNightWaterReflections(ctx, waterTiles) {
        const nightReflection = this._atmosphereReactions?.nightReflection || 0;
        if (nightReflection <= 0.05 || !waterTiles?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of waterTiles) {
            if (tile.seed < 0.46) continue;
            if (tile.profile === 'lagoon' && tile.seed < 0.68) continue;
            const width = 8 + tile.seed * (tile.profile === 'openSea' ? 20 : 14);
            const alpha = Math.min(0.16, nightReflection * (0.032 + tile.seed * 0.052));
            ctx.strokeStyle = `rgba(${tile.token.glint}, ${alpha})`;
            ctx.lineWidth = tile.profile === 'openSea' ? 1.4 : 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(tile.screenX - width), Math.round(tile.screenY - 7 + tile.seed * 3));
            ctx.lineTo(Math.round(tile.screenX + width * 0.72), Math.round(tile.screenY - 10 - tile.seed * 2));
            ctx.stroke();
        }
        ctx.restore();
    }

    // #10 — Night water light reflections. Building fire (forge glow, harbor
    // torches, lighthouse lantern) bleeds onto adjacent water as wavering
    // vertical reflection columns at dusk/night. Origins and tile centers share
    // the same unzoomed world-screen space, so a reflection falls on water that
    // sits just below a light source in screen Y. Scaled by `nightReflection`
    // and the atmosphere `buildingGlowScale`/source intensity; shimmer rides the
    // slow intrinsic pulse band. Reduced-motion (`motionScale<=0`) collapses
    // `pulseValue` to its band base, leaving a static reflection column.
    _drawBuildingLightReflections(ctx, waterTiles) {
        const nightReflection = this._atmosphereReactions?.nightReflection || 0;
        if (nightReflection <= 0.05 || !waterTiles?.length || !this.buildingRenderer) return;
        const lighting = this._lastAtmosphere?.lighting || null;
        const glowScale = lighting?.lightBoost ?? this._lastAtmosphere?.grade?.buildingGlowScale ?? 1;
        const sources = (this.buildingRenderer.getLightSources?.(lighting) || [])
            .filter(s => (s.kind || 'point') === 'point' && Number.isFinite(s.x) && Number.isFinite(s.y));
        if (!sources.length) return;

        // Slow intrinsic band shimmer; static base under reduced motion.
        const shimmer = pulseValue('intrinsic', this.waterFrame, this.motionScale);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        let drawn = 0;
        for (const tile of waterTiles) {
            if (drawn >= 48) break;
            let best = null;
            let bestDist = Infinity;
            for (const source of sources) {
                const dx = tile.screenX - source.x;
                if (Math.abs(dx) > 22) continue;
                const dy = tile.screenY - source.y;
                // Reflection only reads on water below the emitter within reach.
                if (dy < 4 || dy > 96) continue;
                const dist = Math.abs(dx) + dy * 0.5;
                if (dist < bestDist) { bestDist = dist; best = { source, dx, dy }; }
            }
            if (!best) continue;
            const { source, dx, dy } = best;
            // Fade with vertical distance from the emitter and lateral offset.
            const reach = (1 - dy / 96) * (1 - Math.abs(dx) / 22);
            const intensity = Math.max(0, Math.min(1.6, source.intensity || 1));
            const alpha = Math.min(
                0.20,
                nightReflection * glowScale * intensity * reach * (0.10 + shimmer * 0.10),
            );
            if (alpha <= 0.01) continue;
            const colX = Math.round(tile.screenX - dx * 0.5);
            const top = Math.round(tile.screenY - 9);
            const bottom = Math.round(tile.screenY + 8);
            // Lateral sway tracks the same shimmer so the column wavers on water.
            const sway = (shimmer - 0.55) * 6 * (this.motionScale ? 1 : 0);
            const grad = ctx.createLinearGradient(colX, top, colX + sway, bottom);
            grad.addColorStop(0, this._withAlpha(source.color, alpha));
            grad.addColorStop(0.55, this._withAlpha(source.color, alpha * 0.6));
            grad.addColorStop(1, this._withAlpha(source.color, 0));
            ctx.fillStyle = grad;
            const halfW = 2.2 + reach * 3.4;
            ctx.beginPath();
            ctx.moveTo(colX - halfW, top);
            ctx.lineTo(colX + halfW, top);
            ctx.lineTo(colX + halfW + sway, bottom);
            ctx.lineTo(colX - halfW + sway, bottom);
            ctx.closePath();
            ctx.fill();
            drawn++;
        }
        ctx.restore();
    }

    _firstAdjacentWaterMeta(tileX, tileY) {
        const candidates = [
            [tileX, tileY - 1],
            [tileX + 1, tileY],
            [tileX, tileY + 1],
            [tileX - 1, tileY],
        ];
        for (const [x, y] of candidates) {
            const key = `${x},${y}`;
            if (this.waterTiles.has(key)) return { x, y, key, meta: this._waterMetaAt(x, y, key) };
        }
        return null;
    }

    _drawHarborWakeWaterDescriptors(ctx) {
        const descriptors = this.harborTraffic?.enumerateWakeDescriptors?.(Date.now()) || [];
        if (!descriptors.length) return;
        const roughness = this._waterWeather?.storm || 0;
        // #35 — reduced motion ships a static stern foam dab only: no diverging
        // arcs, no V bow ripple, no widening sink ring or fleck burst.
        const reduced = !(this.motionScale > 0);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const wake of descriptors.slice(0, 16)) {
            const alpha = Math.min(0.22, (wake.alpha ?? 0.12) * (1 + roughness * 0.28));
            if (alpha <= 0.01) continue;
            const token = WATER_TOKENS[wake.waterRegion] || WATER_TOKENS.harbor;
            // #35 — hull class scales every wake feature so push size reads at a
            // glance (skiff ~0.88 → flagship ~2.38).
            const hullScale = Math.max(0.85, Number(wake.wakeScale) || 1);
            if (wake.type === 'sinkRing') {
                this._drawWakeSinkRing(ctx, wake, token, alpha, hullScale, reduced);
                continue;
            }
            const dx = wake.x - (wake.tailX ?? wake.x - 1);
            const dy = wake.y - (wake.tailY ?? wake.y);
            const wakeRotation = wake.type === 'departing' ? Math.atan2(dy, dx) * 0.55 : -0.18;
            const drewWakeSprite = this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.harborWake, {
                x: wake.type === 'departing' ? wake.x - dx * 0.42 : wake.x,
                y: wake.type === 'departing' ? wake.y - dy * 0.42 + 5 : wake.y + 4,
                alpha: alpha * 0.70,
                scaleX: (wake.type === 'departing' ? 0.54 + (wake.spread || 0) * 0.24 : 0.48) * (0.7 + hullScale * 0.22),
                scaleY: wake.type === 'departing' ? 0.44 + (wake.progress || 0) * 0.18 : 0.36,
                rotation: wakeRotation,
                flipX: dx < 0,
            });
            if (drewWakeSprite) continue;
            ctx.strokeStyle = `rgba(${token.wake}, ${alpha})`;
            ctx.fillStyle = `rgba(${token.wake}, ${alpha * 0.24})`;
            ctx.lineWidth = wake.type === 'departing' ? 1.2 + hullScale * 0.5 : 1;
            if (wake.type === 'departing') {
                const len = Math.max(1, Math.hypot(dx, dy));
                const ux = dx / len;
                const uy = dy / len;
                const px = -uy;
                const py = ux;
                if (reduced) {
                    // Static stern foam dab — a single short crescent behind the bow.
                    ctx.beginPath();
                    ctx.moveTo(wake.x - ux * 8 + px * 5, wake.y - uy * 8 + py * 5);
                    ctx.quadraticCurveTo(wake.x - ux * 14, wake.y - uy * 14, wake.x - ux * 8 - px * 5, wake.y - uy * 8 - py * 5);
                    ctx.stroke();
                    continue;
                }
                // Diverging stern arcs, widened by hull class.
                const spread = (10 + (wake.spread || 0) * 18) * (0.6 + hullScale * 0.34);
                const back = 18 + (wake.progress || 0) * 22;
                ctx.beginPath();
                ctx.moveTo(wake.x - ux * 8 + px * 5, wake.y - uy * 8 + py * 5);
                ctx.quadraticCurveTo(wake.x - ux * back, wake.y - uy * back, wake.x - ux * (back + 18) + px * spread, wake.y - uy * (back + 18) + py * spread * 0.55);
                ctx.moveTo(wake.x - ux * 8 - px * 5, wake.y - uy * 8 - py * 5);
                ctx.quadraticCurveTo(wake.x - ux * back, wake.y - uy * back, wake.x - ux * (back + 18) - px * spread, wake.y - uy * (back + 18) - py * spread * 0.55);
                ctx.stroke();
                // V-shaped bow ripple thrown ahead of the bow, scaled by hull class.
                if (wake.bowRipple) {
                    const bowReach = (5 + hullScale * 6);
                    const bowSpread = (4 + hullScale * 5);
                    const bx = wake.x + ux * 6;
                    const by = wake.y + uy * 6;
                    ctx.beginPath();
                    ctx.moveTo(bx - ux * bowReach * 0.4 + px * bowSpread, by - uy * bowReach * 0.4 + py * bowSpread * 0.55);
                    ctx.lineTo(bx + ux * bowReach, by + uy * bowReach);
                    ctx.lineTo(bx - ux * bowReach * 0.4 - px * bowSpread, by - uy * bowReach * 0.4 - py * bowSpread * 0.55);
                    ctx.stroke();
                }
            } else {
                ctx.beginPath();
                ctx.ellipse(Math.round(wake.x), Math.round(wake.y + 4), wake.radiusX || 30, wake.radiusY || 13, -0.18, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // #35 — widening foam ring on a force-push sink, broader for larger hulls, plus
    // a short white-foam fleck burst (shared `wakeFoam` palette). The ring expands
    // and fades over `sinkProgress`; reduced motion collapses it to a single static
    // stern foam dab and never spawns the burst.
    _drawWakeSinkRing(ctx, wake, token, alpha, hullScale, reduced) {
        const cx = Math.round(wake.x);
        const cy = Math.round(wake.y + 4);
        if (reduced) {
            ctx.strokeStyle = `rgba(${token.wake}, ${alpha})`;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.ellipse(cx, cy, 9 * hullScale, 4.5 * hullScale, -0.18, 0, Math.PI * 2);
            ctx.stroke();
            return;
        }
        const t = Math.max(0, Math.min(1, Number(wake.sinkProgress) || 0));
        const radiusX = (10 + t * 30) * hullScale;
        const radiusY = radiusX * 0.5;
        ctx.strokeStyle = `rgba(${token.wake}, ${alpha})`;
        ctx.fillStyle = `rgba(${token.wake}, ${alpha * 0.3})`;
        ctx.lineWidth = 1.2 + hullScale * 0.6;
        ctx.beginPath();
        ctx.ellipse(cx, cy, radiusX, radiusY, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // White-foam fleck burst flung outward, widening with the ring. Throttled
        // to ~every 6th frame so the short-lived flecks read as spray, not a flood.
        if ((Math.floor(this.waterFrame) % 6) !== 0) return;
        const burst = Math.round(2 + hullScale * 2);
        this.particleSystem?.spawn?.('wakeFoam', wake.x, wake.y + 4, burst, {
            colors: WAKE_FOAM_COLORS,
            speed: [0.5, 0.6 + hullScale * 0.8],
            spread: radiusX * 0.4,
            alpha: [0.4, 0.85 * (1 - t * 0.4)],
            layer: 'effects',
        });
    }

    _drawShorelineReflectionShimmer(ctx, shoreEdges) {
        if (!shoreEdges?.length) return;
        for (const tile of shoreEdges) {
            if (tile.seed < 0.32) continue;
            const frame = this.motionScale ? this.waterFrame : 0;
            const alpha = 0.05 + Math.max(0, Math.sin(frame * 1.9 + tile.seed * 6.28)) * 0.08;
            ctx.strokeStyle = `rgba(197, 252, 236, ${alpha})`;
            ctx.lineWidth = 1;
            this._strokeInsetDiamondEdges(ctx, tile.screenX, tile.screenY, tile.edge, 9);
        }
    }

    // Animated surf wash: 2-3 staggered foam-line bands hug each shore tile's
    // water-facing edges, pulsing in/out on PulsePolicy's slow `intrinsic` band
    // (one phase-offset per band so crests stagger). Crest brightness scales
    // with `reactions.stormRoughness` so troubled fleets get heavier surf.
    // Reduced motion (`motionScale<=0`) collapses `pulseValue` to its band base,
    // so only the innermost static foam line draws (`SURF_WASH_BANDS[0]`).
    _drawSurfWashBands(ctx, shoreEdges) {
        if (!shoreEdges?.length) return;
        const stormRoughness = this._atmosphereReactions?.stormRoughness || 0;
        const reduced = !this.motionScale;
        const bands = reduced ? SURF_WASH_BANDS.slice(0, 1) : SURF_WASH_BANDS;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (let b = 0; b < bands.length; b++) {
            const band = bands[b];
            // Per-band phase offset staggers crests; slow `intrinsic` band.
            const frame = this.waterFrame + band.phase;
            const pulse = pulseValue('intrinsic', frame, this.motionScale);
            for (const tile of shoreEdges) {
                if (tile.seed < band.seedFloor) continue;
                // Phase the pulse per tile so the wash never strobes in unison.
                const tilePulse = this.motionScale
                    ? Math.max(0, Math.sin(frame * 0.04 + tile.seed * 6.28)) * pulse
                    : pulse;
                const crest = band.alpha * (0.55 + 0.45 * tilePulse) * (1 + stormRoughness * 0.9);
                const alpha = Math.min(0.34, crest);
                if (alpha <= 0.012) continue;
                ctx.strokeStyle = `rgba(232, 252, 255, ${alpha})`;
                ctx.lineWidth = band.width + stormRoughness * 0.6;
                this._strokeInsetDiamondEdges(ctx, tile.screenX, tile.screenY, tile.edge, band.inset);
            }
        }
        ctx.restore();
    }

    _drawOpenWaterDepthWash(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const openness = this._waterOpenness(x, y);
                const openSea = this._isOpenSeaTile(x, y, openness);
                if (openness < 0.42) continue;
                const isDeep = this.deepWaterTiles.has(key);
                const harbor = this._isHarborWater(x, y);
                const alpha = Math.min(
                    openSea ? 0.36 : 0.22,
                    (isDeep ? (openSea ? 0.22 : 0.12) : 0.055) * openness + (harbor ? 0.035 : 0)
                );
                ctx.fillStyle = isDeep
                    ? `rgba(0, ${openSea ? 7 : 9}, ${openSea ? 38 : 28}, ${alpha})`
                    : `rgba(4, 39, 62, ${alpha})`;
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let y = Math.max(0, startY); y <= Math.min(MAP_SIZE - 1, endY); y++) {
            for (let x = Math.max(0, startX); x <= Math.min(MAP_SIZE - 1, endX); x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key) || !this._isHarborWater(x, y)) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.fillStyle = 'rgba(87, 185, 205, 0.045)';
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    _drawStaticOpenSeaStructure(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.fillStyle = `rgba(2, ${28 + Math.floor(seed * 8)}, ${82 + Math.floor(openness * 28)}, ${0.26 + openness * 0.12})`;
                this._drawDiamond(ctx, screenX, screenY);
                ctx.fill();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'multiply';
        ctx.lineWidth = 2;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                const openSea = this._isOpenSeaTile(x, y, openness);
                const bigLagoon = !openSea && this._isBigLagoonWaterTile(x, y, openness);
                if (!openSea && !bigLagoon) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                // 2.4 — iso-diagonal wavelets baked on big water: short strokes
                // aligned to the two iso axes on a smooth anisotropic band field
                // (2.1), breaking the old horizontal banding into a woven drift.
                const band = this._smoothNoise((x - y) * 0.5 + 211, (x + y) * 0.25 + 97, 3);
                if (band < 0.55) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const drift = (seed - 0.5) * 4;
                const half = TILE_WIDTH * (0.13 + seed * 0.07);
                // Iso axis unit directions: (32, 16) and (-32, 16) normalized.
                const ux = seed > 0.5 ? 0.894 : -0.894;
                const uy = 0.447;
                ctx.strokeStyle = openSea
                    ? `rgba(0, 18, 58, ${0.07 + band * 0.07})`
                    : `rgba(3, 52, 62, ${0.06 + band * 0.06})`;
                ctx.beginPath();
                ctx.moveTo(screenX - ux * half, screenY - uy * half - 3 + drift * 0.4);
                ctx.lineTo(screenX + ux * half, screenY + uy * half - 3 + drift * 0.4);
                ctx.stroke();
            }
        }
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.globalCompositeOperation = 'screen';
        ctx.lineWidth = 1.2;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                const cap = this._tileNoise(x + 617, y + 389);
                if (cap < 0.82 || openness < 0.78) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const width = TILE_WIDTH * (0.16 + cap * 0.12);
                ctx.strokeStyle = `rgba(224, 249, 255, ${0.12 + seed * 0.10})`;
                ctx.beginPath();
                ctx.moveTo(screenX - width, screenY - 10 + seed * 3);
                ctx.quadraticCurveTo(screenX, screenY - 14, screenX + width, screenY - 11 - seed * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // 2.3 — one-mass deep-sea gradient: a single baked radial multiply over the
    // whole sea basin, clipped to the sea tiles, so the open water reads as one
    // body deepening toward its middle instead of a grid of per-tile washes.
    _drawOpenSeaBasinGradient(ctx) {
        if (!this.waterTiles?.size) return;
        const seaTiles = [];
        let sumX = 0;
        let sumY = 0;
        for (const key of this.waterTiles) {
            if (this.bridgeTiles?.has(key)) continue;
            const comma = key.indexOf(',');
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            const region = this._waterRegionAt(x, y, key);
            if (region !== 'sea' && region !== 'openSea') continue;
            const screenX = (x - y) * TILE_WIDTH / 2;
            const screenY = (x + y) * TILE_HEIGHT / 2;
            seaTiles.push({ screenX, screenY });
            sumX += screenX;
            sumY += screenY;
        }
        if (seaTiles.length < 8) return;
        const cx = sumX / seaTiles.length;
        const cy = sumY / seaTiles.length;
        let radius = 0;
        for (const tile of seaTiles) {
            radius = Math.max(radius, Math.hypot(tile.screenX - cx, tile.screenY - cy));
        }
        if (radius <= 0) return;
        radius += TILE_WIDTH * 0.75;

        ctx.save();
        ctx.beginPath();
        for (const tile of seaTiles) {
            ctx.moveTo(tile.screenX, tile.screenY - TILE_HEIGHT / 2);
            ctx.lineTo(tile.screenX + TILE_WIDTH / 2, tile.screenY);
            ctx.lineTo(tile.screenX, tile.screenY + TILE_HEIGHT / 2);
            ctx.lineTo(tile.screenX - TILE_WIDTH / 2, tile.screenY);
            ctx.closePath();
        }
        ctx.clip();
        ctx.globalCompositeOperation = 'multiply';
        const gradient = ctx.createRadialGradient(cx, cy, radius * 0.12, cx, cy, radius);
        gradient.addColorStop(0, 'rgb(148, 172, 208)');
        gradient.addColorStop(0.55, 'rgb(198, 216, 234)');
        gradient.addColorStop(1, 'rgb(255, 255, 255)');
        ctx.fillStyle = gradient;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.restore();
    }

    _drawOpenSeaSurfBreaks(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.5;
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const openness = this._waterOpenness(x, y);
                if (!this._isOpenSeaTile(x, y, openness)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                if (seed < 0.18) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = `rgba(229, 253, 255, ${0.18 + seed * 0.14})`;
                this._strokeInsetDiamondEdges(ctx, screenX, screenY, edge, 5 + seed * 5);
            }
        }
        ctx.restore();
    }

    _drawAnimatedCurrentBands(ctx, waterTiles) {
        if (!waterTiles?.length) return;
        const slideRange = 0.35 * TILE_HEIGHT;
        const roughness = this._waterWeather?.storm || 0;
        const warm = this._atmosphereReactions?.warmGlint || 0;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (const tile of waterTiles) {
            if (!tile.animatedCurrentEligible) continue;
            if (roughness > 0.65 && (tile.x + tile.y) % 2 !== 0) continue;
            const primary = Math.sin(this.waterFrame * 0.82 + tile.x * 0.42 - tile.y * 0.28 + tile.seed * 2.6);
            const secondary = Math.sin(this.waterFrame * 1.17 - tile.x * 0.24 - tile.y * 0.36 + tile.seed * 5.1);
            const crest = ((primary * 0.72 + secondary * 0.28) + 1) / 2;
            const threshold = (tile.isOpenSea ? 0.73 : 0.76) - roughness * (tile.isOpenSea ? 0.10 : tile.isHarbor ? 0.055 : 0.075);
            if (crest < threshold) continue;
            // Slide the crest across the tile interior so it reads as travelling,
            // and taper alpha as the stroke nears the diamond edge.
            const slide = primary * slideRange;
            const edgeTaper = 1 - Math.abs(primary) * 0.28;
            const crestStrength = (crest - threshold) / Math.max(0.001, 1 - threshold);
            const anchorX = tile.screenX + CURRENT_WAVE_UNIT_X * slide;
            const anchorY = tile.screenY + CURRENT_WAVE_UNIT_Y * slide;
            const alpha = Math.min(
                tile.isOpenSea ? 0.24 + roughness * 0.08 : 0.16 + roughness * 0.04,
                (crest - threshold) * (tile.isDeep ? (tile.isOpenSea ? 0.62 : 0.48) : 0.32) * (0.62 + tile.openness * 0.5) * (1 + roughness * 0.35) * edgeTaper
            );
            const drift = Math.sin(this.waterFrame * 0.45 + tile.seed * 6.28) * 2;
            const glintColor = warm > 0.18 ? '255, 210, 136' : tile.token.glint;
            ctx.strokeStyle = `rgba(${glintColor}, ${alpha})`;
            const baseWidth = tile.isOpenSea ? 1.7 + roughness * 0.6 : (tile.isDeep ? 1.4 : 1);
            ctx.lineWidth = baseWidth * (1 + crestStrength * 0.6);
            ctx.beginPath();
            ctx.moveTo(anchorX - TILE_WIDTH * (tile.isOpenSea ? 0.48 : 0.40), anchorY - 2 + drift);
            ctx.quadraticCurveTo(
                anchorX - TILE_WIDTH * 0.02,
                anchorY - (tile.isOpenSea ? 10 : 8) + drift * 0.35,
                anchorX + TILE_WIDTH * (tile.isOpenSea ? 0.48 : 0.40),
                anchorY - 5 - drift * 0.25
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    // B1 — directional river flow. Each flowing river/current tile drifts 1–2
    // short elongated highlights along its downstream unit vector; the along-flow
    // offset wraps every cycle and a sine window fades each streak in/out at the
    // wrap so nothing pops. Reduced motion draws one static streak at mid-tile.
    _drawRiverFlowStreaks(ctx, waterTiles) {
        if (!waterTiles?.length) return;
        const reduced = !this.motionScale;
        const warm = this._atmosphereReactions?.warmGlint || 0;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (const tile of waterTiles) {
            if (!tile.isCurrent) continue;
            const fx = tile.flowDirX;
            const fy = tile.flowDirY;
            if (fx === 0 && fy === 0) continue;
            const ux = tile.flowUnitX;
            const uy = tile.flowUnitY;
            const px = tile.flowPerpendicularX;
            const py = tile.flowPerpendicularY;
            const span = tile.riverSpan;
            const half = tile.riverHalfLength;
            const glint = warm > 0.15 ? '255, 214, 150' : tile.token.glint;
            const lanes = reduced ? 1 : 2;
            for (let l = 0; l < lanes; l++) {
                const laneSeed = tile.riverLaneSeeds[l];
                const frac = reduced
                    ? 0.5
                    : ((this.waterFrame * RIVER_FLOW_SPEED + laneSeed) % 1 + 1) % 1;
                const laneOff = (lanes === 1 ? 0 : (l === 0 ? -0.2 : 0.2)) * TILE_WIDTH * 0.5;
                const win = reduced ? 0.7 : Math.sin(Math.PI * frac);
                const alpha = Math.min(0.15, (0.05 + tile.openness * 0.05) * win);
                if (alpha <= 0.012) continue;
                const cx = tile.screenX + ux * (frac - 0.5) * span + px * laneOff;
                const cy = tile.screenY - 3 + uy * (frac - 0.5) * span + py * laneOff;
                ctx.strokeStyle = `rgba(${glint}, ${alpha})`;
                ctx.lineWidth = 1.1;
                ctx.beginPath();
                ctx.moveTo(cx - ux * half, cy - uy * half);
                ctx.lineTo(cx + ux * half, cy + uy * half);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // B3 — sun/moon glitter field. Sparse deterministic sub-tile sparkles on
    // open water: warm-white by day (scaled by the midday `dayGlitter` reaction),
    // pale blue at night (scaled by `nightReflection`). Sharp `sin^3` twinkle,
    // `screen` composite. Reduced motion drops to one steady speck per tile.
    _drawSeaGlitter(ctx, waterTiles) {
        if (!waterTiles?.length) return;
        const dayGlitter = this._atmosphereReactions?.dayGlitter || 0;
        const nightReflection = this._atmosphereReactions?.nightReflection || 0;
        if (dayGlitter <= 0.04 && nightReflection <= 0.08) return;
        const isDay = dayGlitter >= nightReflection;
        const color = isDay ? '255, 246, 214' : '196, 224, 255';
        const scale = isDay ? dayGlitter : nightReflection;
        const reduced = !this.motionScale;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const tile of waterTiles) {
            if (tile.openness <= 0.5) continue;
            const specks = tile.glitterSpecks || [];
            const count = reduced ? Math.min(1, specks.length) : specks.length;
            for (let i = 0; i < count; i++) {
                const speck = specks[i];
                const twinkle = reduced
                    ? 0.5
                    : Math.max(0, Math.sin(this.waterFrame * speck.rate + speck.phase)) ** 3;
                const alpha = Math.min(0.5, scale * speck.alphaScale * twinkle);
                if (alpha <= 0.02) continue;
                ctx.fillStyle = `rgba(${color}, ${alpha})`;
                ctx.fillRect(
                    Math.round(tile.screenX + speck.offsetX),
                    Math.round(tile.screenY + speck.offsetY),
                    speck.size,
                    speck.size,
                );
            }
        }
        ctx.restore();
    }

    _drawTile(ctx, tileX, tileY) {
        const screenX = (tileX - tileY) * TILE_WIDTH / 2;
        const screenY = (tileX + tileY) * TILE_HEIGHT / 2;
        const key = `${tileX},${tileY}`;
        const seed = this.terrainSeed[tileY * MAP_SIZE + tileX] || 0;

        if (this.terrain) {
            const sheetId = this._terrainSheetIdAt(tileX, tileY);
            this.terrain.drawTile(ctx, sheetId, tileX, tileY,
                (tx, ty) => this._sameTerrainClass(tileX, tileY, tx, ty));
        } else {
            // Fallback: solid diamond (no-assets defensive path).
            ctx.fillStyle = '#33403c';
            ctx.beginPath();
            ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
            ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
            ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
            ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
            ctx.closePath();
            ctx.fill();
        }

        this._drawTerrainTone(ctx, screenX, screenY, key, seed, tileX, tileY);
        this._drawGroundDecals(ctx, screenX, screenY, key, tileX, tileY);

        if (!this.bridgeTiles?.has(key)) {
            if (this.commandCenterRoadTiles.has(key) && this.pathTiles.has(key)) {
                this._drawCommandApproachRoadDetail(ctx, screenX, screenY, seed, tileX, tileY);
            } else if (!this.waterTiles.has(key)) {
                if (this.bushTiles?.has(key)) {
                    const bInfo = this.bushTiles.get(key);
                    const bushId = ['veg.bush.a', 'veg.bush.b', 'veg.bush.c'][(bInfo?.variant ?? 0) % 3];
                    if (this.sprites) this.sprites.drawSprite(ctx, bushId, screenX, screenY);
                }
                if (this.grassTuftTiles?.has(key)) {
                    const gInfo = this.grassTuftTiles.get(key);
                    const tuftId = ['veg.grassTuft.a', 'veg.grassTuft.b'][(gInfo?.variant ?? 0) % 2];
                    if (this.sprites) this.sprites.drawSprite(ctx, tuftId, screenX, screenY);
                }
                if (this.flowerTiles?.has(key)) {
                    const fInfo = this.flowerTiles.get(key);
                    const flowerId = ['veg.flower.a', 'veg.flower.b', 'veg.flower.c'][(fInfo?.variant ?? 0) % 3];
                    if (this.sprites) this.sprites.drawSprite(ctx, flowerId, screenX, screenY);
                }
                const feature = this.featureTiles?.get(key);
                if (feature === 'reeds') {
                    const reedId = seed > 0.58 ? 'veg.reed.a' : 'veg.reed.b';
                    if (this.sprites) this.sprites.drawSprite(ctx, reedId, screenX, screenY);
                } else if (feature === 'stones') {
                    this._drawFeatureStones(ctx, screenX, screenY, tileX, tileY);
                } else if (feature === 'mushrooms') {
                    this._drawFeatureMushrooms(ctx, screenX, screenY, tileX, tileY);
                }
            }
        }

        if (!this.pathTiles.has(key) && this.commandCenterRoadTiles.has(key) && !this.waterTiles.has(key)) {
            this._drawCommandGuardpost(ctx, screenX + (seed - 0.5) * 3, screenY + (seed - 0.5) * 2);
        }

        // Water shimmer / bridge deck
        if (this.bridgeTiles?.has(key)) {
            const bInfo = this.bridgeTiles.get(key);
            const isDoc = bInfo?.kind === 'dock';
            if (isDoc) {
                if (bInfo?.style === 'causeway') {
                    this._drawHarborCausewayTile(ctx, screenX, screenY, bInfo.orientation || 'EW', seed);
                } else {
                    const orientation = (bInfo?.orientation || 'EW').toLowerCase();
                    if (this.sprites) this.sprites.drawSprite(ctx, `dock.${orientation}`, screenX, screenY);
                }
            } else if (bInfo?.kind === 'plank') {
                // 2.8 — single-file plank crossings use the per-tile bridge.ew/ns
                // assets, mirroring the dock tile path.
                const orientation = (bInfo?.orientation || 'EW').toLowerCase();
                if (this.sprites) this.sprites.drawSprite(ctx, `bridge.${orientation}`, screenX, screenY);
            }
        } else if (this.waterTiles.has(key) && !this.terrain) {
            const shimmer = this.motionScale ? Math.sin(this.waterFrame * 2 + tileX * 0.5 + tileY * 0.3) * 0.055 + 0.055 : STATIC_WATER_SHIMMER;
            ctx.fillStyle = `rgba(185, 229, 224, ${shimmer})`;
            ctx.fill();
        }
    }

    // Procedural ground micro-detail baked into the terrain cache: pebble/soil
    // flecks on grass, moss in cobble joints, leaf litter under the northern
    // canopy, and worn dirt where grass meets a road. Deterministic — no motion,
    // no per-frame cost. Breaks up the flat terrain diamonds between buildings.
    _drawGroundDecals(ctx, screenX, screenY, key, tileX, tileY) {
        if (this.waterTiles?.has(key)) return;
        if (this.bridgeTiles?.has(key)) return;
        const isPath = this.pathTiles?.has(key);
        const isRoad = isPath || this.commandCenterRoadTiles?.has(key);

        // Place a speck inside the iso diamond; returns null if it would spill out.
        const place = (salt, spanX, spanY) => {
            const u = this._decalRand(tileX, tileY, salt);
            const v = this._decalRand(tileX, tileY, salt + 911);
            const ox = (u - 0.5) * spanX;
            const oy = (v - 0.5) * spanY;
            if (Math.abs(ox) / 30 + Math.abs(oy) / 14 > 0.92) return null;
            return { ox: Math.round(screenX + ox), oy: Math.round(screenY + oy) };
        };

        ctx.save();
        if (isRoad) {
            // Moss creeping into cobble/flagstone joints.
            const mossCount = this._decalRand(tileX, tileY, 17) > 0.55 ? 2 : 1;
            ctx.fillStyle = 'rgba(86, 120, 52, 0.26)';
            for (let i = 0; i < mossCount; i++) {
                const p = place(31 + i * 7, 46, 22);
                if (p) ctx.fillRect(p.ox, p.oy, 2, 1);
            }

            // 2.7 — road verges and corner wear. Grass tufts encroach where a
            // road tile borders open ground; corners and ends (no straight
            // through-axis) pick up extra center wear.
            const isRoadKey = (k) => this.pathTiles?.has(k) || this.commandCenterRoadTiles?.has(k);
            const straight = (isRoadKey(`${tileX + 1},${tileY}`) && isRoadKey(`${tileX - 1},${tileY}`))
                || (isRoadKey(`${tileX},${tileY + 1}`) && isRoadKey(`${tileX},${tileY - 1}`));
            if (!straight) {
                ctx.fillStyle = 'rgba(94, 72, 44, 0.12)';
                ctx.beginPath();
                ctx.ellipse(Math.round(screenX), Math.round(screenY + 1), 11, 5, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (isRoadKey(`${tileX + dx},${tileY + dy}`)) continue;
                const count = this._decalRand(tileX, tileY, 501 + (dx + 2) * 3 + (dy + 2) * 7) > 0.45 ? 2 : 1;
                ctx.fillStyle = 'rgba(76, 106, 44, 0.30)';
                for (let i = 0; i < count; i++) {
                    const u = this._decalRand(tileX, tileY, 511 + i * 5 + (dx + 2) * 17 + (dy + 2) * 29);
                    const v = this._decalRand(tileX, tileY, 523 + i * 7 + (dx + 2) * 31 + (dy + 2) * 13);
                    const ox = dx * (14 + u * 9) + (dy !== 0 ? (u - 0.5) * 22 : 0);
                    const oy = dy * (6 + v * 5) + (dx !== 0 ? (v - 0.5) * 10 : 0);
                    if (Math.abs(ox) / 30 + Math.abs(oy) / 14 > 0.92) continue;
                    ctx.fillRect(Math.round(screenX + ox), Math.round(screenY + oy), 2, 1);
                }
            }
        } else {
            // Season drives which flecks/litter/blooms bake into the grass. The
            // token only flips on season boundaries, so this stays a rebake, not
            // a per-frame cost. Summer keeps the original look.
            const season = this._terrainSeason || 'summer';

            // Land grass/dirt: pebble + tonal flecks so each diamond varies.
            const fleckNoise = this._decalRand(tileX, tileY, 3);
            const fleckCount = fleckNoise > 0.72 ? 4 : fleckNoise > 0.4 ? 3 : 2;
            for (let i = 0; i < fleckCount; i++) {
                const p = place(40 + i * 13, 48, 24);
                if (!p) continue;
                const tone = this._decalRand(tileX, tileY, 200 + i);
                if (season === 'winter' && tone > 0.5) {
                    // Pale snow flecks settling over the grass.
                    ctx.fillStyle = tone > 0.78
                        ? 'rgba(232, 242, 252, 0.34)'
                        : 'rgba(206, 222, 238, 0.24)';
                } else {
                    ctx.fillStyle = tone > 0.66
                        ? 'rgba(150, 152, 120, 0.20)'   // light pebble
                        : tone > 0.33
                            ? 'rgba(44, 40, 30, 0.24)'  // dark soil pebble
                            : 'rgba(58, 84, 30, 0.20)'; // deep grass fleck
                }
                ctx.fillRect(p.ox, p.oy, tone > 0.85 ? 2 : 1, 1);
            }

            // Leaf litter under the northern canopy — autumn spreads it across
            // the whole map and lays it down more often, thickened with a second
            // flake; other seasons keep it to the northern treeline.
            const litterEverywhere = season === 'autumn';
            const litterThreshold = litterEverywhere ? 0.42 : 0.62;
            if ((litterEverywhere || tileY <= 14) && this._decalRand(tileX, tileY, 71) > litterThreshold) {
                ctx.fillStyle = this._decalRand(tileX, tileY, 72) > 0.5
                    ? 'rgba(156, 112, 48, 0.22)'
                    : 'rgba(116, 82, 40, 0.20)';
                const p = place(73, 44, 22);
                if (p) {
                    ctx.fillRect(p.ox, p.oy, 2, 1);
                    if (litterEverywhere && this._decalRand(tileX, tileY, 74) > 0.5) {
                        const p2 = place(75, 46, 22);
                        if (p2) ctx.fillRect(p2.ox, p2.oy, 1, 1);
                    }
                }
            }

            // Wildflower dabs — tiny color pops scattered through the grass.
            // Spring blooms harder with a blossom-forward palette; winter keeps
            // only a few frost-muted survivors.
            const wildflowerThreshold = season === 'spring' ? 0.70
                : season === 'winter' ? 0.93
                : 0.84;
            if (this._decalRand(tileX, tileY, 90) > wildflowerThreshold) {
                const fc = this._decalRand(tileX, tileY, 91);
                if (season === 'winter') {
                    ctx.fillStyle = fc > 0.6
                        ? 'rgba(214, 220, 228, 0.72)'
                        : 'rgba(198, 186, 214, 0.66)';
                } else if (season === 'spring') {
                    ctx.fillStyle = fc > 0.66 ? 'rgba(248, 206, 224, 0.90)'   // blossom pink
                        : fc > 0.33 ? 'rgba(240, 242, 246, 0.88)'             // white petal
                        : 'rgba(246, 234, 122, 0.90)';                        // buttercup yellow
                } else {
                    ctx.fillStyle = fc > 0.75 ? 'rgba(246, 234, 122, 0.90)'   // buttercup yellow
                        : fc > 0.50 ? 'rgba(238, 240, 244, 0.88)'             // white daisy
                        : fc > 0.25 ? 'rgba(228, 150, 198, 0.84)'             // pink clover
                        : 'rgba(178, 150, 228, 0.84)';                        // violet
                }
                const p = place(92, 42, 20);
                if (p) {
                    ctx.fillRect(p.ox, p.oy, 1, 1);
                    if (fc > 0.60) ctx.fillRect(p.ox + 1, p.oy, 1, 1);
                    if (fc > 0.90) ctx.fillRect(p.ox, p.oy - 1, 1, 1);
                    // Spring adds an extra blossom dab for fuller bloom.
                    if (season === 'spring' && fc > 0.4) {
                        const pb = place(93, 40, 20);
                        if (pb) ctx.fillRect(pb.ox, pb.oy, 1, 1);
                    }
                }
            }

            // Worn dirt where grass meets a road (threshold wear).
            if (this._neighborsRoad(tileX, tileY)) {
                ctx.fillStyle = 'rgba(120, 95, 60, 0.15)';
                ctx.beginPath();
                ctx.ellipse(Math.round(screenX), Math.round(screenY + 2), 13, 6, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    // C5 — pebble clusters on 'stones' feature tiles. 3-4 small grey rects with
    // a highlight pixel, styled like the ground flecks. Baked into the terrain
    // cache; deterministic via the per-tile decal seed.
    _drawFeatureStones(ctx, screenX, screenY, tileX, tileY) {
        const count = this._decalRand(tileX, tileY, 301) > 0.5 ? 4 : 3;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const u = this._decalRand(tileX, tileY, 310 + i * 3);
            const v = this._decalRand(tileX, tileY, 311 + i * 3);
            const ox = Math.round(screenX + (u - 0.5) * 26);
            const oy = Math.round(screenY + (v - 0.5) * 12);
            const w = this._decalRand(tileX, tileY, 312 + i * 3) > 0.6 ? 2 : 1;
            ctx.fillStyle = 'rgba(118, 120, 116, 0.85)';   // stone body
            ctx.fillRect(ox, oy, w, 1);
            ctx.fillStyle = 'rgba(150, 152, 148, 0.90)';   // top highlight
            ctx.fillRect(ox, oy - 1, 1, 1);
            ctx.fillStyle = 'rgba(66, 68, 66, 0.60)';      // grounding shadow
            ctx.fillRect(ox, oy + 1, w, 1);
        }
        ctx.restore();
    }

    // C5 — tiny mushrooms on 'mushrooms' feature tiles: stem + red/tan cap, with
    // a faint cyan glow dot under the northern canopy (tileY <= 14). Baked;
    // deterministic via the per-tile decal seed.
    _drawFeatureMushrooms(ctx, screenX, screenY, tileX, tileY) {
        const count = this._decalRand(tileX, tileY, 401) > 0.55 ? 3 : 2;
        const underCanopy = tileY <= 14;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const u = this._decalRand(tileX, tileY, 410 + i * 4);
            const v = this._decalRand(tileX, tileY, 411 + i * 4);
            const ox = Math.round(screenX + (u - 0.5) * 22);
            const oy = Math.round(screenY + (v - 0.5) * 10);
            ctx.fillStyle = 'rgba(226, 214, 190, 0.90)';   // stem
            ctx.fillRect(ox, oy, 1, 2);
            const red = this._decalRand(tileX, tileY, 412 + i * 4) > 0.5;
            ctx.fillStyle = red ? 'rgba(178, 58, 46, 0.92)' : 'rgba(180, 138, 92, 0.90)'; // cap
            ctx.fillRect(ox - 1, oy - 1, 3, 1);
            if (red) {
                ctx.fillStyle = 'rgba(238, 224, 210, 0.85)'; // cap fleck
                ctx.fillRect(ox, oy - 1, 1, 1);
            }
            if (underCanopy) {
                ctx.fillStyle = 'rgba(150, 243, 255, 0.50)'; // faint bioluminescent glow
                ctx.fillRect(ox, oy - 2, 1, 1);
            }
        }
        ctx.restore();
    }

    // Deterministic per-tile, per-salt value in [0,1) for decal placement.
    _decalRand(tileX, tileY, salt) {
        let h = (Math.imul(tileX | 0, 73856093) ^ Math.imul(tileY | 0, 19349663) ^ Math.imul(salt | 0, 83492791)) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    _neighborsRoad(tileX, tileY) {
        const p = this.pathTiles;
        if (!p) return false;
        return p.has(`${tileX + 1},${tileY}`)
            || p.has(`${tileX - 1},${tileY}`)
            || p.has(`${tileX},${tileY + 1}`)
            || p.has(`${tileX},${tileY - 1}`);
    }

    _drawHarborCausewayTile(ctx, screenX, screenY, orientation = 'EW', seed = 0) {
        const halfW = TILE_WIDTH * 0.50;
        const halfH = TILE_HEIGHT * 0.35;
        const lift = 2;
        ctx.save();
        ctx.translate(screenX, screenY - lift);

        ctx.globalAlpha = 0.78;
        ctx.fillStyle = 'rgba(29, 20, 14, 0.52)';
        ctx.beginPath();
        ctx.moveTo(0, -halfH + 4);
        ctx.lineTo(halfW + 5, 2);
        ctx.lineTo(0, halfH + 7);
        ctx.lineTo(-halfW - 5, 2);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 0.98;
        ctx.fillStyle = '#aa8859';
        ctx.strokeStyle = '#2b1b12';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, -halfH);
        ctx.lineTo(halfW, 0);
        ctx.lineTo(0, halfH);
        ctx.lineTo(-halfW, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#e0c488';
        ctx.lineWidth = 1;
        const cross = orientation === 'NS'
            ? [[-17, -8, 15, 8], [-10, -13, 22, 3], [-22, -2, 10, 14]]
            : [[-19, 6, 13, -10], [-9, 12, 23, -4], [-24, -2, 7, -16]];
        for (const [x1, y1, x2, y2] of cross) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.48;
        ctx.strokeStyle = '#5f3d22';
        ctx.lineWidth = 1.2;
        for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(-halfW + 8, side * 2);
            ctx.lineTo(halfW - 8, side * -2);
            ctx.stroke();
        }

        ctx.globalAlpha = 0.86;
        ctx.strokeStyle = '#46311f';
        ctx.lineWidth = 1.2;
        for (const side of [-1, 1]) {
            const bob = this.motionScale ? Math.sin(this.waterFrame * 1.8 + seed * 8 + side) * 0.5 : 0;
            ctx.beginPath();
            ctx.moveTo(side * (halfW - 4), -1 + bob);
            ctx.lineTo(side * (halfW - 7), -14 + bob);
            ctx.stroke();
        }

        ctx.restore();
    }

    _buildBridgeSpans() {
        if (!this.bridgeTiles?.size) return [];

        const spans = [];
        const visited = new Set();
        const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const isBridgeDeck = (key, bridgeInfo) => {
            const info = this.bridgeTiles.get(key);
            return info?.kind === 'landmark'
                && info.orientation === bridgeInfo.orientation
                && (info.bridgeId || null) === (bridgeInfo.bridgeId || null);
        };

        for (const [key, info] of this.bridgeTiles.entries()) {
            if (visited.has(key) || info?.kind !== 'landmark') continue;

            const orientation = info?.orientation || 'EW';
            const queue = [key];
            const tiles = [];
            visited.add(key);

            while (queue.length) {
                const current = queue.shift();
                const comma = current.indexOf(',');
                const x = Number(current.slice(0, comma));
                const y = Number(current.slice(comma + 1));
                tiles.push({ x, y });

                for (const [dx, dy] of directions) {
                    const next = `${x + dx},${y + dy}`;
                    if (visited.has(next) || !isBridgeDeck(next, info)) continue;
                    visited.add(next);
                    queue.push(next);
                }
            }

            if (tiles.length) {
                spans.push(this._bridgeSpanFromTiles(tiles, orientation, info));
            }
        }

        return spans.sort((a, b) => a.depth - b.depth);
    }

    _bridgeSpanFromTiles(tiles, orientation, info = {}) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        for (const tile of tiles) {
            minX = Math.min(minX, tile.x);
            maxX = Math.max(maxX, tile.x);
            minY = Math.min(minY, tile.y);
            maxY = Math.max(maxY, tile.y);
        }

        const isEastWest = orientation === 'EW';
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const startTile = isEastWest
            ? { x: minX - 0.45, y: centerY }
            : { x: centerX, y: minY - 0.45 };
        const endTile = isEastWest
            ? { x: maxX + 0.45, y: centerY }
            : { x: centerX, y: maxY + 0.45 };
        const axisVector = isEastWest
            ? { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 }
            : { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };
        const crossVector = isEastWest
            ? { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 }
            : { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };
        const crossLength = Math.hypot(crossVector.x, crossVector.y) || 1;
        const axisLength = Math.hypot(axisVector.x, axisVector.y) || 1;
        const lengthTiles = isEastWest ? maxX - minX + 1 : maxY - minY + 1;
        const crossTiles = isEastWest ? maxY - minY + 1 : maxX - minX + 1;

        return {
            id: info.bridgeId || null,
            style: info.style || 'civic',
            orientation,
            start: this._tileToScreen(startTile.x, startTile.y),
            end: this._tileToScreen(endTile.x, endTile.y),
            axisUnit: { x: axisVector.x / axisLength, y: axisVector.y / axisLength },
            crossUnit: { x: crossVector.x / crossLength, y: crossVector.y / crossLength },
            halfWidth: Math.max(34, Math.min(54, 24 + crossTiles * 8)),
            deckRise: info.deckRise || 0,
            nearRail: info.nearRail || null,
            lengthTiles,
            depth: (centerX + centerY) * TILE_HEIGHT / 2,
        };
    }

    _tileToScreen(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _drawLandmarkBridgeSpans(ctx) {
        if (!this.bridgeSpans?.length) return;

        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        for (const span of this.bridgeSpans) {
            this._drawLandmarkBridgeSpan(ctx, span);
        }
        ctx.restore();
    }

    _bridgePoint(span, t, crossOffset = 0, verticalLift = 0, drop = 0) {
        const arch = Math.sin(Math.PI * t);
        const x = span.start.x + (span.end.x - span.start.x) * t + span.crossUnit.x * crossOffset;
        const y = span.start.y + (span.end.y - span.start.y) * t + span.crossUnit.y * crossOffset - arch * span.deckRise - verticalLift + drop;
        return { x, y };
    }

    getBridgeLift(tileX, tileY) {
        if (!this.bridgeSpans?.length) return 0;
        const point = this._tileToScreen(tileX, tileY);
        for (const span of this.bridgeSpans) {
            const dx = point.x - span.start.x;
            const dy = point.y - span.start.y;
            const axisLength = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) || 1;
            const along = dx * span.axisUnit.x + dy * span.axisUnit.y;
            const cross = dx * span.crossUnit.x + dy * span.crossUnit.y;
            if (along < 0 || along > axisLength || Math.abs(cross) > span.halfWidth) continue;
            return Math.sin(Math.PI * along / axisLength) * span.deckRise;
        }
        return 0;
    }

    _isInBridgeTreeExclusion(tileX, tileY) {
        if (!this.bridgeSpans?.length) return false;
        const p = this._tileToScreen(tileX, tileY);
        for (const span of this.bridgeSpans) {
            const dx = p.x - span.start.x;
            const dy = p.y - span.start.y;
            const axisLength = Math.hypot(span.end.x - span.start.x, span.end.y - span.start.y) || 1;
            const along = dx * span.axisUnit.x + dy * span.axisUnit.y;
            const cross = Math.abs(dx * span.crossUnit.x + dy * span.crossUnit.y);
            const rampPad = 40;
            const crossPad = span.halfWidth + 8;
            if (along >= -rampPad && along <= axisLength + rampPad && cross <= crossPad) {
                return true;
            }
        }
        return false;
    }

    _bridgeSidePoints(span, crossOffset, verticalLift = 0, drop = 0, steps = 14) {
        const points = [];
        for (let i = 0; i <= steps; i++) {
            points.push(this._bridgePoint(span, i / steps, crossOffset, verticalLift, drop));
        }
        return points;
    }

    _traceBridgeRibbon(ctx, leftPoints, rightPoints) {
        ctx.beginPath();
        ctx.moveTo(leftPoints[0].x, leftPoints[0].y);
        for (let i = 1; i < leftPoints.length; i++) ctx.lineTo(leftPoints[i].x, leftPoints[i].y);
        for (let i = rightPoints.length - 1; i >= 0; i--) ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
        ctx.closePath();
    }

    // Bridge/water contact: a tight multiply shadow pooling under the deck.
    // Baked with the span; no motion.
    _drawBridgeUnderDeckWaterShadow(ctx, span) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        this._traceBridgeRibbon(
            ctx,
            this._bridgeSidePoints(span, -span.halfWidth - 2, 0, 20, 10),
            this._bridgeSidePoints(span, span.halfWidth + 2, 0, 20, 10)
        );
        ctx.fillStyle = 'rgba(52, 74, 86, 0.42)';
        ctx.fill();
        ctx.restore();
    }

    _bridgeSpriteId(span) {
        const orientation = (span.orientation || 'EW').toLowerCase();
        const style = span.style || 'civic';
        return `bridge.landmark.${style}.${orientation}`;
    }

    _bridgeSpritePlacement(span) {
        if (!this.assets) return null;
        const spriteId = this._bridgeSpriteId(span);
        if (this.assets.has && !this.assets.has(spriteId)) return null;
        const img = this.assets.get(spriteId);
        const dims = this.assets.getDims(spriteId);
        if (!img || !dims) return null;
        const [anchorX, anchorY] = this.assets.getAnchor(spriteId);
        const midX = (span.start.x + span.end.x) / 2;
        const midY = (span.start.y + span.end.y) / 2;
        return {
            img,
            dims,
            x: Math.round(midX - anchorX),
            y: Math.round(midY - anchorY),
        };
    }

    _drawLandmarkBridgeSpan(ctx, span) {
        this._drawBridgeUnderDeckWaterShadow(ctx, span);
        const placement = this._bridgeSpritePlacement(span);
        if (!placement) return;
        ctx.drawImage(
            placement.img,
            placement.x,
            placement.y,
            placement.dims.w,
            placement.dims.h
        );
    }

    _worldDiamondPoints() {
        const last = MAP_SIZE - 1;
        return [
            { x: 0, y: -WORLD_EDGE_PAD_Y },
            { x: last * TILE_WIDTH / 2 + WORLD_EDGE_PAD_X, y: last * TILE_HEIGHT / 2 },
            { x: 0, y: last * TILE_HEIGHT + WORLD_EDGE_PAD_Y },
            { x: -last * TILE_WIDTH / 2 - WORLD_EDGE_PAD_X, y: last * TILE_HEIGHT / 2 },
        ];
    }

    _drawWorldBaseShadow(ctx) {
        const points = this._worldDiamondPoints();
        ctx.save();
        ctx.translate(0, 34);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.46)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
        ctx.shadowBlur = 48;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.fill();

        ctx.translate(0, 18);
        ctx.fillStyle = 'rgba(30, 17, 9, 0.22)';
        ctx.shadowColor = 'rgba(83, 50, 18, 0.28)';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawWorldEdgeRim(ctx) {
        const points = this._worldDiamondPoints();
        ctx.save();
        const sideGradient = ctx.createLinearGradient(0, points[0].y, 0, points[2].y + 44);
        sideGradient.addColorStop(0, 'rgba(87, 62, 31, 0.10)');
        sideGradient.addColorStop(0.55, 'rgba(44, 28, 16, 0.34)');
        sideGradient.addColorStop(1, 'rgba(13, 9, 7, 0.62)');
        ctx.fillStyle = sideGradient;
        ctx.beginPath();
        ctx.moveTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.lineTo(points[2].x, points[2].y + 38);
        ctx.lineTo(points[1].x - 26, points[1].y + 24);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(points[2].x, points[2].y);
        ctx.lineTo(points[3].x, points[3].y);
        ctx.lineTo(points[3].x + 26, points[3].y + 24);
        ctx.lineTo(points[2].x, points[2].y + 38);
        ctx.closePath();
        ctx.fill();

        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(238, 191, 94, 0.24)';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.stroke();

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.52)';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y + 2);
        ctx.lineTo(points[1].x - 2, points[1].y + 1);
        ctx.lineTo(points[2].x, points[2].y - 1);
        ctx.lineTo(points[3].x + 2, points[3].y + 1);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    // #25 — baked sand/cliff shelf along the two lower-facing diamond edges
    // (SE and SW). Turns the hard void cut into a sunlit sand strip dropping
    // into a shaded cliff face, so the island reads as resting on a coastline
    // rather than being sliced off. Baked into the terrain cache — zero
    // per-frame cost, and static by construction (reduced-motion safe).
    _bakePerimeterCliffShelf(ctx) {
        const points = this._worldDiamondPoints();
        const east = points[1];
        const south = points[2];
        const west = points[3];
        const sandH = 16;   // sunlit beach lip
        const cliffH = 46;   // shaded face dropping to the void
        const phase = this._lastAtmosphere?.phase || 'day';

        // Both faces are drawn as stepped bands rather than linear gradients.
        // A smooth vertical ramp is the one thing a pixel-art coastline cannot
        // do: it reads as an airbrushed slab against terrain made of discrete
        // tones. Quantising into courses keeps the same silhouette and colour
        // ramp while putting the cliff in the same idiom as the rock and
        // masonry above it. Baked, so the extra fills cost nothing per frame.
        // `vTop` is the drop from the diamond edge line to the top of this
        // group of bands; both endpoints of the edge move together.
        const bandedFace = (side, vTop, height, bandCount, offsetTop, offsetBottom, ramp) => {
            for (let k = 0; k < bandCount; k++) {
                const t0 = k / bandCount;
                const t1 = (k + 1) / bandCount;
                const dy0 = vTop + height * t0;
                const dy1 = vTop + height * t1;
                const o0 = side.dir * (offsetTop + (offsetBottom - offsetTop) * t0);
                const o1 = side.dir * (offsetTop + (offsetBottom - offsetTop) * t1);
                ctx.fillStyle = sampleRamp(ramp, (t0 + t1) / 2);
                ctx.beginPath();
                ctx.moveTo(side.a.x + o0, Math.round(side.a.y + dy0));
                ctx.lineTo(side.b.x + o0, Math.round(side.b.y + dy0));
                ctx.lineTo(side.b.x + o1, Math.round(side.b.y + dy1));
                ctx.lineTo(side.a.x + o1, Math.round(side.a.y + dy1));
                ctx.closePath();
                ctx.fill();
            }
        };

        const SAND_RAMP = [
            { t: 0, c: [226, 196, 142, 0.92] },
            { t: 1, c: [196, 162, 108, 0.85] },
        ];
        const CLIFF_RAMP = [
            { t: 0, c: [120, 92, 58, 0.82] },
            { t: 0.6, c: [70, 52, 34, 0.62] },
            { t: 1, c: [34, 24, 17, 0] },
        ];

        for (const side of [{ a: east, b: south, dir: -1 }, { a: south, b: west, dir: 1 }]) {
            // Reflection is drawn first, so the face and its waterline sit over
            // the reflected edge instead of receiving an overlaid stripe.
            this._drawBakedCliffReflection(ctx, side, phase, sandH + cliffH);
            ctx.save();
            // Sunlit sand lip hugging the diamond edge — 4 courses.
            bandedFace(side, 0, sandH, 4, 0, 6, SAND_RAMP);
            // Shaded cliff face beneath, dissolving into the distant-sea void.
            bandedFace(side, sandH, cliffH, 8, 6, 14, CLIFF_RAMP);
            this._drawDitheredWaterline(ctx, side, phase, sandH + cliffH);
            ctx.restore();
        }
    }

    // Reflect the lower 60px of the cliff shelf into the water. Each reflected
    // course reverses the source order, selects one of the four authored
    // key-light response bands, and then uses one of exactly three alpha steps.
    // It is part of the terrain bake, never a per-frame water pass.
    _drawBakedCliffReflection(ctx, side, phase = 'day', waterlineOffset = 62) {
        const palette = CLIFF_REFLECTION_PHASE_PALETTES[phase] || CLIFF_REFLECTION_PHASE_PALETTES.day;
        const responseBands = AUTHORED_KEY_LIGHT.responseBands;
        const bandHeight = CLIFF_REFLECTION_DEPTH / CLIFF_REFLECTION_BAND_COUNT;
        const sourceBottom = CLIFF_REFLECTION_BAND_COUNT - 1;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let k = 0; k < CLIFF_REFLECTION_BAND_COUNT; k++) {
            const t0 = k / CLIFF_REFLECTION_BAND_COUNT;
            const t1 = (k + 1) / CLIFF_REFLECTION_BAND_COUNT;
            const sourceBand = sourceBottom - k;
            const keyBand = Math.min(
                responseBands.length - 1,
                Math.floor((sourceBottom - sourceBand) * responseBands.length / CLIFF_REFLECTION_BAND_COUNT),
            );
            const response = responseBands[keyBand] ?? 1;
            const alphaBand = response >= 1.12 ? 2 : response >= 1 ? 1 : 0;
            const offsetNear = side.dir * 14;
            const offsetFar = side.dir * 0;
            const o0 = offsetNear + (offsetFar - offsetNear) * t0;
            const o1 = offsetNear + (offsetFar - offsetNear) * t1;
            const y0 = waterlineOffset + bandHeight * k;
            const y1 = waterlineOffset + bandHeight * (k + 1);

            const alpha = CLIFF_REFLECTION_ALPHA_STEPS[alphaBand] ?? CLIFF_REFLECTION_ALPHA_STEPS.at(-1);
            ctx.fillStyle = this._withAlpha(palette[keyBand], alpha);
            ctx.beginPath();
            ctx.moveTo(side.a.x + o0, Math.round(side.a.y + y0));
            ctx.lineTo(side.b.x + o0, Math.round(side.b.y + y0));
            ctx.lineTo(side.b.x + o1, Math.round(side.b.y + y1));
            ctx.lineTo(side.a.x + o1, Math.round(side.a.y + y1));
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    // The 2px blocks make the island/sea seam a stepped waterline. Bucket 3 is
    // intentionally omitted, matching the GPU wetness shader's four-cell
    // ordered dither rather than inventing another Canvas pattern.
    _drawDitheredWaterline(ctx, side, phase = 'day', waterlineOffset = 62) {
        const palette = WATERLINE_DITHER_PALETTES[phase] || WATERLINE_DITHER_PALETTES.day;
        const length = Math.hypot(side.b.x - side.a.x, side.b.y - side.a.y);
        if (!(length > 0)) return;
        const ux = (side.b.x - side.a.x) / length;
        const uy = (side.b.y - side.a.y) / length;
        const startX = side.a.x + side.dir * 14;
        const startY = side.a.y + waterlineOffset;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        SpriteRenderer.disableSmoothing(ctx);
        for (let distance = 0; distance < length; distance += 2) {
            const x = Math.round(startX + ux * distance);
            const y = Math.round(startY + uy * distance);
            const bucket = Math.round(orderedDither4(x, y) * 3);
            if (bucket >= 3) continue;
            ctx.fillStyle = palette[bucket];
            ctx.fillRect(x, y, 2, 2);
        }
        ctx.restore();
    }

    // Distant sea + horizon beyond the island. Drawn per-frame in world space,
    // BEHIND the terrain (which is opaque over it), so it only fills the void
    // around and below the diamond — turning the flat edge into a coastline.
    // Phase-tinted: the top fades out of the sky's own horizon colour so sea
    // and sky meet seamlessly. Static under reduced motion (pure gradient).
    _drawDistantSeaHorizon(ctx, atmosphere) {
        const points = this._worldDiamondPoints();
        const equatorY = points[1].y;          // diamond's widest screen row
        const seaTop = equatorY - 60;          // horizon a touch above the equator
        const seaBottom = points[2].y + 560;   // deep into the void below the south wall
        const leftX = points[3].x - 1400;
        const rightX = points[1].x + 1400;

        const phase = atmosphere?.phase || 'day';
        const deep = phase === 'night'
            ? { shallow: '#1a3a5e', deep: '#0a1c34' }
            : phase === 'dusk'
                ? { shallow: '#6a6390', deep: '#3b3860' }
                : phase === 'dawn'
                    ? { shallow: '#6f8fb8', deep: '#445e8a' }
                    : { shallow: '#5aa0c8', deep: '#2f6e9b' };
        const horizon = atmosphere?.sky?.palette?.horizon || '#8fb9cf';

        ctx.save();
        const grad = ctx.createLinearGradient(0, seaTop, 0, seaBottom);
        grad.addColorStop(0, horizon);
        grad.addColorStop(0.16, deep.shallow);
        grad.addColorStop(1, deep.deep);
        ctx.fillStyle = grad;
        ctx.fillRect(leftX, seaTop, rightX - leftX, seaBottom - seaTop);

        // Soft horizon haze band where sea meets sky.
        const haze = ctx.createLinearGradient(0, seaTop - 30, 0, seaTop + 30);
        haze.addColorStop(0, 'rgba(255, 255, 255, 0)');
        haze.addColorStop(0.5, phase === 'night' ? 'rgba(120, 150, 190, 0.18)' : 'rgba(240, 250, 255, 0.34)');
        haze.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = haze;
        ctx.fillRect(leftX, seaTop - 30, rightX - leftX, 60);

        // B5 — a few faint distant swell lines for depth. Motion-on: 3-segment
        // quadratics whose control-point y bobs and whose x offset drifts, so the
        // horizon rolls slowly. Reduced motion falls back to the flat lines.
        ctx.strokeStyle = phase === 'night' ? 'rgba(150, 180, 215, 0.10)' : 'rgba(235, 248, 255, 0.16)';
        ctx.lineWidth = 2;
        const swellReduced = !this.motionScale;
        const span = rightX - leftX;
        const x1 = leftX + span / 3;
        const x2 = leftX + (2 * span) / 3;
        const c0 = leftX + span / 6;
        const c1 = leftX + span * 0.5;
        const c2 = leftX + (5 * span) / 6;
        for (let i = 0; i < 4; i++) {
            const ly = seaTop + 40 + i * 70;
            ctx.beginPath();
            if (swellReduced) {
                ctx.moveTo(leftX, ly);
                ctx.lineTo(rightX, ly);
            } else {
                const drift = Math.sin(this.waterFrame * 0.12 + i * 1.3) * 60;
                const bob1 = Math.sin(this.waterFrame * 0.18 + i * 0.9) * 10;
                const bob2 = Math.sin(this.waterFrame * 0.16 - i * 1.1) * 10;
                ctx.moveTo(leftX, ly);
                ctx.quadraticCurveTo(c0 + drift, ly - 12 + bob1, x1 + drift, ly + bob1 * 0.3);
                ctx.quadraticCurveTo(c1 + drift, ly + 12 + bob2, x2 + drift, ly + bob2 * 0.3);
                ctx.quadraticCurveTo(c2 + drift, ly - 12 + bob1, rightX, ly);
            }
            ctx.stroke();
        }

        // B5 — faint vertical glitter column under the sun/moon's horizontal
        // position, tinted warm by day and pale blue at night, fading with fog.
        const glitterBody = atmosphere?.sky?.sun?.visible
            ? atmosphere.sky.sun
            : atmosphere?.sky?.moon?.visible
                ? atmosphere.sky.moon
                : null;
        if (glitterBody) {
            const colFog = Math.max(0, Math.min(1, atmosphere?.weather?.fog ?? 0));
            const colAlpha = (phase === 'night' ? 0.06 : 0.09) * (1 - colFog * 0.7) * (glitterBody.alpha ?? 0);
            if (colAlpha > 0.008) {
                const colColor = phase === 'night' ? '150, 190, 235' : '255, 236, 190';
                const colX = leftX + (glitterBody.xFrac ?? 0.5) * span;
                const colW = 46;
                const colGrad = ctx.createLinearGradient(colX, seaTop, colX, seaBottom);
                colGrad.addColorStop(0, `rgba(${colColor}, 0)`);
                colGrad.addColorStop(0.2, `rgba(${colColor}, ${colAlpha})`);
                colGrad.addColorStop(1, `rgba(${colColor}, 0)`);
                ctx.fillStyle = colGrad;
                ctx.fillRect(colX - colW / 2, seaTop, colW, seaBottom - seaTop);
            }
        }

        // #25 — stacked haze bands dissolve the hard void boundary into
        // atmospheric distance. 3–4 staggered bands fade up toward the sky's
        // own horizon colour, deepening with weather fog so a foggy day melts
        // the diamond edge further into the white. Pure stacked gradients —
        // already static, so the reduced-motion fallback is identical.
        const fog = Math.max(0, Math.min(1, atmosphere?.weather?.fog ?? 0));
        const bands = 4;
        const bandSpan = 150;
        const baseAlpha = (phase === 'night' ? 0.07 : 0.12) + fog * 0.26;
        for (let i = 0; i < bands; i++) {
            const top = seaTop + 24 + i * (bandSpan * 0.62);
            const alpha = baseAlpha * (1 - i / bands) * 0.9;
            if (alpha <= 0.004) continue;
            const band = ctx.createLinearGradient(0, top, 0, top + bandSpan);
            band.addColorStop(0, this._withAlpha(horizon, 0));
            band.addColorStop(0.5, this._withAlpha(horizon, alpha));
            band.addColorStop(1, this._withAlpha(horizon, 0));
            ctx.fillStyle = band;
            ctx.fillRect(leftX, top, rightX - leftX, bandSpan);
        }
        ctx.restore();
    }

    _drawDioramaBackdrop(ctx) {
        const points = this._worldDiamondPoints();
        const gradient = ctx.createLinearGradient(0, points[0].y - 80, 0, points[2].y + 120);
        gradient.addColorStop(0, 'rgba(33, 58, 59, 0.16)');
        gradient.addColorStop(0.42, 'rgba(77, 52, 26, 0.08)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
        ctx.save();
        ctx.translate(0, 12);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y - 44);
        ctx.lineTo(points[1].x + 78, points[1].y + 18);
        ctx.lineTo(points[2].x, points[2].y + 86);
        ctx.lineTo(points[3].x - 78, points[3].y + 18);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawDistrictAtmosphere(ctx) {
        const zoom = this.camera?.zoom || 1;
        const intensity = Math.max(0.38, Math.min(1, (3.4 - zoom) / 2.2));
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        for (const wash of DISTRICT_WASHES) {
            const x = (wash.x - wash.y) * TILE_WIDTH / 2;
            const y = (wash.x + wash.y) * TILE_HEIGHT / 2;
            const radius = Math.max(wash.radiusX * TILE_WIDTH, wash.radiusY * TILE_HEIGHT);
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
            gradient.addColorStop(0, this._withAlpha(wash.color, wash.alpha * intensity));
            gradient.addColorStop(0.62, this._withAlpha(wash.color, wash.alpha * 0.38 * intensity));
            gradient.addColorStop(1, this._withAlpha(wash.color, 0));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.ellipse(x, y, wash.radiusX * TILE_WIDTH / 2, wash.radiusY * TILE_HEIGHT / 2, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = `rgba(247, 205, 116, ${0.04 * intensity})`;
        ctx.lineWidth = 1;
        const points = this._worldDiamondPoints();
        for (let i = 1; i <= 4; i++) {
            const inset = i * 34;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y + inset);
            ctx.lineTo(points[1].x - inset * 0.7, points[1].y + inset * 0.34);
            ctx.lineTo(points[2].x, points[2].y - inset);
            ctx.lineTo(points[3].x + inset * 0.7, points[3].y + inset * 0.34);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawRiverContourLines(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = this.deepWaterTiles.has(key) ? 'rgba(5, 19, 42, 0.42)' : 'rgba(124, 205, 232, 0.30)';
                ctx.lineWidth = this.deepWaterTiles.has(key) ? 2 : 1;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }
        ctx.restore();
    }

    _drawWaterFoamLines(ctx, startX, endX, startY, endY) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineCap = 'round';
        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = `${x},${y}`;
                if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) continue;
                const edge = this._waterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                const seed = this.terrainSeed[y * MAP_SIZE + x] || 0;
                ctx.strokeStyle = `rgba(221, 249, 255, ${0.18 + seed * 0.09})`;
                ctx.lineWidth = this.deepWaterTiles.has(key) ? 1.4 : 1;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }

        if (this.bridgeTiles) {
            for (const [key, info] of this.bridgeTiles.entries()) {
                if (info?.kind !== 'dock') continue;
                const comma = key.indexOf(',');
                const x = Number(key.slice(0, comma));
                const y = Number(key.slice(comma + 1));
                if (x < startX || x > endX || y < startY || y > endY) continue;
                const edge = this._dockWaterEdgeMask(x, y);
                if (edge === 0) continue;
                const screenX = (x - y) * TILE_WIDTH / 2;
                const screenY = (x + y) * TILE_HEIGHT / 2;
                ctx.strokeStyle = 'rgba(238, 252, 238, 0.28)';
                ctx.lineWidth = 1.6;
                this._strokeDiamondEdges(ctx, screenX, screenY, edge);
            }
        }
        ctx.restore();
    }

    // Shoreline mask: which edges of this water tile face something that is not
    // water. Foam belongs on those edges.
    //
    // Neighbours outside the map are NOT shore. They used to count as land,
    // which drew a foam line along the entire map perimeter — a perfectly
    // straight, tile-aligned pale streak running across open ocean where there
    // is no coast at all. The map boundary is an artefact of the array bounds,
    // not a feature of the world.
    _waterEdgeMask(tileX, tileY) {
        const shore = (x, y) => {
            if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return false;
            return !this.waterTiles.has(`${x},${y}`);
        };
        let mask = 0;
        if (shore(tileX, tileY - 1)) mask |= 1;
        if (shore(tileX + 1, tileY)) mask |= 2;
        if (shore(tileX, tileY + 1)) mask |= 4;
        if (shore(tileX - 1, tileY)) mask |= 8;
        return mask;
    }

    _shoreWaterEdgeMask(tileX, tileY) {
        let mask = 0;
        if (this._isOpenWaterTile(tileX, tileY - 1)) mask |= 1;
        if (this._isOpenWaterTile(tileX + 1, tileY)) mask |= 2;
        if (this._isOpenWaterTile(tileX, tileY + 1)) mask |= 4;
        if (this._isOpenWaterTile(tileX - 1, tileY)) mask |= 8;
        return mask;
    }

    _dockWaterEdgeMask(tileX, tileY) {
        let mask = 0;
        if (this._isOpenWaterTile(tileX, tileY - 1)) mask |= 1;
        if (this._isOpenWaterTile(tileX + 1, tileY)) mask |= 2;
        if (this._isOpenWaterTile(tileX, tileY + 1)) mask |= 4;
        if (this._isOpenWaterTile(tileX - 1, tileY)) mask |= 8;
        return mask;
    }

    _isOpenWaterTile(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        return this.waterTiles.has(key) && !this.bridgeTiles?.has(key);
    }

    _waterOpenness(tileX, tileY) {
        const meta = this._waterMetaAt(tileX, tileY);
        if (Number.isFinite(Number(meta?.openness))) return Number(meta.openness);
        let waterNeighbors = 0;
        let checks = 0;
        for (let y = tileY - 1; y <= tileY + 1; y++) {
            for (let x = tileX - 1; x <= tileX + 1; x++) {
                if (x === tileX && y === tileY) continue;
                checks++;
                if (this.waterTiles.has(`${x},${y}`)) waterNeighbors++;
            }
        }
        return checks ? waterNeighbors / checks : 0;
    }

    _isHarborWater(tileX, tileY) {
        const key = `${tileX},${tileY}`;
        const region = this._waterRegionAt(tileX, tileY, key);
        return region === 'harbor' || this._waterProfileAt(tileX, tileY, key) === 'harbor';
    }

    _isOpenSeaTile(tileX, tileY, openness = null) {
        const key = `${tileX},${tileY}`;
        if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) return false;
        if (!this.deepWaterTiles.has(key)) return false;
        const open = openness ?? this._waterOpenness(tileX, tileY);
        if (open < 0.62) return false;
        const region = this._waterRegionAt(tileX, tileY, key);
        const profile = this._waterProfileAt(tileX, tileY, key);
        return region === 'openSea' || region === 'sea' || profile === 'openSea';
    }

    // Interior tiles of the big lagoon bodies — the "big water" class that
    // gets baked wavelets alongside the open sea (2.4).
    _isBigLagoonWaterTile(tileX, tileY, openness = null) {
        const key = `${tileX},${tileY}`;
        if (!this.waterTiles.has(key) || this.bridgeTiles?.has(key)) return false;
        if (!this._isLagoonWaterTile(tileX, tileY, key)) return false;
        return (openness ?? this._waterOpenness(tileX, tileY)) >= 0.75;
    }

    _strokeDiamondEdges(ctx, screenX, screenY, mask) {
        const top = { x: screenX, y: screenY - TILE_HEIGHT / 2 };
        const right = { x: screenX + TILE_WIDTH / 2, y: screenY };
        const bottom = { x: screenX, y: screenY + TILE_HEIGHT / 2 };
        const left = { x: screenX - TILE_WIDTH / 2, y: screenY };
        if (mask & 1) this._strokeSegment(ctx, left, top);
        if (mask & 2) this._strokeSegment(ctx, top, right);
        if (mask & 4) this._strokeSegment(ctx, right, bottom);
        if (mask & 8) this._strokeSegment(ctx, bottom, left);
    }

    _strokeInsetDiamondEdges(ctx, screenX, screenY, mask, inset = 6) {
        const top = { x: screenX, y: screenY - TILE_HEIGHT / 2 + inset * 0.45 };
        const right = { x: screenX + TILE_WIDTH / 2 - inset, y: screenY };
        const bottom = { x: screenX, y: screenY + TILE_HEIGHT / 2 - inset * 0.45 };
        const left = { x: screenX - TILE_WIDTH / 2 + inset, y: screenY };
        if (mask & 1) this._strokeSegment(ctx, left, top);
        if (mask & 2) this._strokeSegment(ctx, top, right);
        if (mask & 4) this._strokeSegment(ctx, right, bottom);
        if (mask & 8) this._strokeSegment(ctx, bottom, left);
    }

    _strokeSegment(ctx, a, b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    // Depth reads as a continuous ramp from the shore rim to the basin centre.
    //
    // This used to shade only the lower half of each tile diamond, with a hard
    // seam across the middle and a binary deep/shallow alpha. Tiled across a
    // body of water that is exactly a light/dark checkerboard — the artefact
    // v0.26 removed from the *classification* was still being drawn back in by
    // the accent pass. Shading the whole diamond, with alpha following the
    // already-computed BFS shore distance, gives one coherent mass instead.
    _drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY) {
        const key = `${tileX},${tileY}`;
        const openSea = this._isOpenSeaTile(tileX, tileY);
        const token = this._waterTokenAt(tileX, tileY, key);
        const meta = this._waterMetaAt(tileX, tileY, key);
        const isDeep = this.deepWaterTiles.has(key);

        const shoreDistance = Number.isFinite(Number(meta?.shoreDistance))
            ? Number(meta.shoreDistance)
            : (isDeep ? 3 : 0);
        const span = openSea ? 6 : 4;
        const t = Math.max(0, Math.min(1, shoreDistance / span));
        const eased = t * t * (3 - 2 * t); // smoothstep: gentle rim, settled centre
        const alpha = (openSea ? 0.10 : 0.08) + eased * (openSea ? 0.34 : 0.25);

        // Scanline diamond, not a path fill. A path diamond antialiases along
        // its diagonals, and with a translucent tint that leaves a hairline
        // where neighbours meet — overscanning to close it composites twice and
        // draws a dark lattice instead. The scanline decomposition tiles
        // exactly, so a body of water comes out as one clean mass.
        fillTileDiamond(ctx, screenX, screenY, TILE_WIDTH, TILE_HEIGHT,
            `rgba(0, ${openSea ? 8 : 12}, ${openSea ? 42 : 34}, ${alpha.toFixed(3)})`);

        // Shelf drop-off. The base art switches between the shallow and deep
        // tilesets at a tile boundary, so the edge of a basin reads as a hard
        // staircase however smoothly the depth tint ramps over it. A darker rim
        // on the deep side of that boundary turns the step into a reef edge
        // falling away, which is what the geometry is actually describing.
        if (isDeep) this._drawShelfDropoff(ctx, screenX, screenY, tileX, tileY, openSea);

        const glint = this.motionScale
            ? 0.04 + Math.max(0, Math.sin(this.waterFrame * 1.6 + tileX * 0.7 - tileY * 0.4 + seed * 5)) * 0.09
            : 0.055;
        const light = `rgb(${token.glint})`;
        ctx.strokeStyle = this._withAlpha(light, Math.min(openSea ? 0.22 : 0.18, glint + (isDeep ? 0.02 : 0.05)));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 18 + seed * 6, screenY - 6);
        ctx.lineTo(screenX + 3 + seed * 10, screenY - 10);
        ctx.stroke();
    }

    // Darkened rim along the edges of a deep tile that face shallower water,
    // inset into the tile so it never doubles up with the neighbour's own rim.
    _drawShelfDropoff(ctx, screenX, screenY, tileX, tileY, openSea) {
        const shallower = (x, y) => {
            const k = `${x},${y}`;
            return this.waterTiles.has(k) && !this.deepWaterTiles.has(k);
        };
        let mask = 0;
        if (shallower(tileX, tileY - 1)) mask |= 1;
        if (shallower(tileX + 1, tileY)) mask |= 2;
        if (shallower(tileX, tileY + 1)) mask |= 4;
        if (shallower(tileX - 1, tileY)) mask |= 8;
        if (mask === 0) return;

        const hw = TILE_WIDTH / 2;
        const hh = TILE_HEIGHT / 2;
        const inset = 0.42;                       // fraction of the half-diagonal
        const top = { x: screenX, y: screenY - hh };
        const right = { x: screenX + hw, y: screenY };
        const bottom = { x: screenX, y: screenY + hh };
        const left = { x: screenX - hw, y: screenY };
        const centre = { x: screenX, y: screenY };
        const toward = (p) => ({
            x: p.x + (centre.x - p.x) * inset,
            y: p.y + (centre.y - p.y) * inset,
        });

        // Bit order matches _waterEdgeMask: N, E, S, W.
        const edges = [
            [top, right], [right, bottom], [bottom, left], [left, top],
        ];
        ctx.fillStyle = `rgba(0, ${openSea ? 6 : 9}, ${openSea ? 30 : 26}, 0.20)`;
        for (let bit = 0; bit < 4; bit++) {
            if (!(mask & (1 << bit))) continue;
            const [a, b] = edges[bit];
            const ai = toward(a);
            const bi = toward(b);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.lineTo(bi.x, bi.y);
            ctx.lineTo(ai.x, ai.y);
            ctx.closePath();
            ctx.fill();
        }
    }

    _drawShoreCrest(ctx, screenX, screenY, seed, tileX, tileY) {
        const adjacentWater = this.waterTiles.has(`${tileX},${tileY - 1}`)
            || this.waterTiles.has(`${tileX + 1},${tileY}`)
            || this.waterTiles.has(`${tileX},${tileY + 1}`)
            || this.waterTiles.has(`${tileX - 1},${tileY}`);

        // B1: foam wash only where the adjacent water is lagoon-kind.
        if (adjacentWater) {
            const adjacentLagoon = this._isLagoonWaterTile(tileX, tileY - 1)
                || this._isLagoonWaterTile(tileX + 1, tileY)
                || this._isLagoonWaterTile(tileX, tileY + 1)
                || this._isLagoonWaterTile(tileX - 1, tileY);
            if (adjacentLagoon) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const drewFoamSprite = this._drawAtmosphereEffectSprite(ctx, ATMOSPHERE_EFFECT_ASSETS.shoreFoam, {
                    x: screenX + (seed - 0.5) * 10,
                    y: screenY - 2 + (seed - 0.5) * 5,
                    alpha: 0.18 + seed * 0.10,
                    scaleX: 0.68 + seed * 0.24,
                    scaleY: 0.58 + seed * 0.18,
                    rotation: -0.45 + seed * 0.9,
                    flipX: seed > 0.5,
                });
                if (!drewFoamSprite) {
                    const foamRadius = TILE_WIDTH * 0.7;
                    const foamGrad = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, foamRadius);
                    foamGrad.addColorStop(0, 'rgba(220, 240, 250, 0.22)');
                    foamGrad.addColorStop(1, 'rgba(220, 240, 250, 0)');
                    ctx.fillStyle = foamGrad;
                    ctx.beginPath();
                    ctx.arc(screenX, screenY, foamRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        ctx.fillStyle = adjacentWater
            ? `rgba(226, 190, 102, ${0.08 + seed * 0.06})`
            : `rgba(87, 70, 36, ${0.07 + seed * 0.04})`;
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2 + 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2 - 5, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2 - 3);
        ctx.lineTo(screenX - TILE_WIDTH / 2 + 5, screenY);
        ctx.closePath();
        ctx.fill();

        // 2.2 — wet-sand crescent: a darker, damp band along the water-facing
        // edges of the shore tile, between the dry sand and the waterline.
        if (adjacentWater) {
            const wetMask = this._shoreWaterEdgeMask(tileX, tileY);
            if (wetMask) {
                ctx.strokeStyle = `rgba(116, 86, 50, ${0.14 + seed * 0.06})`;
                ctx.lineWidth = 5;
                ctx.lineCap = 'round';
                this._strokeInsetDiamondEdges(ctx, screenX, screenY, wetMask, 6);
                ctx.strokeStyle = `rgba(88, 66, 40, ${0.10 + seed * 0.04})`;
                ctx.lineWidth = 2;
                this._strokeInsetDiamondEdges(ctx, screenX, screenY, wetMask, 3);
            }
        }
    }

    _drawPathInsetShadow(ctx, screenX, screenY, seed, tileX, tileY) {
        const isSquare = this.townSquareTiles.has(`${tileX},${tileY}`);
        ctx.strokeStyle = isSquare
            ? `rgba(26, 18, 11, ${0.10 + seed * 0.04})`
            : `rgba(20, 13, 7, ${0.08 + seed * 0.035})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 18, screenY + 1);
        ctx.lineTo(screenX, screenY + 9);
        ctx.lineTo(screenX + 18, screenY + 1);
        ctx.stroke();
    }

    _drawTerrainTone(ctx, screenX, screenY, key, seed, tileX, tileY) {
        let fill = null;
        let alpha = 0;
        const visualWater = this._isVisualWaterTile(tileX, tileY, key);

        const isLagoon = this._isLagoonWaterTile(tileX, tileY, key);
        const waterToken = visualWater ? this._waterTokenAt(tileX, tileY, key) : null;
        if (this.deepWaterTiles.has(key)) {
            const openSea = this._isOpenSeaTile(tileX, tileY);
            if (isLagoon) {
                // Stable cached base; weather-specific water response lives in dynamic passes.
                fill = waterToken.deep;
                alpha = 0.48;
            } else {
                // Smooth tonal drift across the deep mass (0.2): the fill lerps
                // between the two deep tones on a low-frequency field, so depth
                // reads as coherent patches instead of alternating diamonds.
                const drift = this._smoothNoise(tileX + 31, tileY + 47, 5);
                fill = this._lerpColor(waterToken.deep, openSea ? '#03244a' : '#0b6c8d', drift * 0.85);
                alpha = openSea ? 0.58 : 0.48;
            }
        } else if (visualWater) {
            if (isLagoon) {
                // Stable cached base; weather-specific water response lives in dynamic passes.
                fill = waterToken.shallow;
            } else {
                const drift = this._smoothNoise(tileX + 31, tileY + 47, 5);
                fill = this._lerpColor(waterToken.shallow, WATER_TOKENS.water.shallow, drift * 0.7);
            }
            // 2.2 — sandy bed: the tile of water right at the waterline warms
            // toward the shore sand so shallows read as wading depth.
            const shoreDistance = this._waterMetaAt(tileX, tileY, key)?.shoreDistance;
            if (shoreDistance === 0) fill = this._lerpColor(fill, '#c9a35e', 0.30);
            alpha = this.waterTiles.has(key) ? 0.42 : 0.54;
        } else if (this.shoreTiles.has(key)) {
            fill = seed > 0.45 ? '#c29a55' : '#ad8346';
            alpha = 0.15;
        } else if (this.townSquareTiles.has(key)) {
            fill = '#2d2219';
            alpha = 0.09;
        } else if (this.mainAvenueTiles?.has(key)) {
            fill = '#3a2a18';
            alpha = 0.07;
        } else if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) {
            fill = '#2f2818';
            alpha = 0.055;
        } else {
            const forestFloor = this._forestFloorAt(tileX, tileY);
            if (forestFloor) {
                const mix = this._tileNoise(tileX + 709, tileY + 431);
                fill = mix > 0.56 ? forestFloor.accent : forestFloor.base;
                alpha = 0.18 + forestFloor.strength * 0.20;
            } else {
                // Broad grass greens drift in coherent masses on the low-frequency
                // field (2.1) instead of flipping per 5x5 hash cell.
                const broad = this._smoothNoise(tileX + 97, tileY + 131, 7);
                fill = broad > 0.66 ? '#537339' : broad < 0.30 ? '#6d8742' : '#5d7c3c';
                alpha = 0.11;
            }
        }

        if (!fill || alpha <= 0) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = this._withAlpha(fill, alpha);
        this._drawDiamond(ctx, screenX, screenY);
        ctx.fill();

        const allowRegionTint = !visualWater && !this.shoreTiles.has(key);
        const regionTone = allowRegionTint ? this._terrainRegionTint(fill, tileX, tileY, seed) : null;
        if (regionTone && regionTone !== fill) {
            const regionAlpha = Math.min(0.08, alpha * 0.45);
            ctx.fillStyle = this._withAlpha(regionTone, regionAlpha);
            this._drawDiamond(ctx, screenX, screenY);
            ctx.fill();
        }

        const forestFloor = allowRegionTint ? this._forestFloorAt(tileX, tileY) : null;
        if (forestFloor) {
            this._drawForestFloorTexture(ctx, screenX, screenY, seed, forestFloor);
        }

        if (visualWater && this.motionScale && seed > 0.72) {
            const shimmer = 0.05 + Math.max(0, Math.sin(this.waterFrame * 2.2 + seed * 10)) * 0.06;
            // A3: warm tropical teal shimmer for lagoon, cool blue-white for sea.
            ctx.strokeStyle = isLagoon
                ? `rgba(120, 230, 200, ${shimmer})`
                : `rgba(188, 253, 246, ${shimmer})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(screenX - 12, screenY - 2);
            ctx.lineTo(screenX + 10, screenY - 6);
            ctx.stroke();
        }
        if (visualWater) {
            this._drawWaterDepthAccent(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.shoreTiles.has(key)) {
            this._drawShoreCrest(ctx, screenX, screenY, seed, tileX, tileY);
        } else if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) {
            this._drawPathInsetShadow(ctx, screenX, screenY, seed, tileX, tileY);
        }
        ctx.restore();
    }

    _forestFloorAt(tileX, tileY) {
        let strongest = null;
        for (const region of FOREST_FLOOR_REGIONS) {
            const dx = (tileX + 0.5 - region.centerX) / region.radiusX;
            const dy = (tileY + 0.5 - region.centerY) / region.radiusY;
            const distance = dx * dx + dy * dy;
            if (distance > 1) continue;
            const edge = 1 - distance;
            const ragged = (this._tileNoise(tileX + 593, tileY + 277) - 0.5) * 0.18;
            const strength = Math.max(0, Math.min(1, (edge + ragged) * region.strength));
            if (strength <= 0.05) continue;
            if (!strongest || strength > strongest.strength) {
                strongest = {
                    base: region.base,
                    accent: region.accent,
                    strength,
                };
            }
        }
        return strongest;
    }

    _drawForestFloorTexture(ctx, screenX, screenY, seed, forestFloor) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgba(34, 52, 12, ${0.035 + forestFloor.strength * 0.075})`;
        this._drawDiamond(ctx, screenX, screenY);
        ctx.fill();

        if (seed > 0.34) {
            ctx.globalCompositeOperation = 'screen';
            ctx.lineCap = 'round';
            ctx.lineWidth = 1;
            const alpha = 0.035 + forestFloor.strength * 0.07;
            ctx.strokeStyle = `rgba(209, 236, 104, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(screenX - 17 + seed * 5, screenY - 3);
            ctx.quadraticCurveTo(screenX - 5, screenY - 9 - seed * 2, screenX + 14 - seed * 3, screenY - 6);
            ctx.stroke();
        }

        if (seed > 0.78) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(252, 216, 118, ${0.09 + forestFloor.strength * 0.06})`;
            ctx.fillRect(Math.round(screenX - 2), Math.round(screenY - 9), 2, 2);
            ctx.fillStyle = `rgba(153, 221, 82, ${0.11 + forestFloor.strength * 0.08})`;
            ctx.fillRect(Math.round(screenX + 7), Math.round(screenY - 4), 2, 1);
        }
        ctx.restore();
    }

    _drawFishSchools(ctx) {
        this.wildlifeRenderer.drawFishSchools(ctx);
    }

    _drawWaterfowl(ctx) {
        this.wildlifeRenderer.drawWaterfowl(ctx);
    }

    _drawLandBirds(ctx) {
        this.wildlifeRenderer.drawLandBirds(ctx);
    }

    _triggerGullScatter() {
        this.wildlifeRenderer.triggerGullScatter();
    }

    _gullScatterActive() {
        return this.wildlifeRenderer.gullScatterActive();
    }

    _drawOpenSeaGulls(ctx) {
        this.wildlifeRenderer.drawOpenSeaGulls(ctx);
    }

    _drawDiamond(ctx, screenX, screenY) {
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
    }

    // Map a tile's class to the appropriate Wang tileset id.
    // Priority: water (deep > shallow) > shore > town square > main avenue > path > grass.
    _terrainSheetIdAt(x, y) {
        const key = `${x},${y}`;
        if (this.deepWaterTiles.has(key)) return 'terrain.shallow-deep';
        if (this._isVisualWaterTile(x, y, key)) return 'terrain.shore-shallow';
        if (this.shoreTiles.has(key)) return 'terrain.grass-shore';
        if (this.townSquareTiles.has(key)) return 'terrain.cobble-square';
        if (this.mainAvenueTiles?.has(key)) return 'terrain.grass-cobble';
        if (this.pathTiles.has(key) || this.dirtPathTiles?.has(key)) return 'terrain.grass-dirt';
        // Pure grass: any tileset works since mask = 0 paints the lower (grass) variant.
        return 'terrain.grass-dirt';
    }

    // True if the neighbour tile (tx, ty) belongs to the same "upper" class
    // as the tileset chosen for the origin tile (originX, originY).
    _sameTerrainClass(originX, originY, tx, ty) {
        const id = this._terrainSheetIdAt(originX, originY);
        const tkey = `${tx},${ty}`;
        if (id === 'terrain.shallow-deep') return this.deepWaterTiles.has(tkey);
        // Shallow water treats deep water as same-class: the Wang mask then
        // reads the whole water body as one mass and no transition cell is
        // drawn along the deep/shallow boundary (checkerboard fix, 0.2).
        if (id === 'terrain.shore-shallow') return this._isVisualWaterTile(tx, ty, tkey);
        if (id === 'terrain.grass-shore') return this.shoreTiles.has(tkey);
        if (id === 'terrain.cobble-square') return this.townSquareTiles.has(tkey);
        if (id === 'terrain.grass-cobble') return this.mainAvenueTiles?.has(tkey);
        if (id === 'terrain.grass-dirt') return this.pathTiles.has(tkey) || (this.dirtPathTiles?.has(tkey) ?? false);
        return false;
    }

    _terrainRegionTint(baseColor, tileX, tileY, seed) {
        // Smooth low-frequency washes (2.1): region tint reads as large
        // authored patches instead of 4x4 hash cells.
        const broad = this._smoothNoise(tileX + 11, tileY + 19, 7);
        const wash = this._smoothNoise(tileX + tileY + 37, tileY - tileX + 43, 9);
        if (broad > 0.72) return seed > 0.42 ? '#6e873e' : '#5f7f39';
        if (broad < 0.22) return seed > 0.54 ? '#557438' : '#617b3b';
        if (wash > 0.78) return '#718a43';
        if (wash < 0.16) return '#59783a';
        return baseColor;
    }

    _drawTropicalWaterfalls(ctx) {
        if (!TROPICAL_WATERFALLS.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        for (const fall of TROPICAL_WATERFALLS) {
            const x = (fall.tileX - fall.tileY) * TILE_WIDTH / 2;
            const y = (fall.tileX + fall.tileY) * TILE_HEIGHT / 2;
            const scale = fall.scale ?? 1;
            const shimmer = this.motionScale
                ? Math.sin(this.waterFrame * 5.2 + (fall.phase ?? 0)) * 2.5
                : 0;

            ctx.save();
            ctx.translate(x, y);
            ctx.scale(scale, scale);

            ctx.fillStyle = 'rgba(91, 68, 39, 0.68)';
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.58, 2);
            ctx.lineTo(-fall.width * 0.28, -fall.height * 0.66);
            ctx.lineTo(0, -fall.height - 10);
            ctx.lineTo(fall.width * 0.42, -fall.height * 0.58);
            ctx.lineTo(fall.width * 0.58, 4);
            ctx.lineTo(0, 12);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = 'rgba(180, 126, 66, 0.42)';
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.42, -4);
            ctx.lineTo(-fall.width * 0.18, -fall.height * 0.62);
            ctx.lineTo(5, -fall.height - 4);
            ctx.lineTo(fall.width * 0.34, -fall.height * 0.50);
            ctx.lineTo(fall.width * 0.42, -3);
            ctx.closePath();
            ctx.fill();

            const stream = ctx.createLinearGradient(0, -fall.height, 0, 8);
            stream.addColorStop(0, 'rgba(202, 255, 250, 0.88)');
            stream.addColorStop(0.52, 'rgba(71, 211, 229, 0.72)');
            stream.addColorStop(1, 'rgba(216, 255, 250, 0.46)');
            ctx.fillStyle = stream;
            ctx.beginPath();
            ctx.moveTo(-fall.width * 0.16 + shimmer, -fall.height + 2);
            ctx.bezierCurveTo(-fall.width * 0.30, -fall.height * 0.54, -fall.width * 0.14, -fall.height * 0.28, -fall.width * 0.22, 4);
            ctx.lineTo(fall.width * 0.18, 6);
            ctx.bezierCurveTo(fall.width * 0.24, -fall.height * 0.28, fall.width * 0.12, -fall.height * 0.58, fall.width * 0.18 + shimmer, -fall.height + 2);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(235, 255, 246, 0.72)';
            ctx.lineWidth = 1.2;
            for (let i = -1; i <= 1; i++) {
                ctx.beginPath();
                ctx.moveTo(i * 8 + shimmer * 0.35, -fall.height * 0.86);
                ctx.bezierCurveTo(i * 4 - shimmer, -fall.height * 0.56, i * 7 + shimmer, -fall.height * 0.24, i * 5, 2);
                ctx.stroke();
            }

            // A2: animated expanding ripple ring in the pool.
            if (this.motionScale) {
                const poolBaseRadius = fall.width * 0.46;
                const t = (this.waterFrame % 60) / 60;
                const ringR = t * poolBaseRadius * 1.25;
                const ringAlpha = 0.45 * (1 - t);
                ctx.save();
                ctx.strokeStyle = `rgba(226, 255, 246, ${ringAlpha})`;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.ellipse(0, 7, ringR, ringR * (8 / (fall.width * 0.46)), 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
            // Static pool fill.
            ctx.fillStyle = 'rgba(226, 255, 246, 0.48)';
            ctx.beginPath();
            ctx.ellipse(0, 7, fall.width * 0.46, 8, 0, 0, Math.PI * 2);
            ctx.fill();

            // B4 — spray mist + pool churn. Two radial mist ellipses breathe on
            // offset phases, three seed-hashed foam dabs jitter at the plunge
            // point, and a second ripple ring runs half a cycle behind the first.
            // Reduced motion keeps the mist + dabs static and drops the rings.
            const reduced = !this.motionScale;
            const poolW = fall.width * 0.46;
            const hashFrac = (v) => v - Math.floor(v);
            for (let m = 0; m < 2; m++) {
                const mp = (fall.phase ?? 0) + m * 1.7;
                const breathe = reduced ? 0.5 : (Math.sin(this.waterFrame * 0.9 + mp) * 0.5 + 0.5);
                const mr = poolW * (0.7 + m * 0.35) * (0.85 + breathe * 0.3);
                const ma = Math.min(0.16, (0.10 + m * 0.03) * (reduced ? 0.8 : (0.6 + breathe * 0.5)));
                const mist = ctx.createRadialGradient(0, 4, 0, 0, 4, mr);
                mist.addColorStop(0, `rgba(255, 255, 255, ${ma})`);
                mist.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx.fillStyle = mist;
                ctx.beginPath();
                ctx.ellipse(0, 4, mr, mr * 0.5, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            for (let d = 0; d < 3; d++) {
                const hs = hashFrac(Math.sin((fall.phase ?? 0) * 12.9 + d * 78.233) * 43758.5453);
                const jitter = reduced ? 0 : Math.sin(this.waterFrame * 2.1 + d * 2 + (fall.phase ?? 0)) * 2;
                const dx = (hs - 0.5) * poolW * 1.2 + jitter;
                const dy = 7 + (hashFrac(hs * 7.3) - 0.5) * 4;
                ctx.fillStyle = `rgba(240, 255, 250, ${0.26 + hs * 0.2})`;
                ctx.beginPath();
                ctx.ellipse(dx, dy, 1.6 + hs * 1.4, 1.0 + hs * 0.7, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            if (!reduced) {
                const t2 = ((this.waterFrame + 30) % 60) / 60;
                const ringR2 = t2 * poolW * 1.25;
                ctx.strokeStyle = `rgba(226, 255, 246, ${0.4 * (1 - t2)})`;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.ellipse(0, 7, ringR2, ringR2 * (8 / poolW), 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }
        ctx.restore();
    }

    _drawSkyCanopy(ctx, atmosphere = null, dt = 16, motionScale = null) {
        const canvas = this._screenViewport();
        if (!canvas || !this.skyRenderer) return;
        ctx.save();
        this._resetScreenTransform(ctx);
        this.skyRenderer.drawCanopy(ctx, { canvas, camera: this.camera, atmosphere, dt, motionScale });
        ctx.restore();
    }

    _tileToWorld(tileX, tileY) {
        return tileToWorld(tileX, tileY);
    }

    _chroniclerWorldPosition(a, b) {
        if (!this.motionScale) {
            const point = this._tileToWorld(a.tileX, a.tileY);
            return { ...point, facing: 1 };
        }
        const loopMs = 16000;
        const pauseMs = 6000;
        const movingMs = (loopMs - pauseMs * 2) / 2;
        const t = (performance.now() % loopMs);
        let progress = 0;
        let from = a;
        let to = b;
        if (t < pauseMs) {
            progress = 0;
        } else if (t < pauseMs + movingMs) {
            progress = (t - pauseMs) / movingMs;
        } else if (t < pauseMs + movingMs + pauseMs) {
            progress = 1;
        } else {
            from = b;
            to = a;
            progress = (t - pauseMs - movingMs - pauseMs) / movingMs;
        }
        const ease = progress * progress * (3 - 2 * progress);
        const tileX = from.tileX + (to.tileX - from.tileX) * ease;
        const tileY = from.tileY + (to.tileY - from.tileY) * ease;
        const point = this._tileToWorld(tileX, tileY);
        return {
            ...point,
            facing: to.tileX >= from.tileX ? 1 : -1,
        };
    }

    _drawChroniclerScaffold(ctx, x, y, facing = 1) {
        const bob = this.motionScale ? Math.sin(this.waterFrame * 2.1) * 1.2 : 0;
        ctx.save();
        ctx.translate(Math.round(x), Math.round(y + bob));
        ctx.scale(facing >= 0 ? 1 : -1, 1);
        ctx.fillStyle = 'rgba(16, 22, 32, 0.24)';
        ctx.beginPath();
        ctx.ellipse(0, 5, 11, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c9b27a';
        ctx.fillRect(-5, -22, 10, 21);
        ctx.fillStyle = '#f3dfb1';
        ctx.fillRect(-4, -31, 8, 8);
        ctx.fillStyle = '#5f4a2f';
        ctx.fillRect(-7, -25, 4, 18);
        ctx.fillRect(3, -25, 4, 18);
        ctx.fillStyle = '#8bd7ff';
        ctx.globalAlpha = 0.42;
        ctx.fillRect(5, -19, 5, 7);
        ctx.restore();
    }

    _familiarMoteLightSources(lighting = null) {
        const snapshot = this.relationshipState?.getSnapshot?.();
        if (!snapshot?.parentToChildren?.size) return [];
        const sources = [];
        const now = performance.now();
        for (const [parentId, childIds] of snapshot.parentToChildren.entries()) {
            const parentSprite = this.agentSprites.get(parentId);
            if (!parentSprite || parentSprite.isArrivalPending?.()) continue;
            const childSprites = Array.from(childIds || [])
                .map(id => this.agentSprites.get(id))
                .filter(sprite => sprite && !sprite.isArrivalPending?.());
            const departedChildren = (snapshot.recentDepartures || [])
                .filter(item => item.parentSessionId === parentId)
                .map(item => ({
                    id: item.agentId,
                    provider: item.provider,
                    name: item.name,
                }));
            sources.push(...familiarMoteLightSources({
                parentSprite,
                childSprites,
                childAgents: departedChildren,
                now,
                motionScale: this.motionScale,
                lighting,
            }));
        }
        return sources;
    }

    _villageGateLightSources(lighting = null) {
        if (!VILLAGE_GATE) return [];
        const leftBase = this._tileToWorld(VILLAGE_GATE.tileX - VILLAGE_GATE_TOWER_HALF_TILES, VILLAGE_GATE.tileY);
        const rightBase = this._tileToWorld(VILLAGE_GATE.tileX + VILLAGE_GATE_TOWER_HALF_TILES, VILLAGE_GATE.tileY);
        const phaseBoost = Math.max(0.6, lighting?.lightBoost ?? 1);
        return [
            { id: 'left', x: leftBase.x - 9, y: leftBase.y - 13 },
            { id: 'right', x: rightBase.x + 9, y: rightBase.y - 13 },
        ].map((fixture) => normalizeLightSource({
            id: `gate.brazier.${fixture.id}`,
            kind: 'point',
            x: fixture.x,
            y: fixture.y,
            radius: 62,
            color: '#ffd56a',
            intensity: phaseBoost * 0.82,
            buildingType: 'village.gate',
        }));
    }

    _lanternGroundLightSources(lighting = null) {
        const beaconIntensity = Math.max(0, Math.min(1, Number(lighting?.beaconIntensity) || 0));
        if (beaconIntensity <= 0.05) return [];
        return this._lanternGlowSources().map((source) => {
            const isBrazier = source.fixture === 'brazier';
            return normalizeLightSource({
                id: `village.${source.fixture}.${source.tileX}.${source.tileY}`,
                kind: 'point',
                x: source.x,
                y: source.y + 10,
                color: isBrazier ? '#ffb457' : '#ffd56a',
                radius: (isBrazier ? 62 : 52) + beaconIntensity * 6,
                intensity: (isBrazier ? 0.94 : 0.82) + beaconIntensity * 0.12,
            });
        });
    }

    _attentionLightSources() {
        const ledger = signalBuckets(this.world);
        const sources = [];
        for (const [bucket, style] of Object.entries(ATTENTION_LIGHT_STYLES)) {
            for (const agent of ledger[bucket]) {
                const sprite = this.agentSprites.get(agent.id);
                if (!sprite || sprite.isArrivalPending?.()) continue;
                sources.push({
                    ...normalizeLightSource({
                        id: `attention:${bucket}:${agent.id}`,
                        kind: 'point',
                        x: sprite.x,
                        y: sprite.y + 7,
                        radius: style.radius,
                        color: style.color,
                        intensity: style.intensity,
                        priority: GPU_ATTENTION_LIGHT_PRIORITY,
                    }),
                    attention: bucket,
                });
            }
        }
        return sources;
    }

    _computeFrameLightSources(atmosphere = null, now = performance.now()) {
        const lighting = atmosphere?.lighting || null;
        const building = this.buildingRenderer?.getLightSources?.(lighting) || [];
        const ambient = [
            ...this._attentionLightSources(),
            ...building,
            ...relationshipLightSources({
                relationship: this.relationshipState,
                agentSprites: this.agentSprites,
                lighting,
            }),
            ...this._familiarMoteLightSources(lighting),
            ...(this.arrivalDeparture?.getLightSources?.({ now }) || []),
            ...this._villageGateLightSources(lighting),
            ...this._lanternGroundLightSources(lighting),
            ...(this.bridgeLanterns?.getLightSources?.(lighting) || []),
        ];
        return { building, ambient };
    }

    _ambientLightSources(atmosphere = null) {
        if (this._frameLightSources?.ambient) return this._frameLightSources.ambient;
        const { ambient } = this._computeFrameLightSources(atmosphere);
        return ambient;
    }

    _drawAtmosphere(ctx, atmosphere = null, dt = 16, ambientLightSources = null, profileMark = null) {
        const canvas = this._screenViewport();
        if (this._shouldUseFastAtmosphere()) {
            this._drawFastAtmosphereWash(
                ctx,
                canvas,
                atmosphere,
                dt,
                ambientLightSources,
                profileMark,
            );
            return;
        }
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        // E1 — grade the scene by multiplying the cached brightness-multiplier
        // overlay in. Wrapped in its own composite so the passes below stay
        // source-over / screen.
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(this._getAtmosphereVignette(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        ctx.restore();
        profileMark?.('atmosphere-grade');

        // E2/E3 — additive building light glows, shared with the fast path so
        // both draw lanterns identically.
        this._drawLightGlowStamps(ctx, canvas, atmosphere, ambientLightSources);

        this._drawLanternGlows(ctx, canvas, atmosphere);
        profileMark?.('atmosphere-lights');

        ctx.restore();
    }

    // E2/E3 — additive building light-glow pass, extracted so both the full
    // atmosphere path and the fast-atmosphere wash can stamp lanterns. Screen
    // composite plus a low alpha cap keeps the warm cores incandescent against
    // the multiply-graded night without washing out the sprites underneath.
    // `maxCount` bounds the stamp count; the fast path pre-selects the nearest
    // lights and passes them in, the full path passes them all.
    _drawLightGlowStamps(ctx, canvas, atmosphere = null, ambientLightSources = null, maxCount = Infinity) {
        if (!this.buildingRenderer) return;
        const localLightPhase = localLightPhaseForLighting(atmosphere?.lighting);
        if (localLightPhase <= 0.04) return;
        const zoom = this.camera?.zoom || 1;
        const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = this._quantizedAlpha(
            (zoom < 1 ? 0.10 : 0.14) * glowScale * localLightPhase,
        );
        let drawn = 0;
        for (const light of ambientLightSources || this._ambientLightSources(atmosphere)) {
            if (drawn >= maxCount) break;
            if (light.kind && !['point', 'spark', 'orbit', 'arc'].includes(light.kind)) continue;
            const p = this.camera.worldToScreen(light.x, light.y);
            if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
            const radius = light.radius * this.camera.zoom;
            const stamp = this._getLightGlowStamp(light, radius, glowScale * (light.intensity || 1), atmosphere);
            ctx.drawImage(stamp, p.x - radius, p.y - radius, radius * 2, radius * 2);
            drawn++;
        }
        ctx.restore();
    }

    // C3 — warm halos on the baked lantern/brazier props. They darken with the
    // terrain cache at night, so a small radial glow per visible prop restores
    // the torchlight after dusk. Alpha tracks the beacon (night) factor; a faint
    // deterministic flicker plays under motion, static alpha under reduced
    // motion. Only runs in the full atmosphere path (the fast path drops glows
    // by design — that's E3's territory).
    _drawLanternGlows(ctx, canvas, atmosphere = null) {
        const nightFactor = this._lanternNightFactor(atmosphere);
        if (nightFactor <= 0.05) return;
        const sources = this._lanternGlowSources();
        if (!sources.length) return;

        const stamp = this._getLanternGlowStamp();
        const zoom = this.camera?.zoom || 1;
        const radius = Math.max(9, Math.round(14 * zoom));
        const t = this.waterFrame;
        const flickerOn = (this.motionScale ?? 1) > 0;

        ctx.save();
        // E2 — additive so the warm prop halos punch through the multiply grade.
        ctx.globalCompositeOperation = 'screen';
        for (const src of sources) {
            const p = this.camera.worldToScreen(src.x, src.y);
            if (p.x < -radius || p.y < -radius || p.x > canvas.width + radius || p.y > canvas.height + radius) continue;
            const flick = flickerOn ? 0.86 + 0.14 * Math.sin(t * 5 + src.phase) : 1;
            ctx.globalAlpha = this._quantizedAlpha(Math.min(0.5, 0.42 * nightFactor * flick));
            ctx.drawImage(stamp, p.x - radius, p.y - radius, radius * 2, radius * 2);
        }
        ctx.restore();
    }

    // Night factor from the atmosphere's beacon intensity (0 in daylight, rising
    // through dusk to full at night); falls back to inverse ambient light.
    _lanternNightFactor(atmosphere = null) {
        const lighting = atmosphere?.lighting || this._lastAtmosphere?.lighting || null;
        if (!lighting) return 0;
        const beacon = Number(lighting.beaconIntensity);
        if (Number.isFinite(beacon)) return Math.max(0, Math.min(1, beacon));
        const ambient = Number(lighting.ambientLight);
        return Number.isFinite(ambient) ? Math.max(0, Math.min(1, 1 - ambient)) : 0;
    }

    // World-space lantern/brazier positions gathered once from the scenery
    // config (prop.lantern / prop.runeBrazier across the ambient, district, and
    // scenic-point prop sets), lifted to the flame and given a deterministic
    // flicker phase. Memoized — the prop layout never changes at runtime.
    _lanternGlowSources() {
        if (this._lanternGlowSourcesCache) return this._lanternGlowSourcesCache;
        const out = [];
        const push = (tileX, tileY, fixture = 'lantern') => {
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2 - 10; // lift onto the flame
            const phase = (Math.sin(tileX * 12.9898 + tileY * 78.233) * 43758.5453) % (Math.PI * 2);
            out.push({ x, y, phase, fixture, tileX, tileY });
        };
        for (const prop of AMBIENT_GROUND_PROPS) {
            if (prop.type === 'lantern') push(prop.tileX, prop.tileY);
        }
        for (const prop of DISTRICT_PROPS) {
            if (prop.id === 'prop.lantern') push(prop.tileX, prop.tileY);
            if (prop.id === 'prop.runeBrazier') push(prop.tileX, prop.tileY, 'brazier');
        }
        for (const prop of SCENIC_POINT_PROPS) {
            if (prop.id === 'prop.lantern') push(prop.tileX, prop.tileY);
            if (prop.id === 'prop.runeBrazier') push(prop.tileX, prop.tileY, 'brazier');
        }
        this._lanternGlowSourcesCache = out;
        return out;
    }

    // Small cached warm-glow stamp reused for every lantern/brazier halo. Core
    // matches the existing lantern token (#ffd56a) so it reads as torchlight.
    _getLanternGlowStamp() {
        if (this._lanternGlowStamp) return this._lanternGlowStamp;
        const size = 48;
        const stamp = document.createElement('canvas');
        stamp.width = size;
        stamp.height = size;
        const sctx = stamp.getContext('2d');
        const r = size / 2;
        const glow = sctx.createRadialGradient(r, r, 0, r, r, r);
        glow.addColorStop(0, 'rgba(255, 213, 106, 0.90)');  // #ffd56a warm core
        glow.addColorStop(0.5, 'rgba(255, 190, 92, 0.32)');
        glow.addColorStop(1, 'rgba(255, 190, 92, 0)');
        sctx.fillStyle = glow;
        sctx.beginPath();
        sctx.arc(r, r, r, 0, Math.PI * 2);
        sctx.fill();
        this._lanternGlowStamp = stamp;
        return stamp;
    }

    _shouldUseFastAtmosphere() {
        const cssPixels = this._screenWidth() * this._screenHeight();
        return cssPixels >= FAST_ATMOSPHERE_CSS_PIXELS && (this.camera?.zoom || 1) >= 1.5;
    }

    _drawFastAtmosphereWash(
        ctx,
        canvas,
        atmosphere = null,
        dt = 16,
        ambientLightSources = null,
        profileMark = null,
    ) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        // E1 (fast path) — the same multiply grade + radial vignette as the
        // cached overlay path, blitted from a small quarter-size cached stamp
        // (5.1) instead of flat fills + a linear fade, so the frame keeps the
        // same character when the fast path engages mid-zoom. The stamp is
        // stretched with smoothing on: it is a gradient, not pixel art.
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this._getFastVignetteStamp(canvas, atmosphere), 0, 0, canvas.width, canvas.height);
        ctx.restore();
        profileMark?.('atmosphere-grade');

        // E3 — restore light glows on the fast path (previously dropped exactly
        // when zoomed into a building at night), capped at the ~12 nearest.
        this._drawFastPathLightGlows(ctx, canvas, atmosphere, ambientLightSources);
        profileMark?.('atmosphere-lights');

        ctx.restore();
    }

    // 5.1 — quarter-size cached multiply overlay for the fast atmosphere path.
    // The radial vignette uses the same formulas as _getAtmosphereVignette in
    // the stamp's own coordinate space, so the stretched blit matches the
    // full-size overlay's shape at a fraction of the blit cost.
    _getFastVignetteStamp(canvas, atmosphere = null) {
        const width = Math.max(1, Math.round(canvas.width / 4));
        const height = Math.max(1, Math.round(canvas.height / 4));
        const cacheKey = `${width}x${height}|${atmosphere?.cacheKey || 'fallback'}`;
        if (this._fastVignetteStamp && this._fastVignetteStampKey === cacheKey) {
            return this._fastVignetteStamp;
        }

        releaseCanvasBackingStore(this._fastVignetteStamp);
        const stamp = document.createElement('canvas');
        stamp.width = width;
        stamp.height = height;
        const stampCtx = stamp.getContext('2d');
        const phase = atmosphere?.phase || 'day';
        const grade = phaseGradeForCanvas(phase);
        const gradeBase = gradeColorForCanvas(grade.base);
        const gradeEdge = gradeColorForCanvas(grade.edge);
        stampCtx.fillStyle = gradeBase;
        stampCtx.fillRect(0, 0, width, height);
        const vignette = stampCtx.createRadialGradient(
            width * 0.5,
            height * 0.46,
            Math.min(width, height) * 0.18,
            width * 0.5,
            height * 0.5,
            Math.max(width, height) * 0.72,
        );
        vignette.addColorStop(0, this._withAlpha(gradeEdge, 0));
        vignette.addColorStop(0.62, this._withAlpha(gradeEdge, this._quantizedAlpha(grade.edgeAlpha * 0.4)));
        vignette.addColorStop(1, this._withAlpha(gradeEdge, this._quantizedAlpha(grade.edgeAlpha)));
        stampCtx.fillStyle = vignette;
        stampCtx.fillRect(0, 0, width, height);

        this._fastVignetteStamp = stamp;
        this._fastVignetteStampKey = cacheKey;
        return stamp;
    }

    // E3 — pick the nearest visible lights to the viewport centre (after
    // culling) and stamp them via the shared additive helper. No new cache
    // surfaces; reuses _getLightGlowStamp.
    _drawFastPathLightGlows(ctx, canvas, atmosphere = null, ambientLightSources = null) {
        if (!this.buildingRenderer) return;
        const sources = ambientLightSources || this._ambientLightSources(atmosphere);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const visible = [];
        for (const light of sources) {
            if (light.kind && !['point', 'spark', 'orbit', 'arc'].includes(light.kind)) continue;
            const p = this.camera.worldToScreen(light.x, light.y);
            if (p.x < -120 || p.y < -120 || p.x > canvas.width + 120 || p.y > canvas.height + 120) continue;
            visible.push({ light, d2: (p.x - cx) ** 2 + (p.y - cy) ** 2 });
        }
        if (!visible.length) return;
        visible.sort((a, b) => (
            Number(Boolean(b.light.attention)) - Number(Boolean(a.light.attention))
            || (Number(b.light.priority) || 0) - (Number(a.light.priority) || 0)
            || a.d2 - b.d2
        ));
        let protectedCount = 0;
        while (protectedCount < visible.length && visible[protectedCount].light.attention) protectedCount++;
        const nearest = visible.slice(0, Math.max(12, protectedCount)).map(v => v.light);
        this._drawLightGlowStamps(ctx, canvas, atmosphere, nearest);
    }

    _getLightGlowStamp(light, radius, glowScale = 1, atmosphere = null) {
        const dpr = this._screenDpr();
        const phaseBucket = atmosphere?.cacheKey || 'fallback';
        const key = [
            lightSourceCacheKey(light, phaseBucket),
            Math.round(radius),
            this._quantizedAlpha(glowScale),
            dpr,
        ].join('|');
        const cached = this.lightGradientCache.get(key);
        if (cached) {
            this.lightGradientCache.delete(key);
            this.lightGradientCache.set(key, cached);
            return cached;
        }

        const size = Math.max(2, Math.ceil(radius * 2));
        const stampDpr = Math.max(
            0.1,
            Math.min(dpr, Math.sqrt(MAX_LIGHT_GRADIENT_STAMP_PIXELS / Math.max(1, size * size))),
        );
        const stamp = document.createElement('canvas');
        stamp.width = Math.max(1, Math.round(size * stampDpr));
        stamp.height = Math.max(1, Math.round(size * stampDpr));
        const stampPixels = canvasPixelCount(stamp);
        const shouldCache = stampPixels <= MAX_LIGHT_GRADIENT_STAMP_PIXELS;
        if (shouldCache) {
            let retainedPixels = canvasMapPixelCount(this.lightGradientCache);
            while (
                this.lightGradientCache.size > 0 &&
                (this.lightGradientCache.size >= 240 ||
                    retainedPixels + stampPixels > MAX_LIGHT_GRADIENT_CACHE_PIXELS)
            ) {
                const oldestKey = this.lightGradientCache.keys().next().value;
                const oldest = this.lightGradientCache.get(oldestKey);
                retainedPixels -= canvasPixelCount(oldest);
                releaseCanvasBackingStore(oldest);
                this.lightGradientCache.delete(oldestKey);
            }
        }
        const stampCtx = stamp.getContext('2d');
        stampCtx.setTransform(stampDpr, 0, 0, stampDpr, 0, 0);
        const glow = stampCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
        // E2 — hot near-white core so the lantern reads incandescent through the
        // multiply-graded night, fading to the light's own hue and out.
        const core = this._mixToWhite(light.color, 0.6);
        glow.addColorStop(0, this._withAlpha(core, this._quantizedAlpha(0.5 * glowScale)));
        glow.addColorStop(0.35, this._withAlpha(light.color, this._quantizedAlpha(0.25 * glowScale)));
        glow.addColorStop(1, this._withAlpha(light.color, 0));
        stampCtx.fillStyle = glow;
        stampCtx.beginPath();
        stampCtx.arc(radius, radius, radius, 0, Math.PI * 2);
        stampCtx.fill();
        if (shouldCache) this.lightGradientCache.set(key, stamp);
        return stamp;
    }

    _drawLighthouseBeam(ctx, light, atmosphere = null) {
        const signal = (typeof this.harborTraffic?.getActivePushSignal === 'function'
            ? this.harborTraffic.getActivePushSignal()
            : null) || { state: 'idle' };
        const stateName = typeof signal.state === 'string' ? signal.state : 'idle';
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        if (this._beamSignalState !== stateName) {
            this._beamPrevSignalState = this._beamSignalState || 'idle';
            this._beamSignalState = stateName;
            this._beamSignalSince = now;
            this._beamPrevAngle = (typeof this._beamLastIdleAngle === 'number')
                ? this._beamLastIdleAngle
                : -0.34;
        }
        const transitionElapsed = Math.max(0, now - (this._beamSignalSince || now));
        const reducedMotion = this.motionScale <= 0;

        const beaconIntensity = atmosphere?.lighting?.beaconIntensity ?? 0.5;
        const phase = this.motionScale ? this.waterFrame * 0.11 : 0.65;
        const sweep = Math.sin(phase) * 0.28;
        const baseAlpha = (light.alpha ?? 0.12) * (0.45 + beaconIntensity * 0.85) * (light.intensity || 1);
        const length = light.length || 360;
        const farWidth = light.width || 92;
        const nearWidth = Math.max(8, farWidth * 0.13);
        const defaultColor = light.color;

        let primaryAngle = -0.34 + sweep;
        let secondaryAngle = Math.PI - 0.34 + sweep;
        let color = defaultColor;
        let alpha = baseAlpha;
        let lockedSingleBeam = false;

        if (stateName === 'departing' && signal.departingTile) {
            const target = this._tileToWorld(signal.departingTile.tileX, signal.departingTile.tileY);
            const targetAngle = Math.atan2(target.y - light.y, target.x - light.x);
            const lockDuration = 600;
            const t = reducedMotion ? 1 : Math.min(1, transitionElapsed / lockDuration);
            const prev = (typeof this._beamPrevAngle === 'number') ? this._beamPrevAngle : targetAngle;
            const delta = Math.atan2(Math.sin(targetAngle - prev), Math.cos(targetAngle - prev));
            primaryAngle = prev + delta * t;
            secondaryAngle = primaryAngle + Math.PI;
            lockedSingleBeam = true;
            color = (typeof signal.accent === 'string' && signal.accent) ? signal.accent : defaultColor;
        } else if (stateName === 'failed' || stateName === 'rejected') {
            const fallback = stateName === 'failed' ? '#ff755d' : '#ffd34a';
            color = (typeof signal.accent === 'string' && signal.accent) ? signal.accent : fallback;
            if (reducedMotion) {
                alpha = baseAlpha * 0.7;
            } else {
                const strobeOn = Math.floor(transitionElapsed / 200) % 2 === 0;
                alpha = strobeOn ? baseAlpha : 0;
            }
        } else if (stateName === 'untethered') {
            alpha = baseAlpha * 0.4;
            if (this.weatherRenderer && typeof this.weatherRenderer.nudgeFogIntensity === 'function' && !reducedMotion) {
                this.weatherRenderer.nudgeFogIntensity(0.15);
            }
        } else if (stateName === 'pulsing') {
            if (reducedMotion) {
                alpha = baseAlpha * 0.85;
            } else {
                const pulseT = (transitionElapsed % 1500) / 1500;
                const pulse = 0.7 + (Math.sin(pulseT * Math.PI * 2) * 0.5 + 0.5) * 0.3;
                alpha = baseAlpha * pulse;
            }
        }

        if (stateName !== 'departing') {
            this._beamLastIdleAngle = primaryAngle;
        }

        // Punch the beam through fog/rain/storm so it stays legible when the
        // sky is occluded. Multipliers cap at 1.5× alpha and 1.25× bloom; a
        // faint volumetric cone wedge is added at 0.4 alpha to read as light
        // scattering through precipitation. Stacks above the push-signal hue
        // work, inside the same `screen` composite block.
        const weather = atmosphere?.weather;
        let weatherBoost = 1;
        let bloomScale = 1;
        let fogConeAlpha = 0;
        if (weather && (weather.type === 'fog' || weather.type === 'rain' || weather.type === 'storm')) {
            const intensity = Math.max(0, Math.min(1, Number(weather.intensity) || 0));
            if (intensity > 0) {
                weatherBoost = Math.min(1.5, 1 + intensity * 0.6);
                bloomScale = 1 + intensity * 0.25;
                fogConeAlpha = 0.4 * intensity;
            }
        }
        const finalAlpha = alpha * weatherBoost;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 1;
        if (finalAlpha > 0) {
            this._drawBeamWedge(
                ctx, light.x, light.y, primaryAngle, length,
                nearWidth, farWidth, color, finalAlpha, bloomScale,
            );
            if (!lockedSingleBeam) {
                this._drawBeamWedge(
                    ctx, light.x, light.y, secondaryAngle, length * 0.72,
                    nearWidth, farWidth * 0.72, color, finalAlpha * 0.55, bloomScale,
                );
            }
            if (fogConeAlpha > 0) {
                this._drawBeamFogCone(
                    ctx, light.x, light.y, primaryAngle, length,
                    farWidth, fogConeAlpha,
                );
                if (!lockedSingleBeam) {
                    this._drawBeamFogCone(
                        ctx, light.x, light.y, secondaryAngle, length * 0.72,
                        farWidth * 0.72, fogConeAlpha * 0.55,
                    );
                }
            }
        }
        ctx.restore();
    }

    // Faint volumetric cone wedge added on top of the existing beam pass when
    // fog/rain/storm intensity is non-zero. Mirrors the wedge geometry of
    // _drawBeamWedge but uses a white→transparent gradient at low alpha to
    // read as scattered light through weather.
    _drawBeamFogCone(ctx, x, y, angle, length, farWidth, alpha) {
        if (alpha <= 0) return;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const px = -dy;
        const py = dx;
        const farX = x + dx * length;
        const farY = y + dy * length;
        const wedgeWidth = farWidth * 1.10;
        const gradient = ctx.createLinearGradient(x, y, farX, farY);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${this._quantizedAlpha(alpha * 0.85)})`);
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(farX + px * wedgeWidth * 0.5, farY + py * wedgeWidth * 0.5);
        ctx.lineTo(farX - px * wedgeWidth * 0.5, farY - py * wedgeWidth * 0.5);
        ctx.closePath();
        ctx.fill();
    }

    _drawBeamWedge(ctx, x, y, angle, length, nearWidth, farWidth, color, alpha, bloomScale = 1) {
        if (alpha <= 0) return;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const px = -dy;
        const py = dx;
        const farX = x + dx * length;
        const farY = y + dy * length;
        const gradient = ctx.createLinearGradient(x, y, farX, farY);
        gradient.addColorStop(0, this._withAlpha(color, this._quantizedAlpha(alpha * 0.35)));
        gradient.addColorStop(0.58, this._withAlpha(color, this._quantizedAlpha(alpha)));
        gradient.addColorStop(1, this._withAlpha(color, 0));

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x + px * nearWidth * 0.5, y + py * nearWidth * 0.5);
        ctx.lineTo(farX + px * farWidth * 0.5, farY + py * farWidth * 0.5);
        ctx.lineTo(farX - px * farWidth * 0.5, farY - py * farWidth * 0.5);
        ctx.lineTo(x - px * nearWidth * 0.5, y - py * nearWidth * 0.5);
        ctx.closePath();
        ctx.fill();

        // `bloomScale` widens the radial bloom radius under fog/rain/storm
        // so the head of the beam reads through the precipitation.
        const bloomRadius = farWidth * 0.75 * bloomScale;
        const bloom = ctx.createRadialGradient(farX, farY, 0, farX, farY, bloomRadius);
        bloom.addColorStop(0, this._withAlpha(color, this._quantizedAlpha(alpha * 0.28)));
        bloom.addColorStop(1, this._withAlpha(color, 0));
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.ellipse(farX, farY, farWidth * 0.72 * bloomScale, farWidth * 0.22 * bloomScale, angle, 0, Math.PI * 2);
        ctx.fill();
    }

    _getAtmosphereVignette(canvas, atmosphere = null) {
        const dpr = this._screenDpr();
        const cacheKey = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere?.cacheKey || 'fallback'}`;
        if (this.atmosphereVignetteCache && this.atmosphereVignetteCacheKey === cacheKey) {
            return this.atmosphereVignetteCache;
        }

        releaseCanvasBackingStore(this.atmosphereVignetteCache);
        const overlay = document.createElement('canvas');
        overlay.width = Math.max(1, Math.round(canvas.width * dpr));
        overlay.height = Math.max(1, Math.round(canvas.height * dpr));
        const overlayCtx = overlay.getContext('2d');
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const phase = atmosphere?.phase || 'day';

        // E1 — the overlay is a brightness *multiplier*, blitted with a
        // `multiply` composite in _drawAtmosphere. Every pixel is an opaque
        // multiplier colour: near-white leaves the scene untouched, darker/warm
        // values grade it. Painting the opaque base first, then a
        // transparent→dark radial, keeps the whole overlay opaque while
        // darkening toward the edges (the vignette).
        const grade = phaseGradeForCanvas(phase);
        const gradeBase = gradeColorForCanvas(grade.base);
        const gradeEdge = gradeColorForCanvas(grade.edge);
        overlayCtx.fillStyle = gradeBase;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        const vignette = overlayCtx.createRadialGradient(
            canvas.width * 0.5,
            canvas.height * 0.46,
            Math.min(canvas.width, canvas.height) * 0.18,
            canvas.width * 0.5,
            canvas.height * 0.5,
            Math.max(canvas.width, canvas.height) * 0.72,
        );
        vignette.addColorStop(0, this._withAlpha(gradeEdge, 0));
        vignette.addColorStop(0.62, this._withAlpha(gradeEdge, this._quantizedAlpha(grade.edgeAlpha * 0.4)));
        vignette.addColorStop(1, this._withAlpha(gradeEdge, this._quantizedAlpha(grade.edgeAlpha)));
        overlayCtx.fillStyle = vignette;
        overlayCtx.fillRect(0, 0, canvas.width, canvas.height);

        this.atmosphereVignetteCache = overlay;
        this.atmosphereVignetteCacheKey = cacheKey;
        return overlay;
    }

    getWorldPerformanceDiagnostics() {
        const liveSpriteCanvases = new Set();
        for (const sprite of this.agentSprites.values()) {
            if (sprite?.spriteCanvas) liveSpriteCanvases.add(sprite.spriteCanvas);
        }
        let liveSpriteCanvasPixels = 0;
        for (const canvas of liveSpriteCanvases) liveSpriteCanvasPixels += canvasPixelCount(canvas);
        return {
            frameFailures: {
                ...this._frameFailureStats,
                byStage: { ...this._frameFailureStats.byStage },
                reportIntervalMs: WORLD_FRAME_ERROR_REPORT_INTERVAL_MS,
                maxConsecutive: WORLD_FRAME_MAX_CONSECUTIVE_FAILURES,
            },
            boundedState: {
                lightFadeColors: this.lightFadeColorCache?.size || 0,
                lightFadeColorLimit: LIGHT_FADE_COLOR_CACHE_LIMIT,
                lightFadeColorEvictions: this._lightFadeColorCacheEvictions,
                lightColorRgbEntries: this.lightColorRgbCache?.size || 0,
                lightColorRgbLimit: LIGHT_COLOR_RGB_CACHE_LIMIT,
                lightColorRgbEvictions: this._lightColorRgbCacheEvictions,
                crowdBumpCooldowns: this._crowdBumpCooldowns.size,
                crowdBumpCooldownLimit: CROWD_BUMP_COOLDOWN_LIMIT,
                nicknames: this._nicknames.size,
                nicknameLimit: NICKNAME_CACHE_LIMIT,
                liveSpriteCanvases: liveSpriteCanvases.size,
                liveSpriteCanvasPixels,
            },
            waterDescriptors: {
                total: this._waterTileDescriptors?.length || 0,
                currentEligible: this._waterTileDescriptors?.filter?.(tile => tile.animatedCurrentEligible).length || 0,
            },
            harbor: this.harborTraffic?.getDiagnostics?.() || null,
            trails: this.trailRenderer?.getDiagnostics?.() || null,
            events: this.agentEventStream?.getDiagnostics?.() || null,
            landmarks: this.landmarkActivity?.getDiagnostics?.() || null,
            monuments: this.chronicleMonuments?.getDiagnostics?.() || null,
            visits: this.visitIntentManager?.getDiagnostics?.() || null,
            allocator: this.visitTileAllocator?.getDiagnostics?.() || null,
            relationships: this.relationshipState?.getDiagnostics?.() || null,
            council: getCouncilRingDiagnostics(this.relationshipState),
            pathfinder: this.pathfinder?.getDiagnostics?.() || null,
            gpuWorld: this.gpuWorld?.getDiagnostics?.() || null,
            worldRendererMode: this.worldRendererMode,
        };
    }

    getCanvasBudget() {
        const sky = this.skyRenderer?.getCanvasBudget?.() || {};
        const trail = this.trailRenderer?.getCanvasBudget?.() || {};
        const postFxFeed = this.postFxFeed?.getCanvasBudget?.() || {};
        const postFxResources = this.postFx?.getResourceAccounting?.() || gpuResourceAccounting();
        const gpuWorldResources = this.gpuWorld?.getResourceAccounting?.() || {
            textures: {},
            attachments: {},
            buffers: {},
        };
        const gpuResources = gpuResourceAccounting({
            textures: {
                ...Object.fromEntries(Object.entries(postFxResources.textures || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.textures || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
            attachments: {
                ...Object.fromEntries(Object.entries(postFxResources.attachments || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.attachments || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
            buffers: {
                ...Object.fromEntries(Object.entries(postFxResources.buffers || {}).map(([name, bytes]) => [`postfx.${name}`, bytes])),
                ...Object.fromEntries(Object.entries(gpuWorldResources.buffers || {}).map(([name, bytes]) => [`gpuWorld.${name}`, bytes])),
            },
        });
        const volatile = {
            terrain: canvasPixelCount(this.terrainCache),
            sky: sky.volatilePixels || 0,
            trail: trail.volatilePixels || 0,
            postFxMask: postFxFeed.volatilePixels || 0,
            atmosphere: canvasPixelCount(this.atmosphereVignetteCache),
            lightGradients: canvasMapPixelCount(this.lightGradientCache),
            gpuAgentAtlas: canvasPixelCount(this._gpuAgentFrameAtlas),
            gpuAgentMaterialAtlas: canvasPixelCount(this._gpuAgentMaterialAtlas),
            gpuAgentEmissiveAtlas: canvasPixelCount(this._gpuAgentEmissiveAtlas),
            gpuAgentOccluderAtlas: canvasPixelCount(this._gpuAgentOccluderAtlas),
            semanticGround: canvasPixelCount(this._semanticGroundCanvas),
            gpuAgentAtlasUpdateSlots: canvasMapPixelCount(this._gpuAgentAlbedoUpdateCanvases)
                + canvasMapPixelCount(this._gpuAgentMaterialUpdateCanvases)
                + canvasMapPixelCount(this._gpuAgentEmissiveUpdateCanvases)
                + canvasMapPixelCount(this._gpuAgentOccluderUpdateCanvases),
        };
        const volatilePixels = Object.values(volatile).reduce((sum, value) => sum + value, 0);
        const visibleCanvasPixels = canvasPixelCount(this.canvas);
        const overlayCanvasPixels = canvasPixelCount(this.overlayCanvas);
        const retainedAssetPixels = this.foliageRenderer?.getRetainedPixels?.() || 0;
        const resources = unifiedRendererResourceAccounting({
            visibleCanvasPixels: visibleCanvasPixels + overlayCanvasPixels,
            volatileCanvasPixels: volatilePixels,
            retainedCanvasPixels: retainedAssetPixels,
            gpu: gpuResources,
        });
        return {
            budgets: CANVAS_BUDGET,
            dpr: this._screenDpr(),
            running: this.running,
            worldModeActive: this._worldModeActive,
            worldResourcesSuspended: this._worldResourcesSuspended,
            worldResumeInFlight: this._worldResumePromise !== null,
            worldResumeFailures: this._worldResumeFailures,
            rafPending: this.frameId !== null,
            visibleCanvasPixels,
            volatile,
            volatilePixels,
            retainedAssetPixels,
            domCanvasPixels: canvasPixelCount(this.fxCanvas) + overlayCanvasPixels,
            resources,
            cacheCounts: {
                lightGradients: this.lightGradientCache?.size || 0,
                lightFadeColors: this.lightFadeColorCache?.size || 0,
                lightColorRgb: this.lightColorRgbCache?.size || 0,
                fantasyForestTrees: this.foliageRenderer?.cacheSize || 0,
            },
            cacheStats: {
                assets: this.assets?.cacheStats?.() || null,
                compositor: this.compositor?.cacheStats?.() || null,
                agentSprites: AgentSprite.sharedCacheStats?.() || null,
            },
            gpu: this.gpuWorld?.getDiagnostics?.() || null,
            terrainCache: this.getTerrainCacheDiagnostics(),
            runtime: this.getWorldPerformanceDiagnostics(),
        };
    }

    _drawAtmosphereDebug(ctx, atmosphere) {
        if (!atmosphere) return;
        const lighting = atmosphere.lighting || {};
        const motion = atmosphere.motion || {};
        const clock = atmosphere.clock || {};
        const weather = atmosphere.weather || {};
        const reactions = atmosphere.reactions || {};
        const lines = [
            `ATM ${atmosphere.phase} ${(atmosphere.phaseProgress || 0).toFixed(2)}`,
            `CLOCK ${clock.label || '--:--'}:${String(clock.seconds ?? 0).padStart(2, '0')}  MIN ${Math.floor(clock.minuteOfDay ?? 0)}`,
            `WX ${weather.type || 'clear'} ${(weather.intensity || 0).toFixed(2)} R${(weather.precipitation || 0).toFixed(2)} F${(weather.fog || 0).toFixed(2)}  WIND ${motion.windX ?? 0}`,
            `LIGHT A${(lighting.ambientLight ?? 1).toFixed(2)} S${(lighting.shadowAlpha ?? 0).toFixed(2)} B${(lighting.lightBoost ?? 1).toFixed(2)}`,
            `REACT P${(reactions.puddleAlpha || 0).toFixed(2)} W${(reactions.windowWarmth || 0).toFixed(2)} G${(reactions.warmGlint || 0).toFixed(2)}`,
            `MOTION D${motion.driftEnabled ? 1 : 0} P${motion.particleEnabled ? 1 : 0}`,
            `RITUALS ${(this.ritualConductor?.getSnapshot?.() || []).length} OVER ${this.ritualConductor?.getOverflowCount?.() || 0}`,
            `SKY ${atmosphere.cacheKey}`,
        ];
        const panelHeight = 16 + lines.length * 14;
        ctx.save();
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(4, 10, 18, 0.72)';
        ctx.fillRect(12, 58, 520, panelHeight);
        ctx.strokeStyle = 'rgba(142, 204, 255, 0.48)';
        ctx.strokeRect(12.5, 58.5, 520, panelHeight);
        ctx.fillStyle = '#cce9ff';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 20, 66 + i * 14);
        }
        ctx.restore();
    }

    _quantizedAlpha(value) {
        return Math.max(
            0,
            Math.min(1, Math.round((Number(value) || 0) * LIGHT_COLOR_QUANTIZATION_STEPS) / LIGHT_COLOR_QUANTIZATION_STEPS),
        );
    }

    _quantizedColorMix(value) {
        return Math.max(
            0,
            Math.min(1, Math.round((Number(value) || 0) * LIGHT_COLOR_MIX_STEPS) / LIGHT_COLOR_MIX_STEPS),
        );
    }

    _cacheLightFadeColor(key, value) {
        if (!this.lightFadeColorCache.has(key) && this.lightFadeColorCache.size >= LIGHT_FADE_COLOR_CACHE_LIMIT) {
            this.lightFadeColorCache.delete(this.lightFadeColorCache.keys().next().value);
            this._lightFadeColorCacheEvictions++;
        }
        this.lightFadeColorCache.set(key, value);
        return value;
    }

    // Cache `color` → rgba(r,g,b,a) strings keyed by `${color}|${alpha}` so the
    // light pass doesn't re-parse colors per frame.
    _withAlpha(color, alpha) {
        const normalizedColor = String(color || '#ffffff');
        const normalizedAlpha = this._quantizedAlpha(alpha);
        const key = `${normalizedColor}|${normalizedAlpha}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        const [r, g, b] = this._parseLightColor(normalizedColor);
        const out = `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
        return this._cacheLightFadeColor(key, out);
    }

    // Mix a colour toward white by `t` (0 = unchanged, 1 = white). Used for the
    // hot light-glow cores; memoized in the shared colour cache.
    _mixToWhite(color, t) {
        const normalizedColor = String(color || '#ffffff');
        const mixAmount = this._quantizedColorMix(t);
        const key = `mw|${normalizedColor}|${mixAmount}`;
        if (this.lightFadeColorCache.has(key)) return this.lightFadeColorCache.get(key);
        const [r, g, b] = this._parseLightColor(normalizedColor);
        const mix = (c) => Math.round(c + (255 - c) * mixAmount);
        const out = `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
        return this._cacheLightFadeColor(key, out);
    }

    _parseLightColor(color) {
        const key = String(color || '#ffffff');
        const cached = this.lightColorRgbCache.get(key);
        if (cached) return cached;
        let rgb = [255, 255, 255];
        if (key.startsWith('#') && key.length === 7) {
            rgb = [
                parseInt(key.slice(1, 3), 16),
                parseInt(key.slice(3, 5), 16),
                parseInt(key.slice(5, 7), 16),
            ];
        } else {
            const match = key.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (match) rgb = [+match[1], +match[2], +match[3]];
        }
        if (this.lightColorRgbCache.size >= LIGHT_COLOR_RGB_CACHE_LIMIT) {
            this.lightColorRgbCache.delete(this.lightColorRgbCache.keys().next().value);
            this._lightColorRgbCacheEvictions++;
        }
        this.lightColorRgbCache.set(key, rgb);
        return rgb;
    }

    _drawAncientRuins(ctx) {
        const pulse = this.motionScale ? (Math.sin(this.waterFrame * 1.7) + 1) / 2 : 0.45;
        for (const ruin of ANCIENT_RUINS) {
            if (this.waterTiles.has(`${Math.floor(ruin.tileX)},${Math.floor(ruin.tileY)}`)) continue;
            const x = (ruin.tileX - ruin.tileY) * TILE_WIDTH / 2;
            const y = (ruin.tileX + ruin.tileY) * TILE_HEIGHT / 2;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(ruin.scale, ruin.scale);
            ctx.fillStyle = 'rgba(59, 53, 42, 0.62)';
            ctx.fillRect(-18, -28, 8, 31);
            ctx.fillRect(10, -24, 8, 27);
            ctx.fillRect(-18, -30, 36, 7);
            ctx.fillStyle = 'rgba(163, 147, 104, 0.35)';
            ctx.fillRect(-15, -25, 3, 24);
            ctx.fillRect(13, -21, 3, 22);
            ctx.strokeStyle = `rgba(201, 242, 107, ${0.08 + pulse * 0.14})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(0, -11, 14, Math.PI * 1.08, Math.PI * 1.92);
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawAmbientGroundProps(ctx) {
        ctx.save();
        this._drawAncientRuins(ctx);
        if (this.sprites) {
            for (const prop of AMBIENT_GROUND_PROPS) {
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                const id = `prop.${prop.type}`;
                this._drawPropContactShadow(ctx, x, y, id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, id, x, y);
            }
            for (const prop of DISTRICT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y);
            }
            // #41 — scenic-point storytelling props baked alongside the other
            // cache props so each loiter spot reads as an inhabited place.
            for (const prop of SCENIC_POINT_PROPS) {
                if (prop.layer !== 'cache') continue;
                const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
                const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
                this._drawPropContactShadow(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                this.sprites.drawSprite(ctx, prop.id, x, y);
            }
        }

        for (const prop of this.commandCenterGroundProps) {
            const x = (prop.tileX - prop.tileY) * TILE_WIDTH / 2;
            const y = (prop.tileX + prop.tileY) * TILE_HEIGHT / 2;
            if (prop.type === 'watchfire') this._drawCommandWatchfire(ctx, x, y, prop.phase || 0);
            else if (prop.type === 'guardpost') this._drawCommandGuardpost(ctx, x, y);
        }
        ctx.restore();
    }

    // 2.9 — prop contact shadow: a small soft ellipse at the prop's anchor so
    // props ground like buildings do. Land tiles only — water-surface props
    // (buoys, lilypads) take no shadow.
    _drawPropContactShadow(ctx, x, y, id, tileX, tileY) {
        if (this.waterTiles?.has(`${Math.floor(tileX)},${Math.floor(tileY)}`)) return;
        const dims = this.assets?.getDims?.(id);
        const halfW = Math.min(16, Math.max(6, (dims?.w || 24) * 0.22));
        ctx.save();
        ctx.fillStyle = 'rgba(16, 20, 12, 0.24)';
        ctx.beginPath();
        ctx.ellipse(Math.round(x), Math.round(y + 1), halfW, halfW * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawCommandApproachRoadDetail(ctx, screenX, screenY, seed, tileX, tileY) {
        const sweep = (tileX + tileY + seed * 8) * 0.35;
        ctx.strokeStyle = `rgba(255, 224, 126, ${0.16 + Math.sin(this.waterFrame * 0.8 + sweep) * 0.05 + 0.06})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - 9, screenY - 1 + Math.sin(sweep) * 0.8);
        ctx.lineTo(screenX + 9, screenY - 2 - Math.sin(sweep) * 0.7);
        ctx.stroke();
        if (this.motionScale > 0 && ((tileX + tileY + seed) % 2.8) < 1.2) {
            ctx.fillStyle = 'rgba(255, 191, 91, 0.18)';
            ctx.beginPath();
            ctx.arc(screenX, screenY - 4, 1.6, 0, Math.PI * 2);
            ctx.fill();
        }

        if (this.motionScale > 0 && ((tileX + tileY) % 8 === 0)) {
            const x = screenX + ((seed - 0.5) * 4);
            const y = screenY + ((seed - 0.5) * 2);
            this._drawCommandGuardpost(ctx, x, y);
        }
    }

    _drawCommandWatchfire(ctx, x, y, phase = 0) {
        const flicker = this.motionScale ? Math.max(0, Math.sin(this.waterFrame * 7 + phase)) : 0.5;
        ctx.fillStyle = 'rgba(44, 30, 17, 0.6)';
        ctx.fillRect(x - 2, y - 12, 4, 10);

        // Ember bed reads as a pixel pool; the flame uses the shared taper.
        fillPixelEllipse(ctx, x, y - 12, 8 + flicker * 2, 4,
            `rgba(255, 132, 37, ${(0.12 + flicker * 0.08).toFixed(3)})`);
        drawPixelFlame(ctx, x, y - 11, 8 + flicker * 4, 3, {
            outer: `rgba(255, 132, 37, ${(0.62 + flicker * 0.24).toFixed(3)})`,
            inner: `rgba(255, 216, 122, ${(0.72 + flicker * 0.20).toFixed(3)})`,
            tip: `rgba(255, 245, 210, ${(0.60 + flicker * 0.24).toFixed(3)})`,
            lean: this.motionScale ? Math.sin(this.waterFrame * 2.1 + phase) * 1.2 : 0,
        });
    }

    _drawCommandGuardpost(ctx, x, y) {
        ctx.fillStyle = 'rgba(64, 45, 27, 0.85)';
        ctx.fillRect(x - 1.2, y - 11, 2.4, 11);
        ctx.fillStyle = 'rgba(154, 116, 59, 0.72)';
        ctx.fillRect(x - 7, y - 4, 14, 2.8);
        ctx.fillRect(x - 2, y - 8, 4, 1.5);
        ctx.fillStyle = 'rgba(230, 206, 146, 0.26)';
        ctx.beginPath();
        ctx.arc(x, y - 11, 1.4, 0, Math.PI * 2);
        ctx.fill();
    }

}
