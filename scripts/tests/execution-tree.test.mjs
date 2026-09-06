import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

import {
  buildExecutionTree,
  deriveChildProgress,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';

const require = createRequire(import.meta.url);
const {
  deriveTaskProgress,
  projectClaudeExecution,
  summarizeTaskGroup,
} = require('../../claudeville/adapters/claude.js');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude task progress is exact, bounded, and projected server-side', () => {
  const records = [
    { id: '1', subject: 'Inspect the repository', description: 'private transcript prose', status: 'completed' },
    { id: '2', subject: 'Implement the tree', status: 'in_progress' },
  ];
  assert.deepEqual(deriveTaskProgress({ tasks: records, source: 'exact' }), {
    done: 1,
    total: 2,
    source: 'exact',
  });

  const session = { sessionId: 'claude-main', provider: 'claude', agentType: 'main' };
  const projected = projectClaudeExecution([session], [{ groupName: 'claude-main', tasks: records }])[0];
  assert.deepEqual(projected.taskProgress, { done: 1, total: 2, source: 'exact' });
  assert.deepEqual(projected.tasks, [
    { subject: 'Inspect the repository', status: 'completed' },
    { subject: 'Implement the tree', status: 'in_progress' },
  ]);
  assert.equal(Object.hasOwn(projected.tasks[0], 'description'), false);
});

test('inferred progress never counts a departed or disappeared child as done', () => {
  const parent = { id: 'main', provider: 'codex' };
  const children = [
    { id: 'done', status: 'completed' },
    { id: 'working', status: 'working' },
    { id: 'departed', status: 'completed', isDeparted: true },
  ];
  const progress = deriveChildProgress(parent, children, {
    previousChildIds: ['vanished'],
  });
  assert.deepEqual(progress, {
    done: 1,
    total: 4,
    source: 'inferred',
    unknown: 2,
  });

  const inferred = deriveTaskProgress({
    children: [
      { id: 'done', status: 'completed' },
      { id: 'gone', status: 'completed', isDeparted: true },
    ],
    previousChildIds: ['vanished'],
    source: 'inferred',
  });
  assert.deepEqual(inferred, {
    done: 1,
    total: 3,
    source: 'inferred',
    unknown: 2,
  });
});

test('non-Claude execution trees expose counts without invented hierarchy', () => {
  const tree = buildExecutionTree(
    { id: 'codex-main', provider: 'codex', agentType: 'main' },
    [
      { id: 'child-a', provider: 'codex', parentSessionId: 'codex-main', agentType: 'sub-agent', status: 'completed' },
      { id: 'child-b', provider: 'codex', parentSessionId: 'codex-main', agentType: 'sub-agent', status: 'working' },
    ],
  );
  assert.equal(tree.kind, 'counts');
  assert.deepEqual(tree.children, []);
  assert.deepEqual(tree.progress, { done: 1, total: 2, source: 'inferred', unknown: 0 });
});

test('childless sessions produce an empty execution tree', () => {
  const tree = buildExecutionTree(
    { id: 'claude-alone', provider: 'claude', agentType: 'main' },
    [],
  );
  assert.deepEqual(tree.children, []);
  assert.equal(tree.hasChildren, false);
});

test('task subjects are truncated and sanitized without descriptions or absolute paths', () => {
  const longSubject = `Implement /Users/operator/private.js ${'x'.repeat(200)}\nsecret prose`;
  const summary = summarizeTaskGroup({ tasks: [{ id: '1', subject: longSubject, description: 'do not emit this' }] });
  assert.equal(summary.tasks.length, 1);
  assert.ok(summary.tasks[0].subject.length <= 120);
  assert.equal(summary.tasks[0].subject.includes('/Users/'), false);
  assert.equal(summary.tasks[0].subject.includes('do not emit this'), false);
  assert.equal(summary.tasks[0].subject.includes('\n'), false);
});

test('Claude adapter reads task groups and attaches bounded progress to the session payload', () => {
  const home = makeTempDir('claudeville-execution-tree-');
  try {
    const project = path.join(home, 'workspace', 'tree');
    const sessionId = 'tree-main';
    const encodedProject = project.replaceAll('/', '-');
    const now = Date.now();
    writeJsonLines(path.join(home, '.claude', 'history.jsonl'), [
      { sessionId, project, timestamp: now, model: 'claude-sonnet-5', display: 'Tree fixture' },
    ]);
    writeJson(path.join(home, '.claude', 'tasks', sessionId, '1.json'), {
      id: '1', subject: 'First child', status: 'completed', description: 'private',
    });
    writeJson(path.join(home, '.claude', 'tasks', sessionId, '2.json'), {
      id: '2', subject: 'Second child', status: 'pending', description: 'private',
    });

    const script = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude.js');
      const sessions = new ClaudeAdapter().getActiveSessions(60 * 60 * 1000);
      process.stdout.write(JSON.stringify(sessions));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    const session = JSON.parse(output).find(item => item.sessionId === sessionId);
    assert.deepEqual(session.taskProgress, { done: 1, total: 2, source: 'exact' });
    assert.deepEqual(session.tasks, [
      { subject: 'First child', status: 'completed' },
      { subject: 'Second child', status: 'pending' },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP fallback and WebSocket snapshot transport retain execution fields', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  const session = {
    sessionId: 'fallback-main',
    provider: 'claude',
    agentType: 'main',
    parentSessionId: null,
    subagentKind: null,
    taskProgress: { done: 2, total: 3, source: 'exact' },
    tasks: [{ subject: 'Fallback task', status: 'in_progress' }],
  };
  globalThis.window = { location: { origin: 'http://localhost:4000', protocol: 'http:', host: 'localhost:4000' } };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ sessions: [session] }),
  });
  globalThis.WebSocket = class {};

  try {
    const { ClaudeDataSource } = await import(`../../claudeville/src/infrastructure/ClaudeDataSource.js?execution=${Date.now()}`);
    const fallbackSessions = await new ClaudeDataSource().getSessions();
    assert.deepEqual(fallbackSessions[0].taskProgress, session.taskProgress);
    assert.deepEqual(fallbackSessions[0].tasks, session.tasks);

    const { WebSocketClient } = await import(`../../claudeville/src/infrastructure/WebSocketClient.js?execution=${Date.now()}`);
    const client = new WebSocketClient();
    client._rememberSnapshot({ sessions: [session], teams: [] });
    assert.deepEqual(client._state.sessions[0].taskProgress, session.taskProgress);
    assert.deepEqual(client._state.sessions[0].tasks, session.tasks);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = previousWebSocket;
  }
});
