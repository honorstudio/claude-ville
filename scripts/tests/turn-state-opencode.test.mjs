import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  ACTIVE_SESSION_CANDIDATE_SQL,
  buildOpenCodeSession,
  getOpenCodeTurnState,
  recentPartsQuery,
} = require('../../claudeville/adapters/opencode')._test;

const NOW = 1_800_000_000_000;

function part({
  id,
  messageId = id,
  role = 'assistant',
  type,
  created,
  data = {},
}) {
  return {
    id,
    messageId,
    sessionId: 'ses_fixture',
    role,
    timeCreated: created,
    timeUpdated: created,
    type,
    data: { type, ...data },
  };
}

function userTurn(created = NOW - 10_000) {
  return part({
    id: 'user',
    role: 'user',
    type: 'text',
    created,
    data: { text: 'Do the work.' },
  });
}

test('OpenCode list queries bound both sessions and parts by the activity cutoff', () => {
  assert.match(ACTIVE_SESSION_CANDIDATE_SQL, /s\.time_updated\s*>=\s*:cutoff/);
  assert.match(recentPartsQuery("'ses_fixture'"), /p\.time_created\s*>=\s*:cutoff/);
});

test('OpenCode pending and running tools derive tool_pending without an unknown gap', () => {
  for (const status of ['pending', 'running']) {
    const startedAt = NOW - 9_000;
    const state = getOpenCodeTurnState([
      userTurn(),
      part({
        id: `tool-${status}`,
        type: 'tool',
        created: startedAt,
        data: {
          tool: 'bash',
          state: { status, time: { start: startedAt }, input: { command: 'sleep 30' } },
        },
      }),
    ], NOW);

    assert.equal(state.turnState, 'tool_pending');
    assert.notEqual(state.turnState, 'unknown');
    assert.equal(state.pendingTool, 'Bash');
    assert.equal(state.pendingSince, startedAt);
    assert.equal(state.waitReason, null, 'OpenCode tools never wait on a permission prompt');
    assert.equal(state.turnStartedAt, NOW - 10_000);
  }
});

test('OpenCode terminal step-finish derives awaiting_input for a closed turn', () => {
  const finishedAt = NOW - 1_000;
  const state = getOpenCodeTurnState([
    userTurn(),
    part({
      id: 'answer',
      type: 'text',
      created: NOW - 2_000,
      data: { text: 'Done.' },
    }),
    part({
      id: 'finish',
      type: 'step-finish',
      created: finishedAt,
      data: { reason: 'stop', tokens: { total: 100 } },
    }),
  ], NOW);

  assert.equal(state.turnState, 'awaiting_input');
  assert.equal(state.awaitingSince, finishedAt);
  assert.equal(state.pendingTool, null);
});

test('OpenCode session projection emits transcript provenance, timing, state, and provider cost', () => {
  const startedAt = NOW - 10_000;
  const session = buildOpenCodeSession({
    id: 'ses_fixture',
    parent_id: null,
    directory: '/tmp/project',
    title: 'Fixture',
    agent: 'build',
    model: JSON.stringify({ providerID: 'deepseek', id: 'deepseek-v4-pro' }),
    cost: 0.0125,
    tokens_input: 100,
    tokens_output: 20,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    time_updated: NOW,
    latestActivity: NOW,
  }, [
    userTurn(startedAt),
    part({
      id: 'running-tool',
      type: 'tool',
      created: NOW - 5_000,
      data: { tool: 'bash', state: { status: 'running', input: { command: 'sleep 30' } } },
    }),
  ], NOW);

  assert.equal(session.turnState, 'tool_pending');
  assert.equal(session.signalSource, 'transcript');
  assert.equal(session.turnStartedAt, startedAt);
  assert.deepEqual(session.cost, {
    usd: 0.0125,
    source: 'provider',
    rateMatch: null,
    rateRevision: session.cost.rateRevision,
    unknownModel: false,
  });
  assert.equal(typeof session.cost.rateRevision, 'string');
  assert.ok(session.cost.rateRevision.length > 0);
});
