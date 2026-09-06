import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value)}\n`);
}

function writeJsonLines(filePath, records) {
  writeText(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function sqlValue(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createOpenCodeFixture(dbPath, project, now) {
  const sql = [
    'CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);',
    'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, agent TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);',
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    `INSERT INTO project (id, worktree) VALUES (${sqlValue('project-r2-02')}, ${sqlValue(project)});`,
    `INSERT INTO session (id, project_id, parent_id, directory, title, version, time_created, time_updated, time_archived, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (${sqlValue('ses-r2-02')}, ${sqlValue('project-r2-02')}, NULL, ${sqlValue(project)}, ${sqlValue('R2-02 fixture')}, '1', ${now - 2000}, ${now}, NULL, ${sqlValue('OpenCode Fixture')}, ${sqlValue(JSON.stringify({ id: 'deepseek-v4-pro', providerID: 'deepseek' }))}, 0, 100, 20, 6, 30, 4);`,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${sqlValue('msg-tool')}, ${sqlValue('ses-r2-02')}, ${now - 1500}, ${now - 1500}, ${sqlValue(JSON.stringify({ role: 'assistant' }))});`,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${sqlValue('msg-text')}, ${sqlValue('ses-r2-02')}, ${now - 500}, ${now - 500}, ${sqlValue(JSON.stringify({ role: 'assistant' }))});`,
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlValue('part-tool')}, ${sqlValue('msg-tool')}, ${sqlValue('ses-r2-02')}, ${now - 1400}, ${now - 1300}, ${sqlValue(JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call-r2-02', state: { status: 'completed', input: { command: 'git status' }, metadata: { exit: 0 } } }))});`,
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlValue('part-step')}, ${sqlValue('msg-text')}, ${sqlValue('ses-r2-02')}, ${now - 900}, ${now - 800}, ${sqlValue(JSON.stringify({ type: 'step-finish', tokens: { total: 150 } }))});`,
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlValue('part-text')}, ${sqlValue('msg-text')}, ${sqlValue('ses-r2-02')}, ${now - 400}, ${now - 300}, ${sqlValue(JSON.stringify({ type: 'text', text: 'Fixture complete.' }))});`,
  ].join('\n');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(dbPath);
    database.exec(sql);
    database.close();
    return 'node';
  } catch (nodeSqliteError) {
    try {
      execFileSync('sqlite3', ['-batch', dbPath], { input: sql, encoding: 'utf8' });
      return 'cli';
    } catch (cliError) {
      throw new Error(
        `OpenCode fixture needs node:sqlite or sqlite3 (node:sqlite: ${nodeSqliteError.message}; sqlite3: ${cliError.message})`,
      );
    }
  }
}

