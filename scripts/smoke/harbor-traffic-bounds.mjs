#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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
  reduceHarborTrafficState,
  snapshotHarborTrafficState,
} = await import(sourceModuleUrl(HARBOR_PATH));

const BASE_TIME = Date.parse('2026-07-14T12:00:00Z');
const PROJECT = '/tmp/harbor-traffic-bounds';

function commit(id, timestamp, overrides = {}) {
  const sequence = Number(overrides.sequence || 0);
  return {
    id,
    type: 'commit',
    project: PROJECT,
    branch: 'main',
    targetRef: 'main',
    sha: sequence.toString(16).padStart(40, '0'),
    label: `Bounded harbor commit ${id}`,
    timestamp,
    completedAt: timestamp,
    status: 'success',
    success: true,
    ...overrides,
  };
}

function push(id, timestamp, overrides = {}) {
  return {
    id,
    type: 'push',
    project: PROJECT,
    branch: 'main',
    targetRef: 'main',
    timestamp,
    completedAt: timestamp,
    status: 'success',
    success: true,
    exitCode: 0,
    ...overrides,
  };
}

const limits = new HarborTraffic().getDiagnostics();

// The first two repo fleets share their lagoon buoys across branches; later
// repos retain coastal slots, and pushes depart from the same water region.
const homeEvents = Array.from({ length: 6 }, (_, index) => commit(`home-${index}`, BASE_TIME + index, {
  project: `${PROJECT}-${Math.floor(index / 2)}`,
  branch: index % 2 ? 'feature' : 'main',
  sequence: index + 1,
}));
const homeState = reduceHarborTrafficState(null, homeEvents, { now: BASE_TIME + 100, motionScale: 1 });
const homeSnapshot = snapshotHarborTrafficState(homeState);
assert.deepEqual(homeSnapshot.repoAnchorages.map(entry => entry.anchorage), [
  'Commit Lagoon West', 'Commit Lagoon Spring', 'Pharos Reach',
]);
for (const ship of homeSnapshot.ships) {
  const slot = homeSnapshot.repoAnchorages.find(entry => entry.project === ship.project).slot;
  assert.equal(ship.waitingZone, slot < 2 ? 'commit-lagoon' : 'coast');
  assert.equal(ship.anchorageIndex, slot);
}
const homeReplay = reduceHarborTrafficState(homeState, [...homeEvents].reverse(), { now: BASE_TIME + 200 });
assert.deepEqual(snapshotHarborTrafficState(homeReplay).repoAnchorages, homeSnapshot.repoAnchorages);
const homeDepartures = reduceHarborTrafficState(homeReplay, homeEvents.map((event, index) => (
  push(`home-push-${index}`, BASE_TIME + 300, { project: event.project, branch: event.branch, targetRef: event.branch })
)), { now: BASE_TIME + 400, motionScale: 1 });
for (const ship of homeDepartures.ships.values()) {
  const lagoon = ship.project !== `${PROJECT}-2`;
  assert.equal(ship.status, 'departing');
  assert.equal(ship.departWaterZone, lagoon ? 'commit-lagoon' : 'coast');
  assert.ok(lagoon ? ship.departFromTile.tileX < 28 : ship.departFromTile.tileX > 30);
  if (lagoon) assert.ok(ship.departFromTile.tileY < 13);
}

// A push before a source tail longer than the seen-id cap must still launch a
// ship that was already docked, while later commits remain docked.
const liveCommit = commit('live-before-long-tail', BASE_TIME, { sequence: 1 });
let transitionState = reduceHarborTrafficState(null, [liveCommit], {
  now: BASE_TIME + 100,
  motionScale: 1,
});
const longTail = Array.from({ length: limits.maxSeenEventIds + 128 }, (_, index) => (
  commit(`tail-${index}`, BASE_TIME + 2_000 + index, { sequence: index + 2 })
));
transitionState = reduceHarborTrafficState(
  transitionState,
  [push('push-before-long-tail', BASE_TIME + 1_000), ...longTail],
  { now: BASE_TIME + 20_000, motionScale: 1 },
);
assert.equal(transitionState.ships.get(liveCommit.id)?.status, 'departing');
assert.equal(transitionState.ships.get(liveCommit.id)?.pushStatus, 'success');
assert.ok(transitionState.ships.size <= limits.maxShips);
assert.ok(transitionState.seenEventIds.size <= limits.maxSeenEventIds);
assert.equal(
  [...transitionState.ships.values()].filter((ship) => ship.status === 'docked').length
    + [...transitionState.overflowDockCounts.values()].reduce((sum, entry) => sum + entry.count, 0),
  longTail.length,
);

