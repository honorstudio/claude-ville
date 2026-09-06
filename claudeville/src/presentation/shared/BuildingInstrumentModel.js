import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';

export const BUILDING_INSTRUMENT_NAME_LIMIT = 4;

function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value) : null;
}

function agentList(value) {
    return Array.isArray(value) ? value : [];
}

// Presence is the domain visit test; work signal is assigned WORKING sessions,
// not LandmarkActivity's sprite-position count or the allocator's reservations.
//
// Only the keys read below cross into the model. An unknown key on the payload
// — a stray `load`, a raw building-signal blob, a legacy `occupancy` field —
// is ignored rather than borrowed as a count, a denominator or a queue row, and
// a collection that arrives missing or non-array reads as empty instead of
// throwing.
export function buildBuildingInstrumentModel(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const building = source.building && typeof source.building === 'object' ? source.building : {};
    const occupants = agentList(source.occupants);
    const assignedAgents = agentList(source.assignedAgents);
    const routeAgents = agentList(source.routeAgents);
    const reservations = agentList(source.reservations);
    const external = source.external;
    const capacities = building.capacity && typeof building.capacity === 'object'
        ? Object.values(building.capacity).map(count) : [];
    const presenceCapacity = capacities.length && capacities.every(value => value !== null)
        ? capacities.reduce((sum, value) => sum + value, 0)
        : count(building.capacity);
    const visiting = new Set(occupants.map(agent => agent?.id));
    const inbound = new Set(routeAgents.map(agent => agent?.id));
    const queued = new Set(reservations.filter(reservation => (
        reservation?.queueOverflow || Number(reservation?.queueIndex) > 0 || Number(reservation?.queued) > 0
    )).map(reservation => reservation.agentId));
    const queue = [];
    const seen = new Set();
    for (const agent of [...assignedAgents, ...routeAgents, ...occupants]) {
        if (!agent?.id || seen.has(agent.id)) continue;
        seen.add(agent.id);
        const waiting = agent.status === AgentStatus.WAITING || agent.status === AgentStatus.WAITING_ON_USER;
        if (visiting.has(agent.id) && !waiting && !queued.has(agent.id)) continue;
        queue.push({
            agentId: agent.id,
            name: agent.displayName || agent.name || agent.id,
            state: queued.has(agent.id) ? 'Waiting for slot'
                : agent.status === AgentStatus.WAITING_ON_USER ? 'Needs you'
                    : waiting ? 'Waiting' : inbound.has(agent.id) ? 'Inbound' : 'Assigned',
        });
    }
    return {
        presence: { count: occupants.length, capacity: presenceCapacity },
        signal: {
            count: count(external?.counts?.working) ?? assignedAgents.filter(agent => agent.status === AgentStatus.WORKING).length,
            capacity: count(building.capacity?.work),
        },
        queue,
        purpose: typeof building.description === 'string' ? building.description : 'Purpose unavailable',
    };
}
