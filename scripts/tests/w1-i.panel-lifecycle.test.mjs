import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    resolveClose,
    shouldFocusActivityPanel,
    shouldHandleActivityPanelEscape,
} from '../../claudeville/src/presentation/shared/ActivityPanel.js';

test('activity panel requests focus only for keyboard-origin selection', () => {
    assert.equal(shouldFocusActivityPanel('pointer'), false);
    assert.equal(shouldFocusActivityPanel('keyboard'), true);
});

test('activity panel Escape yields to a modal', () => {
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: true,
        popoverOpen: false,
    }), false);
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: false,
        popoverOpen: false,
    }), true);
    assert.equal(shouldHandleActivityPanelEscape({
        panelOpen: true,
        modalOpen: false,
        popoverOpen: true,
    }), false);
});

test('activity panel closes on agent deselection without re-emitting or moving focus', async () => {
    const source = await readFile(new URL('../../claudeville/src/presentation/shared/ActivityPanel.js', import.meta.url), 'utf8');
    const eventClose = resolveClose({ origin: 'event' });
    assert.deepEqual(eventClose, {
        emit: false,
        stopPolling: true,
        moveFocus: false,
    });
    const handlerStart = source.indexOf('this._onAgentDeselected =');
    const handlerEnd = source.indexOf('this._onAgentUpdated =', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(handler, /this\._onAgentDeselected = \(\) => \{\s*if \(this\._viewMode === 'dashboard'\) \{\s*this\.currentAgent = null;\s*return;\s*\}\s*if \(this\._mode === 'agent' && this\.currentAgent\) this\._close\(\{ origin: 'event' \}\);\s*\};/);
    assert.doesNotMatch(handler, /this\.hide\(\)/);
    assert.match(source, /eventBus\.on\('agent:deselected', this\._onAgentDeselected\);/);
    assert.match(source, /eventBus\.off\('agent:deselected', this\._onAgentDeselected\);/);
    assert.match(source, /this\._mode = null;\s*if \(wasAgent && emit\) emitAgentDeselected\(\);/);

    const bus = {
        emissions: 0,
        listeners: [],
        on(listener) {
            this.listeners.push(listener);
        },
        emit() {
            this.emissions++;
            for (const listener of this.listeners) listener();
        },
    };
    let closeCalls = 0;
    bus.on(() => {
        closeCalls++;
        if (eventClose.emit) bus.emit('agent:deselected');
    });
    bus.emit('agent:deselected');
    assert.equal(closeCalls, 1);
    assert.equal(bus.emissions, 1);
});

test('dashboard mode switches retain selection but dashboard deselection clears it', async () => {
    const source = await readFile(new URL('../../claudeville/src/presentation/shared/ActivityPanel.js', import.meta.url), 'utf8');
    const modeClose = resolveClose({ origin: 'mode' });
    assert.deepEqual(modeClose, {
        emit: false,
        stopPolling: true,
        moveFocus: false,
    });

    const modeHandlerStart = source.indexOf('this._onModeChanged =');
    const modeHandlerEnd = source.indexOf('// Pause polling while the tab is hidden', modeHandlerStart);
    const modeHandler = source.slice(modeHandlerStart, modeHandlerEnd);
    assert.match(modeHandler, /if \(mode === 'dashboard'\) \{\s*if \(this\._mode !== null\) this\._close\(\{ origin: 'mode' \}\);\s*return;\s*\}/);
    assert.match(modeHandler, /if \(mode === 'character' && this\._mode === null && this\.currentAgent\) \{\s*this\.show\(this\.currentAgent\);\s*\}/);
    assert.match(source, /const keepCurrentAgent = origin === 'mode' && wasAgent;\s*const retainedAgent = keepCurrentAgent \? this\.currentAgent : null;/);

    const deselectionStart = source.indexOf('this._onAgentDeselected =');
    const deselectionEnd = source.indexOf('this._onAgentUpdated =', deselectionStart);
    const deselectionHandler = source.slice(deselectionStart, deselectionEnd);
    assert.match(deselectionHandler, /if \(this\._viewMode === 'dashboard'\) \{\s*this\.currentAgent = null;\s*return;\s*\}/);
});

test('activity panel close initiated by the panel emits once and restores focus after stopping polling', () => {
    const decision = resolveClose({ origin: 'panel' });
    assert.deepEqual(decision, {
        emit: true,
        stopPolling: true,
        moveFocus: true,
    });

    const bus = {
        emissions: 0,
        emit() {
            this.emissions++;
        },
    };
    if (decision.emit) bus.emit('agent:deselected');
    assert.equal(bus.emissions, 1);
});

test('sidebar status dots stop pulsing under reduced motion without viewport media queries', async () => {
    const css = await readFile(new URL('../../claudeville/css/sidebar.css', import.meta.url), 'utf8');
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.sidebar__agent-dot--working,\s*\.sidebar__agent-dot--waiting,\s*\.sidebar__agent-dot--rate_limited,\s*\.sidebar__agent-dot--errored,\s*\.sidebar__agent-dot--waiting_on_user\s*\{\s*animation:\s*none\s*;\s*\}\s*\}/);
    assert.doesNotMatch(css, /@media[^\{]*\b(?:width|min-width|max-width)\b/i);
});


