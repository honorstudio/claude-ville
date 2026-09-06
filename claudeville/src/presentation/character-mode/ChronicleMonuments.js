import { MonumentPlanter, MonumentRules } from '../../application/MonumentRules.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { collectCommitEvents } from './ChronicleEvents.js';
import { tileToWorld } from './Projection.js';
import { repoProfile } from '../shared/RepoColor.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';

// 4.7 — the selected monument's stone ledger: the last three real records of
// its district, the exact count of the rest, and the period those records
// actually cover. Month-retained records are never called all-time history.
const LEDGER_ROWS = 3;
const LEDGER_MONTHS = Object.freeze([
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function ledgerDate(value) {
    const at = Number(value);
    if (!Number.isFinite(at) || at <= 0) return 'date unknown';
    const date = new Date(at);
    return `${date.getDate()} ${LEDGER_MONTHS[date.getMonth()] || '?'}`;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const KIND_COLORS = {
    release: '#80e8ff',
    feature: '#f2bc5e',
    fix: '#8fd48e',
    performance: '#d5a6ff',
    verified: '#f7f0a3',
};

// 6.1 — sprite ids for the PixelLab monument set. When the asset is missing
// (not yet generated or failed to load) the vector draws below stay as the
// fallback. `founding-layer` maps to the founding sprite.
const MONUMENT_SPRITE_IDS = Object.freeze({
    minor: 'monument.minor',
    medium: 'monument.medium',
    major: 'monument.major',
    founding: 'monument.founding',
});
// Gem-glow anchor on the sprite, as a fraction of its box (from bottom-center).
const MONUMENT_SPRITE_GEM = Object.freeze({
    minor: { fx: 0.5, fy: 0.5, r: 6 },
    medium: { fx: 0.5, fy: 0.45, r: 7 },
    major: { fx: 0.5, fy: 0.42, r: 8 },
    founding: { fx: 0.5, fy: 0.5, r: 7 },
});
// 6.5 — quiet mote presence over major monuments: one slow trickle shared by
// all majors (update cadence is ~1s; the modulo staggers them deterministically).
const MONUMENT_MOTE_INTERVAL_MS = 900;

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

// Mirrored from HarborTraffic.js constants (HARBOR_FINALE_TILE and
// HARBOR_SQUAD_ANCHORAGES[1] "Inner Quay Basin") — kept here so this module
// stays self-contained without exporting harbor internals.
const HARBOR_FIREWORKS_TILE = { tileX: 38.2, tileY: 6.6 };
const INNER_QUAY_BASIN_TILE = { tileX: 35.15, tileY: 22.55 };

const FIREWORKS_RING_COUNT = 3;
const FIREWORKS_RING_STAGGER_MS = 100;
const FIREWORKS_RING_DURATION_MS = 5000;
const FIREWORKS_LIFETIME_MS = 6000;
const FIREWORKS_MAX_ACTIVE = 8;
const FIREWORKS_MAX_RADIUS = 110;
const MAX_PLANTER_SEEN = 4096;
const MAX_COMMIT_SEEN = 4096;
const MAX_CHRISTENED_REPOS = 512;

const MILESTONE_DURATIONS_MS = {
    maiden: 6000,
    ribbon: 8000,
    flagship: 12000,
    aurora: 10000,
};

function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

function projectName(project) {
    const parts = String(project || 'unknown').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function commitIdentity(event) {
    return String(
        event?.sha
        || event?.sourceId
        || event?.commandHash
        || event?.id
        || `${event?.project || 'unknown'}:${event?.timestamp || event?.ts || ''}`,
    );
}

function commitTimestamp(event, fallback) {
    const raw = event?.timestamp ?? event?.ts ?? event?.time ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function reducedMotionPreferred() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
        return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
        return false;
    }
}

function kindIcon(kind) {
    switch (kind) {
        case 'release': return '*';
        case 'feature': return '+';
        case 'fix': return '~';
        case 'performance': return '!';
        case 'verified': return '#';
        case 'founding-layer': return '=';
        default: return '-';
    }
}

export class ChronicleMonuments {
    constructor({
        store = null,
        rules = new MonumentRules(),
        eventTarget = eventBus,
        chronicleStore = null,
        auroraGate = null,
        assets = null,
        particles = null,
    } = {}) {
        this.store = store;
        this.rules = rules;
        this.eventBus = eventTarget;
        this.records = new Map();
        this.planter = new MonumentPlanter({ store, rules, eventTarget });
        this._loaded = false;
        this._pendingHydrate = null;
        // 6.1 — optional AssetManager: when injected and the monument.* sprites
        // exist, monuments draw from PixelLab art with the vector path as the
        // asset-missing fallback. 6.5 — optional ParticleSystem for the quiet
        // major-monument mote trickle. Both are wired by the renderer.
        this.assets = assets;
        this.particles = particles;
        this._lastMonumentMoteAt = 0;
        // ChronicleStore is used for lifetime commit-count milestones. It may
        // be the same instance as `store`, but kept as a separate slot so tests
        // can inject a stub.
        this.chronicleStore = chronicleStore || store;
        // AuroraGate is optional. When passed, the 1000th-commit milestone calls
        // `forceTrigger('milestone-1000')` to bypass the daily cap. When absent
        // (current IsometricRenderer wiring), the aurora is omitted but the
        // banner still appears.
        this.auroraGate = auroraGate;
        this._seenCommitIds = new Set();
        this._activeFireworks = [];
        this._activeBanners = [];
        this._pendingMilestones = [];
        // #18 — christening: HarborTraffic fires `harbor:repo-christened` the
        // first time a repo earns a Home-Waters anchorage. Raise a maiden banner
        // over its buoy. Track christened repos so duplicate emits are no-ops.
        this._christenedRepos = new Set();
        this._onRepoChristened = (event) => this._christenRepo(event);
        this._unsubscribeRepoChristened = this.eventBus?.on?.('harbor:repo-christened', this._onRepoChristened) || null;
        // 4.7 — the one stone whose ledger is open, or null.
        this._selectedMonumentId = null;
        this._disposed = false;
        this._lifecycleGeneration = 0;
    }

    async hydrate(now = Date.now()) {
        if (this._disposed || !this.store || this._loaded) return;
        if (this._pendingHydrate) return this._pendingHydrate;
        const generation = this._lifecycleGeneration;
        this._pendingHydrate = this.store.queryRange('monuments', 'plantedAt', now - MONTH_MS, now + MONTH_MS)
            .then((records) => {
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                for (const record of records || []) this.records.set(record.id, record);
                this._loaded = true;
            })
            .catch(() => {
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                this._loaded = true;
            });
        return this._pendingHydrate;
    }

    async update(agents, context = {}, now = Date.now()) {
        if (this._disposed) return [];
        const generation = this._lifecycleGeneration;
        await this.hydrate(now);
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        const gitEvents = collectCommitEvents(agents);
        const pushEvents = this._collectPushEvents(agents);
        const sourceEvents = [...gitEvents, ...pushEvents].slice(-MAX_PLANTER_SEEN);
        const planted = await this.planter.processEvents(sourceEvents, {
            ...context,
            now,
            monuments: [...this.records.values()],
            isActive: () => !this._disposed && generation === this._lifecycleGeneration,
        });
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        if (this.planter?.seen?.size > MAX_PLANTER_SEEN) {
            this.planter.seen = new Set([...this.planter.seen].slice(-MAX_PLANTER_SEEN));
        }
        for (const record of planted) this.records.set(record.id, record);
        for (const record of planted) {
            if (record.kind === 'release') this._scheduleReleaseFireworks(record, now);
        }
        await this._processCommitMilestones(gitEvents, now, generation);
        if (this._disposed || generation !== this._lifecycleGeneration) return [];
        this._dropExpired(now);
        this._dropExpiredOverlays(now);
        this._emitMajorMonumentMotes(now);
        return planted;
    }

    // 6.5 — quiet mote presence over major monuments: a slow single mote per
    // major, staggered by record hash so several majors never pulse in
    // lockstep, tinted to the monument kind. Silent when no ParticleSystem is
    // wired; reduced motion no-ops inside ParticleSystem.spawn itself.
    _emitMajorMonumentMotes(now) {
        if (!this.particles) return;
        if (now - this._lastMonumentMoteAt < MONUMENT_MOTE_INTERVAL_MS) return;
        this._lastMonumentMoteAt = now;
        const tick = Math.floor(now / MONUMENT_MOTE_INTERVAL_MS);
        for (const record of this.records.values()) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) continue;
            if ((record.weight || 'medium') !== 'major') continue;
            const seed = hashText(record.id || record.project || 'monument');
            if ((tick + seed) % 3 !== 0) continue;
            const world = toWorld(record.tileX, record.tileY);
            this.particles.spawn('archiveMote', world.x, world.y - 26, {
                count: 1,
                colors: [KIND_COLORS[record.kind] || '#d8b96d'],
                size: [1, 2],
                life: [40, 80],
                speed: [0.06, 0.2],
                alpha: [0.3, 0.55],
                spread: [8, 12],
            });
        }
    }

    // 6.1 — sprite id for a monument record, or null when the record should
    // keep the vector draw (unknown weights fall back to medium).
    _monumentSpriteId(record) {
        if (record.kind === 'founding-layer') return MONUMENT_SPRITE_IDS.founding;
        const weight = record.weight || 'medium';
        return MONUMENT_SPRITE_IDS[weight] || MONUMENT_SPRITE_IDS.medium;
    }

    _monumentSpriteAvailable(spriteId) {
        return Boolean(spriteId && this.assets?.has?.(spriteId) && this.assets.get(spriteId));
    }

    getDiagnostics() {
        return {
            records: this.records.size,
            seenCommitIds: this._seenCommitIds.size,
            planterSeen: this.planter?.seen?.size || 0,
            christenedRepos: this._christenedRepos.size,
            activeFireworks: this._activeFireworks.length,
            activeBanners: this._activeBanners.length,
            disposed: this._disposed,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._lifecycleGeneration++;
        if (typeof this._unsubscribeRepoChristened === 'function') {
            this._unsubscribeRepoChristened();
        } else {
            this.eventBus?.off?.('harbor:repo-christened', this._onRepoChristened);
        }
        this._unsubscribeRepoChristened = null;
        this._onRepoChristened = null;
        this.records.clear();
        this._seenCommitIds.clear();
        this.planter?.seen?.clear?.();
        this._christenedRepos.clear();
        this._activeFireworks.length = 0;
        this._activeBanners.length = 0;
        this._pendingMilestones.length = 0;
        this.store = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.assets = null;
        this.particles = null;
    }

    enumerateDrawables(now = Date.now(), camera = null) {
        const bounds = camera?.getViewportTileBounds?.(2);
        const byDistrict = new Map();
        for (const record of this.records.values()) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) continue;
            const group = byDistrict.get(record.district) || [];
            group.push(record);
            byDistrict.set(record.district, group);
        }
        const visible = [];
        for (const [district, records] of byDistrict) {
            const capped = MonumentRules.applyDistrictCap(records);
            visible.push(...capped.visible);
            if (capped.foundingLayer) visible.push(this._foundingLayerRecord(district, records));
        }

        const drawables = visible
            .filter(record => now - Number(record.plantedAt || record.ts || 0) <= MONTH_MS)
            .filter(record => !bounds || (
                record.tileX >= bounds.startX && record.tileX <= bounds.endX &&
                record.tileY >= bounds.startY && record.tileY <= bounds.endY
            ))
            .map(record => {
                const world = toWorld(record.tileX, record.tileY);
                return {
                    kind: 'chronicle-monument',
                    sortY: world.y + 18,
                    payload: { ...record, worldX: world.x, worldY: world.y },
                };
            });

        // Append overlays (fireworks rings, milestone banners) — drawn at a sortY
        // above their anchor so they paint on top of nearby monuments.
        for (const firework of this._activeFireworks) {
            const world = toWorld(firework.tileX, firework.tileY);
            drawables.push({
                kind: 'chronicle-fireworks',
                sortY: world.y + 1e6,
                payload: { ...firework, worldX: world.x, worldY: world.y },
            });
        }
        for (const banner of this._activeBanners) {
            const world = toWorld(banner.tileX, banner.tileY);
            drawables.push({
                kind: 'chronicle-banner',
                sortY: world.y + 1e6,
                payload: { ...banner, worldX: world.x, worldY: world.y },
            });
        }
        return drawables;
    }

    draw(ctx, drawable, zoom = 1, now = Date.now()) {
        const record = drawable?.payload || drawable;
        if (!record) return;
        if (drawable?.kind === 'chronicle-fireworks' || record.kind === 'chronicle-fireworks') {
            this._drawFireworks(ctx, record, zoom, now);
            return;
        }
        if (drawable?.kind === 'chronicle-banner' || record.kind === 'chronicle-banner') {
            this._drawBanner(ctx, record, zoom, now);
            return;
        }
        this._drawMonument(ctx, record, zoom, now);
    }

    hitTest(worldX, worldY, now = Date.now()) {
        for (const drawable of this.enumerateDrawables(now)) {
            if (drawable.kind !== 'chronicle-monument') continue;
            const record = drawable.payload;
            // 6.1 — when the sprite path is live the hit box hugs the sprite
            // bounds (anchored like the draw) instead of the legacy fixed box.
            const spriteId = this._monumentSpriteId(record);
            if (this._monumentSpriteAvailable(spriteId)) {
                const dims = this.assets.getDims(spriteId);
                const [ax, ay] = this.assets.anchors?.has?.(spriteId)
                    ? this.assets.getAnchor(spriteId)
                    : [dims.w / 2, dims.h];
                if (worldX >= record.worldX - ax && worldX <= record.worldX + (dims.w - ax) &&
                    worldY >= record.worldY - ay && worldY <= record.worldY + (dims.h - ay)) {
                    return record;
                }
                continue;
            }
            if (worldX >= record.worldX - 12 && worldX <= record.worldX + 12 &&
                worldY >= record.worldY - 28 && worldY <= record.worldY + 12) {
                return record;
            }
        }
        return null;
    }

    tooltipFor(record, now = Date.now()) {
        if (!record) return '';
        const ageDays = Math.max(0, Math.floor((now - Number(record.plantedAt || record.ts || now)) / 86400000));
        const ageLabel = ageDays === 0 ? 'today' : `${ageDays}d ago`;
        const label = record.label || record.kind;
        const repo = projectName(record.project);
        const weight = record.weight ? ` [${record.weight}]` : '';
        // 4.8 — monument records may carry a chronicle lore line.
        const lore = String(record.lore || '').trim();
        const loreSuffix = lore ? `\n${lore}` : '';
        return `${kindIcon(record.kind)} ${record.kind}${weight}\nrepo: ${repo}\n${label}\nplanted ${ageLabel}${loreSuffix}`;
    }

    minimapMarkers() {
        return this.enumerateDrawables()
            .filter(drawable => drawable.kind === 'chronicle-monument')
            .map(drawable => drawable.payload)
            .map(record => ({
                tileX: record.tileX,
                tileY: record.tileY,
                kind: record.kind,
                color: KIND_COLORS[record.kind] || '#d8b96d',
            }));
    }

    _foundingLayerRecord(district, records) {
        const oldest = [...records].sort((a, b) => Number(a.plantedAt || a.ts || 0) - Number(b.plantedAt || b.ts || 0))[0];
        return {
            ...oldest,
            id: `founding:${district}`,
            kind: 'founding-layer',
            label: 'Founding layer',
            district,
            plantedAt: oldest?.plantedAt || oldest?.ts || Date.now(),
        };
    }

    _drawMonument(ctx, record, zoom, now) {
        const world = record.worldX == null ? toWorld(record.tileX, record.tileY) : record;
        const age = Math.max(0, now - Number(record.plantedAt || record.ts || now));
        const alpha = Math.max(0.55, 1 - age / MONTH_MS * 0.45);
        const color = KIND_COLORS[record.kind] || '#d8b96d';
        // 4.7 — only the selected stone opens its ledger; everything else keeps
        // its silence.
        const selected = this._selectedMonumentId && record.id === this._selectedMonumentId;

        // 6.1 — PixelLab sprite path; the vector draws below remain the
        // asset-missing fallback.
        if (this._drawMonumentSprite(ctx, record, world, alpha, color)) {
            if (selected) this._drawMonumentLedger(ctx, record, world, now);
            return;
        }

        ctx.save();
        ctx.translate(Math.round(world.worldX ?? world.x), Math.round(world.worldY ?? world.y));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(26, 22, 18, 0.35)';
        ctx.beginPath();
        ctx.ellipse(0, 11, 13, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        if (record.kind === 'founding-layer') {
            this._drawFoundingLayer(ctx, alpha, zoom);
            ctx.restore();
            return;
        }

        const weight = record.weight || 'medium';
        if (weight === 'minor') {
            this._drawMinorCairn(ctx, alpha, zoom);
        } else if (weight === 'major') {
            this._drawMajorObelisk(ctx, alpha, zoom, color);
        } else {
            this._drawMediumStone(ctx, alpha, zoom);
        }

        // Energy inset varies with weight: brighter / taller on major releases.
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = color;
        if (weight === 'major') {
            ctx.globalAlpha = alpha * 0.62;
            ctx.fillRect(-3, -16, 6, 18);
        } else if (weight === 'minor') {
            ctx.globalAlpha = alpha * 0.28;
            ctx.fillRect(-2, -6, 4, 7);
        } else {
            ctx.globalAlpha = alpha * 0.42;
            ctx.fillRect(-3, -11, 6, 13);
        }
        ctx.restore();
        if (selected) this._drawMonumentLedger(ctx, record, world, now);
    }

    // 4.7 — the low stone ledger. Rows are real retained records of this
    // stone's district, newest first, each stating its kind, its classified
    // label, its planted date and its repository crest. The rest is an exact
    // count, and the covered period is stated rather than implied.
    setSelectedMonument(id) {
        this._selectedMonumentId = typeof id === 'string' && id ? id : null;
    }

    getSelectedMonumentId() {
        return this._selectedMonumentId;
    }

    ledgerFor(record, now = Date.now()) {
        if (!record) return null;
        const district = record.district;
        const rows = [...this.records.values()]
            .filter((entry) => entry.district === district
                && now - Number(entry.plantedAt || entry.ts || 0) <= MONTH_MS)
            .sort((a, b) => Number(b.plantedAt || b.ts || 0) - Number(a.plantedAt || a.ts || 0));
        return {
            district,
            rows: rows.slice(0, LEDGER_ROWS),
            overflow: Math.max(0, rows.length - LEDGER_ROWS),
            total: rows.length,
        };
    }

    _drawMonumentLedger(ctx, record, world, now) {
        const ledger = this.ledgerFor(record, now);
        if (!ledger?.rows.length) return;
        const x = Math.round((world.worldX ?? world.x) + 14);
        const y = Math.round((world.worldY ?? world.y) - 2);
        const rowH = 8;
        const height = ledger.rows.length * rowH + (ledger.overflow > 0 ? rowH : 0) + 12;
        ctx.save();
        ctx.font = `6px ${WORLD_BODY_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        let width = 0;
        const lines = ledger.rows.map((entry) => ({
            text: `${entry.kind} · ${String(entry.label || '').slice(0, 22)} · ${ledgerDate(entry.plantedAt || entry.ts)}`,
            crest: repoProfile(entry.project).accent || '#d8b96d',
        }));
        const header = `${ledger.district} · last 30 days`;
        width = Math.ceil(ctx.measureText(header).width);
        for (const line of lines) width = Math.max(width, Math.ceil(ctx.measureText(line.text).width) + 6);
        width += 8;
        // A low tablet, not a floating card: one stone face with a lit top
        // course, sitting on the plinth beside the stone.
        ctx.fillStyle = 'rgba(28, 25, 20, 0.9)';
        ctx.fillRect(x, y - height, width, height);
        ctx.fillStyle = 'rgba(155, 138, 107, 0.9)';
        ctx.fillRect(x, y - height, width, 1);
        ctx.fillStyle = 'rgba(216, 185, 109, 0.9)';
        ctx.fillText(header, x + 4, y - height + 6);
        lines.forEach((line, index) => {
            const rowY = y - height + 14 + index * rowH;
            ctx.fillStyle = line.crest;
            ctx.fillRect(x + 4, rowY - 2, 3, 4);
            ctx.fillStyle = 'rgba(232, 228, 216, 0.94)';
            ctx.fillText(line.text, x + 10, rowY);
        });
        if (ledger.overflow > 0) {
            ctx.fillStyle = 'rgba(198, 190, 172, 0.88)';
            ctx.fillText(`+${ledger.overflow} recorded`, x + 10, y - height + 14 + lines.length * rowH);
        }
        ctx.restore();
    }

    // 6.1 — draw the monument from its PixelLab sprite. Returns false when the
    // sprite is unavailable so the caller falls back to the vector draws. The
    // KIND_COLORS gem glow stays a screen-composite overlay on top of the art,
    // and the contact shadow is shared with the vector path.
    _drawMonumentSprite(ctx, record, world, alpha, color) {
        const spriteId = this._monumentSpriteId(record);
        if (!this._monumentSpriteAvailable(spriteId)) return false;
        const img = this.assets.get(spriteId);
        const dims = this.assets.getDims(spriteId);
        if (!img || !dims) return false;
        // Honor a registered manifest anchor; default to bottom-center on the
        // ground point (the engine-wide anchor convention).
        const [ax, ay] = this.assets.anchors?.has?.(spriteId)
            ? this.assets.getAnchor(spriteId)
            : [dims.w / 2, dims.h];
        const wx = Math.round(world.worldX ?? world.x);
        const wy = Math.round(world.worldY ?? world.y);
        const weight = record.kind === 'founding-layer' ? 'founding' : (record.weight || 'medium');
        const gem = MONUMENT_SPRITE_GEM[weight] || MONUMENT_SPRITE_GEM.medium;

        ctx.save();
        ctx.translate(wx, wy);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(26, 22, 18, 0.35)';
        ctx.beginPath();
        ctx.ellipse(0, 11, 13, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(img, Math.round(-ax), Math.round(-ay));
        // Gem glow overlay (screen composite) at the calibrated sprite spot.
        const gx = Math.round(-ax + dims.w * gem.fx);
        const gy = Math.round(-ay + dims.h * gem.fy);
        ctx.globalCompositeOperation = 'screen';
        const gradient = ctx.createRadialGradient(gx, gy, 0, gx, gy, gem.r);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(gx, gy, gem.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return true;
    }

    _drawMediumStone(ctx, alpha, zoom) {
        ctx.fillStyle = '#9b8a6b';
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        const scale = 0.75;
        ctx.beginPath();
        ctx.moveTo(0, -24 * scale);
        ctx.lineTo(8 * scale, -8 * scale);
        ctx.lineTo(6 * scale, 8 * scale);
        ctx.lineTo(-7 * scale, 8 * scale);
        ctx.lineTo(-8 * scale, -8 * scale);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.stroke();
    }

    _drawMajorObelisk(ctx, alpha, zoom, color) {
        ctx.fillStyle = '#a89677';
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.beginPath();
        ctx.moveTo(0, -34);
        ctx.lineTo(9, -10);
        ctx.lineTo(7, 9);
        ctx.lineTo(-8, 9);
        ctx.lineTo(-9, -10);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.stroke();
        // Glowing inset gem centred on the obelisk.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = alpha * 0.85;
        const gradient = ctx.createRadialGradient(0, -16, 0, 0, -16, 7);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, -16, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawMinorCairn(ctx, alpha, zoom) {
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        ctx.globalAlpha = alpha;
        // Three stacked rocks, smallest on top.
        const rocks = [
            { x: -4, y: 6, w: 9, h: 5, fill: '#8a7a5e' },
            { x: 2, y: 4, w: 7, h: 4, fill: '#9b8a6b' },
            { x: -2, y: -2, w: 5, h: 4, fill: '#a89677' },
        ];
        for (const rock of rocks) {
            ctx.fillStyle = rock.fill;
            ctx.beginPath();
            ctx.ellipse(rock.x, rock.y, rock.w, rock.h, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    _drawFoundingLayer(ctx, alpha, zoom) {
        ctx.strokeStyle = '#3e3429';
        ctx.lineWidth = 1 / Math.max(1, zoom);
        for (let i = 0; i < 3; i++) {
            const x = -9 + i * 8;
            const h = 10 + i * 3;
            ctx.fillStyle = i === 1 ? '#a49677' : '#82745d';
            ctx.beginPath();
            ctx.moveTo(x, -h - 4);
            ctx.lineTo(x + 5, -h + 2);
            ctx.lineTo(x + 5, 7);
            ctx.lineTo(x - 4, 7);
            ctx.lineTo(x - 5, -h + 2);
            ctx.closePath();
            ctx.globalAlpha = alpha * (0.84 + i * 0.05);
            ctx.fill();
            ctx.stroke();
        }
    }

    _scheduleReleaseFireworks(record, now) {
        const color = KIND_COLORS[record.kind] || KIND_COLORS.release;
        const anchor = HARBOR_FIREWORKS_TILE;
        this.eventBus?.emit?.('harbor:release-burst', {
            project: record.project,
            label: record.label,
            ts: now,
            color,
        });
        this._pushFirework({
            startedAt: now,
            expiresAt: now + FIREWORKS_LIFETIME_MS,
            tileX: anchor.tileX,
            tileY: anchor.tileY,
            color,
        });
    }

    _pushFirework(firework) {
        this._activeFireworks.push(firework);
        if (this._activeFireworks.length > FIREWORKS_MAX_ACTIVE) {
            // Drop oldest to honour cap.
            this._activeFireworks.splice(0, this._activeFireworks.length - FIREWORKS_MAX_ACTIVE);
        }
    }

    async _processCommitMilestones(gitEvents, now, generation = this._lifecycleGeneration) {
        if (
            !this.chronicleStore
            || (
                typeof this.chronicleStore.recordCommit !== 'function'
                && typeof this.chronicleStore.recordCommitEvents !== 'function'
            )
        ) return;
        // Group fresh commits by project so a burst of N commits from one repo
        // increments lifetimeCounts N times in order.
        const fresh = [];
        const sourceEvents = (gitEvents || [])
            .filter(event => event?.type === 'commit');
        for (const event of sourceEvents) {
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            const id = commitIdentity(event);
            if (this._seenCommitIds.has(id)) continue;
            this._seenCommitIds.add(id);
            fresh.push(event);
        }
        if (this._seenCommitIds.size > MAX_COMMIT_SEEN) {
            this._seenCommitIds = new Set([...this._seenCommitIds].slice(-MAX_COMMIT_SEEN));
        }
        if (typeof this.chronicleStore.recordCommitEvents === 'function' && fresh.length) {
            const results = await this.chronicleStore.recordCommitEvents(fresh.map(event => ({
                projectId: event.project,
                commitId: commitIdentity(event),
                observedAt: commitTimestamp(event, now),
            })));
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            for (let index = 0; index < fresh.length; index++) {
                const result = results[index];
                if (!result?.recorded) continue;
                const tier = this.rules?.classifyMilestone?.(result.count) ?? null;
                if (tier) this._spawnMilestone(tier, fresh[index], result.count, now);
            }
            return;
        }

        for (const event of fresh) {
            if (this._disposed || generation !== this._lifecycleGeneration) return;
            try {
                const store = this.chronicleStore;
                if (!store) return;
                const result = typeof store.recordCommitEvent === 'function'
                    ? await store.recordCommitEvent(event.project, commitIdentity(event), commitTimestamp(event, now))
                    : { count: await store.recordCommit(event.project, now), recorded: true };
                if (this._disposed || generation !== this._lifecycleGeneration) return;
                if (!result.recorded) continue;
                const tier = this.rules?.classifyMilestone?.(result.count) ?? null;
                if (tier) this._spawnMilestone(tier, event, result.count, now);
            } catch { /* lifetime persistence is best-effort */ }
        }
    }

    _spawnMilestone(tier, event, count, now) {
        const project = String(event.project || 'unknown');
        const repo = projectName(project);
        const duration = MILESTONE_DURATIONS_MS[tier] || 6000;
        const banner = {
            tier,
            project,
            repo,
            count,
            startedAt: now,
            expiresAt: now + duration,
            tileX: INNER_QUAY_BASIN_TILE.tileX,
            tileY: INNER_QUAY_BASIN_TILE.tileY,
            text: this._milestoneText(tier, repo, count),
        };
        if (tier === 'flagship') {
            // Trigger lighthouse lock via event so HarborTraffic / Lighthouse can
            // subscribe without us editing them directly.
            this.eventBus?.emit?.('harbor:milestone-lock', { project, repo, durationMs: 4000, ts: now });
        }
        if (tier === 'aurora') {
            // 1000th commit: force aurora regardless of daily cap.
            this.auroraGate?.forceTrigger?.('milestone-1000', now);
        }
        this._activeBanners.push(banner);
        // Cap banners to keep overdraw bounded.
        if (this._activeBanners.length > 6) {
            this._activeBanners.splice(0, this._activeBanners.length - 6);
        }
        this.eventBus?.emit?.('chronicle:milestone-banner', banner);
    }

    // #18 — first-sighting christening. Raises a maiden banner over the repo's
    // own buoy (the event carries its anchorage tile), distinct from the
    // commit-count maiden milestone which sits at the inner quay basin.
    _christenRepo(event = {}) {
        if (this._disposed) return;
        const project = String(event.project || 'unknown');
        if (this._christenedRepos.has(project)) return;
        this._christenedRepos.add(project);
        if (this._christenedRepos.size > MAX_CHRISTENED_REPOS) {
            this._christenedRepos.delete(this._christenedRepos.values().next().value);
        }
        const repo = event.repoName || projectName(project);
        const now = Number(event.ts) || Date.now();
        const duration = MILESTONE_DURATIONS_MS.maiden || 6000;
        const tileX = Number.isFinite(Number(event.tileX)) ? Number(event.tileX) : INNER_QUAY_BASIN_TILE.tileX;
        const tileY = Number.isFinite(Number(event.tileY)) ? Number(event.tileY) : INNER_QUAY_BASIN_TILE.tileY;
        const banner = {
            tier: 'maiden',
            project,
            repo,
            startedAt: now,
            expiresAt: now + duration,
            tileX,
            tileY,
            text: `Maiden Voyage - ${repo}`,
        };
        this._activeBanners.push(banner);
        if (this._activeBanners.length > 6) {
            this._activeBanners.splice(0, this._activeBanners.length - 6);
        }
        this.eventBus?.emit?.('chronicle:milestone-banner', banner);
    }

    _milestoneText(tier, repo, count) {
        switch (tier) {
            case 'maiden': return `Maiden Voyage - ${repo}`;
            case 'ribbon': return `${repo} - 10 commits`;
            case 'flagship': return `${repo} - 100 commits`;
            case 'aurora': return `${repo} - 1000 commits`;
            default: return `${repo} - ${count} commits`;
        }
    }

    _drawFireworks(ctx, payload, zoom, now) {
        const reduced = reducedMotionPreferred();
        const elapsed = Math.max(0, now - Number(payload.startedAt || now));
        const lineWidth = Math.max(1, 1.5 / Math.max(1, zoom));
        ctx.save();
        ctx.translate(Math.round(payload.worldX), Math.round(payload.worldY));
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = payload.color || KIND_COLORS.release;
        if (reduced) {
            // Static three concentric outlines — no expansion.
            ctx.globalAlpha = 0.85;
            for (let i = 0; i < FIREWORKS_RING_COUNT; i++) {
                const radius = 28 + i * 20;
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        } else {
            ctx.globalCompositeOperation = 'lighter';
            for (let i = 0; i < FIREWORKS_RING_COUNT; i++) {
                const ringStart = i * FIREWORKS_RING_STAGGER_MS;
                const ringElapsed = elapsed - ringStart;
                if (ringElapsed < 0) continue;
                if (ringElapsed > FIREWORKS_RING_DURATION_MS) continue;
                const t = ringElapsed / FIREWORKS_RING_DURATION_MS;
                const radius = 6 + t * FIREWORKS_MAX_RADIUS;
                ctx.globalAlpha = Math.max(0, 0.85 * (1 - t));
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawBanner(ctx, payload, zoom, now) {
        const reduced = reducedMotionPreferred();
        const elapsed = Math.max(0, now - Number(payload.startedAt || now));
        const duration = Math.max(1, Number(payload.expiresAt || now) - Number(payload.startedAt || now));
        const t = Math.min(1, elapsed / duration);
        const fade = reduced ? 1 : Math.min(1, t < 0.15 ? t / 0.15 : (1 - t) / 0.2);
        if (fade <= 0) return;
        const text = payload.text || '';
        const tier = payload.tier || 'maiden';
        const accent = tier === 'aurora'
            ? '#bff0ff'
            : tier === 'flagship'
                ? '#ffd27a'
                : tier === 'ribbon'
                    ? '#ffea9b'
                    : '#e8f6c8';
        const scale = 1 / Math.max(1, zoom);
        ctx.save();
        ctx.translate(Math.round(payload.worldX), Math.round(payload.worldY));
        ctx.globalAlpha = fade;
        ctx.font = `${Math.round(14 * scale)}px "Press Start 2P", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const lift = tier === 'flagship' ? -84 : tier === 'ribbon' ? -56 : -48;
        const measure = ctx.measureText(text);
        const padX = 10 * scale;
        const padY = 6 * scale;
        const bgW = measure.width + padX * 2;
        const bgH = 18 * scale + padY * 2;
        ctx.fillStyle = 'rgba(16, 12, 24, 0.78)';
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.beginPath();
        const x = -bgW / 2;
        const y = lift * scale - bgH;
        ctx.rect(x, y, bgW, bgH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.fillText(text, 0, lift * scale - padY);
        if (!reduced && tier === 'ribbon') {
            // Small flag-ribbon flourish over the squad flagship anchor.
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.moveTo(bgW / 2, y + bgH / 2);
            ctx.lineTo(bgW / 2 + 12 * scale, y + bgH / 2 - 6 * scale);
            ctx.lineTo(bgW / 2 + 12 * scale, y + bgH / 2 + 6 * scale);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _collectPushEvents(agents) {
        const events = [];
        for (const agent of agents || []) {
            const sources = [agent?.gitEvents, agent?.git?.events, agent?.vcsEvents].filter(Array.isArray);
            for (const source of sources) {
                for (const event of source) {
                    const type = String(event?.type || event?.kind || '').toLowerCase();
                    if (type === 'push' || type === 'tag') {
                        events.push({ ...event, project: event.project || agent.project, provider: event.provider || agent.provider });
                    }
                }
            }
        }
        return events;
    }

    _dropExpired(now) {
        for (const [id, record] of this.records) {
            if (now - Number(record.plantedAt || record.ts || 0) > MONTH_MS) this.records.delete(id);
        }
    }

    _dropExpiredOverlays(now) {
        if (this._activeFireworks.length) {
            this._activeFireworks = this._activeFireworks.filter(f => Number(f.expiresAt || 0) > now);
        }
        if (this._activeBanners.length) {
            this._activeBanners = this._activeBanners.filter(b => Number(b.expiresAt || 0) > now);
        }
    }
}
