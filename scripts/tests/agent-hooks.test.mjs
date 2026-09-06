import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeTempDir } from './support/tmp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookPath = path.join(repoRoot, 'scripts/agent-hooks/claude-hook.cjs');
const require = createRequire(import.meta.url);
const { mapClaudeHookEvent, runIngest } = require(hookPath);

function run(mode, input, options = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [hookPath, mode], {
    cwd: repoRoot,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 1000,
    ...options
  });
  return { ...result, elapsed: performance.now() - started };
}

function bash(command) {
  return { hook_event_name: 'PreToolUse', cwd: repoRoot, tool_name: 'Bash', tool_input: { command } };
}

const deniedCommands = [
  ['git reset --hard HEAD~1', 'git reset'],
  ['git reset --merge ORIG_HEAD', 'git reset'],
  ['sudo env CI=1 git -C "a directory" reset --keep HEAD', 'git reset'],
  ['git checkout -- "path with spaces.js"', 'git checkout'],
  ['git checkout main -- src/app.js', 'git checkout'],
  ['git restore src/app.js', 'git restore'],
  ['git restore --staged --worktree src/app.js', 'git restore'],
  ['git clean -f', 'git clean'],
  ['git clean -d', 'git clean'],
  ['git clean -x', 'git clean'],
  ['git clean -X', 'git clean'],
  ['git stash drop', 'git stash'],
  ['git stash clear', 'git stash'],
  ['rm -rf node_modules/.cache', 'recursive forced removal'],
  ['rm -R --force "directory with spaces"', 'recursive forced removal'],
  ['kill 123', 'kill'],
  ['env SIGNAL=TERM pkill node', 'pkill'],
  ['sudo killall node', 'killall'],
  ['lsof -ti :4000 | xargs kill', 'process lookup pipeline'],
  ['fuser 4000/tcp | xargs -r kill', 'process lookup pipeline']
];

