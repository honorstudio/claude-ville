import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeCacheTokens } = require('../../claudeville/adapters/shared.js');

test('normalizes provider cache aliases without changing the frontend shape', () => {
  const cases = [
    {
      name: 'Claude',
      usage: { cache_read_input_tokens: 12, cache_creation_input_tokens: 4 },
      fieldMap: {
        cacheRead: ['cache_read_input_tokens', 'cached_input_tokens'],
        cacheCreate: ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
      },
      expected: { cacheRead: 12, cacheCreate: 4 },
    },
    {
      name: 'Codex',
      usage: { cached_input_tokens: 80 },
      fieldMap: {
        cacheRead: ['cached_input_tokens', 'cache_read_input_tokens'],
        cacheCreate: [],
      },
      expected: { cacheRead: 80, cacheCreate: 0 },
    },
    {
      name: 'Gemini',
      usage: { cachedContentTokenCount: 25 },
      fieldMap: {
        cacheRead: ['cached_input_tokens', 'cachedContentTokenCount'],
        cacheCreate: ['cache_creation_input_tokens'],
      },
      expected: { cacheRead: 25, cacheCreate: 0 },
    },
    {
      name: 'Grok',
      usage: { totalTokens: 1000 },
      fieldMap: { cacheRead: [], cacheCreate: [] },
      expected: { cacheRead: 0, cacheCreate: 0 },
    },
    {
      name: 'Kimi legacy',
      usage: { input_cache_read: 50, input_cache_creation: 6 },
      fieldMap: {
        cacheRead: ['input_cache_read'],
        cacheCreate: ['input_cache_creation'],
      },
      expected: { cacheRead: 50, cacheCreate: 6 },
    },
    {
      name: 'Kimi Code',
      usage: { input_cache_read: 51, inputCacheCreation: 7 },
      fieldMap: {
        cacheRead: ['inputCacheRead', 'input_cache_read'],
        cacheCreate: ['inputCacheCreation', 'input_cache_creation'],
      },
      expected: { cacheRead: 51, cacheCreate: 7 },
    },
    {
      name: 'OpenCode',
      usage: { tokens_cache_read: 90, tokens_cache_write: 3 },
      fieldMap: {
        cacheRead: ['tokens_cache_read'],
        cacheCreate: ['tokens_cache_write'],
      },
      expected: { cacheRead: 90, cacheCreate: 3 },
    },
  ];

  for (const { name, usage, fieldMap, expected } of cases) {
    assert.deepEqual(normalizeCacheTokens(usage, fieldMap), expected, name);
  }
});

test('uses the first valid alias and safely defaults missing or invalid values', () => {
  assert.deepEqual(
    normalizeCacheTokens({
      cached_input_tokens: 'not-a-number',
      cache_read_input_tokens: '31',
      cacheCreationInputTokens: 9,
    }, {
      cacheRead: ['cached_input_tokens', 'cache_read_input_tokens'],
      cacheCreate: ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    }),
    { cacheRead: 31, cacheCreate: 9 },
  );

  assert.deepEqual(normalizeCacheTokens(null, { cacheRead: 'read', cacheCreate: 'create' }), {
    cacheRead: 0,
    cacheCreate: 0,
  });
});

test('supports provider-local nullish alias precedence without centralizing provider parsing', () => {
  const ompFieldMap = {
    cacheRead: [usage => usage?.cacheRead ?? usage?.cache_read],
    cacheCreate: [usage => usage?.cacheWrite ?? usage?.cacheCreate ?? usage?.cache_create],
  };

  assert.deepEqual(
    normalizeCacheTokens({ cacheRead: 'invalid', cache_read: 5, cacheCreate: 6 }, ompFieldMap),
    { cacheRead: 0, cacheCreate: 6 },
  );
});
