import test from 'node:test';
import assert from 'node:assert/strict';

import { runReplay } from '../../smoke/r1-18.e2e-replay.mjs';

test('real multi-provider pipeline replays WebSocket delta and snapshot payloads', async () => {
  const summary = await runReplay();

  assert.deepEqual(summary.providers, ['claude', 'codex', 'gemini', 'opencode']);
  assert.ok(summary.deltaSeq > summary.warmupSeq);
  assert.ok(summary.deltaOps > 0);
  assert.ok(summary.floorSeq > summary.deltaSeq);
  assert.ok(summary.floorDelayMs >= 20_000);
});
