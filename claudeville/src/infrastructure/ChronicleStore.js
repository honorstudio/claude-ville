import { eventBus } from '../domain/events/DomainEvent.js';

const DB_NAME = 'claudeville-chronicle';
const DB_VERSION = 7;
const LEASE_KEY = 'claudeville.chronicle.captureLease';
const DEFAULT_LEASE_TTL_MS = 7000;
const LIFETIME_COUNTS_META_KEY = 'lifetimeCounts';
const LIFETIME_COMMIT_ID_LIMIT = 4096;
const LATEST_COMMIT_IDS_PER_PROJECT_LIMIT = 64;
const FOUNDING_META_KEY = 'founding';
const EVENT_RETENTION_DAYS = 14;
const EVENT_RETENTION_MAX_ROWS = 20_000;
const CHRONICLE_OPEN_TIMEOUT_MS = 5000;

const RETENTION_MS = {
    manifests: 24 * 60 * 60 * 1000,
    pinnedManifest: 7 * 24 * 60 * 60 * 1000,
    monuments: 30 * 24 * 60 * 60 * 1000,
    trailSamples: 24 * 60 * 60 * 1000,
    affinities: 30 * 24 * 60 * 60 * 1000,
};

export function eventRetentionCutoff(now = nowMs(), retentionDays = EVENT_RETENTION_DAYS) {
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Math.max(0, retentionDays - 1));
    return cutoff.getTime();
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function randomToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowMs() {
    return Date.now();
}

function normalizedStatusReason(value) {
    if (value == null) return null;
    const reason = String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return reason || 'unavailable';
}

function storeConfig(name) {
    return {
        manifests: { keyPath: 'id', indexes: ['project', 'ts', 'pinned'] },
        monuments: { keyPath: 'id', indexes: ['district', 'plantedAt', 'ts', 'dedupKey'] },
        trailSamples: { keyPath: 'id', indexes: ['agentId', 'ts'] },
        auroraLog: { keyPath: 'localDate', indexes: ['ts'] },
        biographies: { keyPath: 'identityKey', indexes: ['firstSeenAt', 'lastSeenAt'] },
        events: { keyPath: 'id', indexes: ['ts', 'kind', 'localDate', 'identityKey'] },
        affinities: { keyPath: 'pairKey', indexes: ['lastInteractionAt'] },
        meta: { keyPath: 'key', indexes: [] },
    }[name];
}

export class ChronicleStore {
    constructor({
        dbName = DB_NAME,
        openTimeoutMs = CHRONICLE_OPEN_TIMEOUT_MS,
        onStatusChange = null,
    } = {}) {
        this.dbName = dbName;
        this.storageNamespace = dbName === DB_NAME ? '' : `:${dbName}`;
        this.captureLeaseKey = LEASE_KEY + this.storageNamespace;
        this.eventRetentionDays = EVENT_RETENTION_DAYS;
        this.openTimeoutMs = Number.isFinite(Number(openTimeoutMs))
            ? Math.max(1, Number(openTimeoutMs))
            : CHRONICLE_OPEN_TIMEOUT_MS;
        this.db = null;
        this.status = 'idle';
        this.isDegraded = false;
        this.degradedReason = null;
        this.degradedError = null;
        this._statusListener = typeof onStatusChange === 'function' ? onStatusChange : null;
        this.channel = typeof BroadcastChannel !== 'undefined'
            ? new BroadcastChannel(DB_NAME + this.storageNamespace)
            : null;
        this._leaseToken = null;
        this._lastLeaseNotice = 0;
        this._lifetimeCounts = null;
        this._recentCommitIds = null;
        this._lifetimeCountsLoad = null;
        this._lifetimeWriteTail = Promise.resolve();
        this._openPromise = null;
        this._closed = false;
        this._onChannelMessage = (event) => {
            if (event.data?.type === 'lease-acquired') {
                this._lastLeaseNotice = nowMs();
            }
            if (event.data?.type === 'lifetime-counts-updated') {
                this._lifetimeCounts = null;
                this._recentCommitIds = null;
                this._lifetimeCountsLoad = null;
            }
        };
        this.channel?.addEventListener?.('message', this._onChannelMessage);
    }

