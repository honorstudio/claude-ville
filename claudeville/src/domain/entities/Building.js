import { Position } from '../value-objects/Position.js';

export class Building {
    constructor({
        type,
        x,
        y,
        width,
        height,
        label,
        icon,
        description,
        labelPriority,
        shortLabel,
        district,
        visualTier,
        capacity,
        visitCapacity,
        entrance,
        visitTiles,
        walkExclusion,
        scenery,
    }) {
        this.type = type;
        this.position = new Position(x, y);
        this.width = width || 4;
        this.height = height || 4;
        this.label = label;
        this.shortLabel = shortLabel || null;
        this.icon = icon;
        this.description = description;
        this.labelPriority = labelPriority || 'normal';
        this.district = district || 'village';
        this.visualTier = visualTier || 'major';
        this.capacity = capacity && typeof capacity === 'object' ? { ...capacity } : capacity;
        this.visitCapacity = visitCapacity ?? null;
        this.entrance = entrance ? { tileX: entrance.tileX, tileY: entrance.tileY } : null;
        this.visitTiles = Array.isArray(visitTiles)
            ? visitTiles.map((tile) => ({ ...tile, tileX: tile.tileX, tileY: tile.tileY }))
            : [];
        this.walkExclusion = this._normalizeWalkExclusions(walkExclusion);
        this.scenery = scenery ? {
            excludePadding: scenery.excludePadding ? { ...scenery.excludePadding } : null,
            sightline: scenery.sightline ? { ...scenery.sightline } : null,
            tallPropClearance: scenery.tallPropClearance ?? null,
        } : null;
        this.congestion = {
            load: 0,
            capacity: this._normalizeVisitCapacity(this.visitCapacity),
            ratio: 0,
            overBy: 0,
            level: 'normal',
            congested: false,
            updatedAt: 0,
        };
    }

    updateVisitLoad({ load = 0, capacity = null, now = Date.now() } = {}) {
        const resolvedCapacity = this._normalizeVisitCapacity(capacity)
            ?? this._normalizeVisitCapacity(this.visitCapacity);
        const resolvedLoad = Math.max(0, Math.floor(Number(load) || 0));
        let level = 'normal';
        if (resolvedCapacity) {
            if (resolvedLoad > resolvedCapacity) level = 'overwhelmed';
            else if (resolvedLoad === resolvedCapacity) level = 'busy';
        }
        const changed = level !== this.congestion.level;
        this.congestion = {
            load: resolvedLoad,
            capacity: resolvedCapacity,
            ratio: resolvedCapacity ? resolvedLoad / resolvedCapacity : 0,
            overBy: resolvedCapacity ? Math.max(0, resolvedLoad - resolvedCapacity) : 0,
            level,
            congested: level === 'overwhelmed',
            updatedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
        };
        return changed;
    }

    isCongested() {
        return !!this.congestion?.congested;
    }

    _normalizeVisitCapacity(capacity) {
        const value = Number(capacity);
        if (!Number.isFinite(value) || value <= 0) return null;
        return Math.max(1, Math.floor(value));
    }

    containsPoint(tileX, tileY) {
        return tileX >= this.position.tileX &&
               tileX < this.position.tileX + this.width &&
               tileY >= this.position.tileY &&
               tileY < this.position.tileY + this.height;
    }

    containsVisitPoint(tileX, tileY) {
        const x = Number(tileX);
        const y = Number(tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return this.visitTiles.some((tile) => (
            Math.abs(tile.tileX - x) <= 0.72 &&
            Math.abs(tile.tileY - y) <= 0.72
        ));
    }

    _normalizeWalkExclusions(walkExclusion) {
        if (!Array.isArray(walkExclusion)) return [];
        return walkExclusion.map((rect) => {
            const x0 = Number.isFinite(rect.x)
                ? rect.x
                : this.position.tileX + (rect.dx || 0);
            const y0 = Number.isFinite(rect.y)
                ? rect.y
                : this.position.tileY + (rect.dy || 0);
            const width = Math.max(1, Math.floor(rect.width || 1));
            const height = Math.max(1, Math.floor(rect.height || 1));
            return {
                x0: Math.floor(x0),
                y0: Math.floor(y0),
                x1: Math.floor(x0) + width - 1,
                y1: Math.floor(y0) + height - 1,
            };
        });
    }

    walkExclusionRects() {
        return this.walkExclusion.map((rect) => ({ ...rect }));
    }

    blocksWalkTile(tileX, tileY) {
        const x = Math.round(tileX);
        const y = Math.round(tileY);
        return this.containsPoint(x, y) || this.walkExclusion.some((rect) => (
            x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1
        ));
    }

    primaryVisitTile() {
        return this.visitTiles[0] || this.entrance || {
            tileX: this.position.tileX + Math.floor(this.width / 2),
            tileY: this.position.tileY + this.height,
        };
    }

    isAgentVisiting(agent) {
        if (!agent?.position) return false;
        return this.containsPoint(agent.position.tileX, agent.position.tileY) ||
            this.containsVisitPoint(agent.position.tileX, agent.position.tileY);
    }
}