function createFixtures(root) {
  const project = path.join(root, 'work', 'r2-02-fixture');
  const now = Date.now();
  fs.mkdirSync(project, { recursive: true });

  const claudeProject = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
  writeJson(path.join(root, '.claude', 'history.jsonl'), {
    sessionId: 'claude-r2-02',
    project,
    timestamp: now,
    model: 'claude-sonnet-4-5',
    display: 'R2-02 fixture',
  });
  writeJson(path.join(root, '.claude', 'sessions', 'claude-r2-02.json'), { sessionId: 'claude-r2-02', name: 'Claude Fixture' });
  writeJsonLines(path.join(claudeProject, 'claude-r2-02.jsonl'), [{
    type: 'assistant',
    timestamp: new Date(now).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
        { type: 'text', text: 'Fixture complete.' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 },
    },
  }]);

  const codexRollout = path.join(root, '.codex', 'sessions', '2026', '08', '25', 'rollout-r2-02.jsonl');
  writeJsonLines(codexRollout, [
    { type: 'session_meta', payload: { id: 'codex-r2-02', cwd: project, model: 'gpt-5', agent_nickname: 'Codex Fixture', agent_role: 'main', git: { branch: 'feature/codex-plan' } } },
    { type: 'turn_context', payload: { model: 'gpt-5', effort: 'medium' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Older prompt.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Old step', status: 'pending' }] }) } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>not user text</environment_context>' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: ` ${'Latest Codex prompt '.repeat(20)} ` } },
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Inspect rollout', status: 'completed' }, { step: 'Project plan', status: 'in_progress' }, { step: 'Verify bounds', status: 'pending' }] }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'git status' }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture complete.' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30 }, last_token_usage: { total_tokens: 150 }, model_context_window: 200000 } } },
  ]);
  writeJsonLines(path.join(root, '.codex', 'session_index.jsonl'), [{ id: 'codex-r2-02', thread_name: 'Codex Fixture', updated_at: new Date(now).toISOString() }]);

  const projectHash = crypto.createHash('sha256').update(project).digest('hex');
  writeJson(path.join(root, '.gemini', 'tmp', projectHash, 'chats', 'session-gemini-r2-02.json'), {
    sessionId: 'gemini-r2-02',
    projectHash,
    messages: [
      { type: 'user', content: 'Check the fixture.' },
      {
        type: 'gemini',
        model: 'gemini-2.5-flash',
        content: 'Fixture complete.',
        toolCalls: [{ name: 'run_shell_command', args: { command: 'git status' } }],
        tokens: { input: 100, output: 20 },
        timestamp: new Date(now).toISOString(),
      },
    ],
  });

  const grokSession = path.join(root, '.grok', 'sessions', encodeURIComponent(project), 'grok-r2-02');
  writeJson(path.join(grokSession, 'summary.json'), {
    info: { id: 'grok-r2-02', cwd: project },
    current_model_id: 'grok-4.5',
    agent_name: 'Grok Fixture',
    updated_at: new Date(now).toISOString(),
  });
  writeJsonLines(path.join(grokSession, 'updates.jsonl'), [
    { timestamp: now - 100, params: { _meta: { totalTokens: 150 }, update: { sessionUpdate: 'tool_call', title: 'run_terminal_command', rawInput: { command: 'git status' } } } },
    { timestamp: now, params: { _meta: { totalTokens: 150 }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture complete.' } } } },
  ]);

  const kimiHash = crypto.createHash('md5').update(project).digest('hex');
  writeJson(path.join(root, '.kimi', 'kimi.json'), { work_dirs: [{ path: project }] });
  writeText(path.join(root, '.kimi', 'config.toml'), [
    'default_model = "kimi-code/kimi-for-coding"',
    '[models."kimi-code/kimi-for-coding"]',
    'model = "kimi-code/kimi-for-coding"',
    'display_name = "kimi-code/kimi-for-coding"',
    'provider = "kimi"',
    '',
  ].join('\n'));
  writeJsonLines(path.join(root, '.kimi', 'sessions', kimiHash, 'kimi-r2-02', 'wire.jsonl'), [
    { timestamp: Math.floor((now - 100) / 1000), message: { type: 'ToolCall', payload: { function: { name: 'Shell', arguments: JSON.stringify({ command: 'git status' }) } } } },
    { timestamp: Math.floor(now / 1000), message: { type: 'ContentPart', payload: { type: 'text', text: 'Fixture complete.' } } },
    { timestamp: Math.floor(now / 1000), message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 100, output: 20, input_cache_read: 30, input_cache_creation: 4 }, context_tokens: 150, max_context_tokens: 262144 } } },
  ]);
  writeJson(path.join(root, '.kimi', 'sessions', kimiHash, 'kimi-r2-02', 'state.json'), { custom_title: 'Kimi Fixture' });

  const ompSession = path.join(root, '.omp', 'agent', 'sessions', 'r2-02-fixture');
  writeJsonLines(path.join(ompSession, 'omp-r2-02.jsonl'), [
    { type: 'session', id: 'omp-r2-02', timestamp: new Date(now - 1000).toISOString(), cwd: project, title: 'OMP Fixture' },
    { type: 'model_change', model: 'openai-codex/gpt-5.6-luna', timestamp: new Date(now - 900).toISOString() },
    { type: 'message', id: 'omp-message', timestamp: new Date(now).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'omp-call', name: 'shell', arguments: { command: 'git status' } }, { type: 'text', text: 'Fixture complete.' }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 } } },
  ]);

  const openCodeDb = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
  const openCodeStrategy = createOpenCodeFixture(openCodeDb, project, now);
  fs.mkdirSync(path.join(root, '.config', 'opencode', 'agents'), { recursive: true });

  return { project, openCodeDb, openCodeStrategy };
}

