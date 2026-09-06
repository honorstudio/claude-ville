import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _perfTest: perfTest } = require('../../claudeville/server.js');

test.beforeEach(() => {
  perfTest.resetProcessErrorTelemetry();
});

test.after(() => {
  perfTest.resetProcessErrorTelemetry();
});

test('records the latest rejection and exception details in bounded telemetry', () => {
  perfTest.recordUnhandledRejection('rejection detail', 1_700_000_000_001);
  perfTest.recordUncaughtException(new Error('exception detail'), 1_700_000_000_002);

  assert.deepEqual(perfTest.getProcessErrorTelemetry(), {
    unhandledRejections: {
      count: 1,
      lastOccurredAt: 1_700_000_000_001,
      lastReason: 'rejection detail',
    },
    uncaughtExceptions: {
      count: 1,
      lastOccurredAt: 1_700_000_000_002,
      lastMessage: 'exception detail',
    },
  });
});

test('truncates latest details and does not retain repeated error objects', () => {
  const detail = 'x'.repeat(perfTest.processErrorDetailMaxLength * 8);
  const repetitions = 10_000;

  for (let index = 0; index < repetitions; index += 1) {
    perfTest.recordUnhandledRejection(new Error(`${index}:${detail}`), index);
  }

  const telemetry = perfTest.getProcessErrorTelemetry();
  assert.equal(telemetry.unhandledRejections.count, repetitions);
  assert.equal(telemetry.unhandledRejections.lastOccurredAt, repetitions - 1);
  assert.equal(telemetry.unhandledRejections.lastReason.length, perfTest.processErrorDetailMaxLength);
  assert.match(telemetry.unhandledRejections.lastReason, /…$/);
  assert.equal(Array.isArray(telemetry.unhandledRejections), false);
  assert.ok(JSON.stringify(telemetry).length < perfTest.processErrorDetailMaxLength * 4);
});

test('returns a defensive snapshot for /api/perf serialization', () => {
  perfTest.recordUnhandledRejection('first', 1);
  const snapshot = perfTest.getProcessErrorTelemetry();
  snapshot.unhandledRejections.count = 0;
  snapshot.unhandledRejections.lastReason = 'mutated outside telemetry';

  assert.deepEqual(perfTest.getProcessErrorTelemetry().unhandledRejections, {
    count: 1,
    lastOccurredAt: 1,
    lastReason: 'first',
  });
});
