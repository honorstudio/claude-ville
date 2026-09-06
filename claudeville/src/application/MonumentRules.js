// Chronicle monuments classify repository milestones only. Quota, token,
// usage, and rollover events are deliberately excluded; the Token Mine owns
// token-cap visuals and this module must not create quota stones.

import { BUILDING_DEFS } from '../config/buildings.js';
import { eventBus } from '../domain/events/DomainEvent.js';

const DISTRICT_BY_TYPE = {
    feat: 'forge',
    fix: 'taskboard',
    refactor: 'forge',
    perf: 'mine',
};

const DISTRICT_ALIASES = {
    code: 'forge',
    task: 'taskboard',
    tasks: 'taskboard',
    lore: 'archive',
    knowledge: 'archive',
    token: 'mine',
    harbor: 'harbor',
};

const DISTRICT_CAP = 6;

const MILESTONE_TIERS = Object.freeze([
    { count: 1000, tier: 'aurora' },
    { count: 100, tier: 'flagship' },
    { count: 10, tier: 'ribbon' },
    { count: 1, tier: 'maiden' },
]);

function textOf(value) {
    return String(value || '').trim();
}

function conventionalType(message) {
    const match = textOf(message).match(/^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/i);
    if (!match) return null;
    return { type: match[1].toLowerCase(), subject: match[2] };
}

function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    return textOf(match?.[1] || match?.[2] || match?.[3] || '');
}

