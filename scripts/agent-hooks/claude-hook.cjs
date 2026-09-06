#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODES = new Set(['session', 'guard', 'check-js', 'ingest']);

function parseArgs(argv = process.argv.slice(2)) {
  const mode = argv[0] || '';
  return { mode: MODES.has(mode) ? mode : '' };
}

function readInput() {
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function shellParts(command) {
  const parts = [];
  let tokens = [];
  let token = '';
  let quote = '';
  let escaped = false;

  function finishToken() {
    if (token) tokens.push(token);
    token = '';
  }

  function finishPart(operator) {
    finishToken();
    if (tokens.length) parts.push({ tokens, operator });
    tokens = [];
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      finishPart(pair);
      index += 1;
      continue;
    }
    if (character === ';' || character === '|') {
      finishPart(character);
      continue;
    }
    token += character;
  }
  finishPart(null);
  return parts;
}

function commandTokens(tokens) {
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index] === 'sudo') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        index += 1;
        if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
          '-C', '--chdir', '-T', '--command-timeout', '-R', '--chroot'].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    if (tokens[index] === 'env') {
      index += 1;
      while (index < tokens.length) {
        const value = tokens[index];
        if (value === '--') {
          index += 1;
          break;
        }
        if (value === '-u' || value === '--unset') {
          index += 2;
          continue;
        }
        if (value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function executableName(value = '') {
  return path.posix.basename(value.replaceAll('\\', '/'));
}

function gitCommand(tokens) {
  if (executableName(tokens[0]) !== 'git') return null;
  let index = 1;
  const optionsWithValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (optionsWithValues.has(option)) index += 1;
  }
  if (index >= tokens.length) return null;
  return { name: tokens[index], args: tokens.slice(index + 1) };
}

function hasShortOption(args, letter) {
  return args.some((argument) => /^-[^-]/.test(argument) && argument.slice(1).includes(letter));
}

function denyReason(command) {
  const parts = shellParts(command);
  const normalized = parts.map((part) => ({ ...part, command: commandTokens(part.tokens) }));

  for (const part of normalized) {
    const tokens = part.command;
    const executable = executableName(tokens[0]);
    const git = gitCommand(tokens);
    if (git?.name === 'reset' && git.args.some((arg) => ['--hard', '--merge', '--keep'].includes(arg))) {
      return 'git reset can discard work';
    }
    if (git?.name === 'checkout' && git.args.includes('--')) {
      return 'git checkout can overwrite paths';
    }
    if (git?.name === 'restore' && (!git.args.includes('--staged') || git.args.includes('--worktree'))) {
      return 'git restore can discard work';
    }
    if (git?.name === 'clean') {
      const dryRun = git.args.includes('--dry-run') || hasShortOption(git.args, 'n');
      const destructive = git.args.includes('--force') || git.args.includes('--directory') ||
        git.args.includes('--ignored') || git.args.includes('--ignored-only') ||
        ['f', 'd', 'x', 'X'].some((letter) => hasShortOption(git.args, letter));
      if (destructive && !dryRun) return 'git clean can delete untracked files';
    }
    if (git?.name === 'stash' && ['drop', 'clear'].includes(git.args[0])) {
      return 'git stash deletion is destructive';
    }
    if (executable === 'rm') {
      const recursive = tokens.includes('--recursive') || hasShortOption(tokens.slice(1), 'r') || hasShortOption(tokens.slice(1), 'R');
      const force = tokens.includes('--force') || hasShortOption(tokens.slice(1), 'f');
      if (recursive && force) return 'recursive forced removal is destructive';
    }
    if (['kill', 'pkill', 'killall'].includes(executable)) return `${executable} can terminate operator processes`;
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (normalized[index].operator !== '|') continue;
    const source = normalized[index].command;
    const target = normalized[index + 1].command;
    const sourceExecutable = executableName(source[0]);
    const hasPort = source.some((token) => /^:\d+$/.test(token));
    const lsofFlags = source.filter((token) => /^-[^-]/.test(token)).join('');
    const isProcessLookup = (sourceExecutable === 'lsof' && hasPort && lsofFlags.includes('t') && lsofFlags.includes('i')) ||
      sourceExecutable === 'fuser';
    const feedsKill = target.some((token) => ['kill', 'pkill', 'killall'].includes(executableName(token)));
    if (isProcessLookup && feedsKill) return 'a process lookup pipeline can terminate operator processes';
  }
  return null;
}

function runGuard(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return 0;
  const reason = denyReason(command);
  if (!reason) return 0;
  process.stderr.write(`claudeville-hook: blocked ${reason}; AGENTS.md Git Hygiene forbids this — ask the operator.\n`);
  return 2;
}

function runCheckJs(input) {
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !/\.(?:js|cjs|mjs)$/.test(filePath)) return 0;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd,
    encoding: 'utf8',
    timeout: 150,
    windowsHide: true
  });
  if (result.status !== 0 || result.error) {
    const message = result.stderr || result.error?.message || `node --check failed for ${filePath}`;
    process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  }
  return 0;
}

