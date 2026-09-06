import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import {
    GULL_BANK_FRAME,
    GULL_FLIGHT_FRAMES,
    GULL_LIGHTHOUSE_HOTSPOT,
    GULL_OFFMAP_GATEWAYS,
    GULL_ROUTE_SPEED_SCALE,
    GULL_STAGING_WAYPOINTS,
    LAND_BIRD_ROUTES,
    CALM_WATER_FAUNA,
    SHORE_FAUNA,
    MARINE_FISH_SCHOOLS,
    OPEN_SEA_FLOCK_FORMATION,
    OPEN_SEA_FLOCK_ROUTES,
    WATCHTOWER_GULL_FALLBACK_TILE,
    WATCHTOWER_GULL_ORBIT,
} from '../../config/scenery.js';

const GULL_BASE_POPULATION = OPEN_SEA_FLOCK_ROUTES.reduce((sum, flock) => sum + flock.size, 0);
const GULL_MAX_POPULATION = GULL_BASE_POPULATION * 3;
const GULL_MIN_ACTIVE_TARGET = Math.max(1, Math.floor(GULL_BASE_POPULATION / 4));
const GULL_MAX_ACTIVE_TARGET = Math.max(GULL_MIN_ACTIVE_TARGET, Math.floor(GULL_MAX_POPULATION / 2));
// #39 — how long a celebratory flock scatter holds the active-gull target at
// its maximum after a harbor push-success / git push.
const GULL_SCATTER_DURATION_MS = 6000;
const WILDLIFE_SCENE_ITEMS = Object.freeze([
    Object.freeze({
        sourceCategory: 'wildlife',
        stableKey: 'wildlife:ground-and-air',
        sortY: -1000000,
    }),
]);

// Wildlife and waterfalls are world detail rather than occluders. Keeping the
// whole layer overlay-safe lets the Canvas fallback retain its original early
// draw order while the direct GPU island replays it on the transparent overlay.
export const WILDLIFE_SCENE_CATEGORY = Object.freeze({
    id: 'wildlife',
    sortBand: 40,
    enumerate({ renderer } = {}) {
        return renderer?.wildlifeRenderer ? WILDLIFE_SCENE_ITEMS : [];
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        const wildlife = context.renderer?.wildlifeRenderer;
        wildlife?.drawSceneLayer?.(ctx, context.renderNow);
    },
    unsupported: 'overlay-safe',
    overlayBand: 40,
});

// Owns fauna animation state. The host supplies stable world classifiers,
// culling, renderer services, and the live frame/motion values.
export class WildlifeRenderer {
    constructor(host) {
        this.host = host;
        this.openSeaFlockBirds = this._buildOpenSeaFlockBirds();
        this._landBirdRoutes = null;
        this._landBirdLastNow = 0;
        this._gullScatterUntil = 0;
        this._sceneFrameToken = null;
        this._sceneFrameNow = 0;
    }

    drawSceneLayer(ctx, frameToken = null) {
        if (this._sceneFrameToken !== frameToken) {
            this._sceneFrameToken = frameToken;
            this._sceneFrameNow = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
        }
        this.drawFishSchools(ctx);
        this.drawWaterfowl(ctx);
        this.host._drawTropicalWaterfalls?.(ctx);
        this.drawOpenSeaGulls(ctx);
        this.drawLandBirds(ctx, this._sceneFrameNow);
    }

