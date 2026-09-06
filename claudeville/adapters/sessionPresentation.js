const {
  MODEL_DEFAULTS,
  MODEL_REVISION,
  findModelRow,
  normalizeModel,
  ratesForModel,
} = require('../src/config/models.generated.cjs');

const DEFAULT_TOKEN_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  cacheWrite: 0,
  totalInput: 0,
  totalOutput: 0,
  reasoningTokens: 0,
  reasoningInOutput: false,
});

const FIELD_ALIASES = Object.freeze({
  input: ['input', 'totalInput', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'total_input_tokens', 'total_input'],
  output: ['output', 'totalOutput', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'total_output_tokens', 'total_output'],
  cacheRead: ['cacheRead', 'cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read'],
  cacheCreate: ['cacheCreate', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cache_create_tokens'],
  totalInput: ['totalInput', 'total_input', 'total_input_tokens', 'input'],
  totalOutput: ['totalOutput', 'total_output', 'total_output_tokens', 'output'],
  cacheWrite: ['cacheWrite', 'cache_write'],
  reasoningTokens: ['reasoningTokens', 'reasoning', 'reasoning_tokens', 'reasoning_output_tokens', 'reasoningOutputTokens', 'tokens_reasoning'],
});

const EFFORT_LABELS = Object.freeze({
  none: 'none',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
});

const DEFAULT_CODEX_IDENTITY = Object.freeze({
  label: MODEL_DEFAULTS.codex.label,
  shortLabel: MODEL_DEFAULTS.codex.shortLabel,
  spriteId: MODEL_DEFAULTS.codex.spriteId,
  color: MODEL_DEFAULTS.codex.color,
});

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function coerceTokenField(raw, candidates) {
  for (const candidate of candidates) {
    if (raw[candidate] !== undefined && raw[candidate] !== null) {
      return normalizeNumber(raw[candidate]);
    }
  }
  return 0;
}

function isLikelyNormalized(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return ['input', 'output', 'cacheRead', 'cacheCreate'].every((key) => Number.isFinite(Number(raw[key])));
}

function normalizeTokenUsage(raw = null) {
  const has = keys => keys.some(key => raw?.[key] != null && raw[key] !== ''
    && typeof raw[key] !== 'boolean' && Number.isFinite(Number(raw[key])) && Number(raw[key]) >= 0);
  const availability = ['observed', 'partial', 'unavailable'].includes(raw?.availability) ? raw.availability
    : has(FIELD_ALIASES.input) && has(FIELD_ALIASES.output) ? 'observed'
      : ['input', 'output', 'cacheRead', 'cacheCreate'].some(field => has(FIELD_ALIASES[field])) ? 'partial' : 'unavailable';
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_USAGE, availability };
  if (isLikelyNormalized(raw)) {
    return {
      availability,
      input: normalizeNumber(raw.input),
      output: normalizeNumber(raw.output),
      cacheRead: normalizeNumber(raw.cacheRead),
      cacheCreate: normalizeNumber(raw.cacheCreate ?? raw.cacheWrite),
      cacheWrite: normalizeNumber(raw.cacheWrite ?? raw.cache_create ?? raw.cacheCreate),
      totalInput: normalizeNumber(raw.totalInput ?? raw.input),
      totalOutput: normalizeNumber(raw.totalOutput ?? raw.output),
      reasoningTokens: normalizeNumber(raw.reasoningTokens ?? raw.reasoning),
      reasoningInOutput: raw.reasoningInOutput === true,
    };
  }

  const input = coerceTokenField(raw, FIELD_ALIASES.input);
  const output = coerceTokenField(raw, FIELD_ALIASES.output);
  const cacheRead = coerceTokenField(raw, FIELD_ALIASES.cacheRead);
  const cacheCreate = coerceTokenField(raw, FIELD_ALIASES.cacheCreate);
  return {
    availability,
    input,
    output,
    cacheRead,
    cacheCreate,
    cacheWrite: coerceTokenField(raw, FIELD_ALIASES.cacheWrite) || cacheCreate,
    totalInput: coerceTokenField(raw, FIELD_ALIASES.totalInput) || input,
    totalOutput: coerceTokenField(raw, FIELD_ALIASES.totalOutput) || output,
    reasoningTokens: coerceTokenField(raw, FIELD_ALIASES.reasoningTokens),
    reasoningInOutput: raw.reasoningInOutput === true,
  };
}

function estimateCost(rawUsage, model, provider) {
  const usage = normalizeTokenUsage(rawUsage);
  const { rate, match, isDefault } = ratesForModel(model, provider);
  // Reasoning tokens are billed at the output rate. Skip them when the
  // provider already counts them inside output (e.g. Codex) to avoid
  // double pricing.
  const billableReasoning = usage.reasoningInOutput ? 0 : usage.reasoningTokens;
  return {
    availability: usage.availability,
    usd: usage.availability === 'unavailable' ? null : (
      usage.input * rate.input +
      (usage.output + billableReasoning) * rate.output +
      usage.cacheRead * rate.cacheRead +
      usage.cacheCreate * rate.cacheCreate
    ) / 1000000,
    rateMatch: match,
    unknownModel: isDefault,
  };
}

