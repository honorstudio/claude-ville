// AgentSimulator — development-only behavior fixture (B-R10).
//
// Drives the live World with synthetic agents and a scripted tool/event
// timeline so renderer/behavior changes can be exercised without a real CLI
// session. Gated by `?sim=1` in `App.js`; production loads never construct
// this class.
//
// Contract:
//   - Pushes fake agents into `world` directly via `world.addAgent` /
//     `world.updateAgent` (real `Agent` constructor; no adapter, no WS).
//   - Steps a timeline (`[{ ts, agentId, tool|event|status, ... }]`) using
//     `setTimeout` keyed off step `ts` offsets.
//   - Calls `world.removeAgent(id)` for every sim agent on `stop()`.
//   - Never writes to `~/.claude` or any session file.

import { Agent } from '../../../domain/entities/Agent.js';
import { AgentStatus } from '../../../domain/value-objects/AgentStatus.js';
import { Position } from '../../../domain/value-objects/Position.js';
import {
    DEFAULT_WORLD_SCENARIO_ID,
    cloneWorldScenario,
} from './WorldScenarios.js';

export {
    DEFAULT_WORLD_SCENARIO_ID,
    getWorldScenario,
    listWorldScenarios,
    WORLD_SCENARIOS,
} from './WorldScenarios.js';

const SIM_DEBUG = false;
const SCENARIO_TIMESTAMP_REBASE_WINDOW_MS = 24 * 60 * 60 * 1000;

function debug(...args) {
    if (SIM_DEBUG) console.info('[AgentSimulator]', ...args);
}

function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function browserScenarioId() {
    try {
        if (typeof location === 'undefined' || !location.search) return null;
        const params = new URLSearchParams(location.search);
        return params.get('scenario') || params.get('simScenario') || null;
    } catch {
        return null;
    }
}

function positionFromSpec(value) {
    const tileX = Number(value?.tileX);
    const tileY = Number(value?.tileY);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return new Position(tileX, tileY);
}

function buildAgent(spec, timeBase) {
    const lastSessionActivity = Number.isFinite(Number(spec.lastSessionActivity))
        ? Number(spec.lastSessionActivity)
        : timeBase;
    const agent = new Agent({
        id: spec.id,
        name: spec.name,
        model: spec.model || 'unknown',
        status: spec.status || AgentStatus.IDLE,
        role: spec.role || 'general',
        provider: spec.provider || 'claude',
        teamName: spec.teamName || null,
        projectPath: spec.projectPath || '/sim/project',
        agentId: spec.agentId || spec.id,
        agentName: spec.name,
        agentType: spec.agentType || 'main',
        parentSessionId: spec.parentId || null,
        tokens: spec.tokens === undefined ? { input: 0, output: 0 } : spec.tokens,
        cost: spec.cost,
        effort: spec.effort,
        waitReason: spec.waitReason,
        pendingTool: spec.pendingTool,
        signalSource: spec.signalSource,
        signalCertainty: spec.signalCertainty,
        signalStale: spec.signalStale,
        signalObservedAt: timeBase - (Number(spec.signalAgeMs) || 0),
        freshness: spec.freshness ? { ...spec.freshness, observedAt: timeBase - (Number(spec.freshness.ageMs) || 0) } : null,
        messages: Array.isArray(spec.messages) ? clonePlain(spec.messages) : [],
        gitEvents: Array.isArray(spec.gitEvents) ? clonePlain(spec.gitEvents) : [],
        lastPrompt: spec.lastPrompt ?? null,
        todos: Array.isArray(spec.todos) ? clonePlain(spec.todos) : [],
        gitBranch: spec.gitBranch ?? null,
        lastMessage: spec.lastMessage || null,
        currentTool: spec.currentTool || null,
        currentToolInput: spec.currentToolInput || null,
        lastTool: spec.lastTool || null,
        lastToolInput: spec.lastToolInput || null,
        lastSessionActivity,
        activityAgeMs: 0,
    });
    agent.underlyingProvider = spec.underlyingProvider || null;
    agent.promptDetail = spec.promptDetail || null;
    const position = positionFromSpec(spec.position);
    if (position) agent.position = position;
    const targetPosition = positionFromSpec(spec.targetPosition);
    if (targetPosition) agent.targetPosition = targetPosition;
    agent.lastActive = lastSessionActivity;
    return agent;
}

