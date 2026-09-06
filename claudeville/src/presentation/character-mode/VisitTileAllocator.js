import { normalizeBuildingType, VISIT_OVERFLOW_TILES } from '../../config/buildings.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';

const DEFAULT_RESERVATION_TTL_MS = 20000;
const TILE_OCCUPANCY_RADIUS = 0.78;
const BUILDING_OCCUPANCY_RADIUS = 1.15;
const WALKABILITY_PENALTY = 240;
const RESERVED_PENALTY = 180;
const TILE_CROWD_PENALTY = 70;
const BUILDING_CROWD_PENALTY = 18;
const OVER_CAPACITY_PENALTY = 130;
const DISTANCE_WEIGHT = 0.15;
const SAME_AGENT_SLOT_BONUS = 90;
const RELATED_CLUSTER_BONUS = 45;
const RELATED_CLUSTER_RADIUS = 3.0;
const TARGET_SLOT_INDEX_BONUS = 80;
const LOCAL_CLUSTER_RADIUS = 2.4;
const LOCAL_CLUSTER_PENALTY = 12;
const CROWD_CLUSTER_CELL_SIZE = 4;
const CROWD_CLUSTER_TOP_LIMIT = 12;

const BUILDING_CAPACITY_OVERRIDES = Object.freeze({
    command: 5,
    taskboard: 4,
    forge: 4,
    mine: 4,
    archive: 4,
    observatory: 3,
    portal: 4,
    harbor: 4,
    watchtower: 2,
});

export class VisitTileAllocator {
    constructor({
        reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
    } = {}) {
        this.reservationTtlMs = Math.max(1000, Number(reservationTtlMs) || DEFAULT_RESERVATION_TTL_MS);
        this.buildings = new Map();
        this.agentSprites = [];
        this.pathfinder = null;
        this.reservations = new Map();
        this.agentReservationIds = new Map();
        this.agentMeta = new Map();
        this._relatedCache = new Map();
        this._sequence = 0;
        this.metrics = {
            allocations: 0,
            rejected: 0,
            releases: 0,
            renewals: 0,
            expired: 0,
            staleReleases: 0,
            unwalkableSkipped: 0,
            scenicAllocations: 0,
            overflowAllocations: 0,
            clusteredAllocations: 0,
            queuedAllocations: 0,
            overCapacityAllocations: 0,
            clusterPressureAllocations: 0,
        };
        this._occupancyEntries = [];
        this._occupancyBuckets = new Map();
        this._crowdClusters = [];
        this._disposed = false;
    }

    updateContext({
        buildings = this.buildings,
        agentSprites = this.agentSprites,
        pathfinder = this.pathfinder,
    } = {}) {
        if (this._disposed) return this;
        this.buildings = this._normalizeBuildings(buildings);
        this.agentSprites = this._normalizeAgentSprites(agentSprites);
        this.pathfinder = pathfinder || null;
        this._rebuildAgentMeta();
        this._rebuildOccupancyIndex();
        this.cleanup(Date.now());
        this._releaseStaleAgentReservations();
        return this;
    }

    _rebuildAgentMeta() {
        this.agentMeta.clear();
        this._relatedCache.clear();
        for (const sprite of this.agentSprites) {
            const agent = sprite?.agent;
            const id = this._agentId(agent, sprite, null);
            if (!id) continue;
            this.agentMeta.set(id, {
                teamName: agent?.teamName || null,
                parentSessionId: agent?.parentSessionId || null,
                isSubagent: !!agent?.isSubagent,
            });
        }
    }

    _relatedAgentIds(agentId) {
        if (!agentId) return null;
        if (this._relatedCache.has(agentId)) return this._relatedCache.get(agentId);
        const self = this.agentMeta.get(agentId);
        if (!self) {
            this._relatedCache.set(agentId, null);
            return null;
        }
        const related = new Set();
        if (self.parentSessionId) related.add(self.parentSessionId);
        for (const [otherId, meta] of this.agentMeta.entries()) {
            if (otherId === agentId) continue;
            if (meta.parentSessionId && meta.parentSessionId === agentId) related.add(otherId);
            if (self.parentSessionId && meta.parentSessionId && self.parentSessionId === meta.parentSessionId) related.add(otherId);
            if (self.teamName && meta.teamName && self.teamName === meta.teamName) related.add(otherId);
        }
        const result = related.size > 0 ? related : null;
        this._relatedCache.set(agentId, result);
        return result;
    }

