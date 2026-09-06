#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from '../tests/support/tmp.mjs';

const require = createRequire(import.meta.url);
const tmpHome = makeTempDir('claudeville-usage-history-');
const claudeHome = path.join(tmpHome, '.claude');
const historyPath = path.join(claudeHome, 'history.jsonl');
const previousHome = process.env.HOME;
const originalReadFileSync = fs.readFileSync;
const originalReadSync = fs.readSync;

try {
  process.env.HOME = tmpHome;
  fs.mkdirSync(claudeHome, { recursive: true });
  const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const oldLine = `${JSON.stringify({ timestamp: oldTimestamp, sessionId: 'old', display: 'x'.repeat(80) })}\n`;
  const oldPrefix = oldLine.repeat(Math.ceil((20 * 1024 * 1024) / Buffer.byteLength(oldLine)));
  const liveLine = `${JSON.stringify({ timestamp: Date.now(), sessionId: 'current', display: 'x'.repeat(80) })}\n`;
  const liveCount = Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(liveLine));
  fs.writeFileSync(historyPath, oldPrefix + liveLine.repeat(liveCount));

  let historyReadFileCalls = 0;
  let bytesRead = 0;
  let maxRead = 0;
  fs.readFileSync = function readFileSync(filePath, ...args) {
    if (path.resolve(String(filePath)) === historyPath) historyReadFileCalls++;
    return originalReadFileSync.call(this, filePath, ...args);
  };
  fs.readSync = function readSync(fd, buffer, offset, length, position) {
    bytesRead += length;
    maxRead = Math.max(maxRead, length);
    return originalReadSync.call(this, fd, buffer, offset, length, position);
  };

  const usageQuota = require('../../claudeville/services/usageQuota.js');
  const usage = usageQuota.fetchUsage();
  assert.equal(usage.activity.today.messages, liveCount);
  assert.equal(usage.activity.today.sessions, 1);
  assert.equal(usage.activity.thisWeek.messages, liveCount);
  assert.equal(usage.activity.thisWeek.sessions, 1);
  assert.equal(historyReadFileCalls, 0, 'history must not fall back to readFileSync');
  assert.ok(maxRead <= 64 * 1024, `history chunk exceeded 64 KiB: ${maxRead}`);
  assert.ok(bytesRead < 7 * 1024 * 1024, `scanner crossed far past the week boundary: ${bytesRead}`);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'usage-history-bounds',
    historyBytes: fs.statSync(historyPath).size,
    bytesRead,
    maxRead,
    liveCount,
  }));
} finally {
  fs.readFileSync = originalReadFileSync;
  fs.readSync = originalReadSync;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
