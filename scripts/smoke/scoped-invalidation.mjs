import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeTempDir } from '../tests/support/tmp.mjs';

const tmpHome = makeTempDir('claudeville-invalidation-');
const require = createRequire(import.meta.url);
const previousHome = process.env.HOME;
const previousDisableGit = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;

process.env.HOME = tmpHome;
delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;

function makeRepository(name) {
  const project = path.join(tmpHome, name);
  fs.mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  return project;
}

function syntheticCommit(project) {
  return {
    id: `fixture-${path.basename(project)}`,
    type: 'commit',
    project,
    provider: 'fixture',
    sessionId: 'fixture',
    success: true,
    branch: 'main',
    ts: Date.now(),
    completedAt: Date.now(),
  };
}

try {
  const projectA = makeRepository('project-a');
  const projectB = makeRepository('project-b');
  const openCodeState = path.join(tmpHome, '.local', 'share', 'opencode');
  fs.mkdirSync(openCodeState, { recursive: true });
  for (const fileName of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
    fs.writeFileSync(path.join(openCodeState, fileName), 'fixture');
  }
  const gitEvents = require('../../claudeville/adapters/gitEvents.js');
  gitEvents.inferPushedGitEvents([syntheticCommit(projectA)]);
  gitEvents.inferPushedGitEvents([syntheticCommit(projectB)]);
  const initialGitStats = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(initialGitStats.statusCacheSize, 2, 'fixture should populate two project status entries');
  const session = {
    sessionId: 'fixture-session',
    provider: 'fixture',
    project: projectA,
    gitEvents: [],
  };
  gitEvents.inferUnpushedGitEventsForSessions([session]);
  const afterFirstUnpushed = gitEvents.getGitEnrichmentPerfStats();
  gitEvents.inferUnpushedGitEventsForSessions([session]);
  const afterSecondUnpushed = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(
    afterSecondUnpushed.gitCommandCount,
    afterFirstUnpushed.gitCommandCount,
    'unchanged unpushed enrichment should reuse its project cache',
  );
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 60_000;
  try {
    gitEvents.inferUnpushedGitEventsForSessions([session]);
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(
    gitEvents.getGitEnrichmentPerfStats().gitCommandCount,
    afterFirstUnpushed.gitCommandCount,
    'an unchanged 60-second window must not launch a periodic Git subprocess burst',
  );
  assert.equal(afterSecondUnpushed.statusCacheSize, 2, 'unpushed events need a distinct cache key space');
  assert.equal(afterSecondUnpushed.unpushedEventCacheSize, 1, 'fixture should retain one bounded unpushed entry');

  execFileSync('git', ['config', 'user.email', 'fixture@claudeville.local'], { cwd: projectA });
  execFileSync('git', ['config', 'user.name', 'ClaudeVille Fixture'], { cwd: projectA });
  fs.writeFileSync(path.join(projectA, 'commit.txt'), 'base fixture\n');
  execFileSync('git', ['add', 'commit.txt'], { cwd: projectA });
  execFileSync('git', ['commit', '-q', '-m', 'fixture base'], { cwd: projectA });
  execFileSync('git', ['branch', 'master'], { cwd: projectA });
  gitEvents.inferUnpushedGitEventsForSessions([session]);
  const afterBase = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(
    afterBase.headInvalidations,
    afterSecondUnpushed.headInvalidations + 1,
    'the first commit must invalidate the project cache without waiting for its TTL',
  );

  fs.writeFileSync(path.join(projectA, 'commit.txt'), 'new commit fixture\n');
  execFileSync('git', ['add', 'commit.txt'], { cwd: projectA });
  execFileSync('git', ['commit', '-q', '-m', 'fixture commit'], { cwd: projectA });
  const afterCommitSessions = gitEvents.inferUnpushedGitEventsForSessions([session]);
  const afterCommit = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(
    afterCommit.headInvalidations,
    afterBase.headInvalidations + 1,
    'a new commit must invalidate the project cache without waiting for its TTL',
  );
  assert.ok(afterCommit.gitCommandCount > afterBase.gitCommandCount);
  assert.ok(
    afterCommitSessions[0].gitEvents.some(event => event.label === 'fixture commit'),
    'the next enrichment pass must expose the new commit',
  );

  gitEvents.invalidateGitStatusCaches({ project: projectA });
  const pathBeforeGitFailure = process.env.PATH;
  process.env.PATH = path.join(tmpHome, 'missing-bin');
  try {
    gitEvents.inferUnpushedGitEventsForSessions([session]);
  } finally {
    process.env.PATH = pathBeforeGitFailure;
  }
  assert.equal(
    gitEvents.getGitEnrichmentPerfStats().unpushedEventCacheSize,
    0,
    'a failed Git scan must not cache an authoritative empty result',
  );
  const recoveredSessions = gitEvents.inferUnpushedGitEventsForSessions([session]);
  assert.ok(
    recoveredSessions[0].gitEvents.some(event => event.label === 'fixture commit'),
    'Git enrichment must retry and recover immediately after a transient failure',
  );
  gitEvents.inferPushedGitEvents([syntheticCommit(projectA)]);
  assert.equal(
    gitEvents.getGitEnrichmentPerfStats().statusCacheSize,
    2,
    'the pushed-status fixture should restore both project cache entries',
  );

  const registry = require('../../claudeville/adapters/index.js');
  const claude = registry.adapters.find((adapter) => adapter.provider === 'claude');
  const grok = registry.adapters.find((adapter) => adapter.provider === 'grok');
  const openCode = registry.adapters.find((adapter) => adapter.provider === 'opencode');
  const openCodeWatchPaths = openCode.getWatchPaths();
  assert.ok(openCodeWatchPaths.some(entry => entry.path.endsWith('opencode.db')));
  assert.ok(openCodeWatchPaths.some(entry => entry.path.endsWith('opencode.db-wal')));
  assert.equal(
    openCodeWatchPaths.some(entry => entry.path.endsWith('-shm') || entry.filters?.includes('.db-shm')),
    false,
    'reader-mutated SQLite shared memory must not be watched',
  );
  const originalClaudeScoped = claude.invalidateCachesForDirty;
  const originalGrokFull = grok.invalidateCaches;
  const claudeDirtyCalls = [];
  let grokFullInvalidations = 0;
  claude.invalidateCachesForDirty = (dirty) => {
    claudeDirtyCalls.push(dirty);
    return originalClaudeScoped.call(claude, dirty);
  };
  grok.invalidateCaches = () => {
    grokFullInvalidations++;
    return originalGrokFull.call(grok);
  };

  try {
    const transcriptPath = path.join(tmpHome, '.claude', 'projects', 'fixture.jsonl');
    registry.invalidateSessionCaches({
      dirty: {
        provider: 'claude',
        path: transcriptPath,
        kind: 'transcript',
        reason: 'append',
        sessionId: 'fixture-session',
        project: projectA,
      },
    });
    assert.equal(claudeDirtyCalls.length, 1);
    assert.equal(claudeDirtyCalls[0].kind, 'transcript');
    assert.equal(claudeDirtyCalls[0].sessionId, 'fixture-session');
    assert.equal(grokFullInvalidations, 0, 'unrelated adapter cache must survive provider append');
    assert.equal(
      gitEvents.getGitEnrichmentPerfStats().statusCacheSize,
      2,
      'provider append must not invalidate Git status caches',
    );
    assert.equal(
      gitEvents.getGitEnrichmentPerfStats().unpushedEventCacheSize,
      1,
      'provider append must not invalidate unpushed Git events',
    );

    registry.invalidateSessionCaches({
      dirty: {
        provider: null,
        path: projectA,
        kind: 'git',
        reason: 'git-state',
        project: projectA,
      },
    });
    assert.equal(
      gitEvents.getGitEnrichmentPerfStats().statusCacheSize,
      1,
      'Git invalidation should remove all cache entries for only the named project',
    );
    assert.equal(
      gitEvents.getGitEnrichmentPerfStats().unpushedEventCacheSize,
      0,
      'Git invalidation should remove the named project unpushed-event entry',
    );
    assert.equal(grokFullInvalidations, 0, 'Git invalidation must not flush provider adapters');

    registry.invalidateSessionCaches({
      dirty: {
        provider: 'grok',
        path: path.join(tmpHome, '.grok', 'sessions'),
        kind: 'discovery',
        reason: 'new-session',
      },
    });
    assert.equal(grokFullInvalidations, 1, 'provider discovery should retain legacy full invalidation');
  } finally {
    claude.invalidateCachesForDirty = originalClaudeScoped;
    grok.invalidateCaches = originalGrokFull;
  }

  const remoteProject = makeRepository('nested-remote-ref');
  execFileSync('git', ['config', 'user.email', 'fixture@claudeville.local'], { cwd: remoteProject });
  execFileSync('git', ['config', 'user.name', 'ClaudeVille Fixture'], { cwd: remoteProject });
  fs.writeFileSync(path.join(remoteProject, 'remote.txt'), 'base\n');
  execFileSync('git', ['add', 'remote.txt'], { cwd: remoteProject });
  execFileSync('git', ['commit', '-q', '-m', 'remote base'], { cwd: remoteProject });
  const remoteBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteProject, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(remoteProject, 'remote.txt'), 'second\n');
  execFileSync('git', ['add', 'remote.txt'], { cwd: remoteProject });
  execFileSync('git', ['commit', '-q', '-m', 'remote second'], { cwd: remoteProject });
  const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteProject, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteBase], { cwd: remoteProject });
  const remoteSession = {
    sessionId: 'nested-remote-ref-session',
    provider: 'fixture',
    project: remoteProject,
    gitEvents: [],
  };
  const beforeRemoteAdvance = gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  assert.ok(
    beforeRemoteAdvance[0].gitEvents.some(event => event.label === 'remote second'),
    'fixture must begin with one commit ahead of the nested remote ref',
  );
  const beforeRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', remoteHead], { cwd: remoteProject });
  const afterRemoteAdvance = gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  const afterRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  assert.equal(
    afterRemoteStats.headInvalidations,
    beforeRemoteStats.headInvalidations + 1,
    'a nested loose remote-ref update must invalidate Git enrichment without watcher help',
  );
  assert.ok(afterRemoteStats.gitCommandCount > beforeRemoteStats.gitCommandCount);
  assert.equal(
    afterRemoteAdvance[0].gitEvents.some(event => event.type === 'commit' && event.label === 'remote second'),
    false,
    'the refreshed enrichment must not retain a commit now contained by the remote ref',
  );
  const bulkRemoteDir = path.join(remoteProject, '.git', 'refs', 'remotes', 'bulk');
  fs.mkdirSync(bulkRemoteDir, { recursive: true });
  for (let index = 0; index < 900; index++) {
    fs.writeFileSync(
      path.join(bulkRemoteDir, `ref-${String(index).padStart(4, '0')}`),
      `${remoteHead}\n`,
    );
  }
  const beforeBoundedRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  gitEvents.inferUnpushedGitEventsForSessions([remoteSession]);
  const afterBoundedRemoteStats = gitEvents.getGitEnrichmentPerfStats();
  assert.ok(
    afterBoundedRemoteStats.remoteRefScanTruncations
      > beforeBoundedRemoteStats.remoteRefScanTruncations,
    'large loose remote-ref trees must stop at the traversal budget',
  );
  assert.ok(
    afterBoundedRemoteStats.remoteRefScanHighWater
      <= afterBoundedRemoteStats.remoteRefScanEntryLimit,
    'loose remote-ref traversal exceeded its entry budget',
  );

  const { shutdownRuntime, _watcherTest } = require('../../claudeville/server.js');
  const watchRoot = path.join(tmpHome, 'watch-root');
  fs.mkdirSync(watchRoot);
  const canonical = _watcherTest.canonicalizeWatchDescriptors([
    {
      type: 'directory',
      path: watchRoot,
      provider: 'claude',
      scope: 'active',
      kind: 'transcript',
      sessionId: 'fixture-session',
      project: projectA,
      filter: '.jsonl',
    },
  ]);
  assert.equal(canonical.length, 1);
  assert.deepEqual(canonical[0].kinds, ['transcript']);
  assert.deepEqual(canonical[0].sessionIds, ['fixture-session']);
  assert.deepEqual(canonical[0].projects, [projectA]);
  const dirty = _watcherTest.dirtyDescriptorForWatch(canonical[0], 'directory:watch-root', 'child.jsonl');
  assert.deepEqual(dirty, {
    provider: 'claude',
    path: path.join(watchRoot, 'child.jsonl'),
    kind: 'transcript',
    reason: 'directory:watch-root',
    sessionId: 'fixture-session',
    project: projectA,
  });
  shutdownRuntime({ reason: 'scoped invalidation smoke', exitProcess: false });

  console.log('scoped invalidation smoke passed (provider append, project Git scope, nested remote refs, watcher metadata)');
} finally {
  process.env.HOME = previousHome;
  if (previousDisableGit === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = previousDisableGit;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
