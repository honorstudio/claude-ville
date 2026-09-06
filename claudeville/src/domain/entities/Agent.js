import { AgentStatus, normalizeAgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { AgentBiography } from '../value-objects/AgentBiography.js';
import { i18n } from '../../config/i18n.js';
import { TokenUsage } from '../value-objects/TokenUsage.js';
import { normalizeMood } from '../value-objects/AgentMood.js';
import { buildingForTool } from '../services/ToolIdentity.js';
import { DIALOGUE_STALE_MS, dialogueShape, dialogueWindowMs } from '../../config/dialogue.js';

const AGENT_NAMES_EN = [
    'Ada', 'Alden', 'Ansel', 'Bess', 'Bram', 'Cedric', 'Cora', 'Cyril',
    'Della', 'Dorian', 'Dove', 'Edith', 'Edric', 'Elowen', 'Ember', 'Faye',
    'Fenn', 'Finn', 'Freya', 'Godric', 'Greta', 'Hazel', 'Hollis', 'Hugh',
    'Isolde', 'Ivo', 'Ivy', 'Juno', 'Kael', 'Kira', 'Lena', 'Lorne',
    'Maren', 'Maud', 'Merric', 'Nell', 'Nolan', 'Onyx', 'Opal', 'Orin',
    'Percy', 'Prue', 'Quill', 'Quince', 'Rosa', 'Rune', 'Sable', 'Sage',
    'Signe', 'Silas', 'Tamsin', 'Tess', 'Thane', 'Ulric', 'Ursa', 'Vera',
    'Verity', 'Wren', 'Wystan', 'Yara', 'Yorick', 'Zara', 'Alba', 'Corin',
];

function optionalNumber(value, { nonnegative = false } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || (nonnegative && number < 0)) return null;
    return number;
}

export const TODO_LIMIT = 64;

export function normalizeTodoList(value) {
    return Array.isArray(value)
        ? value.slice(0, TODO_LIMIT).flatMap((todo) => {
            const subject = typeof todo?.subject === 'string' ? todo.subject.trim().slice(0, 200) : '';
            const rawStatus = typeof todo?.status === 'string' ? todo.status.trim().toLowerCase() : '';
            const status = rawStatus === 'completed' || rawStatus === 'in_progress' ? rawStatus : 'pending';
            const phase = typeof todo?.phase === 'string' && todo.phase.trim()
                ? todo.phase.trim().slice(0, 80)
                : null;
            return subject ? [{ subject, status, phase }] : [];
        })
        : [];
}

