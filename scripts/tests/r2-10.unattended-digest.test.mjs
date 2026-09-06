import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ChronicleEventKind,
    ChronicleLog,
    summarizeDigest,
} from '../../claudeville/src/application/ChronicleLog.js';
import {
    AttentionService,
    UNATTENDED_DIGEST_THRESHOLD_MS,
    formatUnattendedDigest,
} from '../../claudeville/src/application/AttentionService.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

class EventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(name, listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(listener);
    }

    removeEventListener(name, listener) {
        this.listeners.get(name)?.delete(listener);
    }

    dispatch(name) {
        for (const listener of this.listeners.get(name) || []) listener();
    }
}

function visibilityHarness(initial = 'visible') {
    const document = new EventTarget();
    document.visibilityState = initial;
    document.title = '';
    document.querySelector = () => null;
    const window = new EventTarget();
    return {
        document,
        window,
        setVisibility(value) {
            document.visibilityState = value;
            document.dispatch('visibilitychange');
        },
        blur() { window.dispatch('blur'); },
        focus() { window.dispatch('focus'); },
    };
}

function waitForDigest() {
    return new Promise(resolve => setImmediate(resolve));
}

function emptyWorld() {
    return { agents: new Map() };
}

test('a twenty-second glance does not meet the unattended threshold', async () => {
    assert.ok(UNATTENDED_DIGEST_THRESHOLD_MS > 20_000);
    const view = visibilityHarness();
    let now = 10_000;
    let reads = 0;
    const service = new AttentionService(emptyWorld(), {
        document: view.document,
        window: view.window,
        now: () => now,
        chronicleLog: {
            async readDigest() {
                reads++;
                return summarizeDigest([]);
            },
        },
    });

    try {
        view.blur();
        now += 20_000;
        view.focus();
        await waitForDigest();
        assert.equal(reads, 0);
    } finally {
        service.destroy();
    }
});

test('a meaningful return emits one priority-ordered Chronicle digest', async () => {
    const view = visibilityHarness();
    let now = 100_000;
    const reads = [];
    const messages = [];
    const digests = [];
    const service = new AttentionService(emptyWorld(), {
        document: view.document,
        window: view.window,
        now: () => now,
        toast: { show(message, type) { messages.push({ message, type }); } },
        chronicleLog: {
            async readDigest(since, until) {
                reads.push({ since, until });
                return summarizeDigest([
                    { ts: since + 1, kind: ChronicleEventKind.COMPLETED, agentName: 'Builder' },
                    { ts: since + 2, kind: ChronicleEventKind.COMMIT, agentName: 'Builder', label: 'fix: quay lights' },
                    { ts: since + 3, kind: ChronicleEventKind.WAITING, agentId: 'wait-1', agentName: 'Ada', reason: 'approval' },
                    { ts: since + 4, kind: ChronicleEventKind.ERRORED, agentId: 'error-1', agentName: 'Bramble' },
                    { ts: since + 5, kind: ChronicleEventKind.RATE_LIMITED, agentId: 'rate-1', agentName: 'Cinder' },
                ], { since, until });
            },
        },
    });
    const onDigest = payload => digests.push(payload);
    eventBus.on('attention:digest', onDigest);

    try {
        view.setVisibility('hidden');
        now += UNATTENDED_DIGEST_THRESHOLD_MS + 1;
        view.setVisibility('visible');
        await waitForDigest();
    } finally {
        eventBus.off('attention:digest', onDigest);
        service.destroy();
    }

    assert.deepEqual(reads, [{ since: 100_000, until: 160_001 }]);
    assert.equal(digests.length, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'warning');
    const message = messages[0].message;
    assert.ok(message.startsWith('While you were away: 1 agent needs attention'));
    assert.ok(message.indexOf('1 agent needs attention') < message.indexOf('1 error'));
    assert.ok(message.indexOf('1 error') < message.indexOf('1 rate limit'));
    assert.ok(message.indexOf('1 rate limit') < message.indexOf('1 completion'));
    assert.ok(message.indexOf('1 completion') < message.indexOf('1 commit'));
    assert.deepEqual(
        {
            kind: digests[0].kind,
            since: digests[0].since,
            until: digests[0].until,
            awayMs: digests[0].awayMs,
        },
        {
            kind: 'unattended-digest',
            since: 100_000,
            until: 160_001,
            awayMs: UNATTENDED_DIGEST_THRESHOLD_MS + 1,
        },
    );
    assert.equal(digests[0].summary.waiting[0].agentName, 'Ada');
});

