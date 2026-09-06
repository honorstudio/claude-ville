import test from 'node:test';
import assert from 'node:assert/strict';

import {
    groupTodosByPhase,
    TaskboardBoardModel,
    taskboardBoardLayout,
    taskboardBoardRows,
} from '../../claudeville/src/presentation/character-mode/TaskboardBoardModel.js';

function sprite(agent) {
    return { agent };
}

test('taskboard resolution prefers selected, then pinned, then the latest changed todos', () => {
    const selected = {
        id: 'selected',
        lastActive: 500,
        todos: [{ subject: 'Selected work', status: 'pending' }],
    };
    const pinned = {
        id: 'pinned',
        lastActive: 400,
        todos: [{ subject: 'Pinned work', status: 'in_progress' }],
    };
    const recent = {
        id: 'recent',
        lastActive: 200,
        todos: [{ subject: 'Recent work', status: 'pending' }],
    };
    const older = {
        id: 'older',
        lastActive: 100,
        todos: [{ subject: 'Older work', status: 'pending' }],
    };
    const empty = { id: 'empty', lastActive: 900, todos: [] };
    const sprites = new Map([
        ['selected', sprite(selected)],
        ['pinned', sprite(pinned)],
        ['recent', sprite(recent)],
        ['older', sprite(older)],
        ['empty', sprite(empty)],
    ]);
    const model = new TaskboardBoardModel();
    model.updateAgentSprites(sprites, 100);

    recent.todos = [{ subject: 'Most recently changed', status: 'in_progress' }];
    model.updateAgentSprites(sprites, 200);

    assert.equal(model.resolve({
        candidates: ['selected', 'pinned'],
        agentSprites: sprites,
    }), selected);
    assert.equal(model.resolve({
        candidates: ['empty', 'pinned'],
        agentSprites: sprites,
    }), pinned);
    assert.equal(model.resolve({
        candidates: ['empty'],
        agentSprites: sprites,
    }), recent);

    older.todos = [{ subject: 'Now newest', status: 'pending' }];
    model.updateAgentSprites(sprites, 300);
    model.updateAgentSprites(sprites, 400);
    assert.equal(model.resolve({ candidates: [], agentSprites: sprites }), older);
});

test('taskboard fallback breaks update ties by latest activity and returns null without todos', () => {
    const active = { id: 'active', lastActive: 200, todos: [{ subject: 'Active', status: 'pending' }] };
    const idle = { id: 'idle', lastActive: 100, todos: [{ subject: 'Idle', status: 'pending' }] };
    const model = new TaskboardBoardModel();
    const tied = [sprite(idle), sprite(active)];
    model.updateAgentSprites(tied, 100);

    assert.equal(model.resolve({ candidates: [], agentSprites: tied }), active);

    const empty = [sprite({ id: 'none', todos: [] })];
    model.updateAgentSprites(empty, 200);
    assert.equal(model.resolve({ candidates: [], agentSprites: empty }), null);
});

test('taskboard rows preserve provider order, overflow, and full subjects', () => {
    const todos = Array.from({ length: 9 }, (_, index) => ({
        subject: index === 2 ? 'A deliberately long provider-authored subject that drawing may measure later' : `row ${index}`,
        status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : index === 3 ? 'unknown' : 'pending',
    }));
    const board = taskboardBoardRows(todos, { maxRows: 6 });

    assert.equal(board.rows.length, 6);
    assert.equal(board.overflow, 3);
    assert.equal(board.total, 9);
    assert.equal(board.done, 1);
    assert.deepEqual(board.rows.map(row => row.subject), todos.slice(0, 6).map(todo => todo.subject));
    assert.equal(board.rows[0].done, true);
    assert.equal(board.rows[1].done, false);
    assert.equal(board.rows[3].status, 'unknown');
    assert.equal(board.rows[3].done, false);
    assert.equal(board.rows[2].subject, todos[2].subject);
});

test('taskboard rows render nothing without provider todos and strike completed only', () => {
    assert.equal(taskboardBoardRows([]), null);
    assert.equal(taskboardBoardRows(null), null);
    const board = taskboardBoardRows([
        { subject: 'Exact completed', status: 'completed' },
        { subject: 'Similar but open', status: 'complete' },
        { subject: 'Unknown remains open', status: 'mystery' },
    ]);
    assert.deepEqual(board.rows.map(row => row.done), [true, false, false]);
    assert.equal(board.done, 1);
});

