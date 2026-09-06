import test from 'node:test';
import assert from 'node:assert/strict';

import {
    APERTURE_MIN_ZOOM,
    assignRoomSlots,
    buildApertureModel,
} from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';

const session = (agentId, extra = {}) => ({
    agentId,
    name: agentId.toUpperCase(),
    tool: 'spawn_agent',
    status: 'working',
    observation: { state: 'fresh', observedAt: 1, ageMs: 0 },
    visiting: false,
    ...extra,
});

test('aperture presents at most the authored desks and an exact overflow', () => {
    const model = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: ['a', 'b', 'c', 'd', 'e'].map((id) => session(id)),
    });
    assert.equal(model.slots.length, 3);
    assert.deepEqual(model.slots.map((slot) => slot.agentId), ['a', 'b', 'c']);
    assert.equal(model.overflow, 2);
});

test('overflow is zero and slots empty when nothing is assigned', () => {
    const model = buildApertureModel({ buildingType: 'command', capacity: 3, sessions: [] });
    assert.deepEqual(model.slots, []);
    assert.equal(model.overflow, 0);
});

test('a session is never presented twice', () => {
    const model = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a'), session('a'), session('b')],
    });
    assert.deepEqual(model.slots.map((slot) => slot.agentId), ['a', 'b']);
    assert.equal(model.overflow, 0);
});

test('source distinguishes physically present occupants from assigned sessions', () => {
    const visiting = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a', { visiting: true }), session('b', { visiting: true })],
    });
    assert.equal(visiting.source, 'visit');
    const mixed = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a', { visiting: true }), session('b')],
    });
    assert.equal(mixed.source, 'signal');
});

test('a slot carries the reported tool and status without claiming an outcome', () => {
    const [slot] = buildApertureModel({
        buildingType: 'command',
        capacity: 1,
        sessions: [session('a', { status: 'waiting_on_user', tool: 'wait agent' })],
    }).slots;
    assert.equal(slot.status, 'waiting_on_user');
    assert.equal(slot.tool, 'wait agent');
    assert.equal(slot.observation.state, 'fresh');
});

test('a label too long for a desk row is clipped, never wrapped onto the world', () => {
    const [slot] = buildApertureModel({
        buildingType: 'command',
        capacity: 1,
        sessions: [session('a', { name: 'Quartermaster General', tool: 'run_a_very_long_command' })],
    }).slots;
    assert.ok(slot.name.length <= 10, slot.name);
    assert.ok(slot.tool.length <= 12, slot.tool);
});

test('the aperture only opens at inspection zoom', () => {
    assert.equal(APERTURE_MIN_ZOOM, 2);
});

test('a working occupant keeps its room while it keeps working', () => {
    const first = assignRoomSlots({ previous: null, workingIds: ['a', 'b'], rooms: 3 });
    assert.deepEqual([...first.assignment.entries()], [['a', 0], ['b', 1]]);
    // 'a' stops working: only its room goes dark, 'b' does not move.
    const second = assignRoomSlots({ previous: first.assignment, workingIds: ['b'], rooms: 3 });
    assert.deepEqual([...second.assignment.entries()], [['b', 1]]);
    // A new worker takes the freed room, not 'b' s.
    const third = assignRoomSlots({ previous: second.assignment, workingIds: ['b', 'c'], rooms: 3 });
    assert.equal(third.assignment.get('b'), 1);
    assert.equal(third.assignment.get('c'), 0);
});

test('never more lit rooms than the art has; the surplus is an exact count', () => {
    const { assignment, overflow } = assignRoomSlots({
        previous: null,
        workingIds: ['a', 'b', 'c', 'd'],
        rooms: 2,
    });
    assert.equal(assignment.size, 2);
    assert.equal(overflow, 2);
});

test('rooms with no workers light nothing', () => {
    const { assignment, overflow } = assignRoomSlots({ previous: null, workingIds: [], rooms: 3 });
    assert.equal(assignment.size, 0);
    assert.equal(overflow, 0);
});
