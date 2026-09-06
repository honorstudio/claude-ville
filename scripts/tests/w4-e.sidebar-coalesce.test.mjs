import assert from 'node:assert/strict';
import test from 'node:test';

import { Sidebar } from '../../claudeville/src/presentation/shared/Sidebar.js';

function makeSidebar() {
    const frames = [];
    const cancelledFrames = [];
    const sidebar = Object.assign(Object.create(Sidebar.prototype), {
        _destroyed: false,
        _reactiveFrame: null,
        _reactiveFrameGeneration: 0,
        _pendingAgentChanges: new Map(),
        _reactiveRenderPending: false,
        _workflowPruneTimer: null,
        _workflowPruneAt: 0,
        _detailIndexTimer: null,
        _filter: '',
        _renderSignature: '',
        _seenWorkflows: new Set(),
        _collapsedWorkflows: new Set(),
        _workflowLastSeenAt: new Map(),
        _renderCalls: 0,
        _renderedSelection: null,
        _indexedAgents: [],
        selection: {
            selectedId: null,
            destroy() {},
        },
        searchIndex: {
            remove() {},
            clear() {},
        },
    });

    sidebar._requestAnimationFrame = callback => {
        frames.push(callback);
        return frames.length;
    };
    sidebar._cancelAnimationFrame = frame => cancelledFrames.push(frame);
    sidebar._indexAgent = agent => sidebar._indexedAgents.push(agent.id);
    sidebar.render = () => {
        sidebar._renderCalls++;
        sidebar._renderedSelection = sidebar.selection.selectedId;
    };

    return { sidebar, frames, cancelledFrames };
}

test('coalesces a burst into one reindex pass and one render of final selection', () => {
    const { sidebar, frames } = makeSidebar();
    let reindexPasses = 0;
    const reindex = sidebar._reindexPendingAgentChanges.bind(sidebar);
    sidebar._reindexPendingAgentChanges = () => {
        reindexPasses++;
        return reindex();
    };

    const agents = ['ada', 'beau', 'clio'].map(id => ({ id }));
    for (const agent of agents) sidebar._handleAgentUpdate(agent);
    // The final operation for one agent replaces its earlier queued update.
    sidebar._handleAgentUpdate({ id: 'ada', status: 'idle' });
    sidebar.selection.selectedId = 'clio';

    assert.equal(frames.length, 1);
    assert.equal(sidebar._renderCalls, 0);

    frames[0]();

    assert.equal(reindexPasses, 1);
    assert.equal(sidebar._renderCalls, 1);
    assert.deepEqual(sidebar._indexedAgents.sort(), ['ada', 'beau', 'clio']);
    assert.equal(sidebar._renderedSelection, 'clio');
});

test('filter input flushes pending reactive work and renders immediately', () => {
    const { sidebar, frames, cancelledFrames } = makeSidebar();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar._handleFilterInput({ target: { value: '  Ada ' } });

    assert.equal(sidebar._filter, 'ada');
    assert.equal(sidebar._renderCalls, 1);
    assert.deepEqual(sidebar._indexedAgents, ['ada']);
    assert.deepEqual(cancelledFrames, [1]);

    // A cancelled callback must be harmless if the browser had already queued it.
    frames[0]();
    assert.equal(sidebar._renderCalls, 1);

    sidebar._handleAgentUpdate({ id: 'beau' });
    frames[0]();
    assert.equal(sidebar._renderCalls, 1);
    frames[1]();
    assert.equal(sidebar._renderCalls, 2);
});

test('workflow collapse click flushes pending work before its synchronous render', () => {
    const { sidebar, cancelledFrames } = makeSidebar();
    const toggle = { dataset: { workflowId: 'workflow-1' } };
    sidebar.listEl = {
        addEventListener(_type, callback) {
            sidebar._onListClick = callback;
        },
        contains(node) {
            return node === toggle;
        },
    };
    sidebar._bindListClick();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar._onListClick({
        target: {
            closest() {
                return toggle;
            },
        },
    });

    assert.equal(sidebar._renderCalls, 1);
    assert.equal(sidebar._collapsedWorkflows.has('workflow-1'), true);
    assert.deepEqual(cancelledFrames, [1]);
});

test('destroy cancels the pending frame and prevents its callback from rendering', () => {
    const { sidebar, frames, cancelledFrames } = makeSidebar();
    sidebar._handleAgentUpdate({ id: 'ada' });

    sidebar.destroy();

    assert.deepEqual(cancelledFrames, [1]);
    assert.equal(sidebar._reactiveFrame, null);
    frames[0]();
    assert.equal(sidebar._renderCalls, 0);
    assert.deepEqual(sidebar._indexedAgents, []);
});