function normalizeReasoningEffort(effort) {
  const normalized = String(effort || '').toLowerCase();
  if (!normalized || normalized === 'none') return normalized ? 'none' : null;
  if (normalized.includes('ultra')) return 'ultra';
  if (normalized === 'max' || normalized.includes('maximum')) return 'max';
  if (normalized.includes('xhigh') || normalized.includes('extra')) return 'xhigh';
  if (normalized.includes('high')) return 'high';
  if (normalized.includes('mid') || normalized.includes('medium')) return 'medium';
  if (normalized.includes('low')) return 'low';
  return normalized;
}

function normalizeCodexEffortTier(effortTier) {
  return effortTier === 'max' ? 'xhigh' : effortTier;
}

function codexGpt55Sprite(effortTier) {
  return effortTier === 'high'
    ? 'agent.codex.gpt55.high'
    : effortTier === 'xhigh'
      ? 'agent.codex.gpt55.xhigh'
      : 'agent.codex.gpt55';
}

function inferredRegistryProvider(model, provider = '') {
  const normalizedModel = normalizeModel(model);
  if (normalizedModel.includes('deepseek')) return 'deepseek';
  if (normalizedModel.includes('glm')) return 'zai';
  if (normalizedModel.includes('gemini')) return 'gemini';
  if (normalizedModel.includes('codex') || normalizedModel.includes('gpt')) return 'codex';
  if (normalizedModel.includes('claude')) return 'claude';
  if (normalizedModel.includes('kimi')) return 'kimi';
  if (normalizedModel.includes('grok')) return 'grok';
  const normalizedProvider = String(provider || '').toLowerCase();
  if (normalizedProvider.includes('deepseek')) return 'deepseek';
  if (normalizedProvider.includes('zai') || normalizedProvider.includes('zhipu')) return 'zai';
  if (normalizedProvider.includes('gemini')) return 'gemini';
  if (normalizedProvider.includes('codex') || normalizedProvider.includes('openai')) return 'codex';
  if (normalizedProvider.includes('claude')) return 'claude';
  if (normalizedProvider.includes('kimi')) return 'kimi';
  if (normalizedProvider.includes('grok')) return 'grok';
  return normalizedProvider;
}

function selectModelRow(model, provider = '') {
  const direct = findModelRow(model, provider);
  if (!direct.isDefault) return direct;

  const modelMatch = findModelRow(model);
  if (!modelMatch.isDefault) return modelMatch;

  const inferredProvider = inferredRegistryProvider(model, provider);
  if (inferredProvider && inferredProvider !== String(provider || '').toLowerCase()) {
    const inferred = findModelRow(model, inferredProvider);
    if (inferred.row) return inferred;
  }
  return direct;
}

function modelIdentity(model, effort, provider = '') {
  const { row } = selectModelRow(model, provider);
  const effortTier = normalizeReasoningEffort(effort);
  if (!row) {
    return {
      shortLabel: String(model || ''),
      effortTier,
      spriteId: null,
      color: '#64748b',
    };
  }

  const isCelestial = row.modelClass === 'gpt6astra'
    || row.modelClass === 'gpt56sol'
    || row.modelClass === 'gpt56terra'
    || row.modelClass === 'gpt56luna';
  const resolvedEffortTier = row.paletteKey === 'codex' && !isCelestial
    ? normalizeCodexEffortTier(effortTier)
    : effortTier;
  const identity = row === MODEL_DEFAULTS.codex ? DEFAULT_CODEX_IDENTITY : row;
  return {
    shortLabel: identity.shortLabel,
    effortTier: resolvedEffortTier,
    spriteId: row.modelClass === 'gpt55'
      ? codexGpt55Sprite(resolvedEffortTier)
      : identity.spriteId,
    color: identity.color,
  };
}

function formatModelLabel(model, effort, provider = '') {
  const identity = modelIdentity(model, effort, provider);
  let label = identity.shortLabel || String(model || '?');
  if (identity.effortTier && identity.effortTier !== 'none') {
    label += ` ${EFFORT_LABELS[identity.effortTier] || identity.effortTier}`;
  }
  return label
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace('-20250929', '')
    .replace('-20251001', '');
}

function decorateSessionPresentation(session) {
  const identity = modelIdentity(session.model, session.reasoningEffort || session.effort, session.provider);
  const explicitCost = session.estimatedCost == null ? NaN : Number(session.estimatedCost);
  const estimate = estimateCost(session.tokenUsage ?? session.tokens ?? session.usage, session.model, session.provider);
  const estimatedCost = Number.isFinite(explicitCost) && explicitCost >= 0
    ? explicitCost
    : estimate.usd;
  const providerCost = session.cost?.source === 'provider' && session.cost.usd != null && Number.isFinite(Number(session.cost.usd))
    ? session.cost
    : null;
  return {
    ...session,
    estimatedCost,
    cost: providerCost || {
      usd: estimatedCost,
      availability: Number.isFinite(explicitCost) ? session.cost?.availability || 'observed' : estimate.availability,
      source: 'estimate',
      rateMatch: estimate.rateMatch,
      rateRevision: MODEL_REVISION,
      unknownModel: estimate.unknownModel,
    },
    displayModel: session.displayModel || formatModelLabel(session.model, session.reasoningEffort || session.effort, session.provider),
    modelColor: session.modelColor || identity.color,
    spriteId: session.spriteId || identity.spriteId,
  };
}

module.exports = {
  decorateSessionPresentation,
  estimateCost,
  formatModelLabel,
  modelIdentity,
  normalizeTokenUsage,
  ratesForModel,
};