    _rebuildOccupancyIndex() {
        this._occupancyEntries = [];
        this._occupancyBuckets = new Map();
        for (const sprite of this.agentSprites) {
            const agentId = this._agentId(sprite?.agent, sprite, null);
            if (!agentId) continue;
            const tile = this._spriteTile(sprite) || this._agentTile(sprite?.agent);
            if (!tile) continue;
            const entry = {
                agentId,
                tileX: tile.tileX,
                tileY: tile.tileY,
                status: sprite?.agent?.status || null,
                teamName: sprite?.agent?.teamName || null,
                parentSessionId: sprite?.agent?.parentSessionId || null,
                moving: !!sprite?.moving,
            };
            this._occupancyEntries.push(entry);
            const key = this._occupancyBucketKey(tile.tileX, tile.tileY);
            const bucket = this._occupancyBuckets.get(key) || [];
            bucket.push(entry);
            this._occupancyBuckets.set(key, bucket);
        }
        this._crowdClusters = this._summarizeCrowdClustersFromEntries();
    }

    _occupancyBucketKey(tileX, tileY) {
        return `${Math.floor(Number(tileX) || 0)},${Math.floor(Number(tileY) || 0)}`;
    }

    _nearbyOccupancyEntries(tileX, tileY, radius) {
        const x = Number(tileX);
        const y = Number(tileY);
        const r = Math.max(0, Number(radius) || 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !this._occupancyBuckets?.size) return [];
        const out = [];
        for (let bx = Math.floor(x - r); bx <= Math.floor(x + r); bx++) {
            for (let by = Math.floor(y - r); by <= Math.floor(y + r); by++) {
                const bucket = this._occupancyBuckets.get(`${bx},${by}`);
                if (bucket?.length) out.push(...bucket);
            }
        }
        return out;
    }

    _clusterPressureAt(tileX, tileY, ignoredAgentId) {
        if ((this._occupancyEntries?.length || 0) < 18) return 0;
        let count = 0;
        for (const entry of this._nearbyOccupancyEntries(tileX, tileY, LOCAL_CLUSTER_RADIUS)) {
            if (ignoredAgentId && entry.agentId === ignoredAgentId) continue;
            if (this._distance(entry, { tileX, tileY }) <= LOCAL_CLUSTER_RADIUS) count++;
        }
        return count;
    }

    _summarizeCrowdClustersFromEntries() {
        return summarizeCrowdClusterEntries(this._occupancyEntries, {
            cellSize: CROWD_CLUSTER_CELL_SIZE,
            topLimit: CROWD_CLUSTER_TOP_LIMIT,
            includeStatusCounts: true,
        }).clusters;
    }

    _crowdSnapshot() {
        const clusters = this._crowdClusters || [];
        return {
            agentCount: this._occupancyEntries?.length || 0,
            clusterCellSize: CROWD_CLUSTER_CELL_SIZE,
            clusters,
            denseClusterCount: clusters.length,
            maxClusterSize: clusters.reduce((max, cluster) => Math.max(max, cluster.count || 0), 0),
            congestedAgents: clusters.reduce((sum, cluster) => sum + (cluster.count || 0), 0),
        };
    }

    _nearestRelatedReservationDistance(agentId, buildingType, slot) {
        const related = this._relatedAgentIds(agentId);
        if (!related) return Infinity;
        let best = Infinity;
        for (const reservation of this.reservations.values()) {
            if (reservation.buildingType !== buildingType) continue;
            if (reservation.agentId === agentId) continue;
            if (!related.has(reservation.agentId)) continue;
            const dist = this._distance(reservation, slot);
            if (dist < best) best = dist;
        }
        return best;
    }

