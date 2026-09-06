import { resolveObservation } from './ObservationCertainty.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';

const MAX_CONCURRENT_RITUALS = 6;
const COALESCE_WINDOW_MS = 250;
const DEFAULT_DURATION_MS = 1400;

const RITUAL_META = {
    forge: { kind: 'forge-strike', durationMs: 1500, pulseBand: 'medium' },
    archive: { kind: 'archive-page', durationMs: 1800, pulseBand: 'medium' },
    mine: { kind: 'mine-pick', durationMs: 1500, pulseBand: 'medium' },
    observatory: { kind: 'observatory-sweep', durationMs: 1900, pulseBand: 'slow' },
    portal: { kind: 'portal-mirror', durationMs: 2600, pulseBand: 'medium' },
    taskboard: { kind: 'task-paper', durationMs: 2600, pulseBand: 'fast' },
    command: { kind: 'command-signal', durationMs: 2600, pulseBand: 'static' },
    harbor: { kind: 'harbor-crate', durationMs: 30000, pulseBand: 'static' },
    watchtower: { kind: 'watchtower-flare', durationMs: 1800, pulseBand: 'slow' },
};

// Agent-level work-gesture pose per ritual building. Each of the nine
// buildings gets a small repeated gesture (hammer-tick at the forge,
// page-turn at the archive, pick-swing at the mine, scroll-unfurl at the
// taskboard, …) drawn procedurally by AgentSprite._drawToolRitualOverlay.
// `period` is the gesture cadence in ms; AgentSprite fires one downbeat
// particle per cycle. Consumed via getAgentPoses(); reduced motion draws
// the static posed frame and emits no particle.
const RITUAL_POSE_BY_BUILDING = {
    forge: 'hammer',
    archive: 'page',
    mine: 'pick',
    taskboard: 'scroll',
    observatory: 'gaze',
    portal: 'conjure',
    command: 'signal',
    harbor: 'haul',
    watchtower: 'scan',
};

// Gesture cadence (ms per downbeat) keyed by pose. AgentSprite reads this to
// time both the procedural animation and the one-shot particle on the peak.
const RITUAL_GESTURE_PERIOD_MS = {
    hammer: 460,
    page: 900,
    pick: 540,
    scroll: 1100,
    gaze: 1400,
    conjure: 760,
    signal: 820,
    haul: 980,
    scan: 1300,
};

// #41 — place-specific idle posture for villagers loitering at a scenic point.
// Keyed by AMBIENT_SCENIC_POINTS id; AgentSprite consults this while parked-idle
// at an `ambient:<id>` destination and folds the offsets into its posture path.
// `staticDy` (+down lean, -up lift) is also the reduced-motion resting offset;
// `bobScale` scales the idle bob; `idleFrame` (when set) pins a held rest frame
// (IDLE_FRAMES-1 = settled/eyes-low) so a reading or resting stance reads as a
// pose, not mid-cycle motion. No particles, no new pulse — purely postural.
const SCENIC_POINT_POSTURE = Object.freeze({
    'bridge-west': { staticDy: 1, bobScale: 0.8 },        // leaning on the rail
    'bridge-east': { staticDy: 1, bobScale: 0.8 },
    'harbor-rail': { staticDy: 1, bobScale: 0.75 },       // watching the water
    'harbor-ledger': { staticDy: 1, bobScale: 0.7, idleFrame: 3 }, // bent over the ledger
    'portal-ruins': { staticDy: -1, bobScale: 0.85 },     // craning at the arch
    'mine-cart': { staticDy: 1, bobScale: 0.8 },
    'forest-edge': { staticDy: 2, bobScale: 0.6, idleFrame: 3 },   // resting on the stone
    'archive-alcove': { staticDy: 1, bobScale: 0.65, idleFrame: 3 }, // reading, head low
    'observatory-view': { staticDy: -2, bobScale: 0.9 },  // skywatch, head up
    'lighthouse-shore': { staticDy: 1, bobScale: 0.75 },  // gazing out to sea
    'plaza-corner': { staticDy: 0, bobScale: 0.85 },
    'forge-handoff': { staticDy: 0, bobScale: 0.9 },
});

const COMMAND_LIFECYCLE_ACTIONS = {
    spawn: 'summon',
    send_input: 'familiar-send',
    wait: 'familiar-wait',
    resume: 'familiar-return',
    close: 'dismiss',
};

