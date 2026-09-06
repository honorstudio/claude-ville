import { eventBus } from '../../domain/events/DomainEvent.js';
import { classifyTool } from './VisitIntentManager.js';

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function toolKey(agent) {
    return [
        agent?.currentTool || '',
        agent?.currentToolInput || '',
        agent?.lastSessionActivity || '',
    ].join('\u001f');
}

function snapshotAgent(agent) {
    return {
        id: agent.id,
        tool: agent.currentTool || null,
        input: agent.currentToolInput || null,
        toolKey: toolKey(agent),
        parentId: agent.parentSessionId || null,
        teamName: agent.teamName || null,
        agentType: agent.agentType || null,
        agentName: agent.agentName || null,
        subagentType: agent.subagent_type || agent.subagentType || null,
        lastTile: agent.position
            ? { tileX: agent.position.x, tileY: agent.position.y }
            : null,
    };
}

const COMMAND_LIFECYCLE_TOOLS = new Map([
    ['functions.spawn_agent', 'spawn'],
    ['spawn_agent', 'spawn'],
    ['functions.send_input', 'send_input'],
    ['send_input', 'send_input'],
    ['functions.wait_agent', 'wait'],
    ['wait_agent', 'wait'],
    ['functions.resume_agent', 'resume'],
    ['resume_agent', 'resume'],
    ['functions.close_agent', 'close'],
    ['close_agent', 'close'],
]);

const TARGET_REF_KEYS = [
    'targetAgentId',
    'target_agent_id',
    'sessionId',
    'session_id',
    'agentId',
    'agent_id',
    'threadId',
    'thread_id',
    'target',
    'recipient',
    'id',
];

function commandLifecycleKind(toolName) {
    const tool = String(toolName || '');
    if (COMMAND_LIFECYCLE_TOOLS.has(tool)) return COMMAND_LIFECYCLE_TOOLS.get(tool);
    const lower = tool.toLowerCase();
    for (const [name, kind] of COMMAND_LIFECYCLE_TOOLS.entries()) {
        if (lower.includes(name.toLowerCase())) return kind;
    }
    return null;
}

function parseToolInputObject(input) {
    if (!input) return null;
    if (typeof input === 'object') return input;
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (!text) return null;
    if (/^[\[{]/.test(text)) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }
    return null;
}

function firstScalar(value) {
    if (value == null) return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const scalar = firstScalar(item);
            if (scalar) return scalar;
        }
        return null;
    }
    if (typeof value === 'object') {
        for (const key of TARGET_REF_KEYS) {
            const scalar = firstScalar(value[key]);
            if (scalar) return scalar;
        }
        return null;
    }
    const text = String(value).trim();
    return text || null;
}

