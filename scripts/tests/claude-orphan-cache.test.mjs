import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

test('Claude orphan discovery rechecks active children without rescanning cold child trees', () => {
  const tmpHome = makeTempDir('claudeville-orphan-cache-');
  const previousHome = process.env.HOME;
  const project = path.join(tmpHome, 'workspace', 'fixture');
  const projectDir = path.join(tmpHome, '.claude', 'projects', project.replace(/\//g, '-'));
  const staleAt = new Date(Date.now() - 10 * 60 * 1000);
  const thresholdMs = 2 * 60 * 1000;
  let adapter = null;

  const writeTranscript = (filePath, value) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  };
  const parentPath = sessionId => path.join(projectDir, `${sessionId}.jsonl`);
  const childPath = (sessionId, childId) => (
    path.join(projectDir, sessionId, 'subagents', `agent-${childId}.jsonl`)
  );

  try {
    process.env.HOME = tmpHome;
    fs.mkdirSync(project, { recursive: true });
    for (let index = 0; index < 300; index++) {
      const sessionId = `stale-${index}`;
      writeTranscript(parentPath(sessionId), { type: 'assistant', message: { content: [] } });
      writeTranscript(childPath(sessionId, `cold-${index}`), { message: { role: 'user', content: 'cold' } });
      fs.utimesSync(parentPath(sessionId), staleAt, staleAt);
      fs.utimesSync(childPath(sessionId, `cold-${index}`), staleAt, staleAt);
    }

    const activeSessionId = 'active-parent';
    const activeChild = childPath(activeSessionId, 'active-child');
    writeTranscript(parentPath(activeSessionId), { type: 'assistant', message: { content: [] } });
    writeTranscript(activeChild, { message: { role: 'user', content: 'active' } });
    fs.utimesSync(parentPath(activeSessionId), staleAt, staleAt);

    const require = createRequire(import.meta.url);
    const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
    adapter = new ClaudeAdapter();

    const initial = adapter.getActiveSessions(thresholdMs);
    assert.ok(initial.some(session => session.sessionId === activeSessionId));
    assert.ok(initial.some(session => session.sessionId === 'subagent-active-child'));

    const originalStatSync = fs.statSync;
    const originalReaddirSync = fs.readdirSync;
    let statCalls = 0;
    let readdirCalls = 0;
    fs.statSync = (...args) => {
      statCalls++;
      return originalStatSync(...args);
    };
    fs.readdirSync = (...args) => {
      readdirCalls++;
      return originalReaddirSync(...args);
    };

    let warm;
    try {
      warm = adapter.getActiveSessions(thresholdMs);
    } finally {
      fs.statSync = originalStatSync;
      fs.readdirSync = originalReaddirSync;
    }
    assert.deepEqual(
      warm.map(session => session.sessionId).sort(),
      initial.map(session => session.sessionId).sort(),
    );
    assert.ok(statCalls < 1_000, `warm orphan scan made ${statCalls} stat calls`);
    assert.ok(readdirCalls < 100, `warm orphan scan made ${readdirCalls} directory reads`);

    const previousActivity = warm.find(session => session.sessionId === activeSessionId).lastActivity;
    const advancedAt = new Date(Date.now() + 1000);
    fs.utimesSync(activeChild, advancedAt, advancedAt);
    const advanced = adapter.getActiveSessions(thresholdMs)
      .find(session => session.sessionId === activeSessionId);
    assert.ok(advanced.lastActivity > previousActivity);

    const diagnostics = adapter.getPerfStats().orphanScan;
    assert.ok(diagnostics.subagentActivityEntries <= diagnostics.subagentActivityLimit);
  } finally {
    adapter?.shutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
