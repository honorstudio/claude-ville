import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './support/tmp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function writeSession(root, sessionId, records) {
  const sessionDir = path.join(root, '.kimi-code', 'sessions', 'workspace-fixture', sessionId);
  writeJsonl(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), records);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    workDir: '/workspace/fixture',
    agents: { main: {} },
  }));
}

function readSessions(root) {
  const script = `
    const { KimiAdapter } = require('./claudeville/adapters/kimi.js');
    process.stdout.write(JSON.stringify(new KimiAdapter().getActiveSessions(60 * 60 * 1000)));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: root, USERPROFILE: root },
    encoding: 'utf8',
  }));
}

test('Kimi Code derives pending and closed turns from one transcript projection', () => {
  const root = makeTempDir('claudeville-kimi-turn-state-');
  const now = Date.now();
  const pendingStart = now - 10_000;
  const pendingAt = now - 8_000;
  const closedStart = now - 20_000;
  const closedAt = now - 15_000;

  try {
    writeSession(root, 'pending-session', [
      { type: 'context.append_message', message: { role: 'user', content: 'Run the task.' }, time: pendingStart },
      { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 0 }, time: pendingStart + 1 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '0', toolCallId: 'call-open', name: 'Bash', args: { command: 'node task.js' }, time: pendingAt }, time: pendingAt },
      { type: 'context.append_loop_event', event: { type: 'step.end', turnId: '0', finishReason: 'tool_use' }, time: pendingAt + 1 },
    ]);
    writeSession(root, 'closed-session', [
      { type: 'context.append_message', message: { role: 'user', content: 'Read the file.' }, time: closedStart },
      { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 0 }, time: closedStart + 1 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '0', toolCallId: 'call-done', name: 'Read', args: { path: '/workspace/fixture/a.js' }, time: closedStart + 2 }, time: closedStart + 2 },
      { type: 'context.append_loop_event', event: { type: 'tool.result', turnId: '0', toolCallId: 'call-done', result: { output: 'ok' }, time: closedStart + 3 }, time: closedStart + 3 },
      { type: 'context.append_loop_event', event: { type: 'content.part', turnId: '0', part: { type: 'text', text: 'Done.' } }, time: closedAt - 1 },
      { type: 'context.append_loop_event', event: { type: 'step.end', turnId: '0', finishReason: 'stop' }, time: closedAt },
    ]);

    const sessions = readSessions(root);
    const pending = sessions.find(session => session.sessionId === 'kimi-pending-session');
    const closed = sessions.find(session => session.sessionId === 'kimi-closed-session');

    assert.ok(pending);
    assert.equal(pending.turnState, 'tool_pending');
    assert.equal(pending.pendingTool, 'Bash');
    assert.equal(pending.pendingSince, pendingAt);
    assert.equal(pending.awaitingSince, null);
    assert.equal(pending.waitReason, null);
    assert.equal(pending.signalSource, 'transcript');
    assert.equal(pending.turnStartedAt, pendingStart);
    assert.notEqual(pending.turnState, 'unknown');

    assert.ok(closed);
    assert.equal(closed.turnState, 'awaiting_input');
    assert.equal(closed.pendingTool, null);
    assert.equal(closed.pendingSince, null);
    assert.equal(closed.awaitingSince, closedAt);
    assert.equal(closed.waitReason, null);
    assert.equal(closed.signalSource, 'transcript');
    assert.equal(closed.turnStartedAt, closedStart);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
