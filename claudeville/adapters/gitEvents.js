const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { execFile, execFileSync } = require('child_process');

const GIT_EVENT_TYPES = new Set(['commit', 'push', 'pull', 'fetch']);
const GH_EVENT_TYPES = new Set(['pr', 'issue', 'release']);
const GH_EVENT_COMMANDS = Object.freeze({
  pr: new Set(['create', 'merge']),
  issue: new Set(['create']),
  release: new Set(['create']),
});
const GH_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '--repo',
  '-R',
  '--hostname',
  '--config',
]);
const GIT_PULL_FETCH_FLAG_TRACKED = new Set(['--all', '--prune', '--tags']);
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
]);
const HELP_FLAGS = new Set(['--help', '-h']);
const GIT_SUBCOMMAND_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-F',
  '-m',
  '-o',
  '-S',
  '--author',
  '--cleanup',
  '--date',
  '--exec',
  '--file',
  '--fixup',
  '--gpg-sign',
  '--message',
  '--pathspec-from-file',
  '--push-option',
  '--receive-pack',
  '--repo',
  '--reuse-message',
  '--reedit-message',
  '--squash',
  '--template',
  '--trailer',
]);
const GIT_PUSH_FLAGS_WITH_VALUE = new Set([
  '-o',
  '--exec',
  '--push-option',
  '--receive-pack',
  '--repo',
]);
// Git-state probes invalidate a project's cache when refs change. Keep a slow
// fallback for missed/provider-external changes without launching a subprocess
// burst at every 30-second watcher reconciliation.
const GIT_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_REPOSITORY_PUSH_TTL_MS = 2 * 60 * 1000;
const REPOSITORY_UNPUSHED_EVENT_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.CLAUDEVILLE_REPOSITORY_UNPUSHED_EVENT_TTL_MS || (7 * 24 * 60 * 60 * 1000)) || (7 * 24 * 60 * 60 * 1000)
);
const MAX_UNPUSHED_COMMITS_PER_BRANCH = 120;
// Forge events are transcript-derived and intentionally bounded like the
// repository commit cache. The newest records win when a scan is larger.
const MAX_FORGE_EVENTS_PER_PROJECT = MAX_UNPUSHED_COMMITS_PER_BRANCH;
const GIT_TRACKING_TTL_MS = 6 * 60 * 60 * 1000;
const GIT_TRACKING_MAX_PROJECTS = 512;
const GIT_REMOTE_REF_SCAN_MAX_ENTRIES = 800;
const GIT_REMOTE_REF_SCAN_MAX_DEPTH = 8;
const GIT_WORKER_MAX_CONCURRENCY = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_CONCURRENCY',
  2,
  1,
  8,
);
const GIT_WORKER_MAX_QUEUE_DEPTH = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_QUEUE_DEPTH',
  32,
  1,
  256,
);
const GIT_WORKER_TIMEOUT_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_TIMEOUT_MS',
  750,
  50,
  10_000,
);
const GIT_WORKER_RETRY_BASE_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_RETRY_BASE_MS',
  1_000,
  100,
  60_000,
);
const GIT_WORKER_RETRY_MAX_MS = boundedIntegerEnv(
  'CLAUDEVILLE_GIT_WORKER_RETRY_MAX_MS',
  30_000,
  GIT_WORKER_RETRY_BASE_MS,
  5 * 60_000,
);
const _gitStatusCache = new Map();
const _unpushedEventsCache = new Map();
const _currentBranchCache = new Map();
const _gitStatusActiveProjects = new Map();
const _gitHeadSignatureByProject = new Map();
const _lastUnpushedByProjectBranch = new Map();
const _recentRepositoryPushEvents = new Map();
const _gitTrackingLastSeen = new Map();
const _perf = {
  disabled: false,
  enrichmentCalls: 0,
  enrichmentTimeMs: 0,
  projectsScanned: 0,
  gitCommandCount: 0,
  gitCommandTimeMs: 0,
  gitCommandErrors: 0,
  gitCommandTimeouts: 0,
  cacheHits: 0,
  headInvalidations: 0,
  remoteRefScans: 0,
  remoteRefEntries: 0,
  remoteRefScanHighWater: 0,
  remoteRefScanTruncations: 0,
  lastRun: null,
  recentRuns: [],
};

const _gitWorker = {
  enabled: false,
  stopping: false,
  queue: [],
  activeJobs: 0,
  activeChildren: new Set(),
  states: new Map(),
  retryTimers: new Map(),
  onDataReady: null,
  requests: 0,
  refreshes: 0,
  refreshTimeMs: 0,
  failures: 0,
  retries: 0,
  sheds: 0,
  coalesced: 0,
  staleCompletions: 0,
  droppedOnShutdown: 0,
  callbackErrors: 0,
  maxQueueDepthObserved: 0,
  lastError: null,
  lastErrorAt: null,
  lastRefreshAt: null,
  lastRefreshProject: null,
  lastRefreshReason: null,
};

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function invalidateGitStatusCaches({ project = null } = {}) {
  const preserveStaleWorkerState = _gitWorker.enabled && !_gitWorker.stopping;
  if (!project) {
    if (!preserveStaleWorkerState) {
      _gitStatusCache.clear();
      _unpushedEventsCache.clear();
      _currentBranchCache.clear();
    }
    if (_gitWorker.enabled) noteGitWorkerInvalidation();
    return;
  }

  const prefix = `${project}::`;
  if (!preserveStaleWorkerState) {
    for (const key of _gitStatusCache.keys()) {
      if (key === project || key.startsWith(prefix)) _gitStatusCache.delete(key);
    }
    _unpushedEventsCache.delete(project);
    _currentBranchCache.delete(project);
  }
  if (preserveStaleWorkerState || _gitWorker.states.has(project)) {
    noteGitWorkerInvalidation(project);
  }
}

function markProjectSessionActive(project, now = Date.now()) {
  if (!project) return;
  _gitStatusActiveProjects.set(project, now);
  _gitTrackingLastSeen.delete(project);
  _gitTrackingLastSeen.set(project, now);
  if (_gitStatusActiveProjects.size > 512) {
    for (const [key, at] of _gitStatusActiveProjects.entries()) {
      if (now - at >= GIT_STATUS_CACHE_TTL_MS) _gitStatusActiveProjects.delete(key);
    }
  }
}

function pruneGitTrackingState(activeProjects = [], now = Date.now()) {
  for (const project of activeProjects) {
    if (!project) continue;
    _gitTrackingLastSeen.delete(project);
    _gitTrackingLastSeen.set(project, now);
  }

  const expiredProjects = new Set();
  for (const [project, seenAt] of _gitTrackingLastSeen) {
    if ((now - seenAt) > GIT_TRACKING_TTL_MS) expiredProjects.add(project);
  }
  while ((_gitTrackingLastSeen.size - expiredProjects.size) > GIT_TRACKING_MAX_PROJECTS) {
    const project = [..._gitTrackingLastSeen.keys()].find((candidate) => !expiredProjects.has(candidate));
    if (!project) break;
    expiredProjects.add(project);
  }

  for (const project of expiredProjects) {
    _gitTrackingLastSeen.delete(project);
    _gitStatusActiveProjects.delete(project);
    _gitHeadSignatureByProject.delete(project);
    invalidateGitStatusCaches({ project });
  }

  for (const [key, remembered] of _lastUnpushedByProjectBranch) {
    const observedAt = Number(remembered?.observedAt || 0);
    if (expiredProjects.has(remembered?.project) || !observedAt || (now - observedAt) > GIT_TRACKING_TTL_MS) {
      _lastUnpushedByProjectBranch.delete(key);
    }
  }
}

function gitStatusCacheTtl() {
  return GIT_STATUS_CACHE_TTL_MS;
}

function resolveGitDir(project) {
  let gitDir = path.join(project, '.git');
  try {
    if (fs.statSync(gitDir).isFile()) {
      // Worktree/submodule checkout: .git is a pointer file to the real git dir.
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!pointer) return null;
      gitDir = path.resolve(project, pointer[1]);
    }
  } catch {
    return null;
  }
  return gitDir;
}

function resolveGitCommonDir(gitDir) {
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  } catch {
    return gitDir;
  }
}

function gitHeadFiles(gitDir) {
  // logs/HEAD changes on local commits, HEAD on checkout, and remote/packed-ref
  // metadata on fetch/push.
  return [
    path.join(gitDir, 'logs', 'HEAD'),
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'FETCH_HEAD'),
    path.join(gitDir, 'packed-refs'),
    path.join(gitDir, 'refs', 'heads'),
    path.join(gitDir, 'refs', 'remotes'),
  ];
}

