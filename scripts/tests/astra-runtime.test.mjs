import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import { TokenUsage } from '../../claudeville/src/domain/value-objects/TokenUsage.js';
import { WebSocketClient } from '../../claudeville/src/infrastructure/WebSocketClient.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import AgentSimulator from '../../claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const { estimateCost } = require('../../claudeville/adapters/sessionPresentation.js');

test('unknown usage survives server, browser and Agent cost contracts', () => {
  for (const estimate of [estimateCost, TokenUsage.estimateCost.bind(TokenUsage)]) {
    assert.equal(estimate(null, 'grok-4.5', 'grok').usd, null);
    assert.equal(estimate({ availability: 'unavailable', input: 0, output: 0, contextWindow: 4000 }, 'grok-4.5', 'grok').usd, null);
    assert.equal(estimate({ input: 0, output: 0 }, 'gpt-5', 'codex').usd, 0);
    assert.equal(estimate({ input: 10 }, 'gpt-5', 'codex').availability, 'partial');
  }
  const agent = new Agent({ id: 'unknown', provider: 'grok', cost: { usd: null, availability: 'unavailable' } });
  assert.equal(agent.cost.usd, null);
});

test('provider observations survive failure, recover and expire; Grok activity uses transcript mtime', () => {
  const home = makeTempDir('astra-observations-');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const registry = require('./claudeville/adapters');
    const adapters = registry.adapters;
    for (const a of adapters) a.isAvailable = () => false;
    const [claude, codex] = adapters;
    claude.isAvailable = codex.isAvailable = () => true;
    let now = Date.now(); const originalNow = Date.now; Date.now = () => now;
    claude.getActiveSessions = () => [{ sessionId: 'kept', lastActivity: now }];
    codex.getActiveSessions = () => [{ sessionId: 'other', lastActivity: now }];
    const scan = () => registry.getAllSessions(600000, { force: true });
    assert.equal(scan().length, 2);
    claude.getActiveSessions = () => { throw new Error('read failed'); };
    now += 5000;
    let kept = scan().find(s => s.sessionId === 'kept');
    assert.equal(kept.freshness.state, 'stale'); assert.equal(kept.freshness.ageMs, 5000);
    now += 60000; assert.deepEqual(scan().map(s => s.sessionId), ['other']);
    claude.getActiveSessions = () => [{ sessionId: 'kept', lastActivity: now }];
    assert.equal(scan().find(s => s.sessionId === 'kept').freshness.state, 'fresh');
    claude.getActiveSessions = () => []; assert.equal(scan().length, 1);
    claude.getSessionDetail = () => ({ messages: ['last good detail'] });
    const detail = registry.getSessionDetailByProvider('claude', 'kept', '', { force: true });
    assert.equal(detail.freshness.state, 'fresh');
    claude.getSessionDetail = () => { throw new Error('detail failed'); };
    now += 1000;
    assert.equal(registry.getSessionDetailByProvider('claude', 'kept', '', { force: true }).freshness.state, 'stale');
    now += 60000;
    assert.equal(registry.getSessionDetailByProvider('claude', 'kept', '', { force: true }).freshness.state, 'unavailable');
    Date.now = originalNow;
    const { GrokAdapter } = require('./claudeville/adapters/grok');
    const dir = path.join(process.env.HOME, '.grok/sessions/project/live');
    fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 3600000) / 1000;
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: 'live', cwd: '/fixture' } }));
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), JSON.stringify({ params: { update: { sessionUpdate: 'tool_call', toolCallId: 'build', title: 'run_terminal_command' } } }) + '\\n');
    fs.utimesSync(path.join(dir, 'summary.json'), old, old); fs.utimesSync(dir, old, old);
    fs.utimesSync(path.join(dir, 'updates.jsonl'), old, old);
    fs.appendFileSync(path.join(dir, 'updates.jsonl'), JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Building' } } } }) + '\\n');
    const grok = new GrokAdapter();
    let sessions = grok.getActiveSessions(60000);
    assert.equal(sessions.length, 1); assert.equal(sessions[0].turnState, 'tool_pending');
    assert.equal(sessions[0].waitReason, null); assert.equal(sessions[0].tokenUsage.availability, 'unavailable');
    const { getTailCacheDiagnostics } = require('./claudeville/adapters/shared');
    const parses = getTailCacheDiagnostics().parsed.parsedLines;
    assert.equal(grok.getActiveSessions(60000).length, 1);
    assert.equal(getTailCacheDiagnostics().parsed.parsedLines, parses);
    fs.appendFileSync(path.join(dir, 'updates.jsonl'), JSON.stringify({ params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'completed' } } }) + '\\n');
    assert.equal(grok.getActiveSessions(60000)[0].turnState, 'working');
    fs.utimesSync(path.join(dir, 'updates.jsonl'), old, old);
    assert.equal(grok.getActiveSessions(60000).length, 0);
    const chatDir = path.join(path.dirname(dir), 'chat-only');
    fs.mkdirSync(chatDir); fs.writeFileSync(path.join(chatDir, 'summary.json'), JSON.stringify({ info: { id: 'chat-only' } }));
    fs.writeFileSync(path.join(chatDir, 'chat_history.jsonl'), JSON.stringify({ type: 'assistant', tool_calls: [{ id: 'chat-build', name: 'run_terminal_command' }] }) + '\\n');
    assert.equal(grok.getActiveSessions(60000).find(s => s.sessionId === 'grok-chat-only').turnState, 'tool_pending');
    fs.appendFileSync(path.join(chatDir, 'chat_history.jsonl'), JSON.stringify({ type: 'tool_result', tool_call_id: 'chat-build' }) + '\\n');
    assert.equal(grok.getActiveSessions(60000).find(s => s.sessionId === 'grok-chat-only').turnState, 'working');
    const { ClaudeAdapter } = require('./claudeville/adapters/claude');
    const claudeDir = path.join(process.env.HOME, '.claude/projects/-fixture');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME, '.claude/history.jsonl'), JSON.stringify({ sessionId: 'limited', project: '/fixture', timestamp: Date.now() }) + '\\n');
    fs.writeFileSync(path.join(claudeDir, 'limited.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [], stop_reason: 'rate_limited' } }) + '\\n');
    assert.equal(new ClaudeAdapter().getActiveSessions(60000).find(s => s.sessionId === 'limited').rateLimit.enforced, true);
    const { GeminiAdapter } = require('./claudeville/adapters/gemini');
    const gemini = new GeminiAdapter();
    const file = path.join(process.env.HOME, '.gemini/tmp/project/chats/session-live.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = value => { fs.writeFileSync(file, JSON.stringify(value)); return gemini.getActiveSessions(60000)[0]; };
    assert.equal(record({ messages: [{ type: 'future-format' }] }).turnState, 'unknown');
    assert.equal(record({ messages: [{ type: 'gemini', toolCalls: [{ name: 'run_shell_command', id: 'build' }] }] }).turnState, 'tool_pending');
    assert.equal(record({ messages: [{ type: 'gemini', toolCalls: [{ name: 'run_shell_command', id: 'build', result: {} }] }] }).signalCertainty, 'inferred');
    assert.equal(record({ messages: [{ type: 'gemini', finishReason: 'STOP' }] }).turnState, 'awaiting_input');
    const adapter = adapters.find(a => a.provider === 'gemini'); adapter.isAvailable = () => true;
    assert.ok(scan().some(s => s.provider === 'gemini'));
    const readFile = fs.readFileSync;
    registry.invalidateSessionCaches({ provider: 'gemini', dirty: { kind: 'transcript', path: file } });
    fs.readFileSync = function (target, ...args) { if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return readFile.call(this, target, ...args); };
    const failed = scan().find(s => s.provider === 'gemini');
    assert.equal(failed.freshness.state, 'stale');
    assert.equal(registry.getProviderHealth().find(p => p.id === 'gemini').health, 'degraded');
    fs.readFileSync = readFile;
    registry.invalidateSessionCaches({ provider: 'gemini', dirty: { kind: 'transcript', path: file } });
    assert.equal(scan().find(s => s.provider === 'gemini').freshness.state, 'fresh');
  `;
  execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, HOME: home, CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1' }, stdio: 'pipe' });
});

test('raw Codex/Gemini hook IDs update their actual HTTP and WebSocket sessions', { timeout: 15000 }, async () => {
  const home = makeTempDir('astra-hook-identity-');
  const write = (relative, value) => {
    const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  };
  const rawId = 'same-source-id';
  write('.codex/sessions/2026/09/05/rollout-2026-09-05T10-00-00-same-source-id.jsonl', JSON.stringify({ type: 'session_meta', payload: { id: rawId, cwd: '/fixture', model: 'gpt-5' } }) + '\n');
  write('.gemini/tmp/project/chats/session-2026-09-05T10-00-00-same-source-id.json', JSON.stringify({ sessionId: rawId, messages: [{ type: 'user', content: 'hello' }] }));
  const bootstrap = `const http = require('http'); const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) { if (args[0] === 4000) args[0] = 0; return listen.apply(this, args); };
    const runtime = require(${JSON.stringify(path.join(root, 'claudeville/server.js'))});
    process.once('SIGTERM', () => runtime.shutdownRuntime({ reason: 'test' }));
    const server = runtime.startServer(); server.once('listening', () => process.send(server.address()));`;
  const child = spawn(process.execPath, ['-e', bootstrap], { cwd: home, env: { ...process.env, HOME: home, CLAUDEVILLE_DISABLE_GIT_ENRICHMENT: '1', CLAUDEVILLE_INGEST_TOKEN: 'fixture-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let socket;
  const previousWindow = globalThis.window;
  try {
    const { port } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    const base = `http://localhost:${port}`;
    const sessions = async () => { const body = await (await fetch(`${base}/api/sessions`)).json(); return body.sessions || body; };
    const initial = await sessions();
    const codex = initial.find(s => s.provider === 'codex'); const gemini = initial.find(s => s.provider === 'gemini');
    assert.ok(codex); assert.ok(gemini); assert.notEqual(codex.sessionId, rawId);
    globalThis.window = { location: { protocol: 'http:', host: `localhost:${port}` } };
    const client = new WebSocketClient();
    let pending = Buffer.alloc(0); let upgraded = false;
    socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) { const end = pending.indexOf('\r\n\r\n'); if (end < 0) return; pending = pending.subarray(end + 4); upgraded = true; }
      while (pending.length >= 2) {
        let length = pending[1] & 127; let start = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); start = 4; }
        if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); start = 10; }
        if (pending.length < start + length) return;
        if ((pending[0] & 15) === 1) client._handleMessage(JSON.parse(pending.subarray(start, start + length).toString()));
        pending = pending.subarray(start + length);
      }
    });
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: YXN0cmEtaWRlbnRpdHktMQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const hook = async (provider, kind) => {
      const response = await fetch(`${base}/api/ingest/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudeville-ingest-token': 'fixture-token' }, body: JSON.stringify({ provider, sessionId: rawId, kind, tool: 'Bash' }) });
      assert.equal(response.status, 202);
    };
    await hook('codex', 'PermissionRequest');
    let live = await sessions();
    assert.equal(live.find(s => s.sessionId === codex.sessionId).waitReason, 'approval');
    assert.equal(live.find(s => s.sessionId === gemini.sessionId).waitReason, null);
    await hook('gemini', 'PermissionRequest');
    live = await sessions(); assert.equal(live.find(s => s.sessionId === gemini.sessionId).waitReason, 'approval');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && ![codex, gemini].every(session => client._state?.sessions.find(s => s.sessionId === session.sessionId)?.waitReason === 'approval')) await new Promise(resolve => setTimeout(resolve, 25));
    for (const session of [codex, gemini]) assert.equal(client._state.sessions.find(s => s.sessionId === session.sessionId).waitReason, 'approval', 'WebSocket updates the intended public session');
    await hook('codex', 'PostToolUse');
    live = await sessions(); assert.equal(live.find(s => s.sessionId === codex.sessionId).waitReason, null);
    assert.equal(live.find(s => s.sessionId === gemini.sessionId).waitReason, 'approval');
  } finally {
    globalThis.window = previousWindow;
    socket?.destroy(); child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  }
});

test('World and simulator message updates preserve status and publish the updated agent', () => {
  const world = new World();
  const agent = new Agent({ id: 'message-update', provider: 'codex', lastMessage: 'Before' });
  world.addAgent(agent);
  const observed = [];
  const off = eventBus.on('agent:updated', value => observed.push({ agent: value, status: value.status, message: value.lastMessage }));
  try {
    const update = { status: 'waiting_on_user', lastMessage: 'Approve the command?' };
    world.updateAgent(agent.id, update);
    assert.deepEqual(update, { status: 'waiting_on_user', lastMessage: 'Approve the command?' });
    const simulator = new AgentSimulator({ world, scenarioId: 'mixed-tools' });
    simulator._applyToolStep({ agentId: agent.id, status: 'working', tool: 'Bash', lastMessage: 'Command approved.' });
    assert.deepEqual(observed, [
      { agent, status: 'waiting_on_user', message: 'Approve the command?' },
      { agent, status: 'working', message: 'Command approved.' },
    ]);
    world.updateAgent(agent.id, { lastMessage: null });
    assert.equal(agent.lastMessage, null);
    assert.equal(agent.status, 'working');
  } finally { off(); }
});
