class SessionDetailsService {
    constructor() {
        this._defaultProvider = 'claude';
        this._inFlight = new Map();
        this._activeRequests = new Set();
        this._keyTokens = new Map();
        this._cache = new Map();
        this._cacheTtlMs = 5000;
        this._staleTtlMs = 15000;
        this._maxCacheEntries = 128;
        this._fetchTimeoutMs = 4000;
        this._generation = 0;
        this._counters = this._newCounters();
        this._installDebugSnapshot();
    }

    _newCounters() {
        return {
            cacheHits: 0,
            cacheStaleHits: 0,
            cacheMisses: 0,
            fetchStarted: 0,
            fetchSucceeded: 0,
            fetchFailed: 0,
            fetchTimedOut: 0,
            batchStarted: 0,
            batchSucceeded: 0,
            batchFailed: 0,
            batchTimedOut: 0,
            inFlightJoined: 0,
            staleRefreshStarted: 0,
            cacheTrimmed: 0,
            cacheDeleted: 0,
            cacheSwept: 0,
        };
    }

    _installDebugSnapshot() {
        if (typeof window === 'undefined') return;
        const service = this;
        window.__claudeVilleSessionDetails = {
            snapshot() {
                return service.getDebugSnapshot();
            },
            reset() {
                service.resetDebugCounters();
                return service.getDebugSnapshot();
            },
        };
    }

    getDebugSnapshot() {
        return {
            counters: { ...this._counters },
            cacheEntries: this._cache.size,
            inFlightEntries: this._inFlight.size,
            activeRequests: this._activeRequests.size,
            cacheTtlMs: this._cacheTtlMs,
            staleTtlMs: this._staleTtlMs,
            maxCacheEntries: this._maxCacheEntries,
            fetchTimeoutMs: this._fetchTimeoutMs,
            generation: this._generation,
        };
    }

    resetDebugCounters() {
        this._counters = this._newCounters();
    }

    _cacheStateFor(key, now = Date.now()) {
        const entry = this._cache.get(key) || null;
        if (!entry) {
            return {
                key,
                entry: null,
                value: null,
                age: Infinity,
                isFresh: false,
                isStale: false,
                hasEntry: false,
            };
        }
        const age = now - entry.at;
        return {
            key,
            entry,
            value: entry.value,
            age,
            isFresh: age <= this._cacheTtlMs,
            isStale: age > this._cacheTtlMs && age <= this._staleTtlMs,
            hasEntry: true,
        };
    }

    _recordFreshCacheHit(cacheState) {
        this._counters.cacheHits++;
        return cacheState.value;
    }

    _recordStaleCacheHit(cacheState) {
        this._counters.cacheStaleHits++;
        return cacheState.value;
    }

    _keyTokenFor(key) {
        let token = this._keyTokens.get(key);
        if (!token) {
            token = {};
            this._keyTokens.set(key, token);
        }
        return token;
    }

    _isKeyTokenCurrent(key, token) {
        return this._keyTokens.get(key) === token;
    }

    _releaseKeyTokenIfUnused(key, token = null) {
        if (this._cache.has(key) || this._inFlight.has(key)) return;
        if (token && !this._isKeyTokenCurrent(key, token)) return;
        this._keyTokens.delete(key);
    }

    _createFetchTimeout(keys = [], requestKey = null) {
        const controller = new AbortController();
        let timeout = null;
        let cleared = false;
        const state = {
            controller,
            signal: controller.signal,
            keys: new Set(keys),
            requestKey,
            promise: null,
            didTimeout: false,
            didCancel: false,
            clear: () => {
                if (cleared) return;
                cleared = true;
                clearTimeout(timeout);
                this._activeRequests.delete(state);
            },
        };
        timeout = setTimeout(() => {
            state.didTimeout = true;
            controller.abort();
        }, this._fetchTimeoutMs);
        this._activeRequests.add(state);
        return state;
    }

    clear() {
        this._generation++;
        this._keyTokens.clear();
        for (const request of [...this._activeRequests]) {
            request.didCancel = true;
            request.controller.abort();
            request.clear();
        }
        this._activeRequests.clear();
        this._inFlight.clear();
        this._cache.clear();
    }

    _recordTimedFailure(timeoutState, timedOutCounter, failedCounter) {
        if (timeoutState.didCancel) return;
        if (timeoutState.didTimeout) this._counters[timedOutCounter]++;
        else this._counters[failedCounter]++;
    }

    _storeDetail(key, detail) {
        this._cache.set(key, { value: detail, at: Date.now() });
    }