function looseRemoteRefsSignature(gitDir) {
  const root = path.join(gitDir, 'refs', 'remotes');
  const hash = crypto.createHash('sha256');
  const pending = [{ directory: root, relative: '', depth: 0 }];
  let observed = false;
  let scannedEntries = 0;
  let truncated = false;
  _perf.remoteRefScans++;
  while (pending.length && scannedEntries < GIT_REMOTE_REF_SCAN_MAX_ENTRIES) {
    const { directory, relative, depth } = pending.pop();
    let dir;
    const entries = [];
    try {
      const stat = fs.statSync(directory);
      hash.update(`dir:${relative}\0${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino || 0}\0`);
      observed = true;
      dir = fs.opendirSync(directory);
      while (entries.length < GIT_REMOTE_REF_SCAN_MAX_ENTRIES - scannedEntries) {
        const entry = dir.readSync();
        if (!entry) break;
        entries.push(entry);
      }
      if (
        entries.length >= GIT_REMOTE_REF_SCAN_MAX_ENTRIES - scannedEntries
        && dir.readSync()
      ) {
        truncated = true;
      }
    } catch {
      continue;
    } finally {
      try { dir?.closeSync(); } catch { /* ignore */ }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    scannedEntries += entries.length;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const entryPath = path.join(directory, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < GIT_REMOTE_REF_SCAN_MAX_DEPTH) {
          pending.push({ directory: entryPath, relative: entryRelative, depth: depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(entryPath);
      } catch {
        continue;
      }
      observed = true;
      hash.update(entryRelative);
      hash.update('\0');
      hash.update(`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino || 0}`);
      hash.update('\0');
    }
  }
  if (pending.length) truncated = true;
  hash.update(`scan:${scannedEntries}:${truncated ? 'truncated' : 'complete'}`);
  _perf.remoteRefEntries += scannedEntries;
  _perf.remoteRefScanHighWater = Math.max(_perf.remoteRefScanHighWater, scannedEntries);
  if (truncated) _perf.remoteRefScanTruncations++;
  return observed ? hash.digest('hex').slice(0, 16) : '-';
}

function gitHeadSignature(project) {
  const gitDir = resolveGitDir(project);
  if (!gitDir) return null;
  const gitDirs = [...new Set([gitDir, resolveGitCommonDir(gitDir)])];
  const fileSignature = [...new Set(gitDirs.flatMap(gitHeadFiles))]
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino || 0}`;
      } catch {
        return '-';
      }
    })
    .join('|');
  const remoteRefSignature = gitDirs
    .map(looseRemoteRefsSignature)
    .join('|');
  return `${fileSignature}|${remoteRefSignature}`;
}

function invalidateOnGitHeadChange(project) {
  if (!project) return;
  const signature = gitHeadSignature(project);
  const previous = _gitHeadSignatureByProject.get(project);
  _gitHeadSignatureByProject.set(project, signature);
  if (previous !== undefined && signature !== null && previous !== signature) {
    _perf.headInvalidations++;
    invalidateGitStatusCaches({ project });
  }
}

function isGitEnrichmentDisabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT || '').toLowerCase());
}

function gitWorkerErrorDetail(error) {
  const detail = error?.message || error?.code || String(error || 'Unknown Git worker error');
  return detail.length <= 256 ? detail : `${detail.slice(0, 255)}…`;
}

function isGitWorkerTimeout(error) {
  return error?.code === 'ETIMEDOUT'
    || error?.signal === 'SIGTERM'
    || /timed? out|timeout/i.test(error?.message || '');
}

function gitWorkerState(project) {
  const normalizedProject = path.resolve(String(project));
  let state = _gitWorker.states.get(normalizedProject);
  if (state) return state;

  state = {
    project: normalizedProject,
    generation: 0,
    queued: false,
    running: false,
    rerunRequested: false,
    retryAttempt: 0,
    nextRetryAt: 0,
    retryTimer: null,
    observedBranches: new Set(),
    jobObservedBranches: new Set(),
    lastRequestedAt: null,
    lastCompletedAt: null,
    lastGoodAt: null,
    lastReason: null,
  };
  _gitWorker.states.set(normalizedProject, state);
  trimGitWorkerStates(normalizedProject);
  return state;
}

function trimGitWorkerStates(protectedProject = null) {
  if (_gitWorker.states.size <= GIT_TRACKING_MAX_PROJECTS) return;
  for (const [project, state] of _gitWorker.states) {
    if (_gitWorker.states.size <= GIT_TRACKING_MAX_PROJECTS) break;
    if (project === protectedProject) continue;
    if (state.running || state.queued) continue;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    _gitWorker.states.delete(project);
  }
}

function noteGitWorkerInvalidation(project = null) {
  const states = project
    ? [gitWorkerState(project)]
    : [..._gitWorker.states.values()];
  for (const state of states) {
    state.generation++;
    if (state.running || state.queued) state.rerunRequested = true;
  }
}

function scheduleGitWorkerRetry(project, state) {
  if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled()) return;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  const delay = Math.min(
    GIT_WORKER_RETRY_MAX_MS,
    GIT_WORKER_RETRY_BASE_MS * (2 ** Math.min(state.retryAttempt - 1, 8)),
  );
  state.nextRetryAt = Date.now() + delay;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    state.nextRetryAt = 0;
    if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled()) return;
    _gitWorker.retries++;
    requestGitWorkerRefresh(project, { reason: 'retry' });
  }, delay);
  state.retryTimer.unref?.();
}

function workerSnapshot(project) {
  const cached = _unpushedEventsCache.get(project);
  return cached && Array.isArray(cached.value)
    ? cached
    : null;
}

function workerSnapshotNeedsRefresh(project, state, now = Date.now()) {
  const cached = workerSnapshot(project);
  if (!cached) return true;
  if (cached.generation !== state.generation) return true;
  return now - Number(cached.at || 0) >= GIT_STATUS_CACHE_TTL_MS;
}

function addObservedGitBranches(state, events = []) {
  const branches = new Set();
  for (const event of events) {
    if (event?.type !== 'commit') continue;
    branches.add(eventBranch(event));
  }
  let unseen = false;
  for (const branch of branches) {
    if (!state.observedBranches.has(branch) && !state.jobObservedBranches.has(branch)) unseen = true;
    state.observedBranches.add(branch);
  }
  return unseen;
}

function runGitWorkerCommand(project, args) {
  if (!project) return Promise.resolve('');

  const start = Date.now();
  _perf.gitCommandCount++;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let hardTimeout = null;

    const finish = (error, stdout = '') => {
      if (settled) return;
      settled = true;
      if (hardTimeout) clearTimeout(hardTimeout);
      if (child) _gitWorker.activeChildren.delete(child);
      _perf.gitCommandTimeMs += Date.now() - start;

      if (error) {
        const expectedRefMiss = args[0] === 'rev-parse'
          && args.includes('--verify')
          && args.includes('--quiet')
          && Number.isInteger(error?.status);
        if (!expectedRefMiss) {
          _perf.gitCommandErrors++;
          if (isGitWorkerTimeout(error)) _perf.gitCommandTimeouts++;
        }
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    };

    try {
      child = execFile('git', ['-C', project, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_WORKER_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 256 * 1024,
      }, (error, stdout) => finish(error, stdout));
      _gitWorker.activeChildren.add(child);
      hardTimeout = setTimeout(() => {
        const timeoutError = new Error(`git command timed out after ${GIT_WORKER_TIMEOUT_MS}ms`);
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.signal = 'SIGTERM';
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        finish(timeoutError);
      }, GIT_WORKER_TIMEOUT_MS + 250);
      hardTimeout.unref?.();
    } catch (error) {
      finish(error);
    }
  });
}

async function tryRunGitWorker(project, args) {
  try {
    return await runGitWorkerCommand(project, args);
  } catch (error) {
    if (
      isGitWorkerTimeout(error)
      || error?.code === 'ENOENT'
      || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) throw error;
    return '';
  }
}

async function workerCurrentBranch(project, { force = false } = {}) {
  const now = Date.now();
  const cached = _currentBranchCache.get(project);
  if (!force && cached && now - cached.at < GIT_STATUS_CACHE_TTL_MS) {
    _perf.cacheHits++;
    return cached.value;
  }
  const value = await tryRunGitWorker(project, ['branch', '--show-current']);
  _currentBranchCache.set(project, { at: now, value });
  return value;
}

async function workerBranchUpstream(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  return tryRunGitWorker(project, [
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${normalized}`,
  ]);
}

