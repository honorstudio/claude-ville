import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDir } from '../tests/support/tmp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tmpHome = makeTempDir('claudeville-server-security-');
let child = null;
let childOutput = '';

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

function request(port, {
  method = 'GET',
  pathname = '/api/providers',
  host = `localhost:${port}`,
  origin,
  body = null,
  headers: extraHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, ...extraHeaders };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(port);
      if (response.statusCode === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not become ready');
}

function websocketUpgrade(port, {
  pathname = '/ws',
  host = `localhost:${port}`,
  origin = `http://localhost:${port}`,
  version = '13',
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket upgrade timed out'));
    }, 2000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = error => finish(error);
    socket.once('error', onError);
    socket.on('data', function onData(chunk) {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf('\r\n\r\n');
      if (boundary === -1) return;
      socket.off('data', onData);
      const header = received.subarray(0, boundary).toString('latin1');
      const statusCode = Number(header.match(/^HTTP\/1\.1\s+(\d+)/)?.[1] || 0);
      finish(null, {
        socket,
        statusCode,
        remainder: received.subarray(boundary + 4),
      });
    });
    socket.once('connect', () => {
      const headers = [
        `GET ${pathname} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: ${version}`,
      ];
      if (origin !== null) headers.push(`Origin: ${origin}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
  });
}

function waitForCloseCode(socket, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let received = initial;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket close frame timed out'));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const consume = () => {
      let offset = 0;
      while (received.length - offset >= 2) {
        const first = received[offset];
        let length = received[offset + 1] & 0x7f;
        let headerBytes = 2;
        if (length === 126) {
          if (received.length - offset < 4) return;
          length = received.readUInt16BE(offset + 2);
          headerBytes = 4;
        } else if (length === 127) {
          if (received.length - offset < 10) return;
          length = Number(received.readBigUInt64BE(offset + 2));
          headerBytes = 10;
        }
        if (received.length - offset < headerBytes + length) return;
        const payload = received.subarray(offset + headerBytes, offset + headerBytes + length);
        if ((first & 0x0f) === 0x8) {
          cleanup();
          resolve(payload.length >= 2 ? payload.readUInt16BE(0) : null);
          return;
        }
        offset += headerBytes + length;
      }
      received = received.subarray(offset);
    };
    const onData = chunk => {
      received = Buffer.concat([received, chunk]);
      consume();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    consume();
  });
}

function waitForExit(processHandle, timeoutMs = 5000) {
  if (processHandle.exitCode !== null) return Promise.resolve(processHandle.exitCode);
  return Promise.race([
    new Promise(resolve => processHandle.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('server did not exit after SIGTERM')),
      timeoutMs,
    )),
  ]);
}

const port = await reserveEphemeralPort();

try {
  const bootstrap = `
    const http = require('http');
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 4000) args[0] = Number(process.env.CLAUDEVILLE_SMOKE_PORT);
      return originalListen.apply(this, args);
    };
    const runtime = require(${JSON.stringify(path.join(repoRoot, 'claudeville', 'server.js'))});
    process.once('SIGTERM', () => runtime.shutdownRuntime({ reason: 'SIGTERM' }));
    const instance = runtime.startServer();
    instance.once('listening', () => process.send?.(instance.address()));
  `;
  child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: tmpHome,
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1',
      CLAUDEVILLE_INGEST_TOKEN: 'security-smoke-token',
      CLAUDEVILLE_SMOKE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const listeningAddress = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server address was not reported')), 2000);
    child.once('message', address => {
      clearTimeout(timer);
      resolve(address);
    });
  });
  const collectOutput = chunk => {
    childOutput = `${childOutput}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on('data', collectOutput);
  child.stderr.on('data', collectOutput);

  await waitForServer(port);
  assert.equal((await listeningAddress).address, '127.0.0.1');

  const accepted = await request(port, { origin: `http://localhost:${port}` });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers['access-control-allow-origin'], undefined);

  const noOrigin = await request(port);
  assert.equal(noOrigin.statusCode, 200, 'origin-less CLI requests must remain supported');

  for (const pathname of [
    '/api/providers',
    '/api/sessions',
    '/api/session-detail?provider=claude&sessionId=secret&project=%2Ftmp',
    '/api/tasks',
    '/api/usage',
  ]) {
    const hostileOrigin = await request(port, {
      pathname,
      origin: 'https://attacker.example',
    });
    assert.equal(hostileOrigin.statusCode, 403, `${pathname} accepted a hostile origin`);
    assert.doesNotMatch(hostileOrigin.body, /providers|sessions|homeDir|subscription|quota/);
    assert.equal(hostileOrigin.headers['access-control-allow-origin'], undefined);
  }

  const hostileHost = await request(port, { host: 'attacker.example' });
  assert.equal(hostileHost.statusCode, 421);

  const preflight = await request(port, {
    method: 'OPTIONS',
    origin: `http://localhost:${port}`,
  });
  assert.equal(preflight.statusCode, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);

  const invalidJson = await request(port, {
    method: 'POST',
    pathname: '/api/session-details',
    body: '{',
  });
  assert.equal(invalidJson.statusCode, 400);

  const oversizedJson = await request(port, {
    method: 'POST',
    pathname: '/api/session-details',
    body: JSON.stringify({ value: 'x'.repeat(256 * 1024) }),
  });
  assert.equal(oversizedJson.statusCode, 413);

  const hookBody = JSON.stringify({
    provider: 'codex',
    sessionId: 'security-smoke',
    cwd: tmpHome,
    ts: Date.now(),
    kind: 'PermissionRequest',
    tool: 'Bash',
    input: { command: 'npm test' },
  });
  const ingestHeaders = { 'X-ClaudeVille-Ingest-Token': 'security-smoke-token' };

  const missingHookToken = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: hookBody,
  });
  assert.equal(missingHookToken.statusCode, 401);

  const acceptedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: hookBody,
    headers: ingestHeaders,
  });
  assert.equal(acceptedHook.statusCode, 202);

  const hookWrongMethod = await request(port, {
    method: 'GET',
    pathname: '/api/ingest/hook',
  });
  assert.equal(hookWrongMethod.statusCode, 405);

  const hookHostileHost = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    host: 'attacker.example',
    body: hookBody,
  });
  assert.equal(hookHostileHost.statusCode, 421);

  const hookHostileOrigin = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    origin: 'https://attacker.example',
    body: hookBody,
  });
  assert.equal(hookHostileOrigin.statusCode, 403);

  const malformedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: '{',
    headers: ingestHeaders,
  });
  assert.equal(malformedHook.statusCode, 400);
  assert.doesNotMatch(malformedHook.body, /\bat\s+\S+|stack|SyntaxError/i);

  const oversizedHook = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: JSON.stringify({ value: 'x'.repeat(256 * 1024) }),
    headers: ingestHeaders,
  });
  assert.equal(oversizedHook.statusCode, 413);
  assert.doesNotMatch(oversizedHook.body, /\bat\s+\S+|stack|SyntaxError/i);

  const unknownHookProvider = await request(port, {
    method: 'POST',
    pathname: '/api/ingest/hook',
    body: JSON.stringify({ provider: 'unknown', sessionId: 'x', kind: 'SessionStart' }),
    headers: ingestHeaders,
  });
  assert.equal(unknownHookProvider.statusCode, 400);

  const hostileSocket = await websocketUpgrade(port, { origin: 'https://attacker.example' });
  assert.equal(hostileSocket.statusCode, 403);
  hostileSocket.socket.destroy();

  const missingOriginSocket = await websocketUpgrade(port, { origin: null });
  assert.equal(missingOriginSocket.statusCode, 403);
  missingOriginSocket.socket.destroy();

  const wrongPathSocket = await websocketUpgrade(port, { pathname: '/' });
  assert.equal(wrongPathSocket.statusCode, 404);
  wrongPathSocket.socket.destroy();

  const wrongVersionSocket = await websocketUpgrade(port, { version: '12' });
  assert.equal(wrongVersionSocket.statusCode, 400);
  wrongVersionSocket.socket.destroy();

  const validSocket = await websocketUpgrade(port);
  assert.equal(validSocket.statusCode, 101);
  validSocket.socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.equal(
    await waitForCloseCode(validSocket.socket, validSocket.remainder),
    1002,
    'unmasked client frames must close with protocol error',
  );
  validSocket.socket.destroy();

  console.log('server security smoke passed');
} catch (error) {
  if (childOutput) process.stderr.write(`${childOutput}\n`);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await waitForExit(child).catch(() => {});
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