export class Agent {
    constructor({
        id,
        name,
        model,
        effort,
        status,
        role,
        tokens,
        estimatedCost,
        cost,
        messages,
        teamName,
        projectPath,
        currentTool,
        currentToolInput,
        lastTool,
        lastToolInput,
        lastMessage,
        gitEvents,
        lastPrompt,
        todos,
        gitBranch,
        permissionMode,
        sendMessages,
        provider,
        agentId,
        agentName,
        agentType,
        parentSessionId,
        workflowId,
        workflowName,
        lastSessionActivity,
        activityAgeMs,
        turnState,
        pendingTool,
        pendingSince,
        waitReason,
        awaitingSince,
        turnStartedAt,
        lastTurnDurationMs,
        signalSource,
        signalCertainty,
        signalObservedAt,
        signalStale,
        freshness,
        workingSet,
        lastResults,
        collisions,
        resident,
        departedAt,
        dialogue,
        observedSources,
    }) {
        this.id = id;
        this._customName = !!name; // Whether the name was assigned by a team
        this.name = name || this.generateName();
        this.agentId = agentId || null;
        this.agentName = agentName || name || null;
        this.agentType = agentType || null;
        this.parentSessionId = parentSessionId || null;
        this.workflowId = workflowId || null;
        this.workflowName = workflowName || null;
        // isAdvisor (below) keys off the raw '__advisor' agentName; the
        // display name is remapped once here so every surface (world tags,
        // sidebar, inspector, toasts) reads it as a villager, not a slug.
        if (this.isAdvisor) this.name = 'Advisor';
        this.model = model || 'unknown';
        this.effort = effort || null;
        this.status = normalizeAgentStatus(status);
        this.role = role || 'general';
        this.tokens = TokenUsage.normalize(tokens);
        this.estimatedCost = optionalNumber(estimatedCost, { nonnegative: true });
        this._cost = null;
        this.cost = cost;
        this.messages = messages || [];
        this.teamName = teamName;
        this.projectPath = projectPath;
        this.provider = provider || 'claude';
        this.currentTool = currentTool || null;
        this.currentToolInput = currentToolInput || null;
        this.lastTool = lastTool || currentTool || null;
        this.lastToolInput = lastToolInput || currentToolInput || null;
        this.gitEvents = Array.isArray(gitEvents) ? gitEvents : [];
        // AgentManager normalizes live updates; constructor validation also keeps
        // direct/simulated agents inside the same bounded provider-data contract.
        this.lastPrompt = typeof lastPrompt === 'string' && lastPrompt.trim()
            ? lastPrompt.trim().slice(0, 200)
            : null;
        this.todos = normalizeTodoList(todos);
        this.gitBranch = typeof gitBranch === 'string' && gitBranch.trim()
            ? gitBranch.trim().slice(0, 256)
            : null;
        this.permissionMode = permissionMode ?? null;
        // Transcript-derived turn state (see adapters/turnState.js). `waitReason`
        // says why a WAITING_ON_USER agent is blocked; `resident` marks a session
        // the server is holding past its active window.
        this.turnState = turnState || 'unknown';
        this.pendingTool = pendingTool || null;
        this.pendingSince = optionalNumber(pendingSince);
        this.waitReason = waitReason || null;
        this.awaitingSince = optionalNumber(awaitingSince);
        this.turnStartedAt = optionalNumber(turnStartedAt);
        this.lastTurnDurationMs = optionalNumber(lastTurnDurationMs, { nonnegative: true });
        this.signalSource = signalSource === 'hook' || signalSource === 'transcript'
            ? signalSource
            : null;
        this.signalCertainty = signalCertainty || 'unavailable';
        this.signalObservedAt = signalObservedAt ?? null;
        this.signalStale = signalStale === true;
        this.freshness = freshness || null;
        this.workingSet = Array.isArray(workingSet) ? workingSet.slice(0, 16) : [];
        // Provider-reported outcomes of calls that already finished, newest
        // first and capped by the adapter contract. Absent for providers that
        // report no result record; never inferred from a tool disappearing.
        this.lastResults = Array.isArray(lastResults) ? lastResults.slice(0, 5) : [];
        this.collisions = Array.isArray(collisions) ? collisions : [];
        this.resident = resident === true;
        // A departed agent is no longer present in the live server roster, but
        // remains in the world briefly so burst workloads stay perceptible.
        // This marker is intentionally separate from AgentStatus: departure is
        // presence lifecycle, not another execution state.
        this.departedAt = departedAt !== null
            && departedAt !== undefined
            && Number.isFinite(Number(departedAt))
            ? Number(departedAt)
            : null;
        this.sendMessages = Array.isArray(sendMessages) ? sendMessages : [];
        this.lastSessionActivity = lastSessionActivity || null;
        this.activityAgeMs = Number.isFinite(Number(activityAgeMs)) ? Number(activityAgeMs) : null;
        this._lastMessage = lastMessage || null;
        // Telemetry-derived emotion; kept current by application/MoodService.js.
        this.mood = normalizeMood(null);
        // Provenance-tagged speech from adapters/dialogue.js: the model's own
        // words, with where they came from and whether they were trimmed or
        // redacted. Null means the agent said nothing we can attribute, and the
        // villager stays silent rather than reciting filler.
        this.dialogue = dialogue || null;
        this.observedSources = observedSources || null;
        this.refreshIdentityAppearance();
        this.position = new Position(20 + Math.random() * 10, 20 + Math.random() * 10);
        this.targetPosition = null;
        this.walkFrame = 0;
        this.lastActive = Number(this.lastSessionActivity) || Date.now();
    }