async function workerSameNameRemoteBranch(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  const refs = (await tryRunGitWorker(project, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/*/${normalized}`,
  ]))
    .split('\n')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .filter((ref) => !ref.endsWith('/HEAD'));
  if (!refs.length) return '';
  return refs.find((ref) => ref === `origin/${normalized}`) || refs[0];
}

async function workerRefExists(project, ref) {
  if (!ref) return false;
  try {
    return !!(await runGitWorkerCommand(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
  } catch (error) {
    if (isGitWorkerTimeout(error) || error?.code === 'ENOENT') throw error;
    return false;
  }
}

async function workerDefaultComparisonBase(project, branch) {
  const candidates = [
    'origin/HEAD',
    'origin/main',
    'origin/master',
    'main',
    'master',
  ].filter((ref) => ref && ref !== branch);

  for (const ref of candidates) {
    if (await workerRefExists(project, ref)) return ref;
  }
  return null;
}

async function workerBranchComparison(project, branch = '') {
  const normalizedBranch = normalizeLocalBranchName(branch || await workerCurrentBranch(project, { force: true }));
  const upstream = await workerBranchUpstream(project, normalizedBranch);
  if (upstream) {
    return { branch: normalizedBranch, baseRef: upstream, upstream, hasUpstream: true };
  }

  const remoteBranch = await workerSameNameRemoteBranch(project, normalizedBranch);
  if (remoteBranch) {
    return {
      branch: normalizedBranch,
      baseRef: remoteBranch,
      upstream: remoteBranch,
      hasUpstream: true,
    };
  }

  const baseRef = await workerDefaultComparisonBase(project, normalizedBranch);
  return {
    branch: normalizedBranch,
    baseRef,
    upstream: null,
    hasUpstream: false,
  };
}

async function readPushStateAsync(project, branch = null, { force = false } = {}) {
  const now = Date.now();
  const normalizedBranch = normalizeLocalBranchName(branch);
  const cacheKey = `${project}::${normalizedBranch || 'HEAD'}`;
  const cached = _gitStatusCache.get(cacheKey);
  if (!force && cached && now - cached.at < GIT_STATUS_CACHE_TTL_MS) {
    _perf.cacheHits++;
    return cached.value;
  }

  let value = { pushedToUpstream: false, upstream: null };
  try {
    if (await runGitWorkerCommand(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const effectiveBranch = normalizedBranch || await workerCurrentBranch(project, { force });
    const upstream = normalizedBranch
      ? await workerBranchUpstream(project, normalizedBranch)
      : await tryRunGitWorker(project, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const counts = (await runGitWorkerCommand(project, [
      'rev-list',
      '--left-right',
      '--count',
      `${effectiveBranch || 'HEAD'}...${upstream}`,
    ]))
      .split(/\s+/)
      .map((part) => Number(part));
    const ahead = Number.isFinite(counts[0]) ? counts[0] : null;
    value = { pushedToUpstream: ahead === 0, upstream };
  } catch (error) {
    if (
      isGitWorkerTimeout(error)
      || error?.code === 'ENOENT'
      || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) throw error;
  }

  _gitStatusCache.set(cacheKey, { at: now, value });
  return value;
}

async function readUnpushedCommitEventsAsync(project, context = {}) {
  if (!project) return [];
  let insideWorkTree;
  try {
    insideWorkTree = await runGitWorkerCommand(project, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (Number.isInteger(error?.status)) {
      return [];
    }
    throw error;
  }
  if (insideWorkTree !== 'true') {
    return [];
  }

  const comparison = await workerBranchComparison(project);
  if (!comparison.baseRef) {
    return [];
  }

  let output;
  try {
    output = await runGitWorkerCommand(project, [
      'log',
      '--reverse',
      `--max-count=${MAX_UNPUSHED_COMMITS_PER_BRANCH}`,
      '--format=%H%x1f%ct%x1f%s',
      `${comparison.baseRef}..${comparison.branch}`,
    ]);
  } catch (error) {
    if (Number.isInteger(error?.status)) return workerSnapshot(project)?.value || [];
    throw error;
  }

  const events = [];
  for (const line of output.split('\n')) {
    const [sha, timestampSeconds, subject] = line.split('\x1f');
    if (!sha) continue;
    const ts = Number(timestampSeconds) * 1000;
    const id = `git-unpushed-${stableHash(`${project}:${comparison.branch || 'HEAD'}:${sha}`)}`;
    events.push({
      id,
      type: 'commit',
      command: `git commit ${sha.slice(0, 10)} (${subject || 'unpushed commit'})`,
      project,
      provider: context.provider,
      sessionId: context.sessionId,
      sourceId: 'git-upstream-status',
      source: 'git-upstream-status',
      confidence: 0.72,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      commandHash: stableHash(id),
      dryRun: false,
      success: true,
      exitCode: 0,
      completedAt: Number.isFinite(ts) ? ts : Date.now(),
      sha,
      label: subject || sha.slice(0, 10),
      inferred: true,
      observed: false,
      branch: comparison.branch || null,
      targetRef: comparison.branch || comparison.baseRef,
      upstream: comparison.upstream,
      comparisonRef: comparison.baseRef,
      hasUpstream: comparison.hasUpstream,
    });
  }
  return dedupeGitEvents(events);
}

async function observeRepositoryPushTransitionsAsync(project, unpushedEvents = [], now = Date.now()) {
  if (!project) return;
  expireRecentRepositoryPushEvents(now);
  const currentByBranch = groupCommitEventsByBranch(unpushedEvents);
  for (const [branch, events] of currentByBranch.entries()) {
    _lastUnpushedByProjectBranch.set(projectBranchKey(project, branch), {
      project,
      branch,
      events: dedupeGitEvents(events),
      observedAt: now,
    });
  }

  for (const [key, previous] of _lastUnpushedByProjectBranch) {
    if (previous.project !== project || currentByBranch.has(previous.branch)) continue;
    try {
      const pushState = await readPushStateAsync(project, previous.branch, { force: true });
      if (pushState.pushedToUpstream) {
        const event = syntheticRepositoryPushFromTransition(project, previous.branch, previous.events, pushState, now);
        if (event) _recentRepositoryPushEvents.set(event.id, event);
        _lastUnpushedByProjectBranch.delete(key);
      }
    } catch (error) {
      if (!isGitWorkerTimeout(error) && error?.code !== 'ENOENT') continue;
      throw error;
    }
  }
}

async function refreshGitWorkerProject(job, state) {
  const { project, generation, reason } = job;
  const startedAt = Date.now();
  const startSignature = gitHeadSignature(project);
  const observedBranches = new Set(state.observedBranches);
  state.observedBranches.clear();
  state.jobObservedBranches = new Set(observedBranches);
  const recentPushesBefore = recentRepositoryPushEventsByProject([project], startedAt).get(project) || [];

  try {
    const events = await readUnpushedCommitEventsAsync(project, {
      provider: 'git',
      sessionId: `git-repo-${stableHash(project)}`,
    });
    for (const branch of observedBranches) {
      await readPushStateAsync(project, branch || null, { force: true });
    }
    await observeRepositoryPushTransitionsAsync(project, events, Date.now());

    const endSignature = gitHeadSignature(project);
    if (state.generation !== generation || startSignature !== endSignature) {
      _gitWorker.staleCompletions++;
      state.generation++;
      state.rerunRequested = true;
      return;
    }

    const previous = workerSnapshot(project);
    const previousValue = previous?.value || [];
    const valueChanged = JSON.stringify(previousValue) !== JSON.stringify(events);
    const completedAt = Date.now();
    const recentPushesAfter = recentRepositoryPushEventsByProject([project], completedAt).get(project) || [];
    const derivedStateChanged = JSON.stringify(recentPushesBefore) !== JSON.stringify(recentPushesAfter)
      || observedBranches.size > 0;
    _unpushedEventsCache.set(project, {
      at: completedAt,
      value: events,
      generation: state.generation,
    });
    _gitHeadSignatureByProject.set(project, endSignature);
    state.retryAttempt = 0;
    state.nextRetryAt = 0;
    state.lastGoodAt = completedAt;
    state.lastCompletedAt = completedAt;
    state.lastReason = reason;
    _gitWorker.refreshes++;
    _gitWorker.refreshTimeMs += completedAt - startedAt;
    _gitWorker.lastRefreshAt = completedAt;
    _gitWorker.lastRefreshProject = project;
    _gitWorker.lastRefreshReason = reason;

    if (!previous || valueChanged || derivedStateChanged) {
      const rerunBeforePublish = state.rerunRequested;
      try {
        _gitWorker.onDataReady?.({
          project,
          reason: 'git-enrichment-refresh',
          staleAgeMs: previous ? Math.max(0, completedAt - Number(previous.at || completedAt)) : null,
        });
      } catch (error) {
        _gitWorker.callbackErrors++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      }
      // The server invalidates its session-list cache when it publishes this
      // completion. Keep the published snapshot aligned with that generation
      // without losing a genuinely newer request coalesced during the job.
      const published = _unpushedEventsCache.get(project);
      if (published) published.generation = state.generation;
      state.rerunRequested = rerunBeforePublish;
    }
  } catch (error) {
    _gitWorker.failures++;
    _gitWorker.lastError = `${project}: ${gitWorkerErrorDetail(error)}`;
    _gitWorker.lastErrorAt = Date.now();
    state.retryAttempt++;
    scheduleGitWorkerRetry(project, state);
  } finally {
    state.jobObservedBranches.clear();
  }
}

function drainGitWorkerQueue() {
  if (!_gitWorker.enabled || _gitWorker.stopping) return;
  while (_gitWorker.activeJobs < GIT_WORKER_MAX_CONCURRENCY && _gitWorker.queue.length) {
    const job = _gitWorker.queue.shift();
    const state = _gitWorker.states.get(job.project);
    if (!state || !state.queued) continue;
    state.queued = false;
    state.running = true;
    state.lastRequestedAt = job.requestedAt;
    state.lastReason = job.reason;
    _gitWorker.activeJobs++;
    Promise.resolve(refreshGitWorkerProject(job, state))
      .catch((error) => {
        _gitWorker.failures++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      })
      .finally(() => {
        _gitWorker.activeJobs--;
        state.running = false;
        if (_gitWorker.enabled && !_gitWorker.stopping && state.rerunRequested) {
          state.rerunRequested = false;
          requestGitWorkerRefresh(job.project, { reason: 'coalesced-change' });
        }
        trimGitWorkerStates();
        drainGitWorkerQueue();
      })
      .catch((error) => {
        _gitWorker.failures++;
        _gitWorker.lastError = gitWorkerErrorDetail(error);
        _gitWorker.lastErrorAt = Date.now();
      });
  }
}

function requestGitWorkerRefresh(project, { reason = 'stale', observedEvents = [] } = {}) {
  if (!_gitWorker.enabled || _gitWorker.stopping || isGitEnrichmentDisabled() || !project) return false;
  const normalizedProject = path.resolve(String(project));
  _gitWorker.requests++;
  const state = gitWorkerState(normalizedProject);
  const hasUnseenBranches = addObservedGitBranches(state, observedEvents);
  if (state.running || state.queued) {
    _gitWorker.coalesced++;
    if (state.running && hasUnseenBranches) state.rerunRequested = true;
    return true;
  }
  if (state.nextRetryAt > Date.now()) {
    _gitWorker.coalesced++;
    return true;
  }
  if (_gitWorker.queue.length >= GIT_WORKER_MAX_QUEUE_DEPTH) {
    _gitWorker.sheds++;
    state.observedBranches.clear();
    return false;
  }

  state.queued = true;
  state.lastRequestedAt = Date.now();
  state.lastReason = reason;
  _gitWorker.queue.push({
    project: normalizedProject,
    generation: state.generation,
    reason,
    requestedAt: state.lastRequestedAt,
  });
  _gitWorker.maxQueueDepthObserved = Math.max(_gitWorker.maxQueueDepthObserved, _gitWorker.queue.length);
  drainGitWorkerQueue();
  return true;
}

function configureGitEnrichmentWorker({ enabled = true, onDataReady = null } = {}) {
  _gitWorker.enabled = Boolean(enabled);
  _gitWorker.stopping = !_gitWorker.enabled;
  _gitWorker.onDataReady = typeof onDataReady === 'function' ? onDataReady : null;
  if (_gitWorker.enabled) drainGitWorkerQueue();
  return getGitWorkerPerfStats();
}

function shutdownGitEnrichmentWorker() {
  _gitWorker.stopping = true;
  _gitWorker.enabled = false;
  _gitWorker.onDataReady = null;
  _gitWorker.droppedOnShutdown += _gitWorker.queue.length;
  _gitWorker.queue.length = 0;
  for (const timer of _gitWorker.retryTimers.values()) clearTimeout(timer);
  _gitWorker.retryTimers.clear();
  for (const state of _gitWorker.states.values()) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.nextRetryAt = 0;
    state.queued = false;
    state.rerunRequested = false;
  }
  for (const child of _gitWorker.activeChildren) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function getGitWorkerPerfStats() {
  const now = Date.now();
  let staleProjects = 0;
  let maxStaleAgeMs = 0;
  for (const cached of _unpushedEventsCache.values()) {
    const age = Math.max(0, now - Number(cached?.at || now));
    if (age >= GIT_STATUS_CACHE_TTL_MS) staleProjects++;
    maxStaleAgeMs = Math.max(maxStaleAgeMs, age);
  }
  return {
    enabled: _gitWorker.enabled,
    stopping: _gitWorker.stopping,
    maxConcurrency: GIT_WORKER_MAX_CONCURRENCY,
    maxQueueDepth: GIT_WORKER_MAX_QUEUE_DEPTH,
    timeoutMs: GIT_WORKER_TIMEOUT_MS,
    retryBaseMs: GIT_WORKER_RETRY_BASE_MS,
    retryMaxMs: GIT_WORKER_RETRY_MAX_MS,
    activeJobs: _gitWorker.activeJobs,
    activeSubprocesses: _gitWorker.activeChildren.size,
    queueDepth: _gitWorker.queue.length,
    stateCount: _gitWorker.states.size,
    requests: _gitWorker.requests,
    refreshes: _gitWorker.refreshes,
    refreshTimeMs: _gitWorker.refreshTimeMs,
    failures: _gitWorker.failures,
    retries: _gitWorker.retries,
    shedCount: _gitWorker.sheds,
    coalescedRequests: _gitWorker.coalesced,
    staleCompletions: _gitWorker.staleCompletions,
    droppedOnShutdown: _gitWorker.droppedOnShutdown,
    callbackErrors: _gitWorker.callbackErrors,
    maxQueueDepthObserved: _gitWorker.maxQueueDepthObserved,
    staleProjects,
    maxStaleAgeMs,
    lastError: _gitWorker.lastError,
    lastErrorAt: _gitWorker.lastErrorAt,
    lastRefreshAt: _gitWorker.lastRefreshAt,
    lastRefreshProject: _gitWorker.lastRefreshProject,
    lastRefreshReason: _gitWorker.lastRefreshReason,
  };
}

function recordGitEnrichment(label, projectCount, fn) {
  const disabled = isGitEnrichmentDisabled();
  _perf.disabled = disabled;
  _perf.enrichmentCalls++;
  if (disabled) {
    const run = {
      label,
      disabled: true,
      projectCount: Number(projectCount) || 0,
      elapsed: 0,
      ts: Date.now(),
    };
    _perf.lastRun = run;
    _perf.recentRuns.push(run);
    while (_perf.recentRuns.length > 25) _perf.recentRuns.shift();
    return null;
  }

  const start = Date.now();
  const beforeCommands = _perf.gitCommandCount;
  const beforeErrors = _perf.gitCommandErrors;
  const beforeTimeouts = _perf.gitCommandTimeouts;
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - start;
    _perf.enrichmentTimeMs += elapsed;
    _perf.projectsScanned += Number(projectCount) || 0;
    const run = {
      label,
      disabled: false,
      projectCount: Number(projectCount) || 0,
      elapsed,
      gitCommands: _perf.gitCommandCount - beforeCommands,
      errors: _perf.gitCommandErrors - beforeErrors,
      timeouts: _perf.gitCommandTimeouts - beforeTimeouts,
      ts: Date.now(),
    };
    _perf.lastRun = run;
    _perf.recentRuns.push(run);
    while (_perf.recentRuns.length > 25) _perf.recentRuns.shift();
  }
}

function getGitEnrichmentPerfStats() {
  const worker = getGitWorkerPerfStats();
  return {
    ..._perf,
    disabled: isGitEnrichmentDisabled(),
    worker,
    workerQueueDepth: worker.queueDepth,
    workerShedCount: worker.shedCount,
    workerActiveJobs: worker.activeJobs,
    statusCacheSize: _gitStatusCache.size,
    unpushedEventCacheSize: _unpushedEventsCache.size,
    currentBranchCacheSize: _currentBranchCache.size,
    activeProjectCacheSize: _gitStatusActiveProjects.size,
    headSignatureCacheSize: _gitHeadSignatureByProject.size,
    unpushedTransitionCacheSize: _lastUnpushedByProjectBranch.size,
    trackingProjectCount: _gitTrackingLastSeen.size,
    trackingProjectLimit: GIT_TRACKING_MAX_PROJECTS,
    remoteRefScanEntryLimit: GIT_REMOTE_REF_SCAN_MAX_ENTRIES,
    remoteRefScanDepthLimit: GIT_REMOTE_REF_SCAN_MAX_DEPTH,
  };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function parseTimestamp(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractCommand(value, depth = 0) {
  if (!value || depth > 4) return null;
  const parsed = tryParseJson(value);

  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.command === 'string') return parsed.command;
    if (typeof parsed.cmd === 'string') return parsed.cmd;

    for (const key of ['input', 'arguments', 'args', 'payload', 'data']) {
      const command = extractCommand(parsed[key], depth + 1);
      if (command) return command;
    }
  }

  return null;
}
const OUTPUT_FIELD_KEYS = new Set([
  'aggregated_output',
  'content',
  'message',
  'output',
  'result',
  'stderr',
  'stdout',
  'text',
  'tool_result',
  'toolUseResult',
]);

function collectOutputStrings(value, parts, depth = 0, active = false) {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    if (active && value.trim()) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputStrings(item, parts, depth + 1, active);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key || '');
    if (/^(?:command|cmd|input|arguments|args)$/i.test(normalizedKey)) continue;
    const childIsOutput = active
      || OUTPUT_FIELD_KEYS.has(normalizedKey)
      || /(?:output|result|stdout|stderr)/i.test(normalizedKey);
    collectOutputStrings(child, parts, depth + 1, childIsOutput);
  }
}

function extractToolOutput(value, { direct = false } = {}) {
  const parts = [];
  collectOutputStrings(tryParseJson(value), parts, 0, direct);
  return [...new Set(parts)].join('\n').slice(0, 64 * 1024);
}

function splitShellCommands(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ';' || ch === '\n' || (ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function findGitCommand(tokens) {
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index++;
  if (tokens[index] !== 'git') return null;

  index++;
  while (index < tokens.length) {
    const token = tokens[index];
    if (GIT_EVENT_TYPES.has(token)) return { type: token, subcommandIndex: index };

    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith('--git-dir=') ||
      token.startsWith('--work-tree=') ||
      token.startsWith('--namespace=') ||
      token.startsWith('--exec-path=') ||
      token.startsWith('-c') && token.length > 2
    ) {
      index++;
      continue;
    }

    if (token.startsWith('-')) {
      index++;
      continue;
    }

    return null;
  }

  return null;
}
function findGhCommand(tokens) {
  let index = 0;
  while (index < tokens.length && isEnvAssignment(tokens[index])) index++;
  if (tokens[index] === 'env') {
    index++;
    while (index < tokens.length && isEnvAssignment(tokens[index])) index++;
  }
  if (tokens[index] !== 'gh') return null;

  index++;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return null;
    if (GH_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=') || token.startsWith('--config=')) {
      index++;
      continue;
    }
    if (token.startsWith('-')) {
      index++;
      continue;
    }

    const type = String(token).toLowerCase();
    if (!GH_EVENT_TYPES.has(type)) return null;
    index++;
    while (index < tokens.length) {
      const actionToken = tokens[index];
      if (actionToken === '--') return null;
      if (GH_GLOBAL_FLAGS_WITH_VALUE.has(actionToken)) {
        index += 2;
        continue;
      }
      if (actionToken.startsWith('-')) {
        index++;
        continue;
      }

      const action = String(actionToken).toLowerCase();
      if (!GH_EVENT_COMMANDS[type]?.has(action)) return null;
      return { type, action, actionIndex: index };
    }
  }

  return null;
}

function isDryRun(type, tokens, subcommandIndex) {
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--dry-run' || token.startsWith('--dry-run=')) return true;
    if (type === 'push' && token === '-n') return true;
  }
  return false;
}

function isHelpRequest(tokens, subcommandIndex) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (HELP_FLAGS.has(token)) return true;
    if (i <= subcommandIndex) continue;
    if (token.includes('=')) continue;
    if (GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) i++;
  }
  return false;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}
const SECRET_ASSIGNMENT_RE = /(^|[\s?&,;])(?:--)?(?:key|token)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|,]*)/gi;
const SECRET_TOKEN_RE = /[A-Za-z0-9_-]{32,}/g;

function stripSecrets(value) {
  return String(value ?? '')
    .replace(SECRET_ASSIGNMENT_RE, '$1')
    .replace(SECRET_TOKEN_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function isForgeEventType(type) {
  return GH_EVENT_TYPES.has(String(type || '').toLowerCase());
}

function normalizeForgeUrl(value, type) {
  let candidate = String(value || '').trim().replace(/[),.;!?]+$/g, '');
  if (!candidate || stripSecrets(candidate) !== candidate) return null;

  const route = type === 'pr'
    ? /\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/i
    : type === 'issue'
      ? /\/[^/\s]+\/[^/\s]+\/issues\/\d+\/?$/i
      : /\/[^/\s]+\/[^/\s]+\/releases\/tag\/[^/\s?#]+\/?$/i;
  if (!/^https?:\/\/(?:www\.)?github\.com\//i.test(candidate) || !route.test(candidate)) return null;
  return candidate;
}

function forgeUrlsByType(output) {
  const urls = new Map();
  const text = String(output || '');
  const matches = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s<>"'`]+/gi) || [];
  for (const match of matches) {
    for (const type of GH_EVENT_TYPES) {
      const url = normalizeForgeUrl(match, type);
      if (!url) continue;
      const values = urls.get(type) || [];
      if (!values.includes(url)) values.push(url);
      urls.set(type, values);
      break;
    }
  }
  return urls;
}

function normalizeRefName(ref) {
  const text = String(ref || '').trim();
  if (!text) return null;

  const withoutForce = text.startsWith('+') ? text.slice(1) : text;
  const target = withoutForce.includes(':')
    ? withoutForce.slice(withoutForce.lastIndexOf(':') + 1)
    : withoutForce;
  if (!target) return null;

  return target
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '');
}

function pushPositionals(tokens, subcommandIndex) {
  const positionals = [];
  let repositoryFromFlag = false;
  let force = null;

  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (token === '--force' || token === '-f') {
      if (force === null) force = true;
    } else if (token === '--force-with-lease' || token.startsWith('--force-with-lease=')) {
      force = 'lease';
    } else if (token === '--force-if-includes' || token.startsWith('--force-if-includes=')) {
      force = 'includes';
    }

    if (token === '--repo') repositoryFromFlag = true;
    if (GIT_PUSH_FLAGS_WITH_VALUE.has(token) || GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }

    if (token.startsWith('--repo=')) {
      repositoryFromFlag = true;
      continue;
    }
    if (token.startsWith('--push-option=') || token.startsWith('--receive-pack=')) continue;
    if (token.startsWith('-')) continue;

    if (token.startsWith('+') && force === null) force = true;
    positionals.push(token);
  }

  return { positionals, repositoryFromFlag, force };
}

function pullFetchPositionals(tokens, subcommandIndex) {
  const positionals = [];
  const flags = [];

  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (GIT_PULL_FETCH_FLAG_TRACKED.has(token) && !flags.includes(token)) flags.push(token);
    if (GIT_PUSH_FLAGS_WITH_VALUE.has(token) || GIT_SUBCOMMAND_FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;

    positionals.push(token);
  }

  return { positionals, flags };
}

function extractTargetRef(type, tokens, subcommandIndex) {
  if (type === 'push') {
    const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
    const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
    if (refspecs[0] === 'tag' && refspecs[1]) return normalizeRefName(refspecs[1]);

    for (const refspec of refspecs) {
      const target = normalizeRefName(refspec);
      if (target) return target;
    }

    return null;
  }

  if (type === 'pull' || type === 'fetch') {
    const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
    const refspecs = positionals.slice(1);
    for (const refspec of refspecs) {
      const target = normalizeRefName(refspec);
      if (target) return target;
    }
    return null;
  }

  return null;
}

function extractRefspecs(type, tokens, subcommandIndex) {
  if (type === 'push') {
    const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
    const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
    return refspecs.filter(Boolean);
  }

  if (type === 'pull' || type === 'fetch') {
    const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
    return positionals.slice(1).filter(Boolean);
  }

  return [];
}

function extractRemote(type, tokens, subcommandIndex) {
  if (type !== 'pull' && type !== 'fetch') return null;
  const { positionals } = pullFetchPositionals(tokens, subcommandIndex);
  const remote = positionals[0];
  return remote ? String(remote).trim() || null : null;
}

// Branch-deletion pushes ("git push origin --delete b", "-d b", "origin :b")
// look like a normal push to the branch positional; flag them so consumers show
// a deletion rather than a publish to that ref.
function isPushDelete(tokens, subcommandIndex) {
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--delete' || token === '-d' || token.startsWith('--delete=')) return true;
  }
  const { positionals, repositoryFromFlag } = pushPositionals(tokens, subcommandIndex);
  const refspecs = repositoryFromFlag ? positionals : positionals.slice(1);
  return refspecs.some((refspec) => {
    const withoutForce = String(refspec).replace(/^\+/, '');
    return withoutForce.startsWith(':') && withoutForce.length > 1;
  });
}

function clampConfidence(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function createGitEvent(command, type, dryRun, context, parsed = {}) {
  const forge = isForgeEventType(type);
  const rawNormalized = normalizeCommand(command);
  // Forge command arguments can contain titles, prompts, and credentials.
  // Keep only the executable/action for new event records; Git events retain
  // their existing command field after secret scrubbing.
  const normalized = forge
    ? `gh ${type} ${parsed.action || 'create'}`
    : stripSecrets(rawNormalized);
  const commandHash = stableHash(forge ? stripSecrets(rawNormalized) : normalized);
  const provider = context.provider || 'unknown';
  const sessionId = context.sessionId || null;
  const sourceId = context.sourceId || null;
  const ts = parseTimestamp(context.ts);
  const project = context.project || null;
  const identity = [provider, sessionId, sourceId, project, ts, type, commandHash].filter(Boolean).join('|');
  const completedAt = parseTimestamp(context.completedAt);
  const hasCompletionMetadata = completedAt
    || typeof context.success === 'boolean'
    || Number.isFinite(Number(context.exitCode))
    || context.status != null;

  const event = {
    id: `git-${type}-${stableHash(identity)}`,
    type,
    command: normalized,
    project,
    provider,
    sessionId,
    sourceId,
    ts,
    commandHash,
    dryRun,
    source: context.source || 'command-parser',
    confidence: clampConfidence(context.confidence, forge ? 0.7 : (hasCompletionMetadata ? 0.98 : 0.92)),
    inferred: forge || context.inferred === true,
    observed: !forge && context.observed !== false && context.inferred !== true,
  };

  if (forge && parsed.action) event.action = parsed.action;
  if (forge && parsed.url) event.url = parsed.url;
  if (parsed.targetRef) event.targetRef = parsed.targetRef;
  if (parsed.refspec) event.refspec = parsed.refspec;
  if (Array.isArray(parsed.refspecs) && parsed.refspecs.length) event.refspecs = parsed.refspecs;
  if (project && type === 'push') {
    const targetBranch = normalizeRefName(parsed.targetRef);
    const branch = targetBranch || currentBranch(project, { deferOnWorker: true });
    if (branch) {
      event.branch = branch;
      if (!event.targetRef) event.targetRef = branch;
    } else if (!targetBranch) event.branch = null;
  }
  if (project && (type === 'pull' || type === 'fetch')) {
    const targetBranch = normalizeRefName(parsed.targetRef);
    const branch = targetBranch || currentBranch(project, { deferOnWorker: true });
    if (branch) event.branch = branch;
    else if (!targetBranch) event.branch = null;
  }
  if (type === 'push' && parsed.force) event.force = parsed.force;
  if (type === 'push' && parsed.deleted) event.deleted = true;
  if ((type === 'pull' || type === 'fetch')) {
    if (parsed.remote) event.remote = parsed.remote;
    if (Array.isArray(parsed.flags) && parsed.flags.length) event.flags = parsed.flags;
  }
  if (typeof context.success === 'boolean') event.success = context.success;
  if (Number.isFinite(Number(context.exitCode))) event.exitCode = Number(context.exitCode);
  if (context.status) event.status = context.status;
  if (completedAt) event.completedAt = completedAt;
  if (!forge && typeof context.stderr === 'string' && context.stderr) {
    event.stderr = stripSecrets(context.stderr);
  }

  return event;
}

function parseGitEventsFromCommand(command, context = {}, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const outputValues = [];
  for (const source of [options, context]) {
    for (const key of [
      'output',
      'stdout',
      'stderr',
      'result',
      'toolOutput',
      'tool_output',
      'toolResult',
      'tool_result',
      'aggregated_output',
    ]) {
      if (source?.[key] !== undefined) outputValues.push(source[key]);
    }
  }
  const output = [...new Set(outputValues
    .map(value => extractToolOutput(value, { direct: typeof value === 'string' }))
    .filter(Boolean))]
    .join('\n');
  const forgeUrls = forgeUrlsByType(output);
  const forgeUrlIndexes = new Map();
  const events = [];
  const ignoreDryRun = options.ignoreDryRun !== false;

  for (const segment of splitShellCommands(command)) {
    const tokens = tokenizeShellSegment(segment);
    const match = findGitCommand(tokens);
    if (match) {
      if (isHelpRequest(tokens, match.subcommandIndex)) continue;

      const dryRun = isDryRun(match.type, tokens, match.subcommandIndex);
      if (dryRun && ignoreDryRun) continue;

      const parsed = {
        targetRef: extractTargetRef(match.type, tokens, match.subcommandIndex),
      };
      const refspecs = extractRefspecs(match.type, tokens, match.subcommandIndex);
      if (refspecs.length) {
        parsed.refspec = refspecs[0];
        parsed.refspecs = refspecs;
      }
      if (match.type === 'push') {
        const pushInfo = pushPositionals(tokens, match.subcommandIndex);
        if (pushInfo.force) parsed.force = pushInfo.force;
        if (isPushDelete(tokens, match.subcommandIndex)) parsed.deleted = true;
      } else if (match.type === 'pull' || match.type === 'fetch') {
        parsed.remote = extractRemote(match.type, tokens, match.subcommandIndex);
        const pullInfo = pullFetchPositionals(tokens, match.subcommandIndex);
        if (pullInfo.flags.length) parsed.flags = pullInfo.flags;
      }
      events.push(createGitEvent(segment, match.type, dryRun, context, parsed));
      continue;
    }

    const forgeMatch = findGhCommand(tokens);
    if (!forgeMatch) continue;
    if (tokens.some(token => HELP_FLAGS.has(token))) continue;

    const dryRun = tokens.some(token => token === '--dry-run' || token.startsWith('--dry-run='));
    if (dryRun && ignoreDryRun) continue;
    const urls = forgeUrls.get(forgeMatch.type) || [];
    const urlIndex = forgeUrlIndexes.get(forgeMatch.type) || 0;
    const parsed = { action: forgeMatch.action };
    if (urls[urlIndex]) parsed.url = urls[urlIndex];
    forgeUrlIndexes.set(forgeMatch.type, urlIndex + 1);
    events.push(createGitEvent(
      segment,
      forgeMatch.type,
      dryRun,
      { ...context, inferred: true, observed: false },
      parsed,
    ));
  }

  return dedupeGitEvents(events);
}

function scrubForgeEventOutput(event) {
  const type = String(event?.type || event?.kind || '').toLowerCase();
  if (!isForgeEventType(type)) return;

  if (!event.url) {
    const output = [event.stderr, event.stdout, event.output, event.result]
      .filter(value => typeof value === 'string')
      .join('\n');
    const url = forgeUrlsByType(output).get(type)?.[0];
    if (url) event.url = url;
  } else {
    const url = normalizeForgeUrl(event.url, type);
    if (url) event.url = url;
    else delete event.url;
  }

  // Completion records may temporarily attach stdout/stderr after parsing.
  // Parse the URL above, then discard the provider prose and any credentials.
  for (const field of ['stderr', 'stdout', 'output', 'result']) delete event[field];
}

function dedupeGitEvents(events) {
  const seen = new Set();
  const unique = [];

  for (const event of events) {
    const type = event?.type || event?.kind;
    if (!isForgeEventType(type) && typeof event?.stderr === 'string') {
      event.stderr = stripSecrets(event.stderr);
    }
    scrubForgeEventOutput(event);
    if (!event || !event.id || seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }

  // Adapter scans can contain many old tool records for one repository. Keep
  // the newest forge records without imposing a new limit on Git history.
  const dropped = new Set();
  const forgeCountsByProject = new Map();
  for (let index = unique.length - 1; index >= 0; index--) {
    const event = unique[index];
    const type = event?.type || event?.kind;
    if (!isForgeEventType(type)) continue;
    const project = String(event?.project || '').trim() || '<unknown>';
    const count = forgeCountsByProject.get(project) || 0;
    if (count >= MAX_FORGE_EVENTS_PER_PROJECT) {
      dropped.add(index);
      continue;
    }
    forgeCountsByProject.set(project, count + 1);
  }

  return unique.filter((_, index) => !dropped.has(index));
}

function gitEventWireReference(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';
  let remaining = hash >>> 0;
  for (let index = 0; index < 6; index++) {
    encoded = alphabet[remaining % 64] + encoded;
    remaining = Math.floor(remaining / 64);
  }
  return encoded;
}

/**
 * Replace repeated session git-event objects with payload-level references.
 * Event ids are the normal table keys. A deterministic content suffix keeps
 * two non-identical events with the same id lossless instead of silently
 * merging them. Session references use stable short aliases derived from the
 * sorted full ids, while bitmap rows and repeated-string tables remove JSON
 * field-name overhead without changing the rehydrated event shape.
 */
function compactGitEventsForWire(sessions) {
  if (!Array.isArray(sessions)) {
    return {
      sessions: [],
      gitEventFields: [],
      gitEventStringTables: [],
      gitEventsById: {},
    };
  }

  const gitEventsById = Object.create(null);
  const entriesById = new Map();

  const referenceFor = (event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    const eventId = String(event.id || '').trim();
    let serialized = null;
    const serialize = () => {
      if (serialized === null) serialized = JSON.stringify(event);
      return serialized;
    };
    const baseKey = eventId || `git-event-${stableHash(serialize())}`;
    const existing = entriesById.get(baseKey) || [];
    for (const entry of existing) {
      if (entry.event === event || isDeepStrictEqual(entry.event, event)) return entry.key;
    }

    let key = baseKey;
    if (existing.length > 0) {
      const contentHash = stableHash(serialize());
      key = `${baseKey}~${contentHash}`;
      let suffix = 2;
      while (Object.prototype.hasOwnProperty.call(gitEventsById, key)) {
        key = `${baseKey}~${contentHash}-${suffix++}`;
      }
    }
    gitEventsById[key] = event;
    existing.push({ key, event });
    entriesById.set(baseKey, existing);
    return key;
  };

  const referencedSessions = sessions.map((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
    const references = [];
    for (const event of Array.isArray(session.gitEvents) ? session.gitEvents : []) {
      const reference = referenceFor(event);
      if (reference) references.push(reference);
    }
    return { ...session, gitEvents: references };
  });

  const gitEventIds = Object.keys(gitEventsById).sort();
  const gitEventReferenceById = new Map();
  const usedReferences = new Set();
  for (const id of gitEventIds) {
    const baseReference = gitEventWireReference(id);
    let reference = baseReference;
    let suffix = 2;
    while (usedReferences.has(reference)) reference = `${baseReference}~${suffix++}`;
    usedReferences.add(reference);
    gitEventReferenceById.set(id, reference);
  }
  // Normalize through JSON once so undefined/non-JSON properties have exactly
  // the same semantics as the former direct session payload.
  const events = gitEventIds.map((id) => JSON.parse(JSON.stringify(gitEventsById[id])));
  const gitEventFields = [...new Set(events.flatMap((event) => Object.keys(event)))].sort();
  const gitEventStringTables = [];
  const stringTableByField = new Map();

  for (let fieldIndex = 0; fieldIndex < gitEventFields.length; fieldIndex++) {
    const field = gitEventFields[fieldIndex];
    const values = events
      .filter((event) => Object.prototype.hasOwnProperty.call(event, field))
      .map((event) => event[field]);
    if (!values.length || values.some((value) => typeof value !== 'string')) continue;

    const uniqueValues = [...new Set(values)];
    const indexByValue = new Map(uniqueValues.map((value, index) => [value, index]));
    const rawBytes = values.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
    const indexedBytes = Buffer.byteLength(JSON.stringify(uniqueValues))
      + values.reduce((total, value) => total + String(indexByValue.get(value)).length, 0)
      + 10;
    if (indexedBytes >= rawBytes) continue;

    stringTableByField.set(field, indexByValue);
    gitEventStringTables.push([fieldIndex, uniqueValues]);
  }

  const encodedGitEventsById = Object.create(null);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const masks = [];
    for (let start = 0; start < gitEventFields.length; start += 30) {
      let mask = 0;
      for (let offset = 0; offset < 30 && start + offset < gitEventFields.length; offset++) {
        if (Object.prototype.hasOwnProperty.call(event, gitEventFields[start + offset])) {
          mask += 2 ** offset;
        }
      }
      masks.push(mask);
    }

    const row = [masks];
    for (const field of gitEventFields) {
      if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
      const value = event[field];
      row.push(stringTableByField.has(field)
        ? stringTableByField.get(field).get(value)
        : value);
    }
    encodedGitEventsById[gitEventIds[eventIndex]] = row;
  }

  const compactedSessions = referencedSessions.map((session) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
    return {
      ...session,
      gitEvents: session.gitEvents.map((id) => gitEventReferenceById.get(id)),
    };
  });

  return {
    sessions: compactedSessions,
    gitEventFields,
    gitEventStringTables,
    gitEventsById: encodedGitEventsById,
  };
}

function eventTime(event) {
  return parseTimestamp(event?.completedAt || event?.completed_at || event?.ts || event?.timestamp || event?.time);
}

function eventSha(event) {
  return String(event?.sha || event?.commit || event?.hash || event?.commitSha || event?.revision || '')
    .trim()
    .toLowerCase();
}

function eventBranch(event) {
  return normalizeLocalBranchName(String(event?.branch || event?.targetRef || '')
    .replace(/^refs\/remotes\/[^/]+\//, ''));
}

function commitSubjectFromCommand(command) {
  if (!command) return '';

  for (const segment of splitShellCommands(command)) {
    const tokens = tokenizeShellSegment(segment);
    const match = findGitCommand(tokens);
    if (!match || match.type !== 'commit') continue;

    const messages = [];
    for (let i = match.subcommandIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if ((token === '-m' || token === '--message') && tokens[i + 1]) {
        messages.push(tokens[i + 1]);
        i++;
        continue;
      }
      if (token.startsWith('--message=')) {
        messages.push(token.slice('--message='.length));
        continue;
      }
      if (token.startsWith('-m') && token.length > 2) {
        messages.push(token.slice(2));
      }
    }
    if (messages.length) return messages.join(' ');
  }

  return '';
}

function normalizeCommitText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function commitText(event) {
  return normalizeCommitText(
    event?.label || event?.subject || event?.message || commitSubjectFromCommand(event?.command)
  );
}

function eventTimesClose(left, right) {
  if (!left || !right) return false;
  return Math.abs(left - right) <= 120000;
}

function commitTextsEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 18) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function sameCommitEvent(left, right) {
  if (!left || !right || left.type !== 'commit' || right.type !== 'commit') return false;
  if (left.project !== right.project) return false;

  const leftSha = eventSha(left);
  const rightSha = eventSha(right);
  if (leftSha && rightSha) return leftSha === rightSha;

  const leftTime = eventTime(left);
  const rightTime = eventTime(right);
  const timesClose = eventTimesClose(leftTime, rightTime);
  if (left.commandHash && right.commandHash && left.commandHash === right.commandHash) {
    return !leftTime || !rightTime || timesClose;
  }

  return timesClose && commitTextsEquivalent(commitText(left), commitText(right));
}

function mergeCommitEvents(observed, inferred) {
  const merged = {
    ...inferred,
    ...observed,
  };
  const sha = eventSha(observed) || eventSha(inferred);
  if (sha) merged.sha = sha;
  if (!merged.label && inferred.label) merged.label = inferred.label;
  if (!merged.branch && inferred.branch) merged.branch = inferred.branch;
  if (!merged.targetRef && inferred.targetRef) merged.targetRef = inferred.targetRef;
  if (!merged.upstream && inferred.upstream) merged.upstream = inferred.upstream;
  if (!merged.comparisonRef && inferred.comparisonRef) merged.comparisonRef = inferred.comparisonRef;
  if (typeof merged.hasUpstream !== 'boolean' && typeof inferred.hasUpstream === 'boolean') {
    merged.hasUpstream = inferred.hasUpstream;
  }
  if (observed.inferred !== true) merged.inferred = false;
  return merged;
}

function mergeUnpushedGitEvents(observedEvents, inferredEvents) {
  const observed = Array.isArray(observedEvents) ? observedEvents : [];
  const inferred = Array.isArray(inferredEvents) ? inferredEvents : [];
  if (!inferred.length) return dedupeGitEvents(observed);

  const usedInferred = new Set();
  const merged = observed.map((event) => {
    if (event?.type !== 'commit') return event;
    const index = inferred.findIndex((candidate, candidateIndex) => {
      return !usedInferred.has(candidateIndex) && sameCommitEvent(event, candidate);
    });
    if (index === -1) return event;
    usedInferred.add(index);
    return mergeCommitEvents(event, inferred[index]);
  });

  inferred.forEach((event, index) => {
    if (!usedInferred.has(index)) merged.push(event);
  });

  return dedupeGitEvents(merged);
}

function runGit(project, args) {
  if (!project) return '';
  const start = Date.now();
  _perf.gitCommandCount++;
  try {
    return execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    }).trim();
  } catch (err) {
    const expectedRefMiss = args[0] === 'rev-parse'
      && args.includes('--verify')
      && args.includes('--quiet')
      && Number.isInteger(err?.status);
    if (!expectedRefMiss) {
      _perf.gitCommandErrors++;
      if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || /timed? out|timeout/i.test(err?.message || '')) {
        _perf.gitCommandTimeouts++;
      }
    }
    throw err;
  } finally {
    _perf.gitCommandTimeMs += Date.now() - start;
  }
}