function materializeScenario(input, fallbackId = DEFAULT_WORLD_SCENARIO_ID) {
    if (Array.isArray(input)) {
        const base = cloneWorldScenario(fallbackId);
        base.id = 'custom-timeline';
        base.label = 'Custom timeline';
        base.timeline = clonePlain(input);
        return base;
    }

    if (input && typeof input === 'object') {
        const base = cloneWorldScenario(input.extends || fallbackId);
        const custom = clonePlain(input);
        return {
            ...base,
            ...custom,
            agents: Array.isArray(custom.agents) ? custom.agents : base.agents,
            timeline: Array.isArray(custom.timeline) ? custom.timeline : base.timeline,
            metadata: {
                ...(base.metadata || {}),
                ...(custom.metadata || {}),
            },
        };
    }

    return cloneWorldScenario(input || fallbackId);
}

export default class AgentSimulator {
    constructor({ world, agentManager = null, eventBus = null, scenario = null, scenarioId = null } = {}) {
        if (!world || typeof world.addAgent !== 'function') {
            throw new Error('AgentSimulator requires a World with addAgent()');
        }
        this.world = world;
        this.agentManager = agentManager;
        this.eventBus = eventBus;
        this._scenarioInput = scenario || scenarioId || browserScenarioId() || DEFAULT_WORLD_SCENARIO_ID;
        this._scenario = null;
        this._timeBase = Date.now();
        this._scenarioTimeBase = this._timeBase;
        this._preserveScenarioTimestamps = false;
        this._active = false;
        this._timers = [];
        this._agentIds = new Set();
        this._timeline = null;
    }

    isActive() {
        return this._active;
    }

    getScenario() {
        return this._scenario ? clonePlain(this._scenario) : null;
    }

    start(input = null) {
        if (this._active) {
            debug('start() ignored — already active');
            return;
        }
        this._active = true;
        const scenario = materializeScenario(input || this._scenarioInput);
        this._scenario = scenario;
        const configuredTimeBase = Number(scenario.timeBase);
        const liveTimeBase = Date.now();
        this._scenarioTimeBase = Number.isFinite(configuredTimeBase)
            ? configuredTimeBase
            : liveTimeBase;
        this._preserveScenarioTimestamps = scenario.metadata?.preserveTimestamps === true;
        this._timeBase = this._preserveScenarioTimestamps
            ? this._scenarioTimeBase
            : liveTimeBase;
        this._timeline = Array.isArray(scenario.timeline)
            ? [...scenario.timeline].sort((a, b) => (a.ts || 0) - (b.ts || 0))
            : [];

        // Seed the cast immediately.
        for (const spec of scenario.agents || []) {
            const agent = buildAgent(spec, this._timeBase);
            this.world.addAgent(agent);
            this._agentIds.add(agent.id);
        }
        debug(`seeded ${this._agentIds.size} agents for ${scenario.id}`);

        // Schedule each step against its `ts` offset.
        for (const step of this._timeline) {
            const delay = Math.max(0, Number(step.ts) || 0);
            const handle = setTimeout(() => this._applyStep(step), delay);
            this._timers.push(handle);
        }
    }

    stop() {
        if (!this._active) return;
        this._active = false;
        for (const handle of this._timers) clearTimeout(handle);
        this._timers = [];
        for (const id of Array.from(this._agentIds)) {
            this.world.removeAgent(id);
        }
        this._agentIds.clear();
        this._timeline = null;
        this._scenario = null;
        debug('stopped');
    }

    _applyStep(step) {
        if (!this._active || !step) return;
        try {
            if (step.event === 'subagent:spawn') {
                this._spawnSubagent(step);
                return;
            }
            if (step.event === 'subagent:complete') {
                this._removeAgent(step.agentId);
                return;
            }
            if (step.event === 'agent:add') {
                this._addAgent(step.agent || step);
                return;
            }
            if (step.event === 'agent:remove') {
                this._removeAgent(step.agentId || step.id);
                return;
            }
            if (step.event === 'git:event') {
                this._applyGitEventStep(step);
                return;
            }
            this._applyToolStep(step);
        } catch (err) {
            debug('step failed', step, err?.message || err);
        }
    }

    _addAgent(spec) {
        if (!spec?.id || this.world.agents.has(spec.id)) return;
        const agent = buildAgent(spec, this._timeBase);
        this.world.addAgent(agent);
        this._agentIds.add(agent.id);
    }

    _spawnSubagent(step) {
        const id = step.subagentId || `${step.parentId || step.agentId}-child`;
        if (this.world.agents.has(id)) return;
        const agent = buildAgent({
            id,
            name: step.agentName || 'Subagent',
            provider: step.provider || 'claude',
            model: step.model || 'claude-sonnet-4-5',
            role: step.subagentType || 'subagent',
            teamName: step.teamName || null,
            agentId: step.agentId || id,
            agentType: step.subagentType || 'subagent',
            parentId: step.parentId || step.agentId,
            status: AgentStatus.WORKING,
            position: step.position || null,
            targetPosition: step.targetPosition || null,
            tokens: step.tokens || { input: 0, output: 0 },
        }, this._stepTime(step));
        this.world.addAgent(agent);
        this._agentIds.add(agent.id);
    }

