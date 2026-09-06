#!/usr/bin/env node

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { startIsolatedServer } from './support/isolated-server.mjs';
import { makeTempDir } from '../tests/support/tmp.mjs';

const REQUEST_TIMEOUT_MS = 2_000;
const FRAME_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = 30_000;

const SESSION_ID = 'boot-contract-session';
const INITIAL_MESSAGE = 'Boot contract initial';
const DELTA_MESSAGE = 'Boot contract delta';

function oneLine(error) {
  const message = String(error?.message || error || 'unknown failure')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 1_000) || 'unknown failure';
}

function assertObject(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function touch(filePath, timestamp) {
  const date = new Date(timestamp);
  fs.utimesSync(filePath, date, date);
}

function createFixture(home) {
  const project = path.join(home, 'fixture-project');
  const claudeDir = path.join(home, '.claude');
  const encodedProject = project.replaceAll('/', '-');
  const projectDir = path.join(claudeDir, 'projects', encodedProject);
  const historyFile = path.join(claudeDir, 'history.jsonl');
  const sessionFile = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const binDir = path.join(home, 'bin');
  const repositoryRoot = path.join(home, 'repositories');
  const now = Date.now();

  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.writeFileSync(path.join(project, 'fixture.txt'), 'synthetic fixture data\n');

  writeJsonLines(historyFile, [{
    sessionId: SESSION_ID,
    agentId: null,
    agentType: 'main',
    model: 'claude-sonnet-4-5',
    project,
    timestamp: now,
    display: INITIAL_MESSAGE,
  }]);
  writeJsonLines(sessionFile, [
    {
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: new Date(now - 1_000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Read the synthetic fixture.' }],
      },
    },
    {
      type: 'assistant',
      sessionId: SESSION_ID,
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'tool_use',
            id: 'boot-contract-initial-tool',
            name: 'Read',
            input: { file_path: path.join(project, 'fixture.txt') },
          },
          { type: 'text', text: INITIAL_MESSAGE },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ]);
  touch(historyFile, now);
  touch(sessionFile, now);

  return {
    home,
    project,
    binDir,
    repositoryRoot,
    historyFile,
    sessionFile,
  };
}

function appendDeltaFixture(fixture) {
  const now = Date.now();
  fs.appendFileSync(fixture.historyFile, `${JSON.stringify({
    sessionId: SESSION_ID,
    agentId: null,
    agentType: 'main',
    model: 'claude-sonnet-4-5',
    project: fixture.project,
    timestamp: now,
    display: DELTA_MESSAGE,
  })}\n`);
  fs.appendFileSync(fixture.sessionFile, `${JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: new Date(now).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        {
          type: 'tool_use',
          id: 'boot-contract-delta-tool',
          name: 'Write',
          input: { file_path: path.join(fixture.project, 'delta.txt') },
        },
        { type: 'text', text: DELTA_MESSAGE },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    },
  })}\n`);
  touch(fixture.historyFile, now);
  touch(fixture.sessionFile, now);
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: pathname,
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.once('error', finish);
      res.once('aborted', () => finish(new Error(`GET ${pathname} response aborted`)));
      res.once('end', () => finish(null, {
        statusCode: res.statusCode,
        headers: res.headers,
        body,
      }));
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`GET ${pathname} timed out`));
    }, REQUEST_TIMEOUT_MS);
    req.once('error', finish);
    req.end();
  });
}

async function requestJson(port, pathname) {
  let response;
  try {
    response = await request(port, pathname);
  } catch (error) {
    throw new Error(
      `GET ${pathname} could not reach isolated server on port ${port}: ${oneLine(error)}; possible port collision or server startup failure`,
    );
  }
  assert.equal(response.statusCode, 200, `${pathname} returned HTTP ${response.statusCode}`);
  assert.match(
    String(response.headers['content-type'] || ''),
    /application\/json/i,
    `${pathname} did not return JSON`,
  );
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`Invalid JSON from ${pathname}: ${oneLine(error)}`);
  }
}

function frameForClient(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index++) {
    masked[index] = body[index] ^ mask[index % 4];
  }

  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