function targetReleaseRef(event) {
    const ref = textOf(event.targetRef || event.ref || event.tag);
    const cleaned = ref.replace(/^refs\/tags\//, '');
    return /^v?\d+\.\d+/.test(cleaned) ? cleaned : '';
}

function eventTs(event, fallback = Date.now()) {
    const raw = event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.completedAt;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function stableHash(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function projectName(project) {
    const parts = textOf(project).split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || 'unknown';
}

function normalizeDistrict(district) {
    const key = textOf(district).toLowerCase();
    return DISTRICT_ALIASES[key] || key || 'archive';
}

function occupiedBuildingTiles(building) {
    const tiles = new Set();
    for (let dx = 0; dx < (building.width || 1); dx++) {
        for (let dy = 0; dy < (building.height || 1); dy++) {
            tiles.add(`${building.x + dx},${building.y + dy}`);
        }
    }
    for (const ex of building.walkExclusion || []) {
        for (let dx = 0; dx < (ex.width || 1); dx++) {
            for (let dy = 0; dy < (ex.height || 1); dy++) {
                tiles.add(`${building.x + ex.dx + dx},${building.y + ex.dy + dy}`);
            }
        }
    }
    for (const tile of building.visitTiles || []) {
        tiles.add(`${tile.tileX},${tile.tileY}`);
    }
    return tiles;
}

// Short narrative line per monument kind, for detail overlays/tooltips.
const LORE_BY_KIND = {
    feature: (label, repo) => `Raised when "${label}" came to ${repo}.`,
    fix: (label, repo) => `Marks the mending of "${label}" in ${repo}.`,
    performance: (label, repo) => `Honors the quickening of ${repo}: "${label}".`,
    release: (label, repo) => `Commemorates the launch of ${label} from the ${repo} harbor.`,
};

function monumentLore(kind, label, repoName) {
    const template = LORE_BY_KIND[kind];
    return template ? template(textOf(label) || kind, repoName) : '';
}

function isTokenEvent(event) {
    const type = textOf(event?.type).toLowerCase();
    const kind = textOf(event?.kind).toLowerCase();
    const source = textOf(event?.source).toLowerCase();
    return /token|quota|usage|rollover/.test(`${type} ${kind} ${source}`);
}

export class MonumentRules {
    classify(event) {
        if (!event || isTokenEvent(event)) return null;
        const type = textOf(event.type).toLowerCase();
        if (!['commit', 'push', 'tag', 'pr-merge'].includes(type)) return null;

        if ((type === 'tag' || type === 'push') && targetReleaseRef(event)) {
            return this._releaseStone(event);
        }
        if (type === 'commit' || type === 'pr-merge') {
            return this._featureStone(event);
        }
        return null;
    }

    _releaseStone(event) {
        const ref = targetReleaseRef(event) || textOf(event.targetRef || event.ref || event.tag || 'release');
        const project = textOf(event.project || event.repository || event.repo || 'unknown');
        return {
            kind: 'release',
            district: 'harbor',
            weight: 'major',
            label: ref.replace(/^refs\/tags\//, '') || 'release',
            dedupKey: `release:${project}:${ref || event.id || event.commandHash || event.ts}`,
        };
    }

    _featureStone(event) {
        const parsed = conventionalType(
            event.subject || event.message || event.label || commitMessageFromCommand(event.command) || event.command
        );
        if (!parsed || !DISTRICT_BY_TYPE[parsed.type]) return null;
        const project = textOf(event.project || event.repository || event.repo || 'unknown');
        return {
            kind: parsed.type === 'fix' ? 'fix' : parsed.type === 'perf' ? 'performance' : 'feature',
            district: DISTRICT_BY_TYPE[parsed.type],
            weight: parsed.type === 'feat' ? 'medium' : 'minor',
            label: parsed.subject || parsed.type,
            dedupKey: `commit:${project}:${event.sha || event.commandHash || event.id || textOf(parsed.subject).slice(0, 80)}`,
        };
    }

    classifyMilestone(projectCommitCount) {
        const count = Number(projectCommitCount);
        if (!Number.isFinite(count) || count <= 0) return null;
        for (const { count: threshold, tier } of MILESTONE_TIERS) {
            if (count === threshold) return tier;
        }
        return null;
    }

    buildRecord(event, context = {}) {
        const result = this.classify(event);
        if (!result) return null;
        const now = Number(context.now || Date.now());
        const project = textOf(event.project || event.repository || event.repo || context.project || 'unknown');
        const id = stableHash(result.dedupKey);
        const placement = chooseMonumentPlacement(result.district, {
            seed: result.dedupKey,
            monuments: context.monuments,
            waterTiles: context.waterTiles,
            blockedTiles: context.blockedTiles,
        });
        return {
            id,
            dedupKey: result.dedupKey,
            kind: result.kind,
            district: normalizeDistrict(result.district),
            weight: result.weight,
            label: result.label,
            lore: monumentLore(result.kind, result.label, projectName(project)),
            project,
            repoName: projectName(project),
            plantedAt: eventTs(event, now),
            ts: eventTs(event, now),
            sourceEventId: textOf(event.id || event.sourceId || event.commandHash),
            tileX: placement.tileX,
            tileY: placement.tileY,
        };
    }

    static foundingLayerReached(monumentsForDistrict = []) {
        return Array.isArray(monumentsForDistrict) && monumentsForDistrict.length >= 7;
    }

    static applyDistrictCap(monumentsForDistrict = [], cap = DISTRICT_CAP) {
        const list = Array.isArray(monumentsForDistrict) ? [...monumentsForDistrict] : [];
        list.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
        return {
            visible: list.slice(0, cap),
            foundingLayer: list.length > cap,
        };
    }
}

export function chooseMonumentPlacement(district, options = {}) {
    const normalized = normalizeDistrict(district);
    const building = BUILDING_DEFS.find(def => def.type === normalized)
        || BUILDING_DEFS.find(def => def.district === normalized)
        || BUILDING_DEFS.find(def => def.type === 'archive')
        || BUILDING_DEFS[0];
    const occupied = occupiedBuildingTiles(building);
    const waterTiles = options.waterTiles || new Set();
    const blockedTiles = options.blockedTiles || new Set();
    const monuments = Array.isArray(options.monuments) ? options.monuments : [];
    const seed = parseInt(stableHash(options.seed || normalized), 36) || 0;
    const center = building.entrance || {
        tileX: building.x + Math.floor((building.width || 1) / 2),
        tileY: building.y + (building.height || 1),
    };
    const candidates = [];

    for (let radius = 1; radius <= 7; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                const tileX = Math.max(0, Math.min(39, Math.round(center.tileX + dx)));
                const tileY = Math.max(0, Math.min(39, Math.round(center.tileY + dy)));
                const key = `${tileX},${tileY}`;
                if (occupied.has(key) || waterTiles.has(key) || blockedTiles.has(key)) continue;
                const nearOther = monuments.some(monument => (
                    Math.hypot(Number(monument.tileX) - tileX, Number(monument.tileY) - tileY) < 2
                ));
                if (!nearOther) candidates.push({ tileX, tileY });
            }
        }
        if (candidates.length) break;
    }

    if (!candidates.length) return { tileX: center.tileX, tileY: center.tileY + 1 };
    return candidates[seed % candidates.length];
}

export class MonumentPlanter {
    constructor({ store, rules = new MonumentRules(), eventTarget = eventBus } = {}) {
        this.store = store;
        this.rules = rules;
        this.eventBus = eventTarget;
        this.seen = new Set();
    }

    async processEvents(events = [], context = {}) {
        if (!this.store) return [];
        const planted = [];
        const isActive = typeof context.isActive === 'function' ? context.isActive : () => true;
        for (const event of events) {
            if (!isActive()) break;
            const record = this.rules.buildRecord(event, context);
            if (!record || this.seen.has(record.id)) continue;
            this.seen.add(record.id);
            try {
                const existing = await this.store.get('monuments', record.id);
                if (!isActive()) break;
                if (existing) continue;
                await this.store.put('monuments', record);
                if (!isActive()) break;
                planted.push(record);
                this.eventBus?.emit?.('chronicle:milestone', record);
            } catch {
                // Chronicle writes are best-effort and must not break live rendering.
            }
        }
        return planted;
    }
}
