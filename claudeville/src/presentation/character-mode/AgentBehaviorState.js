import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    clampRouteIndex,
    cloneItinerary,
    inferGoal,
    normalizeGoal,
    normalizeItineraryRoute,
    normalizePhase,
    normalizeRouteStop,
    WORK_ITINERARY_PHASE_INDEX,
    WORK_ITINERARY_ROUTE,
} from './VisitIntentSemantics.js';

const MAX_RECENT_BUILDINGS = 5;
const FAMILY_PLAZA_TTL_MS = 30000;
const PLAN_MODE_PERSIST_MS = 1000;
const RETRY_WINDOW_MS = 20000;
const RETRY_BUFFER_LIMIT = 8;
const RETRY_INPUT_NORMALIZE_LIMIT = 64;
const ACCEPTED_INTENT_HISTORY_LIMIT = 8;
const COMPLETED_VISIT_HISTORY_LIMIT = 8;
const BLOCKED_REASON_HISTORY_LIMIT = 10;
const GOAL_HISTORY_LIMIT = 8;
const ITINERARY_HISTORY_LIMIT = 8;

function boundedPush(list, entry, limit) {
    list.push(entry);
    if (list.length > limit) list.splice(0, list.length - limit);
}

function normalizeItineraryRecord(intent, {
    now,
    building = null,
    phase = null,
    goal = null,
} = {}) {
    const raw = intent?.itinerary || intent?.payload?.itinerary || null;
    const route = normalizeItineraryRoute(raw);
    if (!route.length) return null;
    const resolvedBuilding = normalizeRouteStop(building || intent?.building);
    const explicitIndex = raw?.currentIndex ?? raw?.stepIndex ?? raw?.index;
    let currentIndex = clampRouteIndex(explicitIndex, route);
    if (currentIndex < 0 && resolvedBuilding) currentIndex = route.indexOf(resolvedBuilding);
    if (currentIndex < 0 && phase && WORK_ITINERARY_PHASE_INDEX[phase] != null) {
        currentIndex = clampRouteIndex(WORK_ITINERARY_PHASE_INDEX[phase], route);
    }
    if (currentIndex < 0) currentIndex = 0;
    return {
        id: raw?.id || intent?.id || null,
        label: raw?.label || '',
        goal: normalizeGoal(raw?.goal || goal) || goal || null,
        route,
        currentIndex,
        currentStop: route[currentIndex] || resolvedBuilding || null,
        nextStop: route[currentIndex + 1] || null,
        source: intent?.source || null,
        reason: intent?.reason || null,
        updatedAt: now,
        inferred: !!raw?.inferred,
    };
}

function normalizedIntentRecord(intent, {
    now,
    building = null,
    reason = null,
    phase = null,
    targetTile = null,
} = {}) {
    if (!intent) return null;
    const priority = Number(intent.priority);
    const confidence = Number(intent.confidence);
    const expiresAt = Number(intent.expiresAt);
    const stickyUntil = Number(intent.stickyUntil);
    const resolvedBuilding = intent.building || building || null;
    const resolvedReason = reason || intent.reason || intent.source || null;
    const resolvedPhase = normalizePhase(phase || intent.phase || intent.workingPhase) || null;
    const goal = normalizeGoal(intent.goal || intent.intentGoal || intent.payload?.goal)
        || inferGoal({
            source: intent.source,
            reason: resolvedReason,
            phase: resolvedPhase,
            building: resolvedBuilding,
        });
    return {
        intentId: intent.id || null,
        source: intent.source || null,
        building: resolvedBuilding,
        reason: resolvedReason,
        phase: resolvedPhase,
        goal,
        priority: Number.isFinite(priority) ? priority : null,
        confidence: Number.isFinite(confidence) ? confidence : null,
        label: intent.label || '',
        acceptedAt: now,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        stickyUntil: Number.isFinite(stickyUntil) ? stickyUntil : null,
        targetTile: targetTile ? { ...targetTile } : null,
        itinerary: normalizeItineraryRecord(intent, {
            now,
            building: resolvedBuilding,
            phase: resolvedPhase,
            goal,
        }),
    };
}

