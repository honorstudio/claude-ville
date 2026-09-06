import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const { OmpAdapter, parseOmpTranscript } = require('../../claudeville/adapters/omp.js');

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function assistantMessage(id, timestamp, content, usage = null) {
  return {
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'assistant',
      content,
      ...(usage ? { usage } : {}),
    },
  };
}

test('OMP transcript projects the latest user prompt and reconstructed todo checklist', () => {
  const prompt = ` ${'Latest OMP prompt '.repeat(20)} `;
  const parsed = parseOmpTranscript([
    {
      type: 'session',
      id: '01900000-0000-7000-8000-000000000010',
      timestamp: '2026-08-12T10:00:00.000Z',
      cwd: '/workspace/fixture',
      git: { branch: 'feature/omp-todos' },
    },
    { type: 'message', timestamp: '2026-08-12T10:00:01.000Z', message: {
      role: 'user', content: [{ type: 'text', text: prompt }],
    } },
    { type: 'message', timestamp: '2026-08-12T10:00:02.000Z', message: {
      role: 'user', content: [{ type: 'text', text: '<system-reminder>Not a user prompt.</system-reminder>' }],
    } },
    assistantMessage('todo-init', '2026-08-12T10:00:03.000Z', [
      { type: 'toolCall', id: 'todo-init-call', name: 'todo', arguments: {
        op: 'init',
        list: [
          { phase: 'Implementation', items: ['Inspect OMP', 'Project checklist', 'Remove this item'] },
          { phase: 'Verification', items: ['Verify bounds', 'Check ordering', 'Confirm counts'] },
        ],
      } },
      { type: 'toolCall', id: 'todo-done-call', name: 'todo', arguments: {
        op: 'done', task: 'Inspect OMP',
      } },
      { type: 'toolCall', id: 'todo-start-call', name: 'todo', arguments: {
        op: 'start', task: 'Project checklist',
      } },
      { type: 'toolCall', id: 'todo-drop-call', name: 'todo', arguments: {
        op: 'drop', task: 'Remove this item',
      } },
    ]),
  ], {
    filePath: '/nonexistent/omp-fixture.jsonl',
    now: Date.parse('2026-08-12T10:01:00.000Z'),
    fileMtimeMs: Date.parse('2026-08-12T10:00:03.000Z'),
  });

  assert.equal(parsed.session.lastPrompt, prompt.trim().slice(0, 200));
  assert.deepEqual(parsed.session.todos, [
    { subject: 'Inspect OMP', status: 'completed', phase: 'Implementation' },
    { subject: 'Project checklist', status: 'in_progress', phase: 'Implementation' },
    { subject: 'Verify bounds', status: 'pending', phase: 'Verification' },
    { subject: 'Check ordering', status: 'pending', phase: 'Verification' },
    { subject: 'Confirm counts', status: 'pending', phase: 'Verification' },
  ]);
  assert.equal(parsed.session.todos.length, 5);
  assert.equal(parsed.session.todos.filter(todo => todo.status === 'completed').length, 1);
  assert.equal(parsed.session.gitBranch, 'feature/omp-todos');
});