    drawFishSchools(ctx) {
        if (!this.host.motionScale || !this.host.sprites || !MARINE_FISH_SCHOOLS.length) return;
        const visible = this.host._getVisibleTileBounds(2);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const fish of MARINE_FISH_SCHOOLS.slice(0, 12)) {
            const baseX = Math.floor(fish.tileX);
            const baseY = Math.floor(fish.tileY);
            if (baseX < visible.startX || baseX > visible.endX || baseY < visible.startY || baseY > visible.endY) continue;
            const key = `${baseX},${baseY}`;
            const isLagoon = this.host.lagoonWaterTiles?.has(key);
            if (!this.host.waterTiles.has(key) || (this.host.deepWaterTiles.has(key) && !isLagoon) || this.host.bridgeTiles?.has(key)) continue;
            if (this._isHarborLabelZone(baseX, baseY)) continue;

            const swim = Math.sin(this.host.waterFrame * 1.4 + fish.phase) * (fish.radius ?? 0.25);
            const drift = Math.cos(this.host.waterFrame * 0.9 + fish.phase) * 0.12;
            const tileX = fish.tileX + swim;
            const tileY = fish.tileY + drift;
            const x = (tileX - tileY) * TILE_WIDTH / 2;
            const y = (tileX + tileY) * TILE_HEIGHT / 2;
            this.host.sprites.drawSprite(ctx, fish.id, x, y, { alpha: 0.48 });
        }
        ctx.restore();
    }

    // Calm-water ducks + shoreline herons. Ducks drift on lagoon water with a
    // gentle paddle; herons stand at the shore with a small bob. Reduced motion
    // freezes both in place (still readable).
    drawWaterfowl(ctx) {
        if (!this.host.sprites) return;
        const visible = this.host._getVisibleTileBounds(2);
        ctx.save();
        for (const duck of CALM_WATER_FAUNA) {
            const bx = Math.floor(duck.tileX);
            const by = Math.floor(duck.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            if (!this.host.waterTiles.has(`${bx},${by}`) || this.host.bridgeTiles?.has(`${bx},${by}`)) continue;
            const swim = this.host.motionScale ? Math.sin(this.host.waterFrame * 0.7 + duck.phase) * (duck.radius ?? 0.15) : 0;
            const drift = this.host.motionScale ? Math.cos(this.host.waterFrame * 0.5 + duck.phase) * 0.06 : 0;
            const tileX = duck.tileX + swim;
            const tileY = duck.tileY + drift;
            this.host.sprites.drawSprite(ctx, duck.id, (tileX - tileY) * TILE_WIDTH / 2, (tileX + tileY) * TILE_HEIGHT / 2);
        }
        for (const heron of SHORE_FAUNA) {
            const bx = Math.floor(heron.tileX);
            const by = Math.floor(heron.tileY);
            if (bx < visible.startX || bx > visible.endX || by < visible.startY || by > visible.endY) continue;
            const bob = this.host.motionScale ? Math.sin(this.host.waterFrame * 0.4 + heron.tileX) * 0.5 : 0;
            const x = (heron.tileX - heron.tileY) * TILE_WIDTH / 2;
            const y = (heron.tileX + heron.tileY) * TILE_HEIGHT / 2 + bob;
            this.host.sprites.drawSprite(ctx, heron.id, x, y);
        }
        ctx.restore();
    }

    // Songbirds flitting on small looping flight paths between the trees of the
    // inhabited belt — the land analogue of the sea gulls. Wing frames cycle
    // when motion is on; a single gliding frame is shown under reduced motion.
    drawLandBirds(ctx, frameNow = null) {
        if (!this.host.sprites || !LAND_BIRD_ROUTES.length) return;
        if (!this._landBirdRoutes) {
            this._landBirdRoutes = LAND_BIRD_ROUTES.map((r) => ({
                route: this._normalizeGullRoute(r.points),
                speed: r.speed ?? 0.018,
                altitude: r.altitude ?? 26,
                phase: r.phase ?? 0,
                wingRate: r.wingRate ?? 6,
                // #39 — flutter-pause: songbirds flutter along the route, then
                // perch-hold for 1–3s at the route point before fluttering on.
                // `progress` advances only while fluttering; held position is
                // captured at the moment a perch begins. State seeds vary so the
                // three birds don't perch in unison.
                progress: (r.phase ?? 0) % 1,
                state: 'flutter',
                stateUntil: 0,
                perchProgress: (r.phase ?? 0) % 1,
            }));
        }
        const now = Number.isFinite(frameNow)
            ? frameNow
            : (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
        const dtMs = this._landBirdLastNow ? Math.max(0, Math.min(120, now - this._landBirdLastNow)) : 0;
        this._landBirdLastNow = now;
        const visible = this.host._getVisibleTileBounds(3);
        ctx.save();
        for (const bird of this._landBirdRoutes) {
            let progress;
            let perched;
            if (!this.host.motionScale) {
                // Reduced motion: every songbird is a static perched bird, held
                // at a deterministic point on its route.
                progress = bird.phase % 1;
                perched = true;
            } else {
                if (now >= bird.stateUntil) {
                    if (bird.state === 'flutter') {
                        bird.state = 'perch';
                        bird.perchProgress = bird.progress;
                        bird.stateUntil = now + 1000 + this._gullUnitNoise(bird.phase * 17.3 + now * 0.0001) * 2000;
                    } else {
                        bird.state = 'flutter';
                        bird.stateUntil = now + 1400 + this._gullUnitNoise(bird.phase * 23.9 + now * 0.0002) * 2600;
                    }
                }
                if (bird.state === 'flutter') {
                    bird.progress = ((bird.progress + bird.speed * (dtMs / 16)) % 1 + 1) % 1;
                }
                progress = bird.state === 'perch' ? bird.perchProgress : bird.progress;
                perched = bird.state === 'perch';
            }
            const p = this._pointOnGullRoute(bird.route, progress);
            const bx = Math.floor(p.tileX);
            const by = Math.floor(p.tileY);
            if (bx < visible.startX - 2 || bx > visible.endX + 2 || by < visible.startY - 2 || by > visible.endY + 2) continue;
            const gx = (p.tileX - p.tileY) * TILE_WIDTH / 2;
            const gy = (p.tileX + p.tileY) * TILE_HEIGHT / 2;
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.ellipse(gx, gy, 4, 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            let frame = 'prop.songbird';
            if (this.host.motionScale && !perched) {
                const f = Math.floor(this.host.waterFrame * bird.wingRate + bird.phase * 11) % 4;
                frame = f === 0 ? 'prop.songbird.up' : f === 2 ? 'prop.songbird.down' : 'prop.songbird';
            }
            // Perched birds settle lower (drop the flight altitude toward a
            // rooftop sit) and use the level wings-folded frame.
            const altitude = perched ? bird.altitude * 0.18 : bird.altitude;
            this.host.sprites.drawSprite(ctx, frame, gx, gy - altitude);
        }
        ctx.restore();
    }

    _isHarborLabelZone(tileX, tileY) {
        return tileX >= 31 && tileX <= 38 && tileY >= 18 && tileY <= 23;
    }

    _buildOpenSeaFlockBirds() {
        const birds = [];

        const waveCount = Math.max(1, Math.ceil(GULL_MAX_POPULATION / GULL_BASE_POPULATION));
        for (let wave = 0; wave < waveCount; wave++) {
            OPEN_SEA_FLOCK_ROUTES.forEach((flock, flockIndex) => {
                const route = this._normalizeGullRoute(flock.route);
                const count = Math.max(1, flock.size || OPEN_SEA_FLOCK_FORMATION.length);
                for (let member = 0; member < count; member++) {
                    const formation = OPEN_SEA_FLOCK_FORMATION[member % OPEN_SEA_FLOCK_FORMATION.length];
                    const seed = (wave + 1) * 31.41 + (flockIndex + 1) * 23.17 + member * 8.31;
                    const activeSpan = 0.70 + ((Math.sin(seed * 1.37) + 1) / 2) * 0.18;
                    birds.push({
                        route,
                        wave,
                        flockIndex,
                        altitude: flock.altitude + ((member + wave) % 4) * 2.8 + wave * 1.4,
                        phase: flock.phase + member * 0.011,
                        memberPhase: seed,
                        sideOffset: formation.side + Math.sin(seed) * 0.10,
                        trailOffset: formation.trail + Math.cos(seed * 0.73) * 0.08,
                        speed: flock.speed * GULL_ROUTE_SPEED_SCALE * (0.82 + wave * 0.07 + (member % 3) * 0.018),
                        wingRate: flock.wingRate * (0.92 + (member % 4) * 0.045),
                        alpha: 0.66 + (member % 3) * 0.08,
                        activeSpan,
                        cycleOffset: ((seed * 0.61803398875) % 1 + 1) % 1,
                        entryIndex: (flockIndex + member + wave * 2) % GULL_OFFMAP_GATEWAYS.length,
                        exitIndex: (flockIndex * 3 + member * 2 + wave) % GULL_OFFMAP_GATEWAYS.length,
                        waypointIndex: (flockIndex + member + wave) % GULL_STAGING_WAYPOINTS.length,
                        orbitRadiusX: 1.55 + ((Math.sin(seed * 0.43) + 1) / 2) * 1.10,
                        orbitRadiusY: 1.05 + ((Math.cos(seed * 0.61) + 1) / 2) * 0.75,
                        orbitStart: seed * 0.27,
                        orbitTurns: 0.72 + ((member + wave) % 3) * 0.22,
                        orbitDirection: (member + flockIndex + wave) % 2 === 0 ? 1 : -1,
                    });
                }
            });
        }

        return birds;
    }

    _normalizeGullRoute(points = []) {
        const routePoints = points.map((point) => ({
            tileX: point.tileX,
            tileY: point.tileY,
        }));
        const cumulative = [0];
        let totalLength = 0;

        for (let i = 0; i < routePoints.length; i++) {
            const from = routePoints[i];
            const to = routePoints[(i + 1) % routePoints.length];
            const length = Math.max(0.001, Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY));
            totalLength += length;
            cumulative.push(totalLength);
        }

        return {
            points: routePoints,
            cumulative,
            totalLength: Math.max(0.001, totalLength),
        };
    }

    _pointOnGullRoute(route, progress) {
        const normalized = ((progress % 1) + 1) % 1;
        const distance = normalized * route.totalLength;
        let segmentIndex = 0;
        for (let i = 0; i < route.points.length; i++) {
            if (distance >= route.cumulative[i] && distance <= route.cumulative[i + 1]) {
                segmentIndex = i;
                break;
            }
        }

        const from = route.points[segmentIndex];
        const to = route.points[(segmentIndex + 1) % route.points.length];
        const startDistance = route.cumulative[segmentIndex];
        const segmentLength = Math.max(0.001, route.cumulative[segmentIndex + 1] - startDistance);
        const t = (distance - startDistance) / segmentLength;
        const dx = to.tileX - from.tileX;
        const dy = to.tileY - from.tileY;
        const length = Math.max(0.001, Math.hypot(dx, dy));

        return {
            tileX: from.tileX + dx * t,
            tileY: from.tileY + dy * t,
            tangentX: dx / length,
            tangentY: dy / length,
        };
    }

    _loopingPick(list, index) {
        return list[((index % list.length) + list.length) % list.length];
    }

    _gullUnitNoise(seed) {
        const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
        return value - Math.floor(value);
    }

    // #39 — record a push-success so the gull flock scatters skyward for a
    // few seconds. Bounded by performance.now(); read by `_gullActiveTarget`
    // and (via the renderer-supplied getter) by SeasonalAmbience suppression.
    triggerGullScatter() {
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        this._gullScatterUntil = now + GULL_SCATTER_DURATION_MS;
    }

    gullScatterActive() {
        if (!this._gullScatterUntil) return false;
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        return now < this._gullScatterUntil;
    }

    _gullActiveTarget(cycleIndex) {
        // While a push-success scatter is live, drive every route to the max
        // active target so the whole flock takes wing at once.
        if (this.gullScatterActive()) return GULL_MAX_ACTIVE_TARGET;
        const range = GULL_MAX_ACTIVE_TARGET - GULL_MIN_ACTIVE_TARGET;
        return GULL_MIN_ACTIVE_TARGET + Math.floor(this._gullUnitNoise(cycleIndex + 19.37) * (range + 1));
    }

    _isGullCycleEnabled(gull, cycleIndex) {
        const target = this._gullActiveTarget(cycleIndex);
        const rank = this._gullUnitNoise(gull.memberPhase + cycleIndex * 7.31 + gull.wave * 13.7);
        return rank <= Math.min(1, target / (GULL_MAX_POPULATION * 0.72));
    }

    _gullVisitsLighthouse(gull, cycleIndex) {
        return this._gullUnitNoise(gull.memberPhase + cycleIndex * 5.17 + gull.flockIndex * 2.11) < 0.58;
    }

    _lerpPoint(from, to, t) {
        return {
            tileX: from.tileX + (to.tileX - from.tileX) * t,
            tileY: from.tileY + (to.tileY - from.tileY) * t,
        };
    }

    _quadraticPoint(from, control, to, t) {
        const a = this._lerpPoint(from, control, t);
        const b = this._lerpPoint(control, to, t);
        return this._lerpPoint(a, b, t);
    }

    _gullGateway(gull, cycleIndex, kind) {
        const bias = kind === 'exit' ? 3 : 0;
        const baseIndex = kind === 'exit' ? gull.exitIndex : gull.entryIndex;
        return this._loopingPick(GULL_OFFMAP_GATEWAYS, baseIndex + cycleIndex * (kind === 'exit' ? 3 : 2) + bias);
    }

    _gullStagingPoint(gull, cycleIndex, kind) {
        const waypoint = this._loopingPick(
            GULL_STAGING_WAYPOINTS,
            gull.waypointIndex + cycleIndex * (kind === 'exit' ? 2 : 1)
        );
        const routePoint = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.19 + (kind === 'exit' ? 0.37 : 0)) % 1 + 1) % 1
        );
        const mix = kind === 'exit' ? 0.42 : 0.58;
        return {
            tileX: waypoint.tileX * mix + routePoint.tileX * (1 - mix),
            tileY: waypoint.tileY * mix + routePoint.tileY * (1 - mix),
        };
    }

    _gullOrbitPoint(gull, travelT) {
        const angle = gull.orbitStart + travelT * Math.PI * 2 * gull.orbitTurns * gull.orbitDirection;
        const wobble = Math.sin(angle * 1.7 + gull.memberPhase) * 0.18;
        return {
            tileX: GULL_LIGHTHOUSE_HOTSPOT.tileX + Math.cos(angle) * (gull.orbitRadiusX + wobble),
            tileY: GULL_LIGHTHOUSE_HOTSPOT.tileY + Math.sin(angle) * (gull.orbitRadiusY + wobble * 0.65),
        };
    }

    _gullJourneyPoint(gull, cycleIndex, t) {
        const entry = this._gullGateway(gull, cycleIndex, 'entry');
        const exit = this._gullGateway(gull, cycleIndex, 'exit');
        const inbound = this._gullStagingPoint(gull, cycleIndex, 'entry');
        const outbound = this._gullStagingPoint(gull, cycleIndex, 'exit');
        const openWaterMid = this._pointOnGullRoute(
            gull.route,
            ((gull.phase + cycleIndex * 0.23 + 0.18) % 1 + 1) % 1
        );
        if (!this._gullVisitsLighthouse(gull, cycleIndex)) {
            if (t < 0.32) {
                return this._quadraticPoint(entry, inbound, inbound, t / 0.32);
            }
            if (t < 0.68) {
                return this._quadraticPoint(inbound, openWaterMid, outbound, (t - 0.32) / 0.36);
            }
            return this._quadraticPoint(outbound, outbound, exit, (t - 0.68) / 0.32);
        }

        const orbitStart = this._gullOrbitPoint(gull, 0);
        const orbitEnd = this._gullOrbitPoint(gull, 1);

        if (t < 0.28) {
            return this._quadraticPoint(entry, inbound, inbound, t / 0.28);
        }
        if (t < 0.44) {
            return this._quadraticPoint(inbound, this._lerpPoint(inbound, orbitStart, 0.55), orbitStart, (t - 0.28) / 0.16);
        }
        if (t < 0.60) {
            return this._gullOrbitPoint(gull, (t - 0.44) / 0.16);
        }
        return this._quadraticPoint(orbitEnd, outbound, exit, (t - 0.60) / 0.40);
    }

    _openSeaGullPositions() {
        const reducedMotion = !this.host.motionScale;
        const time = this.host.motionScale ? this.host.waterFrame : 0;
        return this.openSeaFlockBirds.map((gull) => {
            const rawCycle = time * gull.speed + gull.cycleOffset;
            const cycleIndex = Math.floor(rawCycle);
            // Under reduced motion every gull becomes a deterministic
            // in-flight snapshot — fold cycleOffset back into the active
            // window so birds whose offset > activeSpan still render, and
            // skip the population gate so each route keeps at least one
            // visible bird.
            const cyclePhase = reducedMotion
                ? (gull.cycleOffset % gull.activeSpan)
                : (rawCycle - cycleIndex);
            if (!reducedMotion && !this._isGullCycleEnabled(gull, cycleIndex)) return null;
            if (cyclePhase > gull.activeSpan) return null;

            const journeyT = cyclePhase / gull.activeSpan;
            const routePoint = this._gullJourneyPoint(gull, cycleIndex, journeyT);
            const turnProbe = this._gullJourneyPoint(gull, cycleIndex, Math.min(1, journeyT + 0.006));
            const dx = turnProbe.tileX - routePoint.tileX;
            const dy = turnProbe.tileY - routePoint.tileY;
            const tangentLength = Math.max(0.001, Math.hypot(dx, dy));
            const tangentX = dx / tangentLength;
            const tangentY = dy / tangentLength;
            const sideX = -tangentY;
            const sideY = tangentX;
            const spread = 1 + (this.host.motionScale ? Math.sin(time * 0.9 + gull.memberPhase) * 0.10 : 0);
            const wander = this.host.motionScale ? Math.sin(time * 0.72 + gull.memberPhase) * 0.08 : 0;
            const tileX = routePoint.tileX + sideX * gull.sideOffset * spread + tangentX * wander;
            const tileY = routePoint.tileY + sideY * gull.sideOffset * spread + tangentY * wander;
            const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
            const bob = this.host.motionScale ? Math.sin(time * 1.1 + gull.memberPhase) * 2.4 : 0;
            // #39 — fishing dive: over the open-water midsection a gull folds
            // and plunges toward the surface, then climbs back to cruise. A
            // half-sine well over [0.40, 0.62] of the journey reduces altitude
            // by up to ~80% (a near-surface skim) and recovers. Lighthouse
            // visitors keep their orbit altitude; dives skip under reduced
            // motion (held cruise snapshot).
            let diveDrop = 0;
            let diving = false;
            if (this.host.motionScale && !this._gullVisitsLighthouse(gull, cycleIndex)) {
                const DIVE_START = 0.40;
                const DIVE_END = 0.62;
                if (journeyT >= DIVE_START && journeyT <= DIVE_END) {
                    const dt = (journeyT - DIVE_START) / (DIVE_END - DIVE_START);
                    const well = Math.sin(dt * Math.PI);
                    diveDrop = well * gull.altitude * 0.80;
                    diving = well > 0.45;
                }
            }
            const screenVx = (dx - dy) * TILE_WIDTH / 2;
            const screenVy = (dx + dy) * TILE_HEIGHT / 2;
            const orbiting = this._gullVisitsLighthouse(gull, cycleIndex)
                && journeyT >= 0.44
                && journeyT <= 0.60;
            const turn = orbiting
                ? gull.orbitDirection * 0.6
                : sideX * dx + sideY * dy;
            const flapFrame = this.host.motionScale
                ? Math.floor(time * gull.wingRate + gull.memberPhase) % GULL_FLIGHT_FRAMES.length
                : 1;
            const banking = this.host.motionScale
                && Math.abs(turn + Math.sin(time * 0.55 + gull.memberPhase) * 0.42) > 0.36
                && flapFrame === 1;

            return {
                ...gull,
                tileX,
                tileY,
                x: (tileX - tileY) * TILE_WIDTH / 2,
                y: waterY - (gull.altitude - diveDrop) + bob,
                waterY,
                wing: this.host.motionScale ? Math.sin(time * 3.2 + gull.memberPhase) * 1.7 : 0.6,
                frameId: diving ? 'prop.gullFlight.down' : (banking ? GULL_BANK_FRAME : GULL_FLIGHT_FRAMES[flapFrame]),
                fallbackFrameId: 'prop.gullFlight',
                facing: screenVx < 0 ? -1 : 1,
                screenSpeed: Math.hypot(screenVx, screenVy),
            };
        }).filter(Boolean);
    }

    _isGullFlightTile(tileX, tileY) {
        if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) {
            return tileX >= -6 && tileX <= MAP_SIZE + 5 && tileY >= -6 && tileY <= MAP_SIZE + 5;
        }

        const lighthouseDx = (tileX - GULL_LIGHTHOUSE_HOTSPOT.tileX) / 4.2;
        const lighthouseDy = (tileY - GULL_LIGHTHOUSE_HOTSPOT.tileY) / 3.0;
        if ((lighthouseDx * lighthouseDx + lighthouseDy * lighthouseDy) <= 1) return true;

        const key = `${tileX},${tileY}`;
        if (!this.host.waterTiles.has(key) || this.host.bridgeTiles?.has(key)) return false;
        if (this._isHarborLabelZone(tileX, tileY)) return false;
        const openness = this.host._waterOpenness(tileX, tileY);
        if (this.host._isOpenSeaTile(tileX, tileY, openness)) return true;
        const eastSea = tileX >= 31 && tileY <= 34;
        const crossMapWater = tileY >= 22 && tileY <= 27;
        const northLagoonRun = tileY <= 11 && tileX >= 6;
        const broadLightWater = tileX >= 5 && tileX <= 35 && tileY <= 18;
        if (openness >= 0.38 && (eastSea || crossMapWater || northLagoonRun || broadLightWater)) return true;
        return this.host.deepWaterTiles.has(key) && openness >= 0.50;
    }

    _isGullInVisibleBounds(gull, bounds) {
        const tileX = Math.floor(gull.tileX);
        const tileY = Math.floor(gull.tileY);
        return tileX >= bounds.startX - 6
            && tileX <= bounds.endX + 6
            && tileY >= bounds.startY - 6
            && tileY <= bounds.endY + 6;
    }

    _drawGullShadow(ctx, gull) {
        const altitudeFade = Math.max(0.035, 0.18 - gull.altitude * 0.0032);
        const shadowWidth = Math.max(5, 15 - gull.altitude * 0.12);
        const shadowHeight = Math.max(2, 5 - gull.altitude * 0.035);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = altitudeFade * gull.alpha;
        ctx.fillStyle = 'rgba(7, 18, 30, 0.32)';
        ctx.beginPath();
        ctx.ellipse(Math.round(gull.x), Math.round(gull.waterY - 2), shadowWidth, shadowHeight, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawGullSprite(ctx, gull) {
        const frameId = this.host.assets?.get(gull.frameId) ? gull.frameId : gull.fallbackFrameId;
        const img = this.host.assets?.get(frameId);
        if (!img) return false;
        const [anchorX, anchorY] = this.host.assets.getAnchor(frameId);
        ctx.save();
        ctx.globalAlpha *= gull.alpha;
        ctx.translate(Math.round(gull.x), Math.round(gull.y));
        ctx.scale(gull.facing, 1);
        ctx.drawImage(img, Math.round(-anchorX), Math.round(-anchorY));
        ctx.restore();
        return true;
    }

    drawOpenSeaGulls(ctx) {
        if (!this.openSeaFlockBirds.length) return;
        const gulls = this._openSeaGullPositions();
        const visible = this.host._getVisibleTileBounds(5);
        const visibleGulls = gulls.filter((gull) => {
            const tileX = Math.floor(gull.tileX);
            const tileY = Math.floor(gull.tileY);
            return this._isGullInVisibleBounds(gull, visible)
                && this._isGullFlightTile(tileX, tileY);
        });

        // Single guardian gull orbiting the Pharos Lighthouse beacon. 30s
        // loop, low altitude; falls back to a held pose under reduced motion
        // so the silhouette still reads near the watchtower.
        const watchtowerGull = this._watchtowerGullPosition();
        if (watchtowerGull && this._isGullInVisibleBounds(watchtowerGull, visible)) {
            visibleGulls.push(watchtowerGull);
        }

        if (this.host.sprites) {
            ctx.save();
            for (const gull of visibleGulls) {
                this._drawGullShadow(ctx, gull);
            }
            for (const gull of visibleGulls) {
                if (!this._drawGullSprite(ctx, gull)) {
                    this.host.sprites.drawSprite(ctx, 'prop.gullFlight', gull.x, gull.y, { alpha: gull.alpha });
                }
            }
            ctx.restore();
            return;
        }

        ctx.save();
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        for (const gull of visibleGulls) {
            const span = 9;
            const lift = 4.2 + gull.wing;
            ctx.globalAlpha = 0.72;
            ctx.strokeStyle = 'rgba(22, 34, 44, 0.36)';
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(gull.x - span, gull.y + 1);
            ctx.lineTo(gull.x, gull.y - lift + 1);
            ctx.lineTo(gull.x + span, gull.y + 1);
            ctx.stroke();
            ctx.globalAlpha = 0.82;
            ctx.strokeStyle = 'rgba(235, 244, 232, 0.88)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(gull.x - span, gull.y);
            ctx.lineTo(gull.x, gull.y - lift);
            ctx.lineTo(gull.x + span, gull.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Watchtower beacon gull. Single bird looping the Pharos Lighthouse at
    // WATCHTOWER_GULL_ORBIT. Reduced motion (motionScale === 0) pins the gull
    // at the start-of-orbit anchor so the silhouette remains.
    _watchtowerGullPosition() {
        if (!this.host.assets?.has?.('prop.gullFlight')) return null;
        const motionScale = this.host.motionScale ?? 1;
        let tileX;
        let tileY;
        let facing = 1;
        let frameId = 'prop.gullFlight.level';
        if (motionScale <= 0) {
            tileX = WATCHTOWER_GULL_FALLBACK_TILE.tileX;
            tileY = WATCHTOWER_GULL_FALLBACK_TILE.tileY;
        } else {
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const t = (now % WATCHTOWER_GULL_ORBIT.periodMs) / WATCHTOWER_GULL_ORBIT.periodMs;
            const angle = t * Math.PI * 2;
            tileX = WATCHTOWER_GULL_ORBIT.centerTileX + Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
            tileY = WATCHTOWER_GULL_ORBIT.centerTileY + Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
            const tangentX = -Math.sin(angle) * WATCHTOWER_GULL_ORBIT.radiusTileX;
            const tangentY = Math.cos(angle) * WATCHTOWER_GULL_ORBIT.radiusTileY;
            const screenVx = (tangentX - tangentY) * TILE_WIDTH / 2;
            facing = screenVx < 0 ? -1 : 1;
            const flapIndex = Math.floor(now * 0.006) % GULL_FLIGHT_FRAMES.length;
            frameId = GULL_FLIGHT_FRAMES[flapIndex];
        }
        const waterY = (tileX + tileY) * TILE_HEIGHT / 2;
        return {
            tileX,
            tileY,
            x: (tileX - tileY) * TILE_WIDTH / 2,
            y: waterY - WATCHTOWER_GULL_ORBIT.altitudePx,
            waterY,
            altitude: WATCHTOWER_GULL_ORBIT.altitudePx,
            alpha: 0.92,
            wing: 0.6,
            frameId,
            fallbackFrameId: 'prop.gullFlight',
            facing,
            screenSpeed: 0,
        };
    }
}
