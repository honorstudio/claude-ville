import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../adapters/fixtures/claude');

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('Claude keeps a seen main identity and separates Agent kind from agentType', () => {
  const root = makeTempDir('claudeville-claude-identity-');
  const previousHome = process.env.HOME;
  let adapter = null;
  try {
    process.env.HOME = root;
    const project = path.join(root, 'work', 'identity');
    const projectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    const parentPath = path.join(projectDir, 'identity-main.jsonl');
    const childPath = path.join(projectDir, 'identity-main', 'subagents', 'agent-explorer.jsonl');
    const orphanPath = path.join(projectDir, 'never-seen.jsonl');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(childPath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-launch.jsonl'), parentPath);
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'agent-child.jsonl'), childPath);
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'minimal.jsonl'), orphanPath);

    const historyPath = path.join(root, '.claude', 'history.jsonl');
    writeJsonLines(historyPath, [{
      sessionId: 'identity-main',
      project,
      timestamp: Date.now(),
      model: 'claude-opus-4-6',
      agentType: 'main',
    }]);

    const require = createRequire(import.meta.url);
    const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
    adapter = new ClaudeAdapter();

    const initial = adapter.getActiveSessions(60 * 60 * 1000);
    assert.equal(initial.find(session => session.sessionId === 'identity-main')?.agentType, 'main');
    const child = initial.find(session => session.sessionId === 'subagent-explorer');
    assert.equal(child?.agentType, 'sub-agent');
    assert.equal(child?.subagentKind, 'Explore');
    assert.equal(initial.find(session => session.sessionId === 'never-seen')?.agentType, 'team-member');

    writeJsonLines(historyPath, [{
      sessionId: 'identity-main',
      project,
      timestamp: Date.now() - (11 * 60 * 1000),
      model: 'claude-opus-4-6',
      agentType: 'main',
    }]);
    const afterHistoryAgesOut = adapter.getActiveSessions(60 * 60 * 1000);
    const main = afterHistoryAgesOut.find(session => session.sessionId === 'identity-main');
    assert.equal(main?.agentType, 'main');
    assert.equal(main?.agentId, null);
    assert.equal(adapter.getPerfStats().sessionIdentity.entryLimit, 4096);
    assert.ok(adapter.getPerfStats().sessionIdentity.entries <= 4096);
  } finally {
    adapter?.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
