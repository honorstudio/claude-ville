// Chronicle day-book helpers: commit-subject extraction and the day rollup.
// Both are pure, so neither needs IndexedDB.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ChronicleLog, commitSubject, summarizeDay, ChronicleEventKind } from '../../claudeville/src/application/ChronicleLog.js';

test('a plain subject line passes through', () => {
    assert.equal(commitSubject({ label: 'feat: harbor lights' }), 'feat: harbor lights');
});

test('a -m flag yields the subject, not the shell text', () => {
    assert.equal(commitSubject({ command: `git commit -m 'docs: tidy the map'` }), 'docs: tidy the map');
});

test('a heredoc yields its first body line', () => {
    const label = `git commit -q -m "$(cat <<'EOF'\nfix: chain flag logos load\nEOF`;
    assert.equal(commitSubject({ label }), 'fix: chain flag logos load');
});

test('an unreadable command yields null rather than shell noise', () => {
    assert.equal(commitSubject({ label: 'git push origin main' }), null);
    assert.equal(commitSubject({}), null);
});

test('the day rollup counts each kind and the longest wait', () => {
    const events = [
        { ts: 10, kind: ChronicleEventKind.ARRIVED, agentName: 'Wren', project: 'claude-ville' },
        { ts: 20, kind: ChronicleEventKind.COMMIT, agentName: 'Wren', project: 'claude-ville' },
        { ts: 30, kind: ChronicleEventKind.PUSH, agentName: 'Wren', project: 'claude-ville' },
        { ts: 40, kind: ChronicleEventKind.WAITING, agentName: 'Silas', project: 'pharosville' },
        { ts: 50, kind: ChronicleEventKind.RESOLVED, agentName: 'Silas', waitedMs: 90_000 },
        { ts: 60, kind: ChronicleEventKind.RESOLVED, agentName: 'Silas', waitedMs: 30_000 },
        { ts: 70, kind: ChronicleEventKind.ERRORED, agentName: 'Silas', project: 'pharosville' },
        { ts: 80, kind: ChronicleEventKind.COMPLETED, agentName: 'Wren' },
    ];
    const summary = summarizeDay(events);
    assert.equal(summary.commits, 1);
    assert.equal(summary.pushes, 1);
    assert.equal(summary.waits, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.rateLimits, 0);
    assert.equal(summary.totalWaitMs, 120_000);
    assert.equal(summary.longestWaitMs, 90_000);
    assert.deepEqual(summary.agents.sort(), ['Silas', 'Wren']);
    assert.deepEqual(summary.projects.sort(), ['claude-ville', 'pharosville']);
    assert.equal(summary.firstTs, 10);
    assert.equal(summary.lastTs, 80);
});

test('an empty day rolls up to zeroes, not NaN', () => {
    const summary = summarizeDay([]);
    assert.equal(summary.commits, 0);
    assert.equal(summary.longestWaitMs, 0);
    assert.equal(summary.firstTs, null);
    assert.deepEqual(summary.agents, []);
});

test('a large day is folded exactly while the newest timeline stays bounded', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
        id: `event-${index}`,
        ts: index + 1,
        kind: ChronicleEventKind.COMPLETED,
        agentName: `agent-${index % 25}`,
    }));
    const store = {
        async reduceRange(_name, options, reducer, initialValue) {
            let result = initialValue;
            const ordered = options.direction === 'prev' ? [...rows].reverse() : rows;
            for (const row of ordered) result = reducer(result, row);
            return result;
        },
    };
    const page = await new ChronicleLog({ store }).readDayPage(new Date(), { limit: 100 });
    assert.equal(page.summary.completed, 10_000);
    assert.equal(page.summary.totalEvents, 10_000);
    assert.equal(page.totalCount, 10_000);
    assert.equal(page.events.length, 100);
    assert.equal(page.events[0].id, 'event-9999');
    assert.equal(page.events.at(-1).id, 'event-9900');
});

// ─── Day-book noise control ──────────────────────────────────────────────
//
// The first cut of the Chronicle filled with "arrived" every time the tab was
// reloaded and logged each commit twice. Both made the recap unreadable, which
// is the only thing it has to be.

// Minimal stand-in for ChronicleStore's `events` table.
function fakeStore(seed = []) {
    const rows = [...seed];
    return {
        rows,
        async put(_store, record) { rows.push(record); return record; },
        async queryRange() { return [...rows].sort((a, b) => a.ts - b.ts); },
    };
}

const agent = (id, extra = {}) => ({
    id, name: id, provider: 'claude', projectPath: '/home/u/git/demo', gitEvents: [], ...extra,
});

test('a reload does not re-announce agents already in town', async () => {
    const store = fakeStore();
    const first = new ChronicleLog({ store }).start();
    first._onAdded(agent('a'));
    await first.flush();
    first._onAdded(agent('a'));      // same page, duplicate add
    await first.flush();
    first.stop();

    // A fresh page over the same store: the agent is still here, not arriving.
    const second = new ChronicleLog({ store }).start();
    second._onAdded(agent('a'));
    await second.flush();

    const arrivals = store.rows.filter((r) => r.kind === 'arrived');
    assert.equal(arrivals.length, 1);
});

