import { Agent, normalizeTodoList } from '../domain/entities/Agent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { resolveAgentStatus } from '../domain/services/StatusResolver.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';
import { dialogueIsHeldable } from '../config/dialogue.js';
import {
    createVerifiedOutcome,
    verifiedOutcomeFromGitEvent,
    verifiedOutcomeIsLive,
    verifiedOutcomeKey,
    VERIFIED_OUTCOME_EVENT,
} from '../domain/services/VerifiedOutcome.js';

const GENERATED_NAMES_STORAGE_KEY = 'claudeville.generatedAgentNames.v1';

// Sessions leave the server's live roster after two quiet minutes. Keep their
// villagers present just long enough for a short parallel fan-out to still be
// readable once it finishes, then send them out through the village gate.
export const DEPARTED_AGENT_GRACE_MS = 90 * 1000;
// The grace above expires on wall-clock time, but WebSocket updates stop the
// moment the server has nothing left to report — which is exactly when the last
// villager departs. Sweep on our own cadence so departures never wait on
// unrelated traffic.
export const DEPARTED_SWEEP_INTERVAL_MS = 15 * 1000;
// Bound world presence independently of Chronicle history. A 20-agent fan-out
// fits comfortably while pathological churn evicts the oldest departures.
export const MAX_DEPARTED_AGENTS = 100;

const AGENT_SIGNATURE_FIELDS = Object.freeze([
    'id',
    'agentId',
    'agentName',
    'agentType',
    'subagentKind',
    'parentSessionId',
    'workflowId',
    'workflowName',
    'model',
    'effort',
    'status',
    'role',
    'teamName',
    'tokens',
    'estimatedCost',
    'taskProgress',
    'tasks',
    'todos',
    'cost',
    'currentTool',
    'currentToolInput',
    'lastTool',
    'lastToolInput',
    'lastPrompt',
    'gitBranch',
    'gitEvents',
    'permissionMode',
    'turnState',
    'pendingTool',
    'pendingSince',
    'waitReason',
    'awaitingSince',
    'turnStartedAt',
    'lastTurnDurationMs',
    'signalSource',
    'signalCertainty',
    'signalObservedAt',
    'signalStale',
    'freshness',
    'workingSet',
    'lastResults',
    'collisions',
    'resident',
    'sendMessages',
    'lastSessionActivity',
    '_lastMessage',
    'dialogue',
    'name',
    '_customName',
    'projectPath',
    'provider',
]);
const SIGNATURE_STRING_SAMPLE = 512;
const SIGNATURE_ARRAY_ITEMS = 64;
const SIGNATURE_OBJECT_FIELDS = 32;
const SIGNATURE_FIELD_VALUE_BUDGET = 128;
const SIGNATURE_COLLECTION_VALUE_BUDGET = 1024;
const SIGNATURE_FIELD_CHARACTER_BUDGET = 1024;
const SIGNATURE_COLLECTION_CHARACTER_BUDGET = 15 * 1024;
const SIGNATURE_CHARACTER_BUDGET = 64 * 1024;
const SIGNATURE_COLLECTION_FIELDS = new Set(['gitEvents', 'sendMessages', 'workingSet', 'lastResults', 'collisions', 'tasks', 'todos']);
const VERIFIED_OUTCOME_KEY_LIMIT = 512;
const EXECUTION_TASK_LIMIT = 12;
// Mirrors the adapter contract's bounded last-result summary (adapters/toolResults.js).
const LAST_RESULT_LIMIT = 5;

