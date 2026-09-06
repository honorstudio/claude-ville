#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  mergeUnpushedGitEvents,
  parseGitEventsFromCommand,
} = require('../claudeville/adapters/gitEvents');

const project = '/tmp/claude-ville-git-fixture';
const baseTime = Date.parse('2026-04-28T12:00:00Z');

function commit(id, overrides = {}) {
  return {
    id,
    type: 'commit',
    project,
    label: 'Implement git event merge fixture coverage',
    completedAt: baseTime,
    inferred: false,
    ...overrides,
  };
}

function ids(events) {
  return events.map((event) => event.id).sort();
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-sha', { sha: 'abc123', label: 'Observed label' })],
    [commit('inferred-sha', { sha: 'abc123', branch: 'main', inferred: true })]
  );
  assert.equal(merged.length, 1, 'SHA match should merge observed and inferred commits');
  assert.equal(merged[0].id, 'observed-sha');
  assert.equal(merged[0].branch, 'main');
  assert.equal(merged[0].inferred, false);
}

{
  const commandHash = 'command-hash-1';
  const merged = mergeUnpushedGitEvents(
    [commit('observed-command', { commandHash, completedAt: null })],
    [commit('inferred-command', { commandHash, completedAt: null, inferred: true })]
  );
  assert.equal(merged.length, 1, 'matching command hashes without times should merge');
  assert.equal(merged[0].id, 'observed-command');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-text', { label: 'Implement git event merge fixture coverage', completedAt: baseTime })],
    [commit('inferred-text', { label: 'Implement git event merge fixture coverage and checks', completedAt: baseTime + 60_000, inferred: true })]
  );
  assert.equal(merged.length, 1, 'nearby commit text and time should merge');
  assert.equal(merged[0].id, 'observed-text');
}

{
  const merged = mergeUnpushedGitEvents(
    [],
    [commit('synthetic-only', { inferred: true })]
  );
  assert.deepEqual(ids(merged), ['synthetic-only'], 'synthetic-only commit should be retained');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-only')],
    []
  );
  assert.deepEqual(ids(merged), ['observed-only'], 'observed-only commit should be retained');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-near-miss', { label: 'Implement git event merge fixture coverage', completedAt: baseTime })],
    [commit('inferred-near-miss', { label: 'Refactor unrelated renderer code', completedAt: baseTime + 5 * 60_000, inferred: true })]
  );
  assert.deepEqual(
    ids(merged),
    ['inferred-near-miss', 'observed-near-miss'],
    'text/time near misses should remain distinct'
  );
}

{
  const events = parseGitEventsFromCommand('git fetch --prune origin main', {
    project,
    provider: 'codex',
    sessionId: 'session-fetch',
    sourceId: 'tool-fetch',
    ts: baseTime,
    completedAt: baseTime + 1000,
    success: true,
    exitCode: 0,
  });
  assert.equal(events.length, 1, 'fetch command should produce one git event');
  assert.equal(events[0].type, 'fetch');
  assert.equal(events[0].remote, 'origin');
  assert.equal(events[0].targetRef, 'main');
  assert.equal(events[0].branch, 'main');
  assert.equal(events[0].refspec, 'main');
  assert.deepEqual(events[0].flags, ['--prune']);
  assert.equal(events[0].source, 'command-parser');
  assert.equal(events[0].observed, true);
  assert.equal(events[0].inferred, false);
  assert.ok(events[0].confidence >= 0.95, 'completion metadata should raise fetch confidence');
}

{
  const events = parseGitEventsFromCommand('git pull --ff-only upstream release/2026', {
    project,
    provider: 'claude',
    sessionId: 'session-pull',
    sourceId: 'tool-pull',
    ts: baseTime,
    status: 'cancelled',
  });
  assert.equal(events.length, 1, 'pull command should produce one git event');
  assert.equal(events[0].type, 'pull');
  assert.equal(events[0].remote, 'upstream');
  assert.equal(events[0].targetRef, 'release/2026');
  assert.equal(events[0].branch, 'release/2026');
  assert.equal(events[0].refspec, 'release/2026');
  assert.equal(events[0].status, 'cancelled');
  assert.equal(events[0].source, 'command-parser');
}

async function runNormalizationChecks() {
  const identityPath = path.join(
    __dirname,
    '../claudeville/src/presentation/shared/GitEventIdentity.js',
  );
  const identitySource = fs.readFileSync(identityPath, 'utf8');
  const identityModule = `data:text/javascript;base64,${Buffer.from(identitySource).toString('base64')}`;
  const { normalizeGitEvent } = await import(identityModule);
  const agent = {
    id: 'agent-fixture',
    name: 'Fixture Agent',
    provider: 'codex',
    sessionId: 'agent-session',
  };

  const fetch = normalizeGitEvent({
    id: 'fetch-normalized',
    type: 'fetch',
    project,
    remote: 'origin',
    targetRef: 'main',
    refspec: 'main',
    source: 'command-parser',
    confidence: 0.98,
    success: true,
    exitCode: 0,
    completedAt: baseTime + 5000,
  }, agent);
  assert.equal(fetch.type, 'fetch');
  assert.equal(fetch.remote, 'origin');
  assert.equal(fetch.branch, 'main');
  assert.equal(fetch.targetRef, 'main');
  assert.equal(fetch.status, 'success');
  assert.equal(fetch.source, 'command-parser');
  assert.equal(fetch.confidence, 0.98);
  assert.equal(fetch.observed, true);
  assert.equal(fetch.inferred, false);
  assert.equal(fetch.completedAt, baseTime + 5000);

  const pull = normalizeGitEvent({
    id: 'pull-normalized',
    kind: 'pull',
    project,
    remote: 'upstream',
    branch: 'release/2026',
    targetRef: 'release/2026',
    source: 'manual-fixture',
    confidence: 0.87,
    status: 'failed',
    completedAt: baseTime + 6000,
  }, agent);
  assert.equal(pull.type, 'pull');
  assert.equal(pull.remote, 'upstream');
  assert.equal(pull.branch, 'release/2026');
  assert.equal(pull.status, 'failed');
  assert.equal(pull.source, 'manual-fixture');
  assert.equal(pull.confidence, 0.87);

  const pushCases = [
    ['success', { success: true, exitCode: 0 }, 'success'],
    ['failed', { success: false, stderr: 'fatal: network error' }, 'failed'],
    ['rejected', { success: false, stderr: '! [rejected] main -> main (non-fast-forward)' }, 'rejected'],
    ['cancelled', { status: 'canceled' }, 'cancelled'],
    ['force-success', { success: true, force: true }, 'success'],
  ];

  for (const [id, overrides, expected] of pushCases) {
    const normalized = normalizeGitEvent({
      id: `push-${id}`,
      type: 'push',
      project,
      branch: 'main',
      targetRef: 'main',
      completedAt: baseTime + 7000,
      ...overrides,
    }, agent);
    assert.equal(normalized.status, expected, `push ${id} status should normalize to ${expected}`);
    if (id === 'force-success') assert.equal(normalized.force, true, 'force push metadata should survive normalization');
  }
}

runNormalizationChecks()
  .then(() => {
    console.log('git event fixtures passed');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
