import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingRepoSummariesFromDockSummaries } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { buildHarborLedgerRows } from '../../claudeville/src/presentation/shared/Sidebar.js';

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function profile(key, accent = '#ffd56a') {
    return { key, shortName: key, name: key, accent, labelText: accent, panel: '#111', panelBorder: accent };
}

test('pending repo summaries retain the oldest commit across dock zones', () => {
    const alpha = profile('alpha/main');
    const unknown = profile('unknown/main');
    const summaries = new Map([
        ['alpha-harbor', {
            project: '/repos/alpha', branch: 'main', profile: alpha, count: 2,
            failedCount: 0, latestEventTime: NOW - 5 * 60 * 60_000,
            earliestEventTime: NOW - 2 * DAY_MS, waitingZone: 'harbor',
        }],
        ['alpha-storage', {
            project: '/repos/alpha', branch: 'main', profile: alpha, count: 1,
            failedCount: 0, latestEventTime: NOW - 4 * 60 * 60_000,
            earliestEventTime: NOW - 6 * DAY_MS, waitingZone: 'commit-lagoon',
        }],
        ['unknown-overflow', {
            project: '/repos/unknown', branch: 'main', profile: unknown, count: 3,
            failedCount: 0, latestEventTime: NOW - 60_000,
            earliestEventTime: 0, waitingZone: 'harbor',
        }],
    ]);

    const rows = pendingRepoSummariesFromDockSummaries(summaries);
    const alphaRow = rows.find(row => row.project === '/repos/alpha');
    const unknownRow = rows.find(row => row.project === '/repos/unknown');
    assert.equal(alphaRow.pendingCommits, 3);
    assert.equal(alphaRow.oldestCommitTime, NOW - 6 * DAY_MS);
    assert.equal(unknownRow.oldestCommitTime, 0);
});

test('harbor ledger is age-first and formats honest age and cap disclosures', () => {
    const rows = buildHarborLedgerRows([
        { project: '/repos/alpha', repoName: 'alpha', branch: 'main', profile: profile('alpha'), pendingCommits: 4, failedPushes: 0, oldestCommitTime: NOW - 2 * DAY_MS },
        { project: '/repos/beta', repoName: 'beta', branch: 'feature/leaks', profile: profile('beta'), pendingCommits: 2, failedPushes: 0, oldestCommitTime: NOW - 6 * DAY_MS },
        { project: '/repos/capped', repoName: 'capped', branch: 'release', profile: profile('capped'), pendingCommits: 120, failedPushes: 1, oldestCommitTime: 0 },
        { project: '/repos/empty', repoName: 'empty', branch: 'main', profile: profile('empty'), pendingCommits: 0, failedPushes: 4, oldestCommitTime: NOW - 8 * DAY_MS },
    ], NOW);

    assert.deepEqual(rows.map(row => row.name), ['beta', 'alpha', 'capped']);
    assert.equal(rows[0].ageLabel, '6d ago');
    assert.equal(rows[0].detailText, 'feature/leaks - 2 commits - oldest 6d ago');
    assert.equal(rows[1].ageLabel, '2d ago');
    assert.equal(rows[2].ageLabel, '');
    assert.equal(rows[2].detailText, 'release - 120 commits');
    assert.equal(rows[2].detailText.includes('oldest'), false);
    assert.equal(rows[2].countCapped, true);
});

test('unknown-age rows use failure and count ordering only after known ages', () => {
    const rows = buildHarborLedgerRows([
        { repoName: 'zeta', branch: 'main', profile: profile('zeta'), pendingCommits: 8, failedPushes: 0, oldestCommitTime: 0 },
        { repoName: 'alpha', branch: 'main', profile: profile('alpha'), pendingCommits: 1, failedPushes: 2, oldestCommitTime: 0 },
        { repoName: 'known', branch: 'main', profile: profile('known'), pendingCommits: 1, failedPushes: 0, oldestCommitTime: NOW - 60_000 },
    ], NOW);

    assert.deepEqual(rows.map(row => row.name), ['known', 'alpha', 'zeta']);
});
