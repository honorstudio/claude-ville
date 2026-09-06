import {
    MODEL_DEFAULTS,
    MODEL_REGISTRY,
    MODEL_REVISION,
    ratesForModel,
} from '../../config/models.generated.js';

const DEFAULT_TOKEN_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cacheWrite: 0,
    totalInput: 0,
    totalOutput: 0,
    reasoningTokens: 0,
    reasoningInOutput: false,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
};

const FIELD_ALIASES = {
    input: ['input', 'totalInput', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'total_input_tokens', 'total_input'],
    output: ['output', 'totalOutput', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'total_output_tokens', 'total_output'],
    cacheRead: ['cacheRead', 'cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read'],
    cacheCreate: ['cacheCreate', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cache_create_tokens'],
    totalInput: ['totalInput', 'total_input', 'total_input_tokens', 'input'],
    totalOutput: ['totalOutput', 'total_output', 'total_output_tokens', 'output'],
    contextWindow: ['contextWindow', 'contextWindowTokens', 'context_window', 'context_window_tokens'],
    contextWindowMax: ['contextWindowMax', 'contextWindowLimit', 'context_window_max', 'context_window_limit', 'context_max'],
    turnCount: ['turnCount', 'turn_count', 'numTurns'],
    cacheWrite: ['cacheWrite', 'cache_write'],
    reasoningTokens: ['reasoningTokens', 'reasoning', 'reasoning_tokens', 'reasoning_output_tokens', 'reasoningOutputTokens', 'tokens_reasoning'],
};

const normalizeNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const coerceTokenField = (raw, candidates) => {
    for (const candidate of candidates) {
        if (raw[candidate] !== undefined && raw[candidate] !== null) {
            return normalizeNumber(raw[candidate]);
        }
    }
    return 0;
};

const isLikelyNormalized = (raw) => {
    if (!raw || typeof raw !== 'object') return false;
    return ['input', 'output', 'cacheRead', 'cacheCreate'].every((key) => Number.isFinite(Number(raw[key])));
};

export class TokenUsage {
    constructor(raw = null) {
        Object.assign(this, TokenUsage.normalize(raw));
    }

    static normalize(raw = null) {
        const has = keys => keys.some(key => raw?.[key] != null && raw[key] !== ''
          && typeof raw[key] !== 'boolean' && Number.isFinite(Number(raw[key])) && Number(raw[key]) >= 0);
        const availability = ['observed', 'partial', 'unavailable'].includes(raw?.availability) ? raw.availability
          : has(FIELD_ALIASES.input) && has(FIELD_ALIASES.output) ? 'observed'
            : ['input', 'output', 'cacheRead', 'cacheCreate'].some(field => has(FIELD_ALIASES[field])) ? 'partial' : 'unavailable';
        if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOKEN_USAGE, availability };
        if (raw instanceof TokenUsage) {
            return { ...raw };
        }
        if (isLikelyNormalized(raw)) {
            return {
                availability,
                input: normalizeNumber(raw.input),
                output: normalizeNumber(raw.output),
                cacheRead: normalizeNumber(raw.cacheRead),
                cacheCreate: normalizeNumber(raw.cacheCreate ?? raw.cacheWrite),
                totalInput: normalizeNumber(raw.totalInput ?? raw.input),
                totalOutput: normalizeNumber(raw.totalOutput ?? raw.output),
                contextWindow: normalizeNumber(raw.contextWindow ?? raw.contextWindowTokens ?? raw.context_window ?? raw.context_window_tokens),
                contextWindowMax: normalizeNumber(raw.contextWindowMax ?? raw.contextWindowLimit ?? raw.context_window_max ?? raw.context_window_limit ?? raw.context_max),
                turnCount: normalizeNumber(raw.turnCount ?? raw.turn_count ?? raw.numTurns),
                cacheWrite: normalizeNumber(raw.cacheWrite ?? raw.cache_create ?? raw.cacheCreate),
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
            contextWindow: coerceTokenField(raw, FIELD_ALIASES.contextWindow),
            contextWindowMax: coerceTokenField(raw, FIELD_ALIASES.contextWindowMax),
            turnCount: coerceTokenField(raw, FIELD_ALIASES.turnCount),
            reasoningTokens: coerceTokenField(raw, FIELD_ALIASES.reasoningTokens),
            reasoningInOutput: raw.reasoningInOutput === true,
        };
    }

    static totalTokens(rawUsage) {
        const usage = rawUsage instanceof TokenUsage ? rawUsage : TokenUsage.normalize(rawUsage);
        return usage.totalInput + usage.totalOutput + usage.cacheRead + usage.cacheCreate;
    }

    static get rateRevision() {
        return MODEL_REVISION;
    }

    static pricingForModel(model, provider) {
        return ratesForModel(model, provider);
    }

    static estimateCost(rawUsage, model, provider) {
        const usage = rawUsage instanceof TokenUsage ? rawUsage : TokenUsage.normalize(rawUsage);
        const { rate, match, isDefault } = TokenUsage.pricingForModel(model, provider);
        // Reasoning tokens are billed at the output rate. Skip them when the
        // provider already counts them inside output (e.g. Codex) to avoid
        // double pricing.
        const billableReasoning = usage.reasoningInOutput ? 0 : usage.reasoningTokens;
        const estimate = {
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
        Object.defineProperty(estimate, 'valueOf', {
            value: () => estimate.usd,
            enumerable: false,
        });
        return estimate;
    }
}
