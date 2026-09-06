import { eventBus } from '../../domain/events/DomainEvent.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';
import { drawCouncilRings, drawFamilyTethers, drawAdvisorTethers, drawAllyTethers, drawTalkArcs, admitTalkArcMarks } from './CouncilRing.js';
import { drawCrowdClusterAuras, drawCrowdClusterBadges } from './CrowdClusterOverlay.js';
import { drawSharedFileKnot, drawSharedFileOverlapLabel } from './SharedFileKnot.js';
import {
    appendDepthSortedDrawables,
    cullDepthSortedDrawables,
    drawDepthSortedDrawables,
    drawSceneCategoryOverlays,
    summarizeDrawableLayers,
} from './DrawablePass.js';
import {
    drawVillageDirectorGround,
    drawVillageDirectorOverlays,
    drawVillageDirectorScreen,
    drawPrimaryPillRestamp,
    drawOffscreenCueEdges,
} from './VillageDirectorOverlay.js';
import { worldSceneCategoryRegistry } from './SceneCategoryRegistry.js';
import { buildGpuWorldRecords } from './gpu/GpuSceneBuilder.js';
import { createBoundedRing, writeBoundedRing } from '../shared/ClientPerfMetrics.js';
import { drawWorkScoreGround, drawWorkScoreScreen } from './SpatialWorkScore.js';
import { ornamentPlan, sampleFramePressure } from './MarkGovernor.js';

const FRAME_TIMING_RING_CAPACITY = 90;
const FRAME_TIMER_MAX_MARKS = 48;
const CANVAS_SCENE_BACKEND = Object.freeze({ id: 'canvas-2d', canvasFallback: true });
// 3.5 — the authored palette-ramp table (11x3 RGBA, nearest-sampled). Declared
// in the sprite manifest like every other asset; absent means the Command
// pilot keeps today's additive light response.
export const PALETTE_RAMP_ASSET_ID = 'lut.light-ramp.command';

// Quarter-res occupancy field, matching the PostFx water-mask budget. One
// byte per sample; the renderer paints it into a reused quarter-res canvas
// only when the pose/viewport/atmosphere key changes.
export const HAZE_FIELD_SCALE = 0.25;
export const HAZE_FIELD_BYTES_PER_SAMPLE = 1;
export const HAZE_ALPHA_CAP = 0.16;
export const HAZE_WATER_FALLOFF_PX = 220;
export const HAZE_LOWLAND_FALLOFF_PX = 160;
export const HAZE_ROAD_CARVE_RADIUS_PX = 28;
export const HAZE_SUBJECT_CARVE_RADIUS_PX = 42;
export const HAZE_ROAD_CARVE = 0.12;
export const HAZE_SUBJECT_CARVE = 0.18;
export const WETNESS_ATTACK_MS = 480;
export const WETNESS_RELEASE_MS = 4000;
export const DAMP_MARK_LIMIT = 24;
export const DAMP_MATERIAL_MULTIPLIER = Object.freeze({
    roof: 1,
    dock: 1.12,
    stone: 0.82,
    road: 0.7,
    fire: 0,
    emissive: 0,
});

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function isoFromTileKey(key, tileWidth = TILE_WIDTH, tileHeight = TILE_HEIGHT) {
    const text = String(key || '');
    const comma = text.indexOf(',');
    if (comma < 0) return null;
    const tileX = Number(text.slice(0, comma));
    const tileY = Number(text.slice(comma + 1));
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return {
        tileX,
        tileY,
        x: (tileX - tileY) * tileWidth / 2,
        y: (tileX + tileY) * tileHeight / 2,
    };
}

export function isoFromTile(tileX, tileY, tileWidth = TILE_WIDTH, tileHeight = TILE_HEIGHT) {
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return {
        tileX,
        tileY,
        x: (tileX - tileY) * tileWidth / 2,
        y: (tileX + tileY) * tileHeight / 2,
    };
}

export function hazeFieldSampleCount(viewportWidth, viewportHeight, scale = HAZE_FIELD_SCALE) {
    const width = Math.max(1, Math.ceil(Math.max(0, Number(viewportWidth) || 0) * scale));
    const height = Math.max(1, Math.ceil(Math.max(0, Number(viewportHeight) || 0) * scale));
    return width * height;
}

export function hazeFieldMemoryBytes(viewportWidth, viewportHeight, scale = HAZE_FIELD_SCALE) {
    return hazeFieldSampleCount(viewportWidth, viewportHeight, scale) * HAZE_FIELD_BYTES_PER_SAMPLE;
}

export function hazePlanForPressure(level = 0, motionScale = 1) {
    const reduced = Number(motionScale) <= 0;
    const plan = ornamentPlan({ level, motionScale: reduced ? 0 : 1 });
    const shed = plan.ambientWeatherEmbellishment === 'off';
    return {
        density: shed ? 0.36 : 1,
        detail: shed ? 0 : 1,
        fieldScale: shed ? 0.125 : HAZE_FIELD_SCALE,
        static: reduced,
        rebuild: !reduced,
        pressureLevel: Number(level) || 0,
    };
}

export function hazeFieldCacheKey({
    camera = null,
    viewport = null,
    atmosphereBucket = '',
    pressureLevel = 0,
    focusedId = '',
    fieldScale = HAZE_FIELD_SCALE,
} = {}) {
    const x = Math.round((Number(camera?.x) || 0) * 2) / 2;
    const y = Math.round((Number(camera?.y) || 0) * 2) / 2;
    const z = Math.round((Number(camera?.zoom) || 1) * 100);
    const vw = Math.round(Number(viewport?.width) || 0);
    const vh = Math.round(Number(viewport?.height) || 0);
    return `${x}|${y}|${z}|${vw}x${vh}|${atmosphereBucket}|p${pressureLevel}|f${focusedId || ''}|s${fieldScale}`;
}

export function shouldRebuildHazeField(previousKey, nextKey, { motionScale = 1, hasField = false } = {}) {
    if (!nextKey) return false;
    if (previousKey === nextKey) return false;
    if (Number(motionScale) <= 0 && hasField) return false;
    return true;
}

export function collectHazeAnchors({
    waterTiles = [],
    waterMeta = null,
    lowlandPoints = [],
    waterBucketSize = 9,
    waterLimit = 6,
    tileWidth = TILE_WIDTH,
    tileHeight = TILE_HEIGHT,
} = {}) {
    const buckets = new Map();
    for (const key of waterTiles || []) {
        const iso = isoFromTileKey(key, tileWidth, tileHeight);
        if (!iso) continue;
        const bucketKey = `${Math.floor(iso.tileX / waterBucketSize)},${Math.floor(iso.tileY / waterBucketSize)}`;
        const bucket = buckets.get(bucketKey) || { n: 0, sx: 0, sy: 0, weight: 0 };
        bucket.n += 1;
        bucket.sx += iso.tileX;
        bucket.sy += iso.tileY;
        const meta = waterMeta?.get?.(key) || null;
        const region = meta?.region || meta?.weatherProfile || '';
        bucket.weight += region === 'lagoon' ? 1.2 : region === 'harbor' ? 1.1 : 1;
        buckets.set(bucketKey, bucket);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, waterLimit);
    const anchors = [];
    for (const bucket of ranked) {
        const tileX = bucket.sx / bucket.n;
        const tileY = bucket.sy / bucket.n;
        const iso = isoFromTile(tileX, tileY, tileWidth, tileHeight);
        if (!iso) continue;
        anchors.push({
            x: iso.x,
            y: iso.y,
            kind: 'water',
            weight: Math.min(1.35, bucket.weight / bucket.n),
            seed: (bucket.n % 7) / 7,
        });
    }
    for (let i = 0; i < (lowlandPoints || []).length; i++) {
        const point = lowlandPoints[i];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        anchors.push({
            x: point.x,
            y: point.y,
            kind: 'lowland',
            weight: 0.72,
            seed: i === 0 ? 0.31 : 0.67,
        });
    }
    return { anchors };
}

export function collectRoadCarvePoints({
    pathTiles = [],
    mainAvenueTiles = [],
    dirtPathTiles = [],
    commandCenterRoadTiles = [],
    stride = 4,
    limit = 28,
    tileWidth = TILE_WIDTH,
    tileHeight = TILE_HEIGHT,
} = {}) {
    const points = [];
    const seen = new Set();
    const ingest = (tiles, extraStride = 0) => {
        if (!tiles) return;
        let index = 0;
        const step = Math.max(1, stride + extraStride);
        for (const key of tiles) {
            if ((index++ % step) !== 0) continue;
            if (seen.has(key)) continue;
            const iso = isoFromTileKey(key, tileWidth, tileHeight);
            if (!iso) continue;
            seen.add(key);
            points.push({ x: iso.x, y: iso.y, key });
            if (points.length >= limit) return;
        }
    };
    ingest(mainAvenueTiles, 0);
    ingest(commandCenterRoadTiles, 1);
    ingest(pathTiles, 1);
    ingest(dirtPathTiles, 2);
    return points;
}

export function lowlandPointsFromDiamond(points) {
    if (!Array.isArray(points) || points.length < 4) return [];
    const bottom = points[2];
    const left = points[3];
    const right = points[1];
    if (!bottom || !left || !right) return [];
    return [
        { x: (bottom.x + left.x) / 2, y: (bottom.y + left.y) / 2 },
        { x: (bottom.x + right.x) / 2, y: (bottom.y + right.y) / 2 },
    ];
}

function isoDistance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = (ay - by) * 2;
    return Math.hypot(dx, dy);
}