function tryRunGit(project, args) {
  try {
    return runGit(project, args);
  } catch {
    return '';
  }
}

function refExists(project, ref) {
  if (!ref) return false;
  return !!tryRunGit(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

function currentBranch(project, { deferOnWorker = false } = {}) {
  if (!project) return '';
  const now = Date.now();
  const cached = _currentBranchCache.get(project);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }
  if (deferOnWorker && _gitWorker.enabled && !_gitWorker.stopping) {
    requestGitWorkerRefresh(project, { reason: 'branch-cache-miss' });
    return null;
  }
  const value = tryRunGit(project, ['branch', '--show-current']);
  _currentBranchCache.set(project, { at: now, value });
  return value;
}

function normalizeLocalBranchName(branch) {
  return String(branch || '').trim().replace(/^refs\/heads\//, '');
}

function branchUpstream(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  return tryRunGit(project, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${normalized}`]);
}

function sameNameRemoteBranch(project, branch) {
  const normalized = normalizeLocalBranchName(branch);
  if (!normalized) return '';
  const refs = tryRunGit(project, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/*/${normalized}`,
  ])
    .split('\n')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .filter((ref) => !ref.endsWith('/HEAD'));
  if (!refs.length) return '';
  const originRef = refs.find((ref) => ref === `origin/${normalized}`);
  return originRef || refs[0];
}

function defaultComparisonBase(project, branch) {
  const candidates = [
    'origin/HEAD',
    'origin/main',
    'origin/master',
    'main',
    'master',
  ].filter((ref) => ref && ref !== branch);

  for (const baseRef of candidates) {
    if (refExists(project, baseRef)) return baseRef;
  }

  return null;
}

function branchComparison(project, branch, explicitUpstream = '') {
  const normalizedBranch = normalizeLocalBranchName(branch || currentBranch(project));
  const upstream = explicitUpstream || branchUpstream(project, normalizedBranch);
  if (upstream) {
    return {
      branch: normalizedBranch,
      baseRef: upstream,
      upstream,
      hasUpstream: true,
    };
  }

  const remoteBranch = sameNameRemoteBranch(project, normalizedBranch);
  if (remoteBranch) {
    return {
      branch: normalizedBranch,
      baseRef: remoteBranch,
      upstream: remoteBranch,
      hasUpstream: true,
    };
  }

  const baseRef = defaultComparisonBase(project, normalizedBranch);
  if (baseRef) return {
    branch: normalizedBranch,
    baseRef,
    upstream: null,
    hasUpstream: false,
  };

  return {
    branch: normalizedBranch,
    baseRef: null,
    upstream: null,
    hasUpstream: false,
  };
}

function unpushedComparison(project) {
  return branchComparison(project, currentBranch(project));
}

function readPushState(project, branch = null) {
  const now = Date.now();
  const normalizedBranch = normalizeLocalBranchName(branch);
  const cacheKey = `${project}::${normalizedBranch || 'HEAD'}`;
  const cached = _gitStatusCache.get(cacheKey);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }

  let value = { pushedToUpstream: false, upstream: null };
  try {
    if (runGit(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const effectiveBranch = normalizedBranch || currentBranch(project) || 'HEAD';
    const upstream = normalizedBranch
      ? branchUpstream(project, normalizedBranch)
      : runGit(project, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) {
      _gitStatusCache.set(cacheKey, { at: now, value });
      return value;
    }
    const counts = runGit(project, ['rev-list', '--left-right', '--count', `${effectiveBranch}...${upstream}`])
      .split(/\s+/)
      .map((part) => Number(part));
    const ahead = Number.isFinite(counts[0]) ? counts[0] : null;
    value = {
      pushedToUpstream: ahead === 0,
      upstream: upstream || null,
    };
  } catch {
    value = { pushedToUpstream: false, upstream: null };
  }

  _gitStatusCache.set(cacheKey, { at: now, value });
  return value;
}

function buildSyntheticPushForState(project, commitEvents, pushState, now = Date.now()) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length) return null;

  const branch = commits[0].branch || commits[0].targetRef || null;
  if (!pushState.pushedToUpstream) return null;

  const latestCommit = commits[0];
  const latestCommitTime = latestCommit.completedAt || latestCommit.ts || 0;
  const eventTime = latestCommitTime || now;
  const id = `git-push-inferred-${stableHash([
    project,
    pushState.upstream || 'upstream',
    latestCommit.id || latestCommit.commandHash || latestCommit.command || latestCommitTime,
  ].join('|'))}`;

  return {
    id,
    type: 'push',
    command: `git push (${pushState.upstream || 'upstream'} already contains HEAD)`,
    project,
    provider: latestCommit.provider,
    sessionId: latestCommit.sessionId,
    sourceId: 'git-upstream-status',
    source: 'git-upstream-status',
    confidence: 0.76,
    ts: eventTime,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: eventTime,
    status: 'success',
    targetRef: pushState.upstream,
    branch: branch || null,
    label: pushState.upstream ? `Pushed to ${pushState.upstream}` : 'Pushed',
    inferred: true,
    observed: false,
  };
}

