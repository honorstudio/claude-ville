import { formatRelative } from '../shared/Formatters.js';
import { ornamentPlan } from './MarkGovernor.js';
import { normalizeLightSource } from './LightSourceRegistry.js';
import { pulseValueMs } from './PulsePolicy.js';
import { tileToWorld } from './Projection.js';

export const MAX_BRIDGE_LANTERNS = 6;

const DAY_MS = 24 * 60 * 60_000;
const LANTERN_COLOR = '#ffd56a';
const LANTERN_LIGHT_PRIORITY = 100;
const LANTERN_GLASS_WORLD_SIZE = 7;
const LANTERN_HALO_WORLD_RADIUS = 7;

function normalizedZoom(zoom) {
    const value = Number(zoom);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

export function lanternScreenSize(zoom = 1) {
    return Math.max(12, LANTERN_GLASS_WORLD_SIZE * normalizedZoom(zoom));
}

function lanternHaloScreenRadius(zoom = 1) {
    return Math.max(10, LANTERN_HALO_WORLD_RADIUS * normalizedZoom(zoom));
}

const BRIDGE_LANTERN_SCENE_ITEMS = [];
export const BRIDGE_LANTERN_SCENE_CATEGORY = Object.freeze({
    id: 'bridge-lantern',
    sortBand: 45,
    enumerate({ renderer, renderNow } = {}) {
        const items = BRIDGE_LANTERN_SCENE_ITEMS;
        items.length = 0;
        const drawables = renderer?.bridgeLanterns?.enumerateDrawables?.(renderNow, renderer.camera) ?? [];
        for (let index = 0; index < drawables.length; index++) items.push(drawables[index]);
        return items;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        drawable?.draw?.(ctx, zoom, context);
    },
    unsupported: 'overlay-safe',
    overlayBand: 45,
});

function brightnessTier(ageMs) {
    if (ageMs < DAY_MS) return 0.5;
    if (ageMs < 3 * DAY_MS) return 0.68;
    if (ageMs < 7 * DAY_MS) return 0.85;
    return 1;
}

function ewPlankDeck(bridgeTiles) {
    const entries = bridgeTiles instanceof Map
        ? [...bridgeTiles.entries()].map(([key, value]) => ({ key, ...value }))
        : Array.isArray(bridgeTiles) ? bridgeTiles : [];
    return entries
        .filter(tile => tile?.kind === 'plank' && tile.orientation === 'EW')
        .map((tile) => {
            const [keyX, keyY] = String(tile.key || '').split(',').map(Number);
            return {
                ...tile,
                tileX: Number.isFinite(Number(tile.tileX)) ? Number(tile.tileX) : keyX,
                tileY: Number.isFinite(Number(tile.tileY)) ? Number(tile.tileY) : keyY,
            };
        })
        .filter(tile => Number.isFinite(tile.tileX) && Number.isFinite(tile.tileY))
        .sort((a, b) => a.tileX - b.tileX || a.tileY - b.tileY);
}

export function deriveLanternPlan(pendingRepoSummaries = [], bridgeTiles = [], now = Date.now()) {
    const deck = ewPlankDeck(bridgeTiles);
    if (deck.length === 0) return [];

    const rows = [...(Array.isArray(pendingRepoSummaries) ? pendingRepoSummaries : [])]
        .filter(row => (Number(row.pendingCommits ?? row.count) || 0) > 0)
        .filter(row => (Number(row.oldestCommitTime) || 0) > 0)
        .sort((a, b) => (Number(a.oldestCommitTime) - Number(b.oldestCommitTime))
            || String(a.repoName || a.project || '').localeCompare(String(b.repoName || b.project || ''))
            || String(a.branch || '').localeCompare(String(b.branch || '')));
    const selected = rows.slice(0, MAX_BRIDGE_LANTERNS);
    if (selected.length === 0) return [];

    const west = deck[0];
    const east = deck[deck.length - 1];
    const overflowCount = Math.max(0, rows.length - selected.length);
    return selected.map((row, index) => {
        const fraction = selected.length === 1 ? 0.5 : index / (selected.length - 1);
        const oldestCommitTime = Number(row.oldestCommitTime) || 0;
        const ageMs = Math.max(0, Number(now) - oldestCommitTime);
        return {
            tileX: west.tileX + (east.tileX - west.tileX) * fraction,
            tileY: west.tileY + (east.tileY - west.tileY) * fraction,
            branch: row.branch || '',
            repoName: row.repoName || row.shortName || row.project || 'unknown',
            accent: row.profile?.accent || '#fff1ad',
            ageMs,
            tier: brightnessTier(ageMs),
            oldestCommitTime,
            pendingCommits: Number(row.pendingCommits ?? row.count) || 0,
            overflowCount,
        };
    });
}

function drawLantern(ctx, lantern, now, motionScale, zoom) {
    const world = lantern.world;
    const policy = ornamentPlan({ motionScale });
    const animated = policy.lanterns === 'on' && motionScale > 0;
    const pulse = animated ? pulseValueMs('harbor', now, motionScale, lantern.phase) : 1;
    const alpha = Math.max(0.2, Math.min(1, lantern.tier * pulse));
    const scale = normalizedZoom(zoom);
    const glassSize = Math.round(lanternScreenSize(scale));
    const glassHalf = Math.floor(glassSize / 2);
    const haloRadius = lanternHaloScreenRadius(scale);

    ctx.save();
    ctx.translate(Math.round(world.x), Math.round(world.y) - 12);
    ctx.scale(1 / scale, 1 / scale);

    const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, haloRadius);
    halo.addColorStop(0, lantern.accent);
    halo.addColorStop(1, 'rgba(255, 213, 106, 0)');
    ctx.globalAlpha = alpha * 0.34;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#563820';
    ctx.fillRect(-glassHalf, -glassHalf - 5, glassSize, 2);
    ctx.fillRect(-glassHalf, -glassHalf - 5, 2, 6);
    ctx.fillRect(glassHalf - 1, -glassHalf - 5, 2, 6);
    ctx.fillRect(-glassHalf, -glassHalf, glassSize, glassSize);
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = lantern.accent;
    ctx.fillRect(-glassHalf + 2, -glassHalf + 2, glassSize - 4, glassSize - 4);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = LANTERN_COLOR;
    ctx.fillRect(-glassHalf + 3, -glassHalf + 3, Math.max(2, glassSize - 7), Math.max(2, glassSize - 7));
    ctx.restore();
}