test('guard denies every destructive command class with the required message', async (t) => {
  for (const [command, reason] of deniedCommands) {
    await t.test(command, () => {
      const result = run('guard', bash(command));
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^claudeville-hook: blocked .*${reason}.*; AGENTS\\.md Git Hygiene forbids this — ask the operator\\.\\n$`));
    });
  }
});

test('guard allows documented safe cases and produces no output', () => {
  for (const command of [
    'git restore --staged "path with spaces.js"',
    'git clean -nfd',
    'git clean --dry-run -fdx',
    'git checkout main',
    'rm -r build',
    'printf "%s\\n" "quoted value"'
  ]) {
    const result = run('guard', bash(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
    assert.equal(result.stderr, '', command);
  }
});

test('all modes fail open on malformed input', () => {
  for (const mode of ['session', 'guard', 'check-js', 'ingest']) {
    const result = run(mode, '{not json');
    assert.equal(result.status, 0, mode);
  }
});

test('check-js reports syntax failures without blocking', () => {
  const result = run('check-js', {
    cwd: repoRoot,
    tool_input: { file_path: 'scripts/tests/agent-hooks.test.mjs' }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');

  const fixtureDir = makeTempDir('claudeville-hook-');
  try {
    writeFileSync(path.join(fixtureDir, 'invalid.js'), 'const = broken;\n');
    const invalid = run('check-js', {
      cwd: fixtureDir,
      tool_input: { file_path: 'invalid.js' }
    });
    assert.equal(invalid.status, 0);
    assert.match(invalid.stderr, /SyntaxError/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('session prints repository status, package version, and maintained-server warning', () => {
  const result = run('session', { cwd: repoRoot, hook_event_name: 'SessionStart', tool_input: {} });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ClaudeVille v\d+\.\d+\.\d+/);
  assert.match(result.stdout, /maintained server: http:\/\/localhost:4000 \(do not start\/stop\)/);
});

test('ingest maps Claude lifecycle fixtures to allowlisted normalized payloads', () => {
  const base = {
    session_id: ' session-123 ',
    cwd: '/tmp/project',
    tool_name: 'Bash',
    prompt: 'never forward me',
    transcript_path: '/secret/transcript',
    tool_input: {
      command: 'deploy token=supersecretvalue --note ' + 'x'.repeat(220),
      prompt: 'never forward this either',
      file_content: 'private source'
    }
  };
  const pre = mapClaudeHookEvent({ ...base, hook_event_name: 'PreToolUse' }, 123456);
  assert.deepEqual(pre, {
    provider: 'claude',
    sessionId: 'session-123',
    kind: 'PreToolUse',
    tool: 'Bash',
    input: { command: 'deploy token=[REDACTED] --note [REDACTED]' },
    cwd: '/tmp/project',
    ts: 123456
  });
  assert.equal(JSON.stringify(pre).includes('never forward'), false);

  const pattern = mapClaudeHookEvent({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_input: { pattern: 'safe words '.repeat(30), prompt: 'not allowed' }
  }, 123456);
  assert.equal(pattern.input.pattern.length, 200);
  assert.equal(pattern.input.pattern.endsWith('…'), true);

  const post = mapClaudeHookEvent({
    ...base,
    hook_event_name: 'PostToolUse',
    tool_input: { file_path: '/tmp/example.js', content: 'not allowed' }
  }, 123457);
  assert.equal(post.kind, 'PostToolUse');
  assert.deepEqual(post.input, { file_path: '/tmp/example.js' });

  const stop = mapClaudeHookEvent({
    session_id: 'session-123',
    hook_event_name: 'Stop',
    cwd: '/tmp/project',
    stop_hook_active: true
  }, 123458);
  assert.deepEqual(stop, {
    provider: 'claude',
    sessionId: 'session-123',
    kind: 'Stop',
    tool: null,
    input: null,
    cwd: '/tmp/project',
    ts: 123458
  });
  assert.equal(mapClaudeHookEvent({ ...base, hook_event_name: 'Notification' }), null);
});

test('ingest flag unset exits zero without reading input or opening a request', () => {
  let read = false;
  let requested = false;
  assert.equal(runIngest({
    env: {},
    read: () => { read = true; },
    request: () => { requested = true; }
  }), 0);
  assert.equal(read, false);
  assert.equal(requested, false);

  const result = run('ingest', '{not json', { env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// .claude/settings.json gives every hook `timeout: 1` (one second). That is the
// observable contract: a hook that exceeds it is killed and the tool call stalls.
// The 200 ms figure from the plan is a local design budget, not a CI-safe
// per-run bound (a shared runner spawning `git status` can cross it), so it is
// asserted on the median over ten runs; each run must stay under 500 ms, half
// the timeout, so a regression surfaces well before hooks start being killed.
const HOOK_TIMEOUT_MS = 1000;
const HOOK_RUN_BUDGET_MS = 500; // half the configured timeout: early warning with headroom for CI jitter
const HOOK_MEDIAN_BUDGET_MS = 200;

test('each hook mode stays under 500 ms per run (half the 1 s hook timeout) with a sub-200 ms median', () => {
  const fixtures = {
    session: { cwd: repoRoot, hook_event_name: 'SessionStart', tool_input: {} },
    guard: bash('git status --short'),
    'check-js': { cwd: repoRoot, tool_input: { file_path: 'scripts/agent-hooks/claude-hook.cjs' } },
    ingest: { cwd: repoRoot, tool_input: {} }
  };
  for (const [mode, fixture] of Object.entries(fixtures)) {
    const elapsed = [];
    for (let runNumber = 1; runNumber <= 10; runNumber += 1) {
      const result = run(mode, fixture);
      assert.equal(result.status, 0, `${mode} run ${runNumber}`);
      assert.ok(result.elapsed < HOOK_RUN_BUDGET_MS, `${mode} run ${runNumber} took ${result.elapsed.toFixed(1)} ms`);
      elapsed.push(result.elapsed);
    }
    const median = elapsed.sort((a, b) => a - b)[Math.floor(elapsed.length / 2)];
    assert.ok(median < HOOK_MEDIAN_BUDGET_MS, `${mode} median ${median.toFixed(1)} ms over ten runs`);
  }
});
