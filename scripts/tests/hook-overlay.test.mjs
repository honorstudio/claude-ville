import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HOOK_WAIT_RETENTION_MS,
  HOOK_EXPIRY_MS,
  HOOK_MERGE_WINDOW_MS,
  HookOverlay,
  MAX_HOOK_SESSIONS,
  mergeOverlay,
  promptDetailFrom,
} = require('../../claudeville/adapters/hooks.js');
const { normalizeSession } = require('../../claudeville/adapters/index.js');

function fixture() {
  let now = 1_800_000_000_000;
  return {
    overlay: new HookOverlay({ now: () => now }),
    now: () => now,
    advance: ms => { now += ms; },
  };
}

test('permission hooks expose exact approval state and sanitized bounded detail', () => {
  const clock = fixture();
  const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF1234567890';
  clock.overlay.ingest({
    provider: 'codex',
    sessionId: 'thread-1',
    cwd: '/workspace',
    kind: 'PermissionRequest',
    tool: 'Bash',
    input: { command: `npm test token=small ${secret} ${'x'.repeat(240)}` },
  });

  const value = clock.overlay.overlayFor('thread-1');
  assert.equal(value.turnState, 'tool_pending');
  assert.equal(value.pendingTool, 'Bash');
  assert.equal(value.waitReason, 'approval');
  assert.equal(value.signalSource, 'hook');
  assert.ok(value.promptDetail.length <= 200);
  assert.match(value.promptDetail, /token=\[REDACTED\]/);
  assert.doesNotMatch(value.promptDetail, new RegExp(secret));
});

test('prompt extraction displays commands or paths but never file contents', () => {
  assert.equal(promptDetailFrom({ file_path: '/tmp/example.js', content: 'private source' }), '/tmp/example.js');
  assert.equal(promptDetailFrom({ content: 'private source' }), null);
});

test('a scoped Claude notification retains preceding tool detail', () => {
  const clock = fixture();
  clock.overlay.ingest({
    provider: 'claude',
    sessionId: 'claude-1',
    kind: 'PreToolUse',
    tool: 'Edit',
    input: { file_path: '/workspace/app.js' },
  });
  clock.advance(20);
  clock.overlay.ingest({
    provider: 'claude',
    sessionId: 'claude-1',
    kind: 'Notification',
  });

  const value = clock.overlay.overlayFor('claude-1');
  assert.equal(value.waitReason, 'approval');
  assert.equal(value.pendingTool, 'Edit');
  assert.equal(value.promptDetail, '/workspace/app.js');
});

test('Gemini BeforeTool starts a pending tool and AfterTool clears it', () => {
  const clock = fixture();
  clock.overlay.ingest({
    provider: 'gemini',
    sessionId: 'gemini-1',
    cwd: '/workspace',
    kind: 'BeforeTool',
    tool: 'run_shell_command',
    input: { command: 'npm test' },
  });

  const pending = clock.overlay.overlayFor('gemini-1');
  assert.equal(pending.turnState, 'tool_pending');
  assert.equal(pending.pendingTool, 'run_shell_command');
  assert.equal(pending.promptDetail, 'npm test');

  clock.overlay.ingest({
    provider: 'gemini',
    sessionId: 'gemini-1',
    cwd: '/workspace',
    kind: 'AfterTool',
    tool: 'run_shell_command',
    input: { command: 'npm test' },
  });

  const cleared = clock.overlay.overlayFor('gemini-1');
  assert.equal(cleared.turnState, 'working');
  assert.equal(cleared.pendingTool, null);
  assert.equal(cleared.promptDetail, null);
});

test('an out-of-order asynchronous hook cannot suppress a newer approval', () => {
  const clock = fixture();
  const older = clock.now() - 100;
  clock.overlay.ingest({
    provider: 'codex',
    sessionId: 'codex-race',
    ts: clock.now(),
    kind: 'PermissionRequest',
    tool: 'Bash',
    input: { command: 'npm test' },
  });
  clock.advance(10);
  clock.overlay.ingest({
    provider: 'codex',
    sessionId: 'codex-race',
    ts: older,
    kind: 'PreToolUse',
    tool: 'Bash',
  });
  assert.equal(clock.overlay.overlayFor('codex-race').waitReason, 'approval');
});

test('fresh overlays escalate old state but never suppress a newer transcript resolution', () => {
  const clock = fixture();
  clock.overlay.ingest({
    provider: 'claude',
    sessionId: 'session-1',
    kind: 'PermissionRequest',
    tool: 'Bash',
    input: { command: 'npm test' },
  });
  const hook = clock.overlay.overlayFor('session-1');
  const working = {
    provider: 'claude',
    sessionId: 'session-1',
    turnState: 'working',
    signalSource: 'transcript',
    lastActivity: clock.now() - 1000,
  };
  const escalated = mergeOverlay(working, hook, clock.now());
  assert.equal(escalated.waitReason, 'approval');
  assert.equal(escalated.signalSource, 'hook');
  assert.equal(escalated.promptDetail, 'npm test');

  const awaiting = {
    ...working,
    turnState: 'awaiting_input',
    awaitingSince: clock.now() + 500,
  };
  assert.strictEqual(mergeOverlay(awaiting, hook, clock.now()), awaiting);
});

test('unanswered approval remains last observed waiting until bounded expiry', () => {
  const clock = fixture();
  clock.overlay.ingest({
    provider: 'codex',
    sessionId: 'session-2',
    kind: 'PermissionRequest',
    tool: 'Bash',
  });
  const transcript = {
    provider: 'codex',
    sessionId: 'session-2',
    turnState: 'working',
    signalSource: 'transcript',
  };
  const hook = clock.overlay.overlayFor('session-2');
  clock.advance(HOOK_MERGE_WINDOW_MS);
  assert.equal(mergeOverlay(transcript, hook, clock.now()).signalStale, true);
  clock.advance(HOOK_WAIT_RETENTION_MS - HOOK_MERGE_WINDOW_MS);
  assert.equal(clock.overlay.overlayFor('session-2'), null);
});

test('overlay evicts oldest sessions at its cap', () => {
  const clock = fixture();
  for (let index = 0; index <= MAX_HOOK_SESSIONS; index++) {
    clock.overlay.ingest({
      provider: 'claude',
      sessionId: `session-${index}`,
      kind: 'SessionStart',
    });
    clock.advance(1);
  }
  assert.equal(clock.overlay.size, MAX_HOOK_SESSIONS);
  assert.equal(clock.overlay.overlayFor('session-0'), null);
  assert.ok(clock.overlay.overlayFor(`session-${MAX_HOOK_SESSIONS}`));
});

test('unknown providers are rejected without retaining an entry', () => {
  const clock = fixture();
  assert.throws(
    () => clock.overlay.ingest({ provider: 'unknown', sessionId: 'x', kind: 'SessionStart' }),
    error => error?.code === 'UNKNOWN_PROVIDER',
  );
  assert.equal(clock.overlay.size, 0);
});

test('sessions without hooks add transcript provenance but no prompt payload', () => {
  const normalized = normalizeSession({
    provider: 'claude',
    sessionId: 'transcript-only',
    turnState: 'working',
    promptDetail: 'must not pass through',
  });
  assert.equal(normalized.signalSource, 'transcript');
  assert.equal(JSON.parse(JSON.stringify(normalized)).promptDetail, undefined);
});
