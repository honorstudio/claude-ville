import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from './ChronicleEvents.js';

export const CHRONICLER_HOME = Object.freeze({ tileX: 8, tileY: 17 });
export const CHRONICLER_QUEUE_LIMIT = 4;
export const CHRONICLER_PAUSE_MS = 3600;

const LANDMARKS = Object.freeze({
    archive: CHRONICLER_HOME,
    harbor: Object.freeze({ tileX: 28, tileY: 19 }),
    taskboard: Object.freeze({ tileX: 25, tileY: 37 }),
    watchtower: Object.freeze({ tileX: 28, tileY: 14 }),
});
const SPEED_TILES_PER_FRAME = 0.018;
const SPRITE_ID = 'character.chronicler';

function finiteTarget(event, fallback) {
    const tileX = event?.tileX == null || event?.tileX === '' ? NaN : Number(event.tileX);
    const tileY = event?.tileY == null || event?.tileY === '' ? NaN : Number(event.tileY);
    if (Number.isFinite(tileX) && Number.isFinite(tileY)) return { tileX, tileY };
    return { ...fallback };
}

export function routeChroniclerEvent(type, event = {}) {
    if (type === 'chronicle:milestone' || type === 'chronicle:milestone-banner') {
        const kind = event.kind === 'release' ? 'release' : 'milestone';
        const fallback = kind === 'release' ? LANDMARKS.harbor : LANDMARKS.archive;
        return { key: `outcome:${kind}`, kind, target: finiteTarget(event, fallback) };
    }
    if (type === VERIFIED_OUTCOME_EVENT) {
        if (event.kind === 'push' || event.kind === 'release') {
            return { key: `outcome:${event.kind}`, kind: event.kind, target: { ...LANDMARKS.harbor } };
        }
        if (event.kind === 'commit' || event.kind === 'milestone') {
            return { key: `outcome:${event.kind}`, kind: event.kind, target: { ...LANDMARKS.archive } };
        }
        return null;
    }
    if (type !== 'chronicle:recorded') return null;
    if (event.kind === 'push') {
        return { key: 'outcome:push', kind: 'push', target: { ...LANDMARKS.harbor } };
    }
    if (event.kind === 'errored' || event.kind === 'rate_limited') {
        return { key: 'incident:error', kind: 'error', target: { ...LANDMARKS.watchtower } };
    }
    if (event.kind === 'resolved') {
        const waited = Number(event.waitedMs) > 0;
        return {
            key: waited ? 'resolution:wait' : 'resolution:recovery',
            kind: waited ? 'wait-resolution' : 'recovery',
            target: { ...(waited ? LANDMARKS.taskboard : LANDMARKS.watchtower) },
        };
    }
    return null;
}

export function coalesceChroniclerRoute(queue, route, {
    activeKey = null,
    limit = CHRONICLER_QUEUE_LIMIT,
} = {}) {
    const next = Array.isArray(queue) ? [...queue] : [];
    if (!route || route.key === activeKey) return next.slice(0, limit);
    const existingIndex = next.findIndex(item => item.key === route.key);
    if (existingIndex >= 0) {
        next.splice(existingIndex, 1, route);
        return next.slice(0, limit);
    }
    if (next.length >= limit) next.splice(limit - 1, next.length - limit + 1, route);
    else next.push(route);
    return next;
}

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

export class Chronicler {
    constructor({ assets = null, sprites = null, motionScale = 1, eventTarget = eventBus } = {}) {
        this.assets = assets;
        this.sprites = sprites;
        this.motionScale = motionScale;
        this.tileX = CHRONICLER_HOME.tileX;
        this.tileY = CHRONICLER_HOME.tileY;
        this.pauseUntil = 0;
        this.frame = 0;
        this.phase = 'home';
        this._activeErrand = null;
        this._errandQueue = [];
        this._unsubscribers = [
            eventTarget.on('chronicle:milestone', (record) => this.enqueueEvent('chronicle:milestone', record)),
            eventTarget.on('chronicle:milestone-banner', (record) => this.enqueueEvent('chronicle:milestone-banner', record)),
            eventTarget.on('chronicle:recorded', (record) => this.enqueueEvent('chronicle:recorded', record)),
            eventTarget.on(VERIFIED_OUTCOME_EVENT, (outcome) => this.enqueueEvent(VERIFIED_OUTCOME_EVENT, outcome)),
        ];
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
        if (this.motionScale === 0 && this.phase !== 'home' && this.phase !== 'pause') {
            this.tileX = CHRONICLER_HOME.tileX;
            this.tileY = CHRONICLER_HOME.tileY;
            this.phase = 'home';
            this._activeErrand = null;
            this.pauseUntil = 0;
        }
    }

