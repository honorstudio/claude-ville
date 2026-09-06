import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChronicleMarkdown,
    ChroniclePanel,
    csvEscapeCell,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import { ChronicleEventKind, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { Toast } from '../../claudeville/src/presentation/shared/Toast.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';
import { DashboardRenderer } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    add(value) {
        const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
        names.add(value);
        this.owner.className = [...names].join(' ');
    }
}

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
}

function toastHarness() {
    const container = new FakeElement();
    const listeners = new Map();
    const eventTarget = {
        on(name, listener) {
            listeners.set(name, listener);
            return () => listeners.delete(name);
        },
        emit(name, payload) {
            listeners.get(name)?.(payload);
        },
    };
    const documentRef = {
        getElementById(id) { return id === 'toastContainer' ? container : null; },
        createElement() { return new FakeElement(); },
    };
    const toast = new Toast({ eventTarget, documentRef });
    return { container, eventTarget, toast };
}

function chronicleEvent(overrides = {}) {
    return {
        ts: Date.UTC(2026, 7, 25, 9, 5),
        kind: ChronicleEventKind.COMMIT,
        agentName: 'Ada',
        provider: 'codex',
        project: 'village',
        label: 'Ship the chronicle',
        ...overrides,
    };
}

test('Chronicle CSV treats leading whitespace/control formula prefixes as dangerous and quotes tabs', () => {
    for (const value of ['\t=SUM(A1)', ' \t+cmd', '\u0000@mention', '\r\n-2+3']) {
        const escaped = csvEscapeCell(value);
        assert.equal(escaped.startsWith('"\'') || escaped.startsWith("'"), true, value);
        assert.equal(escaped.includes('\t'), value.includes('\t'));
        assert.equal(escaped.includes('\r'), value.includes('\r'));
    }
    assert.equal(csvEscapeCell('ordinary\tlabel').startsWith('"'), true);
});

test('Chronicle Markdown neutralizes links, images, raw HTML, and cell-breaking controls', () => {
    const markdown = buildChronicleMarkdown({
        dateKey: '2026-08-24',
        events: [chronicleEvent({
            label: '![x](https://tracker.example/pixel.png) <img src="https://tracker.example/a"> [open](https://tracker.example)',
        })],
        summary: summarizeDay([]),
    });

    assert.doesNotMatch(markdown, /!\[/);
    assert.doesNotMatch(markdown, /\]\(/);
    assert.doesNotMatch(markdown, /<\/?(?:img|a|script)\b/i);
    assert.doesNotMatch(markdown, /<br\s*\/?\s*>/i);
    assert.match(markdown, /&lt;img/);
    assert.match(markdown, /\\!\\\[/);
});

test('BGM event cues preserve agent identity, provider, spatial, and urgency payloads', () => {
    const director = new BgmDirector({ engine: {} });
    const cues = [];
    director.cueKit = {
        play(kind, payload) {
            cues.push({ kind, payload });
            return true;
        },
    };
    director.running = true;
    director._subscribe();

    try {
        eventBus.emit('village:scene', {
            kind: 'arrival',
            agentId: 'agent-ada',
            agent: { id: 'agent-ada', name: 'Ada', provider: 'claude' },
            position: { tileX: 4, tileY: 2 },
        });
        eventBus.emit('distress:watchtower', {
            kind: 'errored',
            agentId: 'agent-ada',
            label: 'Ada',
            provider: 'claude',
            position: { tileX: 4, tileY: 2 },
        });
        eventBus.emit('attention:raised', {
            agentId: 'agent-bram',
            agent: { id: 'agent-bram', name: 'Bram', provider: 'claude' },
            waitingCount: 3,
            oldestWaitMs: 90_000,
        });
    } finally {
        director.stop();
    }

    assert.equal(cues.length, 3);
    assert.equal(cues[0].kind, 'arrival');
    assert.equal(cues[0].payload.agentId, 'agent-ada');
    assert.equal(cues[0].payload.label, 'Ada');
    assert.equal(cues[0].payload.provider, 'claude');
    assert.deepEqual(cues[0].payload.position, { tileX: 4, tileY: 2 });
    assert.equal(cues[1].kind, 'distress');
    assert.equal(cues[1].payload.position.tileX, 4);
    assert.equal(cues[2].kind, 'summons');
    assert.equal(cues[2].payload.agentId, 'agent-bram');
    assert.equal(cues[2].payload.waitingCount, 3);
    assert.equal(cues[2].payload.oldestWaitMs, 90_000);
});

test('BGM dedupes near-simultaneous distress and summons for one agent', () => {
    const director = new BgmDirector({ engine: {} });
    const cues = [];
    director.cueKit = {
        play(kind, payload) {
            cues.push({ kind, payload });
            return true;
        },
    };
    director.running = true;
    director._subscribe();

    try {
        eventBus.emit('distress:watchtower', {
            kind: 'errored',
            agentId: 'agent-ada',
        });
        eventBus.emit('attention:raised', {
            agentId: 'agent-ada',
            waitingCount: 1,
            oldestWaitMs: 2_000,
        });
    } finally {
        director.stop();
    }

    assert.equal(cues.length, 1);
    assert.equal(cues[0].kind, 'distress');
});

test('one attention event keeps the specific direct notice and cue caption in one toast', () => {
    const view = toastHarness();
    try {
        view.eventTarget.emit('attention:raised', {
            agentId: 'agent-ada',
            agent: { id: 'agent-ada', name: 'Ada' },
            reason: 'question',
            label: 'needs you',
        });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'agent-ada',
            label: 'Ada',
        });
        view.toast.show('Ada asked you a question', 'warning');

        assert.equal(view.container.children.length, 1);
        assert.equal(view.container.children[0].textContent, 'Ada asked you a question');
    } finally {
        view.toast.destroy();
    }
});