test('an empty Chronicle interval stays silent', async () => {
    const view = visibilityHarness();
    let now = 50_000;
    let reads = 0;
    let emitted = 0;
    const service = new AttentionService(emptyWorld(), {
        document: view.document,
        window: view.window,
        now: () => now,
        chronicleLog: {
            async readDigest() {
                reads++;
                return summarizeDigest([]);
            },
        },
    });
    const onDigest = () => { emitted++; };
    eventBus.on('attention:digest', onDigest);

    try {
        view.setVisibility('hidden');
        now += UNATTENDED_DIGEST_THRESHOLD_MS + 1;
        view.setVisibility('visible');
        await waitForDigest();
    } finally {
        eventBus.off('attention:digest', onDigest);
        service.destroy();
    }

    assert.equal(reads, 1);
    assert.equal(emitted, 0);
});

test('Chronicle digest queries the timestamp range and ignores rows outside it', async () => {
    const rows = [
        { ts: 99, kind: ChronicleEventKind.COMPLETED, agentName: 'Before' },
        { ts: 100, kind: ChronicleEventKind.WAITING, agentId: 'inside', agentName: 'Inside' },
        { ts: 200, kind: ChronicleEventKind.COMMIT, agentName: 'Inside', label: 'feat: digest' },
        { ts: 300, kind: ChronicleEventKind.ERRORED, agentId: 'inside-error', agentName: 'Error' },
        { ts: 301, kind: ChronicleEventKind.COMPLETED, agentName: 'After' },
    ];
    const calls = [];
    const store = {
        async reduceRange(_name, options, reducer, initial) {
            calls.push(options);
            return rows
                .filter(row => row.ts >= options.lower && row.ts <= options.upper)
                .reduce(reducer, initial);
        },
    };
    const digest = await new ChronicleLog({ store }).readDigest(100, 300);

    assert.deepEqual(calls, [{
        index: 'ts',
        lower: 100,
        upper: 300,
        direction: 'next',
    }]);
    assert.equal(digest.totalEvents, 3);
    assert.equal(digest.waitingAgents, 1);
    assert.equal(digest.errors, 1);
    assert.equal(digest.commits, 1);
    assert.equal(digest.completed, 0);
    assert.deepEqual(digest.agents.sort(), ['Error', 'Inside']);
});

test('a Chronicle started after AttentionService is discovered through the active-log handoff', async () => {
    const service = new AttentionService(emptyWorld(), {
        document: visibilityHarness().document,
        chronicleLog: null,
    });
    const store = {
        async queryRange() { return []; },
    };
    const log = new ChronicleLog({ store }).start();

    try {
        assert.strictEqual(service.chronicleLog, log);
    } finally {
        await log.stop();
        service.destroy();
    }
});

test('new urgent residents are recorded once without re-announcing them after reload', async () => {
    const rows = [];
    const store = {
        async put(_name, record) { rows.push(record); },
        async queryRange() { return [...rows].sort((a, b) => a.ts - b.ts); },
    };
    const agent = {
        id: 'waiting-resident',
        name: 'Waiting Resident',
        status: 'waiting_on_user',
        waitReason: 'approval',
    };
    const first = new ChronicleLog({ store }).start();
    first._onAdded(agent);
    await first.flush();
    await first.stop();

    const second = new ChronicleLog({ store }).start();
    second._onAdded(agent);
    await second.flush();
    await second.stop();

    assert.equal(rows.filter(row => row.kind === ChronicleEventKind.ARRIVED).length, 1);
    assert.equal(rows.filter(row => row.kind === ChronicleEventKind.WAITING).length, 1);
});

test('desktop-notified urgent rows remain an aggregate in the return digest', async () => {
    class FakeNotification {
        static permission = 'granted';

        constructor() {}

        close() {}
    }

    const view = visibilityHarness('hidden');
    let now = 0;
    const agent = {
        id: 'alerted',
        name: 'Ada',
        status: 'waiting_on_user',
        waitReason: 'approval',
    };
    const service = new AttentionService({ agents: new Map([[agent.id, agent]]) }, {
        document: view.document,
        window: view.window,
        now: () => now,
        NotificationClass: FakeNotification,
        chronicleLog: {
            async readDigest() {
                return summarizeDigest([{
                    ts: 1,
                    kind: ChronicleEventKind.WAITING,
                    agentId: agent.id,
                    agentName: agent.name,
                    reason: agent.waitReason,
                }]);
            },
        },
    });
    service.desktopAlerts = true;
    service.refresh();
    const digests = [];
    const onDigest = payload => digests.push(payload);
    eventBus.on('attention:digest', onDigest);

    try {
        now = UNATTENDED_DIGEST_THRESHOLD_MS + 1;
        view.setVisibility('visible');
        await waitForDigest();
    } finally {
        eventBus.off('attention:digest', onDigest);
        service.destroy();
    }

    assert.equal(digests.length, 1);
    assert.equal(digests[0].summary.desktopNotifiedCount, 1);
    assert.equal(digests[0].message, 'While you were away: 1 agent needs attention.');
});

test('digest formatter returns no copy for an empty rollup', () => {
    assert.equal(formatUnattendedDigest(summarizeDigest([])), '');
});
