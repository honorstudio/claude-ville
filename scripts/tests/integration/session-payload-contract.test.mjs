import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startIsolatedServer } from '../../smoke/support/isolated-server.mjs';
import { assertSessionContract, stableSessionObservation } from '../support/session-contract.mjs';
import { makeTempDir } from '../support/tmp.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const CLAUDE_FIXTURE = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'claude', 'all-records.jsonl');
const SESSION_ID = 'session-payload-contract';
const REQUEST_TIMEOUT_MS = 3_000;
const FRAME_TIMEOUT_MS = 5_000;

function seedFixtureHome(home) {
  const project = path.join(home, 'workspace');
  const encodedProject = project.replaceAll('/', '-');
  const sessionDirectory = path.join(home, '.claude', 'projects', encodedProject);
  const sessionFile = path.join(sessionDirectory, `${SESSION_ID}.jsonl`);
  const now = Date.now();
  const sourceRecords = fs.readFileSync(CLAUDE_FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line, index) => ({
      ...JSON.parse(line),
      timestamp: new Date(now - 2_000 + index).toISOString(),
    }));

  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(sessionFile, `${sourceRecords.map(record => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'history.jsonl'), `${JSON.stringify({
    sessionId: SESSION_ID,
    agentId: null,
    agentType: 'main',
    model: 'claude-fable-5-1',
    project,
    timestamp: now,
    display: 'Session payload contract fixture',
  })}\n`);
}

function requestJson(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: url.host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => {
        try {
          assert.equal(response.statusCode, 200, `${pathname} returned HTTP ${response.statusCode}`);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
      response.once('error', reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`${pathname} timed out`)));
    request.once('error', reject);
  });
}

function clientFrame(value, opcode = 0x1) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  const mask = crypto.randomBytes(4);
  const header = body.length < 126 ? Buffer.alloc(2) : Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (body.length < 126 ? body.length : 126);
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index++) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function readInitFrame(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('WebSocket init timed out')), FRAME_TIMEOUT_MS);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const consume = () => {
      if (!upgraded) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const headers = buffer.subarray(0, boundary).toString('latin1');
        if (!/^HTTP\/1\.1 101 /i.test(headers)) {
          finish(new Error(`WebSocket upgrade failed: ${headers.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(boundary + 4);
        socket.write(clientFrame({ type: 'hello', deltas: true }));
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) {
          const message = JSON.parse(payload.toString('utf8'));
          if (message.type === 'init') finish(null, message);
        } else if (opcode === 0x9) {
          socket.write(clientFrame(payload, 0xa));
        }
      }
    };

    socket.once('error', finish);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        consume();
      } catch (error) {
        finish(error);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
        + `Origin: http://127.0.0.1:${port}\r\n\r\n`,
      );
    });
  });
}

function sessionsById(sessions, source) {
  assert.ok(Array.isArray(sessions), `${source}.sessions must be an array`);
  const entries = sessions.map(session => {
    assertSessionContract(session, `${source}.sessions[${session?.sessionId || '?'}]`);
    return [session.sessionId, session];
  });
  const result = new Map(entries);
  assert.equal(result.size, entries.length, `${source}.sessions must have unique sessionId values`);
  return result;
}

test('HTTP sessions and WebSocket init honor the client session contract', { timeout: 14_000 }, async () => {
  const home = makeTempDir('claudeville-session-contract-');
  let server = null;
  try {
    seedFixtureHome(home);
    server = await startIsolatedServer({ home });
    assert.notEqual(server.port, 4000);

    const websocketInit = await readInitFrame(server.port);
    const httpPayload = await requestJson(server.baseUrl, '/api/sessions?force=1');
    const wsSessions = sessionsById(websocketInit.sessions, 'WebSocket init');
    const httpSessions = sessionsById(httpPayload.sessions, 'HTTP');

    assert.ok(httpSessions.size > 0, 'fixture server must expose at least one session');
    assert.deepEqual([...wsSessions.keys()].sort(), [...httpSessions.keys()].sort(), 'HTTP and WebSocket sessionIds must agree');
    for (const [sessionId, httpSession] of httpSessions) {
      assert.deepEqual(stableSessionObservation(wsSessions.get(sessionId)), stableSessionObservation(httpSession), `HTTP and WebSocket session ${sessionId} must agree`);
    }
  } finally {
    await server?.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
