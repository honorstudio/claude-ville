#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const HARBOR_PATH = path.join(
    REPO_ROOT,
    'claudeville/src/presentation/character-mode/HarborTraffic.js',
);

const moduleUrlCache = new Map();

function sourceModuleUrl(filePath) {
    const absolutePath = path.resolve(filePath);
    const cached = moduleUrlCache.get(absolutePath);
    if (cached) return cached;

    const source = fs.readFileSync(absolutePath, 'utf8').replace(
        /from\s+(['"])(\.{1,2}\/[^'"]+\.js)\1/g,
        (match, quote, specifier) => {
            const resolved = path.resolve(path.dirname(absolutePath), specifier);
            return `from ${quote}${sourceModuleUrl(resolved)}${quote}`;
        },
    );
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    moduleUrlCache.set(absolutePath, url);
    return url;
}

const {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
    snapshotHarborTrafficState,
} = await import(sourceModuleUrl(HARBOR_PATH));

const project = '/tmp/claude-ville-harbor-fixture';
const baseTime = Date.parse('2026-04-28T12:00:00Z');
const agent = {
    id: 'agent-harbor-fixture',
    name: 'Harbor Fixture',
    provider: 'codex',
    sessionId: 'session-harbor-fixture',
};

function normalize(event, index) {
    return normalizeGitEvent({
        project,
        provider: 'fixture',
        sessionId: agent.sessionId,
        sourceId: `fixture:${event.id}`,
        source: event.source || 'fixture',
        confidence: event.confidence ?? 0.96,
        completedAt: event.completedAt || event.timestamp || baseTime,
        ...event,
    }, agent, index, { fallbackTimestamp: baseTime });
}

function commit(id, branch, offsetMs, overrides = {}) {
    return {
        id,
        type: 'commit',
        branch,
        targetRef: branch,
        sha: `${id.replace(/[^a-z0-9]/gi, '').padEnd(12, '0')}abcdef`,
        label: `Fixture ${branch} commit`,
        timestamp: baseTime + offsetMs,
        completedAt: baseTime + offsetMs,
        success: true,
        ...overrides,
    };
}

function push(id, branch, offsetMs, overrides = {}) {
    return {
        id,
        type: 'push',
        branch,
        targetRef: branch,
        timestamp: baseTime + offsetMs,
        completedAt: baseTime + offsetMs,
        ...overrides,
    };
}

const rawEvents = [
    commit('commit-success', 'success', 0),
    push('push-success', 'success', 1000, { success: true, exitCode: 0 }),
    commit('commit-failed', 'failed', 2000, {
        inferred: true,
        observed: false,
        source: 'git-upstream-status',
        confidence: 0.72,
    }),
    push('push-failed', 'failed', 3000, { success: false, stderr: 'fatal: network error' }),
    commit('commit-rejected', 'rejected', 4000),
    push('push-rejected', 'rejected', 5000, {
        success: false,
        stderr: '! [rejected] rejected -> rejected (non-fast-forward)',
    }),
    commit('commit-cancelled', 'cancelled', 6000),
    push('push-cancelled', 'cancelled', 7000, { status: 'cancelled' }),
    commit('commit-force', 'force', 8000),
    push('push-force', 'force', 9000, { success: true, exitCode: 0, force: true }),
    {
        id: 'fetch-origin-main',
        type: 'fetch',
        remote: 'origin',
        branch: 'main',
        targetRef: 'main',
        refspec: 'main',
        source: 'command-parser',
        confidence: 0.98,
        success: true,
        exitCode: 0,
        timestamp: baseTime + 10000,
        completedAt: baseTime + 10000,
    },
    {
        id: 'pull-upstream-release',
        type: 'pull',
        remote: 'upstream',
        branch: 'release/2026',
        targetRef: 'release/2026',
        refspec: 'release/2026',
        source: 'command-parser',
        confidence: 0.98,
        success: true,
        exitCode: 0,
        timestamp: baseTime + 11000,
        completedAt: baseTime + 11000,
    },
    commit('commit-convoy-a', 'release/convoy', 12000),
    commit('commit-convoy-b', 'release/convoy', 12500),
    commit('commit-convoy-c', 'release/convoy', 13000),
    push('push-convoy', 'release/convoy', 15000, { success: true, exitCode: 0 }),
];

const events = rawEvents.map(normalize);
const now = baseTime + 16000;
const state = reduceHarborTrafficState(null, events, { now, motionScale: 1 });
const snapshot = snapshotHarborTrafficState(state);
const ships = new Map(snapshot.ships.map(ship => [ship.id, ship]));
const batches = new Map(snapshot.batches.map(batch => [batch.id, batch]));
const pushEvents = new Map(snapshot.pushEvents.map(event => [event.id, event]));

assert.equal(pushEvents.get('push-success')?.status, 'success');
assert.equal(pushEvents.get('push-failed')?.status, 'failed');
assert.equal(pushEvents.get('push-rejected')?.status, 'rejected');
assert.equal(pushEvents.get('push-cancelled')?.status, 'cancelled');
assert.equal(pushEvents.get('push-force')?.status, 'success');
assert.equal(pushEvents.get('push-force')?.force, true);
assert.equal(pushEvents.get('push-convoy')?.status, 'success');

assert.equal(batches.get('push-batch:push-force')?.force, true);
const convoyBatch = batches.get('push-batch:push-convoy');
assert.equal(convoyBatch?.convoy?.mode, 'release-convoy');
assert.equal(convoyBatch?.convoy?.count, 3);
assert.equal(convoyBatch?.convoy?.leaderShipId, 'commit-convoy-a');
assert.ok(convoyBatch?.route?.id, 'release convoy batch should expose route metadata');
assert.equal(ships.get('commit-failed')?.pushStatus, 'failed');
assert.equal(ships.get('commit-failed')?.inferred, true);
assert.equal(ships.get('commit-failed')?.source, 'git-upstream-status');
assert.equal(ships.get('commit-rejected')?.pushStatus, 'rejected');
assert.equal(ships.get('commit-cancelled')?.pushStatus, 'cancelled');
assert.equal(ships.get('commit-force')?.pushForce, true);

for (const id of ['commit-convoy-a', 'commit-convoy-b', 'commit-convoy-c']) {
    const ship = ships.get(id);
    assert.equal(ship?.pushStatus, 'success');
    assert.equal(ship?.convoy?.id, 'release-convoy:push-convoy');
    assert.equal(ship?.convoy?.count, 3);
    assert.ok(ship?.route?.id, `${id} should expose route metadata`);
    assert.ok(ship?.route?.waypointIds?.includes('sea.exit'), `${id} route should include sea exit`);
}
assert.equal(ships.get('commit-convoy-a')?.convoy?.index, 0);

const harbor = new HarborTraffic();
const successShip = state.ships.get('commit-success');
const successRoute = harbor._shipRouteTiles(successShip);
const routeEndpoint = successRoute[successRoute.length - 1];
assert.ok(routeEndpoint?.tileY > 3.5, 'successful departure should end at the sea lane, before the randomized map edge');
const endpointDrawable = harbor._shipDrawable(
    successShip,
    successShip.departStartedAt + 1500 + successShip.departMsOverride,
);
assert.equal(endpointDrawable?.payload?.progress, 1);
assert.equal(harbor._departureAlpha(endpointDrawable.payload), 0, 'ship should be fully faded when it reaches open water');

const fetchShip = ships.get('inbound:fetch-origin-main');
assert.equal(fetchShip?.arrivingKind, 'fetch');
assert.equal(fetchShip?.remote, 'origin');
assert.equal(fetchShip?.ref, 'main');
assert.equal(fetchShip?.source, 'command-parser');
assert.equal(fetchShip?.confidence, 0.98);
assert.equal(fetchShip?.observed, true);
assert.equal(fetchShip?.inferred, false);
assert.equal(fetchShip?.route?.id, 'inbound.fetch-roadstead');
assert.equal(fetchShip?.route?.kind, 'roadstead');

const pullShip = ships.get('inbound:pull-upstream-release');
assert.equal(pullShip?.arrivingKind, 'pull');
assert.equal(pullShip?.remote, 'upstream');
assert.equal(pullShip?.ref, 'release/2026');
assert.equal(pullShip?.eventStatus, 'success');
assert.equal(pullShip?.source, 'command-parser');
assert.equal(pullShip?.route?.id, 'inbound.pull');
assert.equal(pullShip?.route?.kind, 'inbound');

console.log('harbor git event scenario passed');
