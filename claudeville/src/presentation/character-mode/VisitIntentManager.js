import { classifyTool, compactToolLabel as compactLabel } from '../../domain/services/ToolIdentity.js';
import { normalizeGitEvent, parseEventTime } from '../shared/GitEventIdentity.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    clampRouteIndex,
    cloneItinerary,
    inferGoal,
    normalizeGoal,
    normalizeItineraryRoute,
    normalizeRouteStop,
    normalizeWorkingPhase,
    WORK_ITINERARY_PHASE_INDEX,
    WORK_ITINERARY_ROUTE,
} from './VisitIntentSemantics.js';

const CASH_OUT_TOKEN_DELTA = 1024;
const CASH_OUT_PRIORITY = 95;
const CASH_OUT_TTL_MS = 8000;
const CASH_OUT_STICKY_MS = 8000;
const QUOTA_THROTTLE_PRIORITY = 20;
const QUOTA_THROTTLE_WINDOW_MS = 60000;
const QUOTA_THROTTLE_CLEAR_RATIO = 0.7;
const TEAM_GATHER_PRIORITY = 70;
const TEAM_GATHER_TTL_MS = 30000;
const TEAM_GATHER_STICKY_MS = 30000;

const DEFAULT_TTLS = Object.freeze({
    chat: { priority: 100, ttlMs: 30000, stickyMs: 30000 },
    alert: { priority: 90, ttlMs: 45000, stickyMs: 10000 },
    git: { priority: 85, ttlMs: 90000, stickyMs: 20000 },
    handoff: { priority: 82, ttlMs: 45000, stickyMs: 12000 },
    tool: { priority: 80, ttlMs: 30000, stickyMs: 8000 },
    token: { priority: 65, ttlMs: 25000, stickyMs: 8000 },
    team: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    subagent: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    quota: { priority: 50, ttlMs: 60000, stickyMs: 10000 },
    ambient: { priority: 10, ttlMs: 20000, stickyMs: 0 },
});

const TOKEN_DELTA_THRESHOLD = 128;
const CONTEXT_PRESSURE_THRESHOLD = 0.82;
const MAX_SEEN_GIT_EVENTS = 600;
const MAX_PENDING_GATHERS = 64;

function timeNow() {
    return Date.now();
}

function agentListFrom(input, world = null) {
    const source = input || world?.agents || [];
    if (source?.values) return Array.from(source.values());
    if (Array.isArray(source)) return source;
    if (source && typeof source[Symbol.iterator] === 'function') return Array.from(source);
    return [];
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
    const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
    const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
    const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
    return input + output + cacheRead + cacheCreate;
}

function contextRatio(agent) {
    const tokens = agent?.tokens || {};
    const current = Number(tokens.contextWindow ?? 0) || 0;
    const max = Number(tokens.contextWindowMax ?? 0) || 0;
    if (current <= 0 || max <= 0) return 0;
    return Math.max(0, Math.min(1, current / max));
}

function intentSort(a, b, now) {
    const aSticky = a.stickyUntil > now ? 1 : 0;
    const bSticky = b.stickyUntil > now ? 1 : 0;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (aSticky !== bSticky) return bSticky - aSticky;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return b.createdAt - a.createdAt;
}

function stringifyToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try {
        return JSON.stringify(input);
    } catch {
        return String(input);
    }
}

function phaseFromToolClassification(tool, input, classified) {
    const building = String(classified?.building || '').toLowerCase();
    const text = [
        tool,
        stringifyToolInput(input),
        classified?.reason,
        classified?.label,
        building,
    ].join(' ').toLowerCase();

    if (building === 'harbor' || /\b(git\s+\w+|gh\s+\w+|commit|push|pull|merge|rebase|checkout)\b/.test(text)) return 'git';
    if (building === 'mine' || /\b(quota|token|context|usage|throttle|rate.?limit|resource)\b/.test(text)) return 'quota/resource';
    if (/\b(test|spec|pytest|jest|vitest|playwright|check|lint|typecheck|validate|verification)\b/.test(text)) return 'testing';
    if (building === 'forge' || /\b(edit|write|patch|apply_patch|modify|refactor|generate|create|delete|rename|move|format)\b/.test(text)) return 'editing';
    if (building === 'observatory' || building === 'portal' || /\b(web|browser|browse|fetch|curl|research|search_query|image_query|lookup)\b/.test(text)) return 'researching';
    if (building === 'archive' || /\b(read|grep|rg|find|cat|sed|open|inspect|scan|list|ls|view)\b/.test(text)) return 'reading';
    if (building === 'command' || building === 'taskboard' || /\b(spawn|agent|parallel|multi_tool|todo|task|plan|handoff|coordinate|delegate|wait|resume)\b/.test(text)) return 'coordinating';
    return 'coordinating';
}