function interruptibleForIntent(intent, state) {
    if (!intent) return true;
    if (intent.interruptible === false) return false;
    if (intent.interruptible === true) return true;
    const priority = Number(intent.priority);
    if (state === 'performing' && Number.isFinite(priority) && priority >= 85) return false;
    return true;
}

function normalizeToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') {
        return input.replace(/\s+/g, ' ').trim().slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    }
    try {
        return JSON.stringify(input).slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    } catch {
        return String(input).slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    }
}

export class AgentBehaviorState {
    constructor({ now = Date.now } = {}) {
        this.now = typeof now === 'function' ? now : Date.now;
        this.state = 'roaming';
        this.intentId = null;
        this.building = null;
        this.reason = 'spawn';
        this.targetTile = null;
        this.arrivedAt = null;
        this.cooldownUntil = 0;
        this.lastRerouteAt = 0;
        this.recentBuildings = [];
        this.visitStartedAt = null;
        this.completedVisits = 0;
        this.completedVisitHistory = [];
        this.totalDwellMs = 0;
        this.reroutes = 0;
        this.acceptedIntents = [];
        this.acceptedIntentCount = 0;
        this.blockedReasons = [];
        this.blockedCount = 0;
        this.lastBlockedAt = 0;
        this.lastBlockedReason = null;
        this.currentPhase = 'waiting';
        this.interruptible = true;
        this.currentIntent = null;
        this.currentGoal = null;
        this.goalHistory = [];
        this.currentItinerary = null;
        this.itineraryHistory = [];
        this.familyPlazaPreference = null;
        this.planMode = false;
        this._lastPlanReasonAt = 0;
        this._lastToolKey = null;
        this._retryBuffer = [];
        this.lastRetryAt = 0;
        this.lastRetryCount = 0;
        this.lastRetryTool = null;
    }

    setRoute({
        state = 'traveling',
        intent = null,
        building = null,
        reason = null,
        targetTile = null,
        phase = null,
        interruptible = null,
    } = {}) {
        const time = this.now();
        const intentId = intent?.id || null;
        this.finishVisit();
        if (this.intentId !== intentId || this.building !== building) {
            this.lastRerouteAt = time;
            this.reroutes++;
        }
        this.state = state;
        this.intentId = intentId;
        this.building = building || null;
        this.reason = reason || intent?.reason || (intent ? intent.source : 'ambient');
        this.targetTile = targetTile ? { ...targetTile } : null;
        this.arrivedAt = null;
        this.visitStartedAt = null;
        this.currentPhase = normalizePhase(phase || intent?.phase || intent?.workingPhase) || this._phaseForRoute(state, intent);
        this.interruptible = interruptible != null ? !!interruptible : interruptibleForIntent(intent, state);
        this.currentIntent = normalizedIntentRecord(intent, {
            now: time,
            building: this.building,
            reason: this.reason,
            phase: this.currentPhase,
            targetTile: this.targetTile,
        });
        this.currentGoal = this._goalForRecord(this.currentIntent);
        this.currentItinerary = this._itineraryForRecord(this.currentIntent);
        if (this.currentIntent) {
            this.currentIntent.goal = this.currentGoal;
            this.currentIntent.itinerary = cloneItinerary(this.currentItinerary);
            this._recordAcceptedIntent(this.currentIntent);
            this._recordGoal(this.currentIntent);
            this._recordItinerary(this.currentItinerary);
        }
        this.recordBuilding(building);
    }

    arrive({ state = 'performing', cooldownMs = 0, phase = null, interruptible = null } = {}) {
        const time = this.now();
        this.state = state;
        this.arrivedAt = time;
        this.visitStartedAt = time;
        this.cooldownUntil = cooldownMs > 0 ? time + cooldownMs : 0;
        if (phase) this.currentPhase = normalizePhase(phase) || this.currentPhase;
        if (interruptible != null) {
            this.interruptible = !!interruptible;
        } else if (state === 'performing' && this.currentIntent) {
            this.interruptible = interruptibleForIntent({
                priority: this.currentIntent.priority,
                interruptible: this.interruptible,
            }, state);
        }
    }