    open() {
        if (this._closed) return Promise.reject(new Error('ChronicleStore is closed'));
        if (this.db) return Promise.resolve(this);
        if (this._openPromise) return this._openPromise;
        if (this.degradedError) return Promise.reject(this.degradedError);
        if (typeof indexedDB === 'undefined') {
            const error = new Error('IndexedDB is not available in this browser context');
            this._setStatus('degraded', { reason: 'indexeddb-unavailable', error });
            return Promise.reject(error);
        }
        this._setStatus('opening');

        let request;
        try {
            request = indexedDB.open(this.dbName, DB_VERSION);
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this._setStatus('degraded', { reason: 'open-failed', error: normalized });
            return Promise.reject(normalized);
        }

        const openPromise = new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            let cancelOpen = null;

            const cleanup = () => {
                if (timeoutId !== null) clearTimeout(timeoutId);
                timeoutId = null;
                if (this._openCancel === cancelOpen) this._openCancel = null;
            };

            const fail = (error, reason) => {
                if (settled) return;
                settled = true;
                cleanup();
                const normalized = error instanceof Error
                    ? error
                    : new Error(String(error || 'ChronicleStore failed to open'));
                this._setStatus('degraded', { reason, error: normalized });
                reject(normalized);
            };

            const succeed = (db) => {
                if (settled) {
                    db?.close?.();
                    return;
                }
                settled = true;
                cleanup();
                if (this._closed) {
                    db?.close?.();
                    reject(new Error('ChronicleStore closed while opening'));
                    return;
                }
                db.onversionchange = () => {
                    // Let a newer schema version proceed in another tab. An
                    // old open connection otherwise holds the upgrade hostage.
                    try { db.close?.(); } catch { /* best effort */ }
                    if (this.db !== db || this._closed) return;
                    this.db = null;
                    this._setStatus('idle');
                };
                this.db = db;
                this._setStatus('ready');
                resolve(this);
            };

            cancelOpen = () => fail(new Error('ChronicleStore closed while opening'), 'closed');
            this._openCancel = cancelOpen;

            request.onupgradeneeded = () => {
                try {
                    const db = request.result;
                    const tx = request.transaction;
                    for (const name of ['manifests', 'monuments', 'trailSamples', 'auroraLog', 'biographies', 'affinities', 'events', 'meta']) {
                        const config = storeConfig(name);
                        this._ensureStore(db, tx, name, config.keyPath, config.indexes);
                    }
                } catch (error) {
                    try { request.transaction?.abort?.(); } catch { /* best effort */ }
                    fail(error, 'upgrade-failed');
                }
            };
            request.onblocked = () => {
                if (!settled) {
                    // Keep trying briefly so an older tab can receive
                    // versionchange and close, but expose the degraded state
                    // immediately instead of leaving startup looking frozen.
                    this._setStatus('degraded', { reason: 'upgrade-blocked', terminal: false });
                }
            };
            request.onerror = () => fail(request.error, 'open-failed');
            request.onsuccess = () => succeed(request.result);

            timeoutId = setTimeout(() => {
                const blocked = this.degradedReason === 'upgrade-blocked';
                const reason = blocked ? 'upgrade-blocked-timeout' : 'open-timeout';
                const error = new Error(
                    `ChronicleStore open timed out after ${this.openTimeoutMs}ms`,
                );
                error.code = 'CHRONICLE_STORE_OPEN_TIMEOUT';
                fail(error, reason);
            }, this.openTimeoutMs);
            timeoutId?.unref?.();
        });
        this._openPromise = openPromise;
        openPromise.then(
            () => { if (this._openPromise === openPromise) this._openPromise = null; },
            () => { if (this._openPromise === openPromise) this._openPromise = null; },
        );
        return openPromise;
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._openCancel?.();
        this.db?.close?.();
        this.db = null;
        this.channel?.removeEventListener?.('message', this._onChannelMessage);
        this.channel?.close?.();
        this.channel = null;
        this._setStatus('closed');
    }

    _setStatus(status, { reason = null, error = null, terminal = true } = {}) {
        this.status = status;
        this.isDegraded = status === 'degraded';
        if (status === 'degraded') {
            this.degradedReason = normalizedStatusReason(reason);
            if (terminal && error) this.degradedError = error;
            const detail = error?.message ? `: ${error.message}` : '';
            console.warn(`[ChronicleStore] degraded (${reason || 'unavailable'})${detail}`);
        } else {
            this.degradedReason = null;
            this.degradedError = null;
        }
        try {
            this._statusListener?.({
                status: this.status,
                isDegraded: this.isDegraded,
                reason: this.degradedReason,
                error: this.degradedError,
            });
        } catch { /* status reporting must never break storage */ }
        eventBus.emit('chronicle:status', {
            status: this.status,
            reason: this.degradedReason,
        });
    }

    async put(storeName, record) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        await txDone(tx);
        return record;
    }

    async bulkPut(storeName, records = []) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const record of records) store.put(record);
        await txDone(tx);
        return records.length;
    }

    async get(storeName, key) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        return requestToPromise(tx.objectStore(storeName).get(key));
    }

    async deleteKey(storeName, key) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        await txDone(tx);
    }

    async queryRange(storeName, indexOrOptions = 'ts', lowerArg = null, upperArg = null, optsArg = {}) {
        const options = typeof indexOrOptions === 'object'
            ? indexOrOptions
            : { index: indexOrOptions, lower: lowerArg, upper: upperArg, ...optsArg };
        const {
            index = 'ts',
            lower = null,
            upper = null,
            limit = Infinity,
            direction = 'next',
        } = options;
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        const range = this._range(lower, upper);
        const out = [];
        await new Promise((resolve, reject) => {
            const request = source.openCursor(range, direction);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || out.length >= limit) {
                    resolve();
                    return;
                }
                out.push(cursor.value);
                cursor.continue();
            };
        });
        return out;
    }

    async reduceRange(storeName, options, reducer, initialValue) {
        if (typeof reducer !== 'function') throw new TypeError('reduceRange requires a reducer');
        const {
            index = 'ts',
            lower = null,
            upper = null,
            direction = 'next',
        } = options || {};
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        const range = this._range(lower, upper);
        let accumulator = initialValue;
        await new Promise((resolve, reject) => {
            const request = source.openCursor(range, direction);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                try {
                    accumulator = reducer(accumulator, cursor.value);
                } catch (error) {
                    reject(error);
                    return;
                }
                cursor.continue();
            };
        });
        return accumulator;
    }

    async deleteRange(storeName, { index = 'ts', lower = null, upper = null } = {}) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        const range = this._range(lower, upper);
        let deleted = 0;
        await new Promise((resolve, reject) => {
            const request = source.openCursor(range);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                cursor.delete();
                deleted++;
                cursor.continue();
            };
        });
        await txDone(tx);
        return deleted;
    }

    async count(storeName, indexName = null, range = null) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const source = indexName && store.indexNames.contains(indexName) ? store.index(indexName) : store;
        return requestToPromise(source.count(range));
    }

    async prune(now = nowMs()) {
        const manifestCutoff = now - RETENTION_MS.manifests;
        const pinnedCutoff = now - RETENTION_MS.pinnedManifest;
        const monumentCutoff = now - RETENTION_MS.monuments;
        const trailCutoff = now - RETENTION_MS.trailSamples;
        const deleted = {
            manifests: await this._deleteWhere('manifests', record => (
                Number(record.ts || 0) < (record.pinned ? pinnedCutoff : manifestCutoff)
            )),
            monuments: await this.deleteRange('monuments', { index: 'plantedAt', upper: monumentCutoff }),
            trailSamples: await this.deleteRange('trailSamples', { upper: trailCutoff }),
            affinities: await this.deleteRange('affinities', {
                index: 'lastInteractionAt',
                upper: now - RETENTION_MS.affinities,
            }),
            // Keep complete local calendar days rather than a rolling duration:
            // yesterday should not disappear part-way through the afternoon.
            events: await this.deleteRange('events', {
                upper: eventRetentionCutoff(now, this.eventRetentionDays) - 1,
            }),
        };
        const overflowEvents = await this._trimOldest('events', EVENT_RETENTION_MAX_ROWS, 'ts');
        deleted.events += overflowEvents;
        await this.put('meta', { key: 'lastPruneAt', value: now });
        return deleted;
    }

    async getMeta(key, fallback = null) {
        const row = await this.get('meta', key);
        return row ? row.value : fallback;
    }

    async setMeta(key, value) {
        return this.put('meta', { key, value, ts: nowMs() });
    }

    async _loadLifetimeCounts() {
        if (this._lifetimeCounts) return this._lifetimeCounts;
        if (this._lifetimeCountsLoad) return this._lifetimeCountsLoad;
        this._lifetimeCountsLoad = (async () => {
            const raw = await this.getMeta(LIFETIME_COUNTS_META_KEY, null).catch(() => null);
            const map = new Map();
            const projects = raw?.version === 2 ? raw.projects : raw;
            if (projects && typeof projects === 'object') {
                const entries = projects instanceof Map ? projects.entries() : Object.entries(projects);
                for (const [project, value] of entries) {
                    const key = String(project || '').trim();
                    if (!key) continue;
                    const commits = Number((value && value.commits) ?? 0);
                    if (!Number.isFinite(commits) || commits <= 0) continue;
                    const lastUpdated = Number((value && value.lastUpdated) ?? 0);
                    const latestCommitAt = Number((value && value.latestCommitAt) ?? 0);
                    const latestCommitIds = Array.isArray(value?.latestCommitIds)
                        ? value.latestCommitIds.slice(-LATEST_COMMIT_IDS_PER_PROJECT_LIMIT).map(id => String(id))
                        : [];
                    map.set(key, {
                        commits,
                        lastUpdated: Number.isFinite(lastUpdated) ? lastUpdated : 0,
                        latestCommitAt: Number.isFinite(latestCommitAt) ? latestCommitAt : 0,
                        latestCommitIds,
                        identitySeeded: raw?.version === 2 ? value?.identitySeeded !== false : false,
                    });
                }
            }
            this._lifetimeCounts = map;
            this._recentCommitIds = new Set(
                (Array.isArray(raw?.recentCommitIds) ? raw.recentCommitIds : [])
                    .slice(-LIFETIME_COMMIT_ID_LIMIT)
                    .map(id => String(id)),
            );
            return map;
        })();
        return this._lifetimeCountsLoad;
    }

    async _persistLifetimeCounts() {
        if (!this._lifetimeCounts) return;
        const out = {};
        for (const [project, entry] of this._lifetimeCounts.entries()) {
            out[project] = {
                commits: entry.commits,
                lastUpdated: entry.lastUpdated,
                latestCommitAt: entry.latestCommitAt || 0,
                latestCommitIds: (entry.latestCommitIds || []).slice(-LATEST_COMMIT_IDS_PER_PROJECT_LIMIT),
                identitySeeded: entry.identitySeeded !== false,
            };
        }
        try {
            await this.setMeta(LIFETIME_COUNTS_META_KEY, {
                version: 2,
                projects: out,
                recentCommitIds: [...(this._recentCommitIds || [])],
            });
            this.channel?.postMessage?.({ type: 'lifetime-counts-updated' });
        } catch { /* persist is best-effort */ }
    }

    async recordCommit(projectId, now = nowMs()) {
        const [result] = await this.recordCommitEvents([{ projectId, observedAt: now }]);
        return result?.count || 0;
    }

    async recordCommitEvent(projectId, commitId, observedAt = nowMs()) {
        const [result] = await this.recordCommitEvents([{ projectId, commitId, observedAt }]);
        return result || { count: 0, recorded: false };
    }

    recordCommitEvents(events = []) {
        const run = async () => {
            const execute = () => this._recordCommitEventsLocked(events);
            if (typeof navigator !== 'undefined' && navigator.locks?.request) {
                return navigator.locks.request(`claudeville-lifetime-counts:${this.dbName}`, execute);
            }
            return execute();
        };
        const pending = this._lifetimeWriteTail.then(run, run);
        this._lifetimeWriteTail = pending.then(() => undefined, () => undefined);
        return pending;
    }

    async _recordCommitEventsLocked(events = []) {
        this._lifetimeCounts = null;
        this._recentCommitIds = null;
        this._lifetimeCountsLoad = null;
        const counts = await this._loadLifetimeCounts();
        const recentIds = this._recentCommitIds || new Set();
        this._recentCommitIds = recentIds;
        const results = [];
        let changed = false;
        const bootstrapProjects = new Set();
        for (const event of events) {
            const projectKey = String(event?.projectId || '').trim() || 'unknown';
            if (counts.get(projectKey)?.identitySeeded === false) bootstrapProjects.add(projectKey);
        }

        for (const event of events) {
            const projectKey = String(event?.projectId || '').trim() || 'unknown';
            const observedAt = Number.isFinite(Number(event?.observedAt)) ? Number(event.observedAt) : nowMs();
            const commitId = String(event?.commitId || '').trim();
            const identity = commitId ? `${projectKey}\u0000${commitId}` : '';
            const previous = counts.get(projectKey) || {
                commits: 0,
                lastUpdated: 0,
                latestCommitAt: 0,
                latestCommitIds: [],
                identitySeeded: true,
            };
            const latestCommitIds = Array.isArray(previous.latestCommitIds) ? previous.latestCommitIds : [];
            if (bootstrapProjects.has(projectKey)) {
                const nextLatestIds = observedAt > (previous.latestCommitAt || 0)
                    ? (identity ? [identity] : [])
                    : observedAt === (previous.latestCommitAt || 0)
                        ? [...latestCommitIds, ...(identity ? [identity] : [])]
                            .slice(-LATEST_COMMIT_IDS_PER_PROJECT_LIMIT)
                        : latestCommitIds;
                counts.set(projectKey, {
                    ...previous,
                    latestCommitAt: Math.max(previous.latestCommitAt || 0, observedAt),
                    latestCommitIds: nextLatestIds,
                });
                if (identity) recentIds.add(identity);
                results.push({ count: previous.commits, recorded: false, seeded: true });
                changed = true;
                continue;
            }
            if (
                identity
                && (
                    recentIds.has(identity)
                    || (previous.latestCommitAt > 0 && observedAt < previous.latestCommitAt)
                    || (observedAt === previous.latestCommitAt && latestCommitIds.includes(identity))
                )
            ) {
                results.push({ count: previous.commits, recorded: false });
                continue;
            }

            const nextLatestIds = observedAt > (previous.latestCommitAt || 0)
                ? (identity ? [identity] : [])
                : [...latestCommitIds, ...(identity ? [identity] : [])]
                    .slice(-LATEST_COMMIT_IDS_PER_PROJECT_LIMIT);
            const next = {
                commits: previous.commits + 1,
                lastUpdated: nowMs(),
                latestCommitAt: Math.max(previous.latestCommitAt || 0, observedAt),
                latestCommitIds: nextLatestIds,
                identitySeeded: true,
            };
            counts.set(projectKey, next);
            if (identity) recentIds.add(identity);
            results.push({ count: next.commits, recorded: true });
            changed = true;
        }

        for (const projectKey of bootstrapProjects) {
            const entry = counts.get(projectKey);
            if (entry) counts.set(projectKey, { ...entry, identitySeeded: true });
        }

        if (recentIds.size > LIFETIME_COMMIT_ID_LIMIT) {
            this._recentCommitIds = new Set([...recentIds].slice(-LIFETIME_COMMIT_ID_LIMIT));
        }
        if (changed) await this._persistLifetimeCounts();
        return results;
    }

    async getLifetimeCommitCount(projectId) {
        const key = String(projectId || '').trim() || 'unknown';
        const counts = await this._loadLifetimeCounts();
        return counts.get(key)?.commits || 0;
    }

    async getBiography(identityKey) {
        return this.get('biographies', identityKey);
    }

    async putBiography(record) {
        await this.put('biographies', record);
        this.channel?.postMessage?.({
            type: 'biography-updated',
            identityKey: record.identityKey,
            schemaVersion: record.schemaVersion,
        });
        return record;
    }

    /** Founding record: `{ identityKey, name, foundedAt }` or null. */
    async getFounding() {
        return this.getMeta(FOUNDING_META_KEY, null);
    }

    /**
     * Persist the village founding record exactly once. Later calls
     * return the original record unchanged.
     */
    async recordFounding(record) {
        const existing = await this.getFounding();
        if (existing) return existing;
        await this.setMeta(FOUNDING_META_KEY, record);
        return record;
    }

    async getAffinity(pairKey) {
        return this.get('affinities', pairKey);
    }

    async getAllAffinities({ since = null, limit = Infinity } = {}) {
        if (Number.isFinite(since)) {
            return this.queryRange('affinities', {
                index: 'lastInteractionAt',
                lower: since,
                direction: 'prev',
                limit,
            });
        }
        if (Number.isFinite(limit)) {
            return this.queryRange('affinities', {
                index: 'lastInteractionAt',
                direction: 'prev',
                limit,
            });
        }
        await this.open();
        const tx = this.db.transaction('affinities', 'readonly');
        return requestToPromise(tx.objectStore('affinities').getAll());
    }

    async putAffinity(record) {
        await this.put('affinities', record);
        this.channel?.postMessage?.({
            type: 'affinity-updated',
            pairKey: record.pairKey,
            schemaVersion: record.schemaVersion,
        });
        return record;
    }

    acquireCaptureLease({ ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
        const token = randomToken();
        const expiresAt = nowMs() + ttlMs;
        const current = this._readLease();
        if (current && current.expiresAt > nowMs() && current.token !== token) {
            return {
                acquired: false,
                token: current.token,
                expiresAt: current.expiresAt,
                renew: () => false,
                release: () => false,
            };
        }

        this._writeLease({ token, expiresAt });
        const confirmed = this._readLease();
        const acquired = confirmed?.token === token;
        if (acquired) {
            this._leaseToken = token;
            this.channel?.postMessage?.({ type: 'lease-acquired', token, expiresAt });
        }

        return {
            acquired,
            token,
            expiresAt,
            renew: () => this._renewLease(token, ttlMs),
            release: () => this._releaseLease(token),
        };
    }

    _ensureStore(db, tx, name, keyPath, indexes) {
        let store;
        if (db.objectStoreNames.contains(name)) {
            store = tx.objectStore(name);
            if (store.keyPath !== keyPath) {
                throw new Error(`Chronicle store ${name} has an incompatible key path`);
            }
        } else {
            store = db.createObjectStore(name, { keyPath });
        }
        for (const indexName of indexes) {
            if (!store.indexNames.contains(indexName)) store.createIndex(indexName, indexName, { unique: false });
        }
    }

    _range(lower, upper) {
        if (lower != null && upper != null) return IDBKeyRange.bound(lower, upper);
        if (lower != null) return IDBKeyRange.lowerBound(lower);
        if (upper != null) return IDBKeyRange.upperBound(upper);
        return null;
    }

    async _deleteWhere(storeName, predicate) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let deleted = 0;
        await new Promise((resolve, reject) => {
            const request = store.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (predicate(cursor.value)) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
        });
        await txDone(tx);
        return deleted;
    }

    async _trimOldest(storeName, maxRows, index = 'ts') {
        const total = await this.count(storeName);
        let remaining = Math.max(0, total - maxRows);
        if (!remaining) return 0;
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const source = index && store.indexNames.contains(index) ? store.index(index) : store;
        let deleted = 0;
        await new Promise((resolve, reject) => {
            const request = source.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || remaining <= 0) {
                    resolve();
                    return;
                }
                cursor.delete();
                deleted++;
                remaining--;
                cursor.continue();
            };
        });
        await txDone(tx);
        return deleted;
    }

    _readLease() {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(this.captureLeaseKey);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    _writeLease(record) {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(this.captureLeaseKey, JSON.stringify(record));
        } catch { /* ignore */ }
    }

    _renewLease(token, ttlMs) {
        const current = this._readLease();
        if (!current || current.token !== token) return false;
        const expiresAt = nowMs() + ttlMs;
        this._writeLease({ token, expiresAt });
        this.channel?.postMessage?.({ type: 'lease-renewed', token, expiresAt });
        return true;
    }

    _releaseLease(token) {
        const current = this._readLease();
        if (!current || current.token !== token) return false;
        try {
            localStorage.removeItem(this.captureLeaseKey);
        } catch { /* ignore */ }
        this.channel?.postMessage?.({ type: 'lease-released', token });
        if (this._leaseToken === token) this._leaseToken = null;
        return true;
    }
}

export {
    DB_NAME,
    DB_VERSION,
    CHRONICLE_OPEN_TIMEOUT_MS,
    EVENT_RETENTION_DAYS,
    EVENT_RETENTION_MAX_ROWS,
    RETENTION_MS,
};