test('taskboard phase groups preserve first-seen phase and item order with truthful counts', () => {
    const todos = [
        { subject: 'A1', status: 'completed', phase: 'I. Resting frame' },
        { subject: 'B1', status: 'pending', phase: 'II. Recognizability' },
        { subject: 'A2', status: 'pending', phase: 'I. Resting frame' },
        { subject: 'Loose', status: 'completed', phase: null },
    ];

    const groups = groupTodosByPhase(todos);
    assert.deepEqual(groups.map(({ phase, done, total }) => ({ phase, done, total })), [
        { phase: 'I. Resting frame', done: 1, total: 2 },
        { phase: 'II. Recognizability', done: 0, total: 1 },
        { phase: null, done: 1, total: 1 },
    ]);
    assert.deepEqual(groups[0].items, [todos[0], todos[2]]);
});

test('taskboard layout expands the first incomplete phase and uses full-list header counts', () => {
    const todos = [
        { subject: 'Rest pose', status: 'completed', phase: 'I. Resting frame' },
        { subject: 'Silhouette', status: 'pending', phase: 'I. Resting frame' },
        { subject: 'Face', status: 'completed', phase: 'II. Recognizability' },
        { subject: 'Walk', status: 'pending', phase: 'III. Life' },
    ];
    const board = taskboardBoardLayout(todos, { maxItemRows: 1 });

    assert.equal(board.done, 2);
    assert.equal(board.total, 4);
    assert.deepEqual(board.rows, [
        { kind: 'phase', text: 'I. Resting frame', done: 1, total: 2, active: true },
        { kind: 'item', text: 'Rest pose', status: 'completed' },
        { kind: 'more', text: '+1 more' },
        { kind: 'phase', text: 'II. Recognizability', done: 1, total: 1, active: false },
        { kind: 'phase', text: 'III. Life', done: 0, total: 1, active: false },
    ]);
});

test('taskboard layout selects the last phase when every item is complete', () => {
    const board = taskboardBoardLayout([
        { subject: 'First', status: 'completed', phase: 'I. Shape' },
        { subject: 'Last', status: 'completed', phase: 'II. Finish' },
    ], { maxItemRows: 2 });

    assert.deepEqual(board.rows, [
        { kind: 'phase', text: 'I. Shape', done: 1, total: 1, active: false },
        { kind: 'phase', text: 'II. Finish', done: 1, total: 1, active: true },
        { kind: 'item', text: 'Last', status: 'completed' },
    ]);
});

test('taskboard flat layout renders capped items directly without phase rows', () => {
    const board = taskboardBoardLayout([
        { subject: 'One', status: 'completed', phase: null },
        { subject: 'Two', status: 'in_progress', phase: null },
        { subject: 'Three', status: 'pending', phase: null },
    ], { maxItemRows: 2 });

    assert.equal(board.done, 1);
    assert.equal(board.total, 3);
    assert.deepEqual(board.rows, [
        { kind: 'item', text: 'One', status: 'completed' },
        { kind: 'item', text: 'Two', status: 'in_progress' },
        { kind: 'more', text: '+1 more' },
    ]);
});

test('taskboard draws the same inset chalk at every zoom level', async () => {
    const { BuildingSprite } = await import('../../claudeville/src/presentation/character-mode/BuildingSprite.js');
    const agent = { id: 'plan', todos: [{ subject: 'Ship', status: 'in_progress' }] };
    const building = Object.create(BuildingSprite.prototype);
    building._taskboardBoardAgent = () => agent;
    building._taskboardViewFor = () => ({ header: 'Plan · 0/1', layout: taskboardBoardLayout(agent.todos) });
    const draw = (zoom) => {
        const calls = [];
        const ctx = new Proxy({ measureText: text => ({ width: text.length * 3 }) }, {
            get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])),
        });
        building._zoom = zoom;
        assert.equal(building._drawTaskboardBoard(ctx, (x, y) => ({ x, y })), true);
        assert.ok(calls.some(([method]) => method === 'fillText'));
        assert.ok(calls.some(([method]) => method === 'clip'));
        return calls;
    };
    assert.deepEqual(draw(1), draw(2));
    assert.deepEqual(draw(0.5), draw(3));
});
