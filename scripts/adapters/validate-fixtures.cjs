#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('../tests/support/tmp.cjs');

const kimiFixture = buildKimiCodeFixture();
if (kimiFixture) {
  process.env.HOME = kimiFixture.root;
  process.env.CLAUDEVILLE_KIMI_INDEX_FALLBACK_MAX_BYTES = String(64 * 1024);
  delete process.env.USERPROFILE;
}
const codexFixture = kimiFixture ? buildCodexFixture(kimiFixture.root) : null;

const fixture = buildOpenCodeFixture();
if (fixture) {
  process.env.CLAUDEVILLE_OPENCODE_STATE_DIR = fixture.stateDir;
  process.env.CLAUDEVILLE_OPENCODE_CONFIG_DIR = fixture.configDir;
  process.env.CLAUDEVILLE_OPENCODE_DB = fixture.dbPath;
}

const {
  getSessionDetailByProvider,
  isKnownSessionDetailProvider,
  normalizeDetail,
  normalizeSession,
} = require('../../claudeville/adapters');
const { KimiAdapter } = require('../../claudeville/adapters/kimi');
const { CodexAdapter } = require('../../claudeville/adapters/codex');
const {
  OpenCodeAdapter,
  _test: openCodeTest,
} = require('../../claudeville/adapters/opencode');

const now = Date.now();

const rawSession = {
  sessionId: 123,
  provider: 'codex',
  project: '/tmp/claude-ville',
  model: '',
  status: '',
  lastActivity: String(now),
  tokens: { input_tokens: 10, output_tokens: 2 },
};

const normalizedSession = normalizeSession(rawSession);
assert.equal(normalizedSession.sessionId, '123');
assert.equal(normalizedSession.provider, 'codex');
assert.equal(normalizedSession.model, 'codex');
assert.equal(normalizedSession.status, 'active');
assert.equal(normalizedSession.lastActivity, now);
assert.deepEqual(normalizedSession.gitEvents, []);
assert.deepEqual(normalizedSession.tokenUsage, rawSession.tokens);

const normalizedOpenCodeSession = normalizeSession({
  sessionId: 'opencode-fixture',
  provider: 'opencode',
  model: '',
  lastActivity: String(now),
});
assert.equal(normalizedOpenCodeSession.provider, 'opencode');
assert.equal(normalizedOpenCodeSession.model, 'opencode');

const normalizedDetail = normalizeDetail({
  sessionId: 123,
  provider: 'gemini',
  toolHistory: null,
  messages: 'not-array',
  usage: { input: 1, output: 2 },
}, { project: '/tmp/project' });
assert.equal(normalizedDetail.sessionId, '123');
assert.equal(normalizedDetail.provider, 'gemini');
assert.equal(normalizedDetail.project, '/tmp/project');
assert.deepEqual(normalizedDetail.toolHistory, []);
assert.deepEqual(normalizedDetail.messages, []);
assert.deepEqual(normalizedDetail.tokenUsage, { input: 1, output: 2 });

assert.equal(isKnownSessionDetailProvider('claude'), true);
assert.equal(isKnownSessionDetailProvider('git'), true);
assert.equal(isKnownSessionDetailProvider('opencode'), true);
assert.equal(isKnownSessionDetailProvider('unknown-provider'), false);

const gitDetail = getSessionDetailByProvider('git', 'git-repo-fixture', '/tmp/project');
assert.equal(gitDetail.provider, 'git');
assert.equal(gitDetail.sessionId, 'git-repo-fixture');
assert.equal(gitDetail.project, '/tmp/project');
assert.deepEqual(gitDetail.toolHistory, []);
assert.deepEqual(gitDetail.messages, []);
assert.equal(typeof gitDetail.reason, 'string');

if (codexFixture) {
  const adapter = new CodexAdapter();
  assert.equal(adapter.isAvailable(), true);

  const sessions = adapter.getActiveSessions(10 * 60 * 1000);
  const directVariant = sessions.find((session) => session.agentId === 'codex-delayed-luna');
  const inferredVariant = sessions.find((session) => session.agentId === 'codex-delayed-terra');

  assert.ok(directVariant);
  assert.equal(directVariant.agentName, 'Curie');
  assert.equal(directVariant.agentType, 'worker');
  assert.equal(directVariant.model, 'gpt-5.6-luna');
  assert.equal(directVariant.reasoningEffort, 'high');
  assert.equal(directVariant.project, '/tmp/claude-ville-codex');

  assert.ok(inferredVariant);
  assert.equal(inferredVariant.agentName, 'Gauss');
  assert.equal(inferredVariant.model, 'gpt-5.6-terra');
  assert.equal(inferredVariant.reasoningEffort, 'xhigh');
}

