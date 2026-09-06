#!/usr/bin/env node

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSessionObservation } from '../tests/support/session-contract.mjs';
import { makeTempDir } from '../tests/support/tmp.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const SERVER_MODULE = path.join(REPO_ROOT, 'claudeville', 'server.js');
const SERVER_BOOTSTRAP = path.join(SCRIPT_DIR, 'r1-18.server-bootstrap.cjs');

// These values mirror the production scheduler. The harness waits on actual
// frames, rather than sleeping for an assumed fs.watch delivery time.
const BROADCAST_POLL_INTERVAL_MS = 2_000;
const DELTA_SNAPSHOT_INTERVAL_MS = 20_000;
const FRAME_TIMEOUT_MS = 10_000;
const FLOOR_SLACK_MS = 250;

const CLAUDE_SESSION_ID = 'r1-18-claude-session';
const CODEX_THREAD_ID = 'thr-r1-18-codex';
const CODEX_FILE_ID = 'r1-18-codex-rollout';
const GEMINI_FILE_ID = 'r1-18-gemini-session';
const OPENCODE_SESSION_ID = 'ses-r1-18-opencode';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function touch(filePath, timestamp = Date.now()) {
  const date = new Date(timestamp);
  fs.utimesSync(filePath, date, date);
}

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  touch(filePath);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createOpenCodeDatabase(dbPath, { project, now }) {
  const toolPart = JSON.stringify({
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'git status' },
      metadata: { exit: 0 },
      time: { end: now },
    },
  });
  const textPart = JSON.stringify({
    type: 'text',
    text: 'OpenCode replay ready',
  });
  const model = JSON.stringify({ id: 'deepseek-v4-pro', providerID: 'deepseek' });

  const sql = [
    'CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);',
    'CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);',
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);',
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    `INSERT INTO project (id, worktree) VALUES (${sqlLiteral('project-r1-18')}, ${sqlLiteral(project)});`,
    `INSERT INTO session (id, parent_id, project_id, directory, title, version, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, time_archived) VALUES (${sqlLiteral(OPENCODE_SESSION_ID)}, NULL, ${sqlLiteral('project-r1-18')}, ${sqlLiteral(project)}, ${sqlLiteral('OpenCode replay')}, ${sqlLiteral('1')}, ${sqlLiteral('build')}, ${sqlLiteral(model)}, 0, 1200, 300, 40, 200, 0, ${now - 1000}, ${now}, NULL);`,
    `INSERT INTO message (id, session_id, data, time_created) VALUES (${sqlLiteral('message-r1-18-tool')}, ${sqlLiteral(OPENCODE_SESSION_ID)}, ${sqlLiteral(JSON.stringify({ role: 'assistant' }))}, ${now - 900});`,
    `INSERT INTO message (id, session_id, data, time_created) VALUES (${sqlLiteral('message-r1-18-text')}, ${sqlLiteral(OPENCODE_SESSION_ID)}, ${sqlLiteral(JSON.stringify({ role: 'assistant' }))}, ${now - 100});`,
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlLiteral('part-r1-18-tool')}, ${sqlLiteral('message-r1-18-tool')}, ${sqlLiteral(OPENCODE_SESSION_ID)}, ${now - 900}, ${now - 850}, ${sqlLiteral(toolPart)});`,
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlLiteral('part-r1-18-text')}, ${sqlLiteral('message-r1-18-text')}, ${sqlLiteral(OPENCODE_SESSION_ID)}, ${now - 100}, ${now - 50}, ${sqlLiteral(textPart)});`,
  ].join('\n');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const database = new DatabaseSync(dbPath);
    database.exec(sql);
    database.close();
    return 'node';
  } catch (nodeSqliteError) {
    // Node 18 does not expose node:sqlite. The production adapter has the
    // same sqlite3 CLI fallback, so use it when the host provides that tool.
    try {
      fs.rmSync(dbPath, { force: true });
      execFileSync('sqlite3', ['-batch', dbPath, sql], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      return 'cli';
    } catch (cliError) {
      const nodeMessage = nodeSqliteError?.message || String(nodeSqliteError);
      const cliMessage = cliError?.message || String(cliError);
      throw new Error(
        `OpenCode replay needs node:sqlite or the sqlite3 CLI (node:sqlite: ${nodeMessage}; sqlite3: ${cliMessage})`,
      );
    }
  }
}