    allocate({
        agent,
        sprite = null,
        building = null,
        intent = null,
        candidates = null,
    } = {}) {
        if (this._disposed) return null;
        const now = Date.now();
        this.cleanup(now);

        const agentId = this._agentId(agent, sprite, intent);
        if (!agentId) {
            this.metrics.rejected++;
            return null;
        }

        const resolvedBuilding = this._resolveBuilding(building, intent);
        const buildingType = this._buildingType(resolvedBuilding, intent);
        const slots = this._candidateTiles({
            building: resolvedBuilding,
            buildingType,
            candidates,
            intent,
        });
        if (slots.length === 0) {
            this.metrics.rejected++;
            return null;
        }

        const existingReservation = this._reservationForAgent(agentId);
        const sourceTile = this._spriteTile(sprite) || this._agentTile(agent);
        const buildingCapacity = this._buildingCapacity(resolvedBuilding, buildingType, slots.length, intent);
        const buildingOccupancy = this._buildingOccupancy(resolvedBuilding, buildingType, agentId);
        const hasWalkableSlot = slots.some((slot) => this._isWalkable(slot.tileX, slot.tileY));

        let best = null;
        for (const slot of slots) {
            const scored = this._scoreSlot({
                slot,
                agentId,
                buildingType,
                sourceTile,
                buildingCapacity,
                buildingOccupancy,
                existingReservation,
                intent,
                now,
            });
            if (hasWalkableSlot && !scored.walkable) {
                this.metrics.unwalkableSkipped++;
                continue;
            }
            if (!best || scored.score < best.score || (scored.score === best.score && scored.slotId < best.slotId)) {
                best = scored;
            }
        }

        if (!best) {
            this.metrics.rejected++;
            return null;
        }

        const previousReservationId = this.agentReservationIds.get(agentId);
        if (previousReservationId) this.reservations.delete(previousReservationId);

        const reservationId = this._nextReservationId(agentId);
        const expiresAt = now + this._reservationTtl(intent);
        const reservation = {
            id: reservationId,
            agentId,
            buildingType: best.buildingType,
            tileX: best.tileX,
            tileY: best.tileY,
            slotId: best.slotId,
            slotIndex: Number.isInteger(best.slotIndex) ? best.slotIndex : null,
            intentId: intent?.id || null,
            createdAt: now,
            expiresAt,
            score: best.score,
            walkable: best.walkable,
            scenic: best.scenic,
            overflow: best.overflow,
            queueGroup: best.queueGroup,
            queueIndex: best.queueIndex,
            queueDepth: best.queueDepth,
            queueOverflow: best.queueOverflow,
            buildingCapacity: best.buildingCapacity,
            tileCapacity: best.tileCapacity,
            buildingOccupancy: best.buildingOccupancy,
            tileOccupancy: best.tileOccupancy,
            projectedBuildingUse: best.projectedBuildingUse,
            projectedTileUse: best.projectedTileUse,
            overBuildingCapacity: best.overBuildingCapacity,
            overTileCapacity: best.overTileCapacity,
            clusterPressure: best.clusterPressure,
            relatedCluster: best.clustered,
            relatedDistance: Number.isFinite(best.relatedDistance) ? best.relatedDistance : null,
            facingPoint: best.facingPoint
                ? { x: best.facingPoint.x, y: best.facingPoint.y }
                : null,
        };
        this.reservations.set(reservationId, reservation);
        this.agentReservationIds.set(agentId, reservationId);
        this.metrics.allocations++;
        if (reservation.scenic) this.metrics.scenicAllocations++;
        if (reservation.overflow) this.metrics.overflowAllocations++;
        if (best.clustered) this.metrics.clusteredAllocations++;
        if (reservation.queueIndex > 0) this.metrics.queuedAllocations++;
        if (reservation.queueOverflow) this.metrics.overCapacityAllocations++;
        if (reservation.clusterPressure > 0) this.metrics.clusterPressureAllocations++;

        return {
            tileX: reservation.tileX,
            tileY: reservation.tileY,
            slotId: reservation.slotId,
            slotIndex: reservation.slotIndex,
            reservationId,
            buildingType: reservation.buildingType,
            expiresAt,
            score: reservation.score,
            walkable: reservation.walkable,
            scenic: reservation.scenic,
            overflow: reservation.overflow,
            queueGroup: reservation.queueGroup,
            queueIndex: reservation.queueIndex,
            queueDepth: reservation.queueDepth,
            queueOverflow: reservation.queueOverflow,
            buildingCapacity: reservation.buildingCapacity,
            tileCapacity: reservation.tileCapacity,
            buildingOccupancy: reservation.buildingOccupancy,
            tileOccupancy: reservation.tileOccupancy,
            projectedBuildingUse: reservation.projectedBuildingUse,
            projectedTileUse: reservation.projectedTileUse,
            overBuildingCapacity: reservation.overBuildingCapacity,
            overTileCapacity: reservation.overTileCapacity,
            clusterPressure: reservation.clusterPressure,
            relatedCluster: reservation.relatedCluster,
            relatedDistance: reservation.relatedDistance,
            facingPoint: reservation.facingPoint,
        };
    }