class BootWebSocket {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.handshakeBuffer = Buffer.alloc(0);
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.messages = [];
    this.waiters = [];
    this.closedError = null;
  }

  async connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const statusCode = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = socket;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error) => {
        this.fail(error);
        finish(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(`WebSocket upgrade timed out on port ${this.port}`));
      }, FRAME_TIMEOUT_MS);

      socket.setNoDelay(true);
      socket.once('error', fail);
      socket.once('close', () => {
        const error = this.closedError || new Error('WebSocket closed');
        if (!this.closedError) this.closedError = error;
        if (!this.handshakeComplete) finish(error);
        else this.rejectWaiters(error);
      });
      socket.on('data', (chunk) => {
        try {
          if (!this.handshakeComplete) {
            this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
            const boundary = this.handshakeBuffer.indexOf('\r\n\r\n');
            if (boundary < 0) return;
            const headerText = this.handshakeBuffer.subarray(0, boundary).toString('latin1');
            const match = headerText.match(/^HTTP\/1\.1\s+(\d+)/i);
            const receivedStatus = Number(match?.[1] || 0);
            if (receivedStatus !== 101) {
              fail(new Error(`WebSocket upgrade returned HTTP ${receivedStatus || 'unknown'}`));
              return;
            }
            this.handshakeComplete = true;
            this.buffer = this.handshakeBuffer.subarray(boundary + 4);
            this.handshakeBuffer = Buffer.alloc(0);
            this.consumeFrames();
            finish(null, receivedStatus);
            return;
          }
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.consumeFrames();
        } catch (error) {
          fail(error);
        }
      });
      socket.once('connect', () => {
        socket.write(
          `GET /ws HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${this.port}\r\n`
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\n`
          + 'Sec-WebSocket-Version: 13\r\n'
          + `Origin: http://127.0.0.1:${this.port}\r\n`
          + '\r\n',
        );
      });
    });
    this.sendJson({ type: 'hello', deltas: true });
    return statusCode;
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!this.closedError) this.closedError = failure;
    this.rejectWaiters(failure);
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  sendJson(value) {
    assert.ok(this.socket && !this.socket.destroyed, 'WebSocket is not connected');
    this.socket.write(frameForClient(JSON.stringify(value)));
  }

  consumeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const extended = this.buffer.readBigUInt64BE(2);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('WebSocket frame is too large');
        }
        length = Number(extended);
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      let payloadOffset = offset;
      let mask = null;
      if (masked) {
        mask = this.buffer.subarray(payloadOffset, payloadOffset + 4);
        payloadOffset += 4;
      }
      const payload = Buffer.from(this.buffer.subarray(payloadOffset, payloadOffset + length));
      if (mask) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.buffer = this.buffer.subarray(payloadOffset + length);

      if (opcode === 0x1) {
        this.receiveMessage(JSON.parse(payload.toString('utf8')));
      } else if (opcode === 0x9) {
        this.socket.write(frameForClient(payload, 0xa));
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        this.fail(new Error(`WebSocket closed by server${code ? ` with code ${code}` : ''}`));
        return;
      } else if (opcode !== 0xa) {
        throw new Error(`Unsupported WebSocket opcode ${opcode}`);
      }
    }
  }

  receiveMessage(message) {
    for (let index = 0; index < this.waiters.length; index++) {
      const waiter = this.waiters[index];
      if (!waiter.predicate(message)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  waitForMessage(predicate, timeout = FRAME_TIMEOUT_MS) {
    for (let index = 0; index < this.messages.length; index++) {
      const message = this.messages[index];
      if (!predicate(message)) continue;
      this.messages.splice(index, 1);
      return Promise.resolve(message);
    }
    if (this.closedError) return Promise.reject(this.closedError);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for a WebSocket message after ${timeout}ms`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    this.fail(new Error('WebSocket closed during smoke cleanup'));
    try {
      this.socket.write(frameForClient(Buffer.from([0x03, 0xe8]), 0x8));
    } catch {
      // Child shutdown below also closes all WebSocket sockets.
    }
    this.socket.destroy();
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pointerParts(pointer) {
  assert.equal(typeof pointer, 'string', 'JSON-Patch path must be a string');
  if (pointer === '') return [];
  assert.ok(pointer.startsWith('/'), `Invalid JSON-Patch pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function applyJsonPatch(document, patch) {
  assert.ok(Array.isArray(patch) && patch.length > 0, 'WebSocket delta must contain patch operations');
  const result = cloneJson(document);
  for (const operation of patch) {
    const parts = pointerParts(operation.path);
    if (parts.length === 0) {
      assert.notEqual(operation.op, 'remove', 'Removing the patch root is unsupported');
      assert.ok(operation.op === 'add' || operation.op === 'replace');
      return cloneJson(operation.value);
    }

    let parent = result;
    for (const part of parts.slice(0, -1)) {
      parent = parent[Array.isArray(parent) ? Number(part) : part];
    }
    const leaf = parts.at(-1);
    if (Array.isArray(parent)) {
      const index = leaf === '-' ? parent.length : Number(leaf);
      assert.ok(Number.isInteger(index) && index >= 0, `Invalid array patch index: ${leaf}`);
      if (operation.op === 'add') parent.splice(index, 0, cloneJson(operation.value));
      else if (operation.op === 'replace') parent[index] = cloneJson(operation.value);
      else if (operation.op === 'remove') parent.splice(index, 1);
      else assert.fail(`Unsupported JSON-Patch operation: ${operation.op}`);
    } else {
      if (operation.op === 'add' || operation.op === 'replace') parent[leaf] = cloneJson(operation.value);
      else if (operation.op === 'remove') delete parent[leaf];
      else assert.fail(`Unsupported JSON-Patch operation: ${operation.op}`);
    }
  }
  return result;
}

function coreState(message) {
  return {
    sessions: message.sessions,
    teams: message.teams,
    usage: message.usage,
  };
}

function sessionForId(sessions, sessionId = SESSION_ID) {
  const session = sessions.find(item => item.sessionId === sessionId);
  assert.ok(session, `Expected synthetic session ${sessionId}`);
  return session;
}

function assertSnapshot(message, label) {
  const expectedType = label === 'baseline' ? 'update' : 'init';
  assert.equal(message.type, expectedType, `${label} must be a full snapshot`);
  assert.ok(Number.isInteger(message.seq) && message.seq > 0, `${label} must have a positive sequence`);
  assert.ok(Array.isArray(message.sessions), `${label}.sessions must be an array`);
  assert.ok(Array.isArray(message.teams), `${label}.teams must be an array`);
  assertObject(message.usage, `${label}.usage`);
  sessionForId(message.sessions);
}

function assertProvidersPayload(payload, fixture) {
  assertObject(payload, '/api/providers payload');
  assert.ok(Array.isArray(payload.providers), '/api/providers.providers must be an array');
  assert.equal(payload.count, payload.providers.length, '/api/providers.count must match providers');
  const claude = payload.providers.find(provider => provider.provider === 'claude');
  assert.ok(claude, 'Synthetic Claude provider was not served');
  assert.equal(claude.homeDir, path.join(fixture.home, '.claude'));
  assert.equal(typeof claude.name, 'string');
  assert.equal(typeof claude.supportsDetail, 'boolean');
  assert.equal(typeof claude.supportsWatchPaths, 'boolean');
  assert.ok(Array.isArray(payload.health), '/api/providers.health must be an array');
  const claudeHealth = payload.health.find(provider => provider.id === 'claude');
  assert.ok(claudeHealth, 'Claude provider health was not served');
  assert.equal(typeof claudeHealth.name, 'string');
  assert.equal(typeof claudeHealth.health, 'string');
  assert.equal(typeof claudeHealth.sessions, 'number');
}

function assertSessionsPayload(payload) {
  assertObject(payload, '/api/sessions payload');
  assert.ok(Array.isArray(payload.sessions), '/api/sessions.sessions must be an array');
  assert.equal(payload.count, payload.sessions.length, '/api/sessions.count must match sessions');
  assert.equal(typeof payload.timestamp, 'number');
  const session = sessionForId(payload.sessions);
  assert.equal(session.provider, 'claude');
  assert.equal(session.model, 'claude-sonnet-4-5');
}

function assertUsagePayload(payload) {
  assertObject(payload, '/api/usage payload');
  assert.equal(payload.provider, 'claude');
  assertObject(payload.account, '/api/usage.account');
  assertObject(payload.quota, '/api/usage.quota');
  assertObject(payload.activity, '/api/usage.activity');
  assertObject(payload.totals, '/api/usage.totals');
  assert.equal(typeof payload.quotaAvailable, 'boolean');
}

async function cleanup(context) {
  let cleanupError = null;
  try {
    context.websocket?.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await context.server?.stop();
  } catch (error) {
    cleanupError ||= error;
  }
  try {
    if (context.tmpHome) {
      fs.rmSync(context.tmpHome, { recursive: true, force: true });
      if (fs.existsSync(context.tmpHome)) {
        throw new Error('Temporary HOME still exists after cleanup');
      }
    }
  } catch (error) {
    cleanupError ||= error;
  }
  if (cleanupError) throw cleanupError;
}

async function run(context) {
  context.tmpHome = makeTempDir('claudeville-boot-contract-');
  const fixture = createFixture(context.tmpHome);
  const server = await startIsolatedServer({
    home: fixture.home,
    env: {
      PATH: fixture.binDir,
      CLAUDEVILLE_REPOSITORY_SCAN_ROOT: fixture.repositoryRoot,
    },
  });
  context.server = server;

  let rootResponse;
  try {
    rootResponse = await request(server.port, '/');
  } catch (error) {
    throw new Error(
      `GET / could not reach isolated server on port ${server.port}: ${oneLine(error)}; possible port collision or server startup failure`,
    );
  }
  assert.equal(rootResponse.statusCode, 200, `GET / returned HTTP ${rootResponse.statusCode}`);
  assert.match(String(rootResponse.headers['content-type'] || ''), /text\/html/i, 'GET / did not return HTML');
  assert.match(rootResponse.body, /<html[\s>]/i, 'GET / body was not HTML');

  const providers = await requestJson(server.port, '/api/providers');
  assertProvidersPayload(providers, fixture);

  const sessions = await requestJson(server.port, '/api/sessions');
  assertSessionsPayload(sessions);

  const usage = await requestJson(server.port, '/api/usage');
  assertUsagePayload(usage);

  context.websocket = new BootWebSocket(server.port);
  const statusCode = await context.websocket.connect();
  assert.equal(statusCode, 101, 'WebSocket upgrade must return HTTP 101');

  const initial = await context.websocket.waitForMessage(message => message?.type === 'init');
  assertSnapshot(initial, 'initial');

  const baseline = await context.websocket.waitForMessage(
    message => message?.type === 'update'
      && Array.isArray(message.sessions)
      && !('patch' in message),
  );
  assertSnapshot(baseline, 'baseline');
  assert.ok(baseline.seq > initial.seq, 'Full update must advance the initial sequence');

  appendDeltaFixture(fixture);
  const delta = await context.websocket.waitForMessage(message => message?.type === 'update-delta');
  assert.equal(delta.baseSeq, baseline.seq, 'Delta must use the full snapshot sequence as its base');
  assert.equal(delta.seq, baseline.seq + 1, 'Delta sequence must advance by one');
  const reconstructed = applyJsonPatch(coreState(baseline), delta.patch);
  const changedSession = sessionForId(reconstructed.sessions);
  assert.equal(changedSession.lastMessage, DELTA_MESSAGE);
  assert.equal(changedSession.lastTool, 'Write');

  context.websocket.sendJson({ type: 'resync' });
  const resynced = await context.websocket.waitForMessage(
    message => message?.type === 'init' && message.seq > delta.seq,
  );
  assertSnapshot(resynced, 'resync');
  assert.equal(sessionForId(resynced.sessions).lastMessage, DELTA_MESSAGE);
}

async function main() {
  const context = {
    tmpHome: null,
    server: null,
    port: null,
    websocket: null,
  };
  let failure = null;
  let overallTimer = null;

  try {
    const operation = run(context);
    const timeout = new Promise((_, reject) => {
      overallTimer = setTimeout(() => {
        reject(new Error(`Overall boot contract timeout after ${OVERALL_TIMEOUT_MS}ms`));
      }, OVERALL_TIMEOUT_MS);
    });
    await Promise.race([operation, timeout]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(overallTimer);
    try {
      await cleanup(context);
    } catch (error) {
      failure ||= error;
    }
  }

  if (failure) {
    console.error(`boot contract smoke failed: ${oneLine(failure)}`);
    process.exitCode = 1;
    return;
  }
  console.log('boot contract smoke passed');
}

main().catch(error => {
  console.error(`boot contract smoke failed: ${oneLine(error)}`);
  process.exitCode = 1;
});
