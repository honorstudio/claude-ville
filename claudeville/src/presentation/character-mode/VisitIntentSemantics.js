export const WORKING_PHASES = Object.freeze([
    'reading',
    'editing',
    'testing',
    'researching',
    'coordinating',
    'git',
    'quota/resource',
    'waiting',
]);

export const AGENT_GOALS = Object.freeze([
    'complete-task',
    'assist-parent',
    'monitor-quota',
    'recover-error',
]);

export const WORK_ITINERARY_ROUTE = Object.freeze(['archive', 'forge', 'taskboard', 'harbor']);
export const WORK_ITINERARY_PHASE_INDEX = Object.freeze({
    reading: 0,
    editing: 1,
    testing: 2,
    git: 3,
});

const WORKING_PHASE_SET = new Set(WORKING_PHASES);
const AGENT_GOAL_SET = new Set(AGENT_GOALS);

export function normalizeWorkingPhase(phase) {
    const value = String(phase || '').trim().toLowerCase();
    return WORKING_PHASE_SET.has(value) ? value : null;
}

export const normalizePhase = normalizeWorkingPhase;

export function normalizeGoal(goal) {
    const value = String(goal || '')
        .trim()
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    const aliases = {
        complete: 'complete-task',
        completetask: 'complete-task',
        task: 'complete-task',
        assist: 'assist-parent',
        assistparent: 'assist-parent',
        parent: 'assist-parent',
        monitor: 'monitor-quota',
        monitorquota: 'monitor-quota',
        quota: 'monitor-quota',
        recover: 'recover-error',
        recovererror: 'recover-error',
        error: 'recover-error',
    };
    const normalized = aliases[value] || value;
    return AGENT_GOAL_SET.has(normalized) ? normalized : null;
}

export function inferGoal({ source = null, reason = null, phase = null, building = null, parentId = null } = {}) {
    const sourceKey = String(source || '').toLowerCase();
    const reasonText = String(reason || '').toLowerCase();
    const buildingType = String(building || '').toLowerCase();
    if (sourceKey === 'subagent' || reasonText.includes('parent') || parentId) return 'assist-parent';
    if (
        sourceKey === 'quota'
        || sourceKey === 'token'
        || phase === 'quota/resource'
        || buildingType === 'mine'
        || /\b(quota|context|resource|token|throttle|rate.?limit)\b/.test(reasonText)
    ) {
        return 'monitor-quota';
    }
    if (/\b(fail(?:ed)?|error|errored|reject(?:ed)?|cancel(?:led|ed)?|recover|retry|blocked)\b/.test(reasonText)) {
        return 'recover-error';
    }
    if (sourceKey || phase || buildingType) return 'complete-task';
    return null;
}

export function normalizeRouteStop(stop) {
    const value = typeof stop === 'string'
        ? stop
        : (stop?.building || stop?.buildingType || stop?.type || stop?.id || '');
    return String(value || '').trim().toLowerCase() || null;
}

export function normalizeItineraryRoute(raw) {
    const route = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.route)
            ? raw.route
            : (Array.isArray(raw?.stops) ? raw.stops : raw?.buildings));
    if (!Array.isArray(route)) return [];
    const result = [];
    for (const stop of route) {
        const normalized = normalizeRouteStop(stop);
        if (normalized && result[result.length - 1] !== normalized) result.push(normalized);
    }
    return result;
}

export function clampRouteIndex(index, route) {
    const numeric = Number(index);
    if (!Number.isFinite(numeric) || !route.length) return -1;
    return Math.max(0, Math.min(route.length - 1, Math.round(numeric)));
}

export function cloneItinerary(itinerary) {
    if (!itinerary) return null;
    return {
        ...itinerary,
        route: Array.isArray(itinerary.route) ? [...itinerary.route] : [],
    };
}