    get isWorking() {
        return !this.isDeparted && this.status === AgentStatus.WORKING;
    }

    get isIdle() {
        return !this.isDeparted && this.status === AgentStatus.IDLE;
    }

    get isWaiting() {
        return !this.isDeparted && this.status === AgentStatus.WAITING;
    }

    get isDeparted() {
        return Number.isFinite(this.departedAt);
    }

    get statusSince() {
        const finite = (...values) => values
            .map(Number)
            .find(value => Number.isFinite(value) && value > 0) || null;
        if (this.status === AgentStatus.WAITING_ON_USER) {
            return finite(
                this.awaitingSince,
                this.pendingSince,
                this.turnStartedAt,
                this.lastSessionActivity,
                this.lastActive,
            );
        }
        if (this.status === AgentStatus.WORKING) {
            return finite(
                this.turnStartedAt,
                this.pendingSince,
                this.lastSessionActivity,
                this.lastActive,
            );
        }
        if (this.status === AgentStatus.WAITING) {
            return finite(
                this.pendingSince,
                this.turnStartedAt,
                this.lastSessionActivity,
                this.lastActive,
            );
        }
        return finite(this.lastSessionActivity, this.lastActive);
    }

    get isSubagent() {
        return !!this.parentSessionId || (this.agentType && this.agentType !== 'main');
    }

    // omp advisor threads arrive as subagent sessions literally named
    // '__advisor'. The pairing with the parent session is a first-class
    // relationship in the village (tether + shadowing), so detect it here
    // once instead of re-matching the raw name in every consumer.
    get isAdvisor() {
        return !!this.parentSessionId && String(this.agentName || '') === '__advisor';
    }

    get isToolFresh() {
        return !this.isDeparted && this.status === AgentStatus.WORKING && !!this.currentTool;
    }

    get cost() {
        if (this._cost) return this._cost;
        const estimate = TokenUsage.estimateCost(this.tokens, this.model, this.provider);
        estimate.source = 'estimate';
        estimate.rateRevision = TokenUsage.rateRevision;
        return estimate;
    }

    set cost(value) {
        if (!value || typeof value !== 'object' || (value.usd !== null && !Number.isFinite(Number(value.usd)))) {
            this._cost = null;
            return;
        }
        const normalized = {
            usd: value.usd === null ? null : Math.max(0, Number(value.usd)),
            availability: value.availability || (value.usd === null ? 'unavailable' : 'observed'),
            source: value.source === 'provider' ? 'provider' : 'estimate',
            rateMatch: value.rateMatch == null ? null : String(value.rateMatch),
            rateRevision: String(value.rateRevision || TokenUsage.rateRevision),
            unknownModel: value.unknownModel === true,
        };
        Object.defineProperty(normalized, 'valueOf', {
            value: () => normalized.usd,
            enumerable: false,
        });
        this._cost = normalized;
    }

    get lastMessage() {
        return this._lastMessage || this.messages[this.messages.length - 1] || null;
    }

    get displayName() {
        const raw = String(this.name || '').trim();
        if (!raw) {
            return Agent.generateNameForLang(Appearance.hashCode(this.id), i18n.lang);
        }
        const CAP = 14;
        if (raw.length <= CAP) return raw;
        const words = raw.split(/\s+/);
        let out = '';
        for (const w of words) {
            const next = out ? `${out} ${w}` : w;
            if (next.length > CAP - 1) break;
            out = next;
        }
        if (!out) out = raw.slice(0, CAP - 1);
        return out + '…';
    }