function normalizeExecutionTaskSubject(value) {
    if (typeof value !== 'string') return '';
    const subject = value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|[\s"'([{=])((?:\/|[A-Za-z]:[\\/])(?:[^\s"'`<>()[\]{};,]+))/g, '$1[path]');
    if (!subject) return '';
    return subject.length <= 120 ? subject : `${subject.slice(0, 119).trimEnd()}…`;
}

function normalizeExecutionTaskStatus(value) {
    return String(value || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'unknown';
}

function normalizeExecutionTaskProgress(value) {
    if (!value || typeof value !== 'object') return null;
    const total = Number(value.total);
    const done = Number(value.done);
    if (!Number.isFinite(total) || !Number.isFinite(done)) return null;
    const normalizedTotal = Math.max(0, Math.trunc(total));
    const source = value.source === 'exact' || value.source === 'inferred'
        ? value.source
        : null;
    if (!source) return null;
    return {
        done: Math.min(normalizedTotal, Math.max(0, Math.trunc(done))),
        total: normalizedTotal,
        source,
    };
}


function gitEventWireReference(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let encoded = '';
    let remaining = hash >>> 0;
    for (let index = 0; index < 6; index++) {
        encoded = alphabet[remaining % 64] + encoded;
        remaining = Math.floor(remaining / 64);
    }
    return encoded;
}

function mixDigestCode(state, code) {
    state.a = Math.imul(state.a ^ code, 16777619);
    state.b = Math.imul(state.b ^ code, 2246822519);
}

function mixDigestString(state, value, budget = null) {
    const text = String(value);
    mixDigestCode(state, text.length & 0xffff);
    mixDigestCode(state, text.length >>> 16);
    const globalRemaining = Math.max(0, SIGNATURE_CHARACTER_BUDGET - state.characters);
    const fieldRemaining = budget
        ? Math.max(0, budget.characterLimit - budget.characters)
        : globalRemaining;
    const remaining = Math.min(globalRemaining, fieldRemaining);
    const sampleSize = Math.min(SIGNATURE_STRING_SAMPLE, remaining);
    if (sampleSize <= 0) return;
    if (text.length <= sampleSize) {
        for (let index = 0; index < text.length; index++) mixDigestCode(state, text.charCodeAt(index));
        state.characters += text.length;
        if (budget) budget.characters += text.length;
        return;
    }

    const head = Math.floor(sampleSize * 0.4);
    const tail = Math.floor(sampleSize * 0.4);
    const middle = sampleSize - head - tail;
    for (let index = 0; index < head; index++) mixDigestCode(state, text.charCodeAt(index));
    for (let index = 1; index <= middle; index++) {
        const sourceIndex = Math.floor(index * (text.length - 1) / (middle + 1));
        mixDigestCode(state, text.charCodeAt(sourceIndex));
    }
    for (let index = text.length - tail; index < text.length; index++) {
        mixDigestCode(state, text.charCodeAt(index));
    }
    state.characters += sampleSize;
    if (budget) budget.characters += sampleSize;
}

function mixDigestValue(state, value, depth = 0, budget = null) {
    if (!budget || budget.values >= budget.valueLimit || depth > 4) return;
    budget.values++;
    state.values++;
    if (value === null || value === undefined) {
        mixDigestString(state, value === null ? 'null' : 'undefined', budget);
        return;
    }
    const type = typeof value;
    mixDigestString(state, type, budget);
    if (type === 'string') {
        mixDigestString(state, value, budget);
        return;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
        mixDigestString(state, value, budget);
        return;
    }
    if (Array.isArray(value)) {
        mixDigestString(state, value.length, budget);
        const headCount = value.length > SIGNATURE_ARRAY_ITEMS ? 8 : value.length;
        const tailStart = value.length > SIGNATURE_ARRAY_ITEMS
            ? Math.max(headCount, value.length - (SIGNATURE_ARRAY_ITEMS - headCount))
            : value.length;
        for (let index = 0; index < headCount; index++) {
            mixDigestValue(state, value[index], depth + 1, budget);
        }
        for (let index = tailStart; index < value.length; index++) {
            mixDigestValue(state, value[index], depth + 1, budget);
        }
        return;
    }
    if (type !== 'object') return;

    let fieldCount = 0;
    for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (fieldCount >= SIGNATURE_OBJECT_FIELDS || budget.values >= budget.valueLimit) {
            mixDigestString(state, '[more-fields]', budget);
            break;
        }
        fieldCount++;
        mixDigestString(state, key, budget);
        mixDigestValue(state, value[key], depth + 1, budget);
    }
}

/**
 * Fixed-size signature for the fields retained by an Agent. Work is bounded by
 * sampled strings, recent array rows, recursion depth, and per-field work
 * budgets, so one large collection cannot starve later fields or force a
 * second full-payload serialization.
 */
export function digestAgentPayload(payload, diagnostics = null) {
    const state = {
        a: 2166136261,
        b: 2654435761,
        characters: 0,
        values: 0,
    };
    for (const field of AGENT_SIGNATURE_FIELDS) {
        mixDigestString(state, field);
        const collection = SIGNATURE_COLLECTION_FIELDS.has(field);
        const budget = {
            values: 0,
            valueLimit: collection
                ? SIGNATURE_COLLECTION_VALUE_BUDGET
                : SIGNATURE_FIELD_VALUE_BUDGET,
            characters: 0,
            characterLimit: collection
                ? SIGNATURE_COLLECTION_CHARACTER_BUDGET
                : SIGNATURE_FIELD_CHARACTER_BUDGET,
        };
        mixDigestValue(state, payload?.[field], 0, budget);
    }
    const activityAgeMinute = Number.isFinite(payload?.activityAgeMs)
        ? Math.floor(payload.activityAgeMs / 60_000)
        : null;
    mixDigestString(state, 'activityAgeMinute');
    mixDigestValue(state, activityAgeMinute, 0, {
        values: 0,
        valueLimit: SIGNATURE_FIELD_VALUE_BUDGET,
        characters: 0,
        characterLimit: SIGNATURE_FIELD_CHARACTER_BUDGET,
    });
    if (diagnostics && typeof diagnostics === 'object') {
        diagnostics.characters = state.characters;
        diagnostics.values = state.values;
    }
    return `${(state.a >>> 0).toString(16).padStart(8, '0')}${(state.b >>> 0).toString(16).padStart(8, '0')}`;
}

export class AgentManager {
    constructor(world, dataSource, { clock = Date.now } = {}) {
        this.world = world;
        this.dataSource = dataSource;
        this._clock = typeof clock === 'function' ? clock : Date.now;
        this._teamMembers = new Map();
        this._usageGetter = null;
        this._agentSignatures = new Map();
        this._generatedNames = this._loadGeneratedNames();
        this._verifiedOutcomeKeys = new Set();
        this._departureSweepTimer = null;
        this._unsubscribeVerifiedMilestones = [
            eventBus.on('chronicle:milestone', (record) => this._noteVerifiedMilestone(record)),
            eventBus.on('chronicle:milestone-banner', (record) => this._noteVerifiedMilestone(record)),
        ];
    }

    setUsageGetter(fn) {
        this._usageGetter = typeof fn === 'function' ? fn : null;
    }

    _buildTeamMembers(teams) {
        const teamMembers = new Map();
        for (const team of teams) {
            if (team.members) {
                for (const member of team.members) {
                    teamMembers.set(member.agentId, {
                        name: member.name,
                        teamName: team.teamName || team.name,
                        agentType: member.agentType,
                        model: member.model,
                    });
                }
            }
        }
        return teamMembers;
    }

    async loadInitialData({ signal = null } = {}) {
        try {
            const [sessions, teams] = await Promise.all([
                this.dataSource.getSessions({ signal }),
                this.dataSource.getTeams({ signal }),
            ]);
            if (signal?.aborted) return;

            this._teamMembers = this._buildTeamMembers(teams);

            const gitEventWire = this._gitEventWireFrom(sessions);
            const collisionsByAgent = this._collisionsByAgent(sessions.collisions);
            for (const session of sessions) {
                this._upsertAgent(
                    session,
                    this._teamMembers,
                    gitEventWire,
                    collisionsByAgent.get(String(session.sessionId)) || [],
                );
            }

            console.log(`[AgentManager] ${this.world.agents.size} agents loaded`);
        } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') return;
            console.error('[AgentManager] Failed to load initial data:', err.message);
        }
    }

    handleWebSocketMessage(data) {
        if (!data.sessions) return;

        // Update when team data is included
        if (data.teams) {
            this._teamMembers = this._buildTeamMembers(data.teams);
        }

        const currentIds = new Set();

        const gitEventWire = this._gitEventWireFrom(data, data.sessions);
        const collisionsByAgent = this._collisionsByAgent(data.collisions || data.sessions.collisions);
        for (const session of data.sessions) {
            currentIds.add(session.sessionId);
            this._upsertAgent(
                session,
                this._teamMembers,
                gitEventWire,
                collisionsByAgent.get(String(session.sessionId)) || [],
            );
        }

        this._sweepDepartedAgents(currentIds);
    }

    /**
     * Advance the departed-villager lifecycle: mark newly missing sessions as
     * departed, then remove the ones whose grace has run out so the renderer
     * can walk them out through the village gate.
     *
     * @param {Set<string>|null} liveIds Sessions present in the update that
     *   triggered this sweep, or null for a timer sweep, where every villager
     *   already in the World keeps whatever presence it currently has.
     */
    _sweepDepartedAgents(liveIds = null) {
        // Missing sessions linger as departed villagers. COMPLETED is an
        // existing compatibility projection for UI counters; the
        // departedAt marker, not status, owns this presence lifecycle.
        const now = this._now();
        const toRemove = [];
        for (const [id, agent] of this.world.agents) {
            if (liveIds?.has(id)) continue;
            if (agent.isDeparted) {
                this._agentSignatures.delete(id);
                if (now - agent.departedAt >= DEPARTED_AGENT_GRACE_MS) {
                    toRemove.push(id);
                }
            } else if (liveIds) {
                // Only a roster update can tell us a live villager has gone
                // missing; a timer sweep never demotes one on its own.
                this._agentSignatures.delete(id);
                this.world.updateAgent(id, {
                    status: AgentStatus.COMPLETED,
                    departedAt: now,
                    currentTool: null,
                    currentToolInput: null,
                    pendingTool: null,
                    waitReason: null,
                    awaitingSince: null,
                    resident: false,
                    dialogue: null,
                });
            }
        }
        for (const id of toRemove) {
            this.world.removeAgent(id);
        }
        this._evictDepartedOverflow();
    }

    /**
     * Start the wall-clock sweep. Without it a departed villager only leaves
     * when some unrelated session change wakes a broadcast, so the last agents
     * of a run stand frozen in the village until the page is reloaded.
     */
    startDepartureSweep({ intervalMs = DEPARTED_SWEEP_INTERVAL_MS } = {}) {
        if (this._departureSweepTimer || typeof setInterval !== 'function') return;
        this._departureSweepTimer = setInterval(() => this._sweepDepartedAgents(), intervalMs);
        this._departureSweepTimer.unref?.();
    }

    stopDepartureSweep() {
        if (!this._departureSweepTimer) return;
        clearInterval(this._departureSweepTimer);
        this._departureSweepTimer = null;
    }

    stop() {
        this.stopDepartureSweep();
        for (const unsubscribe of this._unsubscribeVerifiedMilestones) unsubscribe?.();
        this._unsubscribeVerifiedMilestones = [];
    }

    _evictDepartedOverflow() {
        const departed = [...this.world.agents.values()]
            .filter(agent => agent.isDeparted)
            .sort((a, b) => a.departedAt - b.departedAt || String(a.id).localeCompare(String(b.id)));
        const overflow = departed.length - MAX_DEPARTED_AGENTS;
        for (let index = 0; index < overflow; index++) {
            const id = departed[index].id;
            this._agentSignatures.delete(id);
            this.world.removeAgent(id);
        }
    }

    _now() {
        const now = Number(this._clock());
        return Number.isFinite(now) ? now : Date.now();
    }

    _upsertAgent(session, teamMembers, gitEventWire = null, collisions = []) {
        const payload = this._sessionToAgentPayload(session, teamMembers, gitEventWire, collisions);
        this._noteVerifiedGitOutcomes(session, payload.gitEvents);
        const { id } = payload;
        const signature = this._agentSignature(payload);

        if (this.world.agents.has(id)) {
            const agent = this.world.agents.get(id);
            if (!agent.isDeparted && this._agentSignatures.get(id) === signature) {
                agent.activityAgeMs = payload.activityAgeMs;
                agent.lastActive = Date.now();
                return;
            }
            this._agentSignatures.set(id, signature);
            const { id: _id, projectPath: _projectPath, provider: _provider, lastMessage: _lastMessage, ...agentData } = payload;
            this.world.updateAgent(id, { ...agentData, departedAt: null });
        } else {
            this._agentSignatures.set(id, signature);
            const agent = new Agent(payload);
            agent.subagentKind = payload.subagentKind;
            agent.taskProgress = payload.taskProgress;
            agent.tasks = payload.tasks;
            // Fallback (non-provider) names come from a shared pool; probe past
            // names already held by live agents so busy villages stay distinct.
            // Persist the result under the pre-probe identity as well as the
            // resulting identity, so roster order cannot rename the villager
            // after a restart.
            if (!agent._customName) {
                const initialIdentityKey = AgentBiography.identityKeyFor(agent);
                agent.name = this._generatedNames.get(initialIdentityKey)
                    || agent.generateName(this._usedAgentNames());
                const identityKey = AgentBiography.identityKeyFor(agent);
                this._rememberGeneratedName(initialIdentityKey, agent.name);
                this._rememberGeneratedName(identityKey, agent.name);
            }
            agent.refreshIdentityAppearance();
            this.world.addAgent(agent);
        }
    }

    _agentSignature(payload) {
        return digestAgentPayload(payload);
    }

    _noteVerifiedGitOutcomes(session, gitEvents = session?.gitEvents) {
        const agentId = session?.sessionId || session?.agentId || null;
        for (const event of gitEvents || []) {
            const outcome = verifiedOutcomeFromGitEvent(event, {
                project: session?.project,
                agentId,
                at: this._now(),
            });
            this._emitVerifiedOutcome(outcome, event?.id || event?.commandHash || event?.sha || 'git');
        }
    }

    _noteVerifiedMilestone(record) {
        const kind = record?.kind === 'release' ? 'release' : 'milestone';
        const outcome = createVerifiedOutcome(
            kind,
            record?.project,
            record?.agentId ?? null,
            record?.startedAt ?? record?.plantedAt ?? record?.ts
        );
        this._emitVerifiedOutcome(outcome, record?.id || record?.dedupKey || record?.tier || 'milestone');
    }

    _emitVerifiedOutcome(outcome, sourceId) {
        if (!outcome || !verifiedOutcomeIsLive(outcome, this._now())) return;
        const key = verifiedOutcomeKey(outcome, sourceId);
        if (!key || this._verifiedOutcomeKeys.has(key)) return;
        this._verifiedOutcomeKeys.add(key);
        while (this._verifiedOutcomeKeys.size > VERIFIED_OUTCOME_KEY_LIMIT) {
            this._verifiedOutcomeKeys.delete(this._verifiedOutcomeKeys.values().next().value);
        }
        eventBus.emit(VERIFIED_OUTCOME_EVENT, outcome);
    }

    _usedAgentNames() {
        const used = new Set();
        for (const agent of this.world.agents.values()) {
            const name = String(agent?.name || '').trim();
            if (name) used.add(name);
        }
        return used;
    }

    _loadGeneratedNames() {
        if (typeof localStorage === 'undefined') return new Map();
        try {
            const entries = JSON.parse(localStorage.getItem(GENERATED_NAMES_STORAGE_KEY) || '[]');
            if (!Array.isArray(entries)) return new Map();
            return new Map(entries.filter(entry => (
                Array.isArray(entry)
                && typeof entry[0] === 'string'
                && typeof entry[1] === 'string'
            )));
        } catch {
            return new Map();
        }
    }

    _rememberGeneratedName(identityKey, name) {
        if (!identityKey || !name || this._generatedNames.get(identityKey) === name) return;
        this._generatedNames.set(identityKey, name);
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(GENERATED_NAMES_STORAGE_KEY, JSON.stringify([...this._generatedNames]));
        } catch {
            // Storage can be unavailable in private or restricted contexts.
        }
    }

    _sessionToAgentPayload(session, teamMembers, gitEventWire = null, collisions = []) {
        const id = session.sessionId;
        const teamInfo = teamMembers ? teamMembers.get(session.agentId) : null;
        const agentName = teamInfo?.name || session.name || session.agentName || session.nickname || null;
        const status = this._resolveStatus(session);
        const lastSessionActivity = Number(session.lastActivity || 0) || null;
        const activityAgeMs = lastSessionActivity ? Math.max(0, Date.now() - lastSessionActivity) : null;
        const hasFreshTool = status === AgentStatus.WORKING && !!session.lastTool;

        // Team name is an explicit provider field. Do not infer it from project
        // paths; Codex/Gemini intentionally degrade to null.
        const teamName = teamInfo?.teamName
            || session.teamName
            || null;

        return {
            id,
            agentId: session.agentId || null,
            subagentKind: typeof session.subagentKind === 'string' && session.subagentKind.trim()
                ? session.subagentKind.trim().slice(0, 128)
                : null,
            agentName,
            agentType: session.agentType || null,
            parentSessionId: session.parentSessionId || null,
            workflowId: session.workflowId || null,
            workflowName: session.workflowName || null,
            model: teamInfo?.model || session.model || 'unknown',
            effort: session.reasoningEffort || session.effort || null,
            status,
            role: teamInfo?.agentType || session.agentType || 'general',
            teamName,
            tokens: session.tokenUsage || session.tokens || session.usage || null,
            estimatedCost: session.estimatedCost !== null
                && session.estimatedCost !== undefined
                && Number.isFinite(Number(session.estimatedCost))
                ? Number(session.estimatedCost)
                : null,
            cost: session.cost && typeof session.cost === 'object' ? { ...session.cost } : null,
            taskProgress: normalizeExecutionTaskProgress(session.taskProgress),
            tasks: Array.isArray(session.tasks)
                ? session.tasks.slice(0, EXECUTION_TASK_LIMIT).flatMap((task) => {
                    const subject = normalizeExecutionTaskSubject(task?.subject);
                    return subject
                        ? [{ subject, status: normalizeExecutionTaskStatus(task?.status) }]
                        : [];
                })
                : [],
            todos: normalizeTodoList(session.todos),
            currentTool: hasFreshTool ? session.lastTool : null,
            currentToolInput: hasFreshTool ? session.lastToolInput || null : null,
            lastTool: session.lastTool || null,
            lastToolInput: session.lastToolInput || null,
            lastPrompt: typeof session.lastPrompt === 'string' && session.lastPrompt.trim()
                ? session.lastPrompt.trim().slice(0, 200)
                : null,
            gitBranch: typeof session.gitBranch === 'string' && session.gitBranch.trim()
                ? session.gitBranch.trim().slice(0, 256)
                : null,
            gitEvents: this._rehydrateGitEvents(session.gitEvents, gitEventWire),
            permissionMode: session.permissionMode ?? null,
            turnState: session.turnState ?? 'unknown',
            pendingTool: session.pendingTool ?? null,
            pendingSince: session.pendingSince !== null
                && session.pendingSince !== undefined
                && Number.isFinite(Number(session.pendingSince))
                ? Number(session.pendingSince)
                : null,
            waitReason: session.waitReason ?? null,
            awaitingSince: session.awaitingSince !== null
                && session.awaitingSince !== undefined
                && Number.isFinite(Number(session.awaitingSince))
                ? Number(session.awaitingSince)
                : null,
            turnStartedAt: session.turnStartedAt !== null
                && session.turnStartedAt !== undefined
                && Number.isFinite(Number(session.turnStartedAt))
                ? Number(session.turnStartedAt)
                : null,
            lastTurnDurationMs: session.lastTurnDurationMs !== null
                && session.lastTurnDurationMs !== undefined
                && Number.isFinite(Number(session.lastTurnDurationMs))
                ? Math.max(0, Number(session.lastTurnDurationMs))
                : null,
            signalSource: session.signalSource === 'hook' || session.signalSource === 'transcript'
                ? session.signalSource
                : null,
            signalCertainty: session.signalCertainty || 'unavailable',
            signalObservedAt: session.signalObservedAt ?? null,
            signalStale: session.signalStale === true,
            freshness: session.freshness || null,
            workingSet: Array.isArray(session.workingSet) ? session.workingSet.slice(0, 16) : [],
            lastResults: Array.isArray(session.lastResults)
                ? session.lastResults.slice(0, LAST_RESULT_LIMIT)
                : [],
            collisions: Array.isArray(collisions) ? collisions : [],
            resident: session.resident === true,
            sendMessages: Array.isArray(session.sendMessages) ? session.sendMessages : [],
            lastSessionActivity,
            activityAgeMs,
            _lastMessage: session.lastMessage || null,
            lastMessage: session.lastMessage,
            dialogue: this._retainedDialogue(session, status, id),
            observedSources: session.observedSources ?? null,
            name: agentName || null,
            _customName: !!agentName,
            projectPath: session.project || null,
            provider: session.provider || 'claude',
        };
    }

    _collisionsByAgent(collisions) {
        const byAgent = new Map();
        for (const collision of Array.isArray(collisions) ? collisions : []) {
            if (!collision || !Array.isArray(collision.agents)) continue;
            for (const id of collision.agents) {
                const key = String(id || '');
                if (!key) continue;
                if (!byAgent.has(key)) byAgent.set(key, []);
                byAgent.get(key).push(collision);
            }
        }
        return byAgent;
    }

    _gitEventWireFrom(primary, fallback = null) {
        const eventsById = primary?.gitEventsById || fallback?.gitEventsById || null;
        const idsByReference = Object.create(null);
        const usedReferences = new Set();
        for (const id of Object.keys(eventsById || {}).sort()) {
            const baseReference = gitEventWireReference(id);
            let reference = baseReference;
            let suffix = 2;
            while (usedReferences.has(reference)) reference = `${baseReference}~${suffix++}`;
            usedReferences.add(reference);
            idsByReference[reference] = id;
        }
        return {
            idsByReference,
            fields: primary?.gitEventFields || fallback?.gitEventFields || null,
            stringTables: primary?.gitEventStringTables || fallback?.gitEventStringTables || null,
            eventsById,
        };
    }

    _rehydrateGitEvents(gitEvents, wire) {
        if (!Array.isArray(gitEvents)) return [];
        if (!gitEvents.some(reference => typeof reference === 'string' || Number.isInteger(reference))) {
            return gitEvents;
        }

        const resolved = [];
        for (const reference of gitEvents) {
            if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
                resolved.push(this._cloneGitEventValue(reference));
                continue;
            }
            const event = this._gitEventFromReference(reference, wire);
            if (event) resolved.push(event);
        }
        return resolved;
    }

    _gitEventFromReference(reference, wire) {
        const directKey = typeof reference === 'string' ? reference : null;
        const key = directKey && Object.prototype.hasOwnProperty.call(wire?.eventsById || {}, directKey)
            ? directKey
            : wire?.idsByReference?.[directKey];
        if (
            typeof key !== 'string'
            || !wire?.eventsById
            || !Object.prototype.hasOwnProperty.call(wire.eventsById, key)
        ) return null;

        const row = wire.eventsById[key];
        if (!Array.isArray(row)) {
            return row && typeof row === 'object' ? this._cloneGitEventValue(row) : null;
        }
        if (!Array.isArray(row[0]) || !Array.isArray(wire.fields)) return null;

        const dictionaries = new Map();
        for (const entry of wire.stringTables || []) {
            if (Array.isArray(entry) && Number.isInteger(entry[0]) && Array.isArray(entry[1])) {
                dictionaries.set(entry[0], entry[1]);
            }
        }
        const event = {};
        let valueIndex = 1;
        for (let fieldIndex = 0; fieldIndex < wire.fields.length; fieldIndex++) {
            const mask = Number(row[0][Math.floor(fieldIndex / 30)]) || 0;
            const present = Math.floor(mask / (2 ** (fieldIndex % 30))) % 2 === 1;
            if (!present) continue;
            if (valueIndex >= row.length) return null;
            let value = row[valueIndex++];
            const dictionary = dictionaries.get(fieldIndex);
            if (dictionary) {
                if (!Number.isInteger(value) || value < 0 || value >= dictionary.length) return null;
                value = dictionary[value];
            }
            event[wire.fields[fieldIndex]] = this._cloneGitEventValue(value);
        }
        return event;
    }

    _cloneGitEventValue(value) {
        if (Array.isArray(value)) return value.map(item => this._cloneGitEventValue(item));
        if (!value || typeof value !== 'object') return value;
        const clone = {};
        for (const [key, child] of Object.entries(value)) {
            clone[key] = this._cloneGitEventValue(child);
        }
        return clone;
    }

    /**
     * Dialogue for this poll, holding a blocked agent's question in place.
     *
     * The server drops every line older than its own max age, which is right
     * for narration: a working agent's stale line describes work it has already
     * moved on from. A question is different. It stays true until it is
     * answered, and an agent blocked on the operator emits no newer text by
     * definition, so the wire simply goes quiet with the question still
     * outstanding. Keep the assistant prose it was last seen asking; every
     * other kind, and every other status, still falls silent on schedule.
     *
     * `Agent.speech()` marks the retained line as held so the tooltip discloses
     * it instead of passing an old question off as something just said.
     */
    _retainedDialogue(session, status, id) {
        const incoming = session.dialogue ?? null;
        if (incoming) return incoming;
        const previous = this.world?.agents?.get(id)?.dialogue ?? null;
        if (!previous) return null;
        return dialogueIsHeldable(status, previous.kind) ? previous : null;
    }

    _resolveStatus(session) {
        return resolveAgentStatus(session, {
            usage: this._usageGetter ? this._usageGetter() : null,
        });
    }

}