function compactText(value, fallback = '') {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    const base = (lastSlash >= 0 ? text.slice(lastSlash + 1) : text).split(/[?#\s]/)[0] || text;
    return base.length > 14 ? `${base.slice(0, 11)}...` : base;
}

function tryParseInput(input) {
    if (!input || typeof input !== 'string') return input;
    const text = input.trim();
    if (!/^[\[{]/.test(text)) return input;
    try {
        return JSON.parse(text);
    } catch {
        return input;
    }
}

function inputText(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function extractHost(input) {
    const parsed = tryParseInput(input);
    const candidates = [];
    const collect = (value) => {
        if (!value) return;
        if (typeof value === 'string') {
            candidates.push(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(collect);
            return;
        }
        if (typeof value === 'object') {
            ['url', 'uri', 'href', 'target', 'query', 'command', 'arguments', 'input'].forEach((key) => collect(value[key]));
        }
    };
    collect(parsed);
    for (const value of candidates) {
        const text = String(value || '');
        const match = text.match(/https?:\/\/[^\s"'<>]+/i);
        if (!match) continue;
        try {
            return new URL(match[0]).hostname.replace(/^www\./, '');
        } catch {
            // Keep looking.
        }
    }
    return '';
}

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash);
}

function stableIdentityValue(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 64 ? text.slice(0, 64) : text;
}

function taskItemCompleted(item) {
    if (!item || typeof item !== 'object') return false;
    const status = String(item.status || item.state || item.lifecycle || '').toLowerCase();
    return status === 'completed' || status === 'complete' || status === 'done'
        || item.completed === true || item.done === true || item.checked === true;
}

function taskIdentityFromItem(item) {
    if (item == null) return '';
    if (typeof item !== 'object') return stableIdentityValue(item);
    const idKeys = ['id', 'taskId', 'task_id', 'todoId', 'todo_id', 'itemId', 'item_id', 'key'];
    for (const key of idKeys) {
        const value = stableIdentityValue(item[key]);
        if (value) return `id:${value}`;
    }
    const textKeys = ['title', 'content', 'task', 'todo', 'description', 'name'];
    for (const key of textKeys) {
        const value = stableIdentityValue(item[key]);
        if (value) return `text:${value.toLowerCase()}`;
    }
    return '';
}

function extractTaskKey(input, { preferCompleted = false } = {}) {
    const parsed = tryParseInput(input);
    if (parsed && typeof parsed === 'object') {
        const direct = taskIdentityFromItem(parsed);
        if (direct) return direct;
    }

    const findInValue = (value) => {
        if (!value || typeof value !== 'object') return '';
        if (Array.isArray(value)) {
            const preferred = value.find(item => preferCompleted ? taskItemCompleted(item) : !taskItemCompleted(item));
            return taskIdentityFromItem(preferred || value[0]);
        }
        for (const key of ['todos', 'tasks', 'items', 'checklist', 'subtasks']) {
            if (Array.isArray(value[key])) {
                const keyFromList = findInValue(value[key]);
                if (keyFromList) return keyFromList;
            }
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') {
                const nested = findInValue(child);
                if (nested) return nested;
            }
        }
        return '';
    };
    if (parsed && typeof parsed === 'object') {
        const nested = findInValue(parsed);
        if (nested) return nested;
    }

    const text = inputText(input);
    const idMatch = text.match(/(?:(?:task|todo|item)[_-]?id|(?:^|["'\s])id)["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/i);
    if (idMatch?.[1]) return `id:${stableIdentityValue(idMatch[1])}`;
    return '';
}

function ritualMetaFor(event) {
    const building = event?.building;
    const base = RITUAL_META[building];
    const tool = String(event.tool || '');
    const input = event.input;
    const text = inputText(input);
    const host = extractHost(input);
    const isCompletedTask = /status['"]?\s*[:=]\s*['"]?completed\b/i.test(text) || /\bcompleted\b/i.test(text);
    const label = host ? compactText(host, host) : compactText(input, tool);
    if (tool === 'Task' || tool === 'Agent') {
        // Priority order: synthetic dispatch payload (child*), then classified
        // label, then subagent_type parsed from the Task input.
        const parsedInput = tryParseInput(input);
        const subagentTypeFromInput = parsedInput && typeof parsedInput === 'object'
            ? (parsedInput.subagent_type || parsedInput.subagentType || null)
            : null;
        const classifiedLabel = event?.label || null;
        const existingTarget = event?.commandLifecycle?.targetName || null;
        const targetName = event?.childAgentName
            || event?.childSubagentType
            || classifiedLabel
            || subagentTypeFromInput
            || existingTarget
            || null;
        return {
            ...RITUAL_META.portal,
            building: 'portal',
            kind: 'portal-summon',
            action: 'summon',
            label: compactText(targetName || tool, 'SUMMON'),
            commandLifecycle: {
                kind: 'spawn',
                targetAgentId: event?.commandLifecycle?.targetAgentId || null,
                targetName,
            },
        };
    }
    if (!base) return null;
    if (tool === '__token_delta') {
        return {
            ...RITUAL_META.mine,
            kind: 'mine-pick',
            label: `+${Number(input) || 0}`,
            cargo: event.cargo || null,
        };
    }
    if (building === 'taskboard') {
        return {
            ...base,
            action: isCompletedTask ? 'complete' : 'pin',
            taskKey: extractTaskKey(input, { preferCompleted: isCompletedTask }) || null,
            label: compactText(tool, 'TASK'),
        };
    }
    if (building === 'command' || building === 'portal') {
        const lifecycle = event.commandLifecycle || null;
        const lifecycleAction = COMMAND_LIFECYCLE_ACTIONS[lifecycle?.kind];
        if (lifecycleAction) {
            const targetLabel = lifecycle.targetName || lifecycle.targetRef || '';
            return {
                ...RITUAL_META.portal,
                building: 'portal',
                kind: `portal-${lifecycleAction}`,
                action: lifecycleAction,
                label: compactText(targetLabel, lifecycleAction),
                commandLifecycle: lifecycle,
            };
        }
        if (building === 'command') {
            const action = tool === 'SendMessage' ? 'message' : tool === 'TeamCreate' ? 'team' : 'command';
            return { ...base, action, label: compactText(tool, 'CMD') };
        }
    }
    if (building === 'observatory') {
        return {
            ...base,
            label: host ? compactText(host, host) : compactText(input, 'SEARCH'),
            angle: ((hashText(host || text || tool) % 220) - 160) * Math.PI / 180,
        };
    }
    if (building === 'portal') {
        return { ...base, label: host ? compactText(host, host) : compactText(tool.replace(/^mcp__|^functions\./, ''), 'PORTAL') };
    }
    return { ...base, label };
}

function screenToTile(x, y) {
    return {
        tileX: (x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2,
        tileY: (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2,
    };
}

function agentTile(agent) {
    if (!agent?.position) return null;
    const tileX = Number(agent.position.tileX);
    const tileY = Number(agent.position.tileY);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return { tileX, tileY };
}

function spriteTile(sprite) {
    const x = Number(sprite?.x);
    const y = Number(sprite?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (typeof sprite._screenToTile === 'function') return sprite._screenToTile(x, y);
    return screenToTile(x, y);
}

function buildingContainsTile(building, tile) {
    if (!building || !tile) return false;
    if (typeof building.containsPoint === 'function' && building.containsPoint(tile.tileX, tile.tileY)) return true;
    if (typeof building.containsVisitPoint === 'function' && building.containsVisitPoint(tile.tileX, tile.tileY)) return true;
    const visitTile = typeof building.primaryVisitTile === 'function' ? building.primaryVisitTile() : null;
    if (visitTile) return Math.hypot(visitTile.tileX - tile.tileX, visitTile.tileY - tile.tileY) <= 0.85;
    return false;
}

function lifecycleTargetKey(lifecycle) {
    if (!lifecycle?.kind) return '';
    return [
        lifecycle.kind,
        lifecycle.targetAgentId || '',
        lifecycle.targetProviderId || '',
        lifecycle.targetRef || '',
    ].join('\u001f');
}

export class RitualConductor {
    constructor({ motionScale = 1 } = {}) {
        this.motionScale = motionScale;
        this.context = {
            world: null,
            agentSprites: null,
            isAgentVisible: null,
        };
        this.rituals = [];
        this._overflowCount = 0;
        this.unsubscribers = [
            eventBus.on('tool:invoked', (event) => this.enqueue(event)),
        ];
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.rituals = [];
        this._overflowCount = 0;
        this.context = { world: null, agentSprites: null, isAgentVisible: null };
    }

    setMotionScale(scale) {
        this.motionScale = Number.isFinite(scale) ? scale : 1;
    }

    setContext({ world, agentSprites, isAgentVisible } = {}) {
        if (world !== undefined) this.context.world = world || null;
        if (agentSprites !== undefined) this.context.agentSprites = agentSprites || null;
        if (isAgentVisible !== undefined) {
            this.context.isAgentVisible = typeof isAgentVisible === 'function' ? isAgentVisible : null;
        }
    }

    canAccept(event) {
        if (!event?.agentId || !event?.building) return false;
        const { world, agentSprites, isAgentVisible } = this.context;
        const hasWorld = !!world?.agents?.get;
        const hasBuildings = !!world?.buildings?.get;
        const hasSprites = !!agentSprites?.get;
        const agent = hasWorld ? world.agents.get(event.agentId) : null;
        const sprite = hasSprites ? agentSprites.get(event.agentId) : null;
        const building = hasBuildings ? world.buildings.get(event.building) : null;

        if (hasWorld && !agent) return false;
        if (hasBuildings && !building) return false;
        if (hasSprites && !sprite) return false;
        if (typeof isAgentVisible === 'function' && !isAgentVisible(event.agentId)) return false;
        if (sprite?.isArrivalPending?.()) return false;
        if (resolveObservation(agent || sprite?.agent, Date.now()).state === 'stale') return false;

        if (event.commandLifecycle?.kind) return true;

        if (!building) return true;
        if (sprite) return buildingContainsTile(building, spriteTile(sprite));
        if (agent && typeof building.isAgentVisiting === 'function') return building.isAgentVisiting(agent);
        return buildingContainsTile(building, agentTile(agent));
    }

    enqueue(event) {
        if (!event?.tool || !event?.building) return null;
        const meta = ritualMetaFor(event);
        if (!meta) return null;
        if (!this.canAccept(event)) return null;
        const building = meta.building || event.building;
        const now = event.ts || Date.now();
        const targetKey = lifecycleTargetKey(meta.commandLifecycle || event.commandLifecycle);
        const existing = this.rituals.find(ritual => (
            ritual.building === building
            && ritual.kind === meta.kind
            && ritual.tool === event.tool
            && lifecycleTargetKey(ritual.commandLifecycle) === targetKey
            && now - ritual.createdAt <= COALESCE_WINDOW_MS
        ));
        if (existing) {
            existing.count += 1;
            existing.createdAt = now;
            existing.remainingMs = Math.max(existing.remainingMs, meta.durationMs || DEFAULT_DURATION_MS);
            existing.label = meta.label || existing.label;
            existing.cargo = meta.cargo || existing.cargo;
            return existing;
        }

        if (this.rituals.length >= MAX_CONCURRENT_RITUALS) {
            this._overflowCount++;
            this.rituals.sort((a, b) => a.createdAt - b.createdAt);
            this.rituals.shift();
        }

        const ritual = {
            id: `${event.agentId}:${event.tool}:${now}`,
            agentId: event.agentId,
            tool: event.tool,
            input: event.input || null,
            building,
            kind: meta.kind,
            action: meta.action || null,
            taskKey: meta.taskKey || null,
            cargo: meta.cargo || null,
            label: meta.label || '',
            angle: meta.angle || 0,
            commandLifecycle: meta.commandLifecycle || event.commandLifecycle || null,
            pose: RITUAL_POSE_BY_BUILDING[building] || null,
            pulseBand: meta.pulseBand || 'static',
            phase: 'pending',
            count: 1,
            createdAt: now,
            elapsedMs: 0,
            durationMs: meta.durationMs || DEFAULT_DURATION_MS,
            remainingMs: meta.durationMs || DEFAULT_DURATION_MS,
            motionEnabled: this.motionScale > 0,
        };
        this.rituals.push(ritual);
        return ritual;
    }

    update(dt = 16) {
        const delta = Math.max(0, Number(dt) || 0);
        for (const ritual of this.rituals) {
            const agent = this.context.world?.agents?.get?.(ritual.agentId) || this.context.agentSprites?.get?.(ritual.agentId)?.agent;
            ritual.motionEnabled = this.motionScale > 0 && resolveObservation(agent, Date.now()).state !== 'stale';
            ritual.elapsedMs += delta;
            ritual.remainingMs -= delta;
            if (ritual.elapsedMs >= 180 && ritual.phase === 'pending') ritual.phase = 'playing';
            if (ritual.remainingMs <= 280 && ritual.phase !== 'done') ritual.phase = 'fading';
            if (ritual.remainingMs <= 0) ritual.phase = 'done';
        }
        this.rituals = this.rituals.filter(ritual => ritual.phase !== 'done');
    }

    getActiveRitualsForBuilding(type) {
        return this.rituals.filter(ritual => ritual.building === type);
    }

    // Newest active pose-bearing ritual per agent, keyed by agentId.
    getAgentPoses() {
        const poses = new Map();
        for (const ritual of this.rituals) {
            if (!ritual.pose || !ritual.agentId) continue;
            const existing = poses.get(ritual.agentId);
            if (!existing || ritual.createdAt > existing.createdAt) poses.set(ritual.agentId, ritual);
        }
        return poses;
    }

    getSnapshot() {
        return this.rituals.map(ritual => ({ ...ritual }));
    }

    getOverflowCount() {
        return this._overflowCount;
    }

    resetOverflowCount() {
        this._overflowCount = 0;
    }
}

export { MAX_CONCURRENT_RITUALS, RITUAL_GESTURE_PERIOD_MS, SCENIC_POINT_POSTURE };
