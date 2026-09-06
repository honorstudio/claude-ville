export const AgentStatus = {
    WORKING: 'working',
    IDLE: 'idle',
    WAITING: 'waiting',
    COMPLETED: 'completed',
    RATE_LIMITED: 'rate_limited',
    ERRORED: 'errored',
    WAITING_ON_USER: 'waiting_on_user',
};

const KNOWN_STATUSES = new Set(Object.values(AgentStatus));

export function normalizeAgentStatus(status, fallback = AgentStatus.IDLE) {
    const normalized = String(status || fallback || AgentStatus.IDLE).toLowerCase();
    if (normalized === 'active') return AgentStatus.WORKING;
    return KNOWN_STATUSES.has(normalized) ? normalized : fallback;
}

export function statusFromSessionActivity(session = {}, now = Date.now()) {
    const rawStatus = String(session.status || '').toLowerCase();
    const normalized = normalizeAgentStatus(rawStatus);
    if (rawStatus !== 'active') return normalized;

    const age = now - (Number(session.lastActivity || 0) || 0);
    if (age < 30000) return AgentStatus.WORKING;
    if (age < 120000) return AgentStatus.WAITING;
    return AgentStatus.IDLE;
}
