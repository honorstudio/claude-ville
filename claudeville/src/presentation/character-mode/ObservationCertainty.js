// Observation confidence is independent of execution status. Unknown dates stay unknown.
export function resolveObservation(agent, nowMs) {
    const raw = agent?.signalObservedAt ?? agent?.freshness?.observedAt;
    const observedAt = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
    const state = agent?.freshness?.state === 'unavailable' ? 'unavailable'
        : agent?.signalStale === true || agent?.resident === true || agent?.freshness?.state === 'stale' ? 'stale'
            : agent?.freshness?.state === 'fresh' || observedAt !== null ? 'fresh' : 'unavailable';
    return { state, observedAt, ageMs: observedAt !== null && Number.isFinite(nowMs) ? Math.max(0, nowMs - observedAt) : null };
}
