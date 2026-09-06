import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from '../tests/support/tmp.mjs';

const require = createRequire(import.meta.url);
const {
  clearTailCache,
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  parseJsonLines,
  readJsonLines,
  readTailLines,
} = require('../../claudeville/adapters/shared.js');

const dir = makeTempDir('claudeville-tail-cache-');
const file = path.join(dir, 'session.jsonl');

try {
  const original = Array.from({ length: 6_000 }, (_, index) => `line-${index}`).join('\n') + '\n';
  fs.writeFileSync(file, original);

  assert.equal(readTailLines(file, 50).length, 50);
  assert.equal(readTailLines(file, 500).length, 500);
  assert.equal(readTailLines(file, 5_000).length, 5_000);
  assert.deepEqual(readTailLines(file, 2), ['line-5998', 'line-5999']);

  const afterOverlappingReads = getTailCacheDiagnostics();
  assert.equal(afterOverlappingReads.entries, 1, 'one file must retain one shared tail state');
  assert.ok(afterOverlappingReads.estimatedBytes <= afterOverlappingReads.byteLimit);

  fs.appendFileSync(file, 'line-6000\n');
  assert.deepEqual(readTailLines(file, 2), ['line-5999', 'line-6000']);

  fs.writeFileSync(file, 'rotated-0\nrotated-1\n');
  assert.deepEqual(readTailLines(file, 5), ['rotated-0', 'rotated-1']);

  fs.writeFileSync(file, 'alpha-\u{1F642}\nbeta-\u00e9\ngamma-\u03bb\n');
  assert.deepEqual(
    readTailLines(file, 3, { chunkBytes: 3, maxBytes: 1024 }),
    ['alpha-\u{1F642}', 'beta-\u00e9', 'gamma-\u03bb'],
    'backward chunk reads must preserve split UTF-8 code points',
  );

  const prefix = Buffer.from('partial-', 'utf8');
  const smile = Buffer.from('\u{1F642}', 'utf8');
  fs.writeFileSync(file, Buffer.concat([prefix, smile.subarray(0, 1)]));
  readTailLines(file, 1, { chunkBytes: 2, maxBytes: 1024 });
  fs.appendFileSync(file, Buffer.concat([smile.subarray(1), Buffer.from('\n')]));
  assert.deepEqual(
    readTailLines(file, 1, { chunkBytes: 2, maxBytes: 1024 }),
    ['partial-\u{1F642}'],
    'incremental polling must retain an incomplete UTF-8 suffix as bytes',
  );

  const boundaryFile = path.join(dir, 'tail-boundary.jsonl');
  fs.writeFileSync(boundaryFile, `${'x'.repeat(1024)}\n{"id":1}\n{"id":2}\n`);
  const boundedTail = readTailLines(boundaryFile, 10, { chunkBytes: 64, maxBytes: 128 });
  assert.deepEqual(parseJsonLines(boundedTail, { source: 'tail-boundary', file: boundaryFile }), [{ id: 1 }, { id: 2 }]);
  assert.equal(getJsonlDiagnostics()['tail-boundary'].skippedLines, 0,
    'a bounded tail must discard its truncated first line before JSON parsing');

  const exactBoundaryFile = path.join(dir, 'tail-exact-boundary.jsonl');
  const exactTail = '{"id":1}\n{"id":2}\n';
  fs.writeFileSync(exactBoundaryFile, `older\n${exactTail}`);
  assert.deepEqual(
    readTailLines(exactBoundaryFile, 10, { chunkBytes: 64, maxBytes: Buffer.byteLength(exactTail) }),
    ['{"id":1}', '{"id":2}'],
    'a bounded tail must retain the first record when its window starts exactly after a newline',
  );

  const parsedFile = path.join(dir, 'parsed-tail.jsonl');
  fs.writeFileSync(parsedFile, '{"id":1}\n{"id":2}\n{"id":3}\n');
  clearTailCache();
  const parsedBefore = getJsonlDiagnostics()['tail-smoke']?.parsedLines || 0;
  assert.deepEqual(
    readJsonLines(parsedFile, { count: 3, source: 'tail-smoke' }),
    [{ id: 1 }, { id: 2 }, { id: 3 }],
  );
  const parsedAfterFirst = getJsonlDiagnostics()['tail-smoke'].parsedLines;
  assert.equal(parsedAfterFirst - parsedBefore, 3);
  assert.deepEqual(
    readJsonLines(parsedFile, { count: 3, source: 'tail-smoke' }),
    [{ id: 1 }, { id: 2 }, { id: 3 }],
  );
  assert.equal(
    getJsonlDiagnostics()['tail-smoke'].parsedLines,
    parsedAfterFirst,
    'an unchanged parsed tail must not call JSON.parse again',
  );

  fs.appendFileSync(parsedFile, '{"id":4}\n');
  assert.deepEqual(
    readJsonLines(parsedFile, { count: 3, source: 'tail-smoke' }),
    [{ id: 2 }, { id: 3 }, { id: 4 }],
  );
  assert.equal(
    getJsonlDiagnostics()['tail-smoke'].parsedLines,
    parsedAfterFirst + 1,
    'a safe append must parse only its new line',
  );
  fs.appendFileSync(parsedFile, '{"id":');
  assert.deepEqual(
    readJsonLines(parsedFile, { count: 3, source: 'tail-smoke' }),
    [{ id: 3 }, { id: 4 }],
  );
  const partialStats = getJsonlDiagnostics()['tail-smoke'];
  assert.equal(partialStats.trailingPartials, 1);
  fs.appendFileSync(parsedFile, '5}\n{malformed}\n{"id":6}\n');
  assert.deepEqual(
    readJsonLines(parsedFile, { count: 3, source: 'tail-smoke' }),
    [{ id: 5 }, { id: 6 }],
  );
  const recoveredStats = getJsonlDiagnostics()['tail-smoke'];
  assert.equal(recoveredStats.parsedLines, parsedAfterFirst + 3);
  assert.equal(recoveredStats.skippedLines, 1);
  assert.ok(getTailCacheDiagnostics().parsed.hits >= 1);
  assert.ok(getTailCacheDiagnostics().estimatedBytes <= getTailCacheDiagnostics().byteLimit);

  for (let index = 0; index < 9; index++) {
    const pendingFile = path.join(dir, `large-pending-${index}.jsonl`);
    fs.writeFileSync(pendingFile, 'p'.repeat(4 * 1024 * 1024));
    readTailLines(pendingFile, 1);
  }
  const afterLargePendingReads = getTailCacheDiagnostics();
  assert.ok(afterLargePendingReads.entries <= 8,
    'large incomplete records must be evicted by the shared byte budget');
  assert.ok(afterLargePendingReads.estimatedBytes <= afterLargePendingReads.byteLimit,
    'incomplete record buffers must be included in tail-cache byte accounting');

  console.log('tail cache smoke passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