    _removeAgent(agentId) {
        if (!agentId || !this._agentIds.has(agentId)) return;
        this.world.removeAgent(agentId);
        this._agentIds.delete(agentId);
    }

    _stepTime(step, offset = 0) {
        const explicit = step?.timestamp ?? step?.time;
        if (Number.isFinite(Number(explicit))) return Number(explicit) + offset;
        const ts = Number.isFinite(Number(step?.ts)) ? Number(step.ts) : 0;
        return this._timeBase + ts + offset;
    }

    _rebaseScenarioTimestamp(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || this._preserveScenarioTimestamps) return timestamp;
        const offset = timestamp - this._scenarioTimeBase;
        if (Math.abs(offset) > SCENARIO_TIMESTAMP_REBASE_WINDOW_MS) return timestamp;
        return this._timeBase + offset;
    }

    _agentById(id) {
        return this.world.agents instanceof Map
            ? this.world.agents.get(id)
            : null;
    }

    _gitEventsFromStep(step, agent) {
        const rawEvents = [];
        if (step.gitEvent) rawEvents.push(step.gitEvent);
        if (Array.isArray(step.gitEvents)) rawEvents.push(...step.gitEvents);
        return rawEvents
            .filter((event) => event && typeof event === 'object')
            .map((event, index) => {
                const explicitTimestamp = Number(event.timestamp ?? event.ts ?? event.time);
                const timestamp = Number.isFinite(explicitTimestamp)
                    ? this._rebaseScenarioTimestamp(explicitTimestamp)
                    : this._stepTime(step, index);
                return {
                    ...clonePlain(event),
                    id: event.id || `${step.agentId}:git:${event.type || event.kind || 'event'}:${this._stepTime(step, index)}`,
                    project: event.project || event.projectPath || agent?.projectPath || '/sim/project',
                    provider: event.provider || agent?.provider || '',
                    timestamp,
                };
            });
    }

    _applyGitEventStep(step) {
        const id = step.agentId;
        if (!id || !this.world.agents.has(id)) return;
        const agent = this._agentById(id);
        const gitEvents = this._gitEventsFromStep(step, agent);
        if (!gitEvents.length) return;
        const updates = {
            gitEvents: [
                ...(Array.isArray(agent?.gitEvents) ? agent.gitEvents : []),
                ...gitEvents,
            ],
            lastSessionActivity: this._stepTime(step),
            activityAgeMs: 0,
        };
        if (step.status) updates.status = step.status;
        if (step.tool) {
            updates.currentTool = step.tool;
            updates.currentToolInput = step.input || null;
            updates.lastTool = step.tool;
            updates.lastToolInput = step.input || null;
        }
        this.world.updateAgent(id, updates);
    }

    _applyToolStep(step) {
        const id = step.agentId;
        if (!id || !this.world.agents.has(id)) return;
        const agent = this._agentById(id);
        const status = step.status || agent?.status || AgentStatus.IDLE;
        const hasFreshTool = step.tool && status === AgentStatus.WORKING;
        const stepTime = this._stepTime(step);
        const updates = {
            status,
            currentTool: hasFreshTool ? step.tool : null,
            currentToolInput: hasFreshTool ? (step.input || null) : null,
            lastTool: step.tool || null,
            lastToolInput: step.input || null,
            lastSessionActivity: stepTime,
            activityAgeMs: 0,
        };
        // For retries, nudge the activity timestamp so AgentEventStream sees a
        // new toolKey (its key incorporates lastSessionActivity).
        if (step.retry) updates.lastSessionActivity = stepTime + 1;
        const position = positionFromSpec(step.position);
        if (position) updates.position = position;
        const targetPosition = positionFromSpec(step.targetPosition);
        if (targetPosition) updates.targetPosition = targetPosition;
        if (step.tokens) updates.tokens = { ...(agent?.tokens || {}), ...step.tokens };
        if (Object.prototype.hasOwnProperty.call(step, 'lastPrompt')) updates.lastPrompt = step.lastPrompt;
        if (Array.isArray(step.todos)) updates.todos = clonePlain(step.todos);
        if (Object.prototype.hasOwnProperty.call(step, 'gitBranch')) updates.gitBranch = step.gitBranch;
        if (Object.prototype.hasOwnProperty.call(step, 'lastMessage')) {
            updates.lastMessage = step.lastMessage;
        }
        const gitEvents = this._gitEventsFromStep(step, agent);
        if (gitEvents.length) {
            updates.gitEvents = [
                ...(Array.isArray(agent?.gitEvents) ? agent.gitEvents : []),
                ...gitEvents,
            ];
        }
        this.world.updateAgent(id, updates);
    }
}