function syntheticPushForProject(project, commitEvents, now = Date.now()) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length) return null;
  const branch = commits[0].branch || commits[0].targetRef || null;
  return buildSyntheticPushForState(project, commits, readPushState(project, branch), now);
}

function cachedPushState(project, branch = null) {
  const normalizedBranch = normalizeLocalBranchName(branch);
  const cached = _gitStatusCache.get(`${project}::${normalizedBranch || 'HEAD'}`);
  return cached?.value || null;
}

function syntheticPushForProjectFromCache(project, commitEvents, now = Date.now()) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length) return null;
  const branch = commits[0].branch || commits[0].targetRef || null;
  const pushState = cachedPushState(project, branch);
  return pushState ? buildSyntheticPushForState(project, commits, pushState, now) : null;
}

function syntheticPushesForProject(project, commitEvents, now = Date.now()) {
  const groups = new Map();
  for (const event of commitEvents || []) {
    if (event?.type !== 'commit' || event.project !== project) continue;
    const branch = eventBranch(event);
    const events = groups.get(branch) || [];
    events.push(event);
    groups.set(branch, events);
  }

  return [...groups.values()]
    .map((events) => syntheticPushForProject(project, events, now))
    .filter(Boolean);
}

function projectBranchKey(project, branch = '') {
  return `${project}::${normalizeLocalBranchName(branch) || 'HEAD'}`;
}

