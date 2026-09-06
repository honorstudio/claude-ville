import test from 'node:test';
import assert from 'node:assert/strict';

import { ChronicleEventKind, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { ChroniclePanel, foldTimeline } from '../../claudeville/src/presentation/shared/ChroniclePanel.js';

const MINUTE = 60_000;
const event = (ts, kind, extra = {}) => ({ ts, kind, ...extra });

function shape(rows) {
    return rows.map(({ kind, ts, count, label }) => ({ kind, ts, count, label }));
}

function textContent(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    return `${node.textContent || ''}${(node.children || []).map(textContent).join('')}`;
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.textContent = '';
        this.dataset = {};
        this.style = {};
        this.classList = {
            names: new Set(),
            add: (...names) => names.forEach(name => this.classList.names.add(name)),
            contains: name => this.classList.names.has(name),
        };
    }

    append(child) {
        this.children.push(child);
    }

    setAttribute(name, value) {
        this[name] = String(value);
    }

    addEventListener() {}
}

test('folds same-kind events in the same minute and carries their count', () => {
    const rows = foldTimeline([
        event(5_000, 'arrived'),
        event(12_000, 'arrived'),
        event(59_999, 'arrived'),
    ]);

    assert.deepEqual(shape(rows), [{
        kind: 'arrived',
        ts: 5_000,
        count: 3,
        label: 'arrivals',
    }]);
});

test('does not fold same-kind events across a minute boundary', () => {
    const rows = foldTimeline([
        event(MINUTE - 1, 'arrived'),
        event(MINUTE, 'arrived'),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: 'arrived', ts: MINUTE - 1, count: 1, label: 'arrival' },
        { kind: 'arrived', ts: MINUTE, count: 1, label: 'arrival' },
    ]);
});

test('folds interleaved same-kind events in one minute at the first member position', () => {
    const rows = foldTimeline([
        event(5_000, ChronicleEventKind.ARRIVED),
        event(6_000, ChronicleEventKind.COMMIT),
        event(7_000, ChronicleEventKind.ARRIVED),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: ChronicleEventKind.ARRIVED, ts: 5_000, count: 2, label: 'arrivals' },
        { kind: ChronicleEventKind.COMMIT, ts: 6_000, count: 1, label: 'commit' },
    ]);
});

test('preserves chronological order while folding', () => {
    const rows = foldTimeline([
        event(3 * MINUTE + 1_000, 'completed'),
        event(1_000, 'arrived'),
        event(1_500, 'arrived'),
        event(2 * MINUTE, 'waiting'),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: 'arrived', ts: 1_000, count: 2, label: 'arrivals' },
        { kind: 'waiting', ts: 2 * MINUTE, count: 1, label: 'wait' },
        { kind: 'completed', ts: 3 * MINUTE + 1_000, count: 1, label: 'completed turn' },
    ]);
});

test('folds and labels new event kinds without a closed kind list', () => {
    for (const [kind, label] of [['pr', 'PRs'], ['issue', 'issues'], ['release', 'releases']]) {
        const rows = foldTimeline([
            event(5_000, kind),
            event(20_000, kind),
        ]);
        assert.deepEqual(shape(rows), [{ kind, ts: 5_000, count: 2, label }]);
    }
});

test('project subtotals count raw events when timeline rows fold', () => {
    const events = [
        event(5_000, ChronicleEventKind.ARRIVED, { agentName: 'Ada', project: 'alpha' }),
        event(6_000, ChronicleEventKind.COMMIT, { agentName: 'Ada', project: 'alpha' }),
        event(7_000, ChronicleEventKind.ARRIVED, { agentName: 'Bess', project: 'beta' }),
    ];
    const rows = foldTimeline(events);
    assert.equal(rows[0].count, 2, 'the interleaved arrivals share one timeline row');

    const previousNode = globalThis.Node;
    const previousDocument = globalThis.document;
    globalThis.Node = FakeElement;
    globalThis.document = { createElement: tagName => new FakeElement(tagName), createTextNode: value => String(value) };
    try {
        const panel = new ChroniclePanel({ chronicleLog: { retentionDays: 14 } });
        const rendered = panel._render(events, summarizeDay(events), { dateKey: '2026-09-02' });
        const subtotals = rendered.find(node => node.classList?.contains('chronicle__project-subtotals'));
        assert.ok(subtotals, 'the rendered ledger includes project subtotals');
        const projectRows = subtotals.children.filter(node => node.classList?.contains('chronicle__project-row'));
        assert.deepEqual(projectRows.map(textContent), ['alpha2 events', 'beta1 event']);
    } finally {
        if (previousNode === undefined) delete globalThis.Node;
        else globalThis.Node = previousNode;
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});

test('returns an empty array for empty input', () => {
    assert.deepEqual(foldTimeline([]), []);
    assert.deepEqual(foldTimeline(null), []);
});
