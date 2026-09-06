import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from '../tests/support/tmp.mjs';

const tmpRoot = makeTempDir('claudeville-watch-');
const previousHome = process.env.HOME;
process.env.HOME = tmpRoot;
process.env.CLAUDEVILLE_WATCH_ZERO_CLIENT_GRACE_MS = '50';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const now = Date.now();
const project = path.join(tmpRoot, 'work', 'demo');
fs.mkdirSync(project, { recursive: true });

writeJson(path.join(tmpRoot, '.claude', 'history.jsonl'), {
  sessionId: 'claude-fixture',
  project,
  timestamp: now,
  display: 'fixture',
});
touch(
  path.join(tmpRoot, '.claude', 'projects', project.replace(/\//g, '-'), 'claude-fixture.jsonl'),
  `${JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { model: 'fixture', content: [] } })}\n`,
);
fs.mkdirSync(path.join(tmpRoot, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, '.claude', 'teams'), { recursive: true });

touch(
  path.join(tmpRoot, '.codex', 'sessions', '2026', '07', '14', 'rollout-2026-07-14T00-00-00-fixture.jsonl'),
  `${JSON.stringify({ type: 'session_meta', payload: { id: 'fixture', cwd: project } })}\n`,
);
touch(path.join(tmpRoot, '.codex', 'session_index.jsonl'));

writeJson(path.join(tmpRoot, '.gemini', 'tmp', 'fixture-hash', 'chats', 'session-fixture.json'), {
  sessionId: 'fixture',
  messages: [],
});

writeJson(path.join(tmpRoot, '.grok', 'sessions', 'fixture-project', 'fixture', 'summary.json'), {
  info: { id: 'fixture', cwd: project },
  updated_at: new Date(now).toISOString(),
  current_model_id: 'fixture',
});
touch(path.join(tmpRoot, '.grok', 'sessions', 'fixture-project', 'fixture', 'updates.jsonl'));

writeJson(path.join(tmpRoot, '.kimi', 'kimi.json'), { work_dirs: [{ path: project }] });
const kimiProjectHash = crypto.createHash('md5').update(project).digest('hex');
touch(
  path.join(tmpRoot, '.kimi', 'sessions', kimiProjectHash, 'fixture', 'wire.jsonl'),
  `${JSON.stringify({ timestamp: now / 1000, message: { type: 'ContentPart', payload: { type: 'text', text: 'fixture' } } })}\n`,
);
touch(path.join(tmpRoot, '.local', 'share', 'opencode', 'opencode.db'));
fs.mkdirSync(path.join(tmpRoot, '.config', 'opencode', 'agents'), { recursive: true });

const require = createRequire(import.meta.url);
const { adapters, getAllWatchPaths } = require('../../claudeville/adapters');
const { shutdownRuntime, _watcherTest } = require('../../claudeville/server');

function hasWatchResourceExhaustion(snapshot) {
  return (snapshot?.recentFailures || []).some((failure) => (
    /\b(?:EMFILE|ENFILE|ENOSPC)\b/.test(String(failure?.message || ''))
  ));
}

try {
  const sessions = [];
  for (const adapter of adapters) {
    if (adapter.provider === 'opencode') continue;
    sessions.push(...adapter.getActiveSessions(10 * 60 * 1000));
  }

  const descriptors = getAllWatchPaths({ sessions, activeThresholdMs: 10 * 60 * 1000 });
  assert.ok(descriptors.length > 0, 'adapter registry should return watch descriptors');
  assert.ok(descriptors.every((descriptor) => descriptor.recursive !== true), 'recursive descriptors are forbidden');

  for (const adapter of adapters) {
    const providerSessions = sessions.filter((session) => session.provider === adapter.provider);
    const providerDescriptors = adapter.getWatchPaths({ sessions: providerSessions });
    assert.ok(providerDescriptors.some((descriptor) => descriptor.scope === 'discovery'), `${adapter.provider} needs a discovery descriptor`);
    assert.ok(providerDescriptors.every((descriptor) => descriptor.recursive !== true), `${adapter.provider} requested recursion`);
    if (providerSessions.length > 0) {
      assert.ok(
        providerDescriptors.some((descriptor) => descriptor.scope === 'active' && descriptor.probe),
        `${adapter.provider} needs a probed active descriptor`,
      );
    }
  }

  const duplicateRoot = path.join(tmpRoot, 'duplicates');
  fs.mkdirSync(duplicateRoot);
  const canonical = _watcherTest.canonicalizeWatchDescriptors([
    { type: 'directory', path: duplicateRoot, provider: 'grok', filter: '.jsonl', scope: 'active' },
    { type: 'directory', path: duplicateRoot, provider: 'grok', filter: 'summary.json', scope: 'active' },
    { type: 'directory', path: `${duplicateRoot}${path.sep}.`, provider: 'kimi', filter: '.json', scope: 'discovery' },
  ]);
  assert.equal(canonical.length, 1, 'duplicate canonical roots should share one watcher');
  assert.deepEqual(canonical[0].filters, ['.json', '.jsonl', 'summary.json']);
  assert.deepEqual(canonical[0].providers, ['grok', 'kimi']);
  assert.equal(canonical[0].dynamic, false, 'a stable use keeps a merged root installed');
  assert.equal(
    _watcherTest.canonicalizeWatchDescriptors(canonical)[0].dynamic,
    false,
    'canonical descriptors must remain stable when refreshed after client retirement',
  );

  const dynamicFixtures = Array.from({ length: _watcherTest.constants.WATCH_DYNAMIC_CAP + 25 }, (_, index) => ({
    type: 'file',
    path: path.join(tmpRoot, `dynamic-${index}.jsonl`),
    provider: 'fixture',
    scope: 'active',
    activity: index,
    probe: true,
  }));
  const canonicalDynamic = _watcherTest.canonicalizeWatchDescriptors(dynamicFixtures);
  const selected = _watcherTest.selectWatchDescriptors(
    canonicalDynamic,
    { includeDynamic: true },
  );
  assert.equal(selected.dynamic.length, _watcherTest.constants.WATCH_DYNAMIC_CAP, 'dynamic watcher cap must be enforced');
  assert.equal(selected.dynamic[0].activity, dynamicFixtures.length - 1, 'newest active sources should win the cap');
  const probes = _watcherTest.selectProbeDescriptors(canonicalDynamic, { includeDynamic: true });
  assert.ok(probes.length > selected.dynamic.length, 'capped-out active sources should fall back to stat probes');
  assert.ok(probes.length <= _watcherTest.constants.WATCH_ACTIVE_PROBE_CAP, 'stat probes must remain capped');

  const fallbackRoot = path.join(tmpRoot, 'fallback');
  for (let index = 0; index < 12; index++) touch(path.join(fallbackRoot, `${index}.jsonl`), String(index));
  const fallback = _watcherTest.getWatchFallbackSignature({
    type: 'directory',
    path: fallbackRoot,
    filters: ['.jsonl'],
    recursive: true,
  }, 5);
  assert.equal(fallback.entriesScanned, 5, 'fallback must account for traversed entries');
  assert.equal(fallback.truncated, true, 'fallback must report an exhausted shared budget');

  const spritePath = path.join(process.cwd(), 'claudeville', 'assets', 'sprites', 'fixture.png');
  const jsPath = path.join(process.cwd(), 'claudeville', 'src', 'fixture.js');
  const fontPath = path.join(process.cwd(), 'claudeville', 'assets', 'fonts', 'fixture.woff2');
  assert.match(_watcherTest.cacheControlFor(new URL('http://localhost/a?v=1'), spritePath), /immutable/);
  assert.equal(_watcherTest.cacheControlFor(new URL('http://localhost/a'), spritePath), 'no-cache');
  assert.equal(_watcherTest.cacheControlFor(new URL('http://localhost/a?v=1'), jsPath), 'no-cache');
  assert.match(_watcherTest.cacheControlFor(new URL('http://localhost/a?v=1'), fontPath), /immutable/);

  _watcherTest.refreshWatchPaths(descriptors);
  const beforeFirstClient = _watcherTest.watcherTopologySnapshot();
  const degradedWatchers = beforeFirstClient.stableInstalled === 0;
  assert.equal(beforeFirstClient.dynamicInstalled, 0);
  if (degradedWatchers) {
    assert.ok(hasWatchResourceExhaustion(beforeFirstClient));
    assert.ok(beforeFirstClient.fallbacks > 0);
  }
  _watcherTest.onFirstWebSocketClient();
  const afterFirstClient = _watcherTest.watcherTopologySnapshot();
  assert.equal(afterFirstClient.dynamicEnabled, true);
  if (degradedWatchers) {
    assert.ok(hasWatchResourceExhaustion(afterFirstClient));
    assert.ok(afterFirstClient.probes > 0);
  } else {
    assert.ok(afterFirstClient.dynamicInstalled > 0);
  }
  _watcherTest.onLastWebSocketClient();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const retired = _watcherTest.watcherTopologySnapshot();
  assert.equal(retired.dynamicEnabled, false);
  assert.equal(retired.dynamicInstalled, 0);
  if (degradedWatchers) {
    assert.ok(hasWatchResourceExhaustion(retired));
    assert.ok(retired.fallbacks > 0);
  } else {
    assert.ok(retired.stableInstalled > 0);
  }

  console.log(
    `watcher topology smoke passed${degradedWatchers ? ' (degraded: inotify resources exhausted)' : ''} `
    + `(${descriptors.length} raw descriptors, ${sessions.length} fixture sessions)`,
  );
} finally {
  shutdownRuntime({ reason: 'watcher topology smoke', exitProcess: false });
  process.env.HOME = previousHome;
  delete process.env.CLAUDEVILLE_WATCH_ZERO_CLIENT_GRACE_MS;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