test('Chronicle date selection stays committed on a failed read and export failures surface', async () => {
    const input = { value: '2026-08-25' };
    const modal = {
        contentEl: { querySelector: () => input },
        isRequestCurrent: request => request === 1,
    };
    const failures = [];
    const panel = new ChroniclePanel({
        modal,
        chronicleLog: { readDayPage: async () => { throw new Error('indexeddb unavailable'); } },
        toast: { show: (message, type) => failures.push({ message, type }) },
    });
    panel._request = 1;
    panel._selectedDateKey = '2026-08-25';
    input.value = '2026-08-24';

    await panel._showDate('2026-08-24', 1);
    assert.equal(panel._selectedDateKey, '2026-08-25');
    assert.equal(input.value, '2026-08-25');
    assert.deepEqual(failures, [{ message: 'Could not load that Chronicle day.', type: 'warning' }]);

    panel._readExportData = async () => { throw new Error('read failed'); };
    await panel._export('csv');
    assert.deepEqual(failures.at(-1), {
        message: 'Could not export the Chronicle as CSV.',
        type: 'warning',
    });
});

test('MIX moves focus into its dialog and restores the trigger on close', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    let focused = '';
    const slider = { focus: () => { focused = 'slider'; } };
    const button = {
        getBoundingClientRect: () => ({ right: 900, bottom: 40 }),
        setAttribute() {},
        classList: { add() {}, remove() {} },
        focus: () => { focused = 'button'; },
    };
    const panel = {
        style: { display: 'none' },
        querySelector: () => slider,
    };
    try {
        const topbar = {
            _destroyed: false,
            _mixerButtonEl: button,
            _mixerPanelEl: panel,
            _hideSpendPanel() {},
        };
        TopBar.prototype._showMixerPanel.call(topbar);
        assert.equal(focused, 'slider');
        TopBar.prototype._hideMixerPanel.call(topbar);
        assert.equal(focused, 'button');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('Dashboard Escape only deselects from a focused card with no open surface', () => {
    const card = { tagName: 'BUTTON' };
    const modal = { getAttribute: () => 'true' };
    const panels = new Map();
    const previousDocument = globalThis.document;
    globalThis.document = {
        activeElement: card,
        getElementById: id => id === 'modalOverlay' ? modal : panels.get(id) || null,
        querySelectorAll: () => [],
    };
    const renderer = Object.create(DashboardRenderer.prototype);
    renderer.active = true;
    renderer._destroyed = false;
    renderer.gridEl = { contains: element => element === card };
    const deselected = [];
    const unsubscribe = eventBus.on('agent:deselected', () => deselected.push(true));

    try {
        const event = { code: 'Escape', preventDefault() { this.prevented = true; } };
        renderer._handleDashboardKeyboardCommand(event);
        assert.equal(deselected.length, 1);
        assert.equal(event.prevented, true);

        panels.set('spendBreakdownPanel', { hidden: false, style: { display: 'block' } });
        const blocked = { code: 'Escape', preventDefault() { this.prevented = true; } };
        renderer._handleDashboardKeyboardCommand(blocked);
        assert.equal(deselected.length, 1);

        globalThis.document.activeElement = { tagName: 'BUTTON' };
        renderer._handleDashboardKeyboardCommand({
            code: 'Escape',
            preventDefault() { this.prevented = true; },
        });
        assert.equal(deselected.length, 1);
    } finally {
        unsubscribe();
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
