import { eventBus } from '../../domain/events/DomainEvent.js';
import { WORLD_BODY_FONT } from '../../config/theme.js';
import { tileToWorld, worldToTile } from './Projection.js';
import { compactToolLabel, isCommandToolName, isTaskCommandInput } from '../../domain/services/ToolIdentity.js';
import { providerColor } from './ArrivalDeparture.js';
import { resolveObservation } from './ObservationCertainty.js';

const MAX_ITEMS_PER_KIND = 10;
const SNAPSHOT_TTL_MS = 18000;
const FORGE_HANDOFF_WINDOW_MS = 45000;
const TOKEN_ITEM_TTL_MS = 22000;
const COMMAND_ITEM_TTL_MS = 16000;
const RITUAL_TOKEN_DELTA_THRESHOLD = 256;
const CACHE_CARGO_CRYSTAL = '#9fd8f0';
const CACHE_CARGO_ORE = '#5c554b';
const CACHE_CARGO_CRYSTAL_COLORS = ['#bfe9ff', '#8fd0f4', '#e6f8ff'];
const CACHE_CARGO_ORE_COLORS = ['#5c554b', '#3f3a33', '#7e6a50'];
const CACHE_CLASS_DELTA_THRESHOLD = 64;
// Chat direction lines fade linearly over this window from the last
// observed message activity, so older messages read as fainter links.
const CHAT_LINE_MESSAGE_FADE_MS = 8000;
const PRESENCE_RECENCY_MS = 60000;
const PRESENCE_EMIT_INTERVAL_MS = 500;
const PRESENCE_DORMANT_THRESHOLD = 0.1;
// Archive shelf-fill keyed to local-search counter.
// Decay over 2 min so a burst of 6 reads gives full intensity for ~30 s then fades.
const ARCHIVE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const ARCHIVE_READ_DECAY_HALFLIFE_S = 120;
const ARCHIVE_READ_FULL_INTENSITY_COUNT = 6;

// 4.3 — the assay bench's rolling memory. Sixty one-second buckets, filled
// only from positive, non-reset deltas between two consecutive *observations*
// of the same session, so the trays measure what was seen in the last minute
// rather than a share of a lifetime pile.
const ASSAY_BUCKETS = 60;
// 4.3 — spend is only ever a difference between two fresh observations that
// agree on provenance. A source flip, a pricing-revision change or a negative
// delta ends the window and is disclosed as a gap; it never becomes a spike.
// Providers that report no usage split at all (Grok is context-only) never
// reach these buckets: `tokens.availability === 'unavailable'` excludes them.
const ASSAY_COST_STAMP_LIMIT = 6;
// 4.4 — the Forge workload. Deduplicated `tool:invoked` events that the
// canonical classifier routed to the Forge *and* whose reason is a file
// mutation. These are observed edit *calls*: not successful edits, not lines
// changed, not productivity.
const FORGE_WORKLOAD_BUCKETS = 60;
const FORGE_EDIT_REASONS = new Set([
    'edit-file',
    'write-file',
    'patch-file',
    'edit-notebook',
    'modify-files',
]);
// Documented billet thresholds: one billet for any observed call in the
// window, two from four, three from ten. The exact count is one inspection
// away, so the tiers never have to carry it.
const FORGE_BILLET_THRESHOLDS = [1, 4, 10];
// 4.4 — a long idle banks the hearth. Measured from the last observed Forge
// edit call, and only once this reducer has been watching for at least as
// long: a fresh page has observed nothing, which is not the same as an idle
// workshop.
const FORGE_BANK_IDLE_MS = 600000;

const BUILDING_OFFSETS = {
    command: [
        { x: -42, y: -48 }, { x: -16, y: -62 }, { x: 20, y: -58 }, { x: 44, y: -36 },
    ],
    forge: [
        { x: -28, y: -30 }, { x: -6, y: -42 }, { x: 20, y: -30 }, { x: 38, y: -12 },
    ],
    mine: [
        { x: -34, y: -24 }, { x: -10, y: -36 }, { x: 22, y: -30 }, { x: 42, y: -12 },
    ],
    taskboard: [
        { x: -36, y: -34 }, { x: -12, y: -46 }, { x: 14, y: -40 }, { x: 38, y: -24 },
    ],
};

const TOOL_LABELS = {
    forge: 'PATCH',
    taskboard: 'CHECK',
    command: 'SEND',
    mine: 'TOK',
};

function toWorld(tileX, tileY) {
    return tileToWorld(tileX, tileY);
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
    const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
    const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
    const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
    return input + output + cacheRead + cacheCreate;
}

function tokenClassTotals(agent) {
    const tokens = agent?.tokens || {};
    return {
        input: Math.max(0, Number(tokens.input ?? tokens.totalInput ?? 0) || 0),
        cacheRead: Math.max(0, Number(tokens.cacheRead ?? 0) || 0),
        available: tokens.availability !== 'unavailable',
    };
}

function mixHex(a, b, ratio) {
    const parse = value => {
        const hex = String(value).replace('#', '');
        return [
            Number.parseInt(hex.slice(0, 2), 16),
            Number.parseInt(hex.slice(2, 4), 16),
            Number.parseInt(hex.slice(4, 6), 16),
        ];
    };
    const from = parse(a);
    const to = parse(b);
    const t = Math.max(0, Math.min(1, Number(ratio) || 0));
    return `rgb(${from.map((value, i) => Math.round(value + (to[i] - value) * t)).join(', ')})`;
}

function cargoFromTokenBeat(current, previous, deltaTotal) {
    if (!current.available || !previous.available) return null;
    const cacheReadDelta = current.cacheRead - previous.cacheRead;
    const inputDelta = current.input - previous.input;
    if (cacheReadDelta < 0 || inputDelta < 0) return null;
    const classDeltaTotal = cacheReadDelta + inputDelta;
    if (classDeltaTotal >= CACHE_CLASS_DELTA_THRESHOLD) {
        return {
            ratio: cacheReadDelta / classDeltaTotal,
            source: 'delta',
            cacheRead: cacheReadDelta,
            input: inputDelta,
            deltaTotal,
        };
    }
    const cumulativeTotal = current.cacheRead + current.input;
    if (cumulativeTotal <= 0) return null;
    return {
        ratio: current.cacheRead / cumulativeTotal,
        source: 'cumulative',
        cacheRead: current.cacheRead,
        input: current.input,
        deltaTotal,
    };
}