if (kimiFixture) {
  const adapter = new KimiAdapter();
  assert.equal(adapter.isAvailable(), true);
  assert.equal(adapter.homeDir, kimiFixture.kimiDir);

  let sessions = adapter.getActiveSessions(10 * 60 * 1000);
  const firstPerf = adapter.getPerfStats();
  for (let attempt = 0; attempt < 8; attempt++) {
    const alias = sessions.find((session) => session.sessionId === 'kimi-session_alias_dir');
    const perf = adapter.getPerfStats();
    if (alias?.project === '/tmp/claude-ville-alias' && perf.codeIndexFallbackOffset === 0) break;
    sessions = adapter.getActiveSessions(10 * 60 * 1000);
  }
  const settledPerf = adapter.getPerfStats();
  const cachedSessions = adapter.getActiveSessions(10 * 60 * 1000);
  const warmPerf = adapter.getPerfStats();
  const main = sessions.find((session) => session.sessionId === 'kimi-session_fixture');
  const child = sessions.find((session) => session.sessionId === 'kimi-session_fixture::agent-0');
  const nestedChild = sessions.find((session) => session.sessionId === 'kimi-session_fixture::agent-1');
  const childFreshParent = sessions.find((session) => session.sessionId === 'kimi-session_child_fresh');
  const childFreshChild = sessions.find((session) => session.sessionId === 'kimi-session_child_fresh::agent-0');
  const childOnlyParent = sessions.find((session) => session.sessionId === 'kimi-session_child_only');
  const childOnlyChild = sessions.find((session) => session.sessionId === 'kimi-session_child_only::agent-0');
  const aliasMain = sessions.find((session) => session.sessionId === 'kimi-session_alias_dir');
  const stateOnlyMain = sessions.find((session) => session.sessionId === 'kimi-session_state_project');
  const configModelMain = sessions.find((session) => session.sessionId === 'kimi-session_config_model');
  const cwdOnlyMain = sessions.find((session) => session.sessionId === 'kimi-session_cwd_project');
  const stateWorkdirMain = sessions.find((session) => session.sessionId === 'kimi-session_state_workdir');
  const questionToolsMain = sessions.find((session) => session.sessionId === 'kimi-session_question_tools');
  assert.deepEqual(cachedSessions, sessions);
  assert.ok(firstPerf.skippedInactiveAgentWires >= 1);
  assert.ok(warmPerf.codeIndexHits > firstPerf.codeIndexHits);
  assert.ok(firstPerf.codeIndexFallbackScans >= 1);
  assert.ok(firstPerf.codeIndexFallbackMatches >= 1);
  assert.ok(firstPerf.codeIndexFallbackBudgetStops >= 1);
  assert.ok(warmPerf.codeIndexOversizedLines >= 1);
  assert.ok(
    firstPerf.codeIndexFallbackMaxScanBytes <= firstPerf.codeIndexFallbackMaxBytes,
    'each Kimi fallback pass must respect its byte budget',
  );
  assert.equal(
    warmPerf.codeIndexFallbackScans,
    settledPerf.codeIndexFallbackScans,
    'an unchanged Kimi index must not restart a completed fallback scan',
  );

  assert.ok(main);
  assert.equal(main.provider, 'kimi');
  assert.equal(main.agentId, 'main');
  assert.equal(main.agentName, 'Fixture Kimi');
  assert.equal(main.agentType, 'main');
  assert.equal(main.project, '/tmp/claude-ville');
  assert.equal(main.model, 'K2.7 Code');
  assert.equal(main.lastTool, 'Bash');
  assert.equal(main.lastToolInput, 'git commit -m "fixture"');
  assert.equal(main.lastMessage, 'Done.');
  assert.equal(main.tokenUsage.input, 100);
  assert.equal(main.tokenUsage.output, 20);
  assert.equal(main.tokenUsage.cacheRead, 400);
  assert.equal(main.tokenUsage.cacheCreate, 5);
  assert.equal(main.tokenUsage.contextWindow, 505);
  assert.equal(main.tokenUsage.contextWindowMax, 262144);
  assert.equal(main.gitEvents.length, 1);
  assert.equal(main.gitEvents[0].type, 'commit');
  assert.equal(main.gitEvents[0].success, true);
  assert.equal(main.gitEvents[0].exitCode, 0);
  assert.ok(main.gitEvents[0].completedAt > 0);

  assert.ok(child);
  assert.equal(child.agentId, 'agent-0');
  assert.equal(child.agentName, 'agent-0');
  assert.equal(child.agentType, 'sub-agent');
  assert.equal(child.parentSessionId, 'kimi-session_fixture');
  assert.equal(child.model, 'K2.7 Code');
  assert.equal(child.lastTool, 'Edit');
  assert.equal(child.lastToolInput, 'index.js');

  assert.ok(nestedChild);
  assert.equal(nestedChild.agentId, 'agent-1');
  assert.equal(nestedChild.agentType, 'sub-agent');
  assert.equal(nestedChild.parentSessionId, 'kimi-session_fixture::agent-0');
  assert.equal(nestedChild.lastTool, 'Read');

  assert.ok(childFreshParent);
  assert.equal(childFreshParent.agentId, 'main');
  assert.equal(childFreshParent.agentType, 'main');
  assert.equal(childFreshParent.parentSessionId, null);
  assert.equal(childFreshParent.lastTool, 'Read');
  assert.ok(childFreshChild);
  assert.equal(childFreshChild.agentType, 'sub-agent');
  assert.equal(childFreshChild.parentSessionId, 'kimi-session_child_fresh');
  assert.equal(childFreshChild.lastTool, 'Bash');
  assert.equal(childFreshChild.gitEvents.length, 1);
  assert.equal(childFreshChild.gitEvents[0].type, 'push');
  assert.equal(childFreshChild.gitEvents[0].success, false);
  assert.equal(childFreshChild.gitEvents[0].exitCode, 1);
  assert.match(childFreshChild.gitEvents[0].stderr, /rejected/);
  assert.ok(childFreshParent.lastActivity >= childFreshChild.lastActivity);

  assert.ok(childOnlyParent);
  assert.equal(childOnlyParent.agentId, 'main');
  assert.equal(childOnlyParent.agentType, 'main');
  assert.equal(childOnlyParent.agentName, 'Child Only Kimi');
  assert.equal(childOnlyParent.lastTool, null);
  assert.equal(childOnlyParent.model, 'K2 Thinking');
  assert.equal(childOnlyParent.tokenUsage.contextWindowMax, 131072);
  assert.ok(childOnlyChild);
  assert.equal(childOnlyChild.agentType, 'sub-agent');
  assert.equal(childOnlyChild.parentSessionId, 'kimi-session_child_only');
  assert.equal(childOnlyChild.model, 'K2 Thinking');
  assert.equal(childOnlyChild.lastTool, 'Bash');
  assert.equal(childOnlyChild.tokenUsage.contextWindowMax, 131072);
  assert.ok(childOnlyParent.lastActivity >= childOnlyChild.lastActivity);

  assert.ok(aliasMain);
  assert.equal(
    aliasMain.project,
    '/tmp/claude-ville-alias',
    'an active Kimi session older than the 4,096-line index tail must retain its indexed project',
  );
  assert.equal(aliasMain.agentName, 'Aliased Kimi');
  assert.equal(aliasMain.lastTool, 'Bash');

  assert.ok(stateOnlyMain);
  assert.equal(stateOnlyMain.project, '/tmp/claude-ville-state');
  assert.equal(stateOnlyMain.agentName, 'State Project Kimi');
  assert.equal(stateOnlyMain.lastTool, 'Read');

  assert.ok(configModelMain);
  assert.equal(configModelMain.project, '/tmp/claude-ville');
  assert.equal(configModelMain.model, 'K2 Thinking');
  assert.equal(configModelMain.tokenUsage.contextWindowMax, 131072);
  assert.equal(configModelMain.tokenUsage.turnCount, 0);

  assert.ok(cwdOnlyMain);
  assert.equal(cwdOnlyMain.project, '/tmp/claude-ville-cwd');
  assert.equal(cwdOnlyMain.agentName, 'Cwd Project Kimi');
  assert.equal(cwdOnlyMain.lastTool, 'Read');

  assert.ok(stateWorkdirMain);
  assert.equal(stateWorkdirMain.project, '/tmp/claude-ville-workdir');
  assert.equal(stateWorkdirMain.agentName, 'Workdir Kimi');
  assert.equal(stateWorkdirMain.lastTool, 'Read');

  assert.ok(questionToolsMain);
  assert.equal(questionToolsMain.project, '/tmp/claude-ville');
  assert.equal(questionToolsMain.lastTool, 'AskUserQuestion');
  assert.equal(questionToolsMain.lastToolInput, 'Ship the release?');

  const detail = adapter.getSessionDetail('kimi-session_fixture', '/tmp/claude-ville');
  assert.equal(detail.sessionId, 'kimi-session_fixture');
  assert.equal(detail.project, '/tmp/claude-ville');
  assert.equal(detail.toolHistory.length, 1);
  assert.equal(detail.toolHistory[0].tool, 'Bash');
  assert.equal(detail.toolHistory[0].toolExitCode, 0);
  assert.equal(detail.messages.at(-1).text, 'Done.');
  assert.ok(detail.messages.some((message) => message.role === 'user' && message.text === 'Please commit the fixture.'));
  assert.equal(detail.tokenUsage.contextWindowMax, 262144);

  const childDetail = adapter.getSessionDetail('kimi-session_fixture::agent-0', '/tmp/claude-ville');
  assert.equal(childDetail.sessionId, 'kimi-session_fixture::agent-0');
  assert.equal(childDetail.project, '/tmp/claude-ville');
  assert.equal(childDetail.toolHistory.length, 1);
  assert.equal(childDetail.toolHistory[0].tool, 'Edit');
  assert.equal(childDetail.tokenUsage.contextWindowMax, 262144);

  const childOnlyParentDetail = adapter.getSessionDetail('kimi-session_child_only', '/tmp/claude-ville');
  assert.equal(childOnlyParentDetail.sessionId, 'kimi-session_child_only');
  assert.equal(childOnlyParentDetail.project, '/tmp/claude-ville');
  assert.equal(childOnlyParentDetail.toolHistory.length, 1);
  assert.equal(childOnlyParentDetail.toolHistory[0].tool, 'Bash');
  assert.equal(childOnlyParentDetail.tokenUsage.contextWindowMax, 131072);

  const childFreshChildDetail = adapter.getSessionDetail('kimi-session_child_fresh::agent-0', '/tmp/claude-ville');
  assert.equal(childFreshChildDetail.toolHistory.length, 2);
  assert.equal(childFreshChildDetail.toolHistory[0].toolExitCode, 1);
  assert.match(childFreshChildDetail.toolHistory[0].toolStderr, /rejected/);

  const stateOnlyDetail = adapter.getSessionDetail('kimi-session_state_project', '/tmp/claude-ville');
  assert.equal(stateOnlyDetail.project, '/tmp/claude-ville-state');

  const configModelDetail = adapter.getSessionDetail('kimi-session_config_model', '/tmp/claude-ville');
  assert.equal(configModelDetail.tokenUsage.contextWindowMax, 131072);

  const cwdOnlyDetail = adapter.getSessionDetail('kimi-session_cwd_project', '/tmp/claude-ville');
  assert.equal(cwdOnlyDetail.project, '/tmp/claude-ville-cwd');
  assert.equal(cwdOnlyDetail.toolHistory.length, 1);
  assert.equal(cwdOnlyDetail.toolHistory[0].tool, 'Read');

  const stateWorkdirDetail = adapter.getSessionDetail('kimi-session_state_workdir', '/tmp/claude-ville');
  assert.equal(stateWorkdirDetail.project, '/tmp/claude-ville-workdir');
  assert.equal(stateWorkdirDetail.toolHistory.length, 1);
  assert.equal(stateWorkdirDetail.toolHistory[0].tool, 'Read');

  const questionToolsDetail = adapter.getSessionDetail('kimi-session_question_tools', '/tmp/claude-ville');
  assert.equal(questionToolsDetail.toolHistory.length, 3);
  assert.equal(questionToolsDetail.toolHistory[0].tool, 'TaskOutput');
  assert.equal(questionToolsDetail.toolHistory[0].detail, 'task_42');
  assert.equal(questionToolsDetail.toolHistory[1].tool, 'Skill');
  assert.equal(questionToolsDetail.toolHistory[1].detail, 'impeccable');
  assert.equal(questionToolsDetail.toolHistory[2].tool, 'AskUserQuestion');
  assert.equal(questionToolsDetail.toolHistory[2].detail, 'Ship the release?');

  const registryDetail = getSessionDetailByProvider('kimi', 'kimi-session_fixture', '/tmp/claude-ville', { force: true });
  assert.equal(registryDetail.provider, 'kimi');
  assert.equal(registryDetail.sessionId, 'kimi-session_fixture');
  assert.equal(registryDetail.project, '/tmp/claude-ville');
  assert.equal(registryDetail.tokenUsage.contextWindowMax, 262144);

  const registryChildDetail = getSessionDetailByProvider('kimi', 'kimi-session_fixture::agent-0', '/tmp/claude-ville', { force: true });
  assert.equal(registryChildDetail.provider, 'kimi');
  assert.equal(registryChildDetail.sessionId, 'kimi-session_fixture::agent-0');
  assert.equal(registryChildDetail.toolHistory[0].tool, 'Edit');

  const escapedFallbackDetail = adapter.getSessionDetail('kimi-../../outside/escaped', '/tmp/claude-ville');
  assert.equal(escapedFallbackDetail.sessionId, 'kimi-../../outside/escaped');
  assert.deepEqual(escapedFallbackDetail.toolHistory, []);
  assert.deepEqual(escapedFallbackDetail.messages, []);

  const escapedIndexDetail = adapter.getSessionDetail('kimi-session_escape_index', '/tmp/claude-ville');
  assert.equal(escapedIndexDetail.sessionId, 'kimi-session_escape_index');
  assert.deepEqual(escapedIndexDetail.toolHistory, []);
  assert.deepEqual(escapedIndexDetail.messages, []);

  const watchPaths = adapter.getWatchPaths();
  assert.ok(watchPaths.some((watchPath) => watchPath.type === 'file' && watchPath.path.endsWith('.kimi-code/session_index.jsonl')));
  assert.ok(watchPaths.some((watchPath) => watchPath.type === 'file' && watchPath.path.endsWith('.kimi-code/config.toml')));

  fs.rmSync(kimiFixture.root, { recursive: true, force: true });
}

