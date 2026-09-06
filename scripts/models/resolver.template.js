function normalizeModel(model) {
    return String(model || '')
        .toLowerCase()
        .replace(/[._]/g, '-')
        .replace(/\s+/g, '-');
}

function pricingModelCandidates(model) {
    const normalized = normalizeModel(model);
    const dottedCodex = normalized.replace(/\bgpt-5-(\d)\b/g, 'gpt-5.$1');
    return [...new Set([normalized, dottedCodex])];
}

function registryProvider(provider) {
    const normalized = String(provider || '').toLowerCase();
    return normalized === 'openai' ? 'codex' : normalized;
}

function matchingRow(model, provider) {
    const candidates = pricingModelCandidates(model);
    const providerKey = registryProvider(provider);
    for (const row of MODEL_REGISTRY) {
        if (providerKey && row.provider !== providerKey) continue;
        const match = row.match.find(alias => candidates.some(candidate => candidate.includes(alias)));
        if (match) return { row, match };
    }
    return null;
}

function findModelRow(model, provider = '') {
    const providerKey = registryProvider(provider);
    const matched = matchingRow(model, providerKey);
    if (matched) return { row: matched.row, isDefault: false, match: matched.match };
    const row = providerKey ? MODEL_DEFAULTS[providerKey] || null : null;
    const pricingKey = row?.pricingKey || providerKey || 'unknown';
    return { row, isDefault: true, match: `default:${pricingKey}` };
}

function pricingProvider(model, provider) {
    const candidates = pricingModelCandidates(model);
    const normalizedProvider = registryProvider(provider);
    if (normalizedProvider === 'kimi' || candidates.some(candidate => candidate.includes('kimi'))) return 'kimi';
    if (normalizedProvider === 'deepseek' || candidates.some(candidate => candidate.includes('deepseek'))) return 'deepseek';
    if (normalizedProvider === 'zai' || candidates.some(candidate => candidate.includes('glm'))) return 'zai';
    if (normalizedProvider === 'grok' || candidates.some(candidate => candidate.includes('grok'))) return 'grok';
    if (normalizedProvider === 'gemini' || candidates.some(candidate => candidate.includes('gemini'))) return 'gemini';
    if (normalizedProvider === 'codex' || candidates.some(candidate => candidate.includes('gpt'))) return 'codex';
    return 'claude';
}

function ratesForModel(model, provider = '') {
    const selected = findModelRow(model, pricingProvider(model, provider));
    return {
        rate: selected.row?.pricing && !selected.isDefault
            ? { match: selected.match, ...selected.row.pricing }
            : selected.row?.pricing || null,
        match: selected.match,
        isDefault: selected.isDefault,
    };
}

function contextWindowForModel(model, provider = '') {
    const direct = findModelRow(model, provider);
    if (!direct.isDefault) return direct.row?.contextWindow ?? null;
    if (provider) {
        const inferredProvider = pricingProvider(model, provider);
        if (inferredProvider !== registryProvider(provider)) {
            const inferred = findModelRow(model, inferredProvider);
            if (!inferred.isDefault) return inferred.row?.contextWindow ?? null;
        }
        return direct.row?.contextWindow ?? null;
    }
    return null;
}