test('collapsed sidebar count tracks population while row rendering is suspended', async () => {
    const { Sidebar } = await import('../../claudeville/src/presentation/shared/Sidebar.js');
    const countEl = { textContent: '0' };
    const sidebar = {
        world: { agents: new Map([['one', { id: 'one' }], ['two', { id: 'two' }]]) },
        searchIndex: { has: () => true, search: () => [] },
        _publishSharedFilter() {},
        _isRenderHidden: () => true,
        _setText: (node, value) => { node.textContent = String(value); },
        countEl,
    };
    Sidebar.prototype.render.call(sidebar);
    assert.equal(countEl.textContent, '2');
    sidebar.world.agents.delete('one');
    Sidebar.prototype.render.call(sidebar);
    assert.equal(countEl.textContent, '1');
});

test('the attention shelf renders exceptions while rows are suspended and hides at zero', async () => {
    const { Sidebar } = await import('../../claudeville/src/presentation/shared/Sidebar.js');
    class FakeNode {
        constructor() {
            this.children = [];
            this.classList = { add() {}, remove() {}, toggle() {} };
            this.dataset = {};
            this.style = {};
            this.hidden = false;
            this.textContent = '';
            this.parent = null;
        }
        append(...kids) {
            for (const kid of kids) {
                const at = this.children.indexOf(kid);
                if (at >= 0) this.children.splice(at, 1);
                this.children.push(kid);
                kid.parent = this;
            }
        }
        remove() {
            this.parent?.children.splice(this.parent.children.indexOf(this), 1);
            this.parent = null;
        }
        replaceChildren() { this.children = []; }
        setAttribute() {}
        contains() { return false; }
    }
    const makeNode = () => new FakeNode();
    const previousDocument = globalThis.document;
    const previousNode = globalThis.Node;
    globalThis.Node = FakeNode;
    globalThis.document = { createElement: makeNode, createTextNode: value => value, activeElement: null };
    try {
        const shelfEl = makeNode();
        const agents = new Map([
            ['one', { id: 'one', name: 'One', status: 'waiting_on_user', awaitingSince: 1 }],
            ['two', { id: 'two', name: 'Two', status: 'errored', awaitingSince: 2 }],
        ]);
        const sidebar = Object.assign(Object.create(Sidebar.prototype), {
            world: { agents },
            shelfEl,
            _shelfRows: new Map(),
            _shelfExpanded: false,
            searchIndex: { has: () => true, search: () => [] },
            _publishSharedFilter() {},
            // Rows are suspended; the shelf must still speak.
            _isRenderHidden: () => true,
            countEl: { textContent: '0' },
        });

        Sidebar.prototype.render.call(sidebar);
        assert.equal(shelfEl.hidden, false);
        const [heading, list] = shelfEl.children;
        assert.equal(heading.textContent, '1 NEED YOU · 1 ERROR');
        assert.deepEqual(list.children.map(row => row.children[0].textContent), ['One', 'Two']);

        agents.clear();
        Sidebar.prototype.render.call(sidebar);
        assert.equal(shelfEl.hidden, true);
        assert.equal(list.children.length, 0);
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousNode === undefined) delete globalThis.Node;
        else globalThis.Node = previousNode;
    }
});