// A commit removed by the hard ship cap must not re-enter from a stale source.
const prunedCommit = longTail[0];
assert.equal(transitionState.ships.has(prunedCommit.id), false);
const sequenceAfterPrune = transitionState.nextSequence;
transitionState = reduceHarborTrafficState(transitionState, [prunedCommit], {
  now: BASE_TIME + 21_000,
  motionScale: 1,
});
assert.equal(transitionState.ships.has(prunedCommit.id), false);
assert.equal(transitionState.nextSequence, sequenceAfterPrune);

// A completed departure must leave enough replay state to reject the original
// commit after the successful push disappears from the source.
const departedCommit = commit('departed-commit', BASE_TIME + 30_000, {
  project: `${PROJECT}-departed`,
  sequence: 50_000,
});
const departedPush = push('departed-push', BASE_TIME + 31_000, {
  project: `${PROJECT}-departed`,
});
let departedState = reduceHarborTrafficState(null, [departedCommit, departedPush], {
  now: BASE_TIME + 32_000,
  motionScale: 0,
});
assert.equal(departedState.ships.has(departedCommit.id), false);
departedState = reduceHarborTrafficState(departedState, [departedCommit], {
  now: BASE_TIME + 33_000,
  motionScale: 1,
});
assert.equal(departedState.ships.has(departedCommit.id), false);

// Oversized retained state models thousands of docked/active records without
// paying the fixture cost of rendering them. Every replay-related collection
// and nested event-id list must converge to its declared hard bound.
const oversized = {
  seenEventIds: new Set(),
  seenEventTimes: new Map(),
  eventTombstones: new Map(),
  commitReplayFloors: new Map(),
  ships: new Map(),
  batches: new Map(),
  pushEvents: new Map(),
  repoQuays: new Map(),
  nextSequence: 3_000,
  nextBatchSequence: 700,
};
for (let index = 0; index < 3_000; index++) {
  const id = `oversized-event-${index}`;
  oversized.seenEventIds.add(id);
  oversized.seenEventTimes.set(id, BASE_TIME + index);
}
for (let index = 0; index < 2_300; index++) {
  const id = `oversized-event-${index}`;
  const project = `${PROJECT}-active-${index}`;
  oversized.ships.set(id, {
    id,
    project,
    branch: 'main',
    gitKind: 'commit',
    status: 'departing',
    eventTime: BASE_TIME + index,
    createdAt: BASE_TIME + index,
    departStartedAt: BASE_TIME + 100_000,
    berthIndex: index % 24,
    eventIds: index === 500
      ? Array.from({ length: 100 }, (_, alias) => `${id}-alias-${alias}`)
      : [id],
  });
  if (index < 700) oversized.repoQuays.set(project, index % 4);
}
for (let index = 0; index < 700; index++) {
  oversized.batches.set(`push-batch:oversized-push-${index}`, {
    id: `push-batch:oversized-push-${index}`,
    shipIds: [`oversized-event-${index}`],
    startedAt: BASE_TIME + 90_000 + index,
    eventTime: BASE_TIME + index,
    status: 'success',
  });
}
for (let index = 0; index < 1_300; index++) {
  oversized.pushEvents.set(`oversized-push-${index}`, {
    id: `oversized-push-${index}`,
    status: 'success',
    eventTime: BASE_TIME + index,
    seenAt: BASE_TIME + index,
  });
  oversized.commitReplayFloors.set(`${PROJECT}-floor-${index}\x1fmain`, {
    eventTime: BASE_TIME + index,
    recordedAt: BASE_TIME + index,
  });
}
for (let index = 0; index < 5_000; index++) {
  oversized.eventTombstones.set(`old-tombstone-${index}`, {
    type: 'commit',
    eventTime: BASE_TIME + index,
    removedAt: BASE_TIME + index,
  });
}