if (fixture) {
  const adapter = new OpenCodeAdapter();
  assert.equal(adapter.isAvailable(), true);

  const { DatabaseSync } = require('node:sqlite');
  const planDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const plan = planDb.prepare(`EXPLAIN QUERY PLAN ${openCodeTest.ACTIVE_SESSION_CANDIDATE_SQL}`)
      .all({ cutoff: Date.now() - (10 * 60 * 1000), limit: 256 })
      .map(row => String(row.detail || ''))
      .join('\n');
    assert.match(plan, /SEARCH (?:recent_part|candidate_part) USING INDEX part_session_idx/);
    assert.doesNotMatch(
      plan,
      /SCAN (?:recent_part|candidate_part)/,
      'active-session discovery must not scan all OpenCode parts',
    );
  } finally {
    planDb.close();
  }

  const sessions = adapter.getActiveSessions(10 * 60 * 1000);
  const parent = sessions.find((session) => session.sessionId === 'opencode-ses_parent');
  const child = sessions.find((session) => session.sessionId === 'opencode-ses_child');
  const firstPerf = adapter.getPerfStats();
  const cachedSessions = adapter.getActiveSessions(10 * 60 * 1000);
  const warmPerf = adapter.getPerfStats();
  assert.deepEqual(cachedSessions, sessions);
  assert.ok(warmPerf.activeSessionCacheHits > firstPerf.activeSessionCacheHits);

  assert.ok(parent);
  assert.equal(parent.provider, 'opencode');
  assert.equal(parent.model, 'deepseek/deepseek-v4-pro');
  assert.equal(parent.agentName, 'build');
  assert.equal(parent.agentType, 'main');
  assert.equal(parent.project, '/tmp/claude-ville');
  assert.equal(parent.lastTool, 'Bash');
  assert.equal(parent.lastToolInput, 'Commit fixture');
  assert.equal(parent.lastMessage, 'Done.');
  assert.equal(parent.tokenUsage.input, 100);
  assert.equal(parent.tokenUsage.output, 20);
  assert.equal(parent.tokenUsage.cacheRead, 400);
  assert.equal(parent.tokenUsage.contextWindow, 520);
  assert.equal(parent.tokenUsage.contextWindowMax, 1000000);
  assert.equal(parent.gitEvents.length, 1);
  assert.equal(parent.gitEvents[0].type, 'commit');
  assert.equal(parent.gitEvents[0].success, true);

  assert.ok(child);
  assert.equal(child.agentType, 'sub-agent');
  assert.equal(child.parentSessionId, 'opencode-ses_parent');
  assert.equal(child.model, 'deepseek/deepseek-v4-flash');
  assert.equal(child.lastTool, 'TodoWrite');
  assert.equal(child.tokenUsage.contextWindowMax, 256000);

  const detail = adapter.getSessionDetail('opencode-ses_parent', '/tmp/claude-ville');
  assert.equal(detail.provider, 'opencode');
  assert.equal(detail.sessionId, 'opencode-ses_parent');
  assert.equal(detail.toolHistory.length, 1);
  assert.equal(detail.toolHistory[0].tool, 'Bash');
  assert.equal(detail.messages.at(-1).text, 'Done.');
  assert.equal(detail.tokenUsage.reportedCost, 0.01);

  const registryDetail = getSessionDetailByProvider('opencode', 'opencode-ses_parent', '/tmp/claude-ville', { force: true });
  assert.equal(registryDetail.provider, 'opencode');
  assert.equal(registryDetail.sessionId, 'opencode-ses_parent');

  runOpenCodeCliFallbackFixture(fixture);

  fs.rmSync(fixture.root, { recursive: true, force: true });
} else {
  console.log('opencode adapter fixture skipped: node:sqlite unavailable');
}

