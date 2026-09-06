import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingInstrumentModel, BUILDING_INSTRUMENT_NAME_LIMIT } from '../../claudeville/src/presentation/shared/BuildingInstrumentModel.js';

test('unknown denominators remain unavailable rather than borrowing physical or allocator capacity', () => {
    const agent = { id: 'a', name: 'A', status: 'working' };
    const unknown = buildBuildingInstrumentModel({ building: {}, assignedAgents: [agent], load: { capacity: 5 } });
    assert.deepEqual(unknown.presence, { count: 0, capacity: null });
    assert.deepEqual(unknown.signal, { count: 1, capacity: null });
    const partial = buildBuildingInstrumentModel({ building: { capacity: { work: 5, ambient: null } } });
    assert.equal(partial.presence.capacity, null);
    assert.equal(partial.signal.capacity, 5);
    const zero = buildBuildingInstrumentModel({ building: { capacity: { work: 0, ambient: 0 } } });
    assert.deepEqual(zero.presence, { count: 0, capacity: 0 });
    assert.deepEqual(zero.signal, { count: 0, capacity: 0 });
});

test('physical visitors, working assignments and waiting slots never masquerade as each other', () => {
    const assignedAgents = [
        { id: 'lead', name: 'Marshal', status: 'working' },
        { id: 'runner', name: 'Courier', status: 'working' },
        { id: 'scribe', name: 'Ledger', status: 'waiting' },
    ];
    const model = buildBuildingInstrumentModel({
        building: { capacity: { work: 5, ambient: 3, overflow: 3 }, description: 'Team status' },
        occupants: [], assignedAgents, routeAgents: [assignedAgents[1]],
        presence: { count: 9 }, load: { occupied: 7, reserved: 8, queued: 4 },
    });
    assert.deepEqual(model.presence, { count: 0, capacity: 11 });
    assert.deepEqual(model.signal, { count: 2, capacity: 5 });
    assert.deepEqual(model.queue.map(entry => entry.state), ['Assigned', 'Inbound', 'Waiting']);
    const visiting = buildBuildingInstrumentModel({ assignedAgents, occupants: [assignedAgents[0]], reservations: [{ agentId: 'runner', queueOverflow: true }] });
    assert.deepEqual(visiting.queue.map(entry => [entry.agentId, entry.state]), [['runner', 'Waiting for slot'], ['scribe', 'Waiting']]);
});

test('overflow retains every unique selectable name and exposes the exact hidden count', () => {
    const assignedAgents = Array.from({ length: 100 }, (_, index) => ({ id: `a${index}`, name: `Agent ${index}`, status: 'waiting' }));
    const model = buildBuildingInstrumentModel({ assignedAgents, routeAgents: assignedAgents.slice(0, 9) });
    const visible = model.queue.slice(0, BUILDING_INSTRUMENT_NAME_LIMIT);
    const hidden = model.queue.slice(BUILDING_INSTRUMENT_NAME_LIMIT);
    assert.equal(hidden.length, 96);
    assert.deepEqual([...visible, ...hidden].map(entry => entry.agentId), assignedAgents.map(agent => agent.id));
    assert.equal(hidden.at(-1).name, 'Agent 99');
});