const boundedState = reduceHarborTrafficState(oversized, [], {
  now: BASE_TIME + 100_000,
  motionScale: 1,
});
assert.equal(boundedState.ships.size, limits.maxShips);
assert.equal(boundedState.seenEventIds.size, limits.maxSeenEventIds);
assert.equal(boundedState.pushEvents.size, limits.maxPushEvents);
assert.equal(boundedState.batches.size, limits.maxBatches);
assert.equal(boundedState.repoQuays.size, limits.maxRepoQuays);
assert.equal(boundedState.eventTombstones.size, limits.maxEventTombstones);
assert.equal(boundedState.commitReplayFloors.size, limits.maxCommitReplayFloors);
assert.ok(boundedState.overflowDockCounts.size <= limits.maxOverflowDockCounts);
assert.ok([...boundedState.ships.values()].every((ship) => ship.eventIds.length <= 64));
assert.ok([...boundedState.batches.values()].every((batch) => batch.shipIds.length <= limits.maxShips));

// The reducer's commit index and berth occupancy set keep a unique 4,800-event
// first ingest near-linear. The state cap is visual/storage only: summaries
// retain the exact unpushed count through aggregate overflow records.
const benchmarkEvents = Array.from({ length: 4_800 }, (_, index) => (
  commit(`benchmark-${index}`, BASE_TIME + 300_000 + index, {
    project: `${PROJECT}-benchmark`,
    sequence: 100_000 + index,
  })
));
const ingestStartedAt = performance.now();
const benchmarkState = reduceHarborTrafficState(null, benchmarkEvents, {
  now: BASE_TIME + 310_000,
  motionScale: 1,
});
const ingestElapsedMs = performance.now() - ingestStartedAt;
assert.ok(ingestElapsedMs < 2_000, `4,800-event reducer ingest took ${ingestElapsedMs.toFixed(1)}ms`);
assert.equal(
  benchmarkState.ships.size + [...benchmarkState.overflowDockCounts.values()]
    .reduce((sum, entry) => sum + entry.count, 0),
  benchmarkEvents.length,
);
const summaryProbe = new HarborTraffic();
summaryProbe.state = benchmarkState;
const summaryCount = [...summaryProbe._repoDockSummaries({ byShipId: new Map() }).values()]
  .reduce((sum, summary) => sum + summary.count, 0);
assert.equal(summaryCount, benchmarkEvents.length);
summaryProbe.dispose();

// Provider snapshots can copy the same authoritative repository history into
// every session. Canonical project/git identity dedupe must happen before
// normalization and sorting, without collapsing distinct explicit events.
const sharedCommits = Array.from({ length: 120 }, (_, index) => (
  commit(`shared-${index}`, BASE_TIME + 400_000 + index, {
    project: `${PROJECT}-shared`,
    sequence: 200_000 + index,
  })
));
const sharedAgents = Array.from({ length: 100 }, (_, agentIndex) => ({
  id: `shared-agent-${agentIndex}`,
  projectPath: `${PROJECT}-shared`,
  gitEvents: sharedCommits.map((event) => ({ ...event })),
}));
sharedAgents[0].gitEvents.push(commit('agent-scoped-distinct', BASE_TIME + 401_000, {
  project: `${PROJECT}-shared`,
  sequence: 300_000,
  sha: '',
  sourceId: 'agent-scoped-distinct',
}));
const sharedHarbor = new HarborTraffic();
const sharedIngestStartedAt = performance.now();
sharedHarbor.reconcile(sharedAgents, BASE_TIME + 402_000);
const sharedIngestElapsedMs = performance.now() - sharedIngestStartedAt;
const sharedDiagnostics = sharedHarbor.getDiagnostics();
assert.ok(sharedIngestElapsedMs < 2_000, `12,001-entry shared ingest took ${sharedIngestElapsedMs.toFixed(1)}ms`);
assert.equal(sharedDiagnostics.rawEventCount, 12_001);
assert.equal(sharedDiagnostics.normalizedEventCount, 121);
assert.equal(sharedHarbor.state.ships.size, 121);
const sharedSteadyStartedAt = performance.now();
for (let index = 0; index < 100; index++) {
  sharedHarbor.reconcile(sharedAgents, BASE_TIME + 402_001);
}
const sharedSteadyElapsedMs = performance.now() - sharedSteadyStartedAt;
assert.ok(sharedSteadyElapsedMs < 250, `100 shared-source reconciles took ${sharedSteadyElapsedMs.toFixed(1)}ms`);
assert.equal(sharedHarbor.getDiagnostics().sourceNormalizations, 1);
sharedHarbor.dispose();