function groupCommitEventsByBranch(events = []) {
  const groups = new Map();
  for (const event of events || []) {
    if (event?.type !== 'commit') continue;
    const branch = eventBranch(event);
    const list = groups.get(branch) || [];
    list.push(event);
    groups.set(branch, list);
  }
  return groups;
}

function syntheticRepositoryPushFromTransition(project, branch, commitEvents, pushState, now) {
  const commits = (commitEvents || [])
    .filter((event) => event?.type === 'commit' && event.project === project && event.success !== false)
    .sort((a, b) => ((b.completedAt || b.ts || 0) - (a.completedAt || a.ts || 0)));
  if (!commits.length || !pushState?.pushedToUpstream) return null;

  const latestCommit = commits[0];
  const normalizedBranch = normalizeLocalBranchName(branch || latestCommit.branch || latestCommit.targetRef || '');
  const id = `git-push-transition-${stableHash([
    project,
    normalizedBranch || 'HEAD',
    pushState.upstream || 'upstream',
    latestCommit.sha || latestCommit.id || latestCommit.commandHash || latestCommit.command,
  ].join('|'))}`;

  return {
    id,
    type: 'push',
    command: `git push (${pushState.upstream || 'upstream'} now contains HEAD)`,
    project,
    provider: latestCommit.provider || 'git',
    sessionId: latestCommit.sessionId || `git-repo-${stableHash(project)}`,
    sourceId: 'git-upstream-transition',
    source: 'git-upstream-transition',
    confidence: 0.82,
    ts: now,
    commandHash: stableHash(id),
    dryRun: false,
    success: true,
    exitCode: 0,
    completedAt: now,
    status: 'success',
    targetRef: pushState.upstream,
    branch: normalizedBranch || null,
    label: pushState.upstream ? `Pushed to ${pushState.upstream}` : 'Pushed',
    inferred: true,
    observed: false,
  };
}