console.log('adapter fixture normalization checks passed');

function writeTextFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function writeJsonl(target, entries) {
  writeTextFile(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function buildCodexFixture(root) {
  const sessionsDir = path.join(root, '.codex', 'sessions', '2026', '07', '13');
  const now = Date.now();
  const trailingRecords = Array.from({ length: 60 }, (_, index) => ({
    timestamp: new Date(now - (60 - index) * 10).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_progress', index, output: 'x'.repeat(2048) },
  }));

  const fixtures = [
    {
      fileName: 'rollout-2026-07-13T12-00-00-codex-delayed-luna.jsonl',
      agentId: 'codex-delayed-luna',
      agentName: 'Curie',
      agentPath: '/root/delayed_luna_metadata',
      parentId: 'codex-parent-luna',
      model: 'gpt-5.6-luna',
      effort: 'high',
    },
    {
      fileName: 'rollout-2026-07-13T12-01-00-codex-delayed-terra.jsonl',
      agentId: 'codex-delayed-terra',
      agentName: 'Gauss',
      agentPath: '/root/terra_delayed_metadata',
      parentId: 'codex-parent-terra',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    },
  ];

  for (const fixture of fixtures) {
    const filePath = path.join(sessionsDir, fixture.fileName);
    const forkedParentRecords = Array.from({ length: 30 }, (_, index) => ({
      timestamp: new Date(now - 2000 + index).toISOString(),
      type: 'event_msg',
      payload: { type: 'forked_parent_history', index },
    }));
    writeJsonl(filePath, [
      {
        timestamp: new Date(now - 3000).toISOString(),
        type: 'session_meta',
        payload: {
          id: fixture.agentId,
          cwd: '/tmp/claude-ville-codex',
          agent_nickname: fixture.agentName,
          agent_role: 'worker',
          agent_path: fixture.agentPath,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: fixture.parentId,
                agent_path: fixture.agentPath,
                agent_nickname: fixture.agentName,
                agent_role: 'worker',
              },
            },
          },
        },
      },
      ...forkedParentRecords,
      {
        timestamp: new Date(now - 1000).toISOString(),
        type: 'turn_context',
        payload: {
          cwd: '/tmp/claude-ville-codex',
          model: fixture.model,
          effort: fixture.effort,
          collaboration_mode: {
            settings: {
              model: fixture.model,
              reasoning_effort: fixture.effort,
            },
          },
        },
      },
      ...trailingRecords,
    ]);
    const fileDate = new Date(now);
    fs.utimesSync(filePath, fileDate, fileDate);
  }

  return { sessionsDir };
}