// A stable unique 4,800-event source must also bypass normalization, sorting,
// and source replay on every animation frame after its first reconciliation.
const benchmarkAgent = {
  id: 'benchmark-agent',
  projectPath: `${PROJECT}-benchmark`,
  gitEvents: benchmarkEvents,
};
const benchmarkHarbor = new HarborTraffic();
benchmarkHarbor.reconcile([benchmarkAgent], BASE_TIME + 310_000);
const benchmarkReductions = benchmarkHarbor.getDiagnostics().stateReductions;
const steadyStartedAt = performance.now();
for (let index = 0; index < 100; index++) {
  benchmarkHarbor.reconcile([benchmarkAgent], BASE_TIME + 310_001);
}
const steadyElapsedMs = performance.now() - steadyStartedAt;
assert.ok(steadyElapsedMs < 250, `100 cached 4,800-event reconciles took ${steadyElapsedMs.toFixed(1)}ms`);
assert.equal(benchmarkHarbor.getDiagnostics().sourceNormalizations, 1);
assert.equal(benchmarkHarbor.getDiagnostics().stateReductions, benchmarkReductions);
benchmarkHarbor.dispose();

// The controller's version gate must not replay an unchanged source, including
// a maintenance reduction, and disposal must make all update paths terminal.
const controllerEvent = commit('controller-commit', BASE_TIME + 200_000, {
  project: `${PROJECT}-controller`,
  sequence: 60_000,
});
const agent = {
  id: 'harbor-controller-agent',
  projectPath: controllerEvent.project,
  gitEvents: [controllerEvent],
};
const harbor = new HarborTraffic();
harbor.reconcile([agent], BASE_TIME + 200_100);
const firstDiagnostics = harbor.getDiagnostics();
const firstSequence = harbor.state.nextSequence;
harbor.reconcile([agent], BASE_TIME + 200_101);
assert.equal(harbor.getDiagnostics().stateReductions, firstDiagnostics.stateReductions);
assert.equal(harbor.state.nextSequence, firstSequence);
harbor.reconcile([agent], BASE_TIME + 220_000);
assert.equal(harbor.state.nextSequence, firstSequence);

harbor.dispose();
const disposedSnapshot = JSON.stringify({
  frame: harbor.frame,
  diagnostics: harbor.getDiagnostics(),
  nextSequence: harbor.state.nextSequence,
});
harbor.update([agent], 160, BASE_TIME + 230_000);
harbor.reconcile([agent], BASE_TIME + 240_000, { force: true });
assert.equal(JSON.stringify({
  frame: harbor.frame,
  diagnostics: harbor.getDiagnostics(),
  nextSequence: harbor.state.nextSequence,
}), disposedSnapshot);

// Animation remains frame-driven while semantic/source work follows the
// renderer's existing 250ms cadence.
const cadenceHarbor = new HarborTraffic();
cadenceHarbor.reconcile([agent], BASE_TIME + 250_000);
for (let frame = 1; frame <= 60; frame++) {
  cadenceHarbor.advance(1000 / 60);
  if (frame % 15 === 0) cadenceHarbor.reconcile([agent], BASE_TIME + 250_000 + frame * (1000 / 60));
}
const cadenceDiagnostics = cadenceHarbor.getDiagnostics();
assert.equal(cadenceDiagnostics.animationAdvances, 60);
assert.equal(cadenceDiagnostics.semanticReconciliations, 5);
cadenceHarbor.dispose();

console.log('harbor traffic bounds smoke passed');
console.log(`4,800-event reducer ingest: ${ingestElapsedMs.toFixed(1)}ms`);
console.log(`100 cached 4,800-event reconciles: ${steadyElapsedMs.toFixed(1)}ms`);
console.log(`100-agent shared ingest/steady: ${sharedIngestElapsedMs.toFixed(1)}ms / ${sharedSteadyElapsedMs.toFixed(1)}ms`);
