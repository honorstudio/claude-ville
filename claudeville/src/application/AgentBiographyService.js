import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';

const FLUSH_DEBOUNCE_MS = 3000;
const WRITE_LEASE_KEY = 'claudeville.biography.writeLease';
const WRITE_LEASE_TTL_MS = 15000;
const SESSION_PUSH_KEY_LIMIT = 96;
export const BIOGRAPHY_CACHE_LIMIT = 256;

function randomToken() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    return (Number(tokens.input) || 0) + (Number(tokens.output) || 0);
}

function isCountablePush(event) {
    if (!event || typeof event !== 'object') return false;
    if (!String(event.type || '').toLowerCase().includes('push')) return false;
    if (event.dryRun === true) return false;
    if (event.success === false) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected') return false;
    return true;
}

function compactEventKey(value) {
    const text = String(value || '');
    if (text.length <= 180) return text;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.slice(0, 120)}:${(hash >>> 0).toString(36)}`;
}

function pushEventKey(event) {
    if (event?.id) return compactEventKey(event.id);
    const source = String(event?.commandHash || event?.command || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return compactEventKey(`push:${event?.ts || event?.timestamp || 0}:${(hash >>> 0).toString(36)}`);
}

function eventTimestamp(event) {
    const raw = event?.completedAt ?? event?.ts ?? event?.timestamp;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function rememberBounded(set, key, limit = SESSION_PUSH_KEY_LIMIT) {
    if (set.has(key)) return false;
    set.add(key);
    while (set.size > limit) set.delete(set.values().next().value);
    return true;
}

function nameFromIdentityKey(identityKey) {
    return String(identityKey || '').split(':').pop() || '';
}

/**
 * Accumulates per-villager biography state (sessions completed, pushes,
 * lifetime tokens, error recoveries, milestones, earned nicknames) across
 * restarts, persisted through the ChronicleStore `biographies` object
 * store. Also persists the one-time village founding record (first-ever
 * villager + timestamp) under the chronicle `meta` store.
 *
 * Emits `biography:updated` on the event bus whenever milestones are
 * earned; cross-tab consumers get `biography-updated` messages on the
 * chronicle BroadcastChannel via `ChronicleStore.putBiography`.
 *
 * Only the tab holding the write lease accumulates and persists, so
 * multiple open tabs do not double-count the same telemetry.
 */
export class AgentBiographyService {
    constructor({ store = null } = {}) {
        this.store = store;
        this._writeLeaseKey = WRITE_LEASE_KEY + (store?.storageNamespace || '');
        this._biographies = new Map(); // identityKey -> Promise<AgentBiography|null>
        this._loadingKeys = new Set();
        this._flushingKeys = new Set();
        this._mutationTails = new Map(); // identityKey -> Promise (serializes mutations)
        this._sessions = new Map(); // agent.id -> { identityKey, tokenBaseline, countedPushKeys, completed }
        this._dirty = new Set();
        this._foundingPromise = null;
        this._flushTimer = null;
        this._flushTail = Promise.resolve();
        this._stopPromise = null;
        this._accepting = false;
        this._leaseToken = randomToken();
        this._unsubscribers = [];
        this._channelListener = null;
    }

    start() {
        if (!this.store || this._accepting || this._stopPromise) return this;
        this._accepting = true;
        const seen = (agent) => this._handleAgentSeen(agent);
        this._unsubscribers.push(eventBus.on('agent:added', seen));
        this._unsubscribers.push(eventBus.on('agent:updated', seen));
        this._unsubscribers.push(eventBus.on('agent:removed', (agent) => this._handleAgentRemoved(agent)));
        this._unsubscribers.push(eventBus.on(
            'chronicle:recorded',
            (record) => this._handleChronicleRecord(record),
        ));
        if (this.store.channel?.addEventListener) {
            this._channelListener = (event) => {
                if (event.data?.type !== 'biography-updated') return;
                // Another tab wrote this biography; drop the cached copy so
                // follower-tab reads pick up the fresh record.
                if (!this._holdsWriteLease()) {
                    this._biographies.delete(event.data.identityKey);
                }
            };
            this.store.channel.addEventListener('message', this._channelListener);
        }
        return this;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        this._accepting = false;
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._unsubscribers = [];
        if (this._channelListener && this.store?.channel?.removeEventListener) {
            this.store.channel.removeEventListener('message', this._channelListener);
        }
        this._channelListener = null;
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        this._stopPromise = (async () => {
            try {
                await Promise.resolve(this._foundingPromise).catch(() => {});
                await this._drainMutations();
                await this.flush();
                await this._flushTail;
            } finally {
                this._releaseWriteLease();
                this._biographies.clear();
                this._loadingKeys.clear();
                this._flushingKeys.clear();
                this._mutationTails.clear();
                this._sessions.clear();
                this._dirty.clear();
            }
        })();
        return this._stopPromise;
    }

    identityKeyFor(agent) {
        return AgentBiography.identityKeyFor(agent);
    }

    /** Read access for renderers and later systems (nicknames, mood, affinity). */
    async getBiography(identityKey) {
        if (!identityKey || !this.store) return null;
        if (!this._biographies.has(identityKey)) {
            this._loadingKeys.add(identityKey);
            const pending = this._load(identityKey).finally(() => {
                this._loadingKeys.delete(identityKey);
                this._pruneBiographyCache();
            });
            this._biographies.set(identityKey, pending);
        } else {
            this._touchBiography(identityKey);
        }
        this._pruneBiographyCache();
        return this._biographies.get(identityKey);
    }

    /** Founding record (`{ identityKey, name, foundedAt }`) or null. */
    async getFounding() {
        if (!this.store) return null;
        return this.store.getFounding();
    }

    flush() {
        const run = this._flushTail.then(() => this._flushDirty());
        this._flushTail = run.catch(() => {});
        return run;
    }

    async _flushDirty() {
        if (!this.store || !this._dirty.size) return;
        const keys = [...this._dirty];
        this._dirty.clear();
        for (const identityKey of keys) this._flushingKeys.add(identityKey);
        for (const identityKey of keys) {
            try {
                const biography = await this._biographies.get(identityKey);
                if (biography) await this.store.putBiography(biography.toRecord());
            } catch (err) {
                this._dirty.add(identityKey);
                console.warn('[AgentBiographyService] flush failed:', err?.message || err);
            } finally {
                this._flushingKeys.delete(identityKey);
            }
        }
        this._pruneBiographyCache();
    }

    _handleAgentSeen(agent) {
        if (!this._accepting || !agent?.id || !this._holdsWriteLease()) return;
        const identityKey = AgentBiography.identityKeyFor(agent);
        if (!identityKey) return;
        let session = this._sessions.get(agent.id);
        let firstObservation = false;
        if (!session) {
            // Baseline at first sight: sessions report cumulative totals, so
            // counting the initial total would double-count on every page
            // reload. Only growth observed by this tab accrues.
            session = {
                identityKey,
                tokenBaseline: tokenTotal(agent),
                countedPushKeys: new Set(),
                lastStatus: null,
                completed: false,
            };
            this._sessions.set(agent.id, session);
            firstObservation = true;
        }
        session.identityKey = identityKey;
        this._ensureFounding(identityKey, agent);

        const status = String(agent.status || '').toLowerCase();
        const recoveredFromError = session.lastStatus === 'errored' && status && status !== 'errored';
        if (status) session.lastStatus = status;

        const total = tokenTotal(agent);
        const tokenDelta = total - session.tokenBaseline;
        session.tokenBaseline = total;

        const observedPushes = [];
        for (const event of agent.gitEvents || []) {
            if (!isCountablePush(event)) continue;
            const key = pushEventKey(event);
            if (!rememberBounded(session.countedPushKeys, key)) continue;
            observedPushes.push({ key, at: eventTimestamp(event) });
        }
        observedPushes.sort((a, b) => a.at - b.at);

        const now = Date.now();
        this._mutate(identityKey, (biography) => {
            biography.noteSeen(now);
            const earned = [];
            if (tokenDelta > 0) earned.push(...biography.addLifetimeTokens(tokenDelta, now));
            for (const push of observedPushes) {
                if (!biography.rememberPushEvent(push.key, push.at)) continue;
                // Existing telemetry is the page's baseline. Only pushes that
                // appear after first observation increase lifetime totals.
                if (!firstObservation) earned.push(...biography.recordPush(push.at || now));
            }
            if (recoveredFromError) earned.push(...biography.recordErrorRecovery(now));
            return earned;
        });
    }

    /**
     * Persist the founding record (first-ever villager + timestamp) once.
     * Prefers the earliest persisted biography so upgrades credit the true
     * first villager rather than whoever happens to load first today.
     */
    _ensureFounding(identityKey, agent) {
        if (!this.store || this._foundingPromise) return this._foundingPromise;
        this._foundingPromise = (async () => {
            try {
                const existing = await this.store.getFounding();
                if (existing) return existing;
                const [earliest] = await this.store.queryRange('biographies', {
                    index: 'firstSeenAt',
                    limit: 1,
                });
                const founderKey = earliest?.identityKey || identityKey;
                const record = await this.store.recordFounding({
                    identityKey: founderKey,
                    name: founderKey === identityKey
                        ? String(agent.name || agent.displayName || nameFromIdentityKey(founderKey))
                        : nameFromIdentityKey(founderKey),
                    foundedAt: Number(earliest?.firstSeenAt) || Date.now(),
                });
                this._mutate(record.identityKey, (biography) => biography.markFounder(record.foundedAt));
                return record;
            } catch (err) {
                this._foundingPromise = null;
                console.warn('[AgentBiographyService] founding record failed:', err?.message || err);
                return null;
            }
        })();
        return this._foundingPromise;
    }

    _handleAgentRemoved(agent) {
        if (!this._accepting || !agent?.id) return;
        const session = this._sessions.get(agent.id);
        this._sessions.delete(agent.id);
        this._pruneBiographyCache();
        if (!session || session.completed || !this._holdsWriteLease()) return;
        session.completed = true;
        const now = Date.now();
        this._mutate(session.identityKey, (biography) => {
            biography.noteSeen(now);
            return biography.recordSessionCompleted(now);
        });
    }

    _handleChronicleRecord(record) {
        if (!this._accepting || !record?.identityKey || !this._holdsWriteLease()) return;
        this._mutate(record.identityKey, (biography) => {
            biography.rememberLifeEpisode(record);
            return [];
        });
    }

    /** Serialize async mutations per identity to avoid lost updates. */
    _mutate(identityKey, mutator) {
        if (!this.store) return;
        const tail = this._mutationTails.get(identityKey) || Promise.resolve();
        const next = tail
            .then(() => this.getBiography(identityKey))
            .then(async (existing) => {
                let biography = existing;
                if (!biography) {
                    biography = AgentBiography.create(identityKey);
                    this._biographies.set(identityKey, Promise.resolve(biography));
                }
                this._touchBiography(identityKey);
                const earned = mutator(biography) || [];
                this._dirty.add(identityKey);
                if (earned.length) {
                    eventBus.emit('biography:updated', { identityKey, biography, milestones: earned });
                    await this.flush();
                } else {
                    this._scheduleFlush();
                }
            })
            .catch((err) => {
                console.warn('[AgentBiographyService] mutation failed:', err?.message || err);
            });
        this._mutationTails.set(identityKey, next);
        next.then(() => {
            if (this._mutationTails.get(identityKey) === next) {
                this._mutationTails.delete(identityKey);
                this._pruneBiographyCache();
            }
        });
    }

    async _drainMutations() {
        while (this._mutationTails.size) {
            await Promise.allSettled([...this._mutationTails.values()]);
        }
    }

    async _load(identityKey) {
        try {
            const record = await this.store.getBiography(identityKey);
            return AgentBiography.fromRecord(record);
        } catch (err) {
            console.warn('[AgentBiographyService] load failed:', err?.message || err);
            return null;
        }
    }

    _touchBiography(identityKey) {
        const pending = this._biographies.get(identityKey);
        if (!pending) return;
        this._biographies.delete(identityKey);
        this._biographies.set(identityKey, pending);
    }

    _pruneBiographyCache() {
        if (this._biographies.size <= BIOGRAPHY_CACHE_LIMIT) return;
        const pinned = new Set([
            ...this._dirty,
            ...this._loadingKeys,
            ...this._flushingKeys,
            ...this._mutationTails.keys(),
        ]);
        for (const session of this._sessions.values()) {
            if (session.identityKey) pinned.add(session.identityKey);
        }
        for (const identityKey of this._biographies.keys()) {
            if (this._biographies.size <= BIOGRAPHY_CACHE_LIMIT) break;
            if (!pinned.has(identityKey)) this._biographies.delete(identityKey);
        }
    }

    _scheduleFlush() {
        if (!this._accepting || this._flushTimer) return;
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush().catch(() => {});
        }, FLUSH_DEBOUNCE_MS);
    }

    _holdsWriteLease() {
        if (typeof localStorage === 'undefined') return true;
        const now = Date.now();
        try {
            const raw = localStorage.getItem(this._writeLeaseKey);
            const current = raw ? JSON.parse(raw) : null;
            if (current && current.token !== this._leaseToken && Number(current.expiresAt) > now) {
                return false;
            }
            localStorage.setItem(this._writeLeaseKey, JSON.stringify({
                token: this._leaseToken,
                expiresAt: now + WRITE_LEASE_TTL_MS,
            }));
            return true;
        } catch {
            return true;
        }
    }

    _releaseWriteLease() {
        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem(this._writeLeaseKey);
            const current = raw ? JSON.parse(raw) : null;
            if (current?.token === this._leaseToken) localStorage.removeItem(this._writeLeaseKey);
        } catch { /* ignore */ }
    }
}