function createFixtures(root) {
  const home = path.join(root, 'home');
  const project = path.join(home, 'workspace');
  const now = Date.now();
  // Keep the initial session ordering stable while the replay mutates Claude.
  // The non-mutated providers are still comfortably inside the two-minute
  // active window, but Claude remains at index zero so a small edit produces a
  // genuinely small JSON Patch instead of an array-wide reorder.
  const providerActivity = now - 30_000;
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'ClaudeVille R1-18 replay workspace\n');

  const claudeDirectory = path.join(home, '.claude');
  const encodedProject = project.replaceAll('/', '-');
  const claudeProjectDirectory = path.join(claudeDirectory, 'projects', encodedProject);
  const claudeHistoryFile = path.join(claudeDirectory, 'history.jsonl');
  const claudeSessionFile = path.join(claudeProjectDirectory, `${CLAUDE_SESSION_ID}.jsonl`);
  const claudeModel = 'claude-sonnet-4-5';

  writeJsonLines(claudeHistoryFile, [{
    sessionId: CLAUDE_SESSION_ID,
    agentId: null,
    agentType: 'main',
    model: claudeModel,
    project,
    timestamp: now,
    display: 'Claude replay ready',
  }]);
  writeJsonLines(claudeSessionFile, [
    {
      type: 'user',
      sessionId: CLAUDE_SESSION_ID,
      timestamp: new Date(now - 2000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'Inspect the replay workspace.' }] },
    },
    {
      type: 'assistant',
      sessionId: CLAUDE_SESSION_ID,
      timestamp: new Date(now - 1000).toISOString(),
      message: {
        role: 'assistant',
        model: claudeModel,
        content: [{
          type: 'tool_use',
          id: 'claude-tool-r1-18-initial',
          name: 'Read',
          input: { file_path: path.join(project, 'README.md') },
        }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
    {
      type: 'assistant',
      sessionId: CLAUDE_SESSION_ID,
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        model: claudeModel,
        content: [{ type: 'text', text: 'Claude replay ready' }],
        usage: { input_tokens: 120, output_tokens: 25 },
      },
    },
  ]);
  touch(claudeHistoryFile, now);
  touch(claudeSessionFile, now);

  const codexDirectory = path.join(home, '.codex', 'sessions');
  const codexDay = new Date(now);
  const codexDayDirectory = path.join(
    codexDirectory,
    String(codexDay.getUTCFullYear()),
    String(codexDay.getUTCMonth() + 1).padStart(2, '0'),
    String(codexDay.getUTCDate()).padStart(2, '0'),
  );
  const codexRolloutFile = path.join(codexDayDirectory, `rollout-${CODEX_FILE_ID}.jsonl`);
  const codexTimestamp = new Date(now).toISOString();
  writeJsonLines(codexRolloutFile, [
    {
      type: 'session_meta',
      payload: {
        id: CODEX_THREAD_ID,
        cwd: project,
        model: 'gpt-5',
        agent_nickname: 'Codex Replay',
        agent_role: 'main',
      },
    },
    { type: 'turn_context', payload: { model: 'gpt-5', effort: 'medium' } },
    { type: 'event_msg', timestamp: codexTimestamp, payload: { type: 'task_started' } },
    {
      type: 'response_item',
      timestamp: codexTimestamp,
      payload: {
        type: 'function_call',
        name: 'shell',
        call_id: 'codex-call-r1-18',
        arguments: JSON.stringify({ command: 'git status' }),
      },
    },
    {
      type: 'response_item',
      timestamp: codexTimestamp,
      payload: {
        type: 'function_call_output',
        call_id: 'codex-call-r1-18',
        output: 'clean',
      },
    },
    {
      type: 'response_item',
      timestamp: codexTimestamp,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex replay ready' }],
      },
    },
    {
      type: 'event_msg',
      timestamp: codexTimestamp,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 200, output_tokens: 35, cached_input_tokens: 40 },
          last_token_usage: { total_tokens: 235 },
          model_context_window: 200000,
        },
      },
    },
    { type: 'event_msg', timestamp: codexTimestamp, payload: { type: 'task_complete' } },
  ]);
  touch(codexRolloutFile, providerActivity);
  const codexSessionIndex = path.join(home, '.codex', 'session_index.jsonl');
  writeJsonLines(codexSessionIndex, [{
    id: CODEX_THREAD_ID,
    thread_name: 'Codex Replay',
    updated_at: codexTimestamp,
  }]);

  const geminiProjectHash = crypto.createHash('sha256').update(project).digest('hex');
  const geminiChatDirectory = path.join(home, '.gemini', 'tmp', geminiProjectHash, 'chats');
  const geminiSessionFile = path.join(geminiChatDirectory, `session-${GEMINI_FILE_ID}.json`);
  fs.mkdirSync(geminiChatDirectory, { recursive: true });
  fs.writeFileSync(geminiSessionFile, JSON.stringify({
    sessionId: GEMINI_FILE_ID,
    projectHash: geminiProjectHash,
    messages: [
      { type: 'user', content: 'Inspect the replay workspace.', timestamp: codexTimestamp },
      {
        type: 'gemini',
        model: 'gemini-2.5-flash',
        content: 'Gemini replay ready',
        toolCalls: [{ name: 'run_shell_command', args: { command: 'git status' } }],
        tokens: { input: 90, output: 30 },
        timestamp: codexTimestamp,
      },
    ],
  }, null, 2));
  touch(geminiSessionFile, providerActivity);

  const openCodeDatabase = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  const openCodeStrategy = createOpenCodeDatabase(openCodeDatabase, { project, now: providerActivity });

  return {
    root,
    home,
    project,
    now,
    openCodeStrategy,
    claude: {
      historyFile: claudeHistoryFile,
      sessionFile: claudeSessionFile,
      model: claudeModel,
    },
    expected: {
      claudeSessionId: CLAUDE_SESSION_ID,
      codexSessionId: `codex-${CODEX_FILE_ID}`,
      geminiSessionId: `gemini-${GEMINI_FILE_ID}`,
      openCodeSessionId: `opencode-${OPENCODE_SESSION_ID}`,
    },
  };
}