function expireRecentRepositoryPushEvents(now = Date.now()) {
  const cutoff = now - RECENT_REPOSITORY_PUSH_TTL_MS;
  for (const [id, event] of _recentRepositoryPushEvents.entries()) {
    const ts = Number(event?.completedAt || event?.ts || 0);
    if (!Number.isFinite(ts) || ts < cutoff) _recentRepositoryPushEvents.delete(id);
  }
}

function observeRepositoryPushTransitions(project, unpushedEvents = [], now = Date.now()) {
  if (!project) return;
  expireRecentRepositoryPushEvents(now);

  const currentByBranch = groupCommitEventsByBranch(unpushedEvents);
  for (const [branch, events] of currentByBranch.entries()) {
    _lastUnpushedByProjectBranch.set(projectBranchKey(project, branch), {
      project,
      branch,
      events: dedupeGitEvents(events),
      observedAt: now,
    });
  }

  for (const [key, previous] of _lastUnpushedByProjectBranch.entries()) {
    if (previous.project !== project) continue;
    if (currentByBranch.has(previous.branch)) continue;

    const pushState = readPushState(project, previous.branch);
    if (pushState.pushedToUpstream) {
      const event = syntheticRepositoryPushFromTransition(project, previous.branch, previous.events, pushState, now);
      if (event) _recentRepositoryPushEvents.set(event.id, event);
      _lastUnpushedByProjectBranch.delete(key);
    }
  }
}

function recentRepositoryPushEventsByProject(projects = [], now = Date.now()) {
  expireRecentRepositoryPushEvents(now);
  const projectSet = new Set((projects || []).filter(Boolean));
  const byProject = new Map();
  for (const event of _recentRepositoryPushEvents.values()) {
    if (projectSet.size && !projectSet.has(event.project)) continue;
    const list = byProject.get(event.project) || [];
    list.push(event);
    byProject.set(event.project, list);
  }
  return byProject;
}

function readUnpushedCommitEvents(project, context = {}) {
  if (!project) return [];
  const now = Date.now();
  const cached = _unpushedEventsCache.get(project);
  if (cached && now - cached.at < gitStatusCacheTtl(project, now)) {
    _perf.cacheHits++;
    return cached.value;
  }

  let value = [];
  const commandErrorsBefore = _perf.gitCommandErrors;
  try {
    if (runGit(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      _unpushedEventsCache.set(project, { at: now, value });
      return value;
    }
    const comparisons = [unpushedComparison(project)].filter((comparison) => comparison.baseRef);
    if (!comparisons.length) {
      if (_perf.gitCommandErrors > commandErrorsBefore) return cached?.value || value;
      _unpushedEventsCache.set(project, { at: now, value });
      return value;
    }

    const events = [];
    for (const comparison of comparisons) {
      const output = runGit(project, [
        'log',
        '--reverse',
        `--max-count=${MAX_UNPUSHED_COMMITS_PER_BRANCH}`,
        '--format=%H%x1f%ct%x1f%s',
        `${comparison.baseRef}..${comparison.branch}`,
      ]);
      if (!output) continue;

      for (const line of output.split('\n')) {
        const [sha, timestampSeconds, subject] = line.split('\x1f');
        if (!sha) continue;
        const ts = Number(timestampSeconds) * 1000;
        const id = `git-unpushed-${stableHash(`${project}:${comparison.branch || 'HEAD'}:${sha}`)}`;
        events.push({
          id,
          type: 'commit',
          command: `git commit ${sha.slice(0, 10)} (${subject || 'unpushed commit'})`,
          project,
          provider: context.provider,
          sessionId: context.sessionId,
          sourceId: 'git-upstream-status',
          source: 'git-upstream-status',
          confidence: 0.72,
          ts: Number.isFinite(ts) ? ts : Date.now(),
          commandHash: stableHash(id),
          dryRun: false,
          success: true,
          exitCode: 0,
          completedAt: Number.isFinite(ts) ? ts : Date.now(),
          sha,
          label: subject || sha.slice(0, 10),
          inferred: true,
          observed: false,
          branch: comparison.branch || null,
          targetRef: comparison.branch || comparison.baseRef,
          upstream: comparison.upstream,
          comparisonRef: comparison.baseRef,
          hasUpstream: comparison.hasUpstream,
        });
      }
    }
    value = dedupeGitEvents(events);
  } catch {
    return cached?.value || value;
  }
  _unpushedEventsCache.set(project, { at: now, value });
  return value;
}

function inferPushedGitEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const commitsByProject = new Map();
  const observedPushBranchesByProject = new Map();
  for (const event of list) {
    if (!event?.project) continue;
    if (event.type === 'commit') {
      const commits = commitsByProject.get(event.project) || [];
      commits.push(event);
      commitsByProject.set(event.project, commits);
    }
    if (event.type === 'push') {
      const branches = observedPushBranchesByProject.get(event.project) || new Set();
      branches.add(eventBranch(event));
      observedPushBranchesByProject.set(event.project, branches);
    }
  }
  if (!commitsByProject.size) return list;

  const enriched = [...list];
  for (const [project, commits] of commitsByProject.entries()) {
    const observedBranches = observedPushBranchesByProject.get(project) || new Set();
    const candidates = syntheticPushesForProject(project, commits, now)
      .filter((event) => !observedBranches.has(eventBranch(event)));
    enriched.push(...candidates);
  }
  return dedupeGitEvents(enriched);
}

function createRepositoryGitSession(project, gitEvents) {
  const events = Array.isArray(gitEvents) ? gitEvents : [];
  const latestActivity = events.reduce((latest, event) => {
    const eventTime = event?.completedAt || event?.ts || 0;
    return Math.max(latest, Number(eventTime) || 0);
  }, Date.now());
  const count = events.length;
  const pushCount = events.filter((event) => event?.type === 'push').length;
  const commitCount = events.filter((event) => event?.type === 'commit').length;
  const lastMessage = pushCount && !commitCount
    ? (pushCount === 1 ? '1 pushed batch' : `${pushCount} pushed batches`)
    : (commitCount === 1 ? '1 unpushed commit' : `${commitCount || count} unpushed commits`);

  return {
    sessionId: `git-repo-${stableHash(project)}`,
    provider: 'git',
    agentId: null,
    agentType: 'repository',
    name: 'Repo Watch',
    agentName: 'Repo Watch',
    model: 'git',
    status: 'active',
    lastActivity: latestActivity || Date.now(),
    project,
    lastMessage,
    lastTool: 'git status',
    lastToolInput: 'Scan unpushed commits',
    tokenUsage: null,
    gitEvents: events,
    parentSessionId: null,
  };
}

function recentRepositoryUnpushedEvents(events = [], now = Date.now()) {
  const cutoff = now - REPOSITORY_UNPUSHED_EVENT_TTL_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    if (event?.type !== 'commit') return true;
    const eventTime = Number(event.completedAt || event.ts || 0);
    return Number.isFinite(eventTime) && eventTime >= cutoff;
  });
}

function observeRepositoryPushTransitionsFromCache(project, unpushedEvents = [], now = Date.now()) {
  if (!project) return;
  expireRecentRepositoryPushEvents(now);
  const currentByBranch = groupCommitEventsByBranch(unpushedEvents);
  for (const [branch, events] of currentByBranch.entries()) {
    _lastUnpushedByProjectBranch.set(projectBranchKey(project, branch), {
      project,
      branch,
      events: dedupeGitEvents(events),
      observedAt: now,
    });
  }

  for (const [key, previous] of _lastUnpushedByProjectBranch) {
    if (previous.project !== project || currentByBranch.has(previous.branch)) continue;
    const pushState = cachedPushState(project, previous.branch);
    if (!pushState?.pushedToUpstream) continue;
    const event = syntheticRepositoryPushFromTransition(project, previous.branch, previous.events, pushState, now);
    if (event) _recentRepositoryPushEvents.set(event.id, event);
    _lastUnpushedByProjectBranch.delete(key);
  }
}

