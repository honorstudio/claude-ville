import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const { OmpAdapter, parseOmpTranscript } = require('../../claudeville/adapters/omp.js');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const USER_AT = NOW - 20_000;
const ASSISTANT_AT = NOW - 10_000;

function sessionRecord(id) {
  return {
    type: 'session',
    id,
    timestamp: new Date(USER_AT - 1_000).toISOString(),
    cwd: '/workspace/omp-turn-state',
  };
}

function messageRecord(id, role, at, content) {
  return {
    type: 'message',
    id,
    timestamp: new Date(at).toISOString(),
    message: { role, content },
  };
}

function parse(records, id) {
  return parseOmpTranscript(records, {
    filePath: `/tmp/${id}.jsonl`,
    now: NOW,
    fileMtimeMs: NOW,
  }).session;
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

test('OMP derives tool_pending from an open tool and never reports unknown', () => {
  const id = '01900000-0000-7000-8000-000000000101';
  const session = parse([
    sessionRecord(id),
    messageRecord('user-1', 'user', USER_AT, 'Inspect the project.'),
    messageRecord('assistant-1', 'assistant', ASSISTANT_AT, [
      { type: 'toolCall', id: 'call-1', name: 'shell', arguments: { command: 'node --test' } },
    ]),
  ], id);

  assert.equal(session.turnState, 'tool_pending');
  assert.notEqual(session.turnState, 'unknown');
  assert.equal(session.pendingTool, 'shell');
  assert.equal(session.pendingSince, ASSISTANT_AT);
  assert.equal(session.awaitingSince, null);
  assert.equal(session.waitReason, null);
  assert.equal(session.signalSource, 'transcript');
  assert.equal(session.turnStartedAt, USER_AT);
});

test('OMP derives awaiting_input from a closed assistant turn', () => {
  const id = '01900000-0000-7000-8000-000000000102';
  const session = parse([
    sessionRecord(id),
    messageRecord('user-1', 'user', USER_AT, 'Summarize the result.'),
    messageRecord('assistant-1', 'assistant', ASSISTANT_AT, [
      { type: 'text', text: 'The task is complete.' },
    ]),
  ], id);

  assert.equal(session.turnState, 'awaiting_input');
  assert.equal(session.awaitingSince, ASSISTANT_AT);
  assert.equal(session.pendingTool, null);
  assert.equal(session.pendingSince, null);
  assert.equal(session.waitReason, null);
  assert.equal(session.signalSource, 'transcript');
  assert.equal(session.turnStartedAt, USER_AT);
});

test('OMP derives working after a user starts a new turn', () => {
  const id = '01900000-0000-7000-8000-000000000103';
  const nextUserAt = NOW - 1_000;
  const session = parse([
    sessionRecord(id),
    messageRecord('assistant-1', 'assistant', ASSISTANT_AT, 'Earlier answer.'),
    messageRecord('user-1', 'user', nextUserAt, 'Continue.'),
  ], id);

  assert.equal(session.turnState, 'working');
  assert.equal(session.turnStartedAt, nextUserAt);
  assert.equal(session.awaitingSince, null);
});

test('OMP detail index misses do not reparse transcripts until a directory mtime changes', () => {
  const tmpRoot = makeTempDir('claudeville-omp-detail-gate-');
  const projectDir = path.join(tmpRoot, 'project');
  const id = '01900000-0000-7000-8000-000000000104';
  const transcriptPath = path.join(projectDir, `${id}.jsonl`);
  writeJsonl(transcriptPath, [sessionRecord(id)]);

  const adapter = new OmpAdapter({ rootDir: tmpRoot, now: () => NOW });
  const originalParseFile = adapter._parseFile.bind(adapter);
  let parseCount = 0;
  adapter._parseFile = (...args) => {
    if (!args[1]?.detail) parseCount += 1;
    return originalParseFile(...args);
  };

  try {
    adapter.getSessionDetail('omp-missing-first');
    assert.equal(parseCount, 1);

    adapter.getSessionDetail('omp-missing-second');
    assert.equal(parseCount, 1);

    const nextId = '01900000-0000-7000-8000-000000000105';
    writeJsonl(path.join(projectDir, `${nextId}.jsonl`), [sessionRecord(nextId)]);
    const bumpedAt = new Date(NOW + 60_000);
    fs.utimesSync(projectDir, bumpedAt, bumpedAt);

    const detail = adapter.getSessionDetail(`omp-${nextId}`);
    assert.equal(detail.sessionId, `omp-${nextId}`);
    assert.equal(parseCount, 3);
  } finally {
    adapter.shutdown();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
