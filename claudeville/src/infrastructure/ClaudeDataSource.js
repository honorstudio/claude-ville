const BASE_URL = window.location.origin;
const PROVIDER_HEALTH = new Set(['unavailable', 'empty', 'healthy', 'degraded']);

function normalizeProvider(provider) {
    const value = typeof provider === 'string' ? { id: provider, name: provider } : provider || {};
    const id = String(value.id ?? value.provider ?? value.name ?? 'unknown');
    return {
        id,
        name: String(value.name ?? value.id ?? value.provider ?? 'unknown'),
        health: PROVIDER_HEALTH.has(value.health) ? value.health : 'unavailable',
        sessions: Math.max(0, Number(value.sessions) || 0),
        lastSuccessAt: Number(value.lastSuccessAt) || null,
        skippedLines: Math.max(0, Number(value.skippedLines) || 0),
    };
}

function providerKeys(provider) {
    const value = typeof provider === 'string' ? { id: provider } : provider || {};
    const keys = [value.id, value.provider].filter(key => key !== null && key !== undefined);
    return (keys.length > 0 ? keys : [value.name])
        .filter(key => key !== null && key !== undefined)
        .map(String);
}

function mergeProviders(health, legacy) {
    const matchedLegacy = new Set();
    const merged = health.map(healthProvider => {
        const healthKeys = providerKeys(healthProvider);
        const legacyIndex = legacy.findIndex((legacyProvider, index) => (
            !matchedLegacy.has(index)
            && providerKeys(legacyProvider).some(key => healthKeys.includes(key))
        ));

        if (legacyIndex < 0) return healthProvider;
        matchedLegacy.add(legacyIndex);
        return { ...legacy[legacyIndex], ...healthProvider };
    });

    legacy.forEach((legacyProvider, index) => {
        if (!matchedLegacy.has(index)) merged.push(legacyProvider);
    });

    return merged.map(normalizeProvider);
}

function selectProviders(data) {
    const providers = Array.isArray(data)
        ? data
        : (Array.isArray(data?.providers) ? data.providers : data?.active);
    if (Array.isArray(data?.health)) {
        return mergeProviders(data.health, Array.isArray(data.providers) ? data.providers : []);
    }
    return (Array.isArray(providers) ? providers : []).map(normalizeProvider);
}

export class ClaudeDataSource {
    async getSessions(options = {}) {
        return this._getJson(
            '/api/sessions',
            [],
            'sessions',
            (data) => {
                const sessions = Array.isArray(data.sessions) ? data.sessions : [];
                for (const field of [
                    'gitEventFields',
                    'gitEventStringTables',
                    'gitEventsById',
                    'collisions',
                ]) {
                    Object.defineProperty(sessions, field, {
                        value: data[field] || null,
                        configurable: true,
                    });
                }
                return sessions;
            },
            { ...options, rejectOnError: true },
        );
    }

    async getTeams(options = {}) {
        return this._getJson('/api/teams', [], 'teams', (data) => data.teams || [], options);
    }

    async getUsage(options = {}) {
        return this._getJson('/api/usage', null, 'usage', null, options);
    }

    async getProviders(options = {}) {
        return this._getJson('/api/providers', [], 'providers', selectProviders, options);
    }

    async _getJson(path, fallback, label, select, { signal, rejectOnError = false } = {}) {
        try {
            const res = await fetch(`${BASE_URL}${path}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return typeof select === 'function' ? select(data) : data;
        } catch (err) {
            if (rejectOnError) throw err;
            if (err?.name === 'AbortError' || signal?.aborted) return fallback;
            console.error(`[DataSource] Failed to fetch ${label}:`, err.message);
            return fallback;
        }
    }

}