    update(dt = 16, now = Date.now()) {
        if (this.motionScale === 0) return;
        if (this.phase === 'home') {
            if (!this._errandQueue.length) return;
            this._activeErrand = this._errandQueue.shift();
            this.phase = 'outbound';
        }
        if (this.phase === 'pause') {
            if (now < this.pauseUntil) return;
            this.phase = 'returning';
        }
        const target = this.phase === 'returning'
            ? CHRONICLER_HOME
            : this._activeErrand?.target;
        if (!target) {
            this.phase = 'home';
            this._activeErrand = null;
            return;
        }
        if (!this._advance(target, dt)) return;
        if (this.phase === 'outbound') {
            this.phase = 'pause';
            this.pauseUntil = now + CHRONICLER_PAUSE_MS;
        } else {
            this.phase = 'home';
            this._activeErrand = null;
            this.pauseUntil = 0;
        }
    }

    _advance(target, dt) {
        const dx = target.tileX - this.tileX;
        const dy = target.tileY - this.tileY;
        const distance = Math.hypot(dx, dy);
        if (distance < 0.04) {
            this.tileX = target.tileX;
            this.tileY = target.tileY;
            return true;
        }
        const step = SPEED_TILES_PER_FRAME * (dt / 16);
        this.tileX += dx / distance * Math.min(step, distance);
        this.tileY += dy / distance * Math.min(step, distance);
        this.frame += dt / 120;
        return false;
    }

    enqueueEvent(type, event) {
        const route = routeChroniclerEvent(type, event);
        this._errandQueue = coalesceChroniclerRoute(this._errandQueue, route, {
            activeKey: this._activeErrand?.key,
        });
        return route;
    }

    get routeState() {
        return {
            phase: this.phase,
            queueLength: this._errandQueue.length,
            active: this._activeErrand ? { ...this._activeErrand } : null,
            tileX: this.tileX,
            tileY: this.tileY,
        };
    }

    destroy() {
        for (const unsubscribe of this._unsubscribers) unsubscribe?.();
        this._unsubscribers = [];
        this._errandQueue.length = 0;
        this._activeErrand = null;
    }

    enumerateDrawables() {
        const world = toWorld(this.tileX, this.tileY);
        return [{
            kind: 'chronicler',
            sortY: world.y,
            payload: { ...world, tileX: this.tileX, tileY: this.tileY },
        }];
    }

    draw(ctx, drawable, zoom = 1) {
        const payload = drawable?.payload || drawable || {};
        const x = Math.round(payload.x || 0);
        const y = Math.round(payload.y || 0);
        if (this.assets?.has?.(SPRITE_ID)) {
            const img = this.assets.get(SPRITE_ID);
            const dims = this.assets.getDims(SPRITE_ID) || { w: 92, h: 92 };
            ctx.drawImage(img, Math.round(x - dims.w / 2), Math.round(y - dims.h + 10));
            return;
        }
        this._drawProcedural(ctx, x, y, zoom);
    }

    _drawProcedural(ctx, x, y, zoom) {
        const walking = this.phase === 'outbound' || this.phase === 'returning';
        const bob = this.motionScale && walking ? Math.sin(this.frame) * 1.2 : 0;
        ctx.save();
        ctx.translate(x, y + bob);
        ctx.fillStyle = 'rgba(20, 16, 12, 0.28)';
        ctx.beginPath();
        ctx.ellipse(0, 6, 10, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#5b4a68';
        ctx.strokeStyle = '#2f2638';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(0, -28);
        ctx.lineTo(10, -7);
        ctx.lineTo(5, 5);
        ctx.lineTo(-6, 5);
        ctx.lineTo(-10, -7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#d7b979';
        ctx.fillRect(3, -9, 9, 6);
        ctx.fillStyle = '#f1dfae';
        ctx.fillRect(4, -8, 7, 4);
        ctx.strokeStyle = '#33283a';
        ctx.beginPath();
        ctx.moveTo(-8, -5);
        ctx.lineTo(-12, -24);
        ctx.stroke();
        ctx.fillStyle = '#d7b979';
        ctx.fillRect(-13, -25, 3, 7);
        ctx.fillStyle = '#f2d9a0';
        ctx.beginPath();
        ctx.arc(0, -20, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