function formatTokenCount(value) {
    const count = Math.max(0, Number(value) || 0);
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return String(Math.round(count));
}

// Exact counts, grouped for reading. The assay bench states quantities; it
// never states a share.
function formatExactCount(value) {
    const count = Math.max(0, Math.round(Number(value) || 0));
    return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A measured window of spend, never a rate extrapolated past what was seen.
function formatWindowUsd(value) {
    const usd = Math.max(0, Number(value) || 0);
    if (usd > 0 && usd < 0.01) return '< $0.01';
    return `~$${usd.toFixed(2)}`;
}

function createRing(size) {
    return { slots: new Array(size).fill(0), stamps: new Array(size).fill(-1) };
}

// One bucket per wall-clock second, so a bucket that falls out of the window
// is recognised by its stamp instead of being shifted.
function ringAdd(ring, now, value) {
    const amount = Number(value) || 0;
    if (amount <= 0) return;
    const size = ring.slots.length;
    const second = Math.floor(now / 1000);
    const index = ((second % size) + size) % size;
    if (ring.stamps[index] !== second) {
        ring.stamps[index] = second;
        ring.slots[index] = 0;
    }
    ring.slots[index] += amount;
}

function ringSum(ring, now) {
    const size = ring.slots.length;
    const oldest = Math.floor(now / 1000) - (size - 1);
    let total = 0;
    for (let index = 0; index < size; index++) {
        if (ring.stamps[index] >= oldest) total += ring.slots[index];
    }
    return total;
}

function ringClear(ring) {
    ring.slots.fill(0);
    ring.stamps.fill(-1);
}

// Same project key the repo tags and the panel use, so "the selected project"
// means one thing everywhere.
function assayProjectKey(agent) {
    return String(agent?.projectPath || agent?.project || agent?.teamName || agent?.provider || '').trim();
}

// Provenance identity of a cost observation. Any change here ends the window:
// an estimate and a provider invoice are not two samples of one series, and
// neither are two different pricing revisions.
function costProvenanceOf(cost) {
    if (!cost) return null;
    return `${cost.source || 'estimate'}|${cost.rateRevision || ''}|${cost.rateMatch ?? ''}`;
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function activityKey(agent, kind) {
    return [
        kind,
        agent?.id || 'unknown',
        agent?.currentTool || agent?.lastTool || '',
        agent?.currentToolInput || agent?.lastToolInput || '',
        agent?.lastSessionActivity || '',
    ].join('|');
}

function isTaskCommand(agent) {
    return isTaskCommandInput(`${agent?.currentTool || ''} ${agent?.currentToolInput || ''} ${agent?.lastToolInput || ''}`);
}

function isCommandTool(agent) {
    return isCommandToolName(agent?.currentTool);
}

function commandActivityLabel(agent) {
    if (agent?.currentTool === 'SendMessage') return 'MSG';
    if (agent?.currentTool === 'Task') return 'SUMMON';
    return compactToolLabel(agent?.currentTool, TOOL_LABELS.command, 10);
}

const LANDMARK_ACTIVITY_SCENE_ITEMS = [];
export const LANDMARK_ACTIVITY_SCENE_CATEGORY = Object.freeze({
    id: 'landmark-activity',
    sortBand: 60,
    enumerate({ renderer, renderNow } = {}) {
        const items = LANDMARK_ACTIVITY_SCENE_ITEMS;
        items.length = 0;
        const drawables = renderer?.landmarkActivity?.enumerateDrawables?.(renderNow) ?? [];
        for (let index = 0; index < drawables.length; index++) items.push(drawables[index]);
        return items;
    },
    emitSceneCommands() {
        return null;
    },
    canvasFallback(ctx, drawable, zoom, context = {}) {
        const landmarkActivity = context.renderer?.landmarkActivity || context.landmarkActivity;
        landmarkActivity?.draw?.(ctx, drawable, zoom);
    },
    unsupported: 'overlay-safe',
    overlayBand: 60,
});

export class LandmarkActivity {
    constructor({ world, sprites } = {}) {
        this.world = world || null;
        this.sprites = sprites || null;
        this.motionScale = 1;
        this.frame = 0;
        this.items = new Map();
        this.seenSnapshots = new Set();
        this.previousTokenTotals = new Map();
        this.previousTokenClassTotals = new Map();
        this._tokenHitEntries = [];
        this.lastForgeByAgent = new Map();
        // Rolling Read/Grep/Glob/LS counter for the Archive.
        // Decay-based: each update() step multiplies count by exp(-dt / halflife).
        this._archiveReadCounter = { count: 0, lastInvocationTs: 0 };
        this._archiveReadSeen = new Set();
        // 4.3 — per-session assay state: rolling token-class buckets, the last
        // observed class totals, and the cost window with its provenance.
        this._assayByAgent = new Map();
        // The scope the bench reports. Selection is the only thing that
        // narrows it; with nothing selected the bench states an aggregate.
        this._selectedAgentId = null;
        this._selectedProject = null;
        this._onAgentSelected = (agent) => {
            this._selectedAgentId = agent?.id || null;
            this._selectedProject = agent ? assayProjectKey(agent) : null;
        };
        this._onAgentDeselected = () => {
            this._selectedAgentId = null;
            this._selectedProject = null;
        };
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:deselected', this._onAgentDeselected);
        // 4.4 — Forge workload: one bucket per second of deduplicated edit
        // calls, plus the last one observed and when this reducer started
        // watching (an unobserved workshop is not an idle one).
        this._forgeEditRing = createRing(FORGE_WORKLOAD_BUCKETS);
        this._forgeEditSeen = new Set();
        this._lastForgeEditAt = 0;
        this._forgeObservingSince = Date.now();
        this._onToolInvoked = (event) => this._observeForgeEditCall(event);
        eventBus.on('tool:invoked', this._onToolInvoked);
        this.agentSprites = [];
        this._kindIds = new Map();
        this._recencyByType = new Map();
        this._countByType = new Map();
        this._lastPresenceEmit = 0;
        this._disposed = false;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    update(agents, agentSprites = [], dt = 16, now = Date.now()) {
        if (this._disposed) return;
        this.advance(dt);
        this.reconcile(agents, agentSprites, now);
    }

    advance(dt = 16) {
        if (this._disposed) return;
        this.frame += (dt / 16) * this.motionScale;
        // Decay the Archive read counter before observing new invocations so
        // this frame's bumps remain at their full weight.
        this._decayArchiveReadCounter(dt);
    }

    reconcile(agents, agentSprites = [], now = Date.now()) {
        if (this._disposed) return;
        this.agentSprites = Array.isArray(agentSprites)
            ? agentSprites
            : Array.from(agentSprites || []);
        const agentList = Array.from(agents || []);
        this._pruneAgentState(agentList, now);

        for (const agent of agentList) {
            this._observeTokens(agent, now);
            this._observeAssay(agent, now);
            this._observeToolActivity(agent, now);
            this._observeArchiveReadActivity(agent, now);
        }

        this._observeCommandRelationships(agentList, now);
        this._expireItems(now);
        this._refreshBuildingCounts();
        this._maybeEmitPresence(now);
    }

    _pruneAgentState(agents, now) {
        const liveIds = new Set(agents.map(agent => agent?.id).filter(Boolean));
        for (const agentId of this.previousTokenTotals.keys()) {
            if (!liveIds.has(agentId)) this.previousTokenTotals.delete(agentId);
        }
        for (const agentId of this.previousTokenClassTotals.keys()) {
            if (!liveIds.has(agentId)) this.previousTokenClassTotals.delete(agentId);
        }
        for (const agentId of this._assayByAgent.keys()) {
            if (!liveIds.has(agentId)) this._assayByAgent.delete(agentId);
        }
        for (const [agentId, forge] of this.lastForgeByAgent) {
            if (!liveIds.has(agentId) || now - Number(forge?.at || 0) > FORGE_HANDOFF_WINDOW_MS) {
                this.lastForgeByAgent.delete(agentId);
            }
        }
    }

    getDiagnostics() {
        return {
            items: this.items.size,
            seenSnapshots: this.seenSnapshots.size,
            previousTokenTotals: this.previousTokenTotals.size,
            previousTokenClassTotals: this.previousTokenClassTotals.size,
            lastForgeAgents: this.lastForgeByAgent.size,
            archiveReadKeys: this._archiveReadSeen.size,
            assaySessions: this._assayByAgent.size,
            forgeEditKeys: this._forgeEditSeen.size,
            retainedAgentSprites: this.agentSprites.length,
            disposed: this._disposed,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.items.clear();
        this.seenSnapshots.clear();
        this.previousTokenTotals.clear();
        this.previousTokenClassTotals.clear();
        this._tokenHitEntries = [];
        this.lastForgeByAgent.clear();
        this._archiveReadSeen.clear();
        this._assayByAgent.clear();
        this._forgeEditSeen.clear();
        ringClear(this._forgeEditRing);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:deselected', this._onAgentDeselected);
        eventBus.off('tool:invoked', this._onToolInvoked);
        this._kindIds.clear();
        this._recencyByType.clear();
        this._countByType.clear();
        this.agentSprites = [];
        this.world = null;
        this.sprites = null;
        this._archiveReadCounter = { count: 0, lastInvocationTs: 0 };
    }

    enumerateDrawables(now = Date.now()) {
        if (this._disposed) return [];
        const drawables = [];
        for (const item of this.items.values()) {
            const pos = this._itemPosition(item, now);
            if (!pos) continue;
            drawables.push({
                kind: 'landmark-activity',
                sortY: pos.y + (item.sortOffset || 0),
                payload: {
                    ...item,
                    x: pos.x,
                    y: pos.y,
                    progress: pos.progress,
                    alpha: this._itemAlpha(item, now),
                },
            });
        }
        const visible = drawables
            .filter((d) => d.payload.alpha > 0.03)
            .sort((a, b) => a.sortY - b.sortY);
        this._tokenHitEntries = visible
            .filter(drawable => drawable.payload.type === 'token')
            .map(drawable => ({ x: drawable.payload.x, y: drawable.payload.y, item: drawable.payload }));
        return visible;
    }

    hitTestTokenItem(worldX, worldY) {
        for (let i = this._tokenHitEntries.length - 1; i >= 0; i--) {
            const entry = this._tokenHitEntries[i];
            if (Math.hypot(worldX - entry.x, worldY - entry.y) <= 20) return entry.item;
        }
        return null;
    }

    // Counts, never a share: the cart says how much of each class was seen in
    // this beat, and the selected Mine's assay bench carries the 60 s ledger.
    tokenItemTooltip(item) {
        const cargo = item?.cargo;
        if (!cargo) return '';
        const scope = cargo.source === 'cumulative' ? 'session total' : 'observed beat';
        return `${formatExactCount(cargo.input)} input · ${formatExactCount(cargo.cacheRead)} cache read · ${scope}`;
    }

    draw(ctx, drawable, zoom = 1) {
        const item = drawable?.payload || drawable;
        if (!item) return;
        if (item.type === 'forge') return this._drawForgeItem(ctx, item, zoom);
        if (item.type === 'handoff') return this._drawHandoffItem(ctx, item, zoom);
        if (item.type === 'task') return this._drawTaskItem(ctx, item, zoom);
        if (item.type === 'chat') return this._drawChatItem(ctx, item, zoom);
        if (item.type === 'chat-line') {
            return this._drawConnection(ctx, item, item.color || '#f2d36b', zoom, { arrow: true, alphaScale: 0.55 });
        }
        if (item.type === 'token') return this._drawTokenItem(ctx, item, zoom);
        if (item.type === 'command') return this._drawCommandItem(ctx, item, zoom);
        if (item.type === 'dispatch-line') return this._drawConnection(ctx, item, '#f6c85f', zoom);
    }

    _observeToolActivity(agent, now) {
        if (!agent?.currentTool) return;
        const building = agent.targetBuildingType;
        if (building === 'forge') this._addForgeItem(agent, now);
        if (building === 'taskboard') this._addTaskItem(agent, now);
        // Subagent transitions now manifest as Portal summon rituals (handled
        // by RitualConductor); suppress the duplicate Command Center SUMMON
        // stub here.
        if (agent.currentTool === 'Task' || agent.currentTool === 'Agent') return;
        if (building === 'command' || isCommandTool(agent)) this._addCommandItem(agent, now);
    }

    _observeArchiveReadActivity(agent, now) {
        const tool = agent?.currentTool;
        if (!tool || !ARCHIVE_READ_TOOLS.has(tool)) return;
        // Dedupe per (agent, sessionActivity, tool, toolInput) so a held
        // snapshot doesn't bump the counter every frame.
        const key = [
            agent.id || 'unknown',
            tool,
            agent.currentToolInput || agent.lastToolInput || '',
            agent.lastSessionActivity || '',
        ].join('|');
        if (this._archiveReadSeen.has(key)) return;
        this._archiveReadSeen.add(key);
        if (this._archiveReadSeen.size > 240) {
            this._archiveReadSeen = new Set([...this._archiveReadSeen].slice(-160));
        }
        this._archiveReadCounter.count += 1;
        this._archiveReadCounter.lastInvocationTs = now;
        this._recencyByType.set('archive', now);
    }

    _decayArchiveReadCounter(dt) {
        const count = this._archiveReadCounter.count;
        if (count <= 0) return;
        const seconds = Math.max(0, Number(dt) || 0) / 1000;
        if (seconds <= 0) return;
        const next = count * Math.exp(-seconds / ARCHIVE_READ_DECAY_HALFLIFE_S);
        this._archiveReadCounter.count = next < 0.01 ? 0 : next;
    }

    getArchiveReadIntensity() {
        const count = this._archiveReadCounter.count || 0;
        if (count <= 0) return 0;
        return Math.max(0, Math.min(1, count / ARCHIVE_READ_FULL_INTENSITY_COUNT));
    }

    // ── 4.3 The Mine assay bench ────────────────────────────────────────────
    //
    // One bounded record per observed session. Everything here is a difference
    // between two consecutive observations of the *same* session: a first
    // observation is a baseline, a counter that went backwards is a reset, and
    // a provider that reports no usage split at all never enters the window.
    _observeAssay(agent, now) {
        if (!agent?.id) return;
        const classes = tokenClassTotals(agent);
        let record = this._assayByAgent.get(agent.id);
        if (!record) {
            record = {
                project: assayProjectKey(agent),
                input: createRing(ASSAY_BUCKETS),
                cacheRead: createRing(ASSAY_BUCKETS),
                lastInput: null,
                lastCacheRead: null,
                available: classes.available,
                coveredFrom: null,
                cost: {
                    ring: createRing(ASSAY_BUCKETS),
                    lastUsd: null,
                    provenance: null,
                    source: null,
                    gapAt: null,
                    coveredFrom: null,
                },
            };
            this._assayByAgent.set(agent.id, record);
        }
        record.project = assayProjectKey(agent);
        record.available = classes.available;

        if (!classes.available) {
            // Unknown is not zero: the class buckets stop and the tray says so.
            record.lastInput = null;
            record.lastCacheRead = null;
            record.coveredFrom = null;
        } else if (record.lastInput === null || record.lastCacheRead === null) {
            record.lastInput = classes.input;
            record.lastCacheRead = classes.cacheRead;
            record.coveredFrom = now;
        } else {
            const inputDelta = classes.input - record.lastInput;
            const cacheDelta = classes.cacheRead - record.lastCacheRead;
            if (inputDelta < 0 || cacheDelta < 0) {
                // Counter reset: the retained buckets belong to a series that
                // no longer exists, so coverage restarts here.
                ringClear(record.input);
                ringClear(record.cacheRead);
                record.coveredFrom = now;
            } else {
                ringAdd(record.input, now, inputDelta);
                ringAdd(record.cacheRead, now, cacheDelta);
            }
            record.lastInput = classes.input;
            record.lastCacheRead = classes.cacheRead;
        }

        this._observeAssayCost(agent, record, now);
    }

    _observeAssayCost(agent, record, now) {
        const cost = agent.cost || null;
        const window = record.cost;
        const usd = Number(cost?.usd);
        const fresh = resolveObservation(agent, now).state === 'fresh';
        const provenance = costProvenanceOf(cost);
        if (!cost || cost.availability === 'unavailable' || !Number.isFinite(usd) || !fresh) {
            // An unfresh or unpriced observation ends the series without
            // claiming anything about the interval it covered.
            window.lastUsd = null;
            window.coveredFrom = null;
            window.provenance = provenance;
            window.source = cost?.source || null;
            return;
        }
        if (window.provenance !== provenance) {
            // Provenance or pricing revision changed: the window restarts and
            // the discontinuity is disclosed rather than absorbed.
            if (window.provenance !== null) window.gapAt = now;
            ringClear(window.ring);
            window.provenance = provenance;
            window.lastUsd = usd;
            window.coveredFrom = now;
            window.source = cost.source;
            return;
        }
        window.source = cost.source;
        if (window.lastUsd === null) {
            window.lastUsd = usd;
            window.coveredFrom = now;
            return;
        }
        const delta = usd - window.lastUsd;
        window.lastUsd = usd;
        if (delta < 0) {
            ringClear(window.ring);
            window.gapAt = now;
            window.coveredFrom = now;
            return;
        }
        ringAdd(window.ring, now, delta);
    }

    // The bench's reported state. Scope is the selected session's project when
    // there is one, and an explicitly labelled aggregate otherwise; at a
    // hundred sessions this stays two sums, a stamp count, and one breakdown.
    getMineAssay(now = Date.now()) {
        const project = this._selectedProject || null;
        let input = 0;
        let cacheRead = 0;
        let covered = 0;
        let unknown = 0;
        let usd = 0;
        let costCovered = 0;
        let missing = 0;
        let gap = false;
        const stamps = [];
        for (const record of this._assayByAgent.values()) {
            if (project && record.project !== project) continue;
            if (record.available && record.coveredFrom !== null) {
                covered += 1;
                input += ringSum(record.input, now);
                cacheRead += ringSum(record.cacheRead, now);
            } else {
                unknown += 1;
            }
            const window = record.cost;
            const windowGap = window.gapAt !== null && now - window.gapAt < ASSAY_BUCKETS * 1000;
            if (windowGap) gap = true;
            if (window.coveredFrom === null || windowGap) {
                missing += 1;
                continue;
            }
            costCovered += 1;
            usd += ringSum(window.ring, now);
            if (stamps.length < ASSAY_COST_STAMP_LIMIT) {
                stamps.push(window.source === 'provider' ? 'provider' : 'estimate');
            }
        }
        const sessions = covered + unknown;
        const coverage = costCovered === 0 ? 'none' : (gap || missing > 0) ? 'insufficient' : 'ok';
        return {
            project,
            sessions,
            tokens: {
                input: covered > 0 ? input : null,
                cacheRead: covered > 0 ? cacheRead : null,
                unknown,
                covered,
                label: covered > 0
                    ? `${formatExactCount(input)} input · ${formatExactCount(cacheRead)} cache read · observed last 60s`
                    : 'input unknown · cache read unknown · observed last 60s',
            },
            cost: {
                usd: costCovered > 0 ? usd : null,
                coverage,
                missing,
                covered: costCovered,
                stamps,
                stampOverflow: Math.max(0, costCovered - stamps.length),
                label: costCovered > 0
                    ? `${formatWindowUsd(usd)} / last min`
                    : 'insufficient coverage',
                note: missing > 0
                    ? `${missing} session${missing === 1 ? '' : 's'} uncovered`
                    : '',
            },
        };
    }

    // ── 4.4 The Forge workload ──────────────────────────────────────────────
    //
    // `tool:invoked` is already one event per new invocation identity; the
    // extra key here keeps a re-emitted snapshot from counting twice. Only the
    // canonical classifier decides what belongs to the Forge, and only its
    // file-mutation reasons count: an inspection or a shell run is not an edit
    // call, and an edit call is not a successful edit.
    _observeForgeEditCall(event) {
        if (this._disposed) return;
        if (event?.building !== 'forge') return;
        if (!FORGE_EDIT_REASONS.has(event?.reason)) return;
        const at = Number(event.ts);
        const now = Number.isFinite(at) ? at : Date.now();
        const key = [event.agentId || 'unknown', event.tool || '', event.input || '', now].join('|');
        if (this._forgeEditSeen.has(key)) return;
        this._forgeEditSeen.add(key);
        if (this._forgeEditSeen.size > 240) {
            this._forgeEditSeen = new Set([...this._forgeEditSeen].slice(-160));
        }
        ringAdd(this._forgeEditRing, now, 1);
        this._lastForgeEditAt = Math.max(this._lastForgeEditAt, now);
        this._recencyByType.set('forge', now);
    }

    getForgeWorkload(now = Date.now()) {
        const editCalls = Math.round(ringSum(this._forgeEditRing, now));
        let tier = 0;
        for (const threshold of FORGE_BILLET_THRESHOLDS) {
            if (editCalls >= threshold) tier += 1;
        }
        const observedFor = Math.max(0, now - this._forgeObservingSince);
        const idleMs = this._lastForgeEditAt ? Math.max(0, now - this._lastForgeEditAt) : observedFor;
        return {
            editCalls,
            tier,
            idleMs,
            // Only a workshop we have actually watched fall quiet banks its
            // hearth; an unobserved one keeps the shipped treatment.
            banked: observedFor >= FORGE_BANK_IDLE_MS && idleMs >= FORGE_BANK_IDLE_MS,
            label: `${formatExactCount(editCalls)} edit call${editCalls === 1 ? '' : 's'} · last 60s`,
        };
    }

    _observeTokens(agent, now) {
        if (!agent?.id) return;
        const current = tokenTotal(agent);
        const currentClasses = tokenClassTotals(agent);
        const previous = this.previousTokenTotals.get(agent.id);
        const previousClasses = this.previousTokenClassTotals.get(agent.id);
        this.previousTokenTotals.set(agent.id, current);
        this.previousTokenClassTotals.set(agent.id, currentClasses);
        if (previous == null || !previousClasses || current <= previous) return;
        const delta = current - previous;
        if (currentClasses.cacheRead < previousClasses.cacheRead || currentClasses.input < previousClasses.input) return;
        if (delta < 128) return;
        const cargo = cargoFromTokenBeat(currentClasses, previousClasses, delta);
        if (delta >= RITUAL_TOKEN_DELTA_THRESHOLD) {
            eventBus.emit('tool:invoked', {
                agentId: agent.id,
                tool: '__token_delta',
                input: delta,
                building: 'mine',
                ts: now,
                cargo,
            });
            return;
        }
        const id = `token:${agent.id}:${agent.lastSessionActivity || now}:${Math.round(current / 128)}`;
        if (this.items.has(id)) return;
        this.items.set(id, {
            id,
            type: 'token',
            building: 'mine',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + TOKEN_ITEM_TTL_MS,
            delta,
            cargo,
            slot: stableHash(id) % BUILDING_OFFSETS.mine.length,
            sortOffset: 4,
        });
        this._recencyByType.set('mine', now);
        this._capKind('token', MAX_ITEMS_PER_KIND, id);
    }

    _observeCommandRelationships(agents, now) {
        const byId = new Map();
        for (const sprite of this.agentSprites) {
            if (sprite?.agent?.id) byId.set(sprite.agent.id, sprite);
        }

        for (const agent of agents) {
            if (!agent?.parentSessionId) continue;
            if (Number.isFinite(agent.activityAgeMs) && agent.activityAgeMs > COMMAND_ITEM_TTL_MS) continue;
            const sprite = byId.get(agent.id);
            if (!sprite) continue;
            const id = `dispatch-line:${agent.parentSessionId}:${agent.id}:${agent.lastSessionActivity || 'live'}`;
            if (this.seenSnapshots.has(id)) continue;
            this.seenSnapshots.add(id);
            const command = this._buildingCenter('command');
            if (!command) continue;
            this.items.set(id, {
                id,
                type: 'dispatch-line',
                building: 'command',
                createdAt: now,
                expiresAt: now + 3500,
                startX: command.x,
                startY: command.y - 68,
                endX: sprite.x,
                endY: sprite.y - 42,
                label: 'SUB',
                sortOffset: -80,
            });
            this._capKind('dispatch-line', MAX_ITEMS_PER_KIND, id);
        }

        for (const sprite of this.agentSprites) {
            if (!sprite?.agent) continue;
            const agent = sprite.agent;
            if (agent.currentTool === 'SendMessage' && sprite.chatPartner) {
                const id = `chat-line:${agent.id}:${sprite.chatPartner.agent?.id || 'target'}`;
                const activityStamp = agent.lastSessionActivity || null;
                const existing = this.items.get(id);
                if (existing) {
                    // Track moving sprites and keep the item alive without
                    // resetting createdAt, so fade-in happens once and the
                    // message-age fade is measured from real activity.
                    existing.expiresAt = now + 2500;
                    existing.startX = sprite.x;
                    existing.startY = sprite.y - 48;
                    existing.endX = sprite.chatPartner.x;
                    existing.endY = sprite.chatPartner.y - 48;
                    if (activityStamp && activityStamp !== existing.activityStamp) {
                        existing.activityStamp = activityStamp;
                        existing.messageAt = now;
                    }
                } else {
                    this.items.set(id, {
                        id,
                        type: 'chat-line',
                        building: 'command',
                        createdAt: now,
                        expiresAt: now + 2500,
                        messageAt: now,
                        activityStamp,
                        startX: sprite.x,
                        startY: sprite.y - 48,
                        endX: sprite.chatPartner.x,
                        endY: sprite.chatPartner.y - 48,
                        color: providerColor(agent.provider),
                        label: 'MSG',
                        sortOffset: -60,
                    });
                }
            }
        }
    }

    _addForgeItem(agent, now) {
        const id = activityKey(agent, 'forge');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.forge.length;
        this.items.set(id, {
            id,
            type: 'forge',
            building: 'forge',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + SNAPSHOT_TTL_MS,
            slot,
            label: compactToolLabel(agent.currentToolInput, TOOL_LABELS.forge, 10),
            sortOffset: 6,
        });
        this.lastForgeByAgent.set(agent.id, { id, at: now });
        this._recencyByType.set('forge', now);
        this._capKind('forge', MAX_ITEMS_PER_KIND, id);
    }

    _addTaskItem(agent, now) {
        const id = activityKey(agent, 'task');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.taskboard.length;
        this.items.set(id, {
            id,
            type: 'task',
            building: 'taskboard',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + SNAPSHOT_TTL_MS,
            slot,
            label: isTaskCommand(agent) ? 'VERIFY' : compactToolLabel(agent.currentTool, TOOL_LABELS.taskboard, 10),
            isCheck: isTaskCommand(agent),
            sortOffset: 5,
        });
        const forge = this.lastForgeByAgent.get(agent.id);
        if (forge && now - forge.at <= FORGE_HANDOFF_WINDOW_MS) {
            const handoffId = `handoff:${agent.id}:${forge.id}:${id}`;
            this.items.set(handoffId, {
                id: handoffId,
                type: 'handoff',
                building: 'forge',
                agentId: agent.id,
                createdAt: now,
                expiresAt: now + 14000,
                label: 'READY',
                sortOffset: 2,
            });
        }
        this._recencyByType.set('taskboard', now);
        this._capKind('task', MAX_ITEMS_PER_KIND, id);
    }

    _addCommandItem(agent, now) {
        const id = activityKey(agent, 'command');
        if (this.seenSnapshots.has(id)) return;
        this.seenSnapshots.add(id);
        const slot = stableHash(id) % BUILDING_OFFSETS.command.length;
        this.items.set(id, {
            id,
            type: 'command',
            building: 'command',
            agentId: agent.id,
            createdAt: now,
            expiresAt: now + COMMAND_ITEM_TTL_MS,
            slot,
            label: commandActivityLabel(agent),
            sortOffset: -2,
        });
        this._recencyByType.set('command', now);
        this._capKind('command', MAX_ITEMS_PER_KIND, id);
    }

    _expireItems(now) {
        for (const [id, item] of this.items) {
            if (item.expiresAt <= now) this.items.delete(id);
        }
        if (this.seenSnapshots.size > 400) {
            this.seenSnapshots = new Set([...this.seenSnapshots].slice(-240));
        }
    }

    _capKind(type, max, addedId = null) {
        let ids = this._kindIds.get(type);
        if (!ids) {
            ids = [];
            this._kindIds.set(type, ids);
        }
        if (addedId && (ids.length === 0 || ids[ids.length - 1] !== addedId)) {
            ids.push(addedId);
        }
        while (ids.length && !this.items.has(ids[0])) {
            ids.shift();
        }
        while (ids.length > max) {
            const oldest = ids.shift();
            if (oldest) this.items.delete(oldest);
        }
    }

    _refreshBuildingCounts() {
        this._countByType.clear();
        const buildings = this.world?.buildings;
        if (!buildings || typeof buildings.values !== 'function') return;
        for (const sprite of this.agentSprites) {
            if (!sprite?.agent) continue;
            if (!Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
            const tile = worldToTile(sprite.x, sprite.y);
            const positionedAgent = { ...sprite.agent, position: tile };
            for (const building of buildings.values()) {
                if (!building?.type) continue;
                const visiting = typeof building.isAgentVisiting === 'function'
                    ? building.isAgentVisiting(positionedAgent)
                    : building.containsPoint(tile.tileX, tile.tileY);
                if (visiting) {
                    this._countByType.set(building.type, (this._countByType.get(building.type) || 0) + 1);
                }
            }
        }
    }

    _recencyScore(type, now) {
        const last = this._recencyByType.get(type);
        if (!last) return 0;
        const age = now - last;
        if (age <= 0) return 1;
        if (age >= PRESENCE_RECENCY_MS) return 0;
        return 1 - age / PRESENCE_RECENCY_MS;
    }

    _capacityWork(type) {
        const cap = this.world?.buildings?.get(type)?.capacity?.work;
        return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
    }

    _tier(count, recencyScore, capacityWork) {
        if (count >= capacityWork) return 'busy';
        if (count > 0) return 'occupied';
        if (recencyScore >= PRESENCE_DORMANT_THRESHOLD) return 'occupied';
        return 'dormant';
    }

    getBuildingPresence(type, now = Date.now()) {
        const count = this._countByType.get(type) || 0;
        const recencyScore = this._recencyScore(type, now);
        const tier = this._tier(count, recencyScore, this._capacityWork(type));
        return { count, recencyScore, tier };
    }

    _maybeEmitPresence(now) {
        if (now - this._lastPresenceEmit < PRESENCE_EMIT_INTERVAL_MS) return;
        this._lastPresenceEmit = now;
        const buildings = this.world?.buildings;
        if (!buildings || typeof buildings.values !== 'function') return;
        const payload = {};
        for (const building of buildings.values()) {
            if (!building?.type) continue;
            payload[building.type] = this.getBuildingPresence(building.type, now);
        }
        eventBus.emit('building:active-agents', payload);
        // Surface Archive read intensity so BuildingSprite can tier the
        // front-window overlay and door particle spawn rate without coupling.
        eventBus.emit('building:read-intensity', { archive: this.getArchiveReadIntensity() });
        // 4.3 / 4.4 — the two work ledgers the buildings read. Same cadence,
        // same one-way coupling: the reducer measures, the sprite draws.
        eventBus.emit('building:mine-assay', this.getMineAssay(now));
        eventBus.emit('building:forge-workload', this.getForgeWorkload(now));
    }

    _itemPosition(item, now) {
        if (item.type === 'handoff') {
            const start = this._buildingCenter('forge');
            const end = this._buildingCenter('taskboard');
            if (!start || !end) return null;
            const progress = this.motionScale === 0
                ? 1
                : Math.max(0, Math.min(1, (now - item.createdAt) / 9000));
            const eased = 1 - Math.pow(1 - progress, 3);
            return {
                x: start.x + (end.x - start.x) * eased,
                y: start.y - 34 + (end.y - start.y) * eased,
                progress,
            };
        }

        const center = this._buildingCenter(item.building);
        if (!center) return null;
        const offsets = BUILDING_OFFSETS[item.building] || [{ x: 0, y: -32 }];
        const offset = offsets[item.slot % offsets.length] || offsets[0];
        const age = now - item.createdAt;
        const bob = this.motionScale ? Math.sin(this.frame * 0.09 + item.slot) * 2 : 0;
        const settle = this.motionScale ? Math.min(1, age / 700) : 1;
        return {
            x: center.x + offset.x,
            y: center.y + offset.y - (1 - settle) * 10 + bob,
            progress: Math.max(0, Math.min(1, age / Math.max(1, item.expiresAt - item.createdAt))),
        };
    }

    _buildingCenter(type) {
        const building = this.world?.buildings?.get(type);
        if (!building) return null;
        const cx = building.position.tileX + building.width / 2;
        const cy = building.position.tileY + building.height / 2;
        return toWorld(cx, cy);
    }

    _itemAlpha(item, now) {
        const ttl = Math.max(1, item.expiresAt - item.createdAt);
        const age = Math.max(0, now - item.createdAt);
        const remaining = Math.max(0, item.expiresAt - now);
        const fadeIn = this.motionScale === 0 ? 1 : Math.min(1, age / 500);
        const fadeOut = Math.min(1, remaining / Math.min(1600, ttl));
        let alpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
        if (item.type === 'chat-line' && item.messageAt) {
            const messageAge = Math.max(0, now - item.messageAt);
            alpha *= Math.max(0, 1 - messageAge / CHAT_LINE_MESSAGE_FADE_MS);
        }
        return alpha;
    }

    _drawForgeItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = 'rgba(255, 137, 66, 0.28)';
        ctx.beginPath();
        ctx.ellipse(item.x, item.y + 4 * s, 20 * s, 10 * s, -0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f08a4b';
        ctx.strokeStyle = '#3d2517';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.moveTo(item.x - 12 * s, item.y - 4 * s);
        ctx.lineTo(item.x + 8 * s, item.y - 10 * s);
        ctx.lineTo(item.x + 16 * s, item.y);
        ctx.lineTo(item.x - 5 * s, item.y + 8 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 17 * s, s, '#ffd88a');
        ctx.restore();
    }

    _drawHandoffItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.48)';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        const start = this._buildingCenter('forge');
        const end = this._buildingCenter('taskboard');
        if (start && end) {
            ctx.beginPath();
            ctx.moveTo(start.x, start.y - 36);
            ctx.lineTo(end.x, end.y - 28);
            ctx.stroke();
        }
        ctx.fillStyle = '#8a5530';
        ctx.strokeStyle = '#2d1c12';
        ctx.fillRect(Math.round(item.x - 10 * s), Math.round(item.y - 10 * s), Math.round(20 * s), Math.round(14 * s));
        ctx.strokeRect(Math.round(item.x - 10 * s) + 0.5, Math.round(item.y - 10 * s) + 0.5, Math.round(20 * s), Math.round(14 * s));
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(Math.round(item.x - 2 * s), Math.round(item.y - 10 * s), Math.max(1, Math.round(4 * s)), Math.round(14 * s));
        ctx.restore();
    }

    _drawTaskItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = item.isCheck ? '#f2d36b' : '#e2c48a';
        ctx.strokeStyle = item.isCheck ? '#5f4321' : '#4a3420';
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(item.x - 13 * s), Math.round(item.y - 12 * s), Math.round(26 * s), Math.round(18 * s));
        ctx.strokeRect(Math.round(item.x - 13 * s) + 0.5, Math.round(item.y - 12 * s) + 0.5, Math.round(26 * s), Math.round(18 * s));
        ctx.strokeStyle = 'rgba(68, 44, 24, 0.55)';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(item.x - 8 * s, item.y - (6 - i * 5) * s);
            ctx.lineTo(item.x + 8 * s, item.y - (6 - i * 5) * s);
            ctx.stroke();
        }
        if (item.isCheck) {
            ctx.strokeStyle = '#2c6b45';
            ctx.lineWidth = Math.max(1, Math.round(2 * s));
            ctx.beginPath();
            ctx.moveTo(item.x - 5 * s, item.y + 8 * s);
            ctx.lineTo(item.x - 1 * s, item.y + 12 * s);
            ctx.lineTo(item.x + 8 * s, item.y + 2 * s);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawChatItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.fillStyle = '#f4d28b';
        ctx.strokeStyle = '#50351e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(item.x - 14 * s, item.y - 8 * s);
        ctx.lineTo(item.x + 14 * s, item.y - 8 * s);
        ctx.lineTo(item.x + 11 * s, item.y + 9 * s);
        ctx.lineTo(item.x - 11 * s, item.y + 9 * s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(80, 53, 30, 0.65)';
        ctx.beginPath();
        ctx.moveTo(item.x - 13 * s, item.y - 7 * s);
        ctx.lineTo(item.x, item.y + 1 * s);
        ctx.lineTo(item.x + 13 * s, item.y - 7 * s);
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 18 * s, s, '#ffeb8f');
        ctx.restore();
    }

    _drawTokenItem(ctx, item, zoom) {
        const actualZoom = Math.max(0, Number(zoom) || 1);
        const s = 1 / Math.max(1, actualZoom);
        const cargo = item.cargo || null;
        const ratio = cargo ? Math.max(0, Math.min(1, cargo.ratio)) : null;
        const fill = Math.max(0.18, Math.min(1, item.delta / 40000));
        ctx.save();
        ctx.globalAlpha = item.alpha;
        if (this.sprites?.assets?.get('prop.oreCart')) {
            this.sprites.drawSprite(ctx, 'prop.oreCart', item.x, item.y);
        } else {
            ctx.fillStyle = '#5a3927';
            ctx.fillRect(Math.round(item.x - 15 * s), Math.round(item.y - 10 * s), Math.round(30 * s), Math.round(14 * s));
        }
        ctx.globalAlpha = item.alpha * (0.28 + fill * 0.62);
        ctx.fillStyle = cargo ? mixHex(CACHE_CARGO_ORE, CACHE_CARGO_CRYSTAL, ratio) : '#f2d36b';
        ctx.beginPath();
        ctx.ellipse(item.x, item.y - 15 * s, (10 + fill * 8) * s, (5 + fill * 3) * s, -0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = item.alpha;
        if (cargo && actualZoom >= 1) this._drawTokenCargoHeap(ctx, item.x, item.y, s, ratio);
        // No percentage on the Mine: the crystal/ore mix carries the class
        // split, and the exact counts live on the selected bench (4.3).
        ctx.restore();
    }

    _drawTokenCargoHeap(ctx, x, y, s, ratio) {
        const bucket = Math.round(Math.max(0, Math.min(1, ratio)) * 8) / 8;
        const crystalSlots = Math.round(6 * bucket);
        for (let i = 0; i < 6; i++) {
            const row = i < 3 ? 0 : 1;
            const col = i % 3;
            const px = x + (col - 1) * 7 * s + row * 3 * s;
            const py = y - (12 + row * 6) * s;
            const crystal = i < crystalSlots;
            const palette = crystal ? CACHE_CARGO_CRYSTAL_COLORS : CACHE_CARGO_ORE_COLORS;
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = palette[i % palette.length];
            ctx.strokeStyle = crystal ? '#e6f8ff' : '#7e6a50';
            ctx.lineWidth = Math.max(0.7, s);
            ctx.beginPath();
            if (crystal) {
                ctx.moveTo(px, py - 4 * s);
                ctx.lineTo(px + 4 * s, py);
                ctx.lineTo(px, py + 4 * s);
                ctx.lineTo(px - 4 * s, py);
            } else {
                ctx.moveTo(px - 4 * s, py + 2 * s);
                ctx.lineTo(px - 2 * s, py - 3 * s);
                ctx.lineTo(px + 3 * s, py - 4 * s);
                ctx.lineTo(px + 5 * s, py + 2 * s);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            if (crystal) {
                ctx.globalCompositeOperation = 'screen';
                ctx.fillStyle = '#e6f8ff';
                ctx.fillRect(Math.round(px - s), Math.round(py - 3 * s), Math.max(1, Math.round(s)), Math.max(1, Math.round(2 * s)));
            }
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawCommandItem(ctx, item, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale ? 0.65 + Math.sin(this.frame * 0.12 + item.slot) * 0.22 : 0.72;
        ctx.save();
        ctx.globalAlpha = item.alpha;
        ctx.strokeStyle = `rgba(246, 200, 95, ${pulse})`;
        ctx.fillStyle = 'rgba(87, 48, 25, 0.88)';
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.ellipse(item.x, item.y, 20 * s, 9 * s, -0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(item.x - 9 * s, item.y - 2 * s);
        ctx.lineTo(item.x, item.y - 11 * s);
        ctx.lineTo(item.x + 9 * s, item.y - 2 * s);
        ctx.stroke();
        this._drawTinyLabel(ctx, item, item.x, item.y - 22 * s, s, '#ffe7a3');
        ctx.restore();
    }

    _drawConnection(ctx, item, color, zoom, { arrow = false, alphaScale = 0.82 } = {}) {
        const s = 1 / Math.max(1, zoom || 1);
        ctx.save();
        ctx.globalAlpha = item.alpha * alphaScale;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.setLineDash([Math.max(3, 6 * s), Math.max(2, 4 * s)]);
        ctx.lineDashOffset = this.motionScale ? -this.frame * 0.55 : 0;
        ctx.beginPath();
        const mx = (item.startX + item.endX) / 2;
        const my = Math.min(item.startY, item.endY) - 24 * s;
        ctx.moveTo(item.startX, item.startY);
        ctx.quadraticCurveTo(mx, my, item.endX, item.endY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.beginPath();
        if (arrow) {
            // Arrowhead aligned with the curve tangent at the recipient end
            // (end minus control point), pointing sender → recipient.
            const angle = Math.atan2(item.endY - my, item.endX - mx);
            const ah = 7 * s;
            ctx.moveTo(item.endX, item.endY);
            ctx.lineTo(item.endX - ah * Math.cos(angle - 0.45), item.endY - ah * Math.sin(angle - 0.45));
            ctx.lineTo(item.endX - ah * Math.cos(angle + 0.45), item.endY - ah * Math.sin(angle + 0.45));
            ctx.closePath();
        } else {
            ctx.arc(item.endX, item.endY, 3 * s, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.restore();
    }

    _drawTinyLabel(ctx, item, x, y, s, color) {
        const label = String(item.label || '').toUpperCase();
        if (!label) return;
        ctx.font = `${Math.max(5, Math.round(6 * s))}px ${WORLD_BODY_FONT}`;
        const width = Math.min(64 * s, Math.max(22 * s, ctx.measureText(label).width + 8 * s));
        ctx.fillStyle = 'rgba(38, 26, 16, 0.86)';
        ctx.fillRect(Math.round(x - width / 2), Math.round(y - 6 * s), Math.round(width), Math.round(11 * s));
        ctx.strokeStyle = color;
        ctx.strokeRect(Math.round(x - width / 2) + 0.5, Math.round(y - 6 * s) + 0.5, Math.round(width) - 1, Math.round(11 * s) - 1);
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label.slice(0, 10), Math.round(x), Math.round(y));
    }
}