export function hazeOccupancyAtWorld(worldX, worldY, {
    anchors = [],
    roads = [],
    focused = null,
} = {}) {
    let occupancy = 0;
    for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const falloff = anchor.kind === 'lowland' ? HAZE_LOWLAND_FALLOFF_PX : HAZE_WATER_FALLOFF_PX;
        const dist = isoDistance(worldX, worldY, anchor.x, anchor.y);
        const contrib = (anchor.weight || 1) * Math.max(0, 1 - dist / falloff);
        if (contrib > occupancy) occupancy = contrib;
    }
    occupancy = Math.min(1, occupancy);
    for (let i = 0; i < roads.length; i++) {
        const road = roads[i];
        const dist = isoDistance(worldX, worldY, road.x, road.y);
        if (dist >= HAZE_ROAD_CARVE_RADIUS_PX) continue;
        const t = 1 - dist / HAZE_ROAD_CARVE_RADIUS_PX;
        occupancy *= 1 - t * (1 - HAZE_ROAD_CARVE);
    }
    if (focused && Number.isFinite(focused.x) && Number.isFinite(focused.y)) {
        const dist = isoDistance(worldX, worldY, focused.x, focused.y);
        if (dist < HAZE_SUBJECT_CARVE_RADIUS_PX) {
            const t = 1 - dist / HAZE_SUBJECT_CARVE_RADIUS_PX;
            occupancy *= 1 - t * (1 - HAZE_SUBJECT_CARVE);
        }
    }
    return occupancy;
}

export function hazeDensityAtWorld(worldX, worldY, options = {}) {
    const alphaCap = Number.isFinite(Number(options.alphaCap)) ? Number(options.alphaCap) : HAZE_ALPHA_CAP;
    const occupancy = hazeOccupancyAtWorld(worldX, worldY, options);
    return Math.min(alphaCap, occupancy * alphaCap);
}

export function projectWorldToScreen(camera, worldX, worldY) {
    const zoom = Number(camera?.zoom) || 1;
    return {
        x: (worldX + (Number(camera?.x) || 0)) * zoom,
        y: (worldY + (Number(camera?.y) || 0)) * zoom,
    };
}

export function projectScreenToWorld(camera, screenX, screenY) {
    const zoom = Number(camera?.zoom) || 1;
    return {
        x: screenX / zoom - (Number(camera?.x) || 0),
        y: screenY / zoom - (Number(camera?.y) || 0),
    };
}

export function projectHazeField({
    anchors = [],
    roads = [],
    focused = null,
    camera = { x: 0, y: 0, zoom: 1 },
    viewport = { width: 1280, height: 720 },
    scale = HAZE_FIELD_SCALE,
    strength = 1,
    densityScale = 1,
    alphaCap = HAZE_ALPHA_CAP,
} = {}) {
    const width = Math.max(1, Math.ceil(Math.max(0, Number(viewport.width) || 0) * scale));
    const height = Math.max(1, Math.ceil(Math.max(0, Number(viewport.height) || 0) * scale));
    const samples = new Uint8Array(width * height);
    const invScale = 1 / scale;
    const gain = clamp01(strength) * clamp01(densityScale);
    for (let y = 0; y < height; y++) {
        const sy = (y + 0.5) * invScale;
        for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) * invScale;
            const world = projectScreenToWorld(camera, sx, sy);
            const occupancy = hazeOccupancyAtWorld(world.x, world.y, { anchors, roads, focused });
            samples[y * width + x] = Math.round(Math.min(1, occupancy * gain) * 255);
        }
    }
    return {
        width,
        height,
        scale,
        samples,
        bytes: samples.length * HAZE_FIELD_BYTES_PER_SAMPLE,
        alphaCap,
    };
}

export function sampleHazeField(field, screenX, screenY) {
    if (!field?.samples || !field.width || !field.height) return 0;
    const scale = field.scale || HAZE_FIELD_SCALE;
    const x = Math.floor(screenX * scale);
    const y = Math.floor(screenY * scale);
    if (x < 0 || y < 0 || x >= field.width || y >= field.height) return 0;
    return field.samples[y * field.width + x] / 255;
}

export function advanceSurfaceWetness(current = 0, {
    precipitation = 0,
    dt = 16,
    weatherType = 'clear',
} = {}) {
    const wetness = clamp01(current);
    const precip = clamp01(precipitation);
    const raining = precip > 0.04 || weatherType === 'rain' || weatherType === 'storm';
    const frameDt = Math.max(0, Number(dt) || 0);
    if (raining) {
        const attack = frameDt / WETNESS_ATTACK_MS;
        return clamp01(wetness + Math.max(precip, 0.35) * attack);
    }
    return clamp01(wetness - frameDt / WETNESS_RELEASE_MS);
}

export function dampMaterialMultiplier(material) {
    return DAMP_MATERIAL_MULTIPLIER[material] ?? 0;
}

export function dampMarkAlpha(wetness, material, seed = 0.5) {
    const multiplier = dampMaterialMultiplier(material);
    if (multiplier <= 0) return 0;
    return Math.min(0.22, clamp01(wetness) * multiplier * (0.45 + clamp01(seed) * 0.35));
}

export function applySurfaceWetnessToReactions(reactions = {}, wetness = 0) {
    const w = clamp01(wetness);
    return {
        ...reactions,
        surfaceWetness: w,
        puddleAlpha: Math.max(Number(reactions.puddleAlpha) || 0, w * 0.38),
        roofGlintAlpha: Math.max(Number(reactions.roofGlintAlpha) || 0, w * 0.18),
    };
}

export function collectDampMarks({
    roads = [],
    docks = [],
    roofs = [],
    footings = [],
    wetness = 0,
    limit = DAMP_MARK_LIMIT,
    layer = 'all',
} = {}) {
    if (clamp01(wetness) <= 0.03) return [];
    const marks = [];
    const take = (items, material) => {
        if (layer === 'roofs' && material !== 'roof') return;
        if (layer === 'ground' && material === 'roof') return;
        for (let i = 0; i < (items || []).length; i++) {
            const item = items[i];
            if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
            if (dampMaterialMultiplier(material) <= 0) continue;
            marks.push({
                x: Math.round(item.x),
                y: Math.round(item.y),
                material,
                seed: clamp01(item.seed),
                alpha: dampMarkAlpha(wetness, material, item.seed),
            });
            if (marks.length >= limit) return;
        }
    };
    take(roads, 'road');
    take(docks, 'dock');
    take(footings, 'stone');
    take(roofs, 'roof');
    return marks.slice(0, limit);
}