function extractTargetRef(input) {
    const parsed = parseToolInputObject(input);
    if (parsed && typeof parsed === 'object') {
        for (const key of TARGET_REF_KEYS) {
            const value = firstScalar(parsed[key]);
            if (value) return value;
        }
        const targetFromList = firstScalar(parsed.targets);
        if (targetFromList) return targetFromList;
    }
    const text = String(input || '').trim();
    if (!text) return null;
    const fieldMatch = text.match(/(?:targetAgentId|target_agent_id|sessionId|session_id|agentId|agent_id|threadId|thread_id|target|recipient|id)["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/i);
    if (fieldMatch?.[1]) return fieldMatch[1];
    if (/^[A-Za-z0-9_.:-]+$/.test(text)) return text;
    const bareId = text.split(/[,\s]+/).find(part => /^[A-Za-z0-9_.:-]{6,}$/.test(part));
    return bareId || null;
}

function agentDisplayName(agent) {
    return agent?.agentName || agent?.name || agent?.displayName || null;
}

function resolveVisibleAgent(world, targetRef, provider) {
    const ref = String(targetRef || '').trim();
    if (!ref || !world?.agents?.values) {
        return { targetAgentId: null, targetProviderId: null, targetName: null, confidence: 0, source: 'none' };
    }
    if (world.agents.has(ref)) {
        const agent = world.agents.get(ref);
        return { targetAgentId: ref, targetProviderId: agent?.agentId || null, targetName: agentDisplayName(agent), confidence: 1, source: 'input' };
    }
    for (const prefix of ['codex-', 'subagent-', 'kimi-', 'opencode-', 'omp-']) {
        const id = `${prefix}${ref}`;
        if (world.agents.has(id)) {
            const agent = world.agents.get(id);
            return { targetAgentId: id, targetProviderId: agent?.agentId || null, targetName: agentDisplayName(agent), confidence: 0.92, source: 'input' };
        }
    }
    for (const agent of world.agents.values()) {
        if (String(agent?.agentId || '') === ref) {
            return { targetAgentId: agent.id, targetProviderId: agent.agentId || null, targetName: agentDisplayName(agent), confidence: 0.9, source: 'provider-id' };
        }
    }
    const providerPrefix = String(provider || '').toLowerCase();
    if (providerPrefix) {
        const id = `${providerPrefix}-${ref}`;
        if (world.agents.has(id)) {
            const agent = world.agents.get(id);
            return { targetAgentId: id, targetProviderId: agent?.agentId || null, targetName: agentDisplayName(agent), confidence: 0.86, source: 'input' };
        }
    }
    const lowerRef = ref.toLowerCase();
    for (const agent of world.agents.values()) {
        const names = [agent?.agentName, agent?.name, agent?.displayName].filter(Boolean).map(name => String(name).toLowerCase());
        if (names.includes(lowerRef)) {
            return { targetAgentId: agent.id, targetProviderId: agent.agentId || null, targetName: agentDisplayName(agent), confidence: 0.45, source: 'name' };
        }
    }
    return { targetAgentId: null, targetProviderId: null, targetName: null, confidence: 0, source: 'none' };
}

function commandLifecycleFor(agent, tool, input, world) {
    const kind = commandLifecycleKind(tool);
    if (!kind) return null;
    if (kind === 'spawn') {
        return {
            kind,
            targetRef: null,
            targetAgentId: null,
            targetProviderId: null,
            targetName: null,
            confidence: 0,
            source: 'none',
        };
    }
    const targetRef = extractTargetRef(input);
    const resolved = resolveVisibleAgent(world, targetRef, agent?.provider);
    return {
        kind,
        targetRef,
        ...resolved,
    };
}

function pairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

const MAX_EMITTED_TOOL_KEYS_PER_AGENT = 32;
const MAX_EMITTED_TOOL_KEYS_TOTAL = 2048;
const MAX_OBSERVED_RESULT_IDS_PER_AGENT = 16;

export class AgentEventStream {
    constructor(world, { shouldEmitToolEvent = null, shouldEmitEvent = null } = {}) {
        this.world = world;
        this.snapshots = new Map();
        this.chatPairs = new Set();
        this.emittedToolKeys = new Set();
        this._emittedToolKeysByAgent = new Map();
        this._emittedToolKeyOwners = new Map();
        this._observedResultIdsByAgent = new Map();
        // Results that finished before the village started watching this agent
        // are recorded, never stamped: a shelf tile means "this completed while
        // you were here", not "this exists in the transcript tail".
        this._startedAt = Date.now();
        this.shouldEmitToolEvent = typeof shouldEmitToolEvent === 'function' ? shouldEmitToolEvent : null;
        this.shouldEmitEvent = typeof shouldEmitEvent === 'function' ? shouldEmitEvent : null;
        this.unsubscribers = [];

        for (const agent of this.world?.agents?.values?.() || []) {
            this.snapshots.set(agent.id, snapshotAgent(agent));
            this._observeResults(agent, { emit: false });
        }

        this.unsubscribers.push(
            eventBus.on('agent:added', (agent) => this._onAdded(agent)),
            eventBus.on('agent:updated', (agent) => this._onUpdated(agent)),
            eventBus.on('agent:removed', (agent) => this._onRemoved(agent)),
        );
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.snapshots.clear();
        this.chatPairs.clear();
        this.emittedToolKeys.clear();
        this._emittedToolKeysByAgent.clear();
        this._emittedToolKeyOwners.clear();
        this._observedResultIdsByAgent.clear();
        this.shouldEmitToolEvent = null;
        this.shouldEmitEvent = null;
    }

    setToolEventGate(shouldEmitToolEvent = null) {
        this.shouldEmitToolEvent = typeof shouldEmitToolEvent === 'function' ? shouldEmitToolEvent : null;
    }

    _canEmit(eventName, payload, agent) {
        return typeof this.shouldEmitEvent !== 'function' || this.shouldEmitEvent(eventName, payload, agent) !== false;
    }

    emitInitialToolEvents({ force = false, shouldEmit = null } = {}) {
        let emitted = 0;
        const gate = typeof shouldEmit === 'function' ? shouldEmit : this.shouldEmitToolEvent;
        for (const agent of this.world?.agents?.values?.() || []) {
            const snap = snapshotAgent(agent);
            this.snapshots.set(agent.id, snap);
            if (!snap.tool) continue;

            const emittedKey = this._emittedToolKey(agent.id, snap.toolKey);
            if (!force && this.emittedToolKeys.has(emittedKey)) continue;

            const event = this._toolEvent(agent, snap, { replay: true });
            if (typeof gate === 'function' && !gate(event, agent)) continue;

            if (!this._canEmit('tool:invoked', event, agent)) continue;
            eventBus.emit('tool:invoked', event);
            this._rememberEmittedToolKey(agent.id, emittedKey);
            emitted += 1;
        }
        return emitted;
    }

    _onAdded(agent) {
        const snap = snapshotAgent(agent);
        this.snapshots.set(agent.id, snap);
        if (snap.parentId && this.world?.agents?.has?.(snap.parentId)) {
            const event = {
                parentId: snap.parentId,
                childId: agent.id,
                childAgentType: snap.agentType,
                childAgentName: snap.agentName,
                childSubagentType: snap.subagentType,
                ts: Date.now(),
            };
            if (this._canEmit('subagent:dispatched', event, agent)) eventBus.emit('subagent:dispatched', event);
        }
        if (snap.teamName) {
            const event = {
                agentId: agent.id,
                teamName: snap.teamName,
                ts: Date.now(),
            };
            if (this._canEmit('team:joined', event, agent)) eventBus.emit('team:joined', event);
        }
        this._emitToolIfChanged(agent, null, snap);
        this._observeResults(agent);
    }

    _onUpdated(agent) {
        const previous = this.snapshots.get(agent.id) || null;
        const next = snapshotAgent(agent);
        this.snapshots.set(agent.id, next);
        this._emitToolIfChanged(agent, previous, next);
        this._observeResults(agent);
        if (!previous?.teamName && next.teamName) {
            const event = {
                agentId: agent.id,
                teamName: next.teamName,
                ts: Date.now(),
            };
            if (this._canEmit('team:joined', event, agent)) eventBus.emit('team:joined', event);
        }
    }

    _onRemoved(agent) {
        const previous = this.snapshots.get(agent.id) || snapshotAgent(agent);
        this.snapshots.delete(agent.id);
        if (previous.parentId && this.world?.agents?.has?.(previous.parentId)) {
            const event = {
                parentId: previous.parentId,
                childId: agent.id,
                lastTile: previous.lastTile,
                ts: Date.now(),
            };
            if (this._canEmit('subagent:completed', event, agent)) eventBus.emit('subagent:completed', event);
        }
        this._clearChatPairsFor(agent.id);
        this._retireEmittedToolKeys(agent.id);
        this._observedResultIdsByAgent.delete(String(agent.id || ''));
    }

    _emitToolIfChanged(agent, previous, next) {
        if (!next.tool) return;
        if (String(agent.status || '').toLowerCase() !== 'working') return;
        if (previous && previous.toolKey === next.toolKey) return;
        const event = this._toolEvent(agent, next);
        if (!this._canEmit('tool:invoked', event, agent)) return;
        if (typeof this.shouldEmitToolEvent === 'function' && !this.shouldEmitToolEvent(event, agent)) return;
        eventBus.emit('tool:invoked', event);
        this._rememberEmittedToolKey(agent.id, this._emittedToolKey(agent.id, next.toolKey));
    }

    /**
     * Emit `tool:result` once per newly observed provider result record.
     *
     * Results arrive as a bounded newest-first summary on the session payload
     * (`adapters/toolResults.js`); the same finished call keeps one id across
     * polls, so an id the stream has not seen before is a genuinely new
     * outcome. Nothing here fires on invocation, and a result leaving the
     * bounded summary is not an event: only a record that says how a call ended
     * produces one.
     */
    _observeResults(agent, { emit = true } = {}) {
        const results = Array.isArray(agent?.lastResults) ? agent.lastResults : [];
        if (!results.length) return;
        const owner = String(agent.id || '');
        let observed = this._observedResultIdsByAgent.get(owner);
        if (!observed) {
            observed = new Set();
            this._observedResultIdsByAgent.set(owner, observed);
        }

        // Oldest first, so a poll that reveals several completions stamps them
        // in the order the provider finished them.
        for (let index = results.length - 1; index >= 0; index--) {
            const result = results[index];
            const id = typeof result?.id === 'string' ? result.id : '';
            if (!id || observed.has(id)) continue;
            observed.add(id);
            while (observed.size > MAX_OBSERVED_RESULT_IDS_PER_AGENT) {
                observed.delete(observed.values().next().value);
            }
            const completedAt = Number(result.completedAt);
            if (!emit || !Number.isFinite(completedAt) || completedAt < this._startedAt) continue;
            const event = {
                agentId: agent.id,
                id,
                tool: result.tool || null,
                exitCode: Number.isFinite(Number(result.exitCode)) && result.exitCode !== null
                    ? Number(result.exitCode)
                    : null,
                durationMs: Number.isFinite(Number(result.durationMs)) && result.durationMs !== null
                    ? Number(result.durationMs)
                    : null,
                completedAt,
                building: classifyTool(result.tool, result.detail || null)?.building || null,
            };
            if (!this._canEmit('tool:result', event, agent)) continue;
            eventBus.emit('tool:result', event);
        }
    }

    _toolEvent(agent, snap, extra = {}) {
        const classified = classifyTool(snap.tool, snap.input);
        const commandLifecycle = commandLifecycleFor(agent, snap.tool, snap.input, this.world);
        return {
            agentId: agent.id,
            provider: agent.provider || null,
            tool: snap.tool,
            input: snap.input,
            ts: Date.now(),
            building: classified?.building || agent.targetBuildingType || agent.lastKnownBuildingType || null,
            reason: classified?.reason || null,
            confidence: classified?.confidence ?? null,
            label: classified?.label || null,
            commandLifecycle,
            ...extra,
        };
    }

    _emittedToolKey(agentId, key) {
        return `${agentId || ''}\u001f${key || ''}`;
    }

    _rememberEmittedToolKey(agentId, key) {
        const owner = String(agentId || '');
        let keys = this._emittedToolKeysByAgent.get(owner);
        if (!keys) {
            keys = new Set();
            this._emittedToolKeysByAgent.set(owner, keys);
        }
        if (keys.has(key)) keys.delete(key);
        keys.add(key);
        if (this.emittedToolKeys.has(key)) this.emittedToolKeys.delete(key);
        this.emittedToolKeys.add(key);
        this._emittedToolKeyOwners.set(key, owner);

        while (keys.size > MAX_EMITTED_TOOL_KEYS_PER_AGENT) {
            const oldestRetired = this._oldestRetiredToolKey(keys);
            if (oldestRetired == null) break;
            this._deleteEmittedToolKey(oldestRetired);
        }
        while (this.emittedToolKeys.size > MAX_EMITTED_TOOL_KEYS_TOTAL) {
            const oldestRetired = this._oldestRetiredToolKey(this.emittedToolKeys);
            if (oldestRetired == null) break;
            this._deleteEmittedToolKey(oldestRetired);
        }
    }

    _oldestRetiredToolKey(keys) {
        for (const key of keys) {
            if (!this._isCurrentToolKey(key)) return key;
        }
        return null;
    }

    _isCurrentToolKey(key) {
        const owner = this._emittedToolKeyOwners.get(key);
        const snapshot = this.snapshots.get(owner);
        return Boolean(snapshot?.tool)
            && key === this._emittedToolKey(owner, snapshot.toolKey);
    }

    _deleteEmittedToolKey(key) {
        if (key == null) return;
        this.emittedToolKeys.delete(key);
        const owner = this._emittedToolKeyOwners.get(key);
        this._emittedToolKeyOwners.delete(key);
        const keys = this._emittedToolKeysByAgent.get(owner);
        keys?.delete(key);
        if (keys?.size === 0) this._emittedToolKeysByAgent.delete(owner);
    }

    _retireEmittedToolKeys(agentId) {
        const owner = String(agentId || '');
        const keys = this._emittedToolKeysByAgent.get(owner);
        if (!keys) return;
        for (const key of [...keys]) this._deleteEmittedToolKey(key);
    }

    getDiagnostics() {
        return {
            snapshots: this.snapshots.size,
            chatPairs: this.chatPairs.size,
            emittedToolKeys: this.emittedToolKeys.size,
            emittedToolAgents: this._emittedToolKeysByAgent.size,
            maxEmittedToolKeysPerAgent: MAX_EMITTED_TOOL_KEYS_PER_AGENT,
            maxEmittedToolKeysTotal: MAX_EMITTED_TOOL_KEYS_TOTAL,
            observedResultAgents: this._observedResultIdsByAgent.size,
            maxObservedResultIdsPerAgent: MAX_OBSERVED_RESULT_IDS_PER_AGENT,
        };
    }

    reconcileChatPairs(agentSprites) {
        const nextPairs = new Set();
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        for (const sprite of sprites) {
            const aId = sprite.agent?.id;
            const bId = sprite.chatPartner?.agent?.id;
            if (!aId || !bId || aId === bId) continue;
            nextPairs.add(pairKey(aId, bId));
        }

        for (const key of nextPairs) {
            if (this.chatPairs.has(key)) continue;
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:started', event, null)) eventBus.emit('chat:started', event);
        }

        for (const key of this.chatPairs) {
            if (nextPairs.has(key)) continue;
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:ended', event, null)) eventBus.emit('chat:ended', event);
        }

        this.chatPairs = nextPairs;
    }

    _clearChatPairsFor(agentId) {
        for (const key of Array.from(this.chatPairs)) {
            if (!key.split('|').includes(agentId)) continue;
            this.chatPairs.delete(key);
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:ended', event, null)) eventBus.emit('chat:ended', event);
        }
    }
}

export { nowMs };