function phaseFromIntentDraft(draft) {
    const explicit = normalizeWorkingPhase(draft?.phase || draft?.workingPhase);
    if (explicit) return explicit;
    const source = String(draft?.source || '').toLowerCase();
    const building = String(draft?.building || '').toLowerCase();
    const reason = String(draft?.reason || '').toLowerCase();
    if (source === 'git' || building === 'harbor') return 'git';
    if (source === 'quota' || source === 'token' || building === 'mine') return 'quota/resource';
    if (source === 'handoff' || source === 'team' || source === 'subagent') return 'coordinating';
    if (source === 'alert' && reason.includes('wait')) return 'waiting';
    if (building === 'archive') return 'reading';
    if (building === 'forge') return 'editing';
    if (building === 'observatory' || building === 'portal') return 'researching';
    if (building === 'taskboard') return 'testing';
    return 'coordinating';
}

function interruptibleForIntentDraft(draft, priority, phase) {
    if (draft?.interruptible === false) return false;
    if (draft?.interruptible === true) return true;
    const source = String(draft?.source || '').toLowerCase();
    if (source === 'ambient') return true;
    if (phase === 'waiting') return true;
    if (source === 'alert' || source === 'git') return false;
    return priority < 85;
}

function goalFromIntentDraft(draft, phase) {
    const explicit = normalizeGoal(draft?.goal || draft?.intentGoal || draft?.payload?.goal);
    if (explicit) return explicit;
    return inferGoal({
        source: draft?.source,
        reason: draft?.reason,
        phase,
        building: draft?.building,
        parentId: draft?.payload?.parentId,
    }) || 'complete-task';
}

function itineraryFromIntentDraft(draft, { phase, goal, intentId, previous = null, now } = {}) {
    const raw = draft?.itinerary || draft?.payload?.itinerary || null;
    const explicitRoute = normalizeItineraryRoute(raw);
    if (explicitRoute.length) {
        const building = normalizeRouteStop(draft?.building);
        let currentIndex = clampRouteIndex(raw?.currentIndex ?? raw?.stepIndex ?? raw?.index, explicitRoute);
        if (currentIndex < 0 && building) currentIndex = explicitRoute.indexOf(building);
        if (currentIndex < 0 && phase && WORK_ITINERARY_PHASE_INDEX[phase] != null) {
            currentIndex = clampRouteIndex(WORK_ITINERARY_PHASE_INDEX[phase], explicitRoute);
        }
        if (currentIndex < 0) currentIndex = 0;
        return {
            id: raw?.id || intentId || null,
            label: raw?.label || '',
            goal: normalizeGoal(raw?.goal || goal) || goal || null,
            route: explicitRoute,
            currentIndex,
            currentStop: explicitRoute[currentIndex] || building || null,
            nextStop: explicitRoute[currentIndex + 1] || null,
            source: draft?.source || null,
            reason: draft?.reason || null,
            updatedAt: now,
            inferred: !!raw?.inferred,
        };
    }

    const stepIndex = WORK_ITINERARY_PHASE_INDEX[phase];
    const source = String(draft?.source || '').toLowerCase();
    if (stepIndex == null || !['tool', 'handoff', 'git'].includes(source)) {
        return previous?.itinerary ? cloneItinerary(previous.itinerary) : null;
    }
    return {
        id: `work-cycle:${intentId || draft?.sourceKey || draft?.building || 'intent'}`,
        label: 'Work cycle',
        goal,
        route: [...WORK_ITINERARY_ROUTE],
        currentIndex: stepIndex,
        currentStop: WORK_ITINERARY_ROUTE[stepIndex] || null,
        nextStop: WORK_ITINERARY_ROUTE[stepIndex + 1] || null,
        source: draft?.source || null,
        reason: draft?.reason || null,
        updatedAt: now,
        inferred: true,
    };
}

export class VisitIntentManager {
    constructor({ world = null, now = null } = {}) {
        this.world = world;
        this.now = typeof now === 'function' ? now : timeNow;
        this.intentsByAgent = new Map();
        this.tokenSnapshots = new Map();
        this.seenGitEventIds = new Set();
        this.lastForgeByAgent = new Map();
        this.lastToolBuildingByAgent = new Map();
        this.throttleActiveUntil = 0;
        this.throttleAgents = new Set();
        this.pendingGathers = [];
        this._eventUnsubscribers = [];
        this._disposed = false;
        this._nextSeenGitEventIds = null;
        this._gitReplayByAgent = null;
        this._gitReplaySourceSnapshot = [];
        this._gitReplayCache = new Map();
        this._gitReplayStats = { hits: 0, misses: 0, normalized: 0, rawDuplicates: 0 };
        this._subscribeEventBus();
    }

