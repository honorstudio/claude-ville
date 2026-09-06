import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  consumeQuotaResponse,
  QUOTA_RESPONSE_MAX_BYTES,
} = require('../../claudeville/services/usageQuota.js')._test;

class FakeResponse extends EventEmitter {
  constructor(statusCode) {
    super();
    this.statusCode = statusCode;
    this.destroyed = false;
    this.resumed = false;
  }

  destroy() {
    this.destroyed = true;
  }

  resume() {
    this.resumed = true;
  }
}

test('quota response accepts a bounded chunked JSON body', () => {
  const response = new FakeResponse(200);
  let parsed = null;
  consumeQuotaResponse(response, value => { parsed = value; });

  response.emit('data', Buffer.from('{"five_hour":{"util'));
  response.emit('data', Buffer.from('ization":42},"seven_day":{"utilization":7}}'));
  response.emit('end');

  assert.deepEqual(parsed, {
    five_hour: { utilization: 42 },
    seven_day: { utilization: 7 },
  });
  assert.equal(response.destroyed, false);
});

test('quota response destroys an oversized body without parsing it', () => {
  const response = new FakeResponse(200);
  let parsed = false;
  consumeQuotaResponse(response, () => { parsed = true; });

  response.emit('data', Buffer.alloc(QUOTA_RESPONSE_MAX_BYTES));
  response.emit('data', Buffer.from('x'));
  response.emit('end');

  assert.equal(response.destroyed, true);
  assert.equal(parsed, false);
});

test('quota response drains non-200 bodies without retaining them', () => {
  const response = new FakeResponse(503);
  let parsed = false;
  consumeQuotaResponse(response, () => { parsed = true; });

  assert.equal(response.resumed, true);
  assert.equal(response.listenerCount('data'), 0);
  assert.equal(parsed, false);
});