function inferUnpushedGitEventsForSessionsAsync(sessions, options = {}) {
  const now = Date.now();
  const extraProjects = Array.isArray(options.projects)
    ? options.projects.filter(Boolean)
    : [];
  if (sessions.length === 0 && extraProjects.length === 0) {
    pruneGitTrackingState([], now);
    return sessions;
  }
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment('unpushed-async', 0, () => sessions);
    return sessions;
  }

  const eventsByProject = new Map();
  const projects = [
    ...sessions.map((session) => session?.project).filter(Boolean),
    ...extraProjects,
  ];
  const uniqueProjects = [...new Set(projects)];
  return recordGitEnrichment('unpushed-async', uniqueProjects.length, () => {
    pruneGitTrackingState(uniqueProjects, now);
    for (const session of sessions) {
      if (session?.project) markProjectSessionActive(session.project, now);
    }

    for (const project of uniqueProjects) {
      const state = gitWorkerState(project);
      invalidateOnGitHeadChange(project);
      const currentState = _gitWorker.states.get(project) || state;
      const cached = workerSnapshot(project);
      const unpushed = cached?.value || [];
      eventsByProject.set(project, unpushed);
      observeRepositoryPushTransitionsFromCache(project, unpushed, now);
      if (workerSnapshotNeedsRefresh(project, currentState, now)) {
        requestGitWorkerRefresh(project, { reason: cached ? 'stale' : 'initial' });
      }
    }

    const recentPushesByProject = recentRepositoryPushEventsByProject(uniqueProjects, now);
    const hasUnpushed = [...eventsByProject.values()].some((events) => events.length > 0);
    const hasRecentPushes = [...recentPushesByProject.values()].some((events) => events.length > 0);
    if (!hasUnpushed && !hasRecentPushes) return sessions;

    const enrichedSessions = sessions.map((session) => {
      const project = session?.project;
      const unpushed = project ? eventsByProject.get(project) || [] : [];
      const recentPushes = project ? recentPushesByProject.get(project) || [] : [];
      if (!unpushed.length && !recentPushes.length) return session;
      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const commitEvents = mergeUnpushedGitEvents(ownEvents, unpushed);
      return {
        ...session,
        gitEvents: dedupeGitEvents([...commitEvents, ...recentPushes]),
      };
    });

    const sessionProjects = new Set(sessions.map((session) => session?.project).filter(Boolean));
    for (const project of extraProjects) {
      if (sessionProjects.has(project)) continue;
      const unpushed = recentRepositoryUnpushedEvents(eventsByProject.get(project), now);
      const recentPushes = recentPushesByProject.get(project) || [];
      const events = dedupeGitEvents([...unpushed, ...recentPushes]);
      if (!events.length) continue;
      enrichedSessions.push(createRepositoryGitSession(project, events));
    }

    return enrichedSessions;
  });
}

function inferUnpushedGitEventsForSessions(sessions, options = {}) {
  if (!Array.isArray(sessions)) return sessions;
  if (_gitWorker.enabled) return inferUnpushedGitEventsForSessionsAsync(sessions, options);

  const now = Date.now();
  const extraProjects = Array.isArray(options.projects)
    ? options.projects.filter(Boolean)
    : [];
  if (sessions.length === 0 && extraProjects.length === 0) {
    pruneGitTrackingState([], now);
    return sessions;
  }
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment('unpushed', 0, () => sessions);
    return sessions;
  }
  const eventsByProject = new Map();
  const projects = [
    ...sessions.map((session) => session?.project).filter(Boolean),
    ...extraProjects,
  ];

  const uniqueProjects = [...new Set(projects.filter(Boolean))];
  return recordGitEnrichment('unpushed', uniqueProjects.length, () => {
    pruneGitTrackingState(uniqueProjects, now);
    for (const session of sessions) {
      if (session?.project) markProjectSessionActive(session.project, now);
    }
    for (const project of uniqueProjects) {
      invalidateOnGitHeadChange(project);
      if (!eventsByProject.has(project)) {
        const unpushed = readUnpushedCommitEvents(project, {
          provider: 'git',
          sessionId: `git-repo-${stableHash(project)}`,
        });
        eventsByProject.set(project, unpushed);
        observeRepositoryPushTransitions(project, unpushed, now);
      }
    }

    const recentPushesByProject = recentRepositoryPushEventsByProject(uniqueProjects, now);
    const hasUnpushed = [...eventsByProject.values()].some((events) => events.length > 0);
    const hasRecentPushes = [...recentPushesByProject.values()].some((events) => events.length > 0);
    if (!hasUnpushed && !hasRecentPushes) return sessions;

    const enrichedSessions = sessions.map((session) => {
      const project = session?.project;
      const unpushed = project ? eventsByProject.get(project) || [] : [];
      const recentPushes = project ? recentPushesByProject.get(project) || [] : [];
      if (!unpushed.length && !recentPushes.length) return session;

      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const commitEvents = mergeUnpushedGitEvents(ownEvents, unpushed);
      return {
        ...session,
        gitEvents: dedupeGitEvents([...commitEvents, ...recentPushes]),
      };
    });

    const sessionProjects = new Set(sessions.map((session) => session?.project).filter(Boolean));
    for (const project of extraProjects) {
      if (sessionProjects.has(project)) continue;
      const unpushed = recentRepositoryUnpushedEvents(eventsByProject.get(project), now);
      const recentPushes = recentPushesByProject.get(project) || [];
      const events = dedupeGitEvents([...unpushed, ...recentPushes]);
      if (!events.length) continue;
      enrichedSessions.push(createRepositoryGitSession(project, events));
    }

    return enrichedSessions;
  });
}

function inferPushedGitEventsForSessionsAsync(sessions, options = {}) {
  const eventsByProject = new Map();
  for (const session of sessions) {
    for (const event of session.gitEvents || []) {
      if (!event?.project) continue;
      const events = eventsByProject.get(event.project) || [];
      events.push(event);
      eventsByProject.set(event.project, events);
    }
  }

  return recordGitEnrichment('pushed-async', eventsByProject.size, () => {
    const inferredByProject = new Map();
    for (const [project, events] of eventsByProject.entries()) {
      const now = Number.isFinite(options.now) ? options.now : Date.now();
      const needsPushStateRefresh = events.some((event) => {
        if (event?.type !== 'commit') return false;
        const branch = eventBranch(event);
        const cached = _gitStatusCache.get(`${project}::${normalizeLocalBranchName(branch) || 'HEAD'}`);
        return !cached || now - Number(cached.at || 0) >= GIT_STATUS_CACHE_TTL_MS;
      });
      if (needsPushStateRefresh) {
        requestGitWorkerRefresh(project, {
          reason: 'observed-git-event',
          observedEvents: events,
        });
      }
      const inferred = events
        .map((event) => event?.type === 'commit' ? syntheticPushForProjectFromCache(project, [event], now) : null)
        .filter(Boolean);
      if (inferred.length) inferredByProject.set(project, dedupeGitEvents(inferred));
    }

    if (!inferredByProject.size) return sessions;
    return sessions.map((session) => {
      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const additions = [];
      for (const event of ownEvents) {
        if (event?.type !== 'commit' || !event.project || !inferredByProject.has(event.project)) continue;
        const branch = eventBranch(event);
        const inferredForProject = inferredByProject.get(event.project);
        if (!branch) {
          additions.push(...inferredForProject.filter((inferred) => !inferred.branch));
          continue;
        }
        additions.push(...inferredForProject.filter((inferred) => eventBranch(inferred) === branch));
      }
      if (!additions.length) return session;
      return {
        ...session,
        gitEvents: dedupeGitEvents([...ownEvents, ...additions]),
      };
    });
  });
}

function inferPushedGitEventsForSessions(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;
  if (isGitEnrichmentDisabled()) {
    recordGitEnrichment('pushed', 0, () => sessions);
    return sessions;
  }
  if (_gitWorker.enabled) return inferPushedGitEventsForSessionsAsync(sessions, options);

  const eventsByProject = new Map();
  for (const session of sessions) {
    for (const event of session.gitEvents || []) {
      if (!event?.project) continue;
      const events = eventsByProject.get(event.project) || [];
      events.push(event);
      eventsByProject.set(event.project, events);
    }
  }

  return recordGitEnrichment('pushed', eventsByProject.size, () => {
    const inferredByProject = new Map();
    for (const [project, events] of eventsByProject.entries()) {
      const enriched = inferPushedGitEvents(events, options);
      const inferred = enriched.filter((event) => event.inferred && !events.some((existing) => existing.id === event.id));
      if (inferred.length) inferredByProject.set(project, inferred);
    }

    if (!inferredByProject.size) return sessions;
    return sessions.map((session) => {
      const ownEvents = Array.isArray(session.gitEvents) ? session.gitEvents : [];
      const additions = [];
      for (const event of ownEvents) {
        if (event?.type !== 'commit' || !event.project || !inferredByProject.has(event.project)) continue;
        const branch = eventBranch(event);
        const inferredForProject = inferredByProject.get(event.project);
        if (!branch) {
          additions.push(...inferredForProject.filter((inferred) => !inferred.branch));
          continue;
        }
        additions.push(...inferredForProject.filter((inferred) => eventBranch(inferred) === branch));
      }
      if (!additions.length) return session;
      return {
        ...session,
        gitEvents: dedupeGitEvents([...ownEvents, ...additions]),
      };
    });
  });
}

function extractGitEventsFromCommandSource(source, context = {}, options = {}) {
  const parsedSource = tryParseJson(source);
  const command = extractCommand(parsedSource);
  const sourceOutput = extractToolOutput(parsedSource);
  const output = sourceOutput
    ? [context.output, sourceOutput].filter(Boolean).join('\n')
    : context.output;
  const parserContext = output ? { ...context, output } : context;
  return parseGitEventsFromCommand(command, parserContext, options);
}

module.exports = {
  MAX_FORGE_EVENTS_PER_PROJECT,
  compactGitEventsForWire,
  dedupeGitEvents,
  configureGitEnrichmentWorker,
  extractCommand,
  extractGitEventsFromCommandSource,
  getGitEnrichmentPerfStats,
  getGitWorkerPerfStats,
  invalidateGitStatusCaches,
  inferPushedGitEvents,
  inferPushedGitEventsForSessions,
  inferUnpushedGitEventsForSessions,
  isGitEnrichmentDisabled,
  mergeUnpushedGitEvents,
  parseGitEventsFromCommand,
  requestGitWorkerRefresh,
  shutdownGitEnrichmentWorker,
  stableHash,
};