    release(agentId) {
        const id = String(agentId || '');
        if (!id) return false;
        const reservationId = this.agentReservationIds.get(id);
        if (!reservationId) return false;
        this.agentReservationIds.delete(id);
        const released = this.reservations.delete(reservationId);
        if (released) this.metrics.releases++;
        return released;
    }

    releaseReservation(reservationId) {
        const id = String(reservationId || '');
        if (!id) return false;
        const reservation = this.reservations.get(id);
        if (!reservation) return false;
        this.reservations.delete(id);
        if (this.agentReservationIds.get(reservation.agentId) === id) {
            this.agentReservationIds.delete(reservation.agentId);
        }
        this.metrics.releases++;
        return true;
    }

    renew(agentId, ttlMs = null) {
        const id = String(agentId || '');
        if (!id) return false;
        const reservation = this._reservationForAgent(id);
        if (!reservation) return false;
        const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
            ? Math.max(1000, Number(ttlMs))
            : this.reservationTtlMs;
        reservation.expiresAt = Math.max(reservation.expiresAt, Date.now() + ttl);
        this.metrics.renewals++;
        return true;
    }

    cleanup(now = Date.now()) {
        const time = Number(now) || Date.now();
        for (const [id, reservation] of this.reservations.entries()) {
            if (reservation.expiresAt > time) continue;
            this.reservations.delete(id);
            if (this.agentReservationIds.get(reservation.agentId) === id) {
                this.agentReservationIds.delete(reservation.agentId);
            }
            this.metrics.expired++;
        }
        return this;
    }

    getBuildingLoads() {
        const counts = new Map();
        for (const reservation of this.reservations.values()) {
            let entry = counts.get(reservation.buildingType);
            if (!entry) {
                entry = { reserved: 0, queued: 0, overflowReserved: 0 };
                counts.set(reservation.buildingType, entry);
            }
            entry.reserved++;
            if (reservation.queueOverflow) {
                entry.queued++;
                entry.overflowReserved++;
            }
        }

        const buildings = {};
        for (const building of this.buildings.values()) {
            const type = this._buildingType(building, null);
            if (!type) continue;
            const candidates = this._candidateTiles({ building, buildingType: type, candidates: null });
            const capacity = this._buildingCapacity(building, type, candidates.length);
            const count = counts.get(type) || { reserved: 0, queued: 0, overflowReserved: 0 };
            buildings[type] = {
                capacity,
                visitTiles: candidates.length,
                occupied: this._buildingOccupancy(building, type, null),
                reserved: count.reserved,
                queued: count.queued,
                overflowReserved: count.overflowReserved,
            };
        }
        return buildings;
    }