function appendClaudeReplay(fixtures, phase) {
  const now = Date.now();
  const message = phase === 1
    ? 'Claude replay delta received'
    : 'Claude replay snapshot floor received';
  const tool = phase === 1 ? 'Edit' : 'Write';
  const fileName = phase === 1 ? 'delta.txt' : 'snapshot.txt';

  fs.appendFileSync(fixtures.claude.historyFile, `${JSON.stringify({
    sessionId: CLAUDE_SESSION_ID,
    agentId: null,
    agentType: 'main',
    model: fixtures.claude.model,
    project: fixtures.project,
    timestamp: now,
    display: message,
  })}\n`);
  fs.appendFileSync(fixtures.claude.sessionFile, `${JSON.stringify({
    type: 'assistant',
    sessionId: CLAUDE_SESSION_ID,
    timestamp: new Date(now).toISOString(),
    message: {
      role: 'assistant',
      model: fixtures.claude.model,
      content: [
        {
          type: 'tool_use',
          id: `claude-tool-r1-18-${phase}`,
          name: tool,
          input: { file_path: path.join(fixtures.project, fileName) },
        },
        { type: 'text', text: message },
      ],
      usage: { input_tokens: 130 + phase, output_tokens: 30 + phase },
    },
  })}\n`);
  touch(fixtures.claude.historyFile, now);
  touch(fixtures.claude.sessionFile, now);
  return { message, tool, at: now };
}

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      headers: { Host: `127.0.0.1:${port}` },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          reject(new Error(`Invalid JSON from ${requestPath}: ${error.message}`));
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`${requestPath} returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
  });
}

function frameForClient(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index++) masked[index] = body[index] ^ mask[index % 4];

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

class ReplayWebSocket {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeBuffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.messages = [];
    this.waiters = [];
    this.closedError = null;
  }

  async connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const handshake = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      this.socket = socket;
      const fail = error => {
        if (!this.closedError) this.closedError = error;
        reject(error);
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      };
      socket.setNoDelay(true);
      socket.on('error', fail);
      socket.on('close', () => {
        if (!this.closedError) this.closedError = new Error('WebSocket closed');
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(this.closedError);
        }
      });
      socket.on('data', chunk => {
        if (!this.handshakeComplete) {
          this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
          const boundary = this.handshakeBuffer.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          const headerText = this.handshakeBuffer.subarray(0, boundary).toString('utf8');
          if (!/^HTTP\/1\.1 101 Switching Protocols\r\n/i.test(headerText)) {
            fail(new Error(`WebSocket upgrade failed: ${headerText}`));
            return;
          }
          this.handshakeComplete = true;
          this.buffer = this.handshakeBuffer.subarray(boundary + 4);
          this.handshakeBuffer = Buffer.alloc(0);
          this.consumeFrames();
          resolve();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.consumeFrames();
      });
      socket.on('connect', () => {
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

    await handshake;
    this.sendJson({ type: 'hello', deltas: true });
    return this;
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
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large');
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
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(payloadOffset + length);

      if (opcode === 0x1) {
        this.receiveMessage(JSON.parse(payload.toString('utf8')));
      } else if (opcode === 0x9) {
        this.socket.write(frameForClient(payload, 0xA));
      } else if (opcode === 0x8) {
        this.closedError = new Error('WebSocket closed by server');
        return;
      } else if (![0xA].includes(opcode)) {
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
          reject(new Error(`Timed out waiting for a matching WebSocket message after ${timeout}ms`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(frameForClient(Buffer.from([0x03, 0xE8]), 0x8));
    } catch {
      // The isolated server shutdown below also closes all client sockets.
    }
    this.socket.end();
  }
}

function startIsolatedServer(fixtures) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_BOOTSTRAP, SERVER_MODULE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fixtures.home,
        USERPROFILE: fixtures.home,
        CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1',
        CLAUDEVILLE_OPENCODE_CONFIG_DIR: path.join(fixtures.home, '.config', 'opencode'),
        CLAUDEVILLE_OPENCODE_STATE_DIR: path.join(fixtures.home, '.local', 'share', 'opencode'),
        CLAUDEVILLE_OPENCODE_DB: path.join(fixtures.home, '.local', 'share', 'opencode', 'opencode.db'),
        CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY: fixtures.openCodeStrategy,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutRemainder = '';
    let settled = false;
    let startupTimer = null;

    const failStartup = error => {
      if (settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      try {
        child.stdin.write('shutdown\n');
        child.stdin.end();
      } catch {
        // The child may already have exited after reporting its startup error.
      }
      reject(error);
    };

    const onLine = line => {
      if (line.startsWith('R1_18_SERVER_ERROR ')) {
        failStartup(new Error(`Isolated server could not listen: ${line.slice('R1_18_SERVER_ERROR '.length)}`));
        return;
      }
      const match = line.match(/^R1_18_READY (\d+)$/);
      if (!match || settled) return;
      settled = true;
      if (startupTimer) clearTimeout(startupTimer);
      resolve({ child, port: Number(match[1]), stdout, stderr });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = `${stdoutRemainder}${chunk}`.split('\n');
      stdoutRemainder = lines.pop() || '';
      for (const line of lines) onLine(line.replace(/\r$/, ''));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      failStartup(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      failStartup(new Error(
        `Isolated server exited before listening (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    });
    startupTimer = setTimeout(() => {
      failStartup(new Error(
        `Timed out waiting for isolated server readiness\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    }, FRAME_TIMEOUT_MS);
  });
}

async function stopIsolatedServer(processHandle) {
  if (!processHandle?.child || processHandle.child.exitCode !== null) return;
  const child = processHandle.child;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.write('shutdown\n');
  child.stdin.end();
  const result = await Promise.race([
    exited.then(() => 'exited'),
    sleep(8_000).then(() => 'timeout'),
  ]);
  if (result === 'timeout') {
    throw new Error('Isolated server did not complete its graceful shutdown');
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pointerParts(pointer) {
  if (pointer === '') return [];
  assert.ok(pointer.startsWith('/'), `Invalid JSON-Patch pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function applyJsonPatch(document, patch) {
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

function sessionForProvider(sessions, provider) {
  const session = sessions.find(item => item.provider === provider);
  assert.ok(session, `Expected a ${provider} session in browser payload`);
  return session;
}

function assertProviderPayload(sessions, fixtures) {
  const providers = new Set(sessions.map(session => session.provider));
  assert.deepEqual(
    providers,
    new Set(['claude', 'codex', 'gemini', 'opencode']),
    'The replay should expose exactly the four synthetic providers',
  );

  const claude = sessionForProvider(sessions, 'claude');
  assert.equal(claude.sessionId, fixtures.expected.claudeSessionId);
  assert.equal(claude.model, fixtures.claude.model);
  assert.equal(claude.lastTool, 'Read');
  assert.equal(claude.lastMessage, 'Claude replay ready');

  const codex = sessionForProvider(sessions, 'codex');
  assert.equal(codex.sessionId, fixtures.expected.codexSessionId);
  assert.equal(codex.agentName, 'Codex Replay');
  assert.equal(codex.model, 'gpt-5');
  assert.equal(codex.lastTool, 'shell');
  assert.equal(codex.reasoningEffort, 'medium');

  const gemini = sessionForProvider(sessions, 'gemini');
  assert.equal(gemini.sessionId, fixtures.expected.geminiSessionId);
  assert.equal(gemini.model, 'gemini-2.5-flash');
  assert.equal(gemini.lastTool, 'run_shell_command');
  assert.equal(gemini.project, fixtures.project);

  const openCode = sessionForProvider(sessions, 'opencode');
  assert.equal(openCode.sessionId, fixtures.expected.openCodeSessionId);
  assert.equal(openCode.agentName, 'build');
  assert.equal(openCode.model, 'deepseek/deepseek-v4-pro');
  assert.equal(openCode.lastTool, 'Bash');
  assert.equal(openCode.lastMessage, 'OpenCode replay ready');
}

export async function runReplay({ assertPeriodicSnapshot = true } = {}) {
  const root = makeTempDir('claudeville-r1-18-');
  let fixtures = null;
  let serverProcess = null;
  let websocket = null;
  let replayError = null;

  try {
    fixtures = createFixtures(root);
    serverProcess = await startIsolatedServer(fixtures);

    const providerPayload = await requestJson(serverProcess.port, '/api/providers');
    const providerIds = new Set(providerPayload.providers.map(provider => provider.provider));
    assert.deepEqual(providerIds, new Set(['claude', 'codex', 'gemini', 'opencode']));

    websocket = await new ReplayWebSocket(serverProcess.port).connect();
    const initial = await websocket.waitForMessage(message => message.type === 'init');
    assert.ok(Number.isInteger(initial.seq) && initial.seq > 0);
    assert.equal(Array.isArray(initial.sessions), true);
    assert.equal(Array.isArray(initial.teams), true);
    assert.ok(initial.usage && typeof initial.usage === 'object');
    assertProviderPayload(initial.sessions, fixtures);

    const initialApi = await requestJson(serverProcess.port, '/api/sessions?force=1');
    assert.deepEqual(
      new Set(initialApi.sessions.map(session => session.sessionId)),
      new Set(initial.sessions.map(session => session.sessionId)),
      'The HTTP and WebSocket views should expose the same sessions',
    );

    // The first dirty-driven tick is intentionally a full snapshot because
    // lastDeltaSnapshotAt starts at zero. Consume it before creating a delta.
    const warmup = await websocket.waitForMessage(
      message => message.type === 'update' && Array.isArray(message.sessions) && !('patch' in message),
      FRAME_TIMEOUT_MS,
    );
    const warmupObservedAt = Date.now();
    assert.ok(warmup.seq > initial.seq);
    assert.equal('baseSeq' in warmup, false);
    assert.deepEqual({ ...coreState(warmup), sessions: null }, { ...coreState(initial), sessions: null });
    assert.deepEqual(warmup.sessions.map(stableSessionObservation), initial.sessions.map(stableSessionObservation));

    const phaseOne = appendClaudeReplay(fixtures, 1);
    const delta = await websocket.waitForMessage(message => message.type === 'update-delta', FRAME_TIMEOUT_MS);
    const deltaObservedAt = Date.now();
    assert.equal(delta.baseSeq, warmup.seq);
    assert.equal(delta.seq, warmup.seq + 1);
    assert.ok(Array.isArray(delta.patch) && delta.patch.length > 0);

    const reconstructed = applyJsonPatch(coreState(warmup), delta.patch);
    const reconstructedClaude = sessionForProvider(reconstructed.sessions, 'claude');
    assert.equal(reconstructedClaude.lastMessage, phaseOne.message);
    assert.equal(reconstructedClaude.lastTool, phaseOne.tool);
    const deltaApi = await requestJson(serverProcess.port, '/api/sessions?force=1');
    assert.deepEqual(reconstructed.sessions.map(stableSessionObservation), deltaApi.sessions.map(stableSessionObservation));

    let floor = null;
    let phaseTwo = null;
    let floorObservedAt = null;
    if (assertPeriodicSnapshot) {
      // The scheduler is dirty-driven: a quiet interval emits nothing. Wait
      // until the real 20-second floor is due, then make one more append so
      // the next two-second tick must choose a full snapshot.
      const floorDueAt = warmupObservedAt + DELTA_SNAPSHOT_INTERVAL_MS + FLOOR_SLACK_MS;
      await sleep(Math.max(0, floorDueAt - Date.now()));
      phaseTwo = appendClaudeReplay(fixtures, 2);
      floor = await websocket.waitForMessage(
        message => message.type === 'update'
          && message.seq > delta.seq
          && !('patch' in message),
        FRAME_TIMEOUT_MS,
      );
      floorObservedAt = Date.now();
      assert.ok(
        floorObservedAt - warmupObservedAt >= DELTA_SNAPSHOT_INTERVAL_MS,
        `full snapshot arrived before the floor interval (${floorObservedAt - warmupObservedAt}ms)`,
      );
      assert.equal('baseSeq' in floor, false);
      assert.equal('patch' in floor, false);
      assert.ok(floor.seq > delta.seq);
      const floorClaude = sessionForProvider(floor.sessions, 'claude');
      assert.equal(floorClaude.lastMessage, phaseTwo.message);
      assert.equal(floorClaude.lastTool, phaseTwo.tool);
      const floorApi = await requestJson(serverProcess.port, '/api/sessions?force=1');
      assert.deepEqual(floor.sessions.map(stableSessionObservation), floorApi.sessions.map(stableSessionObservation));
    }

    return {
      providers: [...providerIds].sort(),
      initialSeq: initial.seq,
      warmupSeq: warmup.seq,
      deltaSeq: delta.seq,
      deltaOps: delta.patch.length,
      deltaObservedAt,
      floorSeq: floor?.seq || null,
      floorDelayMs: floorObservedAt === null ? null : floorObservedAt - warmupObservedAt,
      schedulerPollMs: BROADCAST_POLL_INTERVAL_MS,
    };
  } catch (error) {
    replayError = error;
    throw error;
  } finally {
    websocket?.close();
    let shutdownError = null;
    try {
      if (serverProcess) await stopIsolatedServer(serverProcess);
    } catch (error) {
      shutdownError = error;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'Replay fixtures must be removed after the run');
    }
    if (!replayError && shutdownError) throw shutdownError;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReplay()
    .then(summary => {
      console.log(`R1-18 replay passed: ${summary.providers.join(', ')}; delta ops=${summary.deltaOps}; floor delay=${summary.floorDelayMs}ms`);
    })
    .catch(error => {
      console.error(`R1-18 replay failed: ${error?.stack || error?.message || error}`);
      process.exitCode = 1;
    });
}
