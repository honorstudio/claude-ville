// Turn-state derivation and pending-tool classification.
//
// This is the layer everything downstream trusts: get it wrong and the village
// tells the user a confident lie about what their agents are doing. It is also
// pure, so it is cheap to pin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const {
    TurnState,
    WaitReason,
    classifyPendingTool,
    deriveTurnState,
    toEpochMs,
} = require('../../claudeville/adapters/turnState.js');

const NOW = 1_700_000_000_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_FIXTURES = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'codex');

function materializeCodexFixtures(root, now) {
    const project = path.join(root, 'work', 'codex-fixture');
    const rolloutDir = path.join(root, '.codex', 'sessions', '2026', '09', '01');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(rolloutDir, { recursive: true });

    const replacements = new Map([
        ['__PROJECT__', project],
        ['__FIVE_MINUTES_AGO__', new Date(now - 5 * 60_000).toISOString()],
        ['__FOUR_MINUTES_AGO__', new Date(now - 4 * 60_000).toISOString()],
        ['__THREE_MINUTES_AGO__', new Date(now - 3 * 60_000).toISOString()],
        ['__NOW__', new Date(now).toISOString()],
        ['__FOUR_MINUTES_AGO_MS__', String(now - 4 * 60_000)],
        ['__THREE_MINUTES_AGO_MS__', String(now - 3 * 60_000)],
        ['__COMMAND_STARTED_MS__', String(now - 1500)],
        ['__NOW_MS__', String(now)],
    ]);

    for (const fixtureName of fs.readdirSync(CODEX_FIXTURES)) {
        let content = fs.readFileSync(path.join(CODEX_FIXTURES, fixtureName), 'utf8');
        for (const [placeholder, value] of replacements) {
            content = content.replaceAll(placeholder, value);
        }
        const target = path.join(rolloutDir, `rollout-${fixtureName}`);
        fs.writeFileSync(target, content);
        fs.utimesSync(target, now / 1000, now / 1000);
    }

    return project;
}

