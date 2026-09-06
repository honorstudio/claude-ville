import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';

/**
 * Resolve the building that may replace an agent's in-flight route.
 *
 * Completed and idle villagers own an ambient route until they arrive. Their
 * status does not identify a new destination, so recomputing one every frame
 * would continuously discard the current path. Directed states still react
 * immediately to status and destination changes.
 */
export function resolveUpdateRouteBuilding({
    activeIntentBuilding = null,
    status = null,
    currentBuilding = null,
    targetBuilding = null,
    lastKnownBuilding = null,
} = {}) {
    if (activeIntentBuilding) return activeIntentBuilding;

    if (status === AgentStatus.WORKING) {
        return targetBuilding || lastKnownBuilding || 'command';
    }
    if (status === AgentStatus.WAITING) {
        return targetBuilding || lastKnownBuilding || 'taskboard';
    }
    if (status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED) {
        return 'watchtower';
    }
    if (status === AgentStatus.WAITING_ON_USER) {
        return 'command';
    }

    return currentBuilding || null;
}