// Follow-up after layer extraction: move private renderer calls used here into
// explicit layer/context methods so this module stays a frame orchestrator.
export function renderWorldFrame(renderer, dt = 16) {
    const ctx = renderer.ctx;
    const canvas = renderer.canvas;
    const overlayCtx = renderer.overlayCtx;
    if (!ctx || !canvas || !overlayCtx) return;
    if (!canvas.width || !canvas.height) return;
    const frameTimer = beginFrameTiming(renderer);
    const collectStructuralDiagnostics = renderer.debugOverlay?.enabled === true;
    const renderNow = Date.now();
    const villageSnapshot = renderer.villageDirector?.getSnapshot?.() || null;
    const viewport = renderer._screenViewport();
    const gpuWorldRequested = renderer.gpuWorld?.isActive?.() === true;
    const sceneCategoryContext = renderer._sceneCategoryContext || (renderer._sceneCategoryContext = {});
    sceneCategoryContext.renderer = renderer;
    sceneCategoryContext.renderNow = renderNow;
    const sceneCategoryFrame = worldSceneCategoryRegistry.enumerate(sceneCategoryContext);
    const sceneCategoryResolution = worldSceneCategoryRegistry.resolve(
        sceneCategoryFrame,
        gpuWorldRequested
            ? sceneCommandBackend(renderer, renderer.gpuWorld)
            : CANVAS_SCENE_BACKEND,
    );
    emitSceneCategoryDiagnostics(renderer, sceneCategoryResolution.diagnostics);
    const gpuWorldActive = gpuWorldRequested && !sceneCategoryResolution.requireCanvasFrame;
    const postFxActive = !gpuWorldActive && renderer.postFx?.isActive?.() === true;
    renderer._setPostFxCanvasVisible?.(gpuWorldActive || postFxActive);
    renderer._resetScreenTransform(overlayCtx);
    overlayCtx.clearRect(0, 0, viewport.width, viewport.height);
    // #28 integration — fire the child sprite's one-shot handoff ack-bob once the
    // director's baton reaches it (progress near terminus), deduped per scene id.
    if (villageSnapshot?.handoffs?.length) {
        const acked = (renderer._handoffAcked ||= new Set());
        const live = renderer._liveHandoffIds || (renderer._liveHandoffIds = new Set());
        live.clear();
        for (const h of villageSnapshot.handoffs) {
            if (h?.kind !== 'handoff' || !h?.to?.id) continue;
            live.add(h.id);
            if ((h.progress ?? 0) >= 0.9 && !acked.has(h.id)) {
                acked.add(h.id);
                renderer.agentSprites.get(h.to.id)?.setHandoffAck?.(true);
            }
        }
        for (const id of acked) if (!live.has(id)) acked.delete(id);
    }
    const atmosphere = renderer.atmosphereState.update({
        now: new Date(renderNow),
        motionScale: renderer.motionScale,
        // 2.2 — village mood nudges the weather (error spikes raise
        // storminess, push streaks clear the skies). Stateless per-frame read.
        eventInfluence: combineWeatherInfluence(
            renderer.moodService?.getWeatherInfluence?.(renderNow) ?? null,
            renderer.villageDirector?.getWeatherInfluence?.(renderNow) ?? null,
        ),
    });
    renderer._lastAtmosphere = atmosphere;
    const wx = atmosphere?.weather;
    renderer._stormIntensity = (wx?.type === 'overcast' || wx?.type === 'rain' || wx?.type === 'storm') && wx.intensity > 0.4
        ? wx.intensity
        : 0;
    renderer._waterWeather = renderer._waterWeatherState(atmosphere);
    renderer._surfaceWetness = advanceSurfaceWetness(renderer._surfaceWetness || 0, {
        precipitation: wx?.precipitation || 0,
        weatherType: wx?.type || 'clear',
        dt,
    });
    const reactions = applySurfaceWetnessToReactions(atmosphere?.reactions || {}, renderer._surfaceWetness);
    renderer._atmosphereReactions = reactions;
    renderer.buildingRenderer?.setLightingState(atmosphere?.lighting);
    renderer.buildingRenderer?.setClockState?.(atmosphere?.clock);
    renderer.buildingRenderer?.setAtmosphereState?.(atmosphere
        ? { ...atmosphere, reactions }
        : atmosphere);
    // #3 — grade authority: harbor anchorage glows lerp toward the time-of-day tint.
    renderer.harborTraffic?.setGradeState?.(atmosphere?.grade);
    const perfNow = performance.now();
    renderer._frameLightSources = renderer._computeFrameLightSources(atmosphere, perfNow);
    renderer._updateGateDoorState?.(perfNow);
    markFrameTiming(frameTimer, 'setup');

    renderer._resetScreenTransform(ctx);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    renderer.skyRenderer.draw(ctx, {
        canvas: viewport,
        camera: renderer.camera,
        dt,
        atmosphere,
        motionScale: renderer.motionScale,
    });
    markFrameTiming(frameTimer, 'sky');

    renderer.camera.applyTransform(ctx);
    renderer._drawDistantSeaHorizon(ctx, atmosphere);
    markFrameTiming(frameTimer, 'horizon');
    renderer._gpuHazeStrength = 0;
    if (!gpuWorldActive) {
        renderer._drawTerrain(
            ctx,
            frameTimer ? label => markFrameTiming(frameTimer, label) : null,
        );
        // #24 — cloud-shadow parallax: feathered shadows slide across the baked
        // terrain on the wind, giving the flat iso plane depth under the live sky.
        drawCloudShadows(renderer, ctx, atmosphere, perfNow);
        // 6.4 — ground haze over water and lowlands, drawn on the ground plane
        // ahead of agents and buildings. The ten wisps are the crest of this
        // field, not the whole effect.
        drawGroundFog(renderer, ctx, atmosphere, perfNow);
    } else {
        const pressure = sampleFramePressure();
        const plan = hazePlanForPressure(pressure.level, renderer.motionScale ?? 1);
        renderer._gpuHazeStrength = groundFogStrength(renderer, atmosphere) * plan.density;
        if (renderer._gpuHazeStrength > 0.02) ensureHazeField(renderer, atmosphere, plan);
    }
    markFrameTiming(frameTimer, 'ground-atmosphere');
    // [0.6] Draw-order: the canopy pass now also carries the hero sky rewards
    // (aurora, shooting stars, sky-flare, sun glints, push grade) so they
    // composite over terrain instead of behind the village. The rewards live
    // in SkyRenderer.drawCanopy — this call site is the whole draw-order change.
    renderer._drawSkyCanopy(ctx, atmosphere, dt, renderer.motionScale);
    renderer.camera.applyTransform(ctx);
    markFrameTiming(frameTimer, 'sky-canopy');
    // Wildlife and waterfalls now enter through the harbor's overlay-safe
    // scene category. Canvas draws them in the depth stream; direct GPU replays
    // the same category above its opaque island.
    markFrameTiming(frameTimer, 'fauna');
    admitTalkArcMarks({ relationship: renderer.relationshipState, agentSprites: renderer.agentSprites });
    const ground = gpuWorldActive ? prepareSemanticGround(renderer, viewport, villageSnapshot, atmosphere) : null;
    if (!gpuWorldActive || ground?.dirty) {
        drawGroundSemantics(renderer, ground?.ctx || ctx, { villageSnapshot, renderNow, perfNow, atmosphere, viewport });
    }
    if (!gpuWorldActive) {
        drawBuildingLightReflections(renderer, ctx, atmosphere);
        renderer.buildingRenderer?.drawShadows(ctx);
    } else if (ground) {
        renderer._resetScreenTransform(ctx);
        ctx.drawImage(renderer._semanticGroundCanvas, 0, 0, viewport.width, viewport.height);
        renderer.camera.applyTransform(ctx);
    }
    markFrameTiming(frameTimer, 'prelayers');

    const buildingDrawables = renderer.buildingRenderer?.enumerateDrawables() ?? [];
    const sortedSprites = renderer._snapshotSortedSprites();
    const agentLighting = atmosphere?.lighting || null;
    for (const sprite of sortedSprites) {
        sprite.setLightingState?.(agentLighting);
        sprite.setGpuWorldEnabled?.(gpuWorldActive);
    }
    const propDrawables = renderer._enumeratePropDrawables();
    const harborPendingRepos = renderer.harborTraffic?.getPendingRepoSummaries?.() ?? [];
    renderer.bridgeLanterns?.update?.(harborPendingRepos, renderNow);
    const harborSignature = renderer._harborPendingReposSignature(harborPendingRepos);
    if (harborSignature !== renderer._harborPendingSignature) {
        renderer._harborPendingSignature = harborSignature;
        eventBus.emit('harbor:updated', harborPendingRepos);
    }
    const chronicleMonumentDrawables = renderer.chronicleMonuments?.enumerateDrawables?.(renderNow, renderer.camera) ?? [];
    const chroniclerDrawables = renderer.chronicler?.enumerateDrawables?.() ?? [];
    const familiarDrawables = renderer._enumerateFamiliarMoteDrawables?.(atmosphere) ?? [];
    const zoom = renderer.camera.zoom;
    const renderModes = renderer._agentRenderMode?.(viewport, sortedSprites);
    const agentRenderMode = renderModes?.body || 'full';
    const annotationMode = renderModes?.annotation || 'full';
    renderer._assignAgentOverlaySlots(sortedSprites, zoom, { agentRenderMode: annotationMode });
    markFrameTiming(frameTimer, 'collect');

    const drawables = renderer._drawables;
    drawables.length = 0;
    const drawableAssembly = renderer._drawableAssembly || (renderer._drawableAssembly = {});
    drawableAssembly.buildingDrawables = buildingDrawables;
    drawableAssembly.propDrawables = propDrawables;
    drawableAssembly.agentSprites = sortedSprites;
    drawableAssembly.sceneCategoryFrame = sceneCategoryFrame;
    drawableAssembly.chronicleMonumentDrawables = chronicleMonumentDrawables;
    drawableAssembly.chroniclerDrawables = chroniclerDrawables;
    drawableAssembly.familiarDrawables = familiarDrawables;
    appendDepthSortedDrawables(drawables, drawableAssembly);
    const cullingStats = cullDepthSortedDrawables(
        drawables,
        renderer.camera,
        viewport,
        220,
        collectStructuralDiagnostics,
    );
    const drawableStats = collectStructuralDiagnostics
        ? summarizeDrawableLayers(drawables, cullingStats)
        : null;
    markFrameTiming(frameTimer, 'sort/cull');
    const drawableContext = renderer._drawableContext || (renderer._drawableContext = {});
    drawableContext.zoom = zoom;
    drawableContext.renderNow = renderNow;
    drawableContext.renderer = renderer;
    drawableContext.buildingRenderer = renderer.buildingRenderer;
    drawableContext.harborTraffic = renderer.harborTraffic;
    drawableContext.landmarkActivity = renderer.landmarkActivity;
    drawableContext.chronicleMonuments = renderer.chronicleMonuments;
    drawableContext.chronicler = renderer.chronicler;
    drawableContext.agentRenderMode = agentRenderMode;
    drawableContext.gpuWorldActive = gpuWorldActive;
    drawDepthSortedDrawables(ctx, drawables, drawableContext);
    // Direct GPU carries wetness in the material shader; the discrete Canvas
    // damp-mark decoration remains fallback-only and is documented as such.
    if (!gpuWorldActive) renderer._drawSurfaceWetnessMarks?.(ctx, 'roofs');
    markFrameTiming(frameTimer, 'drawables');
    renderer.particleSystem.draw(ctx, { excludeLayer: 'screen' });
    renderer.harborTraffic?.drawFinaleEffects(ctx, renderNow);
    markFrameTiming(frameTimer, 'world-effects');

    renderer._resetScreenTransform(ctx);
    let gpuWorldRendered = false;
    let postFxRendered = false;
    const needsGpuFeed = gpuWorldActive || postFxActive;
    const postFxFeedContext = renderer._postFxFeedContext || (renderer._postFxFeedContext = {});
    postFxFeedContext.renderer = renderer;
    postFxFeedContext.atmosphere = atmosphere;
    postFxFeedContext.villageSnapshot = villageSnapshot;
    postFxFeedContext.nowMs = renderNow;
    const feed = needsGpuFeed
        ? renderer.postFxFeed?.build?.(postFxFeedContext) || null
        : null;
    if (gpuWorldActive) {
        const gpuBuildContext = renderer._gpuBuildContext || (renderer._gpuBuildContext = {});
        gpuBuildContext.drawables = drawables;
        const records = buildGpuWorldRecords(renderer, gpuBuildContext);
        const gpuFeed = Object.assign(renderer._gpuFeedEnvelope ||= {}, feed || {});
        gpuFeed.timeMs = renderer.motionTimeMs ?? feed?.timeMs;
        gpuFeed.atmosphere = atmosphere;
        gpuFeed.weather = atmosphere?.weather || null;
        gpuFeed.lighting = atmosphere?.lighting || null;
        // 3.2 — the resident shader consumes the same accumulated wetness the
        // Canvas damp marks use; it never re-derives rain history in GLSL.
        gpuFeed.wetness = renderer._surfaceWetness || 0;
        // 3.5 — the authored palette ramp travels as a plain decoded image; a
        // missing or unexpected table leaves the pilot at today's response.
        gpuFeed.paletteLut = renderer.assets?.get?.(PALETTE_RAMP_ASSET_ID) || null;
        gpuFeed.paletteLutRevision = renderer.assets?.assetVersion || null;
        const gpuRenderContext = renderer._gpuRenderContext || (renderer._gpuRenderContext = {});
        gpuRenderContext.records = records;
        gpuRenderContext.camera = renderer.camera;
        gpuRenderContext.feed = gpuFeed;
        gpuRenderContext.sceneCommands = sceneCategoryResolution.nativeCommandBatches;
        gpuWorldRendered = renderer.gpuWorld?.render?.(gpuRenderContext) === true;
        markFrameTiming(frameTimer, 'gpu-world');
    } else if (postFxActive) {
        postFxRendered = renderer.postFx?.render?.(canvas, feed) === true;
        markFrameTiming(frameTimer, 'postfx');
    }
    if ((!gpuWorldActive || !gpuWorldRendered) && (!postFxActive || !postFxRendered)) {
        renderer._drawAtmosphere(
            ctx,
            atmosphere,
            dt,
            renderer._frameLightSources?.ambient || null,
            frameTimer ? label => markFrameTiming(frameTimer, label) : null,
        );
    }
    if ((gpuWorldActive && !gpuWorldRendered) || (postFxActive && !postFxRendered)) {
        renderer._setPostFxCanvasVisible?.(false);
    }

    renderer._resetScreenTransform(overlayCtx);
    renderer.weatherRenderer?.drawForeground(overlayCtx, {
        canvas: viewport,
        atmosphere,
        dt,
        profileMark: frameTimer ? label => markFrameTiming(frameTimer, label) : null,
    });
    renderer.camera.applyTransform(overlayCtx);
    if (gpuWorldRendered) {
        renderer.buildingRenderer?.drawGpuFunctionalOverlays?.(overlayCtx);
    }
    drawTalkArcs(overlayCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawCrowdClusterBadges(overlayCtx, {
        crowdStats: renderer._crowdStats,
        agentSprites: renderer.agentSprites,
        zoom,
    });
    renderer.arrivalDeparture?.draw?.(overlayCtx, {
        zoom,
        now: perfNow,
        lighting: atmosphere?.lighting,
    });
    drawVillageDirectorOverlays(overlayCtx, villageSnapshot, perfNow, atmosphere?.grade, {
        getBuildingDims: buildingDimsLookup(renderer),
    });

    if (gpuWorldRendered) {
        const sceneOverlayContext = renderer._sceneOverlayContext || (renderer._sceneOverlayContext = {});
        sceneOverlayContext.zoom = zoom;
        sceneOverlayContext.renderNow = renderNow;
        sceneOverlayContext.renderer = renderer;
        drawSceneCategoryOverlays(overlayCtx, drawables, sceneCategoryResolution, sceneOverlayContext);
        renderer.harborTraffic?.drawFinaleEffects?.(overlayCtx, renderNow);
    }
    // 0.7 — re-stamp the PRIMARY mark set (waiting beacons, selection rings,
    // incident pills) AFTER the atmosphere multiply so the action-demanding
    // reads survive the night grade at the same strength the plaques enjoy.
    drawPrimaryMarksPostAtmosphere(renderer, overlayCtx, villageSnapshot, atmosphere, {
        force: gpuWorldRendered,
    });
    if (gpuWorldRendered) {
        for (const sprite of sortedSprites) {
            sprite.drawGpuWorldOverlay?.(overlayCtx, zoom, annotationMode);
        }
    }
    drawSelectedAgentXray(renderer, overlayCtx, buildingDrawables);
    // 4.5 — the shared-file overlap plate. The thread and knot live in the
    // occluded ground texture; the exact counts belong here, once, in both
    // backends, so dense load keeps the numbers when the lines are dropped.
    drawSharedFileOverlapLabel(overlayCtx, {
        overlap: renderer.relationshipState?.getSnapshot?.()?.fileOverlap || null,
        agentSprites: renderer.agentSprites,
        zoom,
        threaded: renderer._sharedFileThreadDrawn === true,
    });
    markFrameTiming(frameTimer, 'post-atmosphere-effects');

    if (!renderer.selectedAgent && !renderer.cameraDirector?.attentionFrame) {
        renderer.buildingRenderer?.drawBubbles(overlayCtx, renderer.world);
    }
    // 5.1 — the ambient caption is measured before the label pass so landmark
    // plates treat its strip as occupied and step aside instead of colliding
    // with it. Screen rect converted to world space: the label pass runs under
    // the world transform.
    const ambientCaption = ambientCaptionLayout(overlayCtx, renderer, viewport);
    const captionWorldBox = ambientCaption && renderer.camera?.screenToWorld
        ? (() => {
            const topLeft = renderer.camera.screenToWorld(ambientCaption.rect.left, ambientCaption.rect.top);
            const bottomRight = renderer.camera.screenToWorld(ambientCaption.rect.right, ambientCaption.rect.bottom);
            return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
        })()
        : null;
    renderer.buildingRenderer?.drawLabels(overlayCtx, {
        zoom,
        scaleMode: 'screen-fixed',
        occupiedBoxes: captionWorldBox
            ? [...renderer._collectAgentLabelHitRects(sortedSprites), captionWorldBox]
            : renderer._collectAgentLabelHitRects(sortedSprites),
        harborPendingRepos,
        readMode: renderer.getReadMode(),
    });
    if (collectStructuralDiagnostics) {
        renderer._lastRenderStats = buildRenderStats(renderer, {
            drawableStats,
            cullingStats,
            harborPendingRepos,
            sceneCategoryResolution,
            inputCounts: {
                buildings: buildingDrawables.length,
                props: propDrawables.length,
                agents: sortedSprites.length,
                sceneCategories: Object.fromEntries(sceneCategoryFrame.entries.map(entry => [
                    entry.category.id,
                    entry.items.length,
                ])),
                monuments: chronicleMonumentDrawables.length,
                chronicler: chroniclerDrawables.length,
                familiars: familiarDrawables.length,
            },
            agentRenderMode,
            annotationMode,
        });
    }
    markFrameTiming(frameTimer, 'labels');

    renderer._resetScreenTransform(overlayCtx);
    renderer.particleSystem.draw(overlayCtx, { layer: 'screen' });
    renderer.seasonalAmbience?.drawStatic?.(overlayCtx);
    renderer.harborTraffic?.drawScreenSummary(overlayCtx, viewport, renderer.camera, renderNow);
    drawVillageDirectorScreen(overlayCtx, villageSnapshot, viewport);
    // 5.4 — the work score's badge and every exact count, once, on the shared
    // upper overlay so Canvas and resident WebGL say the same thing.
    drawWorkScoreScreen(overlayCtx, viewport, villageSnapshot?.workScore || {});
    // 5.7 — offscreen-event edge indicators (incl. cues the CameraDirector
    // dropped): small screen-edge markers, click to glide there.
    drawOffscreenCueEdges(overlayCtx, renderer, viewport, renderNow);
    // #21 — director glide grade pass: a momentary vignette + worldTint wash that
    // fades in and out with the cinematic move. Reduced motion yields no grade
    // (the camera cut leaves nothing to fade), so this is a no-op there.
    drawDirectorGlideGrade(overlayCtx, renderer.camera?.getDirectorGlideGrade?.(), viewport);
    // 5.7/5.2 — cinematic letterbox bars: they ride a release/incident cue
    // glide, and an ambient chapter holds them for a beat after settling so
    // the caption is read at rest. Reduced motion draws none.
    drawCueLetterbox(overlayCtx, renderer.camera, viewport);
    // 5.1/5.2 — the broadcast's one factual caption, drawn after the bars so
    // they never cover it: the district and its counts, or the incident
    // chapter's identity. Static text, no motion of its own.
    drawAmbientCaption(overlayCtx, ambientCaption);
    drawDebugOverlay(renderer, overlayCtx, atmosphere, viewport);
    const timings = finishFrameTiming(renderer, frameTimer);
    if (frameTimer) {
        const renderStats = renderer._lastRenderStats || (renderer._lastRenderStats = {});
        renderStats.timings = timings;
    }
}

function drawGroundSemantics(renderer, groundCtx, { villageSnapshot, renderNow, perfNow, atmosphere, viewport }) {
    renderer.trailRenderer?.draw?.(groundCtx, renderer.camera, viewport, renderNow, true);

    // 5.4 — the requested work score sits on the retained ground cue texture,
    // so buildings and bodies occlude the diagram like every other ground cue.
    if (villageSnapshot?.workScore) {
        drawWorkScoreGround(groundCtx, {
            ...villageSnapshot.workScore,
            zoom: renderer.camera.zoom,
            perfNow,
            motionScale: renderer.motionScale ?? 1,
        });
    }

    // 3.10 — teams with a live council ring skip the director aura wash.
    drawVillageDirectorGround(groundCtx, villageSnapshot, renderNow, atmosphere?.grade, {
        councilTeamNames: collectCouncilTeamNames(renderer, villageSnapshot),
    });

    drawCouncilRings(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawFamilyTethers(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawAdvisorTethers(groundCtx, {
        relationship: renderer.relationshipState,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawAllyTethers(groundCtx, {
        pairs: renderer._allyTetherPairs,
        zoom: renderer.camera.zoom,
        now: perfNow,
        motionScale: renderer.motionScale,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
    });
    drawCrowdClusterAuras(groundCtx, {
        crowdStats: renderer._crowdStats,
        zoom: renderer.camera.zoom,
        lighting: atmosphere?.lighting,
    });
    if (renderer.gpuWorld?.isActive?.()) {
        for (const sprite of renderer.agentSprites.values()) {
            if (!sprite.selected && !sprite.hovered) continue;
            groundCtx.save();
            groundCtx.strokeStyle = sprite._providerAccentColor?.() || '#f2d36b';
            groundCtx.lineWidth = 1.5 / renderer.camera.zoom;
            groundCtx.beginPath();
            groundCtx.ellipse(sprite.x, sprite.y - 2, 24, 9, 0, 0, Math.PI * 2);
            groundCtx.stroke();
            groundCtx.restore();
        }
    }
    // 4.5 — one shared-file thread and knot for the selected agent. Under
    // annotation pressure (a hundred agents) the thread is dropped entirely and
    // the upper label carries the exact per-building counts instead.
    renderer._sharedFileThreadDrawn = drawSharedFileKnot(groundCtx, {
        overlap: renderer.relationshipState?.getSnapshot?.()?.fileOverlap || null,
        agentSprites: renderer.agentSprites,
        zoom: renderer.camera.zoom,
        lighting: atmosphere?.lighting,
        grade: atmosphere?.grade,
        allowThread: (renderer._annotationMode || 'full') === 'full',
    });
}

export function prepareSemanticGround(renderer, viewport, snapshot, atmosphere) {
    const relationship = renderer.relationshipState?.getSnapshot?.() || renderer.relationshipState;
    const sprites = [...renderer.agentSprites.values()];
    const hasCues = sprites.some(sprite => sprite.selected || sprite.hovered || [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED].includes(sprite.agent?.status))
        || relationship?.teamToMembers?.size || relationship?.parentToChildren?.size
        || relationship?.advisorPairs?.length || renderer._allyTetherPairs?.length
        || renderer._crowdStats?.clusters?.length
        || snapshot?.buildingSignals?.length
        || snapshot?.replaySamples?.length || snapshot?.selectedBuildingSignal || snapshot?.hoverBuildingSignal
        || snapshot?.teams?.length || snapshot?.incidents?.length || snapshot?.recoveries?.length || snapshot?.releaseParade
        // 5.4 — an open work score is a ground cue in its own right.
        || snapshot?.workScore;
    renderer._semanticGroundActive = Boolean(hasCues);
    if (!hasCues) return null;
    // ponytail: one 1024px-bounded cue texture; cache static frames and quantize
    // ornament phases to 8 Hz. Native cue records if measured uploads still dominate.
    const canvas = renderer._semanticGroundCanvas ||= document.createElement('canvas');
    const scale = Math.min(1, 1024 / Math.max(viewport.width, viewport.height));
    const width = Math.ceil(viewport.width * scale);
    const height = Math.ceil(viewport.height * scale);
    renderer._semanticGroundViewport = viewport;
    const camera = renderer.camera;
    const key = [width, height, camera.renderOffsetX, camera.renderOffsetY, camera.zoom,
        renderer.motionScale > 0 ? Math.floor((renderer.motionTimeMs || 0) / 125) : 0,
        renderer.motionScale,
        // Compare contents, not collection identity: relationship and crowd owners
        // mutate these in place, including while the visual clock is frozen.
        JSON.stringify([
            [...(relationship?.teamToMembers || [])].map(([name, ids]) => [name, [...ids]]),
            [...(relationship?.parentToChildren || [])].map(([id, children]) => [id, [...children]]),
            relationship?.advisorPairs,
            // 4.5 — the overlap edge is drawn into this texture, so a changed
            // peer, path, kind or availability must invalidate it.
            relationship?.fileOverlap?.edge
                ? [relationship.fileOverlap.selectedId, relationship.fileOverlap.edge.peerId,
                    relationship.fileOverlap.edge.path, relationship.fileOverlap.edge.kind,
                    relationship.fileOverlap.edge.available]
                : null,
            renderer._annotationMode || 'full',
            renderer._allyTetherPairs?.map(pair => [pair.a?.agent?.id, pair.b?.agent?.id]),
            renderer._crowdStats?.clusters?.map(cluster => [cluster.id, cluster.tileX, cluster.tileY, cluster.count, cluster.dominantStatus]),
            // Light boost changes continuously through the day. Sub-byte alpha
            // drift must not turn a static cue texture into a per-frame upload.
            Math.round((atmosphere?.lighting?.lightBoost ?? 1) * 64), atmosphere?.grade?.worldTint,
        ]),
        JSON.stringify([snapshot?.buildingSignals, snapshot?.selectedBuildingSignal, snapshot?.hoverBuildingSignal,
            snapshot?.replaySamples, snapshot?.teams, snapshot?.incidents, snapshot?.recoveries, snapshot?.releaseParade,
            // 5.4 — the scrub cursor and every resolved node position are drawn
            // into this texture, so both must invalidate it.
            snapshot?.workScore?.signature || null]),
        sprites.map(sprite => `${sprite.agent?.id}:${Math.round(sprite.x)}:${Math.round(sprite.y)}:${sprite.selected}:${sprite.hovered}:${sprite.agent?.status}:${sprite.isArrivalPending?.()}:${sprite._providerAccentColor?.()}:${sprite._providerTrimColor?.() || sprite.providerTrimColor}`).join('|'),
    ].join(';');
    const ctx = canvas.getContext('2d');
    if (key === renderer._semanticGroundKey) return { ctx, dirty: false };
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(camera.zoom * scale, 0, 0, camera.zoom * scale, camera.renderOffsetX * scale, camera.renderOffsetY * scale);
    renderer._semanticGroundKey = key;
    renderer._semanticGroundRevision = (renderer._semanticGroundRevision || 0) + 1;
    return { ctx, dirty: true };
}

function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return null;
    const n = Number.parseInt(value, 16);
    if (!Number.isFinite(n)) return null;
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// #21 — screen-space cinematic grade for an active director glide. A radial
// vignette pulls focus to the framed subject and a faint worldTint wash colours
// the moment (red for incidents, gold for a parade, teal for an arrival). Both
// scale with the glide's bell-curve weight so they never linger after the move.
//
// 5.8 — the vignette gradient is cached per (viewport, quantized-strength)
// bucket instead of allocated every frame of the glide; strength is quantized
// to 0.05 steps so the bell-curve ramp reuses a handful of buckets.
const _glideVignetteCache = new Map();
const GLIDE_VIGNETTE_CACHE_LIMIT = 24;

function glideVignetteGradient(ctx, w, h, vignette) {
    const quantized = Math.round(vignette * 20) / 20;
    const key = `${w}x${h}:${quantized}`;
    const cached = _glideVignetteCache.get(key);
    if (cached) return cached;
    const cx = w / 2;
    const cy = h / 2;
    const inner = Math.min(w, h) * 0.32;
    const outer = Math.hypot(w, h) / 2;
    const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${quantized})`);
    if (_glideVignetteCache.size >= GLIDE_VIGNETTE_CACHE_LIMIT) _glideVignetteCache.clear();
    _glideVignetteCache.set(key, gradient);
    return gradient;
}

function drawDirectorGlideGrade(ctx, grade, viewport) {
    if (!grade || !(grade.weight > 0.01) || !viewport?.width || !viewport?.height) return;
    const w = viewport.width;
    const h = viewport.height;
    const weight = Math.max(0, Math.min(1, grade.weight));
    const tint = hexToRgb(grade.worldTint);

    ctx.save();
    if (tint) {
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.5 * weight;
        ctx.fillStyle = `rgb(${tint.r}, ${tint.g}, ${tint.b})`;
        ctx.fillRect(0, 0, w, h);
    }
    const vignette = Math.max(0, Math.min(1, Number(grade.vignette) || 0)) * weight;
    if (vignette > 0.01) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = glideVignetteGradient(ctx, w, h, vignette);
        ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
}

// 5.7 — cinematic letterbox bars while a release/incident camera cue glide
// owns the frame. Bar height rides the glide's bell-curve weight so the bars
// slide in and out with the move; a 1px ember line on the inner edge (tinted
// by the cue grade) keeps them reading as cinema chrome, not a render
// artifact. Reduced motion: cue glides are suppressed and Camera cuts instead,
// so no bars ever appear.
//
// 5.2 — an Ambient incident chapter keeps its bars at full height for three
// seconds after the move settles instead of dropping them on arrival, so the
// caption is read at rest. The Camera owns that timing (getLetterboxState);
// cue bars are unchanged.
function drawCueLetterbox(ctx, camera, viewport) {
    if (!camera?.getLetterboxState || !viewport?.width || !viewport?.height) return 0;
    const state = camera.getLetterboxState();
    const weight = Math.max(0, Math.min(1, Number(state?.weight) || 0));
    if (weight <= 0.02) return 0;
    const barH = Math.round(Math.min(72, viewport.height * 0.08) * weight);
    if (barH < 2) return 0;
    ctx.save();
    ctx.fillStyle = 'rgba(12, 9, 7, 0.94)';
    ctx.fillRect(0, 0, viewport.width, barH);
    ctx.fillRect(0, viewport.height - barH, viewport.width, barH);
    const tint = hexToRgb(state?.grade?.worldTint) || { r: 214, g: 169, b: 81 };
    ctx.fillStyle = `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${0.5 * weight})`;
    ctx.fillRect(0, barH, viewport.width, 1);
    ctx.fillRect(0, viewport.height - barH - 1, viewport.width, 1);
    ctx.restore();
    return barH;
}

// 5.1/5.2 — the broadcast caption: one short factual line naming the district
// and its counts ("Forge · 4 working"), or the incident chapter's identity
// ("Push failed · pharos-watch"). Static: no fade, no motion, identical in
// Canvas and resident WebGL, and present under reduced motion where it is the
// only thing the static overview has to say.
// Measured once per frame, before the label pass, so the plate's strip can be
// reserved. Returns null whenever Ambient does not own the frame.
function ambientCaptionLayout(ctx, renderer, viewport) {
    const caption = renderer?.cameraDirector?.getAmbientCaption?.();
    const text = String(caption?.text || '').trim();
    if (!text || !viewport?.width || !viewport?.height) return null;
    const bars = renderer.camera?.getLetterboxState?.();
    const barH = bars?.weight > 0.02
        ? Math.round(Math.min(72, viewport.height * 0.08) * Math.min(1, bars.weight))
        : 0;
    const label = text.toUpperCase();
    ctx.save();
    ctx.font = `10px ${WORLD_BODY_FONT}`;
    const width = Math.ceil(ctx.measureText(label).width) + 18;
    ctx.restore();
    const left = Math.round((viewport.width - width) / 2);
    const top = barH + 12;
    return {
        label,
        incident: caption.kind === 'chapter',
        rect: { left, top, right: left + width, bottom: top + 22 },
    };
}

function drawAmbientCaption(ctx, layout) {
    if (!layout) return;
    const { rect, incident, label } = layout;
    ctx.save();
    ctx.font = `10px ${WORLD_BODY_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = incident ? 'rgba(34, 16, 14, 0.88)' : 'rgba(20, 16, 13, 0.84)';
    ctx.strokeStyle = incident ? 'rgba(248, 113, 113, 0.72)' : 'rgba(214, 169, 81, 0.6)';
    ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    ctx.strokeRect(rect.left + 0.5, rect.top + 0.5, rect.right - rect.left - 1, rect.bottom - rect.top - 1);
    ctx.fillStyle = incident ? '#ffd9d3' : '#f4e3bc';
    ctx.fillText(label, rect.left + 9, (rect.top + rect.bottom) / 2);
    ctx.restore();
}

function combineWeatherInfluence(a, b) {
    if (!a && !b) return null;
    return {
        storminess: Math.max(
            Number(a?.storminess) || 0,
            Number(b?.storminess) || 0,
        ),
        clearing: Math.max(
            Number(a?.clearing) || 0,
            Number(b?.clearing) || 0,
        ),
    };
}

// 3.10 — names of teams that currently have a live council ring (2+ gathered,
// non-arriving members). The director aura wash skips these so the triple team
// mark (aura + ring + orbit light) dedupes to ring + light. Only computed when
// the snapshot actually has team clusters to filter.
function collectCouncilTeamNames(renderer, villageSnapshot) {
    if (!villageSnapshot?.teams?.length) return null;
    const relationship = renderer.relationshipState;
    const snapshot = typeof relationship?.getSnapshot === 'function' ? relationship.getSnapshot() : relationship;
    const teams = snapshot?.teamToMembers;
    if (!teams?.entries || !renderer.agentSprites) return null;
    const names = new Set();
    for (const [teamName, memberIds] of teams.entries()) {
        let live = 0;
        for (const id of memberIds) {
            const sprite = renderer.agentSprites.get(id);
            if (sprite && !sprite.isArrivalPending?.()) live++;
            if (live >= 2) {
                names.add(teamName);
                break;
            }
        }
    }
    return names;
}

// 5.8 — stable dims accessor handed to the director overlay so pills can stack
// above the building plaque zone. Cached on the renderer: no per-frame closure.
function buildingDimsLookup(renderer) {
    if (!renderer._buildingDimsLookup) {
        renderer._buildingDimsLookup = (type) => renderer.assets?.getDims?.(`building.${type}`) || null;
    }
    return renderer._buildingDimsLookup;
}

// 0.7 — PRIMARY marks survive night. Everything drawn before _drawAtmosphere
// is dimmed by the multiply grade (~50% at night) while plaques/glows drawn
// after stay bright — the legibility hierarchy inverts exactly when the scene
// is darkest. Re-stamp the PRIMARY set here, post-atmosphere, scaled by the
// same beacon night factor the lantern glows use (drawSelectedAgentXray is the
// pass-shape precedent). Daylight (factor ~0) draws nothing, so marks are
// never double-stamped at full strength. Reduced motion: identical — the
// re-stamp carries no motion of its own.
function drawPrimaryMarksPostAtmosphere(renderer, ctx, villageSnapshot, atmosphere, { force = false } = {}) {
    const nightFactor = force ? 1 : primaryRestampNightFactor(renderer, atmosphere);
    if (nightFactor <= 0.06) return;

    for (const sprite of renderer.agentSprites?.values?.() || []) {
        if (!sprite) continue;
        const drawMarks = () => {
            // Waiting-on-user beacon pillar. The outer alpha scales the gradient
            // body; the method's own save/restore keeps state clean (its tiny `!`
            // pennant sets its own alpha — acceptable, it is the top-priority read).
            if (sprite.agent?.status === AgentStatus.WAITING_ON_USER
                && typeof sprite._drawWaitingOnUserBeacon === 'function') {
                ctx.save();
                ctx.globalAlpha = (force ? 1 : 0.55) * nightFactor;
                sprite._drawWaitingOnUserBeacon(ctx, null);
                ctx.restore();
            }
            // Selection ring: a soft additive echo of the asset ring at the feet,
            // in the provider accent so it still reads identity at a glance.
            if (sprite.selected && !force) {
                const accent = hexToRgb(sprite._providerAccentColor?.() || '#f2d36b') || { r: 242, g: 211, b: 107 };
                ctx.save();
                ctx.globalCompositeOperation = 'screen';
                ctx.beginPath();
                ctx.ellipse(sprite.x, sprite.y - 2, 24, 9, 0, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${0.10 * nightFactor})`;
                ctx.fill();
                ctx.strokeStyle = `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${0.5 * nightFactor})`;
                ctx.lineWidth = 1.4;
                ctx.stroke();
                ctx.restore();
            }
        };
        if (typeof sprite.withBridgeLift === 'function') sprite.withBridgeLift(drawMarks);
        else drawMarks();
    }

    drawPrimaryPillRestamp(ctx, villageSnapshot, nightFactor, buildingDimsLookup(renderer));
}

function primaryRestampNightFactor(renderer, atmosphere) {
    const fromRenderer = renderer._lanternNightFactor?.(atmosphere);
    if (Number.isFinite(fromRenderer)) return fromRenderer;
    const lighting = atmosphere?.lighting || null;
    if (!lighting) return 0;
    const beacon = Number(lighting.beaconIntensity);
    if (Number.isFinite(beacon)) return Math.max(0, Math.min(1, beacon));
    const ambient = Number(lighting.ambientLight);
    return Number.isFinite(ambient) ? Math.max(0, Math.min(1, 1 - ambient)) : 0;
}

// ---------------------------------------------------------------------------
// 6.4 — ground haze over water and lowlands. The coherent field is a
// quarter-resolution occupancy mask keyed by camera pose / viewport /
// atmosphere bucket and rebuilt only when that key changes. The existing
// ten wisps remain the visible crest of that field, not the whole effect.
const FOG_SPOT_LIMIT = 10;
const FOG_WATER_ANCHOR_LIMIT = 6;
const FOG_DRIFT_PERIOD_MS = 52000;
const FOG_DRIFT_PX = 14;
const FOG_WISP_SPRITE_ID = 'atmosphere.fog.wisp.low';
const HAZE_FIELD_RGB = Object.freeze([214, 228, 236]);
let _fogStamp = null;

function fogStampCanvas() {
    if (_fogStamp) return _fogStamp;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 48;
    const stampCtx = canvas.getContext('2d');
    const gradient = stampCtx.createRadialGradient(48, 24, 0, 48, 24, 48);
    gradient.addColorStop(0, 'rgba(214, 228, 236, 0.55)');
    gradient.addColorStop(0.6, 'rgba(214, 228, 236, 0.22)');
    gradient.addColorStop(1, 'rgba(214, 228, 236, 0)');
    stampCtx.fillStyle = gradient;
    stampCtx.save();
    stampCtx.translate(48, 24);
    stampCtx.scale(1, 0.5);
    stampCtx.translate(-48, -48);
    stampCtx.fillRect(0, -24, 96, 96);
    stampCtx.restore();
    _fogStamp = canvas;
    return canvas;
}

function groundFogSpots(renderer) {
    if (renderer._groundFogSpots) return renderer._groundFogSpots;
    const { anchors } = collectHazeAnchors({
        waterTiles: renderer.waterTiles,
        waterMeta: renderer.waterMeta,
        lowlandPoints: lowlandPointsFromDiamond(renderer._worldDiamondPoints?.()),
        waterLimit: FOG_WATER_ANCHOR_LIMIT,
    });
    renderer._groundFogSpots = anchors.slice(0, FOG_SPOT_LIMIT).map((anchor) => ({
        x: anchor.x,
        y: anchor.y,
        seed: anchor.seed || 0,
    }));
    return renderer._groundFogSpots;
}

function hazeRoadPoints(renderer) {
    if (renderer._hazeRoadPoints) return renderer._hazeRoadPoints;
    renderer._hazeRoadPoints = collectRoadCarvePoints({
        pathTiles: renderer.pathTiles,
        mainAvenueTiles: renderer.mainAvenueTiles,
        dirtPathTiles: renderer.dirtPathTiles,
        commandCenterRoadTiles: renderer.commandCenterRoadTiles,
    });
    return renderer._hazeRoadPoints;
}

function hazeAtmosphereBucket(atmosphere) {
    if (atmosphere?.cacheKey) return atmosphere.cacheKey;
    const fog = Math.round((Number(atmosphere?.weather?.fog) || 0) * 10);
    const precip = Math.round((Number(atmosphere?.weather?.precipitation) || 0) * 10);
    return `${atmosphere?.phase || 'day'}|f${fog}|p${precip}`;
}

function focusedHazeSubject(renderer) {
    const selected = renderer.selectedAgent;
    const sprite = selected?.id ? renderer.agentSprites?.get?.(selected.id) : null;
    if (sprite && Number.isFinite(sprite.x) && Number.isFinite(sprite.y)) {
        return { id: selected.id, x: sprite.x, y: sprite.y };
    }
    return null;
}

function groundFogStrength(renderer, atmosphere) {
    let strength = 0;
    if (atmosphere?.phase === 'dawn') {
        const progress = Math.max(0, Math.min(1, Number(atmosphere.phaseProgress) || 0));
        // Fade in and back out across the dawn phase rather than popping.
        strength = Math.sin(progress * Math.PI);
    }
    const weatherFog = Number(renderer._waterWeather?.fog) || 0;
    const precipitation = Number(renderer._waterWeather?.rain) || 0;
    return Math.max(strength, weatherFog * 0.7, precipitation * 0.45);
}

function paintHazeMaskCanvas(field) {
    if (typeof document === 'undefined') return null;
    const width = field.width;
    const height = field.height;
    let canvas = field.canvas;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const samples = field.samples;
    const r = HAZE_FIELD_RGB[0];
    const g = HAZE_FIELD_RGB[1];
    const b = HAZE_FIELD_RGB[2];
    for (let i = 0; i < samples.length; i++) {
        const offset = i * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = samples[i];
    }
    ctx.putImageData(imageData, 0, 0);
    field.canvas = canvas;
    return canvas;
}

function ensureHazeField(renderer, atmosphere, plan) {
    const viewport = renderer._screenViewport?.() || { width: 0, height: 0 };
    if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
    const focused = focusedHazeSubject(renderer);
    const key = hazeFieldCacheKey({
        camera: renderer.camera,
        viewport,
        atmosphereBucket: hazeAtmosphereBucket(atmosphere),
        pressureLevel: plan.pressureLevel || 0,
        focusedId: focused?.id || '',
        fieldScale: plan.fieldScale,
    });
    const cached = renderer._hazeField;
    if (!shouldRebuildHazeField(cached?.key, key, {
        motionScale: renderer.motionScale ?? 1,
        hasField: Boolean(cached?.canvas || cached?.samples),
    })) {
        return cached;
    }
    const { anchors } = collectHazeAnchors({
        waterTiles: renderer.waterTiles,
        waterMeta: renderer.waterMeta,
        lowlandPoints: lowlandPointsFromDiamond(renderer._worldDiamondPoints?.()),
        waterLimit: FOG_WATER_ANCHOR_LIMIT,
    });
    if (!anchors.length) {
        renderer._hazeField = { key, width: 0, height: 0, samples: new Uint8Array(0), canvas: null };
        return renderer._hazeField;
    }
    const field = projectHazeField({
        anchors,
        roads: hazeRoadPoints(renderer),
        focused,
        camera: renderer.camera,
        viewport,
        scale: plan.fieldScale,
        strength: 1,
        densityScale: 1,
    });
    field.key = key;
    if (paintHazeMaskCanvas(field)) field.samples = null;
    renderer._hazeField = field;
    return field;
}

function clipProjectedDiamond(renderer, ctx) {
    const points = renderer._worldDiamondPoints?.();
    const camera = renderer.camera;
    if (!Array.isArray(points) || points.length < 4 || !camera?.worldToScreen) return false;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
        const screen = camera.worldToScreen(points[i].x, points[i].y);
        if (i === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
    }
    ctx.closePath();
    ctx.clip();
    return true;
}

function drawHazeField(renderer, ctx, field, strength) {
    if (!field?.canvas || !(field.width > 0) || strength <= 0.01) return;
    const viewport = renderer._screenViewport?.();
    if (!viewport?.width || !viewport?.height) return;
    ctx.save();
    renderer._resetScreenTransform?.(ctx);
    clipProjectedDiamond(renderer, ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(HAZE_ALPHA_CAP, HAZE_ALPHA_CAP * strength);
    ctx.drawImage(field.canvas, 0, 0, viewport.width, viewport.height);
    ctx.restore();
}

function drawGroundFog(renderer, ctx, atmosphere, perfNow) {
    const strength = groundFogStrength(renderer, atmosphere);
    const pressure = sampleFramePressure();
    const plan = hazePlanForPressure(pressure.level, renderer.motionScale ?? 1);
    const fieldStrength = strength * plan.density;
    if (fieldStrength <= 0.02) return;
    const field = ensureHazeField(renderer, atmosphere, plan);
    if (field) drawHazeField(renderer, ctx, field, fieldStrength);

    if (plan.detail <= 0) return;
    const spots = groundFogSpots(renderer);
    if (!spots.length) return;
    const drifting = (renderer.motionScale ?? 1) > 0;
    const driftPhase = drifting ? (perfNow / FOG_DRIFT_PERIOD_MS) * Math.PI * 2 : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < spots.length; i++) {
        const spot = spots[i];
        const dx = Math.sin(driftPhase + spot.seed * Math.PI * 2 + i) * FOG_DRIFT_PX;
        const alpha = Math.min(0.26, (0.15 + spot.seed * 0.08) * strength);
        const drew = renderer._drawAtmosphereEffectSprite?.(ctx, FOG_WISP_SPRITE_ID, {
            x: spot.x + dx,
            y: spot.y,
            alpha,
            scaleX: 1.7 + spot.seed * 0.9,
            scaleY: 0.55 + spot.seed * 0.25,
            rotation: -0.1 + spot.seed * 0.2,
            flipX: spot.seed > 0.5,
        });
        if (drew) continue;
        const stamp = fogStampCanvas();
        ctx.globalAlpha = alpha;
        ctx.drawImage(stamp, Math.round(spot.x + dx - 80), Math.round(spot.y - 26), 160, 64);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// #24 — slow band. 2–3 feathered dark ellipses drift across the baked terrain
// at a fractional parallax of the wind, so cloud shadows visibly slide over the
// village. Clipped to the iso diamond so shadows only fall on land/water, and
// folded under a `multiply` composite at ~12% alpha. Reduced motion (motionScale
// === 0) freezes the drift to static positions rather than dropping the layer.
const CLOUD_SHADOW_MAX = 3;
const CLOUD_SHADOW_DRIFT_RATE = 0.012; // world-px per ms at parallax 1, windX 1
const CLOUD_SHADOW_ALPHA = 0.12;

function drawCloudShadows(renderer, ctx, atmosphere, perfNow) {
    const layers = atmosphere?.sky?.cloudLayers;
    if (!Array.isArray(layers) || !layers.length) return;
    const cloudCover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    if (cloudCover <= 0.04) return; // a clear sky casts no shadows
    const points = renderer._worldDiamondPoints?.();
    if (!points || points.length < 4) return;

    const top = points[0];
    const right = points[1];
    const bottom = points[2];
    const left = points[3];
    const boundsW = right.x - left.x;
    const boundsH = bottom.y - top.y;
    if (!(boundsW > 0) || !(boundsH > 0)) return;

    // The widest, lowest layers read best as ground shadows — take the largest.
    const ranked = [...layers].sort((a, b) => (b.scale || 0) - (a.scale || 0));
    const count = Math.min(CLOUD_SHADOW_MAX, ranked.length);
    const windX = Number(atmosphere?.motion?.windX) || 1;
    const drifting = renderer.motionScale > 0;
    // A generous span so shadows wrap fully off either edge before reappearing.
    const span = boundsW + boundsH;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';

    for (let i = 0; i < count; i++) {
        const layer = ranked[i];
        const parallax = Number(layer.parallax) || 0.5;
        const drift = drifting
            ? windX * perfNow * CLOUD_SHADOW_DRIFT_RATE * parallax
            : 0;
        // Wrap the layer's seeded fraction + drift across the bounding span.
        const baseX = left.x + (((Number(layer.xFrac) || 0) * span + drift) % span + span) % span;
        const cy = top.y + (Number(layer.yFrac) || 0.3) * boundsH;
        const rx = Math.max(48, (Number(layer.scale) || 1) * boundsW * 0.22);
        const ry = rx * 0.5;
        const alpha = CLOUD_SHADOW_ALPHA * cloudCover * (0.6 + (Number(layer.alpha) || 0.3));

        // Draw at the wrapped position and one span to the left so a shadow
        // crossing the seam is never clipped to a hard edge.
        for (const cx of [baseX - span, baseX]) {
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
            grad.addColorStop(0, `rgba(28, 32, 46, ${alpha.toFixed(3)})`);
            grad.addColorStop(0.7, `rgba(28, 32, 46, ${(alpha * 0.5).toFixed(3)})`);
            grad.addColorStop(1, 'rgba(28, 32, 46, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
}

function drawBuildingLightReflections(renderer, ctx, atmosphere) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    const lights = renderer._frameLightSources?.building || [];
    const glowScale = atmosphere?.lighting?.lightBoost ?? atmosphere?.grade?.buildingGlowScale ?? 1;
    const alphaBase = 0.10 * glowScale;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const light of lights) {
        if (light.kind === 'beam') {
            renderer._drawLighthouseBeam(ctx, light, atmosphere);
            continue;
        }
        const overlayId = light.overlay || 'atmosphere.light.lantern-glow';
        const overlayImg = renderer.assets.get(overlayId);
        if (!overlayImg) continue;
        const dims = renderer.assets.getDims(overlayId);
        if (!dims) continue;
        const alpha = alphaBase * (light.intensity || 1) * (light.buildingType === 'watchtower' ? 1.55 : 1);
        ctx.globalAlpha = alpha;
        ctx.drawImage(
            overlayImg,
            Math.round(light.x - dims.w / 2),
            Math.round(light.y - dims.h / 2)
        );
    }
    ctx.restore();
}

function drawSelectedAgentXray(renderer, ctx, buildingDrawables) {
    if (!renderer.buildingRenderer || !renderer.assets) return;
    for (const drawable of buildingDrawables) {
        if (drawable.kind !== 'building-front' && drawable.kind !== 'building') continue;
        const dims = renderer.assets.getDims(drawable.entry.id);
        if (!dims) continue;
        const [ax, ay] = renderer.assets.getAnchor(drawable.entry.id);
        const left = drawable.wx - ax;
        const top = drawable.wy - ay;
        const right = left + dims.w;
        const bottom = top + dims.h;
        const frontY = drawable.sortY;
        for (const sprite of renderer.agentSprites.values()) {
            if (!sprite.selected) continue;
            const withinSpriteBounds = sprite.x >= left - 12
                && sprite.x <= right + 12
                && sprite.y >= top
                && sprite.y <= bottom + 12;
            if (withinSpriteBounds && sprite.y < frontY) {
                sprite.drawXraySilhouette(ctx);
                return;
            }
        }
    }
}

function drawDebugOverlay(renderer, ctx, atmosphere, viewport) {
    const overlay = renderer.debugOverlay;
    // Shift-D owns pass sampling, but only at its edges: a per-frame write
    // would stomp a deliberate setPassSamplingEnabled() measurement made with
    // the overlay hidden (the overlay's own draw cost would then be inside
    // every comparison).
    if (renderer._debugPassSampling !== Boolean(overlay?.enabled)) {
        renderer._debugPassSampling = Boolean(overlay?.enabled);
        renderer.gpuWorld?.setPassSamplingEnabled?.(renderer._debugPassSampling);
    }
    if (!overlay?.enabled && !overlay?.pathDebugEnabled) return;
    const visitIntentDebug = overlay.enabled ? (renderer.visitIntentManager?.debugSnapshot?.() || null) : null;
    const visitReservationDebug = overlay.enabled ? (renderer.visitTileAllocator?.debug?.() || null) : null;
    renderer.camera.applyTransform(ctx);
    overlay.draw(ctx, {
        walkabilityGrid: renderer.walkabilityGrid,
        bridgeTiles: renderer.bridgeTiles,
        agentSprites: renderer.agentSprites,
        buildings: renderer.world?.buildings,
        sceneryZones: renderer.scenery?.getBuildingSceneryZones?.() || [],
        treeProps: renderer.treePropSprites,
        boulderProps: renderer.boulderPropSprites,
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        buildingRenderer: renderer.buildingRenderer,
    });
    overlay.drawPathDebug(ctx, { agentSprites: renderer.agentSprites });
    renderer._resetScreenTransform(ctx);
    if (!overlay.enabled) return;
    renderer._drawAtmosphereDebug(ctx, atmosphere);
    renderer.debugOverlay.drawScreen(ctx, {
        renderer,
        visitIntents: visitIntentDebug,
        visitReservations: visitReservationDebug,
        agentSprites: renderer.agentSprites,
        viewport,
        panelY: 180,
        behaviorStats: renderer._agentBehaviorStats(),
        renderStats: renderer._lastRenderStats,
        // Integrator follow-up (plan 1.9): light inline camera snapshot — zoom
        // plus glide owner/state. DPR/backing pixels are derived by the overlay
        // from the viewport itself; no getCanvasBudget() call per frame.
        cameraState: cameraDebugState(renderer),
    });
}

function cameraDebugState(renderer) {
    const camera = renderer?.camera;
    if (!camera) return null;
    return {
        zoom: camera.zoom,
        owner: camera._cameraOwner || null,
        gliding: Boolean(camera.isDirectorGliding?.()),
    };
}

function buildRenderStats(renderer, {
    drawableStats,
    cullingStats,
    harborPendingRepos,
    inputCounts,
    sceneCategoryResolution,
    agentRenderMode = 'full',
    annotationMode = 'full',
}) {
    const pendingRepos = Array.isArray(harborPendingRepos) ? harborPendingRepos : [];
    return {
        drawables: drawableStats,
        culling: cullingStats,
        inputs: inputCounts,
        harbor: {
            pendingRepos: pendingRepos.length,
            pendingCommits: pendingRepos.reduce((sum, repo) => sum + (Number(repo.pendingCommits ?? repo.count) || 0), 0),
            failedPushes: pendingRepos.reduce((sum, repo) => sum + (Number(repo.failedPushes) || 0), 0),
            bridgeLanterns: Number(inputCounts?.sceneCategories?.['bridge-lantern']) || 0,
        },
        canvas: {
            particles: renderer.particleSystem?.particles?.length || 0,
            lightGradients: renderer.lightGradientCache?.size || 0,
            lightSources: renderer._frameLightSources?.ambient?.length || 0,
        },
        director: renderer.villageDirector?.getStats?.() || null,
        quality: {
            agentRenderMode,
            annotationMode,
            worldRendererMode: renderer.worldRendererMode || 'canvas',
            gpuWorld: renderer.gpuWorld?.getDiagnostics?.() || null,
            sceneCategories: sceneCategoryResolution?.categories || [],
        },
        terrainCache: renderer.getTerrainCacheDiagnostics?.() || null,
        timings: renderer._lastRenderStats?.timings || null,
    };
}

function sceneCommandBackend(renderer, backend) {
    const adapter = renderer._sceneCommandBackend || (renderer._sceneCommandBackend = {
        id: 'gpu-world',
        backend: null,
        supportsSceneCommands(request) {
            return this.backend?.supportsSceneCommands?.(request) === true;
        },
    });
    adapter.id = backend?.backendId || backend?.constructor?.name || 'gpu-world';
    adapter.backend = backend;
    return adapter;
}

function emitSceneCategoryDiagnostics(renderer, diagnostics = []) {
    if (!diagnostics.length) return;
    const emitted = (renderer._sceneCategoryDiagnostics ||= new Set());
    for (const diagnostic of diagnostics) {
        const key = `${diagnostic.code}:${diagnostic.backendId}:${diagnostic.categoryId}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        console.warn(diagnostic.message);
    }
}

function frameTimingRequested(renderer) {
    return Boolean(renderer?.debugOverlay?.enabled || renderer?._performanceSamples);
}

function createFrameTimer() {
    return {
        start: 0,
        last: 0,
        markCount: 0,
        maxMarks: FRAME_TIMER_MAX_MARKS,
        dropped: 0,
        lastTotalMs: 0,
        markLabels: new Array(FRAME_TIMER_MAX_MARKS),
        markMs: new Float64Array(FRAME_TIMER_MAX_MARKS),
        segmentPool: Array.from({ length: FRAME_TIMER_MAX_MARKS }, () => ({ label: '', ms: 0, p95: 0 })),
        lastTimings: { totalMs: 0, totalP50: 0, totalP95: 0, segments: [] },
    };
}

function beginFrameTiming(renderer) {
    if (!frameTimingRequested(renderer)) return null;
    const timer = renderer._frameTimer || (renderer._frameTimer = createFrameTimer());
    const now = performance.now();
    timer.start = now;
    timer.last = now;
    timer.markCount = 0;
    return timer;
}

function markFrameTiming(timer, label) {
    if (!timer) return;
    const now = performance.now();
    const ms = now - timer.last;
    timer.last = now;
    if (timer.markCount >= timer.maxMarks) {
        timer.dropped += 1;
        return;
    }
    const index = timer.markCount;
    timer.markLabels[index] = label;
    timer.markMs[index] = ms;
    timer.markCount = index + 1;
}

function writeFrameTimingSample(renderer, label, ms) {
    const rings = renderer._frameTimingSamples || (renderer._frameTimingSamples = new Map());
    let ring = rings.get(label);
    if (!ring) {
        ring = createBoundedRing(FRAME_TIMING_RING_CAPACITY);
        rings.set(label, ring);
    }
    writeBoundedRing(ring, ms);
}

function finishFrameTiming(renderer, timer) {
    if (!timer) return renderer?._lastRenderStats?.timings || null;
    const totalMs = performance.now() - timer.start;
    timer.lastTotalMs = totalMs;
    writeFrameTimingSample(renderer, 'total', totalMs);
    const timings = timer.lastTimings;
    const segments = timings.segments;
    const pool = timer.segmentPool;
    for (let i = 0; i < timer.markCount; i++) {
        const label = timer.markLabels[i];
        const ms = timer.markMs[i];
        writeFrameTimingSample(renderer, label, ms);
        const slot = pool[i];
        slot.label = label;
        slot.ms = ms;
        slot.p95 = 0;
        segments[i] = slot;
    }
    segments.length = timer.markCount;
    timings.totalMs = totalMs;
    timings.totalP50 = 0;
    timings.totalP95 = 0;
    if (timer.dropped) {
        if (renderer._frameEnvelope) renderer._frameEnvelope.droppedSamples += timer.dropped;
        timer.dropped = 0;
    }
    return timings;
}
