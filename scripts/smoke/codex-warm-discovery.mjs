import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../tests/support/tmp.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000;
const FILE_CAP = 3_200;
const INACTIVE_FILE_COUNT = 3_000;
const CAP_CHURN_FILE_COUNT = 260;
const NOW = Date.now();
const OLD_MTIME = new Date(NOW - 7 * 24 * 60 * 60 * 1000);
const OLDER_MTIME = new Date(NOW - 14 * 24 * 60 * 60 * 1000);
const tmpRoot = makeTempDir('claudeville-codex-warm-');
const sessionsDir = path.join(tmpRoot, '.codex', 'sessions');
const activeDayDir = path.join(sessionsDir, '9999', '12', '31');
const historicalDayDir = path.join(sessionsDir, '9998', '01', '01');
const corpusDayDir = path.join(sessionsDir, '9997', '01', '01');
let directoryClock = NOW + 10_000;

function rolloutPath(dayDir, id) {
  return path.join(dayDir, `rollout-${id}.jsonl`);
}

function writeRollout(dayDir, id, mtime, project = `/fixture/${id}`) {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = rolloutPath(dayDir, id);
  const record = {
    timestamp: new Date(mtime.getTime()).toISOString(),
    type: 'session_meta',
    payload: { id: `thread-${id}`, cwd: project, model: 'gpt-5' },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

function writeInactiveRollout(dayDir, id, mtime) {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = rolloutPath(dayDir, id);
  fs.writeFileSync(filePath, '');
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

function bumpDirectory(dayDir) {
  directoryClock += 5_000;
  const mtime = new Date(directoryClock);
  fs.utimesSync(dayDir, mtime, mtime);
}

function hasSession(sessions, id) {
  return sessions.some(session => session.sessionId === `codex-${id}`);
}

try {
  process.env.HOME = tmpRoot;
  delete process.env.USERPROFILE;
  process.env.CLAUDEVILLE_CODEX_ROLLOUT_FILE_CAP = String(FILE_CAP);

  const activePath = writeRollout(activeDayDir, 'active', new Date(NOW - 1_000));
  const historicalPath = writeRollout(historicalDayDir, 'historical', OLD_MTIME);
  for (let index = 0; index < INACTIVE_FILE_COUNT; index++) {
    writeInactiveRollout(corpusDayDir, `inactive-${String(index).padStart(4, '0')}`, OLD_MTIME);
  }

  const require = createRequire(import.meta.url);
  const { CodexAdapter } = require(path.join(REPO_ROOT, 'claudeville/adapters/codex.js'));
  const adapter = new CodexAdapter();

  const initialSessions = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  const initialStats = adapter.getPerfStats().rolloutDiscovery;
  assert.equal(initialStats.mode, 'reconcile');
  assert.equal(initialStats.rolloutFilesScanned, INACTIVE_FILE_COUNT + 2);
  assert.equal(initialStats.cachedFiles, INACTIVE_FILE_COUNT + 2);
  assert.equal(hasSession(initialSessions, 'active'), true);
  assert.equal(hasSession(initialSessions, 'historical'), false);

  const warmSessions = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  const warmStats = adapter.getPerfStats().rolloutDiscovery;
  assert.equal(warmStats.mode, 'warm');
  assert.equal(warmStats.rolloutFilesScanned, 0);
  assert.equal(warmStats.cachedFileStats, 1, 'warm pass should stat only the active rollout');
  assert.equal(hasSession(warmSessions, 'active'), true);

  for (let index = 0; index < CAP_CHURN_FILE_COUNT; index++) {
    writeInactiveRollout(activeDayDir, `churn-${String(index).padStart(4, '0')}`, OLDER_MTIME);
  }
  bumpDirectory(activeDayDir);

  adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  const evictionStats = adapter.getPerfStats().rolloutDiscovery;
  assert.equal(evictionStats.cachedFiles, FILE_CAP, 'historical cache must retain its cap');
  assert.equal(evictionStats.rolloutFilesScanned, CAP_CHURN_FILE_COUNT + 1);

  adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  const postEvictionWarmStats = adapter.getPerfStats().rolloutDiscovery;
  assert.equal(postEvictionWarmStats.rolloutFilesScanned, 0, 'cap eviction must not invalidate stable day signatures');
  assert.equal(postEvictionWarmStats.cachedFileStats, 1);

  writeRollout(activeDayDir, 'new-session', new Date());
  bumpDirectory(activeDayDir);
  const withNewSession = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  assert.equal(hasSession(withNewSession, 'active'), true);
  assert.equal(hasSession(withNewSession, 'new-session'), true, 'new rollout should be visible on the next warm pass');

  fs.renameSync(rolloutPath(activeDayDir, 'new-session'), path.join(activeDayDir, 'new-session.rotated'));
  writeRollout(activeDayDir, 'rotated-session', new Date());
  bumpDirectory(activeDayDir);
  const withRotation = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  assert.equal(hasSession(withRotation, 'new-session'), false);
  assert.equal(hasSession(withRotation, 'rotated-session'), true, 'replacement rollout should survive rotation');
  assert.equal(fs.existsSync(activePath), true);

  fs.appendFileSync(historicalPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started' } })}\n`);
  const reactivatedAt = new Date();
  fs.utimesSync(historicalPath, reactivatedAt, reactivatedAt);

  const beforeReconcile = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  assert.equal(hasSession(beforeReconcile, 'historical'), false, 'ordinary warm pass should not stat inactive history');
  assert.ok(adapter.getPerfStats().rolloutDiscovery.cachedFileStats <= 2);

  adapter.invalidateCachesForDirty({ kind: 'reconcile', reason: 'smoke-reconciliation' });
  const afterReconcile = adapter.getActiveSessions(ACTIVE_THRESHOLD_MS);
  const reconcileStats = adapter.getPerfStats().rolloutDiscovery;
  assert.equal(reconcileStats.mode, 'reconcile');
  assert.equal(reconcileStats.capped, true);
  assert.equal(reconcileStats.rolloutFilesScanned, FILE_CAP);
  assert.equal(hasSession(afterReconcile, 'historical'), true, 'bounded reconciliation should rediscover reactivated history');

  console.log(
    `codex warm discovery smoke passed (${initialStats.cachedFiles} cached, `
    + `${warmStats.cachedFileStats} warm stat, cap ${FILE_CAP})`,
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