    _trimCache() {
        if (this._cache.size <= this._maxCacheEntries) return;

        const toRemove = this._cache.size - this._maxCacheEntries;
        for (let removed = 0; removed < toRemove; removed++) {
            const oldestKey = this._cache.keys().next().value;
            if (!oldestKey) break;
            this._cache.delete(oldestKey);
            this._releaseKeyTokenIfUnused(oldestKey);
            this._counters.cacheTrimmed++;
        }
    }

    detailCacheState(agent) {
        if (!agent?.id) return null;
        return this._cacheStateFor(this.getSessionDetailKey(agent));
    }

    getSessionDetailKey(agent) {
        const provider = (agent?.provider || this._defaultProvider);
        const project = agent?.projectPath || '';
        const sessionId = agent?.id || '';
        return `${provider}::${project}::${sessionId}`;
    }

    deleteForAgent(agent) {
        if (!agent) return;
        const key = this.getSessionDetailKey(agent);
        this._keyTokens.delete(key);
        if (this._cache.delete(key)) this._counters.cacheDeleted++;
        if (this._inFlight.delete(key)) this._counters.cacheDeleted++;
        for (const request of [...this._activeRequests]) {
            if (!request.keys.delete(key) || request.keys.size > 0) continue;
            request.didCancel = true;
            request.controller.abort();
            request.clear();
            if (request.requestKey && this._inFlight.get(request.requestKey) === request.promise) {
                this._inFlight.delete(request.requestKey);
            }
        }
    }

    sweep(activeAgents = []) {
        const activeKeys = new Set(activeAgents.map(agent => this.getSessionDetailKey(agent)));
        const now = Date.now();
        for (const [key, entry] of this._cache) {
            if (activeKeys.has(key) && now - entry.at <= this._staleTtlMs) continue;
            this._cache.delete(key);
            this._releaseKeyTokenIfUnused(key);
            this._counters.cacheSwept++;
        }
    }

    _requestPayloadFor(agent, key = this.getSessionDetailKey(agent)) {
        return {
            key,
            sessionId: agent.id,
            project: agent.projectPath || '',
            provider: agent.provider || this._defaultProvider,
        };
    }

    fetchSessionDetail(agent) {
        if (!agent || !agent.id) return Promise.resolve(null);

        const key = this.getSessionDetailKey(agent);
        const now = Date.now();
        const cached = this._cacheStateFor(key, now);
        if (cached.isFresh) {
            return Promise.resolve(this._recordFreshCacheHit(cached));
        }

        if (cached.isStale) {
            this._recordStaleCacheHit(cached);
            if (!this._inFlight.has(key)) {
                this._counters.staleRefreshStarted++;
                this._startFetch(key, agent, cached.entry).catch(() => {});
            }
            return Promise.resolve(cached.value);
        }

        if (this._inFlight.has(key)) {
            this._counters.inFlightJoined++;
            return this._inFlight.get(key);
        }

        this._counters.cacheMisses++;
        return this._startFetch(key, agent, cached.entry);
    }

