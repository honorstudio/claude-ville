// Provider-reported command outcomes (plan 4.4).
//
// The distinction this file defends is the one the village keeps getting wrong:
// a tool being invoked is not a tool having finished, and a tool disappearing
// from a transcript tail is not a tool having succeeded. Only an explicit
// provider result record earns a `lastResults` entry, that entry keeps one
// identity across polls, and providers that report no outcome report nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { makeTempDir } from './support/tmp.mjs';

import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { AgentEventStream } from '../../claudeville/src/presentation/character-mode/AgentEventStream.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures');

const { normalizeSession } = require('../../claudeville/adapters/index.js');
const { normalizeToolResults, TOOL_RESULT_LIMIT } = require('../../claudeville/adapters/toolResults.js');
const { _test: openCodeTest } = require('../../claudeville/adapters/opencode.js');

const NOW = Date.now();
const REPLACEMENTS = new Map([
    ['__FIVE_MINUTES_AGO__', new Date(NOW - 5 * 60_000).toISOString()],
    ['__FOUR_MINUTES_AGO__', new Date(NOW - 4 * 60_000).toISOString()],
    ['__THREE_MINUTES_AGO__', new Date(NOW - 3 * 60_000).toISOString()],
    ['__NOW__', new Date(NOW).toISOString()],
    ['__FIVE_MINUTES_AGO_MS__', String(NOW - 5 * 60_000)],
    ['__FOUR_MINUTES_AGO_MS__', String(NOW - 4 * 60_000)],
    ['__THREE_MINUTES_AGO_MS__', String(NOW - 3 * 60_000)],
    ['__COMMAND_STARTED_MS__', String(NOW - 1500)],
    ['__NOW_MS__', String(NOW)],
]);

function materialize(fixture, project, target) {
    let content = fs.readFileSync(path.join(FIXTURE_ROOT, fixture), 'utf8');
    for (const [placeholder, value] of REPLACEMENTS) content = content.replaceAll(placeholder, value);
    content = content.replaceAll('__PROJECT__', project);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.utimesSync(target, NOW / 1000, NOW / 1000);
    return content;
}

