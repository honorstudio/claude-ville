// One priority arbiter for every one-shot cue. Urgent state signals sound
// immediately; routine/scenery bursts share a short aggregation window so a
// busy poll becomes one intelligible answer instead of a wall of beeps.

export const CUE_LANES = Object.freeze({
    NEEDS_YOU: 'needsYou',
    ERRORS: 'errors',
    QUOTA: 'quota',
    ROUTINE: 'routine',
    SCENERY: 'scenery',
});

export const URGENT_CUE_LANES = Object.freeze([
    CUE_LANES.NEEDS_YOU,
    CUE_LANES.ERRORS,
    CUE_LANES.QUOTA,
]);

const LANE_PRIORITY = Object.freeze({
    [CUE_LANES.NEEDS_YOU]: 5,
    [CUE_LANES.ERRORS]: 4,
    [CUE_LANES.QUOTA]: 3,
    [CUE_LANES.ROUTINE]: 2,
    [CUE_LANES.SCENERY]: 1,
});

const KIND_LABELS = Object.freeze({
    arrival: ['arrival', 'arrivals'],
    departure: ['departure', 'departures'],
    recovery: ['recovery', 'recoveries'],
    council: ['council gathering', 'council gatherings'],
    hourBell: ['hour bell', 'hour bells'],
    aurora: ['chronicle milestone', 'chronicle milestones'],
    thunder: ['thunder cue', 'thunder cues'],
});

export function lanePriority(lane) {
    return LANE_PRIORITY[lane] || 0;
}

export function isUrgentCueLane(lane) {
    return URGENT_CUE_LANES.includes(lane);
}

export function compareCuePriority(a, b) {
    return lanePriority(b?.lane) - lanePriority(a?.lane);
}

function aggregateLabel(cues) {
    const counts = new Map();
    for (const cue of cues) counts.set(cue.kind, (counts.get(cue.kind) || 0) + 1);
    const parts = [];
    for (const [kind, count] of counts) {
        const labels = KIND_LABELS[kind] || [kind, `${kind} cues`];
        parts.push(`${count} ${count === 1 ? labels[0] : labels[1]}`);
    }
    return `Routine activity: ${parts.join(', ')}`;
}

// Pure burst collapse. Urgent and explicitly provider-voiced cues are never
// merged. Eligible routine/scenery entries become one honest representative.
export function collapseCueBurst(cues) {
    const source = Array.isArray(cues) ? cues.filter(Boolean) : [];
    const bypass = source.filter(cue => (
        isUrgentCueLane(cue.lane) || cue.aggregate === false
    ));
    const routine = source.filter(cue => (
        !isUrgentCueLane(cue.lane) && cue.aggregate !== false
    ));
    if (!routine.length) return bypass.sort(compareCuePriority);

    const representative = [...routine].sort(compareCuePriority)[0];
    const aggregate = routine.length === 1
        ? representative
        : {
            ...representative,
            eventKind: 'aggregate',
            agentId: null,
            label: aggregateLabel(routine),
            aggregateCount: routine.length,
        };
    return [...bypass, aggregate].sort(compareCuePriority);
}

// Pure role-bus policy. Cues keep a fixed reserved ceiling; urgency creates
// contrast by lowering ambience, never by lifting the cue above that ceiling.
export function computeCueMix(lane, ambientLevel = 1) {
    const ambient = Math.max(0, Math.min(1, Number(ambientLevel) || 0));
    const urgent = isUrgentCueLane(lane);
    const cueBusGain = 0.72;
    const ambientBusGain = ambient * (urgent ? 0.2 : 0.55);
    return {
        ambientBusGain,
        cueBusGain,
        duckDepth: 1 - (urgent ? 0.2 : 0.55),
        masterCeiling: 0.9,
    };
}

export function updateQuietFloor(state = {}, {
    calm = false,
    now = 0,
    enterAfterMs = 30000,
    leaveAfterMs = 4000,
} = {}) {
    const current = state.mode === 'resting' ? 'resting' : 'active';
    if (current === 'active') {
        const calmSince = calm ? (state.calmSince ?? now) : null;
        if (calm && now - calmSince >= enterAfterMs) {
            return { mode: 'resting', calmSince, activeSince: null };
        }
        return { mode: 'active', calmSince, activeSince: null };
    }

    const activeSince = calm ? null : (state.activeSince ?? now);
    if (!calm && now - activeSince >= leaveAfterMs) {
        return { mode: 'active', calmSince: null, activeSince };
    }
    return { mode: 'resting', calmSince: state.calmSince ?? null, activeSince };
}