export class BridgeLanterns {
    constructor({ renderer } = {}) {
        this.renderer = renderer || null;
        this.plan = [];
        this._signature = null;
        this._drawables = [];
        this._drawNow = 0;
        this.hovered = null;
    }

    update(pendingRepoSummaries = [], now = Date.now()) {
        const signature = this.renderer?._harborPendingReposSignature?.(pendingRepoSummaries)
            ?? JSON.stringify(pendingRepoSummaries);
        if (signature === this._signature) return false;
        this._signature = signature;
        this.plan = deriveLanternPlan(pendingRepoSummaries, this.renderer?.bridgeTiles, now)
            .map((lantern, index) => ({
                ...lantern,
                world: tileToWorld(lantern.tileX, lantern.tileY),
                phase: index * 0.83,
            }));
        this._drawables = this.plan.map(lantern => ({
            id: `bridge-lantern:${lantern.repoName}:${lantern.branch}`,
            kind: 'bridge-lantern',
            x: lantern.world.x,
            y: lantern.world.y - 10,
            sortY: lantern.world.y + 1,
            stableKey: `bridge-lantern:${lantern.repoName}:${lantern.branch}`,
            payload: lantern,
            draw: (ctx, zoom) => drawLantern(
                ctx,
                lantern,
                this._drawNow,
                Number(this.renderer?.motionScale) || 0,
                zoom,
            ),
        }));
        return true;
    }

    enumerateDrawables(now = Date.now(), camera = this.renderer?.camera) {
        if (this.plan.length === 0 || !camera?.worldToScreen) return [];
        this._drawNow = now;
        const width = camera.canvas?.clientWidth || camera.canvas?.width || 0;
        const height = camera.canvas?.clientHeight || camera.canvas?.height || 0;
        return this._drawables.filter((drawable) => {
            const lantern = drawable.payload;
            const screen = camera.worldToScreen(lantern.world.x, lantern.world.y - 12);
            return screen.x >= -16 && screen.x <= width + 16 && screen.y >= -24 && screen.y <= height + 16;
        });
    }

    hitTest(worldX, worldY) {
        const zoom = normalizedZoom(this.renderer?.camera?.zoom);
        const radius = lanternHaloScreenRadius(zoom) / zoom;
        const radiusSquared = radius * radius;
        for (const lantern of this.plan) {
            const dx = worldX - lantern.world.x;
            const dy = worldY - (lantern.world.y - 12);
            if (dx * dx + dy * dy <= radiusSquared) return lantern;
        }
        return null;
    }
    setHovered(lantern) {
        this.hovered = lantern || null;
    }


    tooltipFor(lantern, now = Date.now()) {
        if (!lantern) return '';
        const age = formatRelative(lantern.oldestCommitTime, now);
        const count = lantern.pendingCommits;
        const line = `${lantern.repoName} - ${lantern.branch || 'unknown branch'} - ${count} ${count === 1 ? 'commit' : 'commits'}${age ? ` - oldest ${age}` : ''}`;
        return lantern.overflowCount > 0
            ? `${line}\n+${lantern.overflowCount} more branches`
            : line;
    }

    getLightSources(lighting = null) {
        const beaconIntensity = Math.max(0, Math.min(1, Number(lighting?.beaconIntensity) || 0));
        if (beaconIntensity <= 0.05 || this.plan.length === 0) return [];
        return this.plan.map(lantern => ({
            ...normalizeLightSource({
                id: `bridge-lantern:${lantern.tileX},${lantern.tileY}`,
                kind: 'point',
                x: lantern.world.x,
                y: lantern.world.y - 10,
                color: LANTERN_COLOR,
                radius: 46,
                intensity: 0.7 * lantern.tier,
                priority: LANTERN_LIGHT_PRIORITY,
                overlay: 'atmosphere.light.lantern-glow',
            }),
            night: true,
        }));
    }
}