    update(data) {
        const updates = { ...(data || {}) };
        if (Object.prototype.hasOwnProperty.call(updates, 'lastMessage')) {
            updates._lastMessage = updates.lastMessage || null;
            delete updates.lastMessage;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'tokens')) {
            updates.tokens = TokenUsage.normalize(updates.tokens);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'todos')) {
            updates.todos = normalizeTodoList(updates.todos);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
            updates.status = normalizeAgentStatus(updates.status, this.status || AgentStatus.IDLE);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'name') && !updates.name) {
            // Keep the name already assigned (possibly a collision-probed one)
            // rather than reverting to the base pool pick on every WS update.
            updates.name = this.name || this.generateName();
        }
        Object.assign(this, updates);
        // WS updates replay the raw '__advisor' session name; re-apply the
        // villager-facing remap (mirrors the constructor).
        if (this.isAdvisor && this.name === '__advisor') this.name = 'Advisor';
        this.refreshIdentityAppearance();
        this.lastActive = Date.now();
    }

    /**
     * Return the target building type for the current tool
     */
    get targetBuildingType() {
        const toolName = this.currentTool;
        if (!toolName) return null;
        return buildingForTool(toolName, this.currentToolInput || this.lastToolInput);
    }

    get lastKnownBuildingType() {
        return this.targetBuildingType
            || buildingForTool(this.lastTool, this.lastToolInput || this.currentToolInput)
            || null;
    }

    /**
     * The line this villager is currently saying, or null for silence.
     *
     * Every field comes from the adapter-side dialogue contract: the model's
     * own words, tagged with origin and whether they were trimmed or redacted.
     * There is deliberately no fallback — no preset pool, no tool label dressed
     * as speech, no invented filler. When there is nothing attributable to say,
     * the villager says nothing and the renderer shows status glyphs only.
     *
     * How long a line survives depends on what the agent is doing, because
     * "still current" means different things per status. A working agent's line
     * decays on the normal window; a finished agent's parting summary fades
     * faster; an agent blocked on the operator holds its question until the
     * wait ends, and that held line is flagged so the tooltip can say so.
     *
     * Text is NOT truncated here. The renderer fits it by measured pixel width,
     * so truncation happens once, where the font and bubble width are known.
     */
    speech(now = Date.now()) {
        if (this.isDeparted) return null;
        const dialogue = this.dialogue;
        if (!dialogue?.text) return null;
        const observedAt = Number(dialogue.observedAt);
        if (!Number.isFinite(observedAt)) return null;
        const age = now - observedAt;
        // Stale dialogue describes work the agent has already moved on from.
        if (age > dialogueWindowMs(this.status, dialogue.kind)) return null;
        return {
            text: dialogue.text,
            full: dialogue.full || null,
            kind: dialogue.kind,
            source: dialogue.source,
            fidelity: dialogue.fidelity,
            redacted: dialogue.redacted === true,
            // Retained past the point a working agent would have fallen silent,
            // so the operator is told the line is a standing question rather
            // than something just said.
            held: age > DIALOGUE_STALE_MS,
            observedAt,
            actionId: dialogue.actionId || null,
            shape: dialogueShape(dialogue.kind),
        };
    }

    generateName(usedNames = null) {
        const hash = Appearance.hashCode(this.id);
        return Agent.generateNameForLang(hash, i18n.lang, usedNames);
    }

    refreshIdentityAppearance() {
        const identityKey = AgentBiography.identityKeyFor(this);
        this.appearance = Appearance.fromIdentityKey(identityKey || this.id);
        return this.appearance;
    }

    // Deterministic: the hash picks a starting index; when `usedNames` already
    // holds that name, probe subsequent indices (mod pool size) until a free
    // one is found, so live agents keep distinct fallback names.
    static generateNameForLang(hash, lang, usedNames = null) {
        const pool = AGENT_NAMES_EN;
        const start = Math.abs(hash) % pool.length;
        if (!usedNames || usedNames.size === 0) return pool[start];
        for (let i = 0; i < pool.length; i++) {
            const candidate = pool[(start + i) % pool.length];
            if (!usedNames.has(candidate)) return candidate;
        }
        return pool[start];
    }

}
