import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { MODEL_REVISION } from '../../claudeville/src/config/models.generated.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'claude');

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude projects provider records, turn timing, and a canonical working set', () => {
  const root = makeTempDir('claudeville-claude-projection-');
  try {
    const project = path.join(root, 'work', 'projection');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'secret\n');
    fs.symlinkSync(outside, path.join(project, 'link-outside'));

    const now = Date.now();
    writeJsonLines(path.join(root, '.claude', 'history.jsonl'), [
      { sessionId: 'projection-all', project, timestamp: now, model: 'claude-fable-5-1', display: 'Projection fixture' },
      { sessionId: 'projection-minimal', project, timestamp: now - 1, model: 'claude-sonnet-4-5', display: 'Minimal fixture' },
    ]);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'all-records.jsonl'), path.join(projectDir, 'projection-all.jsonl'));
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'minimal.jsonl'), path.join(projectDir, 'projection-minimal.jsonl'));

    const childScript = `
      const { ClaudeAdapter } = require('./claudeville/adapters/claude');
      const { decorateSessionPresentation } = require('./claudeville/adapters/sessionPresentation');
      const adapter = new ClaudeAdapter();
      const sessions = adapter.getActiveSessions(60 * 60 * 1000);
      const all = sessions.find(session => session.sessionId === 'projection-all');
      const minimal = sessions.find(session => session.sessionId === 'projection-minimal');
      process.stdout.write(JSON.stringify({ all, minimal: decorateSessionPresentation(minimal) }));
    `;
    const output = execFileSync(process.execPath, ['-e', childScript], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    });
    const { all, minimal } = JSON.parse(output);

    assert.deepEqual(all.cost, {
      usd: 12.34,
      source: 'provider',
      rateMatch: null,
      rateRevision: MODEL_REVISION,
      unknownModel: false,
    });
    assert.equal(all.estimatedCost, 12.34);
    assert.equal(all.linesAdded, 27);
    assert.equal(all.linesRemoved, 9);
    assert.equal(all.lastTurnDurationMs, 12345);
    assert.equal(all.lastPrompt.length, 200);
    assert.equal(all.todos.length, 13);
    assert.deepEqual(all.todos[1], { subject: 'Task 2', status: 'in_progress', phase: null });
    assert.equal(all.gitBranch, 'feature/transcript-projection');
    assert.equal(all.hookErrors, 2);
    assert.deepEqual(all.modelHistory.map(item => item.effort), ['low', 'high']);
    assert.ok(all.modelHistory.length <= 8);
    assert.equal(all.contextWindowMax, 1_000_000);
    assert.equal(all.tokenUsage.contextWindowMax, 1_000_000);
    assert.equal(all.signalSource, 'transcript');
    assert.equal(all.turnStartedAt, Date.parse('2026-09-01T10:00:00.000Z'));
    assert.deepEqual(all.workingSet.map(item => [item.path, item.op, item.source]), [
      ['~/outside/secret.js', 'write', 'transcript'],
      ['src/new.js', 'write', 'transcript'],
      ['src/index.js', 'write', 'transcript'],
      ['README.md', 'read', 'transcript'],
    ]);
    assert.ok(all.workingSet.every(item => Number.isFinite(item.at)));

    assert.equal(minimal.cost.source, 'estimate');
    assert.equal(minimal.cost.unknownModel, false);
    assert.ok(minimal.estimatedCost > 0);
    assert.equal(minimal.lastPrompt, null);
    assert.deepEqual(minimal.todos, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