    _subscribeEventBus() {
        this._eventUnsubscribers.push(eventBus.on('quota:throttled', (payload) => {
            const ts = Number(payload?.ts);
            const base = Number.isFinite(ts) ? ts : this.now();
            this.throttleActiveUntil = base + QUOTA_THROTTLE_WINDOW_MS;
        }));
        this._eventUnsubscribers.push(eventBus.on('usage:updated', (usage) => {
            const fiveHour = Number(usage?.quota?.fiveHour);
            if (Number.isFinite(fiveHour) && fiveHour < QUOTA_THROTTLE_CLEAR_RATIO) {
                this.throttleActiveUntil = 0;
            }
        }));
        this._eventUnsubscribers.push(eventBus.on('team:gather', (payload) => {
            if (!payload) return;
            this.pendingGathers.push(payload);
            if (this.pendingGathers.length > MAX_PENDING_GATHERS) {
                this.pendingGathers.splice(0, this.pendingGathers.length - MAX_PENDING_GATHERS);
            }
        }));
    }

    update(agents = null, now = this.now()) {
        if (this._disposed) return this.snapshot(now);
        const currentNow = Number.isFinite(Number(now)) ? Number(now) : this.now();
        this.reconcile(agents, currentNow);
        return this.snapshot(currentNow);
    }

    reconcile(agents = null, now = this.now()) {
        if (this._disposed) return this;
        const currentNow = Number.isFinite(Number(now)) ? Number(now) : this.now();
        const activeAgents = agentListFrom(agents, this.world);
        const activeIds = new Set();
        this._nextSeenGitEventIds = new Set();
        this._gitReplayByAgent = this._collectGitReplayWindow(activeAgents, currentNow);

        for (const agent of activeAgents) {
            if (!agent?.id) continue;
            activeIds.add(agent.id);
            this._deriveAgentIntents(agent, currentNow);
        }
        this._deriveGlobalIntents(activeAgents, currentNow);
        this._consumePendingGathers(activeAgents, currentNow);
        this._applyQuotaThrottle(activeAgents, currentNow);

        for (const agentId of Array.from(this.intentsByAgent.keys())) {
            if (!activeIds.has(agentId)) this.intentsByAgent.delete(agentId);
        }
        for (const agentId of Array.from(this.tokenSnapshots.keys())) {
            if (!activeIds.has(agentId)) this.tokenSnapshots.delete(agentId);
        }
        for (const agentId of Array.from(this.lastForgeByAgent.keys())) {
            if (!activeIds.has(agentId)) this.lastForgeByAgent.delete(agentId);
        }
        for (const agentId of Array.from(this.lastToolBuildingByAgent.keys())) {
            if (!activeIds.has(agentId)) this.lastToolBuildingByAgent.delete(agentId);
        }

        this.seenGitEventIds = this._nextSeenGitEventIds;
        this._nextSeenGitEventIds = null;
        this._gitReplayByAgent = null;
        this._expireIntents(currentNow);
        // Intents drive routing, phase, and itinerary only. They deliberately
        // no longer manufacture speech: villager dialogue comes from what the
        // model actually wrote (see adapters/dialogue.js).
        return this;
    }

    getIntentForAgent(agentId, now = this.now()) {
        const intents = [...(this.intentsByAgent.get(agentId)?.values() || [])]
            .filter((intent) => intent.expiresAt > now);
        if (!intents.length) return null;
        return intents.sort((a, b) => intentSort(a, b, now))[0] || null;
    }

    snapshot(now = this.now()) {
        const intents = [];
        for (const map of this.intentsByAgent.values()) {
            for (const intent of map.values()) {
                if (intent.expiresAt <= now) continue;
                intents.push({
                    ...intent,
                    itinerary: cloneItinerary(intent.itinerary),
                    msRemaining: Math.max(0, intent.expiresAt - now),
                });
            }
        }
        intents.sort((a, b) => (a.agentId || '').localeCompare(b.agentId || '') || intentSort(a, b, now));
        return {
            now,
            agents: this.intentsByAgent.size,
            intents,
            tokenSnapshots: [...this.tokenSnapshots.entries()].map(([agentId, total]) => ({ agentId, total })),
            seenGitEvents: this.seenGitEventIds.size,
            lastForgeAgents: this.lastForgeByAgent.size,
        };
    }