    transition(state, reason = null) {
        this.state = state;
        if (reason) this.reason = reason;
        const time = this.now();
        if (state === 'cooldown' && this.cooldownUntil <= time) {
            this.cooldownUntil = time + 1500;
        }
        if (state === 'cooldown' || state === 'blocked' || state === 'wandering' || state === 'roaming') {
            this.interruptible = true;
        }
    }

    acceptIntent(intent, {
        building = null,
        reason = null,
        targetTile = null,
        phase = null,
        interruptible = null,
    } = {}) {
        const time = this.now();
        const record = normalizedIntentRecord(intent, {
            now: time,
            building,
            reason,
            phase,
            targetTile,
        });
        if (!record) return null;
        if (phase) record.phase = normalizePhase(phase) || record.phase;
        this.intentId = record.intentId;
        this.reason = record.reason || this.reason;
        this.currentPhase = record.phase || this.currentPhase;
        this.currentGoal = this._goalForRecord(record);
        this.currentItinerary = this._itineraryForRecord(record);
        record.goal = this.currentGoal;
        record.itinerary = cloneItinerary(this.currentItinerary);
        this.currentIntent = record;
        this.interruptible = interruptible != null ? !!interruptible : interruptibleForIntent(intent, this.state);
        this._recordAcceptedIntent(record);
        this._recordGoal(record);
        this._recordItinerary(this.currentItinerary);
        return record;
    }

    setPhase(phase, { interruptible = null, reason = null } = {}) {
        const normalized = normalizePhase(phase);
        if (normalized) this.currentPhase = normalized;
        if (interruptible != null) this.interruptible = !!interruptible;
        if (reason) this.reason = reason;
    }

    recordBlocked({
        reason = 'blocked',
        building = null,
        intent = null,
        targetTile = null,
        recovery = null,
        fromTile = null,
    } = {}) {
        const time = this.now();
        const entry = {
            reason: String(reason || 'blocked'),
            building: building || this.building || intent?.building || null,
            intentId: intent?.id || this.intentId || null,
            source: intent?.source || this.currentIntent?.source || null,
            phase: normalizePhase(intent?.phase || this.currentPhase) || this.currentPhase,
            goal: normalizeGoal(intent?.goal || this.currentGoal) || this.currentGoal,
            targetTile: targetTile ? { ...targetTile } : (this.targetTile ? { ...this.targetTile } : null),
            fromTile: fromTile ? { ...fromTile } : null,
            recovery: recovery || null,
            at: time,
        };
        this.blockedCount++;
        this.lastBlockedAt = time;
        this.lastBlockedReason = entry.reason;
        boundedPush(this.blockedReasons, entry, BLOCKED_REASON_HISTORY_LIMIT);
        return entry;
    }

    finishVisit() {
        if (this.visitStartedAt) {
            const completedAt = this.now();
            const dwellMs = Math.max(0, completedAt - this.visitStartedAt);
            this.totalDwellMs += dwellMs;
            this.completedVisits++;
            boundedPush(this.completedVisitHistory, {
                intentId: this.intentId,
                building: this.building,
                reason: this.reason,
                phase: this.currentPhase,
                goal: this.currentGoal,
                itinerary: cloneItinerary(this.currentItinerary),
                startedAt: this.visitStartedAt,
                completedAt,
                dwellMs,
                targetTile: this.targetTile ? { ...this.targetTile } : null,
            }, COMPLETED_VISIT_HISTORY_LIMIT);
            this.visitStartedAt = null;
        }
    }

    recordBuilding(type) {
        if (!type) return;
        this.recentBuildings.push(type);
        if (this.recentBuildings.length > MAX_RECENT_BUILDINGS) this.recentBuildings.shift();
    }

    recentCount(type) {
        return this.recentBuildings.filter((entry) => entry === type).length;
    }

