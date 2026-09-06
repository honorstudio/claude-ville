import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { makeTempDir } from '../tests/support/tmp.mjs';

const tmpHome = makeTempDir('claudeville-transcript-');
const project = path.join(tmpHome, 'workspace', 'project-alpha');
const encodedProject = project.replace(/\//g, '-');
const claudeDir = path.join(tmpHome, '.claude');
const projectDir = path.join(claudeDir, 'projects', encodedProject);
const sessionId = 'aggregate-main';
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const subagentId = 'aggregate-child';
const prompt = 'Review cafe\u0301 and Delta';
const activeThresholdMs = 10 * 60 * 1000;

process.env.HOME = tmpHome;
process.env.CLAUDEVILLE_TRANSCRIPT_ASYNC_THRESHOLD_BYTES = String(64 * 1024);
process.env.CLAUDEVILLE_CLAUDE_PARSED_TAIL_CACHE_MAX_BYTES = String(384 * 1024);
process.env.CLAUDEVILLE_CLAUDE_TRANSCRIPT_CACHE_MAX_BYTES = String(1024 * 1024);

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function usageEntry(input, output, { cacheRead = 0, cacheCreate = 0, content = [] } = {}) {
  return {
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
      content,
    },
  };
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function usageFor(adapter, id = sessionId) {
  return adapter.getSessionDetail(id, project).tokenUsage;
}

try {
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(claudeDir, 'history.jsonl'), jsonLine({
    sessionId,
    project,
    timestamp: Date.now(),
    display: 'aggregate fixture',
  }));

  const launch = {
    type: 'tool_use',
    name: 'Agent',
    input: {
      description: 'Transcript analyst',
      subagent_type: 'explorer',
      prompt,
    },
  };
  writeFile(transcript, [
    jsonLine(usageEntry(2, 3, { cacheRead: 5, content: [launch] })),
    '{malformed-json\n',
    jsonLine(usageEntry(7, 11, { cacheCreate: 13, content: [{ type: 'text', text: 'Zażółć' }] })),
  ].join(''));
  writeFile(
    path.join(projectDir, sessionId, 'subagents', `agent-${subagentId}.jsonl`),
    jsonLine({ message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
  );

  const require = createRequire(import.meta.url);
  const { ClaudeAdapter } = require('../../claudeville/adapters/claude.js');
  const { getTailCacheDiagnostics } = require('../../claudeville/adapters/shared.js');
  const adapter = new ClaudeAdapter();
  let completionNotifications = 0;
  adapter.setDataReadyCallback(() => { completionNotifications++; });

  const initial = usageFor(adapter);
  assert.deepEqual(initial, {
    input: 9,
    output: 14,
    totalInput: 9,
    totalOutput: 14,
    cacheRead: 5,
    cacheCreate: 13,
    contextWindow: 20,
    turnCount: 2,
  });
  const sessions = adapter.getActiveSessions(activeThresholdMs);
  const child = sessions.find((session) => session.sessionId === `subagent-${subagentId}`);
  assert.equal(child?.agentName, 'Transcript analyst');
  assert.equal(child?.agentType, 'explorer');

  const noNewlineSessionId = 'aggregate-no-newline';
  const noNewlineTranscript = path.join(projectDir, `${noNewlineSessionId}.jsonl`);
  writeFile(noNewlineTranscript, JSON.stringify(usageEntry(73, 79)));
  assert.equal(usageFor(adapter, noNewlineSessionId).totalInput, 73);
  fs.appendFileSync(noNewlineTranscript, '\n');
  assert.equal(usageFor(adapter, noNewlineSessionId).totalInput, 73, 'newline completion must not double-count');

  const splitLine = Buffer.from(jsonLine(usageEntry(17, 19, {
    content: [{ type: 'text', text: 'split cafe\u0301 bytes' }],
  })));
  const splitMarker = Buffer.from('e\u0301');
  const markerOffset = splitLine.indexOf(splitMarker);
  assert.ok(markerOffset >= 0, 'UTF-8 marker should be present');
  const splitAt = markerOffset + 2;
  fs.appendFileSync(transcript, splitLine.subarray(0, splitAt));
  assert.equal(usageFor(adapter).turnCount, 2, 'partial line must not be committed');
  fs.appendFileSync(transcript, splitLine.subarray(splitAt));
  const afterSplit = usageFor(adapter);
  assert.equal(afterSplit.totalInput, 26);
  assert.equal(afterSplit.totalOutput, 33);
  assert.equal(afterSplit.turnCount, 3);

  const sameSize = fs.statSync(transcript).size;
  const rewrittenEntry = JSON.stringify(usageEntry(23, 29));
  assert.ok(Buffer.byteLength(rewrittenEntry) + 1 < sameSize);
  writeFile(transcript, `${rewrittenEntry}${' '.repeat(sameSize - Buffer.byteLength(rewrittenEntry) - 1)}\n`);
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(transcript, future, future);
  const rewritten = usageFor(adapter);
  assert.equal(rewritten.totalInput, 23);
  assert.equal(rewritten.totalOutput, 29);
  assert.equal(rewritten.turnCount, 1);

  writeFile(transcript, jsonLine(usageEntry(31, 37)));
  const truncated = usageFor(adapter);
  assert.equal(truncated.totalInput, 31);
  assert.equal(truncated.totalOutput, 37);

  fs.renameSync(transcript, `${transcript}.rotated`);
  writeFile(transcript, jsonLine(usageEntry(41, 43)));
  const rotated = usageFor(adapter);
  assert.equal(rotated.totalInput, 41);
  assert.equal(rotated.totalOutput, 43);

  const guardedBase = `${jsonLine(usageEntry(10, 1))}${jsonLine(usageEntry(20, 2))}`;
  writeFile(transcript, guardedBase);
  assert.equal(usageFor(adapter).totalInput, 30);
  const guardedRewrite = Buffer.from(guardedBase.replace('"input_tokens":20', '"input_tokens":30'));
  fs.writeFileSync(transcript, guardedRewrite);
  fs.appendFileSync(transcript, jsonLine(usageEntry(5, 3)));
  const guardRecovered = usageFor(adapter);
  assert.equal(guardRecovered.totalInput, 45);
  assert.equal(guardRecovered.turnCount, 3);

  const largeSessionId = 'aggregate-large';
  const largeTranscript = path.join(projectDir, `${largeSessionId}.jsonl`);
  const firstLarge = Buffer.from(jsonLine(usageEntry(47, 53)));
  writeFile(largeTranscript, firstLarge);
  const sparseOffset = 12 * 1024 * 1024;
  fs.truncateSync(largeTranscript, sparseOffset);
  const fd = fs.openSync(largeTranscript, 'r+');
  const lastLarge = Buffer.from(`\n${jsonLine(usageEntry(59, 61))}`);
  fs.writeSync(fd, lastLarge, 0, lastLarge.length, sparseOffset);
  fs.closeSync(fd);

  let eventLoopTicks = 0;
  const tickTimer = setInterval(() => { eventLoopTicks++; }, 5);
  const initialStartedAt = performance.now();
  const pendingUsage = usageFor(adapter, largeSessionId);
  const initialDurationMs = performance.now() - initialStartedAt;
  assert.ok(initialDurationMs < 500, `oversized initial call blocked for ${initialDurationMs.toFixed(1)}ms`);
  assert.deepEqual(pendingUsage, {
    input: 0,
    output: 0,
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    turnCount: 0,
  });
  assert.equal(adapter.getPerfStats().transcriptAggregate.pending, 1);
  await waitFor(() => adapter.getPerfStats().transcriptAggregate.pending === 0);
  clearInterval(tickTimer);
  assert.ok(eventLoopTicks > 2, 'event loop should advance during the oversized scan');
  const completedLarge = usageFor(adapter, largeSessionId);
  assert.equal(completedLarge.totalInput, 106);
  assert.equal(completedLarge.totalOutput, 114);
  assert.equal(completedLarge.turnCount, 2);

  const largeAppend = Buffer.concat([
    Buffer.alloc(128 * 1024, 32),
    Buffer.from(jsonLine(usageEntry(67, 71))),
  ]);
  fs.appendFileSync(largeTranscript, largeAppend);
  const lastKnown = usageFor(adapter, largeSessionId);
  assert.equal(lastKnown.totalInput, 106, 'large append should return last-known usage while pending');
  assert.equal(adapter.getPerfStats().transcriptAggregate.pending, 1);
  await waitFor(() => adapter.getPerfStats().transcriptAggregate.pending === 0);
  const completedAppend = usageFor(adapter, largeSessionId);
  assert.equal(completedAppend.totalInput, 173);
  assert.equal(completedAppend.totalOutput, 185);
  assert.equal(completedAppend.turnCount, 3);

  const workingSetIds = Array.from({ length: 129 }, (_, index) => `working-set-${String(index).padStart(3, '0')}`);
  const workingSetHistory = [];
  for (const [index, id] of workingSetIds.entries()) {
    workingSetHistory.push(jsonLine({
      sessionId: id,
      project,
      timestamp: Date.now(),
      display: `working set ${index}`,
    }));
    writeFile(path.join(projectDir, `${id}.jsonl`), jsonLine(usageEntry(index + 1, 1)));
  }
  fs.appendFileSync(path.join(claudeDir, 'history.jsonl'), workingSetHistory.join(''));

  const fullScansBeforeWorkingSet = adapter.getPerfStats().transcriptAggregate.fullScans;
  const firstWorkingSet = adapter.getActiveSessions(activeThresholdMs);
  for (const id of workingSetIds) {
    const session = firstWorkingSet.find((candidate) => candidate.sessionId === id);
    assert.equal(session?.status, 'active', `${id} should remain an active session`);
  }
  const fullScansAfterWorkingSet = adapter.getPerfStats().transcriptAggregate.fullScans;
  assert.ok(fullScansAfterWorkingSet - fullScansBeforeWorkingSet >= workingSetIds.length);
  adapter.getActiveSessions(activeThresholdMs);
  assert.equal(
    adapter.getPerfStats().transcriptAggregate.fullScans,
    fullScansAfterWorkingSet,
    'a 129-session active working set must remain warm on the next pass'
  );

  const projectedTailId = 'projected-oversized-tail';
  const projectedTailPath = path.join(projectDir, `${projectedTailId}.jsonl`);
  const largeText = 'projection-fixture-'.repeat(9_000);
  const oversizedScalar = 'scalar-projection-fixture-'.repeat(12_000);
  const oversizedNonArrayContent = {
    output: 'non-array-projection-fixture-'.repeat(12_000),
  };
  const projectedTailLines = Array.from(
    { length: 218 },
    (_, index) => jsonLine(usageEntry(index + 1, 1, {
      content: [{ type: 'text', text: `${index}:${largeText}` }],
    })),
  );
  projectedTailLines.push(
    jsonLine(oversizedScalar),
    jsonLine(usageEntry(219, 1, {
      content: [{
        type: 'tool_result',
        tool_use_id: 'oversized-non-array-result',
        content: oversizedNonArrayContent,
      }],
    })),
  );
  writeFile(
    projectedTailPath,
    projectedTailLines.join(''),
  );
  assert.ok(fs.statSync(projectedTailPath).size > 32 * 1024 * 1024);
  const projectionRejectsBefore = adapter.getPerfStats().parsedTailCache.rejectedEntries;
  adapter.getSessionDetail(projectedTailId, project);
  const projectedAfterFirst = getTailCacheDiagnostics().parsed.parsedLines;
  adapter.getSessionDetail(projectedTailId, project);
  const projectedAfterSecond = getTailCacheDiagnostics().parsed.parsedLines;
  assert.equal(
    projectedAfterSecond,
    projectedAfterFirst,
    'an unchanged oversized raw tail must reuse Claude\'s compact projection',
  );
  const projectionDiagnostics = adapter.getPerfStats().parsedTailCache;
  assert.equal(
    projectionDiagnostics.rejectedEntries,
    projectionRejectsBefore,
    'oversized scalar and non-array content must project within Claude\'s parsed-tail byte budget',
  );
  assert.ok(projectionDiagnostics.projection.bytesDropped > 0);
  await waitFor(() => adapter.getPerfStats().transcriptAggregate.pending === 0);

  const parsedEvictionsBefore = adapter.getPerfStats().parsedTailCache.evictions;
  for (let index = 0; index < 6; index++) {
    const id = `parsed-tail-pressure-${index}`;
    writeFile(path.join(projectDir, `${id}.jsonl`), jsonLine(usageEntry(1, 1, {
      content: [{
        type: 'tool_use',
        id: `tool-${index}`,
        name: 'Bash',
        input: { command: `printf %s ${'p'.repeat(48 * 1024)}` },
      }],
    })));
    usageFor(adapter, id);
  }
  const parsedTailDiagnostics = adapter.getPerfStats().parsedTailCache;
  assert.ok(parsedTailDiagnostics.estimatedBytes <= parsedTailDiagnostics.byteLimit);
  assert.ok(parsedTailDiagnostics.evictions > parsedEvictionsBefore);
  assert.ok(parsedTailDiagnostics.byteEvictions > 0);

  const aggregateEvictionsBefore = adapter.getPerfStats().transcriptAggregate.evictions;
  for (let index = 0; index < 24; index++) {
    const id = `aggregate-pressure-${index}`;
    writeFile(path.join(projectDir, `${id}.jsonl`), 'x'.repeat(60 * 1024));
    usageFor(adapter, id);
  }

  const diagnostics = adapter.getPerfStats().transcriptAggregate;
  assert.ok(diagnostics.bytesRead >= fs.statSync(largeTranscript).size);
  assert.ok(diagnostics.fullScans >= 5);
  assert.ok(diagnostics.incrementalScans >= 3);
  assert.ok(diagnostics.asyncScans >= 2);
  assert.ok(diagnostics.asyncCompletions >= 2);
  assert.ok(diagnostics.malformedLines >= 1);
  assert.ok(diagnostics.oversizedLines >= 1);
  assert.ok(diagnostics.rewrites >= 2);
  assert.ok(diagnostics.truncations >= 1);
  assert.ok(diagnostics.rotations >= 1);
  assert.ok(diagnostics.guardMismatches >= 1);
  assert.equal(diagnostics.pending, 0);
  assert.equal(diagnostics.queued, 0);
  assert.ok(diagnostics.estimatedBytes <= diagnostics.byteLimit);
  assert.ok(diagnostics.evictions > aggregateEvictionsBefore);
  assert.ok(diagnostics.cacheByteEvictions > 0);
  assert.ok(diagnostics.entryLimit >= workingSetIds.length);
  assert.ok(completionNotifications >= 2);

  const cancellationIds = ['aggregate-cancel-active', 'aggregate-cancel-queued'];
  const cancellationPaths = cancellationIds.map((id) => path.join(projectDir, `${id}.jsonl`));
  for (const cancellationPath of cancellationPaths) {
    writeFile(cancellationPath, jsonLine(usageEntry(101, 103)));
    fs.truncateSync(cancellationPath, 2 * 1024 * 1024);
  }

  const originalCreateReadStream = fs.createReadStream;
  const controlledStreams = [];
  const destroyedPaths = new Set();
  fs.createReadStream = (filePath, options) => {
    if (!cancellationPaths.includes(filePath)) return originalCreateReadStream(filePath, options);
    const stream = new PassThrough();
    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = (err) => {
      destroyedPaths.add(filePath);
      return originalDestroy(err);
    };
    controlledStreams.push(stream);
    return stream;
  };

  const notificationsBeforeShutdown = completionNotifications;
  let shutdownSnapshot;
  try {
    usageFor(adapter, cancellationIds[0]);
    await waitFor(() => adapter.getPerfStats().transcriptAggregate.activeStreams === 1);
    usageFor(adapter, cancellationIds[1]);
    assert.equal(adapter.getPerfStats().transcriptAggregate.queued, 1);

    adapter.shutdown();
    const shutdownDiagnostics = adapter.getPerfStats().transcriptAggregate;
    assert.equal(shutdownDiagnostics.shutdown, true);
    assert.equal(shutdownDiagnostics.activeStreams, 0);
    assert.equal(shutdownDiagnostics.active, 0);
    assert.equal(shutdownDiagnostics.queued, 0);
    assert.equal(shutdownDiagnostics.cacheEntries, 0);
    assert.equal(adapter.getPerfStats().parsedTailCache.entries, 0);
    assert.ok(shutdownDiagnostics.cancelledActiveScans >= 1);
    assert.ok(shutdownDiagnostics.cancelledQueuedScans >= 1);
    assert.ok(destroyedPaths.has(cancellationPaths[0]));
    shutdownSnapshot = adapter.getPerfStats();
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  controlledStreams[0].emit('data', Buffer.from(jsonLine(usageEntry(997, 991))));
  controlledStreams[0].emit('end');
  adapter.setDataReadyCallback(() => { completionNotifications++; });
  assert.deepEqual(adapter.getActiveSessions(activeThresholdMs), []);
  assert.equal(adapter.isAvailable(), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(adapter.getPerfStats(), shutdownSnapshot, 'shutdown must be terminal for scan state');
  assert.equal(completionNotifications, notificationsBeforeShutdown);

  console.log(
    `claude transcript aggregate smoke passed (${diagnostics.bytesRead} bytes read, `
    + `${diagnostics.cacheEvictions} aggregate evictions, ${eventLoopTicks} event-loop ticks)`
  );
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
