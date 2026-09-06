import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { makeTempDir } from '../tests/support/tmp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpHome = makeTempDir('claudeville-watch-runtime-');
const project = path.join(tmpHome, 'work', 'demo');
const sessionId = 'runtime-fixture';
const projectDir = path.join(tmpHome, '.claude', 'projects', project.replace(/\//g, '-'));
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
const largeSessionId = 'runtime-large-detail';
const largeTranscript = path.join(projectDir, `${largeSessionId}.jsonl`);
let child = null;
let socket = null;
let childOutput = '';
let runtimePort = null;

function writeJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: runtimePort, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
  });
}

async function poll(check, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`condition not met within ${timeoutMs}ms`);
}

function hasWatchResourceExhaustion(perf) {
  return (perf?.recentWatchFailures || []).some((failure) => (
    /\b(?:EMFILE|ENFILE|ENOSPC)\b/.test(String(failure?.message || ''))
  ));
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port: runtimePort });
    const key = crypto.randomBytes(16).toString('base64');
    let response = '';
    const onData = (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      client.off('data', onData);
      if (!response.startsWith('HTTP/1.1 101')) {
        client.destroy();
        reject(new Error(`WebSocket upgrade failed: ${response.split('\r\n')[0]}`));
        return;
      }
      resolve(client);
    };
    client.on('data', onData);
    client.once('error', reject);
    client.on('connect', () => {
      client.write([
        'GET /ws HTTP/1.1',
        `Host: localhost:${runtimePort}`,
        `Origin: http://localhost:${runtimePort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function closeWebSocketClient(client) {
  const mask = crypto.randomBytes(4);
  const status = Buffer.alloc(2);
  status.writeUInt16BE(1000, 0);
  const frame = Buffer.alloc(8);
  frame[0] = 0x88;
  frame[1] = 0x80 | status.length;
  mask.copy(frame, 2);
  for (let index = 0; index < status.length; index++) {
    frame[6 + index] = status[index] ^ mask[index % 4];
  }
  client.end(frame);
}

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      reservation.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

async function waitForExit(processHandle, timeoutMs = 5000) {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  return Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server did not exit after SIGTERM')), timeoutMs)),
  ]);
}

try {
  runtimePort = await reserveEphemeralPort();

  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'runtime fixture\n');
  execFileSync('git', ['-c', 'user.name=ClaudeVille Smoke', '-c', 'user.email=smoke@example.invalid', 'add', 'README.md'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=ClaudeVille Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: project });
  writeJsonLine(path.join(tmpHome, '.claude', 'history.jsonl'), {
    sessionId,
    project,
    timestamp: Date.now(),
    display: 'runtime watcher fixture',
  });
  writeJsonLine(transcript, {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { model: 'fixture', content: [] },
  });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'teams'), { recursive: true });

  const bootstrap = `
    const http = require('http');
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 4000) args[0] = Number(process.env.CLAUDEVILLE_SMOKE_PORT);
      return originalListen.apply(this, args);
    };
    const runtime = require(${JSON.stringify(path.join(repoRoot, 'claudeville', 'server.js'))});
    process.once('SIGTERM', () => runtime.shutdownRuntime({ reason: 'SIGTERM' }));
    runtime.startServer();
  `;
  child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: tmpHome,
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '0',
      CLAUDEVILLE_REPOSITORY_SCAN_ROOT: path.join(tmpHome, 'missing-repository-scan-root'),
      CLAUDEVILLE_SMOKE_PORT: String(runtimePort),
      CLAUDEVILLE_WATCH_ZERO_CLIENT_GRACE_MS: '250',
      CLAUDEVILLE_TRANSCRIPT_ASYNC_THRESHOLD_BYTES: String(64 * 1024),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collectOutput = (chunk) => {
    childOutput = `${childOutput}${chunk.toString()}`.slice(-16_000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);

  const initial = await poll(async () => {
    const perf = await requestJson('/api/perf');
    const ready = perf.watchers?.configured > 0
      && (perf.watchers.stableInstalled > 0 || hasWatchResourceExhaustion(perf));
    return ready ? perf : null;
  });
  const degradedWatchers = initial.watchers.stableInstalled === 0;
  if (degradedWatchers) {
    assert.ok(hasWatchResourceExhaustion(initial), 'watcher installation failed without a resource-exhaustion diagnostic');
    assert.ok(initial.recursiveWatchFallbacks > 0, 'watcher resource exhaustion did not install stat fallbacks');
    assert.ok(initial.watchers.probePaths > 0, 'watcher resource exhaustion did not retain active probes');
  }
  assert.equal(initial.watchers.dynamicEnabled, false);
  assert.equal(initial.watchers.dynamicInstalled, 0);
  const footprintScript = path.join(repoRoot, 'scripts', 'smoke', 'watcher-footprint.mjs');
  const footprintUrl = `http://127.0.0.1:${runtimePort}/api/perf`;
  execFileSync(process.execPath, [footprintScript, '--url', footprintUrl, '--max', '1000'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (initial.watchers.linux?.watchEntries > 0) {
    assert.throws(
      () => execFileSync(process.execPath, [footprintScript, '--url', footprintUrl, '--max', '0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      'a deliberately low watcher bound must fail against the fresh server process',
    );
  }

  socket = await connectWebSocket();
  const connected = await poll(async () => {
    const perf = await requestJson('/api/perf');
    return perf.watchers?.dynamicEnabled && perf.watchers.dynamicRequested > 0 ? perf : null;
  });
  assert.equal(connected.watchers.dynamicEnabled, true);
  assert.ok(connected.watchers.canonical <= connected.watchers.configured);
  if (degradedWatchers) {
    assert.ok(
      connected.watchers.dynamicInstalled > 0 || hasWatchResourceExhaustion(connected),
      'dynamic watchers were unavailable without a resource-exhaustion diagnostic',
    );
    assert.ok(connected.watchers.probePaths > 0, 'degraded dynamic watchers did not retain probes');
  } else {
    assert.ok(connected.watchers.dynamicInstalled > 0);
  }

  writeJsonLine(largeTranscript, {
    message: { role: 'assistant', usage: { input_tokens: 13, output_tokens: 17 }, content: [] },
  });
  const sparseOffset = 256 * 1024 * 1024;
  fs.truncateSync(largeTranscript, sparseOffset);
  const largeFd = fs.openSync(largeTranscript, 'r+');
  const largeTail = Buffer.from(`\n${JSON.stringify({
    message: { role: 'assistant', usage: { input_tokens: 19, output_tokens: 23 }, content: [] },
  })}\n`);
  fs.writeSync(largeFd, largeTail, 0, largeTail.length, sparseOffset);
  fs.closeSync(largeFd);

  const beforeLargeScan = await requestJson('/api/perf');
  const detailPath = `/api/session-detail?provider=claude&sessionId=${encodeURIComponent(largeSessionId)}&project=${encodeURIComponent(project)}`;
  const detailStartedAt = performance.now();
  const pendingDetail = await requestJson(detailPath);
  const detailDurationMs = performance.now() - detailStartedAt;
  assert.ok(detailDurationMs < 500, `oversized detail blocked for ${detailDurationMs.toFixed(1)}ms`);
  assert.deepEqual(pendingDetail.tokenUsage, {
    input: 0,
    output: 0,
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    turnCount: 0,
  });
  const pendingPerf = await requestJson('/api/perf');
  assert.ok(pendingPerf.providers.claude.transcriptAggregate.pending > 0);
  const healthStartedAt = performance.now();
  await requestJson('/api/providers');
  const healthDurationMs = performance.now() - healthStartedAt;
  assert.ok(healthDurationMs < 250, `provider health request took ${healthDurationMs.toFixed(1)}ms`);
  const completedPerf = await poll(async () => {
    const perf = await requestJson('/api/perf');
    const aggregate = perf.providers.claude.transcriptAggregate;
    return aggregate.pending === 0 && perf.dirty.marks > beforeLargeScan.dirty.marks
      ? perf
      : null;
  }, { timeoutMs: 10_000, intervalMs: 50 });
  assert.ok(completedPerf.providers.claude.transcriptAggregate.oversizedLines >= 1);
  const completedDetail = await poll(async () => {
    const detail = await requestJson(detailPath);
    return detail.tokenUsage?.turnCount === 2 ? detail : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  assert.equal(completedDetail.tokenUsage.totalInput, 32);
  assert.equal(completedDetail.tokenUsage.totalOutput, 40);

  const idleBaseline = await poll(async () => {
    const perf = await requestJson('/api/perf');
    return perf.dirty.providerDataDirty === false ? perf : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const beforeAppend = await requestJson('/api/perf');
  assert.equal(
    beforeAppend.gitEnrichment.gitCommandCount,
    idleBaseline.gitEnrichment.gitCommandCount,
    'warm no-change interval must not execute Git commands',
  );
  writeJsonLine(transcript, {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { model: 'fixture', content: [{ type: 'text', text: 'append' }] },
  });
  const afterAppend = await poll(async () => {
    const perf = await requestJson('/api/perf');
    return perf.watchers.probeChanges > beforeAppend.watchers.probeChanges ? perf : null;
  }, { timeoutMs: 5000, intervalMs: 200 });
  assert.ok(afterAppend.runtime.memory.rss > 0);
  assert.ok(afterAppend.runtime.eventLoop.delayMs.p95 !== undefined);
  assert.ok(afterAppend.tailCache.entries >= 0);
  const appendGitCommands = afterAppend.gitEnrichment.gitCommandCount - beforeAppend.gitEnrichment.gitCommandCount;
  assert.ok(appendGitCommands <= 15, `single append executed ${appendGitCommands} Git commands`);
  const sessionStageMaxMs = Math.max(
    0,
    ...afterAppend.recentBroadcasts.map((broadcast) => Number(broadcast.stages?.sessions) || 0),
  );
  assert.ok(sessionStageMaxMs < 250, `session-stage max was ${sessionStageMaxMs}ms`);

  closeWebSocketClient(socket);
  socket = null;
  const retired = await poll(async () => {
    const perf = await requestJson('/api/perf');
    return perf.watchers.dynamicEnabled === false ? perf : null;
  }, { timeoutMs: 5000, intervalMs: 100 });
  assert.equal(retired.watchers.dynamicInstalled, 0);
  if (degradedWatchers) {
    assert.ok(hasWatchResourceExhaustion(retired));
    assert.ok(retired.recursiveWatchFallbacks > 0);
  } else {
    assert.ok(retired.watchers.stableInstalled > 0);
  }
  if (retired.watchers.linux?.watchEntries != null) {
    assert.ok(retired.watchers.linux.watchEntries < 1000);
  }

  child.kill('SIGTERM');
  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 0, `server exited with ${exitCode}\n${childOutput}`);
  child = null;
  console.log(
    `watcher runtime smoke passed${degradedWatchers ? ' (degraded: inotify resources exhausted)' : ''} `
    + `(detail ${detailDurationMs.toFixed(1)}ms, health ${healthDurationMs.toFixed(1)}ms, `
    + `append git commands ${appendGitCommands}, session-stage max ${sessionStageMaxMs}ms)`,
  );
} catch (err) {
  if (childOutput) process.stderr.write(childOutput);
  throw err;
} finally {
  socket?.destroy();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    try { await waitForExit(child); } catch { /* best effort */ }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