export function cueLifecycleDecision({ lane, hidden = false, returning = false } = {}) {
    if (returning) return 'discard';
    if (hidden && !isUrgentCueLane(lane)) return 'suppress';
    return 'play';
}

export class CueGovernor {
    constructor({ maxPerMinute = 6, minSpacingMs = 4000, aggregationWindowMs = 180 } = {}) {
        this.maxPerMinute = maxPerMinute;
        this.minSpacingMs = minSpacingMs;
        this.aggregationWindowMs = aggregationWindowMs;
        this._lastByKind = new Map();
        this._recent = [];
        this._routine = [];
        this._routineTimer = null;
        this._routineStartedAt = 0;
        this._preparedRoutine = null;
        this._urgentUntil = 0;
    }

    allow(kind, cooldownMs = 15000, { budget = true, key = kind } = {}) {
        const now = Date.now();
        const last = this._lastByKind.get(key) || 0;
        if (now - last < cooldownMs) return false;

        if (budget) {
            this._recent = this._recent.filter(t => now - t < 60000);
            if (this._recent.length >= this.maxPerMinute) return false;
            const newest = this._recent[this._recent.length - 1];
            if (newest && now - newest < this.minSpacingMs) return false;
            this._recent.push(now);
        }

        this._lastByKind.set(key, now);
        return true;
    }

    submit(cue, play) {
        if (!cue?.lane || typeof play !== 'function') return false;
        if (isUrgentCueLane(cue.lane)) {
            this.clearRoutine();
            const key = cue.agentId == null ? cue.kind : `${cue.kind}:${cue.agentId}`;
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: false, key })) return false;
            this._urgentUntil = Date.now() + Math.max(0, Number(cue.guardMs) || 3000);
            play(cue);
            return true;
        }

        // Routine information is momentary. Drop it during an urgent voice
        // instead of delaying it until the state it described has gone stale.
        if (Date.now() < this._urgentUntil) return false;
        if (cue.aggregate === false) {
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: cue.budget !== false })) {
                return false;
            }
            play(cue);
            return true;
        }
        const queued = { ...cue, play };
        if (!this._routine.length) {
            if (!this.allow(cue.kind, cue.cooldownMs, { budget: cue.budget !== false })) {
                return false;
            }
            this._routineStartedAt = Date.now();
            this._preparedRoutine = {
                cue: queued,
                cancel: play(queued, {
                    prepare: true,
                    delayMs: this.aggregationWindowMs,
                }),
            };
        } else if (compareCuePriority(queued, this._preparedRoutine?.cue) < 0) {
            this._cancelPreparedRoutine();
            const elapsed = Date.now() - this._routineStartedAt;
            this._preparedRoutine = {
                cue: queued,
                cancel: play(queued, {
                    prepare: true,
                    delayMs: Math.max(0, this.aggregationWindowMs - elapsed),
                }),
            };
        }
        this._routine.push(queued);
        if (!this._routineTimer) {
            this._routineTimer = setTimeout(() => this._flushRoutine(), this.aggregationWindowMs);
        }
        return true;
    }

    _flushRoutine() {
        const queued = this._routine;
        this._routine = [];
        this._routineTimer = null;
        const collapsed = collapseCueBurst(queued);
        const cue = collapsed[0];
        const prepared = this._preparedRoutine;
        this._preparedRoutine = null;
        this._routineStartedAt = 0;
        if (!cue || !prepared) return;
        prepared.cue.play(cue, { announceOnly: true });
    }

    clearRoutine() {
        if (this._routineTimer) clearTimeout(this._routineTimer);
        this._cancelPreparedRoutine();
        this._routineTimer = null;
        this._routine = [];
        this._routineStartedAt = 0;
    }

    _cancelPreparedRoutine() {
        const cancel = this._preparedRoutine?.cancel;
        this._preparedRoutine = null;
        if (typeof cancel === 'function') cancel();
    }

    destroy() {
        this.clearRoutine();
        this._recent = [];
        this._urgentUntil = 0;
        this._lastByKind.clear();
    }
}