function readFixtureSessions(root, openCodeDb, openCodeStrategy) {
  const childScript = `
    const { ClaudeAdapter } = require('./claudeville/adapters/claude');
    const { CodexAdapter } = require('./claudeville/adapters/codex');
    const { GeminiAdapter } = require('./claudeville/adapters/gemini');
    const { GrokAdapter } = require('./claudeville/adapters/grok');
    const { KimiAdapter } = require('./claudeville/adapters/kimi');
    const { OpenCodeAdapter } = require('./claudeville/adapters/opencode');
    const { OmpAdapter } = require('./claudeville/adapters/omp');
    const threshold = 10 * 60 * 1000;
    const adapters = [
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      ['gemini', new GeminiAdapter()],
      ['grok', new GrokAdapter()],
      ['kimi', new KimiAdapter()],
      ['opencode', new OpenCodeAdapter()],
      ['omp', new OmpAdapter()],
    ];
    const result = {};
    for (const [provider, adapter] of adapters) {
      const session = adapter.getActiveSessions(threshold).find(item => item.provider === provider);
      if (!session) throw new Error('No fixture session returned for ' + provider);
      result[provider] = session;
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ['-e', childScript], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CLAUDEVILLE_OPENCODE_STATE_DIR: path.dirname(openCodeDb),
      CLAUDEVILLE_OPENCODE_CONFIG_DIR: path.join(root, '.config', 'opencode'),
      CLAUDEVILLE_OPENCODE_DB: openCodeDb,
      CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY: openCodeStrategy,
    },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output);
}

test('adapter fixtures keep genuinely shared optional fields aligned', () => {
  const root = makeTempDir('claudeville-r2-02-');
  try {
    const fixture = createFixtures(root);
    const sessions = readFixtureSessions(root, fixture.openCodeDb, fixture.openCodeStrategy);
    const expectedTools = {
      claude: 'Bash',
      codex: 'shell',
      gemini: 'run_shell_command',
      grok: 'run_terminal_command',
      kimi: 'Shell',
      opencode: 'Bash',
      omp: 'shell',
    };

    for (const [provider, session] of Object.entries(sessions)) {
      assert.equal(session.project, fixture.project, `${provider} project normalization drifted`);
      assert.ok(session.model, `${provider} fixture did not expose a model`);
      assert.equal(session.lastTool, expectedTools[provider], `${provider} lastTool normalization drifted`);
      assert.match(String(session.lastToolInput), /git status/, `${provider} lastToolInput lost its command`);
      assert.equal(session.lastMessage, 'Fixture complete.', `${provider} lastMessage normalization drifted`);
    }

    assert.equal(sessions.codex.lastPrompt, 'Latest Codex prompt '.repeat(20).trim().slice(0, 200));
    assert.deepEqual(sessions.codex.todos, [
      { subject: 'Inspect rollout', status: 'completed', phase: null },
      { subject: 'Project plan', status: 'in_progress', phase: null },
      { subject: 'Verify bounds', status: 'pending', phase: null },
    ]);
    assert.equal(sessions.codex.gitBranch, 'feature/codex-plan');

    // Gemini has no agent-name field in its session format; the other six
    // fixtures exercise the common optional name exposed by their adapters.
    for (const provider of ['claude', 'codex', 'grok', 'kimi', 'opencode', 'omp']) {
      assert.ok(sessions[provider].agentName, `${provider} agentName disappeared from its fixture`);
    }

    // These six adapters expose comparable cumulative input/output totals.
    // Codex subtracts cached input from total input by design, so its value is
    // 70 while the other fixtures carry 100 uncached input tokens.
    const expectedTokenTotals = {
      claude: { totalInput: 100, totalOutput: 20 },
      codex: { totalInput: 70, totalOutput: 20 },
      gemini: { totalInput: 100, totalOutput: 20 },
      kimi: { totalInput: 100, totalOutput: 20 },
      opencode: { totalInput: 100, totalOutput: 20 },
      omp: { totalInput: 100, totalOutput: 20 },
    };
    for (const [provider, expected] of Object.entries(expectedTokenTotals)) {
      assert.deepEqual(
        {
          totalInput: sessions[provider].tokenUsage?.totalInput,
          totalOutput: sessions[provider].tokenUsage?.totalOutput,
        },
        expected,
        `${provider} token totals no longer use the shared normalized names`,
      );
      assert.equal(sessions[provider].tokenUsage?.turnCount, 1, `${provider} turn count drifted`);
    }

    // Only these five providers currently report cache reads in the fixture
    // payloads. Gemini and Grok are intentionally excluded.
    for (const provider of ['claude', 'codex', 'kimi', 'opencode', 'omp']) {
      assert.equal(sessions[provider].tokenUsage?.cacheRead, 30, `${provider} cacheRead parity drifted`);
    }

    // Codex cumulative token_count records have no cache-create concept, and
    // Gemini/Grok do not report cache tokens in these fixtures. Do not turn
    // those provider limitations into a false parity expectation.
    for (const provider of ['claude', 'kimi', 'opencode', 'omp']) {
      assert.equal(sessions[provider].tokenUsage?.cacheCreate, 4, `${provider} cacheCreate parity drifted`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
