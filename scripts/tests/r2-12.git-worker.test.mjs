import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir as makeConfiguredTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const GIT_EVENTS_PATH = path.join(REPO_ROOT, 'claudeville', 'adapters', 'gitEvents.js');

function makeTempDir(label) {
  return makeConfiguredTempDir(`claudeville-${label}-`);
}

function writeFakeGit(directory) {
  const fakeGit = path.join(directory, 'git');
  fs.writeFileSync(fakeGit, `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (process.env.FAKE_GIT_MODE === 'hang') {
  setTimeout(() => {}, 2000);
} else if (args.includes('--is-inside-work-tree')) {
  process.stdout.write('true\\n');
} else if (args.includes('branch --show-current')) {
  process.stdout.write('main\\n');
} else if (args.includes('upstream:short')) {
  process.stdout.write('origin/main\\n');
} else if (args.includes('log ')) {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + String.fromCharCode(31) + '1700000000' + String.fromCharCode(31) + 'cached commit\\n');
} else if (args.includes('rev-list')) {
  process.stdout.write('0 0\\n');
} else if (args.includes('rev-parse --verify')) {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
} else {
  process.exitCode = 1;
}
`);
  fs.chmodSync(fakeGit, 0o755);
  return fakeGit;
}

function runWorkerChild(mode, { fakeGit, projectCount = 1 } = {}) {
  const childScript = `
const git = require(${JSON.stringify(GIT_EVENTS_PATH)});
const mode = process.argv[1];
const projects = Array.from({ length: ${projectCount} }, (_, index) => '/tmp/r2-12-project-' + index);
git.configureGitEnrichmentWorker({ enabled: true });
if (mode === 'queue') {
  for (const project of projects) git.requestGitWorkerRefresh(project, { reason: 'load' });
  console.log(JSON.stringify({ phase: 'queued', stats: git.getGitWorkerPerfStats() }));
  const deadline = Date.now() + 5000;
  const waitForDrain = () => {
    const stats = git.getGitWorkerPerfStats();
    if ((stats.queueDepth || stats.activeJobs) && Date.now() < deadline) {
      return setTimeout(waitForDrain, 10);
    }
    git.shutdownGitEnrichmentWorker();
    console.log(JSON.stringify({ phase: 'settled', stats }));
  };
  waitForDrain();
} else if (mode === 'coalesce') {
  for (let index = 0; index < 8; index += 1) {
    git.requestGitWorkerRefresh(projects[0], { reason: 'duplicate' });
  }
  const stats = git.getGitWorkerPerfStats();
  git.shutdownGitEnrichmentWorker();
  console.log(JSON.stringify({ phase: 'coalesced', stats }));
} else if (mode === 'timeout') {
  process.env.FAKE_GIT_MODE = 'hang';
  git.requestGitWorkerRefresh(projects[0], { reason: 'hung-command' });
  setTimeout(() => {
    const stats = git.getGitEnrichmentPerfStats();
    git.shutdownGitEnrichmentWorker();
    console.log(JSON.stringify({ phase: 'timeout', stats }));
  }, 250);
} else if (mode === 'stale') {
  process.env.FAKE_GIT_MODE = 'good';
  const session = { project: projects[0], gitEvents: [] };
  git.inferUnpushedGitEventsForSessions([session]);
  const waitForRefresh = () => {
    if (git.getGitWorkerPerfStats().refreshes < 1) return setTimeout(waitForRefresh, 10);
    const warm = git.inferUnpushedGitEventsForSessions([session]);
    process.env.FAKE_GIT_MODE = 'hang';
    git.invalidateGitStatusCaches({ project: projects[0] });
    const stale = git.inferUnpushedGitEventsForSessions([session]);
    const immediate = { warmEvents: warm[0].gitEvents.length, staleEvents: stale[0].gitEvents.length };
    setTimeout(() => {
      const stats = git.getGitEnrichmentPerfStats();
      git.shutdownGitEnrichmentWorker();
      console.log(JSON.stringify({ phase: 'stale', immediate, stats }));
    }, 500);
  };
  waitForRefresh();
}
`;
  const result = spawnSync(process.execPath, ['-e', childScript, mode], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${path.dirname(fakeGit)}:${process.env.PATH || ''}`,
      CLAUDEVILLE_GIT_WORKER_CONCURRENCY: '2',
      CLAUDEVILLE_GIT_WORKER_QUEUE_DEPTH: '3',
      CLAUDEVILLE_GIT_WORKER_TIMEOUT_MS: mode === 'timeout' ? '50' : mode === 'stale' ? '250' : '1000',
      CLAUDEVILLE_GIT_WORKER_RETRY_BASE_MS: '5000',
      FAKE_GIT_MODE: 'good',
    },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test('the worker coalesces duplicate repositories and sheds beyond its bounded queue', () => {
  const fakeDirectory = makeTempDir('git-worker-queue');
  const fakeGit = writeFakeGit(fakeDirectory);
  const coalesced = runWorkerChild('coalesce', { fakeGit });
  assert.equal(coalesced.phase, 'coalesced');
  assert.equal(coalesced.stats.queueDepth, 0);
  assert.equal(coalesced.stats.activeJobs, 1);
  assert.ok(coalesced.stats.coalescedRequests >= 7);

  const queued = runWorkerChild('queue', { fakeGit, projectCount: 20 });
  assert.equal(queued.phase, 'settled');
  assert.ok(queued.stats.maxQueueDepthObserved <= queued.stats.maxQueueDepth);
  assert.ok(queued.stats.shedCount > 0);
  assert.equal(queued.stats.queueDepth, 0);
  assert.equal(queued.stats.activeJobs, 0);
});

test('a timed-out Git child releases the worker slot and records the timeout', () => {
  const fakeDirectory = makeTempDir('git-worker-timeout');
  const fakeGit = writeFakeGit(fakeDirectory);
  const result = runWorkerChild('timeout', { fakeGit });
  assert.equal(result.phase, 'timeout');
  assert.equal(result.stats.worker.activeJobs, 0);
  assert.equal(result.stats.worker.activeSubprocesses, 0);
  assert.ok(result.stats.gitCommandTimeouts >= 1);
  assert.ok(result.stats.worker.failures >= 1);
});

test('a failed refresh serves the last-good snapshot without breaking enrichment', () => {
  const fakeDirectory = makeTempDir('git-worker-stale');
  const fakeGit = writeFakeGit(fakeDirectory);
  const result = runWorkerChild('stale', { fakeGit });
  assert.equal(result.phase, 'stale');
  assert.equal(result.immediate.warmEvents, 1);
  assert.equal(result.immediate.staleEvents, 1);
  assert.ok(result.stats.worker.failures >= 1);
  assert.equal(result.stats.worker.queueDepth, 0);
});

test('the exported worker limits are visible in Git enrichment diagnostics', () => {
  const git = require(GIT_EVENTS_PATH);
  const worker = git.getGitWorkerPerfStats();
  assert.equal(worker.maxConcurrency, 2);
  assert.equal(worker.maxQueueDepth, 32);
  assert.equal(worker.timeoutMs, 750);
});
