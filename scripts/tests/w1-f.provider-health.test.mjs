import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000;

function writeTranscript(filePath, { malformedMiddle = false, trailingPartial = false } = {}) {
  const now = new Date().toISOString();
  const sessionId = '01900000-0000-7000-8000-000000000099';
  const records = [
    JSON.stringify({ type: 'title', title: 'Provider health fixture', updatedAt: now }),
    ...(malformedMiddle ? ['{"type":"broken"'] : []),
    JSON.stringify({ type: 'session', id: sessionId, timestamp: now, cwd: '/fixture/project' }),
    JSON.stringify({
      type: 'message',
      id: 'assistant-health',
      timestamp: now,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture ready.' }] },
    }),
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.join('\n')}\n${trailingPartial ? '{"type":"message"' : ''}`);
}

function healthFor(registry, provider) {
  return registry.getProviderHealth().find((record) => record.id === provider);
}

test('provider health records distinguish absence, emptiness, parser damage, and failures', async (t) => {
  const tmpHome = makeTempDir('claudeville-provider-health-');
  const previousHome = process.env.HOME;
  const previousGitSetting = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  process.env.HOME = tmpHome;
  process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';

  const registry = require(path.join(REPO_ROOT, 'claudeville/adapters/index.js'));
  const omp = registry.adapters.find((adapter) => adapter.provider === 'omp');
  const claude = registry.adapters.find((adapter) => adapter.provider === 'claude');
  const sessionsDir = path.join(tmpHome, '.omp', 'agent', 'sessions');
  const transcriptPath = path.join(sessionsDir, 'fixture-project', 'health.jsonl');

  try {
    await t.test('a missing provider directory is unavailable', () => {
      registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
      assert.deepEqual(healthFor(registry, 'omp').health, 'unavailable');
      assert.equal(healthFor(registry, 'omp').sessions, 0);
    });

    await t.test('an installed empty provider is empty, not degraded', () => {
      fs.mkdirSync(sessionsDir, { recursive: true });
      registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
      assert.equal(healthFor(registry, 'omp').health, 'empty');
      assert.equal(healthFor(registry, 'omp').sessions, 0);
    });

    await t.test('a valid transcript is healthy and reports its session count', () => {
      writeTranscript(transcriptPath);
      const sessions = registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
      assert.equal(sessions.filter((session) => session.provider === 'omp').length, 1);
      assert.equal(healthFor(registry, 'omp').health, 'healthy');
      assert.equal(healthFor(registry, 'omp').sessions, 1);
      assert.ok(healthFor(registry, 'omp').lastSuccessAt > 0);
    });

    await t.test('a malformed middle JSONL line reports skipped lines without claiming a read failure', () => {
      writeTranscript(transcriptPath, { malformedMiddle: true });
      registry.invalidateSessionCaches({ provider: 'omp' });
      registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
      assert.equal(healthFor(registry, 'omp').health, 'healthy');
      assert.ok(healthFor(registry, 'omp').skippedLines > 0);
      assert.equal(healthFor(registry, 'omp').errorCode, null);
    });

    await t.test('a trailing partial JSONL line remains healthy', () => {
      writeTranscript(transcriptPath, { trailingPartial: true });
      registry.invalidateSessionCaches({ provider: 'omp' });
      registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
      assert.equal(healthFor(registry, 'omp').health, 'healthy');
      assert.equal(healthFor(registry, 'omp').sessions, 1);
      assert.equal(healthFor(registry, 'omp').errorCode, null);
    });

    await t.test('one failed adapter does not erase healthy sessions from the aggregate', () => {
      const originalIsAvailable = claude.isAvailable;
      const originalGetActiveSessions = claude.getActiveSessions;
      claude.isAvailable = () => true;
      claude.getActiveSessions = () => {
        const error = new Error('fixture read failure');
        error.code = 'EACCES';
        throw error;
      };
      try {
        const sessions = registry.getAllSessions(ACTIVE_THRESHOLD_MS, { force: true });
        assert.equal(sessions.filter((session) => session.provider === 'omp').length, 1);
        assert.equal(healthFor(registry, 'omp').health, 'healthy');
        assert.equal(healthFor(registry, 'claude').health, 'degraded');
        assert.equal(healthFor(registry, 'claude').errorCode, 'EACCES');
      } finally {
        claude.isAvailable = originalIsAvailable;
        claude.getActiveSessions = originalGetActiveSessions;
      }
    });

    await t.test('a watch-path error degrades only the failing provider', () => {
      const originalGetWatchPaths = omp.getWatchPaths;
      omp.getWatchPaths = () => {
        throw new Error('fixture watch failure');
      };
      try {
        registry.getAllWatchPaths({ sessions: [], activeThresholdMs: ACTIVE_THRESHOLD_MS });
        assert.equal(healthFor(registry, 'omp').health, 'degraded');
        assert.equal(healthFor(registry, 'omp').watchState, 'failed');
        assert.equal(healthFor(registry, 'omp').errorCode, 'ADAPTER_WATCH_FAILED');
      } finally {
        omp.getWatchPaths = originalGetWatchPaths;
      }
    });

    await t.test('the isolated route serializer exposes bounded health data without path strings', () => {
      // The HTTP listener is intentionally not started here. The route delegates to
      // this serializer, so the public contract and path-leak guard stay pure.
      const { _providerHealthTest } = require(path.join(REPO_ROOT, 'claudeville/server.js'));
      const payload = _providerHealthTest.buildProvidersPayload();
      assert.ok(Array.isArray(payload.providers));
      assert.equal(payload.count, payload.providers.length);
      assert.ok(Array.isArray(payload.health));
      assert.deepEqual(Object.keys(payload.health[0]), [
        'id',
        'name',
        'health',
        'sessions',
        'lastScanStartedAt',
        'lastSuccessAt',
        'errorCode',
        'watchState',
        'skippedLines',
      ]);
      for (const summary of payload.health) {
        for (const [key, value] of Object.entries(summary)) {
          if (key === 'id' || key === 'name' || typeof value !== 'string') continue;
          assert.equal(value.includes('/'), false, `${summary.id}.${key} must not contain a path`);
        }
      }

      const [sanitized] = _providerHealthTest.serializeProviderHealth([{
        id: 'allowed/id',
        name: 'Allowed/Name',
        health: 'degraded',
        errorCode: '/private/tmp/provider failure',
        watchState: '/private/tmp/watch',
      }]);
      assert.equal(sanitized.errorCode.includes('/'), false);
      assert.equal(sanitized.watchState, 'unavailable');
    });
  } finally {
    for (const adapter of registry.adapters) adapter.shutdown?.();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousGitSetting === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
    else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = previousGitSetting;
  }
});