    snapshot(now = Date.now()) {
        const time = Number(now) || Date.now();
        const reservations = [...this.reservations.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((reservation) => ({
                id: reservation.id,
                agentId: reservation.agentId,
                buildingType: reservation.buildingType,
                tileX: reservation.tileX,
                tileY: reservation.tileY,
                slotId: reservation.slotId,
                intentId: reservation.intentId,
                ttlMs: Math.max(0, reservation.expiresAt - time),
                score: reservation.score,
                walkable: reservation.walkable,
                scenic: reservation.scenic,
                overflow: reservation.overflow,
                queueGroup: reservation.queueGroup,
                queueIndex: reservation.queueIndex,
                queueDepth: reservation.queueDepth,
                queueOverflow: reservation.queueOverflow,
                buildingCapacity: reservation.buildingCapacity,
                tileCapacity: reservation.tileCapacity,
                buildingOccupancy: reservation.buildingOccupancy,
                tileOccupancy: reservation.tileOccupancy,
                projectedBuildingUse: reservation.projectedBuildingUse,
                projectedTileUse: reservation.projectedTileUse,
                overBuildingCapacity: reservation.overBuildingCapacity,
                overTileCapacity: reservation.overTileCapacity,
                clusterPressure: reservation.clusterPressure,
                relatedCluster: reservation.relatedCluster,
                relatedDistance: reservation.relatedDistance,
                facingPoint: reservation.facingPoint,
            }));

        const buildings = this.getBuildingLoads();

        return {
            reservationTtlMs: this.reservationTtlMs,
            reservationCount: reservations.length,
            reservations,
            buildings,
            crowd: this._crowdSnapshot(),
            metrics: { ...this.metrics },
            metricsScope: 'since allocator start',
        };
    }

    debug(now = Date.now()) {
        return this.snapshot(now);
    }

    getDiagnostics() {
        return {
            buildings: this.buildings.size,
            retainedAgentSprites: this.agentSprites.length,
            reservations: this.reservations.size,
            reservationAgents: this.agentReservationIds.size,
            agentMeta: this.agentMeta.size,
            relatedCache: this._relatedCache.size,
            occupancyEntries: this._occupancyEntries.length,
            occupancyBuckets: this._occupancyBuckets.size,
            disposed: this._disposed,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.buildings.clear();
        this.agentSprites = [];
        this.pathfinder = null;
        this.reservations.clear();
        this.agentReservationIds.clear();
        this.agentMeta.clear();
        this._relatedCache.clear();
        this._occupancyEntries = [];
        this._occupancyBuckets.clear();
        this._crowdClusters = [];
    }

    _scoreSlot({
        slot,
        agentId,
        buildingType,
        sourceTile,
        buildingCapacity,
        buildingOccupancy,
        existingReservation,
        intent,
        now,
    }) {
        const tileX = slot.tileX;
        const tileY = slot.tileY;
        const slotId = slot.slotId;
        const walkable = this._isWalkable(tileX, tileY);
        const reservations = this._reservationsForSlot(slotId, buildingType, now);
        const reservedByOther = reservations.some((reservation) => reservation.agentId !== agentId);
        const sameAgentSlot = existingReservation
            && existingReservation.buildingType === buildingType
            && existingReservation.slotId === slotId;
        const tileOccupancy = this._tileOccupancy(tileX, tileY, agentId);
        const clusterPressure = this._clusterPressureAt(tileX, tileY, agentId);
        const distance = sourceTile ? this._distance(sourceTile, slot) : 0;
        const capacityLimit = Math.max(1, Number(slot.capacity) || buildingCapacity);
        const projectedTileUse = tileOccupancy + reservations.filter((reservation) => reservation.agentId !== agentId).length;
        const projectedBuildingUse = buildingOccupancy + this._reservationCountForBuilding(buildingType, agentId);
        const overTileCapacity = Math.max(0, projectedTileUse - capacityLimit + 1);
        const overBuildingCapacity = Math.max(0, projectedBuildingUse - buildingCapacity + 1);
        const intentBonus = this._intentSlotBonus(intent, slot);
        const queueOverflow = !!slot.overflow || overTileCapacity > 0 || overBuildingCapacity > 0;
        const queueGroup = this._slotQueueGroup(slot, buildingType);
        const queueDepth = queueOverflow
            ? this._queueDepth(queueGroup, agentId, now, { overflowOnly: true })
            : 0;
        const queueIndex = queueOverflow
            ? (sameAgentSlot && Number.isInteger(existingReservation?.queueIndex)
                ? existingReservation.queueIndex
                : queueDepth)
            : 0;

        const relatedDistance = this._nearestRelatedReservationDistance(agentId, buildingType, slot);
        const clustered = relatedDistance <= RELATED_CLUSTER_RADIUS;

        let score = 0;
        if (!walkable) score += WALKABILITY_PENALTY;
        if (reservedByOther) score += RESERVED_PENALTY;
        score += tileOccupancy * TILE_CROWD_PENALTY;
        score += clusterPressure * LOCAL_CLUSTER_PENALTY;
        score += Math.max(0, buildingOccupancy - 1) * BUILDING_CROWD_PENALTY;
        score += (overTileCapacity + overBuildingCapacity) * OVER_CAPACITY_PENALTY;
        score += distance * DISTANCE_WEIGHT;
        if (sameAgentSlot) score -= SAME_AGENT_SLOT_BONUS;
        if (clustered) score -= RELATED_CLUSTER_BONUS;
        const targetSlotIndex = Number(intent?.targetSlotIndex ?? intent?.payload?.targetSlotIndex);
        if (Number.isInteger(targetSlotIndex) && targetSlotIndex === slot.slotIndex) {
            score -= TARGET_SLOT_INDEX_BONUS;
        }
        score -= intentBonus;
        if (slot.overflow) score += 35;
        if (slot.scenic) score += intent?.source === 'ambient' ? -14 : 10;

        return {
            ...slot,
            buildingType,
            score,
            walkable,
            clustered,
            relatedDistance,
            queueGroup,
            queueDepth,
            queueIndex,
            queueOverflow,
            buildingCapacity,
            tileCapacity: capacityLimit,
            buildingOccupancy,
            tileOccupancy,
            projectedBuildingUse,
            projectedTileUse,
            overBuildingCapacity,
            overTileCapacity,
            clusterPressure,
        };
    }

    _candidateTiles({ building, buildingType, candidates, intent = null }) {
        const source = Array.isArray(candidates) && candidates.length
            ? candidates
            : this._buildingVisitTiles(building, intent);
        const seen = new Set();
        const out = [];
        for (let index = 0; index < source.length; index++) {
            const tile = this._normalizeTile(source[index]);
            if (!tile) continue;
            const key = `${Math.round(tile.tileX * 1000) / 1000},${Math.round(tile.tileY * 1000) / 1000}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                ...tile,
                slotId: tile.slotId || `${buildingType || 'scenic'}:${key}`,
                slotIndex: out.length,
            });
        }
        return out;
    }

    _buildingVisitTiles(building, intent = null) {
        if (!building) return [];
        let base = [];
        if (Array.isArray(building.visitTiles) && building.visitTiles.length) {
            base = building.visitTiles;
        } else if (building.entrance) {
            base = [building.entrance];
        } else if (typeof building.primaryVisitTile === 'function') {
            const tile = building.primaryVisitTile();
            base = tile ? [tile] : [];
        } else {
            const x = Number.isFinite(building.x) ? building.x : building.position?.tileX;
            const y = Number.isFinite(building.y) ? building.y : building.position?.tileY;
            if (Number.isFinite(x) && Number.isFinite(y)) {
                base = [{
                    tileX: x + Math.floor((building.width || 1) / 2),
                    tileY: y + (building.height || 1),
                }];
            }
        }
        const buildingType = this._normalizeBuildingType(building.type);
        const overflow = buildingType
            ? (VISIT_OVERFLOW_TILES[buildingType] || []).map((tile, index) => ({
                ...tile,
                slotId: tile.slotId || `${buildingType}:overflow:${index}`,
                intentId: intent?.id || null,
            }))
            : [];
        return overflow.length ? [...base, ...overflow] : base;
    }

    _normalizeTile(tile) {
        if (!tile) return null;
        const tileX = Number(tile.tileX ?? tile.x);
        const tileY = Number(tile.tileY ?? tile.y);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        const facingPoint = tile.facingPoint
            && Number.isFinite(Number(tile.facingPoint.x))
            && Number.isFinite(Number(tile.facingPoint.y))
            ? { x: Number(tile.facingPoint.x), y: Number(tile.facingPoint.y) }
            : null;
        return {
            tileX,
            tileY,
            slotId: tile.slotId ? String(tile.slotId) : null,
            capacity: Number.isFinite(Number(tile.capacity)) ? Math.max(1, Number(tile.capacity)) : null,
            queueGroup: tile.queueGroup ? String(tile.queueGroup) : null,
            role: tile.role ? String(tile.role) : null,
            scenic: !!tile.scenic,
            overflow: !!tile.overflow,
            reason: tile.reason || null,
            intentId: tile.intentId || null,
            facingPoint,
        };
    }

    _resolveBuilding(building, intent) {
        if (building) return building;
        const type = this._normalizeBuildingType(intent?.building || intent?.buildingType || intent?.targetBuildingType);
        return type ? this.buildings.get(type) || null : null;
    }

    _buildingType(building, intent) {
        return this._normalizeBuildingType(
            building?.type || intent?.building || intent?.buildingType || intent?.targetBuildingType,
        );
    }

    _normalizeBuildingType(type) {
        return normalizeBuildingType(type);
    }

    _buildingCapacity(building, buildingType, slotCount, intent = null) {
        const explicitCapacity = building?.visitCapacity ?? this._capacityForIntent(building?.capacity, intent);
        const explicit = Number(explicitCapacity);
        if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
        if (BUILDING_CAPACITY_OVERRIDES[buildingType]) return BUILDING_CAPACITY_OVERRIDES[buildingType];
        return Math.max(1, Math.min(Math.max(1, slotCount), 4));
    }

    _capacityForIntent(capacity, intent = null) {
        if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) return capacity;
        const source = String(intent?.source || '').toLowerCase();
        if (source === 'ambient' && capacity.ambient != null) return capacity.ambient;
        if ((source === 'alert' || String(intent?.building || '') === 'watchtower') && capacity.alert != null) return capacity.alert;
        if (capacity.overflow != null && capacity.work != null) {
            return Math.max(Number(capacity.work) || 0, Number(capacity.overflow) || 0) || capacity.work;
        }
        if (capacity.work != null) return capacity.work;
        return capacity.ambient ?? capacity.overflow ?? null;
    }

    _buildingOccupancy(building, buildingType, ignoredAgentId) {
        let count = 0;
        const visitTiles = this._candidateTiles({ building, buildingType, candidates: null });
        for (const tile of this._occupancyEntries || []) {
            if (ignoredAgentId && tile.agentId === ignoredAgentId) continue;
            if (building && typeof building.containsVisitPoint === 'function' && building.containsVisitPoint(tile.tileX, tile.tileY)) {
                count++;
                continue;
            }
            if (building && typeof building.containsPoint === 'function' && building.containsPoint(tile.tileX, tile.tileY)) {
                count++;
                continue;
            }
            if (visitTiles.some((visitTile) => this._distance(tile, visitTile) <= BUILDING_OCCUPANCY_RADIUS)) count++;
        }
        return count;
    }

    _tileOccupancy(tileX, tileY, ignoredAgentId) {
        let count = 0;
        for (const tile of this._nearbyOccupancyEntries(tileX, tileY, TILE_OCCUPANCY_RADIUS)) {
            if (ignoredAgentId && tile.agentId === ignoredAgentId) continue;
            if (this._distance(tile, { tileX, tileY }) <= TILE_OCCUPANCY_RADIUS) count++;
        }
        return count;
    }

    _spriteTile(sprite) {
        if (!sprite) return null;
        if (sprite.tile && Number.isFinite(Number(sprite.tile.tileX)) && Number.isFinite(Number(sprite.tile.tileY))) {
            return { tileX: Number(sprite.tile.tileX), tileY: Number(sprite.tile.tileY) };
        }
        if (Number.isFinite(Number(sprite.tileX)) && Number.isFinite(Number(sprite.tileY))) {
            return { tileX: Number(sprite.tileX), tileY: Number(sprite.tileY) };
        }
        if (
            typeof sprite._screenToTile === 'function' &&
            Number.isFinite(Number(sprite.x)) &&
            Number.isFinite(Number(sprite.y))
        ) {
            const tile = sprite._screenToTile(Number(sprite.x), Number(sprite.y));
            if (tile && Number.isFinite(Number(tile.tileX)) && Number.isFinite(Number(tile.tileY))) {
                return { tileX: Number(tile.tileX), tileY: Number(tile.tileY) };
            }
        }
        if (sprite.agent?.position) return this._agentTile(sprite.agent);
        return null;
    }

    _agentTile(agent) {
        const position = agent?.position;
        if (!position) return null;
        const tileX = Number(position.tileX ?? position.x);
        const tileY = Number(position.tileY ?? position.y);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        return { tileX, tileY };
    }

    _isWalkable(tileX, tileY) {
        if (!this.pathfinder || typeof this.pathfinder.isWalkable !== 'function') return true;
        return !!this.pathfinder.isWalkable(Math.round(tileX), Math.round(tileY));
    }

    _reservationForAgent(agentId) {
        const reservationId = this.agentReservationIds.get(agentId);
        return reservationId ? this.reservations.get(reservationId) || null : null;
    }

    _reservationsForSlot(slotId, buildingType, now) {
        const out = [];
        for (const reservation of this.reservations.values()) {
            if (reservation.expiresAt <= now) continue;
            if (reservation.buildingType === buildingType && reservation.slotId === slotId) out.push(reservation);
        }
        return out;
    }

    _reservationCountForBuilding(buildingType, ignoredAgentId) {
        let count = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.buildingType !== buildingType) continue;
            if (ignoredAgentId && reservation.agentId === ignoredAgentId) continue;
            count++;
        }
        return count;
    }

    _slotQueueGroup(slot, buildingType) {
        if (slot?.queueGroup) return String(slot.queueGroup);
        if (slot?.overflow) return `${buildingType || 'scenic'}:overflow`;
        if (slot?.scenic) return `${buildingType || 'scenic'}:scenic`;
        return `${buildingType || 'scenic'}:primary`;
    }

    _queueDepth(queueGroup, ignoredAgentId, now, { overflowOnly = false } = {}) {
        if (!queueGroup) return 0;
        let count = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.expiresAt <= now) continue;
            if (ignoredAgentId && reservation.agentId === ignoredAgentId) continue;
            if (overflowOnly && !reservation.queueOverflow) continue;
            if (reservation.queueGroup === queueGroup) count++;
        }
        return count;
    }

    _reservationTtl(intent) {
        const intentTtl = Number(intent?.reservationTtlMs ?? intent?.ttlMs);
        if (Number.isFinite(intentTtl) && intentTtl > 0) return Math.max(1000, intentTtl);
        const expiresAt = Number(intent?.expiresAt);
        if (Number.isFinite(expiresAt)) {
            const remaining = expiresAt - Date.now();
            if (remaining > 0) return Math.max(1000, Math.min(remaining, this.reservationTtlMs));
        }
        return this.reservationTtlMs;
    }

    _intentSlotBonus(intent, slot) {
        if (!intent) return 0;
        if (slot.intentId && intent.id && slot.intentId === intent.id) return 45;
        if (slot.reason && intent.reason && slot.reason === intent.reason) return 25;
        const preferred = intent.preferredSlotId || intent.slotId;
        if (preferred && preferred === slot.slotId) return 55;
        return 0;
    }

    _normalizeBuildings(buildings) {
        if (buildings instanceof Map) {
            const out = new Map();
            for (const [key, building] of buildings.entries()) {
                const type = this._normalizeBuildingType(building?.type || key);
                if (type && building) out.set(type, building);
            }
            return out;
        }
        if (Array.isArray(buildings)) {
            const out = new Map();
            for (const building of buildings) {
                const type = this._normalizeBuildingType(building?.type);
                if (type) out.set(type, building);
            }
            return out;
        }
        if (buildings && typeof buildings === 'object') {
            const out = new Map();
            for (const [key, building] of Object.entries(buildings)) {
                const type = this._normalizeBuildingType(building?.type || key);
                if (type && building) out.set(type, building);
            }
            return out;
        }
        return new Map();
    }

    _normalizeAgentSprites(agentSprites) {
        if (agentSprites instanceof Map) return [...agentSprites.values()].filter(Boolean);
        if (Array.isArray(agentSprites)) return agentSprites.filter(Boolean);
        if (agentSprites && typeof agentSprites === 'object') return Object.values(agentSprites).filter(Boolean);
        return [];
    }

    _releaseStaleAgentReservations() {
        const active = new Set();
        for (const sprite of this.agentSprites) {
            const id = this._agentId(sprite?.agent, sprite, null);
            if (id) active.add(id);
        }
        for (const agentId of this.agentReservationIds.keys()) {
            if (!active.has(agentId) && this.release(agentId)) this.metrics.staleReleases++;
        }
    }

    _agentId(agent, sprite, intent) {
        const id = agent?.id || agent?.agentId || sprite?.agent?.id || sprite?.id || intent?.agentId;
        return id ? String(id) : null;
    }

    _nextReservationId(agentId) {
        this._sequence = (this._sequence + 1) % Number.MAX_SAFE_INTEGER;
        return `visit:${agentId}:${Date.now().toString(36)}:${this._sequence.toString(36)}`;
    }

    _distance(a, b) {
        return Math.hypot((a.tileX || 0) - (b.tileX || 0), (a.tileY || 0) - (b.tileY || 0));
    }
}

export default VisitTileAllocator;
