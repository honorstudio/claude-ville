// C4 — the inspection aperture model (plan 4.1) and the occupied-room slot
// allocator it feeds (plan 4.2).
//
// Both are pure: the aperture is a *presentation* of the sessions the building
// panel already lists (presence/signal/queue split in
// `shared/BuildingInstrumentModel.js`), never the sprite's physical position.
// Nothing here invents an occupant, and `overflow` is always an exact count —
// never "many", never a percentage.

// Explicit inspection only: the aperture opens on selection at this zoom or
// closer. Below it the exterior is untouched and the building keeps its
// ordinary counts.
export const APERTURE_MIN_ZOOM = 2;

const TOOL_LABEL_LIMIT = 12;
const NAME_LIMIT = 10;

function text(value, limit) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function capacityOf(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Build the C4 aperture record.
 *
 * `sessions` are already ordered by the caller's stable slot allocation, so a
 * session keeps its desk while it remains assigned. Each entry carries
 * `{ agentId, name, tool, status, observation, visiting }`; `observation` is
 * the C1 record from `ObservationCertainty.resolveObservation`.
 *
 * `source` reports where the presented occupants came from: `visit` when every
 * presented session is physically inside the building's visit tiles, `signal`
 * when the set includes sessions assigned to the building that have not
 * arrived. A slot never claims a physical position either way.
 */
export function buildApertureModel({ buildingType, capacity, sessions = [] } = {}) {
    const type = String(buildingType || '').trim();
    const seats = capacityOf(capacity);
    const seen = new Set();
    const presented = [];
    for (const session of Array.isArray(sessions) ? sessions : []) {
        const agentId = session?.agentId;
        if (typeof agentId !== 'string' || !agentId || seen.has(agentId)) continue;
        seen.add(agentId);
        presented.push(session);
    }
    const slots = presented.slice(0, seats).map((session) => ({
        agentId: session.agentId,
        name: text(session.name || session.agentId, NAME_LIMIT),
        tool: text(session.tool, TOOL_LABEL_LIMIT) || null,
        status: session.status || null,
        observation: session.observation || null,
    }));
    return {
        buildingType: type,
        slots,
        overflow: Math.max(0, presented.length - slots.length),
        source: presented.length && presented.every((session) => session.visiting === true)
            ? 'visit'
            : 'signal',
    };
}

/**
 * Stable room allocation (4.2). A working occupant keeps the same window for
 * as long as it keeps working here: leaving work frees exactly that room and
 * no other bulb moves. Waiting is not a failed bulb — waiting occupants are
 * never assigned a room, they are counted.
 *
 * `previous` is the prior `Map<agentId, roomIndex>`; the returned map is a new
 * one so the caller can diff it. Never returns more assignments than `rooms`;
 * everyone who does not fit is reported in `overflow` as an exact count.
 */
export function assignRoomSlots({ previous, workingIds = [], rooms = 0 } = {}) {
    const capacity = capacityOf(rooms);
    const working = [];
    const seen = new Set();
    for (const id of Array.isArray(workingIds) ? workingIds : []) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        working.push(id);
    }
    const assignment = new Map();
    const taken = new Set();
    for (const id of working) {
        const held = previous instanceof Map ? previous.get(id) : undefined;
        if (Number.isInteger(held) && held >= 0 && held < capacity && !taken.has(held)) {
            assignment.set(id, held);
            taken.add(held);
        }
    }
    let next = 0;
    for (const id of working) {
        if (assignment.has(id)) continue;
        while (next < capacity && taken.has(next)) next++;
        if (next >= capacity) break;
        assignment.set(id, next);
        taken.add(next);
    }
    return { assignment, overflow: Math.max(0, working.length - assignment.size) };
}