    debug(now = this.now()) {
        return this.snapshot(now);
    }

    debugSnapshot(now = this.now()) {
        return this.snapshot(now);
    }

    getDiagnostics() {
        let intentCount = 0;
        for (const intents of this.intentsByAgent.values()) intentCount += intents.size;
        return {
            agents: this.intentsByAgent.size,
            intents: intentCount,
            tokenSnapshots: this.tokenSnapshots.size,
            seenGitEvents: this.seenGitEventIds.size,
            seenGitEventLimit: MAX_SEEN_GIT_EVENTS,
            lastForgeAgents: this.lastForgeByAgent.size,
            lastToolAgents: this.lastToolBuildingByAgent.size,
            throttleAgents: this.throttleAgents.size,
            pendingGathers: this.pendingGathers.length,
            pendingGatherLimit: MAX_PENDING_GATHERS,
            disposed: this._disposed,
            gitReplayCacheHits: this._gitReplayStats.hits,
            gitReplayCacheMisses: this._gitReplayStats.misses,
            gitReplayNormalized: this._gitReplayStats.normalized,
            gitReplayRawDuplicates: this._gitReplayStats.rawDuplicates,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.intentsByAgent.clear();
        this.tokenSnapshots.clear();
        this.seenGitEventIds.clear();
        this.lastForgeByAgent.clear();
        this.lastToolBuildingByAgent.clear();
        this.throttleAgents.clear();
        this.pendingGathers.length = 0;
        this._nextSeenGitEventIds = null;
        this._gitReplayByAgent = null;
        this._gitReplaySourceSnapshot = [];
        this._gitReplayCache.clear();
        for (const unsubscribe of this._eventUnsubscribers.splice(0)) {
            unsubscribe?.();
        }
    }

    _deriveAgentIntents(agent, now) {
        this._deriveToolIntent(agent, now);
        this._deriveTokenIntents(agent, now);
        this._deriveGitIntents(agent, now);
        this._deriveRelationshipIntents(agent, now);
        this._deriveLongRunningIntents(agent, now);
    }

    _deriveToolIntent(agent, now) {
        const tool = agent.currentTool || null;
        if (!tool) return;
        if (String(agent.status || '').toLowerCase() !== 'working') return;
        const classified = classifyTool(tool, agent.currentToolInput ?? agent.lastToolInput);
        if (!classified?.building) return;
        const input = agent.currentToolInput ?? agent.lastToolInput;
        const phase = phaseFromToolClassification(tool, input, classified);
        this.lastToolBuildingByAgent.set(agent.id, {
            building: classified.building,
            reason: classified.reason,
            phase,
            at: now,
        });
        if (classified.building === 'forge' && /edit|write|patch|modify|refactor|generate|asset/i.test(classified.reason || '')) {
            this.lastForgeByAgent.set(agent.id, { at: now, label: classified.label || compactLabel(tool, 'forge') });
        }
        if (classified.building === 'taskboard') {
            const forge = this.lastForgeByAgent.get(agent.id);
            if (forge && now - forge.at <= 60000) {
                this._upsertIntent(agent.id, {
                    source: 'handoff',
                    sourceKey: `forge-taskboard:${Math.floor(forge.at / 1000)}`,
                    building: 'taskboard',
                    reason: 'validate-after-edit',
                    phase: 'testing',
                    confidence: 0.9,
                    label: forge.label || 'forge-check',
                    payload: { from: 'forge', to: 'taskboard', forgeAt: forge.at },
                }, now);
            }
        }

        this._upsertIntent(agent.id, {
            source: 'tool',
            sourceKey: [
                tool,
                JSON.stringify(agent.currentToolInput ?? ''),
                agent.lastSessionActivity || '',
            ].join('|'),
            building: classified.building,
            reason: classified.reason,
            phase,
            confidence: classified.confidence,
            label: classified.label || compactLabel(tool, 'tool'),
            payload: {
                tool,
                input: agent.currentToolInput ?? null,
                phase,
                sessionId: agent.sessionId || agent.agentId || agent.id,
            },
        }, now);
    }

    _deriveTokenIntents(agent, now) {
        const current = tokenTotal(agent);
        const previous = this.tokenSnapshots.get(agent.id);
        this.tokenSnapshots.set(agent.id, current);

        if (previous != null && current > previous) {
            const delta = current - previous;
            if (delta >= CASH_OUT_TOKEN_DELTA) {
                this._upsertIntent(agent.id, {
                    source: 'token',
                    sourceKey: `cash-out-${agent.id}-${now}`,
                    building: 'mine',
                    reason: 'cash-out',
                    phase: 'quota/resource',
                    confidence: 0.95,
                    priority: CASH_OUT_PRIORITY,
                    ttlMs: CASH_OUT_TTL_MS,
                    stickyMs: CASH_OUT_STICKY_MS,
                    label: `+${delta}`,
                    payload: { delta, total: current, ratio: contextRatio(agent) },
                }, now);
            } else if (delta >= TOKEN_DELTA_THRESHOLD) {
                this._upsertIntent(agent.id, {
                    source: 'token',
                    sourceKey: `${Math.floor(current / TOKEN_DELTA_THRESHOLD)}:${delta}`,
                    building: 'mine',
                    reason: 'token-delta',
                    phase: 'quota/resource',
                    confidence: Math.min(0.95, 0.55 + delta / 3000),
                    label: `+${delta}`,
                    payload: { delta, total: current, ratio: contextRatio(agent) },
                }, now);
            }
        }

        const ratio = contextRatio(agent);
        if (ratio >= CONTEXT_PRESSURE_THRESHOLD) {
            this._upsertIntent(agent.id, {
                source: 'quota',
                sourceKey: `context:${Math.floor(ratio * 100)}`,
                building: 'mine',
                reason: 'context-pressure',
                phase: 'quota/resource',
                confidence: Math.min(0.95, ratio),
                label: `${Math.round(ratio * 100)}%`,
                payload: { ratio, total: current },
            }, now);
        }
    }

    _deriveGitIntents(agent, now) {
        const replayEvents = this._gitReplayByAgent?.get(agent.id) || [];
        for (const { normalized, sourceKey } of replayEvents) {
            this._nextSeenGitEventIds?.add(sourceKey);
            const ageMs = Math.max(0, now - normalized.timestamp);
            const isFresh = ageMs < DEFAULT_TTLS.git.ttlMs && !this.seenGitEventIds.has(sourceKey);
            if (!isFresh) continue;
            this.seenGitEventIds.add(sourceKey);

            this._upsertIntent(agent.id, {
                source: 'git',
                sourceKey,
                building: 'harbor',
                reason: normalized.type === 'push'
                    ? 'push'
                    : (normalized.type === 'pull' || normalized.type === 'fetch' ? normalized.type : 'commit'),
                phase: 'git',
                confidence: normalized.type === 'push' ? 0.94 : 0.86,
                label: normalized.label,
                payload: normalized,
                createdAt: normalized.timestamp || now,
                expiresAt: normalized.timestamp + DEFAULT_TTLS.git.ttlMs,
                stickyUntil: normalized.timestamp + DEFAULT_TTLS.git.stickyMs,
            }, now);

            if (normalized.type === 'push' && normalized.status === 'failed') {
                this._upsertIntent(agent.id, {
                    source: 'alert',
                    sourceKey: `failed-push:${sourceKey}`,
                    building: 'watchtower',
                    reason: 'failed-push-watch',
                    phase: 'git',
                    confidence: 0.94,
                    label: normalized.label || 'push failed',
                    payload: normalized,
                    createdAt: normalized.timestamp || now,
                    expiresAt: normalized.timestamp + DEFAULT_TTLS.alert.ttlMs,
                    stickyUntil: normalized.timestamp + DEFAULT_TTLS.alert.stickyMs,
                }, now);
            }
        }
    }

    _collectGitReplayWindow(agents, now) {
        const sourceSnapshot = [];
        for (const agent of agents) {
            if (!agent?.id) continue;
            const sources = [agent.gitEvents, agent.git?.events, agent.vcsEvents].filter(Array.isArray);
            for (const source of sources) {
                const last = source.at(-1) || null;
                sourceSnapshot.push({
                    agentId: agent.id,
                    source,
                    length: source.length,
                    last,
                    lastStatus: last?.status ?? last?.success ?? last?.exitCode ?? null,
                    lastActivity: agent.lastSessionActivity || null,
                });
            }
        }
        if (this._sameGitReplaySources(sourceSnapshot)) {
            this._gitReplayStats.hits++;
            return this._gitReplayCache;
        }
        this._gitReplayStats.misses++;

        const rawCandidates = new Map();
        for (const agent of agents) {
            if (!agent?.id) continue;
            const sources = [agent.gitEvents, agent.git?.events, agent.vcsEvents].filter(Array.isArray);
            for (const source of sources) {
                const start = Math.max(0, source.length - MAX_SEEN_GIT_EVENTS);
                source.slice(start).forEach((event, offset) => {
                    const index = start + offset;
                    const key = this._rawGitReplayKey(event, agent, index);
                    if (rawCandidates.has(key)) {
                        this._gitReplayStats.rawDuplicates++;
                        return;
                    }
                    rawCandidates.set(key, { event, agent, index });
                });
            }
        }

        const candidatesByKey = new Map();
        for (const { event, agent, index } of rawCandidates.values()) {
            const normalized = normalizeGitEvent(event, agent, index, {
                fallbackTimestamp: parseEventTime(agent.lastSessionActivity, now),
                maxLabelChars: 18,
                ellipsis: '...',
            });
            if (!normalized) continue;
            this._gitReplayStats.normalized++;
            const sourceKey = `${normalized.sessionId}:${normalized.id}`;
            const previous = candidatesByKey.get(sourceKey);
            if (!previous || normalized.timestamp >= previous.normalized.timestamp) {
                candidatesByKey.set(sourceKey, { agentId: agent.id, normalized, sourceKey });
            }
        }

        const replay = [...candidatesByKey.values()]
            .sort((a, b) => (a.normalized.timestamp - b.normalized.timestamp) || a.sourceKey.localeCompare(b.sourceKey))
            .slice(-MAX_SEEN_GIT_EVENTS);
        const byAgent = new Map();
        for (const entry of replay) {
            const list = byAgent.get(entry.agentId) || [];
            list.push(entry);
            byAgent.set(entry.agentId, list);
        }
        this._gitReplaySourceSnapshot = sourceSnapshot;
        this._gitReplayCache = byAgent;
        return byAgent;
    }

    _sameGitReplaySources(next) {
        const previous = this._gitReplaySourceSnapshot;
        if (previous.length !== next.length) return false;
        for (let index = 0; index < next.length; index++) {
            const a = previous[index];
            const b = next[index];
            if (
                a.agentId !== b.agentId
                || a.source !== b.source
                || a.length !== b.length
                || a.last !== b.last
                || a.lastStatus !== b.lastStatus
                || a.lastActivity !== b.lastActivity
            ) return false;
        }
        return true;
    }

    _rawGitReplayKey(event, agent, index) {
        const sessionId = event?.sessionId || event?.session_id || '';
        const eventId = event?.id || event?.eventId || event?.uuid || event?.key || '';
        const sha = event?.sha || event?.commit || event?.hash || event?.commitSha || '';
        const project = event?.project || event?.projectPath || event?.repository || agent?.projectPath || '';
        const identity = eventId || sha || event?.commandHash || `${event?.type || event?.kind || 'git'}:${index}`;
        return sessionId
            ? `${sessionId}:${identity}`
            : `${agent?.id || 'unknown'}:${project}:${identity}`;
    }

    _deriveRelationshipIntents(agent, now) {
        if (agent.parentSessionId) {
            const parentIntent = this.getIntentForAgent(agent.parentSessionId, now);
            const parentLast = this.lastToolBuildingByAgent.get(agent.parentSessionId);
            const parentBuilding = parentIntent?.building || parentLast?.building || 'command';
            // omp advisors are pinned to their parent: the advisor tether is
            // only legible when the pair actually stands together, so the
            // shadow intent outranks the advisor's own tool (80), git (85),
            // alert (90), and token cash-out (95) intents. Only a live chat
            // (100) may briefly pull the advisor aside.
            const advisor = agent.isAdvisor === true;
            this._upsertIntent(agent.id, {
                source: 'subagent',
                sourceKey: `parent:${agent.parentSessionId}:${parentBuilding}`,
                building: parentBuilding,
                reason: advisor
                    ? 'advise-parent'
                    : (parentBuilding === 'command' ? 'join-parent' : 'follow-parent-work'),
                phase: parentLast?.phase || parentIntent?.phase || phaseFromIntentDraft({ source: 'subagent', building: parentBuilding }),
                confidence: advisor ? 0.9 : 0.72,
                priority: advisor ? 96 : undefined,
                label: advisor ? 'advisor' : 'subagent',
                payload: { parentId: agent.parentSessionId, parentBuilding, advisor },
            }, now);
        }
        if (agent.teamName) {
            this._upsertIntent(agent.id, {
                source: 'team',
                sourceKey: String(agent.teamName),
                building: 'command',
                reason: 'join-team',
                phase: 'coordinating',
                confidence: 0.68,
                label: compactLabel(agent.teamName, 'team'),
                payload: { teamName: agent.teamName },
            }, now);
        }
    }

    _deriveLongRunningIntents(agent, now) {
        const status = String(agent?.status || '').toLowerCase();
        const age = Number(agent?.activityAgeMs);
        if (status === 'waiting' && Number.isFinite(age) && age > 120000) {
            this._upsertIntent(agent.id, {
                source: 'alert',
                sourceKey: `long-wait:${Math.floor(age / 60000)}`,
                building: 'watchtower',
                reason: 'long-wait-watch',
                phase: 'waiting',
                confidence: 0.56,
                label: `${Math.floor(age / 60000)}m wait`,
                payload: { ageMs: age },
                priority: 52,
            }, now);
        }
        if (status === 'working' && Number.isFinite(age) && age > 300000) {
            const last = this.lastToolBuildingByAgent.get(agent.id);
            this._upsertIntent(agent.id, {
                source: 'team',
                sourceKey: `long-work:${last?.building || 'work'}:${Math.floor(age / 300000)}`,
                building: last?.building || agent.lastKnownBuildingType || 'command',
                reason: 'long-work-shift',
                phase: last?.phase || phaseFromIntentDraft({ source: 'team', building: last?.building || agent.lastKnownBuildingType || 'command' }),
                confidence: 0.52,
                label: `${Math.floor(age / 60000)}m work`,
                payload: { ageMs: age },
                priority: 48,
            }, now);
        }
    }

    _deriveGlobalIntents(agents, now) {
        const working = agents.filter((agent) => String(agent?.status || '').toLowerCase() === 'working');
        if (working.length >= 4) {
            const sentries = agents
                .filter((agent) => agent?.id && String(agent.status || '').toLowerCase() !== 'working')
                .slice(0, 2);
            for (const agent of sentries) {
                this._upsertIntent(agent.id, {
                    source: 'alert',
                    sourceKey: `active-count:${working.length}`,
                    building: 'watchtower',
                    reason: 'high-activity-watch',
                    phase: 'coordinating',
                    confidence: 0.58,
                    label: `${working.length} active`,
                    payload: { activeWorkingCount: working.length },
                    priority: 54,
                }, now);
            }
        }

        const quotaPressure = agents.some((agent) => contextRatio(agent) >= CONTEXT_PRESSURE_THRESHOLD);
        if (quotaPressure) {
            const sentinel = agents.find((agent) => (
                agent?.id &&
                contextRatio(agent) < CONTEXT_PRESSURE_THRESHOLD &&
                ['idle', 'waiting'].includes(String(agent.status || '').toLowerCase())
            ));
            if (sentinel) {
                this._upsertIntent(sentinel.id, {
                    source: 'quota',
                    sourceKey: 'quota-sentinel',
                    building: 'mine',
                    reason: 'resource-check',
                    phase: 'quota/resource',
                    confidence: 0.5,
                    label: 'quota watch',
                    payload: { sentinel: true },
                    priority: 45,
                }, now);
            }
        }
    }

    _applyQuotaThrottle(agents, now) {
        const active = this.throttleActiveUntil > now;
        const nextActive = new Set();
        if (active) {
            for (const agent of agents) {
                if (!agent?.id) continue;
                if (String(agent.status || '').toLowerCase() !== 'working') continue;
                this._upsertIntent(agent.id, {
                    source: 'quota',
                    sourceKey: `throttle:${agent.id}`,
                    building: 'mine',
                    reason: 'quota-throttle',
                    phase: 'quota/resource',
                    confidence: 0.55,
                    priority: QUOTA_THROTTLE_PRIORITY,
                    label: 'throttled',
                    payload: { throttle: true },
                }, now);
                nextActive.add(agent.id);
                if (!this.throttleAgents.has(agent.id)) {
                    eventBus.emit('agent:throttle-tint', { agentId: agent.id, active: true });
                }
                if (agent.behavior && typeof agent.behavior === 'object') {
                    agent.behavior.quotaThrottle = true;
                }
            }
        }
        for (const previousId of this.throttleAgents) {
            if (nextActive.has(previousId)) continue;
            eventBus.emit('agent:throttle-tint', { agentId: previousId, active: false });
            const agent = agents.find((a) => a?.id === previousId);
            if (agent?.behavior && typeof agent.behavior === 'object') {
                agent.behavior.quotaThrottle = false;
            }
        }
        this.throttleAgents = nextActive;
    }

    _consumePendingGathers(agents, now) {
        if (!this.pendingGathers.length) return;
        const agentsById = new Map();
        for (const agent of agents) {
            if (agent?.id) agentsById.set(agent.id, agent);
        }
        const pending = this.pendingGathers.splice(0);
        for (const payload of pending) {
            const members = Array.isArray(payload?.members) ? payload.members : [];
            const plazaTile = payload?.plazaTile || null;
            const centroidArc = Array.isArray(payload?.centroidArc) ? payload.centroidArc : null;
            for (let index = 0; index < members.length; index++) {
                const member = members[index];
                const agentId = typeof member === 'string'
                    ? member
                    : (member?.agentId || member?.id || null);
                if (!agentId || !agentsById.has(agentId)) continue;
                const slotEntry = centroidArc ? centroidArc[index] : null;
                const targetSlotIndex = Number.isInteger(slotEntry?.slotIndex)
                    ? slotEntry.slotIndex
                    : (Number.isInteger(slotEntry) ? slotEntry : index);
                this._upsertIntent(agentId, {
                    source: 'team',
                    sourceKey: `team-gather:${payload?.teamName || 'team'}:${payload?.ts || now}`,
                    building: 'command',
                    reason: 'team-gather',
                    phase: 'coordinating',
                    confidence: 0.8,
                    priority: TEAM_GATHER_PRIORITY,
                    ttlMs: TEAM_GATHER_TTL_MS,
                    stickyMs: TEAM_GATHER_STICKY_MS,
                    label: 'gather',
                    targetTile: plazaTile,
                    targetSlotIndex,
                    payload: {
                        teamName: payload?.teamName || null,
                        plazaTile,
                        targetSlotIndex,
                        centroidArc,
                    },
                }, now);
            }
        }
    }

    _upsertIntent(agentId, draft, now) {
        if (!agentId || !draft?.building || !draft?.source) return null;
        const meta = DEFAULT_TTLS[draft.source] || DEFAULT_TTLS.ambient;
        const createdAt = Number.isFinite(Number(draft.createdAt)) ? Number(draft.createdAt) : now;
        const sourceKey = String(draft.sourceKey || draft.reason || draft.building);
        const id = `${agentId}:${draft.source}:${sourceKey}`;
        const map = this._agentIntentMap(agentId);
        const previous = map.get(id);
        const ttlMs = Number.isFinite(Number(draft.ttlMs)) && Number(draft.ttlMs) > 0
            ? Number(draft.ttlMs)
            : meta.ttlMs;
        const stickyMs = Number.isFinite(Number(draft.stickyMs)) && Number(draft.stickyMs) >= 0
            ? Number(draft.stickyMs)
            : meta.stickyMs;
        const priority = Number.isFinite(Number(draft.priority)) ? Number(draft.priority) : meta.priority;
        const expiresAt = Number.isFinite(Number(draft.expiresAt))
            ? Number(draft.expiresAt)
            : now + ttlMs;
        const stickyUntil = Number.isFinite(Number(draft.stickyUntil))
            ? Number(draft.stickyUntil)
            : now + stickyMs;
        const phase = phaseFromIntentDraft(draft);
        const goal = goalFromIntentDraft(draft, phase);
        const itinerary = itineraryFromIntentDraft(draft, {
            phase,
            goal,
            intentId: id,
            previous,
            now,
        });
        const intent = {
            id,
            agentId,
            building: draft.building,
            source: draft.source,
            reason: draft.reason || draft.source,
            priority,
            confidence: Math.max(0, Math.min(1, Number(draft.confidence ?? 0.5))),
            label: draft.label || '',
            createdAt: previous?.createdAt || createdAt,
            updatedAt: now,
            expiresAt: Math.max(previous?.expiresAt || 0, expiresAt),
            stickyUntil: Math.max(previous?.stickyUntil || 0, stickyUntil),
            ttlMs,
            stickyMs,
            phase,
            goal,
            itinerary,
            interruptible: interruptibleForIntentDraft(draft, priority, phase),
            targetTile: draft.targetTile || previous?.targetTile || null,
            targetSlotIndex: Number.isInteger(draft.targetSlotIndex) ? draft.targetSlotIndex : (previous?.targetSlotIndex ?? null),
            payload: draft.payload || {},
        };
        map.set(id, intent);
        return intent;
    }

    _agentIntentMap(agentId) {
        let map = this.intentsByAgent.get(agentId);
        if (!map) {
            map = new Map();
            this.intentsByAgent.set(agentId, map);
        }
        return map;
    }

    _expireIntents(now) {
        for (const [agentId, map] of this.intentsByAgent.entries()) {
            for (const [id, intent] of map.entries()) {
                if (intent.expiresAt <= now) map.delete(id);
            }
            if (!map.size) this.intentsByAgent.delete(agentId);
        }
    }
}

export { classifyTool };