    async fetchSessionDetailsBatch(agents = []) {
        const now = Date.now();
        const results = new Map();
        const requests = [];
        const requestTokens = new Map();
        const pendingKeys = [];
        const callTokens = new Map();

        for (const agent of agents) {
            if (!agent?.id) continue;
            const key = this.getSessionDetailKey(agent);
            const token = this._keyTokenFor(key);
            callTokens.set(agent.id, { key, token });
            const cached = this._cacheStateFor(key, now);
            if (cached.isFresh) {
                results.set(agent.id, this._recordFreshCacheHit(cached));
                continue;
            }
            if (cached.isStale) {
                results.set(agent.id, this._recordStaleCacheHit(cached));
            }
            if (this._inFlight.has(key)) {
                this._counters.inFlightJoined++;
                pendingKeys.push({
                    agentId: agent.id,
                    key,
                    token,
                    promise: this._inFlight.get(key),
                    fallback: cached.value || null,
                });
                continue;
            }
            if (!cached.hasEntry) this._counters.cacheMisses++;
            requests.push(this._requestPayloadFor(agent, key));
            requestTokens.set(key, token);
        }

        const applyPending = async () => {
            for (const pending of pendingKeys) {
                try {
                    const detail = await pending.promise;
                    if (!this._isKeyTokenCurrent(pending.key, pending.token)) continue;
                    if (detail) results.set(pending.agentId, detail);
                    else if (pending.fallback) results.set(pending.agentId, pending.fallback);
                } catch {
                    if (this._isKeyTokenCurrent(pending.key, pending.token) && pending.fallback) {
                        results.set(pending.agentId, pending.fallback);
                    }
                }
            }
        };
        const finishResults = () => {
            for (const [agentId, { key, token }] of callTokens) {
                if (!this._isKeyTokenCurrent(key, token)) results.delete(agentId);
            }
            return results;
        };

        if (requests.length === 0) {
            await applyPending();
            return finishResults();
        }

        const requestKey = `batch::${requests.map(item => item.key).sort().join('\n')}`;
        if (this._inFlight.has(requestKey)) {
            this._counters.inFlightJoined++;
            const fetched = await this._inFlight.get(requestKey);
            for (const [agentId, detail] of fetched) results.set(agentId, detail);
            await applyPending();
            return finishResults();
        }

        const timeoutState = this._createFetchTimeout(requests.map(request => request.key), requestKey);
        const generation = this._generation;
        const fetchPromise = (async () => {
            const fetched = new Map();
            this._counters.batchStarted++;
            try {
                const resp = await fetch('/api/session-details', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: requests }),
                    signal: timeoutState.signal,
                });
                if (!resp.ok) {
                    this._counters.batchFailed++;
                    return fetched;
                }
                const data = await resp.json();
                if (generation !== this._generation) return fetched;
                const details = data.details || {};
                for (const request of requests) {
                    if (!this._isKeyTokenCurrent(request.key, requestTokens.get(request.key))) continue;
                    const detail = details[request.key];
                    if (!detail) continue;
                    this._storeDetail(request.key, detail);
                    fetched.set(request.sessionId, detail);
                }
                this._trimCache();
                this._counters.batchSucceeded++;
            } catch {
                this._recordTimedFailure(timeoutState, 'batchTimedOut', 'batchFailed');
                // Keep any stale values already returned to the caller.
            }
            return fetched;
        })();

        let trackedBatch = null;
        trackedBatch = fetchPromise.finally(() => {
            timeoutState.clear();
            if (this._inFlight.get(requestKey) === trackedBatch) this._inFlight.delete(requestKey);
        });
        timeoutState.promise = trackedBatch;
        this._inFlight.set(requestKey, trackedBatch);
        for (const request of requests) {
            const token = requestTokens.get(request.key);
            let perKeyPromise = null;
            perKeyPromise = trackedBatch
                .then((fetched) => {
                    if (!this._isKeyTokenCurrent(request.key, token)) return null;
                    return fetched.get(request.sessionId) || this._cache.get(request.key)?.value || null;
                })
                .finally(() => {
                    if (this._inFlight.get(request.key) === perKeyPromise) this._inFlight.delete(request.key);
                    this._releaseKeyTokenIfUnused(request.key, token);
                });
            this._inFlight.set(request.key, perKeyPromise);
        }
        const fetched = await trackedBatch;
        for (const [agentId, detail] of fetched) results.set(agentId, detail);
        await applyPending();
        return finishResults();
    }

    _startFetch(key, agent, fallbackCache) {
        const token = this._keyTokenFor(key);
        const timeoutState = this._createFetchTimeout([key], key);
        const generation = this._generation;

        const fetchPromise = (async () => {
            this._counters.fetchStarted++;
            try {
                const params = new URLSearchParams({
                    sessionId: agent.id,
                    project: agent.projectPath || '',
                    provider: agent.provider || this._defaultProvider,
                });
                const resp = await fetch(`/api/session-detail?${params}`, { signal: timeoutState.signal });
                if (!resp.ok) {
                    if (generation !== this._generation || !this._isKeyTokenCurrent(key, token)) return null;
                    this._counters.fetchFailed++;
                    return fallbackCache ? fallbackCache.value : null;
                }

                const data = await resp.json();
                if (generation !== this._generation || !this._isKeyTokenCurrent(key, token)) return null;
                this._storeDetail(key, data);
                this._trimCache();
                this._counters.fetchSucceeded++;
                return data;
            } catch {
                if (generation !== this._generation || !this._isKeyTokenCurrent(key, token)) return null;
                this._recordTimedFailure(timeoutState, 'fetchTimedOut', 'fetchFailed');
                if (fallbackCache) return fallbackCache.value;
                return null;
            }
        })();

        let trackedPromise = null;
        trackedPromise = fetchPromise
            .then(detail => (this._isKeyTokenCurrent(key, token) ? detail : null))
            .finally(() => {
                timeoutState.clear();
                if (this._inFlight.get(key) === trackedPromise) this._inFlight.delete(key);
                this._releaseKeyTokenIfUnused(key, token);
            });
        timeoutState.promise = trackedPromise;
        this._inFlight.set(key, trackedPromise);
        return trackedPromise;
    }
}

export const sessionDetailsService = new SessionDetailsService();