function readCodexFixtureProjection(root) {
    const script = `
        const fs = require('fs');
        const path = require('path');
        const { CodexAdapter } = require('./claudeville/adapters/codex');
        const longRollout = path.join(
            process.env.HOME,
            '.codex', 'sessions', '2026', '09', '01', 'rollout-long-running-turn.jsonl',
        );
        const fullLongRollout = fs.readFileSync(longRollout, 'utf8');
        fs.writeFileSync(longRollout, fullLongRollout.split('\\n').slice(0, 3).join('\\n') + '\\n');
        fs.utimesSync(longRollout, Date.now() / 1000, Date.now() / 1000);
        const adapter = new CodexAdapter();
        adapter.getActiveSessions(60 * 60 * 1000, { force: true });
        fs.writeFileSync(longRollout, fullLongRollout);
        fs.utimesSync(longRollout, Date.now() / 1000, Date.now() / 1000);
        adapter.invalidateCachesForDirty({ path: longRollout, kind: 'transcript' });
        const sessions = adapter.getActiveSessions(60 * 60 * 1000, { force: true });
        const details = Object.fromEntries(sessions.map((session) => [
            session.sessionId,
            adapter.getSessionDetail(session.sessionId, session.project),
        ]));
        const astraRollout = path.join(path.dirname(longRollout), 'rollout-astra.jsonl');
        const metadata = (model, effort) => JSON.stringify({ type: 'turn_context', payload: {
            collaboration_mode: { settings: { model, reasoning_effort: effort } },
        } }) + '\\n';
        const padding = (JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', padding: 'x'.repeat(2048) } }) + '\\n').repeat(60);
        const currentModel = () => {
            const session = adapter.getActiveSessions(60 * 60 * 1000, { force: true }).find(s => s.sessionId === 'codex-astra');
            return [session.model, session.reasoningEffort];
        };
        const transitions = [currentModel()];
        fs.appendFileSync(astraRollout, metadata('gpt-6-astra', 'ultra') + padding);
        transitions.push(currentModel());
        fs.appendFileSync(astraRollout, padding);
        transitions.push(currentModel());
        fs.writeFileSync(astraRollout, metadata('gpt-5.6-luna', 'low'));
        transitions.push(currentModel());
        require('node:assert/strict').deepEqual(transitions, [
            ['gpt-6-astra', 'max'], ['gpt-6-astra', 'ultra'],
            ['gpt-6-astra', 'ultra'], ['gpt-5.6-luna', 'low'],
        ]);
        process.stdout.write(JSON.stringify({ sessions, details }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: root, USERPROFILE: root },
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(output);
}

test('a closed turn hands control back to the user', () => {
    const state = deriveTurnState({ turnEnded: true, turnEndedAt: NOW - 5000 }, NOW);
    assert.equal(state.turnState, TurnState.AWAITING_INPUT);
    assert.equal(state.awaitingSince, NOW - 5000);
    assert.equal(state.pendingTool, null);
});

test('no pending tool and no closed turn means the model is working', () => {
    const state = deriveTurnState({ turnEnded: false }, NOW);
    assert.equal(state.turnState, TurnState.WORKING);
    assert.equal(state.awaitingSince, null);
});

test('an unknown transcript stays unknown rather than guessing', () => {
    const state = deriveTurnState({ known: false, turnEnded: true }, NOW);
    assert.equal(state.turnState, TurnState.UNKNOWN);
    assert.equal(state.awaitingSince, null);
});

test('a pending tool outranks a previously closed turn', () => {
    const state = deriveTurnState(
        { turnEnded: true, turnEndedAt: NOW - 60_000, pendingTool: 'Bash', pendingSince: NOW - 1000 },
        NOW,
    );
    assert.equal(state.turnState, TurnState.TOOL_PENDING);
    assert.equal(state.pendingTool, 'Bash');
});

test('ask tools are blocked the instant they are pending', () => {
    const result = classifyPendingTool({ tool: 'AskUserQuestion', pendingForMs: 0 });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, WaitReason.QUESTION);
});

test('plan tools read as a review request, not an approval', () => {
    const result = classifyPendingTool({ tool: 'ExitPlanMode', pendingForMs: 0 });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, WaitReason.PLAN_REVIEW);
});

test('elapsed time is not evidence of a permission prompt', () => {
    const before = classifyPendingTool({ tool: 'Edit', pendingForMs: 15_000 - 1 });
    const after = classifyPendingTool({ tool: 'Edit', pendingForMs: 15_000 + 1 });
    assert.equal(before.blocked, false);
    assert.equal(after.blocked, false);
    assert.equal(after.reason, null);
});

test('a long-running Bash is not mistaken for a permission prompt', () => {
    // The false-alarm case that matters: builds and test suites run for
    // minutes, and calling that "waiting for you" would train the user to
    // ignore the badge.
    const running = classifyPendingTool({ tool: 'Bash', pendingForMs: 3 * 60_000 });
    assert.equal(running.blocked, false);
    const stuck = classifyPendingTool({ tool: 'Bash', pendingForMs: 240_000 + 1 });
    assert.equal(stuck.blocked, false);
});

test('bypassPermissions means a pending tool is always executing', () => {
    const result = classifyPendingTool({
        tool: 'Edit',
        permissionMode: 'bypassPermissions',
        pendingForMs: 10 * 60_000,
    });
    assert.equal(result.blocked, false);
});

test('acceptEdits silences edit prompts but not Bash', () => {
    const edit = classifyPendingTool({
        tool: 'Write', permissionMode: 'acceptEdits', pendingForMs: 60_000,
    });
    assert.equal(edit.blocked, false);
    const bash = classifyPendingTool({
        tool: 'Bash', permissionMode: 'acceptEdits', pendingForMs: 240_000 + 1,
    });
    assert.equal(bash.blocked, false);
});

test('bypassPermissions never suppresses an explicit question', () => {
    const result = classifyPendingTool({
        tool: 'AskUserQuestion', permissionMode: 'bypassPermissions', pendingForMs: 0,
    });
    assert.equal(result.blocked, true);
});

test('derived state carries the wait reason only when blocked', () => {
    const running = deriveTurnState(
        { pendingTool: 'Bash', pendingSince: NOW - 1000 }, NOW,
    );
    assert.equal(running.waitReason, null);
    assert.equal(running.awaitingSince, null);

    const blocked = deriveTurnState(
        { pendingTool: 'AskUserQuestion', pendingSince: NOW - 60_000 }, NOW,
    );
    assert.equal(blocked.waitReason, WaitReason.QUESTION);
    assert.equal(blocked.awaitingSince, NOW - 60_000);
});

test('timestamps parse from ISO strings and numbers alike', () => {
    assert.equal(toEpochMs('2026-07-25T07:39:20.959Z'), Date.parse('2026-07-25T07:39:20.959Z'));
    assert.equal(toEpochMs(NOW), NOW);
    assert.equal(toEpochMs(null), null);
    assert.equal(toEpochMs('not a date'), null);
});

test('Codex transcript fixtures preserve turn truth and project item_completed fields', (t) => {
    const root = makeTempDir('claudeville-codex-turn-state-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = Date.now();
    const project = materializeCodexFixtures(root, now);
    const { sessions, details } = readCodexFixtureProjection(root);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));

    const astra = byId.get('codex-astra');
    assert.ok(astra);
    assert.equal(astra.model, 'gpt-6-astra');
    assert.equal(astra.reasoningEffort, 'max');

    const aborted = byId.get('codex-abort-after-pending');
    assert.ok(aborted);
    assert.equal(aborted.turnState, TurnState.AWAITING_INPUT);
    assert.equal(aborted.pendingTool, null);
    assert.equal(aborted.waitReason, null);
    assert.equal(aborted.signalSource, 'transcript');
    assert.ok(Number.isFinite(aborted.turnStartedAt));

    const longRunning = byId.get('codex-long-running-turn');
    assert.ok(longRunning);
    assert.equal(longRunning.turnState, TurnState.WORKING);
    assert.notEqual(longRunning.turnState, TurnState.UNKNOWN);
    assert.equal(longRunning.pendingTool, null);
    assert.equal(longRunning.turnStartedAt, now - 5 * 60_000);
    assert.equal(longRunning.signalSource, 'transcript');

    const fullAuto = byId.get('codex-full-auto-pending');
    assert.ok(fullAuto);
    assert.equal(fullAuto.permissionMode, 'bypassPermissions');
    assert.equal(fullAuto.turnState, TurnState.TOOL_PENDING);
    assert.equal(fullAuto.pendingTool, 'Bash');
    assert.equal(fullAuto.waitReason, null);
    assert.equal(fullAuto.awaitingSince, null);

    const completed = byId.get('codex-item-completed');
    assert.ok(completed);
    assert.equal(completed.permissionMode, 'bypassPermissions');
    assert.deepEqual(completed.workingSet, [
        { path: path.join('src', 'newer.js'), op: 'write', at: now - 3 * 60_000, source: 'transcript' },
        { path: path.join('src', 'older.js'), op: 'write', at: now - 3 * 60_000, source: 'transcript' },
    ]);
    assert.ok(completed.workingSet.length <= 16);
    assert.ok(completed.workingSet.every((entry) => !entry.path.startsWith(project)));

    const failedCommand = details['codex-item-completed'].toolHistory.find(
        (item) => item.toolExitCode === 1,
    );
    assert.ok(failedCommand);
    assert.equal(failedCommand.tool, 'Bash');
    assert.equal(failedCommand.durationMs, 1500);
});