test('OMP adapter discovers parent and nested agent transcripts with details and usage', () => {
  const tmpRoot = makeTempDir('claudeville-omp-');
  const projectDir = path.join(tmpRoot, '-workspace-fixture');
  const parentId = '01900000-0000-7000-8000-000000000001';
  const childId = '01900000-0000-7000-8000-000000000002';
  const glmChildId = '01900000-0000-7000-8000-000000000003';
  const parentPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}.jsonl`);
  const childPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}`, 'ReviewWorker.jsonl');
  const glmChildPath = path.join(projectDir, `2026-08-12T10-00-00-000Z_${parentId}`, 'GlmWorker.jsonl');
  const now = Date.parse('2026-08-12T10:01:00.000Z');

  writeJsonl(parentPath, [
    { type: 'title', title: 'OMP parent', updatedAt: '2026-08-12T10:00:00.000Z' },
    { type: 'session', id: parentId, timestamp: '2026-08-12T10:00:00.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', model: 'openai-codex/gpt-5.6-luna', timestamp: '2026-08-12T10:00:00.010Z' },
    assistantMessage('parent-assistant', '2026-08-12T10:00:20.000Z', [
      { type: 'text', text: 'Parent completed the task.' },
      { type: 'toolCall', id: 'call-parent', name: 'task', arguments: { prompt: 'Review the fixture' } },
    ], { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, totalTokens: 154, reasoningTokens: 5 }),
    { type: 'message', id: 'parent-tool-result', timestamp: '2026-08-12T10:00:21.000Z', message: {
      role: 'toolResult', toolCallId: 'call-parent', toolName: 'task',
      content: [{ type: 'text', text: 'done' }], details: { status: 'success' },
    } },
  ]);
  writeJsonl(childPath, [
    { type: 'title', title: '', updatedAt: '2026-08-12T10:00:30.000Z' },
    { type: 'session', id: childId, timestamp: '2026-08-12T10:00:30.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', model: 'kimi-code/k3', timestamp: '2026-08-12T10:00:30.010Z' },
    assistantMessage('child-assistant', '2026-08-12T10:00:40.000Z', [
      { type: 'text', text: 'Review finished.' },
      { type: 'toolCall', id: 'call-child', name: 'read', arguments: { path: '/workspace/fixture/index.js' } },
    ], { input: 10, output: 6, cacheRead: 2, cacheWrite: 0, totalTokens: 18, reasoningTokens: 0 }),
  ]);
  // Observed z.AI order: model_change carries the prefixed string, then each
  // assistant message overwrites the presented model with the bare id.
  writeJsonl(glmChildPath, [
    { type: 'title', title: '', updatedAt: '2026-08-12T10:00:45.000Z' },
    { type: 'session', id: glmChildId, timestamp: '2026-08-12T10:00:45.000Z', cwd: '/workspace/fixture' },
    { type: 'model_change', id: 'glm-model-change', parentId: null, model: 'zai/glm-5.3-flash', timestamp: '2026-08-12T10:00:46.000Z' },
    { type: 'message', id: 'glm-assistant', timestamp: '2026-08-12T10:00:50.000Z', message: {
      role: 'assistant', provider: 'zai', model: 'glm-5.3-flash',
      content: [{ type: 'text', text: 'GLM review finished.' }],
      usage: { input: 8, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 13, reasoningTokens: 0 },
    } },
  ]);

  const adapter = new OmpAdapter({ rootDir: tmpRoot, now: () => now });
  try {
    const sessions = adapter.getActiveSessions(2 * 60 * 1000);
    const parent = sessions.find(session => session.sessionId === `omp-${parentId}`);
    const child = sessions.find(session => session.sessionId === `omp-${childId}`);

    assert.ok(parent);
    assert.equal(parent.provider, 'omp');
    assert.equal(parent.model, 'openai-codex/gpt-5.6-luna');
    assert.equal(parent.project, '/workspace/fixture');
    assert.equal(parent.lastTool, 'task');
    assert.equal(parent.lastToolInput, 'Review the fixture');
    assert.equal(parent.lastMessage, 'Parent completed the task.');
    assert.deepEqual(parent.tokenUsage, {
      input: 100, output: 20, cacheRead: 30, cacheCreate: 4, cacheWrite: 4,
      totalInput: 100, totalOutput: 20, reasoningTokens: 5, reasoningInOutput: false, turnCount: 1,
    });

    assert.ok(child);
    assert.equal(child.agentType, 'sub-agent');
    assert.equal(child.agentName, 'ReviewWorker');
    assert.equal(child.parentSessionId, `omp-${parentId}`);
    assert.equal(child.underlyingProvider, 'kimi-code');

    const glmChild = sessions.find(session => session.sessionId === `omp-${glmChildId}`);
    assert.ok(glmChild);
    assert.equal(glmChild.provider, 'omp');
    assert.equal(glmChild.model, 'glm-5.3-flash');
    assert.equal(glmChild.underlyingProvider, 'zai');

    const detail = adapter.getSessionDetail(`omp-${parentId}`, '/workspace/fixture');
    assert.equal(detail.provider, 'omp');
    assert.equal(detail.sessionId, `omp-${parentId}`);
    assert.equal(detail.toolHistory.length, 1);
    assert.deepEqual(detail.toolHistory[0], {
      tool: 'task', detail: 'Review the fixture', ts: Date.parse('2026-08-12T10:00:20.000Z'),
    });
    assert.deepEqual(detail.messages, [{
      role: 'assistant', text: 'Parent completed the task.', ts: Date.parse('2026-08-12T10:00:20.000Z'),
    }]);
    assert.deepEqual(adapter.getWatchPaths(), [{
      type: 'directory', path: tmpRoot, recursive: true, filter: '.jsonl',
    }]);
  } finally {
    adapter.shutdown();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