function runSession(input) {
  if (!input) return 0;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version || version;
  } catch {}
  const status = spawnSync('git', ['status', '--short'], {
    cwd,
    encoding: 'utf8',
    timeout: 150,
    windowsHide: true
  });
  const statusText = status.status === 0 && status.stdout.trim() ? status.stdout.trimEnd() : '(clean or unavailable)';
  process.stdout.write(`ClaudeVille v${version}\n${statusText}\nmaintained server: http://localhost:4000 (do not start/stop)\n`);
  return 0;
}

function redactIngestValue(value) {
  const clean = String(value || '')
    .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  if (clean.length <= 200) return clean;
  return `${clean.slice(0, 199).trimEnd()}…`;
}

function mapClaudeHookEvent(input, now = Date.now()) {
  const kinds = {
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    Stop: 'Stop'
  };
  const kind = kinds[input?.hook_event_name];
  const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
  if (!kind || !sessionId) return null;

  let safeInput = null;
  if (input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)) {
    for (const key of ['command', 'file_path', 'pattern', 'description']) {
      if (typeof input.tool_input[key] !== 'string') continue;
      const value = redactIngestValue(input.tool_input[key]);
      if (value) safeInput = { [key]: value };
      break;
    }
  }

  return {
    provider: 'claude',
    sessionId,
    kind,
    tool: typeof input.tool_name === 'string' ? redactIngestValue(input.tool_name)?.slice(0, 128) || null : null,
    input: safeInput,
    cwd: typeof input.cwd === 'string' ? input.cwd.slice(0, 4096) : '',
    ts: now
  };
}

function postIngestEvent(event, { request = http.request, token = process.env.CLAUDEVILLE_INGEST_TOKEN } = {}) {
  const body = JSON.stringify(event);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  if (token) headers['X-ClaudeVille-Ingest-Token'] = token;
  try {
    const req = request({
      hostname: '127.0.0.1',
      port: 4000,
      path: '/api/ingest/hook',
      method: 'POST',
      headers,
      timeout: 150
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end(body);
  } catch {}
}

function runIngest({ env = process.env, read = readInput, request = http.request, now = Date.now } = {}) {
  if (env.CLAUDEVILLE_DOGFOOD_HOOKS !== '1') return 0;
  const event = mapClaudeHookEvent(read(), now());
  if (event) postIngestEvent(event, { request, token: env.CLAUDEVILLE_INGEST_TOKEN });
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const { mode } = parseArgs(argv);
  if (!mode) return 0;
  if (mode === 'ingest') return runIngest();
  const input = readInput();
  if (mode === 'guard') return runGuard(input);
  if (mode === 'check-js') return runCheckJs(input);
  return runSession(input);
}

module.exports = {
  parseArgs,
  shellParts,
  commandTokens,
  denyReason,
  mapClaudeHookEvent,
  runIngest,
  main
};

if (require.main === module) process.exitCode = main();
