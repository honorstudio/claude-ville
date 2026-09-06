import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChronicleCsv,
    buildChronicleMarkdown,
    ChroniclePanel,
    csvEscapeCell,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import { ChronicleEventKind, chronicleDateKey, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';

const DAY = chronicleDateKey();

function localTimestamp(dayOffset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(9, 5, 0, 0);
    return date.getTime();
}

function event(overrides = {}) {
    return {
        ts: localTimestamp(),
        kind: ChronicleEventKind.COMMIT,
        agentName: 'Ada',
        provider: 'codex',
        project: 'village',
        label: 'Ship the chronicle',
        ...overrides,
    };
}

test('Markdown export is a paste-ready selected-day recap with optional spend', () => {
    const events = [event()];
    const markdown = buildChronicleMarkdown({
        dateKey: DAY,
        events,
        summary: summarizeDay(events),
        spend: { tokens: 1200, cacheRead: 300, cost: 0.12, costLabel: 'Est. cost' },
    });

    assert.ok(markdown.startsWith(`# Chronicle — ${DAY}`));
    assert.match(markdown, /## Summary/);
    assert.match(markdown, /## Spend summary/);
    assert.match(markdown, /\| Commits \| 1 \|/);
    assert.match(markdown, /\| Ada committed Ship the chronicle · village \|/);
    assert.doesNotMatch(markdown, /```|\{\s*"/);
});

test('historical Markdown export omits the non-retained spend summary', () => {
    const historical = new Date();
    historical.setDate(historical.getDate() - 1);
    const historicalKey = chronicleDateKey(historical);
    const events = [event({ ts: localTimestamp(-1) })];
    const markdown = buildChronicleMarkdown({
        dateKey: historicalKey,
        events,
        summary: summarizeDay(events),
        spend: { tokens: 99, cacheRead: 88, cost: 0.77, costLabel: 'Est. cost' },
    });

    assert.doesNotMatch(markdown, /Spend summary|New tokens|Cache reads|Est\. cost/);
});

test('CSV quotes special cells and neutralizes formula-leading cells', () => {
    assert.equal(csvEscapeCell('a,b'), '"a,b"');
    assert.equal(csvEscapeCell('say "hello"'), '"say ""hello"""');
    assert.equal(csvEscapeCell('line\nbreak'), '"line\nbreak"');
    for (const formula of ['=SUM(A1)', '+cmd', '-2+3', '@mention']) {
        assert.equal(csvEscapeCell(formula), `'${formula}`);
    }

    const csv = buildChronicleCsv({
        dateKey: DAY,
        events: [event({
            kind: ChronicleEventKind.WAITING,
            agentName: '=HYPERLINK("https://unsafe.example")',
            project: 'alpha, beta',
            reason: 'line one\nline two',
            tool: '@approval',
        })],
    });
    assert.match(csv, /row_type,date,time,glyph,event/);
    assert.match(csv, /"alpha, beta"/);
    assert.match(csv, /"line one\nline two"/);
    assert.match(csv, /'=HYPERLINK\(""https:\/\/unsafe\.example""\)/);
    assert.match(csv, /'@approval/);
    assert.match(csv, /\r\n$/);
});

test('export data reads the complete currently selected day and hides historical spend', async () => {
    const today = chronicleDateKey();
    const historical = new Date();
    historical.setDate(historical.getDate() - 1);
    const historicalKey = chronicleDateKey(historical);
    const calls = [];
    const log = {
        async readDay(dateKey) {
            calls.push(dateKey);
            return Array.from({ length: 101 }, (_, index) => event({
                ts: new Date(2026, 7, 24, 8, index).getTime(),
            }));
        },
    };
    const panel = new ChroniclePanel({
        chronicleLog: log,
        spendLedger: { date: today, today: { tokens: 42, cacheRead: 7, cost: 0.01 } },
    });

    const data = await panel._readExportData(historicalKey);
    assert.deepEqual(calls, [historicalKey]);
    assert.equal(data.events.length, 101);
    assert.equal(data.spend, null);
});