function buildKimiCodeFixture() {
  const root = makeTempDir('cv-kimi-code-fixture-');
  const kimiDir = path.join(root, '.kimi-code');
  const sessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_fixture');
  const childFreshSessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_child_fresh');
  const childOnlySessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_child_only');
  const aliasSessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_alias_dir');
  const stateOnlySessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_state_project');
  const configModelSessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_config_model');
  const cwdOnlySessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_cwd_project');
  const stateWorkdirSessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_state_workdir');
  const questionToolsSessionDir = path.join(kimiDir, 'sessions', 'wd_fixture', 'session_question_tools');
  const mainWire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const childWire = path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl');
  const nestedChildWire = path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl');
  const staleChildWire = path.join(sessionDir, 'agents', 'agent-stale', 'wire.jsonl');
  const childFreshMainWire = path.join(childFreshSessionDir, 'agents', 'main', 'wire.jsonl');
  const childFreshChildWire = path.join(childFreshSessionDir, 'agents', 'agent-0', 'wire.jsonl');
  const childOnlyChildWire = path.join(childOnlySessionDir, 'agents', 'agent-0', 'wire.jsonl');
  const aliasMainWire = path.join(aliasSessionDir, 'agents', 'main', 'wire.jsonl');
  const stateOnlyMainWire = path.join(stateOnlySessionDir, 'agents', 'main', 'wire.jsonl');
  const configModelMainWire = path.join(configModelSessionDir, 'agents', 'main', 'wire.jsonl');
  const cwdOnlyMainWire = path.join(cwdOnlySessionDir, 'agents', 'main', 'wire.jsonl');
  const cwdOnlyChildWire = path.join(cwdOnlySessionDir, 'agents', 'agent-0', 'wire.jsonl');
  const stateWorkdirMainWire = path.join(stateWorkdirSessionDir, 'agents', 'main', 'wire.jsonl');
  const questionToolsMainWire = path.join(questionToolsSessionDir, 'agents', 'main', 'wire.jsonl');
  const escapedFallbackWire = path.join(kimiDir, 'outside', 'escaped', 'agents', 'main', 'wire.jsonl');
  const escapedFallbackChildWire = path.join(kimiDir, 'outside', 'escaped', 'agents', 'agent-0', 'wire.jsonl');
  const escapedIndexDir = path.join(kimiDir, 'outside-indexed', 'session_escape_index');
  const escapedIndexWire = path.join(escapedIndexDir, 'agents', 'main', 'wire.jsonl');
  const now = Date.now();

  writeTextFile(
    path.join(kimiDir, 'config.toml'),
    [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '  [models."kimi-code/kimi-for-coding"]',
      '  model = "kimi-for-coding"',
      '  display_name = "K2.7 Code"',
      '  provider = "kimi"',
      '  max_context_size = 262144',
      '',
      '  [models."kimi-code/kimi-thinking"]',
      '  model = "kimi-thinking"',
      '  display_name = "K2 Thinking"',
      '  provider = "kimi"',
      '  max_context_size = 131072',
      '',
    ].join('\n'),
  );

  const indexEntries = [
    {
      sessionId: 'session_fixture',
      sessionDir,
      workDir: '/tmp/claude-ville',
    },
    {
      sessionId: 'session_child_fresh',
      sessionDir: childFreshSessionDir,
      workDir: '/tmp/claude-ville',
    },
    {
      sessionId: 'session_child_only',
      sessionDir: childOnlySessionDir,
      workDir: '/tmp/claude-ville',
    },
    {
      sessionId: 'session_config_model',
      sessionDir: configModelSessionDir,
      workDir: '/tmp/claude-ville',
    },
    {
      sessionId: 'session_question_tools',
      sessionDir: questionToolsSessionDir,
      workDir: '/tmp/claude-ville',
    },
    {
      sessionId: 'persisted_alias_id',
      sessionDir: aliasSessionDir,
      workDir: '/tmp/claude-ville-alias',
    },
    {
      sessionId: 'session_escape_index',
      sessionDir: escapedIndexDir,
      workDir: '/tmp/claude-ville',
    },
  ];
  const aliasIndexEntry = indexEntries.splice(5, 1)[0];
  for (let index = 0; index < 400; index++) {
    indexEntries.push({
      sessionId: `pre-alias-padding-${index}`,
      padding: 'x'.repeat(256),
    });
  }
  indexEntries.push({
    sessionId: 'oversized-index-padding',
    padding: 'x'.repeat(70 * 1024),
  });
  indexEntries.push(aliasIndexEntry);
  for (let index = 0; index < 4096; index++) {
    indexEntries.push({ sessionId: `index-padding-${index}` });
  }
  writeTextFile(
    path.join(kimiDir, 'session_index.jsonl'),
    indexEntries.map((entry) => JSON.stringify(entry)).join('\n'),
  );

  writeTextFile(path.join(sessionDir, 'state.json'), JSON.stringify({
    title: 'Fixture Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null },
      'agent-0': { type: 'sub', parentAgentId: 'main' },
      'agent-1': { type: 'sub', parentAgentId: 'agent-0' },
      'agent-stale': { type: 'sub', parentAgentId: 'main' },
    },
    createdAt: new Date(now - 5000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(childFreshSessionDir, 'state.json'), JSON.stringify({
    title: 'Child Active Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null },
      'agent-0': { type: 'sub', parentAgentId: 'main' },
    },
    createdAt: new Date(now - 60 * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(childOnlySessionDir, 'state.json'), JSON.stringify({
    title: 'Child Only Kimi',
    isCustomTitle: true,
    agents: {
      'agent-0': { type: 'sub', parentAgentId: 'main' },
    },
    createdAt: new Date(now - 30_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(aliasSessionDir, 'state.json'), JSON.stringify({
    title: 'Aliased Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null },
    },
    createdAt: new Date(now - 10_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(stateOnlySessionDir, 'state.json'), JSON.stringify({
    title: 'State Project Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null, homedir: '/tmp/claude-ville-state' },
    },
    createdAt: new Date(now - 9000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(configModelSessionDir, 'state.json'), JSON.stringify({
    title: 'Config Model Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null },
    },
    createdAt: new Date(now - 8000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(cwdOnlySessionDir, 'state.json'), JSON.stringify({
    title: 'Cwd Project Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null },
    },
    createdAt: new Date(now - 7000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  // state.workDir must win over agents.main.homedir: on current Kimi Code builds
  // homedir points inside the session store, so this fixture pins that precedence.
  writeTextFile(path.join(stateWorkdirSessionDir, 'state.json'), JSON.stringify({
    title: 'Workdir Kimi',
    isCustomTitle: true,
    agents: {
      main: { type: 'main', parentAgentId: null, homedir: path.join(stateWorkdirSessionDir, 'agents', 'main') },
    },
    workDir: '/tmp/claude-ville-workdir',
    createdAt: new Date(now - 6000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  writeTextFile(path.join(questionToolsSessionDir, 'state.json'), JSON.stringify({
    title: 'Question Tools Kimi',
    isCustomTitle: false,
    agents: {
      main: { type: 'main', parentAgentId: null },
    },
    createdAt: new Date(now - 5500).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));

  writeJsonl(mainWire, [
    {
      type: 'context.append_message',
      time: now - 4000,
      message: {
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'Please commit the fixture.' }],
        toolCalls: [],
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 3000,
      event: {
        type: 'content.part',
        part: { type: 'text', text: 'Done.' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 2000,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_fixture',
        args: { command: 'git commit -m "fixture"' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 1500,
      event: {
        type: 'tool.result',
        toolCallId: 'call_kimi_fixture',
        result: { output: '[main abc123] fixture' },
      },
    },
    {
      type: 'usage.record',
      time: now - 1000,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: null,
        input_other: 100,
        inputCacheRead: null,
        input_cache_read: 400,
        inputCacheCreation: '',
        input_cache_creation: 5,
        output: 20,
      },
    },
  ]);

  writeJsonl(childWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1800,
      event: {
        type: 'tool.call',
        name: 'Edit',
        toolCallId: 'call_kimi_child_fixture',
        args: { file_path: '/tmp/claude-ville/src/index.js' },
      },
    },
    {
      type: 'usage.record',
      time: now - 900,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 7,
        inputCacheRead: 11,
        inputCacheCreation: 0,
        output: 3,
      },
    },
  ]);

  writeJsonl(nestedChildWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1500,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_nested_child_fixture',
        args: { file_path: '/tmp/claude-ville/claudeville/adapters/kimi.js' },
      },
    },
    {
      type: 'usage.record',
      time: now - 700,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 3,
        inputCacheRead: 9,
        inputCacheCreation: 0,
        output: 2,
      },
    },
  ]);

  writeJsonl(staleChildWire, [{
    type: 'context.append_loop_event',
    time: now - 30 * 60_000,
    event: {
      type: 'tool.call',
      name: 'Read',
      toolCallId: 'call_kimi_inactive_child_fixture',
      args: { file_path: '/tmp/claude-ville/old.js' },
    },
  }]);

  writeJsonl(childFreshMainWire, [
    {
      type: 'context.append_loop_event',
      time: now - 30 * 60_000,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_stale_main_fixture',
        args: { file_path: '/tmp/claude-ville/README.md' },
      },
    },
    {
      type: 'usage.record',
      time: now - 30 * 60_000,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 20,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        output: 2,
      },
    },
  ]);

  writeJsonl(childFreshChildWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1800,
      event: {
        type: 'tool.call',
        name: 'Bash',
        uuid: 'call_kimi_failed_push_fixture',
        args: { command: 'git push origin main' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 1600,
      event: {
        type: 'tool.result',
        uuid: 'call_kimi_failed_push_fixture',
        result: {
          is_error: true,
          stderr: 'error: failed to push some refs: rejected',
        },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 1200,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_fresh_child_fixture',
        args: { command: 'npm run check:adapter-fixtures' },
      },
    },
    {
      type: 'usage.record',
      time: now - 900,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 10,
        inputCacheRead: 25,
        inputCacheCreation: 0,
        output: 4,
      },
    },
  ]);

  writeJsonl(childOnlyChildWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1100,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_child_only_fixture',
        args: { command: 'node --check claudeville/adapters/kimi.js' },
      },
    },
    {
      type: 'usage.record',
      time: now - 800,
      model: 'kimi-code/kimi-thinking',
      usage: {
        inputOther: 8,
        inputCacheRead: 13,
        inputCacheCreation: 0,
        output: 5,
      },
    },
  ]);

  writeJsonl(aliasMainWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_alias_fixture',
        args: { command: 'git status --short' },
      },
    },
    {
      type: 'usage.record',
      time: now - 600,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 6,
        inputCacheRead: 4,
        inputCacheCreation: 0,
        output: 1,
      },
    },
  ]);

  writeJsonl(stateOnlyMainWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_state_project_fixture',
        args: { file_path: '/tmp/claude-ville-state/README.md' },
      },
    },
    {
      type: 'usage.record',
      time: now - 600,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 4,
        inputCacheRead: 2,
        inputCacheCreation: 0,
        output: 1,
      },
    },
  ]);

  writeJsonl(configModelMainWire, [
    {
      type: 'config.update',
      time: now - 1300,
      modelAlias: 'kimi-code/kimi-thinking',
      thinkingLevel: 'high',
    },
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_config_model_fixture',
        args: { file_path: '/tmp/claude-ville/package.json' },
      },
    },
  ]);

  writeJsonl(cwdOnlyMainWire, [
    {
      type: 'config.update',
      time: now - 1300,
      cwd: '/tmp/claude-ville-cwd',
      modelAlias: 'kimi-code/kimi-for-coding',
      thinkingLevel: 'high',
    },
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_cwd_project_fixture',
        args: { file_path: '/tmp/claude-ville-cwd/README.md' },
      },
    },
  ]);

  writeJsonl(cwdOnlyChildWire, [
    {
      type: 'context.append_loop_event',
      time: now - 500,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_cwd_child_fixture',
        args: { command: 'git status --short' },
      },
    },
  ]);

  writeJsonl(stateWorkdirMainWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'Read',
        toolCallId: 'call_kimi_state_workdir_fixture',
        args: { file_path: '/tmp/claude-ville-workdir/README.md' },
      },
    },
    {
      type: 'usage.record',
      time: now - 600,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 4,
        inputCacheRead: 2,
        inputCacheCreation: 0,
        output: 1,
      },
    },
  ]);

  writeJsonl(questionToolsMainWire, [
    {
      type: 'context.append_loop_event',
      time: now - 1400,
      event: {
        type: 'tool.call',
        name: 'TaskOutput',
        toolCallId: 'call_kimi_task_output_fixture',
        args: { task_id: 'task_42' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 1200,
      event: {
        type: 'tool.call',
        name: 'Skill',
        toolCallId: 'call_kimi_skill_fixture',
        args: { skill: 'impeccable' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: now - 1000,
      event: {
        type: 'tool.call',
        name: 'AskUserQuestion',
        toolCallId: 'call_kimi_question_fixture',
        args: { questions: [{ question: 'Ship the release?', header: 'Release', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      },
    },
    {
      type: 'usage.record',
      time: now - 600,
      model: 'kimi-code/kimi-for-coding',
      usage: {
        inputOther: 5,
        inputCacheRead: 3,
        inputCacheCreation: 0,
        output: 1,
      },
    },
  ]);

  writeJsonl(escapedFallbackWire, [
    {
      type: 'context.append_loop_event',
      time: now - 500,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_escape_fallback',
        args: { command: 'cat /tmp/should-not-read' },
      },
    },
  ]);
  writeJsonl(escapedFallbackChildWire, [
    {
      type: 'context.append_loop_event',
      time: now - 450,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_escape_child_fallback',
        args: { command: 'cat /tmp/should-not-read-child' },
      },
    },
  ]);

  writeJsonl(escapedIndexWire, [
    {
      type: 'context.append_loop_event',
      time: now - 400,
      event: {
        type: 'tool.call',
        name: 'Bash',
        toolCallId: 'call_kimi_escape_index',
        args: { command: 'cat /tmp/should-not-read-index' },
      },
    },
  ]);

  const fileDate = new Date(now);
  const staleDate = new Date(now - 30 * 60_000);
  fs.utimesSync(mainWire, fileDate, fileDate);
  fs.utimesSync(childWire, fileDate, fileDate);
  fs.utimesSync(nestedChildWire, fileDate, fileDate);
  fs.utimesSync(staleChildWire, staleDate, staleDate);
  fs.utimesSync(childFreshMainWire, staleDate, staleDate);
  fs.utimesSync(childFreshChildWire, fileDate, fileDate);
  fs.utimesSync(childOnlyChildWire, fileDate, fileDate);
  fs.utimesSync(aliasMainWire, fileDate, fileDate);
  fs.utimesSync(stateOnlyMainWire, fileDate, fileDate);
  fs.utimesSync(configModelMainWire, fileDate, fileDate);
  fs.utimesSync(cwdOnlyMainWire, fileDate, fileDate);
  fs.utimesSync(cwdOnlyChildWire, fileDate, fileDate);
  fs.utimesSync(stateWorkdirMainWire, fileDate, fileDate);
  fs.utimesSync(questionToolsMainWire, fileDate, fileDate);
  fs.utimesSync(escapedFallbackWire, fileDate, fileDate);
  fs.utimesSync(escapedFallbackChildWire, fileDate, fileDate);
  fs.utimesSync(escapedIndexWire, fileDate, fileDate);

  return { root, kimiDir };
}

function buildOpenCodeFixture() {
  let sqlite = null;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return null;
  }
  if (!sqlite?.DatabaseSync) return null;

  const root = makeTempDir('cv-opencode-fixture-');
  const stateDir = path.join(root, 'state');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });

  const dbPath = path.join(stateDir, 'opencode.db');
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        sandboxes text NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        title text NOT NULL,
        version text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_archived integer,
        agent text,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL
      );
      CREATE TABLE message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE INDEX part_session_idx ON part(session_id);
    `);

    const now = Date.now();
    db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)').run(
      'proj_fixture',
      '/tmp/claude-ville',
      now,
      now,
      '{}',
    );

    const insertSession = db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
        agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(
      'ses_parent',
      'proj_fixture',
      null,
      'parent',
      '/tmp/claude-ville',
      'Fixture parent',
      '1.15.3',
      now - 5000,
      now,
      'build',
      JSON.stringify({ id: 'deepseek-v4-pro', providerID: 'deepseek' }),
      0.01,
      100,
      20,
      3,
      400,
      0,
    );
    insertSession.run(
      'ses_child',
      'proj_fixture',
      'ses_parent',
      'child',
      '/tmp/claude-ville',
      'Fixture child',
      '1.15.3',
      now - 4000,
      now - 1000,
      'deepseekV4-flash',
      JSON.stringify({ id: 'deepseek-v4-flash', providerID: 'deepseek', variant: 'default' }),
      0.002,
      12,
      4,
      0,
      30,
      0,
    );

    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
    insertMessage.run('msg_user', 'ses_parent', now - 4500, now - 4500, JSON.stringify({ role: 'user' }));
    insertPart.run('prt_user', 'msg_user', 'ses_parent', now - 4400, now - 4400, JSON.stringify({ type: 'text', text: 'Please commit.' }));
    insertMessage.run('msg_assistant', 'ses_parent', now - 3000, now, JSON.stringify({ role: 'assistant' }));
    insertPart.run('prt_tool', 'msg_assistant', 'ses_parent', now - 2500, now - 2000, JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_fixture',
      state: {
        status: 'completed',
        input: { description: 'Commit fixture', command: 'git commit -m "fixture"' },
        metadata: { exit: 0 },
        time: { end: now - 2000 },
      },
    }));
    insertPart.run('prt_step', 'msg_assistant', 'ses_parent', now - 1500, now - 1500, JSON.stringify({
      type: 'step-finish',
      tokens: { total: 520 },
    }));
    insertPart.run('prt_text', 'msg_assistant', 'ses_parent', now - 1000, now - 900, JSON.stringify({ type: 'text', text: 'Done.' }));

    insertMessage.run('msg_child', 'ses_child', now - 2000, now - 1000, JSON.stringify({ role: 'assistant' }));
    insertPart.run('prt_child_tool', 'msg_child', 'ses_child', now - 1500, now - 1000, JSON.stringify({
      type: 'tool',
      tool: 'todowrite',
      state: { status: 'pending', input: { description: 'Update todos' } },
    }));
  } finally {
    db.close();
  }

  return { root, stateDir, configDir, dbPath };
}

function runOpenCodeCliFallbackFixture(fixture) {
  try {
    execFileSync('sqlite3', ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
  } catch {
    console.log('opencode sqlite3 CLI fallback fixture skipped: sqlite3 unavailable');
    return;
  }

  const script = `
    const assert = require('node:assert/strict');
    const { OpenCodeAdapter } = require('./claudeville/adapters/opencode');
    const adapter = new OpenCodeAdapter();
    assert.equal(adapter.isAvailable(), true);
    const sessions = adapter.getActiveSessions(10 * 60 * 1000);
    const parent = sessions.find((session) => session.sessionId === 'opencode-ses_parent');
    assert.ok(parent);
    assert.equal(parent.model, 'deepseek/deepseek-v4-pro');
    assert.equal(parent.lastTool, 'Bash');
    assert.equal(parent.tokenUsage.contextWindow, 520);
    assert.equal(parent.gitEvents.length, 1);
    const detail = adapter.getSessionDetail('opencode-ses_parent', '/tmp/claude-ville');
    assert.equal(detail.toolHistory[0].tool, 'Bash');
  `;

  execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      CLAUDEVILLE_OPENCODE_STATE_DIR: fixture.stateDir,
      CLAUDEVILLE_OPENCODE_CONFIG_DIR: fixture.configDir,
      CLAUDEVILLE_OPENCODE_DB: fixture.dbPath,
      CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY: 'cli',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
}