test('arrivals landing before the replay resolves are still recorded once', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    // Fire immediately — the replay read has not resolved yet.
    log._onAdded(agent('a'));
    log._onAdded(agent('a'));
    await log.flush();
    assert.equal(store.rows.filter((r) => r.kind === 'arrived').length, 1);
});

test('repository watchers never arrive or depart', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    const repo = agent('git-repo-1', { provider: 'git', agentType: 'repository' });
    log._onAdded(repo);
    log._onRemoved(repo);
    await log.flush();
    assert.deepEqual(store.rows.filter((r) => ['arrived', 'departed'].includes(r.kind)), []);
});

test('one commit reported in two shapes is logged once', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    const ts = Date.now() - 60_000;
    log._onUpdated(agent('a', {
        gitEvents: [
            // Parsed from the repository scan: has a sha and a subject.
            { id: 'e1', type: 'commit', sha: 'abc123', label: 'feat: harbor lights', ts, observed: true },
            // Parsed from the tool command: no sha, raw shell text, other hash.
            { id: 'e2', type: 'commit', commandHash: 'zzz', ts,
              label: `git commit -m 'feat: harbor lights'` },
        ],
    }));
    await log.flush();
    assert.equal(store.rows.filter((r) => r.kind === 'commit').length, 1);
    assert.equal(store.rows.find((r) => r.kind === 'commit').label, 'feat: harbor lights');
});

test('commits older than the watching window are not backfilled', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    log._onUpdated(agent('a', {
        gitEvents: [{ id: 'old', type: 'commit', sha: 'old1', label: 'chore: last week',
                      ts: Date.now() - 7 * 24 * 3600_000 }],
    }));
    await log.flush();
    assert.equal(store.rows.filter((r) => r.kind === 'commit').length, 0);
});

test('pull and fetch events are never mislabeled as commits', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    const ts = Date.now() - 1000;
    log._onUpdated(agent('a', {
        gitEvents: [
            { id: 'pull-1', type: 'pull', sha: 'pullsha', label: 'git pull', ts },
            { id: 'fetch-1', type: 'fetch', sha: 'fetchsha', label: 'git fetch', ts },
        ],
    }));
    await log.flush();
    assert.equal(store.rows.filter((row) => row.kind === ChronicleEventKind.COMMIT).length, 0);
});

test('stop drains delayed day-book writes', async () => {
    let releaseWrite;
    const store = fakeStore();
    store.put = async (_name, record) => {
        await new Promise(resolve => { releaseWrite = resolve; });
        store.rows.push(record);
        return record;
    };
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    log.record(ChronicleEventKind.COMMIT, agent('a'), { label: 'fix: keep the last line' });
    const stopped = log.stop();
    assert.strictEqual(log.stop(), stopped);
    let drained = false;
    stopped.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    releaseWrite();
    await stopped;
    assert.equal(store.rows.some((row) => row.label === 'fix: keep the last line'), true);
});

test('commit records whose subjects differ only in trailing text still collapse', async () => {
    // The real pairing seen in the wild: the scan gives a clean subject, the
    // tool command gives the same subject with heredoc leftovers glued on.
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    const ts = Date.now() - 60_000;
    log._onUpdated(agent('a', {
        gitEvents: [
            { id: 'e1', type: 'commit', sha: 'aa11', ts,
              label: 'feat(world): break the onion, and stop the fleet rafting' },
            { id: 'e2', type: 'commit', commandHash: 'bb22', ts,
              label: 'feat(world): break the onion, and stop the fleet rafting R6 ' },
        ],
    }));
    await log.flush();
    assert.equal(store.rows.filter((r) => r.kind === 'commit').length, 1);
});

test('a commit with neither a name nor a sha is not logged', async () => {
    const store = fakeStore();
    const log = new ChronicleLog({ store }).start();
    await log.flush();
    log._onUpdated(agent('a', {
        gitEvents: [{ id: 'e1', type: 'commit', commandHash: 'cc33', ts: Date.now() - 1000,
                      label: `git commit -q -F - <<'EOF'` }],
    }));
    await log.flush();
    assert.equal(store.rows.filter((r) => r.kind === 'commit').length, 0);
});

test('a squashed commit body is cut to one readable subject', () => {
    const body = 'feat(three): make the world breathe — ' + 'and a great deal more prose '.repeat(20);
    const subject = commitSubject({ label: body });
    assert.ok(subject.length <= 101, `got ${subject.length}`);
    assert.ok(subject.startsWith('feat(three): make the world breathe'));
    assert.ok(subject.endsWith('…'));
});

test('a short subject is left exactly as written', () => {
    assert.equal(commitSubject({ label: 'fix: one line' }), 'fix: one line');
});