    setFamilyPlazaPreference(tileX, tileY) {
        const x = Number(tileX);
        const y = Number(tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this.familyPlazaPreference = { tileX: x, tileY: y, ts: this.now() };
    }

    getFamilyPlazaPreference() {
        if (!this.familyPlazaPreference) return null;
        if (this.now() - this.familyPlazaPreference.ts > FAMILY_PLAZA_TTL_MS) {
            this.familyPlazaPreference = null;
            return null;
        }
        return { ...this.familyPlazaPreference };
    }

    observeToolTransition({ agentId = null, tool = null, input = null, reason = null } = {}) {
        const toolKey = String(tool || '').trim();
        const time = this.now();

        if (reason === 'plan-mode-enter') {
            this.planMode = true;
            this._lastPlanReasonAt = time;
        } else if (reason === 'plan-mode-exit') {
            this.planMode = false;
            this._lastPlanReasonAt = time;
        } else if (this.planMode && toolKey && toolKey !== this._lastToolKey) {
            if (time - this._lastPlanReasonAt > PLAN_MODE_PERSIST_MS) {
                this.planMode = false;
            }
        }

        if (toolKey) {
            const normalized = normalizeToolInput(input);
            const key = `${toolKey}${normalized}`;
            const cutoff = time - RETRY_WINDOW_MS;
            this._retryBuffer = this._retryBuffer.filter((entry) => entry.ts >= cutoff);
            const priorMatches = this._retryBuffer.filter((entry) => entry.key === key);
            this._retryBuffer.push({ key, ts: time });
            if (this._retryBuffer.length > RETRY_BUFFER_LIMIT) {
                this._retryBuffer.splice(0, this._retryBuffer.length - RETRY_BUFFER_LIMIT);
            }
            if (priorMatches.length >= 1) {
                const retryCount = priorMatches.length + 1;
                this.lastRetryAt = time;
                this.lastRetryCount = retryCount;
                this.lastRetryTool = toolKey;
                if (agentId) {
                    eventBus.emit('tool:retried', {
                        agentId,
                        tool: toolKey,
                        retryCount,
                        ts: time,
                    });
                }
            }
        }

        this._lastToolKey = toolKey || this._lastToolKey;
    }

    isRetryGlyphActive(windowMs = 6000) {
        return this.lastRetryAt > 0 && (this.now() - this.lastRetryAt) <= windowMs;
    }

    _phaseForRoute(state, intent) {
        const phase = normalizePhase(intent?.phase || intent?.workingPhase);
        if (phase) return phase;
        if (state === 'cooldown' || state === 'blocked') return 'waiting';
        return this.currentPhase || 'waiting';
    }

    _goalForRecord(record) {
        if (!record) return null;
        return normalizeGoal(record.goal)
            || inferGoal({
                source: record.source,
                reason: record.reason,
                phase: record.phase,
                building: record.building,
            });
    }

    _itineraryForRecord(record) {
        if (!record) return null;
        const explicit = cloneItinerary(record.itinerary);
        if (explicit?.route?.length) {
            explicit.goal = normalizeGoal(explicit.goal || record.goal) || this._goalForRecord(record);
            return explicit;
        }
        return this._inferWorkItinerary(record);
    }

    _inferWorkItinerary(record) {
        const buildingIndex = WORK_ITINERARY_ROUTE.indexOf(normalizeRouteStop(record?.building));
        const phaseIndex = WORK_ITINERARY_PHASE_INDEX[record?.phase];
        const currentIndex = Number.isInteger(phaseIndex) ? phaseIndex : buildingIndex;
        if (currentIndex < 0) return null;
        const source = String(record?.source || '').toLowerCase();
        const historySupportsRoute = this._workRouteHistoryCount(record) >= 2;
        if (!['tool', 'handoff', 'git'].includes(source) && !historySupportsRoute) return null;
        return {
            id: `work-cycle:${record.intentId || record.acceptedAt || 'inferred'}`,
            label: 'Work cycle',
            goal: this._goalForRecord(record),
            route: [...WORK_ITINERARY_ROUTE],
            currentIndex,
            currentStop: WORK_ITINERARY_ROUTE[currentIndex] || null,
            nextStop: WORK_ITINERARY_ROUTE[currentIndex + 1] || null,
            source: record.source || null,
            reason: record.reason || null,
            updatedAt: record.acceptedAt || this.now(),
            inferred: true,
        };
    }

    _workRouteHistoryCount(record) {
        const seen = new Set();
        for (const entry of [...this.completedVisitHistory, ...this.acceptedIntents, record]) {
            const stop = normalizeRouteStop(entry?.building);
            if (WORK_ITINERARY_ROUTE.includes(stop)) seen.add(stop);
        }
        return seen.size;
    }

    _recordGoal(record) {
        const goal = this._goalForRecord(record);
        if (!goal) return;
        const entry = {
            goal,
            intentId: record?.intentId || null,
            building: record?.building || null,
            reason: record?.reason || null,
            phase: record?.phase || null,
            at: record?.acceptedAt || this.now(),
        };
        const previous = this.goalHistory[this.goalHistory.length - 1];
        if (previous?.goal === entry.goal && previous?.intentId === entry.intentId) {
            this.goalHistory[this.goalHistory.length - 1] = entry;
            return;
        }
        boundedPush(this.goalHistory, entry, GOAL_HISTORY_LIMIT);
    }

    _recordItinerary(itinerary) {
        if (!itinerary?.route?.length) return;
        const entry = cloneItinerary(itinerary);
        const previous = this.itineraryHistory[this.itineraryHistory.length - 1];
        const sameRoute = previous?.route?.join('|') === entry.route.join('|');
        if (sameRoute && previous?.currentIndex === entry.currentIndex && previous?.id === entry.id) {
            this.itineraryHistory[this.itineraryHistory.length - 1] = entry;
            return;
        }
        boundedPush(this.itineraryHistory, entry, ITINERARY_HISTORY_LIMIT);
    }

    _recordAcceptedIntent(record) {
        if (!record?.intentId) return;
        const previous = this.acceptedIntents[this.acceptedIntents.length - 1];
        const sameTarget = previous?.targetTile && record.targetTile
            && Math.round(previous.targetTile.tileX) === Math.round(record.targetTile.tileX)
            && Math.round(previous.targetTile.tileY) === Math.round(record.targetTile.tileY);
        if (previous?.intentId === record.intentId && sameTarget) {
            this.acceptedIntents[this.acceptedIntents.length - 1] = record;
            return;
        }
        this.acceptedIntentCount++;
        boundedPush(this.acceptedIntents, record, ACCEPTED_INTENT_HISTORY_LIMIT);
    }

    snapshot() {
        return {
            state: this.state,
            intentId: this.intentId,
            building: this.building,
            reason: this.reason,
            targetTile: this.targetTile ? { ...this.targetTile } : null,
            arrivedAt: this.arrivedAt,
            cooldownUntil: this.cooldownUntil,
            lastRerouteAt: this.lastRerouteAt,
            recentBuildings: [...this.recentBuildings],
            completedVisits: this.completedVisits,
            completedVisitHistory: this.completedVisitHistory.map((visit) => ({ ...visit })),
            totalDwellMs: this.totalDwellMs,
            reroutes: this.reroutes,
            acceptedIntentCount: this.acceptedIntentCount,
            acceptedIntents: this.acceptedIntents.map((entry) => ({ ...entry })),
            blockedCount: this.blockedCount,
            blockedReasons: this.blockedReasons.map((entry) => ({ ...entry })),
            lastBlockedAt: this.lastBlockedAt,
            lastBlockedReason: this.lastBlockedReason,
            currentPhase: this.currentPhase,
            interruptible: this.interruptible,
            currentIntent: this.currentIntent ? { ...this.currentIntent } : null,
            currentGoal: this.currentGoal,
            goalHistory: this.goalHistory.map((entry) => ({ ...entry })),
            currentItinerary: cloneItinerary(this.currentItinerary),
            itineraryHistory: this.itineraryHistory.map((entry) => cloneItinerary(entry)),
            familyPlazaPreference: this.familyPlazaPreference ? { ...this.familyPlazaPreference } : null,
            planMode: this.planMode,
            lastRetryAt: this.lastRetryAt,
            lastRetryCount: this.lastRetryCount,
            lastRetryTool: this.lastRetryTool,
        };
    }
}

export default AgentBehaviorState;