// Codex and Kimi Code resolve their homes at require time, so the adapters run
// in a child process against a synthetic HOME. Each provider is polled twice to
// prove result ids survive re-reading the same transcript.
function readProviderProjections(root) {
    const script = `
        const { CodexAdapter } = require('./claudeville/adapters/codex');
        const { KimiAdapter } = require('./claudeville/adapters/kimi');
        const { ClaudeAdapter } = require('./claudeville/adapters/claude');
        const window = 60 * 60 * 1000;
        const codex = new CodexAdapter();
        const kimi = new KimiAdapter();
        const claude = new ClaudeAdapter();
        const poll = () => ({
            codex: codex.getActiveSessions(window, { force: true }),
            kimi: kimi.getActiveSessions(window),
            claude: claude.getActiveSessions(window),
        });
        const first = poll();
        kimi.invalidateCaches && kimi.invalidateCaches();
        const second = poll();
        process.stdout.write(JSON.stringify({ first, second }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: root, USERPROFILE: root },
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(output);
}

function buildProviderHome(t) {
    const root = makeTempDir('claudeville-tool-results-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'work', 'results');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });

    materialize(
        path.join('codex', 'tool-results.jsonl'),
        project,
        path.join(root, '.codex', 'sessions', '2026', '09', '06', 'rollout-tool-results.jsonl'),
    );
    materialize(
        path.join('kimi', 'tool-results.jsonl'),
        project,
        path.join(root, '.kimi-code', 'sessions', 'wd_results', 'session_results', 'agents', 'main', 'wire.jsonl'),
    );
    // Claude is the control: a rich transcript with tool results and no
    // provider-reported command outcome contract.
    const claudeProjectDir = path.join(root, '.claude', 'projects', project.replaceAll('/', '-'));
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(
        path.join(root, '.claude', 'history.jsonl'),
        `${JSON.stringify({ sessionId: 'results-claude', project, timestamp: NOW, model: 'claude-sonnet-4-5', display: 'Results control' })}\n`,
    );
    fs.copyFileSync(
        path.join(FIXTURE_ROOT, 'claude', 'all-records.jsonl'),
        path.join(claudeProjectDir, 'results-claude.jsonl'),
    );

    return { root, project };
}

function openCodeSession(project) {
    const raw = fs.readFileSync(path.join(FIXTURE_ROOT, 'opencode', 'tool-results.jsonl'), 'utf8');
    let content = raw;
    for (const [placeholder, value] of REPLACEMENTS) content = content.replaceAll(placeholder, value);
    content = content.replaceAll('__PROJECT__', project);
    const parts = content.trim().split('\n').map(line => JSON.parse(line));
    return openCodeTest.buildOpenCodeSession({
        id: 'results',
        directory: project,
        title: 'Results fixture',
        agent: 'build',
        model: 'anthropic/claude-sonnet-4-5',
        time_updated: NOW,
        latestActivity: NOW,
    }, parts, NOW);
}

test('Codex, Kimi Code and OpenCode publish bounded command outcomes; Claude publishes none', (t) => {
    const { root, project } = buildProviderHome(t);
    const { first, second } = readProviderProjections(root);

    const codex = normalizeSession(first.codex.find(session => session.sessionId === 'codex-tool-results'));
    assert.deepEqual(codex.lastResults.map(result => [result.tool, result.exitCode, result.durationMs]), [
        ['Bash', 1, 1500],
        ['Bash', null, 60_000],
        ['Bash', 0, 2250],
    ]);
    assert.equal(codex.lastResults[0].completedAt, NOW);
    assert.equal(codex.lastResults[0].source, 'transcript');
    assert.equal(codex.lastResults[0].detail, 'npm test');
    // The pending `npm run lint` call has no completion record of its own.
    assert.ok(!codex.lastResults.some(result => result.detail.includes('lint')));

    const kimi = normalizeSession(first.kimi.find(session => session.sessionId === 'kimi-session_results'));
    assert.deepEqual(kimi.lastResults.map(result => [result.tool, result.exitCode, result.durationMs]), [
        ['Bash', 1, 1500],
        ['Bash', 0, 60_000],
    ]);
    // A `tool.result` that carries output but no outcome says nothing about
    // success, so the read produces no result record at all.
    assert.ok(!kimi.lastResults.some(result => result.tool === 'Read'));

    const opencode = normalizeSession(openCodeSession(project));
    assert.deepEqual(opencode.lastResults.map(result => [result.tool, result.exitCode, result.durationMs]), [
        ['Bash', 1, 1500],
        ['Bash', 0, 60_000],
    ]);
    assert.ok(!opencode.lastResults.some(result => result.tool === 'Read'));

    const claude = normalizeSession(first.claude.find(session => session.sessionId === 'results-claude'));
    assert.ok(claude.lastTool, 'the Claude control fixture really does record tool activity');
    assert.deepEqual(claude.lastResults, []);

    // Same transcripts, second poll: ids are call identity, not receipt time.
    const codexAgain = normalizeSession(second.codex.find(session => session.sessionId === 'codex-tool-results'));
    const kimiAgain = normalizeSession(second.kimi.find(session => session.sessionId === 'kimi-session_results'));
    assert.deepEqual(codexAgain.lastResults.map(result => result.id), codex.lastResults.map(result => result.id));
    assert.deepEqual(kimiAgain.lastResults.map(result => result.id), kimi.lastResults.map(result => result.id));
    assert.deepEqual(
        normalizeSession(openCodeSession(project)).lastResults.map(result => result.id),
        opencode.lastResults.map(result => result.id),
    );
    assert.equal(new Set([...codex.lastResults, ...kimi.lastResults, ...opencode.lastResults]
        .map(result => result.id)).size, 7);
});

test('the summary keeps the five newest outcomes and drops unattributable ones', () => {
    const results = Array.from({ length: 9 }, (_, index) => ({
        id: `codex-alpha:call-${index}`,
        tool: 'Bash',
        detail: `npm run step-${index}`,
        exitCode: index % 2,
        durationMs: 10,
        completedAt: NOW - index * 1000,
        source: 'transcript',
    }));
    const normalized = normalizeToolResults([...results].reverse());
    assert.equal(normalized.length, TOOL_RESULT_LIMIT);
    assert.deepEqual(normalized.map(result => result.id), results.slice(0, 5).map(result => result.id));

    const duplicated = normalizeToolResults([results[0], { ...results[0], exitCode: 137 }]);
    assert.deepEqual(duplicated, [results[0]]);

    assert.deepEqual(normalizeToolResults([
        { ...results[0], id: '' },
        { ...results[0], id: 'no-tool', tool: '' },
        { ...results[0], id: 'no-source', source: 'guess' },
        { ...results[0], id: 'no-time', completedAt: null },
    ]), []);

    assert.deepEqual(normalizeToolResults([{ ...results[0], exitCode: null, durationMs: null }]), [{
        ...results[0],
        exitCode: null,
        durationMs: null,
    }]);
    assert.deepEqual(normalizeToolResults(null), []);
});

test('tool:result fires once per newly observed outcome, and never for an invocation', (t) => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const stream = new AgentEventStream(world);
    t.after(() => stream.dispose());

    const events = [];
    const unsubscribe = eventBus.on('tool:result', payload => events.push(payload));
    t.after(unsubscribe);

    const at = Date.now();
    const result = (suffix, tool, detail, exitCode, completedAt) => ({
        id: `codex:codex-alpha:${suffix}`,
        tool,
        detail,
        exitCode,
        durationMs: 1500,
        completedAt,
        source: 'transcript',
    });
    const build = result('call-build', 'Bash', 'npm run build', 0, at);
    const edit = result('call-edit', 'Edit', 'src/index.js', 1, at + 10);
    const push = (lastTool, lastResults) => manager.handleWebSocketMessage({
        sessions: [{
            sessionId: 'codex-alpha',
            provider: 'codex',
            project: '/work/results',
            status: 'active',
            turnState: 'working',
            lastActivity: Date.now(),
            lastTool,
            lastToolInput: 'src/index.js',
            lastResults,
        }],
    });

    push('Bash', [build]);
    assert.deepEqual(events, [{
        agentId: 'codex-alpha',
        id: build.id,
        tool: 'Bash',
        exitCode: 0,
        durationMs: 1500,
        completedAt: at,
        building: 'taskboard',
    }]);

    // A different tool is a new invocation, not a new outcome.
    push('Edit', [build]);
    assert.equal(events.length, 1);

    push('Edit', [edit, build]);
    assert.equal(events.length, 2);
    assert.equal(events[1].id, edit.id);
    assert.equal(events[1].exitCode, 1);
    assert.equal(events[1].building, 'forge');

    // The bounded summary forgetting an outcome is not an outcome.
    push('Edit', [edit]);
    // The world keeps the same bounded projection the wire carried.
    assert.deepEqual(world.agents.get('codex-alpha').lastResults, [edit]);
    push('Edit', []);
    assert.equal(events.length, 2);
});

test('outcomes older than the stream are recorded, never stamped', (t) => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const stream = new AgentEventStream(world);
    t.after(() => stream.dispose());

    const events = [];
    const unsubscribe = eventBus.on('tool:result', payload => events.push(payload));
    t.after(unsubscribe);

    const historical = {
        id: 'codex:codex-beta:call-old',
        tool: 'Bash',
        detail: 'npm test',
        exitCode: 0,
        durationMs: 900,
        completedAt: Date.now() - 10 * 60_000,
        source: 'transcript',
    };
    manager.handleWebSocketMessage({
        sessions: [{
            sessionId: 'codex-beta',
            provider: 'codex',
            project: '/work/results',
            status: 'active',
            turnState: 'working',
            lastActivity: Date.now(),
            lastTool: 'Bash',
            lastResults: [historical],
        }],
    });

    assert.deepEqual(events, []);
    assert.deepEqual(world.agents.get('codex-beta').lastResults, [historical]);
});
