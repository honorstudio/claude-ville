import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  MODEL_DEFAULTS,
  MODEL_REGISTRY,
  MODEL_REVISION,
} from '../../claudeville/src/config/models.generated.js';
import { TokenUsage } from '../../claudeville/src/domain/value-objects/TokenUsage.js';

const registryProviderForPricingTable = { openai: 'codex' };
const pricing = Object.fromEntries(
  Object.entries(MODEL_DEFAULTS).map(([provider, defaults]) => [defaults.pricingKey || provider, {
    default: defaults.pricing,
    rates: MODEL_REGISTRY
      .filter(row => row.provider === (registryProviderForPricingTable[provider] || provider))
      .flatMap(row => row.match.map(match => ({ match, ...row.pricing }))),
  }]),
);
pricing.revision = MODEL_REVISION;

const require = createRequire(import.meta.url);
const {
  decorateSessionPresentation,
  estimateCost: estimateServerCost,
  ratesForModel,
} = require('../../claudeville/adapters/sessionPresentation.js');

const ADAPTER_FIXTURE_MODELS = [
  { adapter: 'Claude', provider: 'claude', model: 'claude-sonnet-4-5' },
  { adapter: 'Codex', provider: 'codex', model: 'gpt-5' },
  { adapter: 'Gemini', provider: 'gemini', model: 'gemini-2.5-flash' },
  { adapter: 'Grok', provider: 'grok', model: 'grok-4.5' },
  { adapter: 'Kimi', provider: 'kimi', model: 'kimi-code/kimi-for-coding' },
  { adapter: 'OpenCode', provider: 'opencode', model: 'deepseek/deepseek-v4-pro' },
  { adapter: 'OMP', provider: 'omp', model: 'openai-codex/gpt-5.6-luna' },
  { adapter: 'OMP', provider: 'omp', model: 'zai/glm-5.3-flash' },
  { adapter: 'OMP', provider: 'omp', model: 'glm-5.3' },
];

const LIVE_MODELS = [
  { provider: 'claude', model: 'claude-fable-5-1' },
  { provider: 'claude', model: 'claude-fable-5' },
  { provider: 'claude', model: 'claude-opus-5' },
  { provider: 'claude', model: 'claude-sonnet-5' },
  { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
  { provider: 'codex', model: 'gpt-5.6-sol' },
  { provider: 'codex', model: 'gpt-5.6-luna' },
];

const SAMPLE_USAGE = {
  input: 1_000_000,
  output: 100_000,
  cacheRead: 250_000,
  cacheCreate: 50_000,
};

test('fixture and maintained live model ids select concrete pricing rates', () => {
  for (const entry of [...ADAPTER_FIXTURE_MODELS, ...LIVE_MODELS]) {
    const server = estimateServerCost(SAMPLE_USAGE, entry.model, entry.provider);
    const browser = TokenUsage.estimateCost(SAMPLE_USAGE, entry.model, entry.provider);
    assert.equal(server.unknownModel, false, `${entry.adapter || 'live'} model "${entry.model}" used a default rate`);
    assert.equal(browser.unknownModel, false, `${entry.adapter || 'live'} browser model "${entry.model}" used a default rate`);
  }
});

test('unknown Claude ids disclose use of the default rate', () => {
  const server = estimateServerCost(SAMPLE_USAGE, 'claude-zeta-9', 'claude');
  const browser = TokenUsage.estimateCost(SAMPLE_USAGE, 'claude-zeta-9', 'claude');
  assert.equal(server.unknownModel, true);
  assert.equal(browser.unknownModel, true);
  assert.equal(server.rateMatch, 'default:claude');
  assert.equal(browser.rateMatch, 'default:claude');
});

test('server and browser estimates agree on cost provenance', () => {
  const providerForTable = {
    claude: 'claude',
    openai: 'codex',
    kimi: 'kimi',
    deepseek: 'deepseek',
    zai: 'zai',
    grok: 'grok',
    gemini: 'gemini',
  };

  for (const [tableName, table] of Object.entries(pricing)) {
    if (tableName === 'revision') continue;
    const provider = providerForTable[tableName];
    assert.ok(provider, `missing provider mapping for ${tableName}`);
    for (const model of [...table.rates.map((rate) => rate.match), `__r2_02_unknown_${tableName}__`]) {
      const server = estimateServerCost(SAMPLE_USAGE, model, provider);
      const browser = TokenUsage.estimateCost(SAMPLE_USAGE, model, provider);
      assert.deepEqual(
        { availability: browser.availability, usd: browser.usd, rateMatch: browser.rateMatch, unknownModel: browser.unknownModel },
        server,
        `${tableName} estimate differs between server and browser`,
      );
    }
  }
});

test('rate selection shape and session payload expose F1 provenance', () => {
  const selected = ratesForModel('claude-fable-5-1', 'claude');
  assert.equal(selected.match, 'fable-5-1');
  assert.equal(selected.isDefault, false);
  assert.equal(selected.rate.input, 10);
  assert.equal(selected.rate.cacheRead, 0.25);
  assert.equal(ratesForModel('claude-fable-5', 'claude').rate.cacheRead, 1);
  // OMP presents either the prefixed model_change string or the bare id from
  // later assistant messages; both must pin the flash row, not glm-5-3 or claude.
  for (const raw of ['zai/glm-5.3-flash', 'glm-5.3-flash']) {
    const glmFlash = ratesForModel(raw, 'omp');
    assert.equal(glmFlash.match, 'glm-5-3-flash', raw);
    assert.equal(glmFlash.isDefault, false, raw);
    assert.equal(glmFlash.rate.input, 0.15, raw);
    assert.equal(glmFlash.rate.output, 0.5, raw);
  }
  assert.equal(ratesForModel('glm-5.3', 'omp').match, 'glm-5-3');

  const session = decorateSessionPresentation({
    provider: 'claude',
    model: 'claude-fable-5-1',
    tokenUsage: SAMPLE_USAGE,
  });
  assert.equal(session.estimatedCost, session.cost.usd);
  assert.deepEqual(session.cost, {
    usd: 15.6875,
    availability: 'observed',
    source: 'estimate',
    rateMatch: 'fable-5-1',
    rateRevision: pricing.revision,
    unknownModel: false,
  });

  const providerCost = {
    usd: 12.34,
    source: 'provider',
    rateMatch: null,
    rateRevision: pricing.revision,
    unknownModel: false,
  };
  assert.equal(decorateSessionPresentation({
    provider: 'claude',
    model: 'claude-fable-5-1',
    estimatedCost: providerCost.usd,
    cost: providerCost,
  }).cost, providerCost);
});
