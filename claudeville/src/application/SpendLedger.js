import { eventBus } from '../domain/events/DomainEvent.js';
import { TokenUsage } from '../domain/value-objects/TokenUsage.js';

// What the topbar used to show was the sum of every resident session's
// lifetime cost. It lurched whenever a session appeared or aged out, it was
// not "today", and for a subscription account the dollar figure is a fiction:
// the currency that actually runs out is quota, not money.
//
// SpendLedger answers the question the product claims to answer — "am I
// burning tokens?" — with three honest numbers: what today has cost so far,
// how fast it is going right now, and how much quota is left.
//
// It works from deltas. Session token counts only ever grow, so the increase
// between two observations is spend that happened while we were watching. That
// makes "today" mean "today, as observed by this page" — stated plainly in the
// UI rather than dressed up as a complete account.

const RATE_WINDOW_MS = 5 * 60 * 1000;
// Extrapolating a ten-second burst to an hour produces nonsense. Say nothing
// until the window is wide enough for the number to mean something.
const RATE_MIN_WINDOW_MS = 2 * 60 * 1000;
const LEDGER_KEY_PREFIX = 'usageLedger:';

// Cache reads are the same prompt being re-read every turn, so they dominate
// any raw token count — a busy hour can "spend" hundreds of millions of them
// without new work happening. The headline counts tokens that are genuinely
// new; cache reads are tracked separately and priced into cost, where they
// belong.
function newTokens(usage) {
    const normalized = TokenUsage.normalize(usage);
    return normalized.totalInput + normalized.totalOutput + normalized.cacheCreate;
}

function cacheReadTokens(usage) {
    return TokenUsage.normalize(usage).cacheRead;
}

function localDateKey(ts = Date.now()) {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function projectKey(agent) {
    const path = String(agent?.projectPath || '').trim();
    return path || 'unattributed';
}

function providerKey(agent) {
    const provider = String(agent?.provider || '').trim().toLowerCase();
    return provider || 'unknown';
}

function emptyTotal() {
    return { tokens: 0, cacheRead: 0, cost: 0 };
}

function addTo(map, key, { tokens = 0, cacheRead = 0, cost = 0 }) {
    const total = map.get(key) || emptyTotal();
    total.tokens += tokens;
    total.cacheRead += cacheRead;
    total.cost += cost;
    map.set(key, total);
}

function restoreTotals(value) {
    const totals = new Map();
    if (!Array.isArray(value)) return totals;
    for (const row of value) {
        const key = String(row?.key || '').trim();
        if (!key) continue;
        totals.set(key, {
            tokens: Number(row.tokens) || 0,
            cacheRead: Number(row.cacheRead) || 0,
            cost: Number(row.cost) || 0,
        });
    }
    return totals;
}

export class SpendLedger {
    constructor(world, { store = null } = {}) {
        this.world = world;
        this.store = store;
        this.running = false;
        this.date = localDateKey();
        this.today = { tokens: 0, cacheRead: 0, cost: 0 };
        this._todayByProject = new Map();
        this._todayByProvider = new Map();
        this._lastSeen = new Map();   // agentId → counters + attribution keys
        this._samples = [];           // attributed deltas inside the rate window
        this._loaded = false;
        this._writeTail = Promise.resolve();
        this._stopPromise = null;
    }

    async start() {
        if (this.running) return this;
        this._stopPromise = null;
        this.running = true;
        await this._load();
        this._onChange = () => this.sample();
        eventBus.on('agent:added', this._onChange);
        eventBus.on('agent:updated', this._onChange);
        // A removed agent's last observation stays banked; only the baseline goes.
        this._onRemoved = (agent) => this._lastSeen.delete(agent.id);
        eventBus.on('agent:removed', this._onRemoved);
        this.sample();
        return this;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        if (this.running) {
            this.running = false;
            eventBus.off('agent:added', this._onChange);
            eventBus.off('agent:updated', this._onChange);
            eventBus.off('agent:removed', this._onRemoved);
        }
        this._stopPromise = this.flush();
        return this._stopPromise;
    }

    /**
     * Fold the world's current token counts into today's total.
     *
     * A session first seen mid-flight contributes nothing retroactively — its
     * running total becomes the baseline, and only growth from there counts.
     * Anything else would let a long-running session dump hours of history into
     * "today" the moment the page opened.
     */
    sample(now = Date.now()) {
        const date = localDateKey(now);
        if (date !== this.date) this._rollOver(date);

        const delta = emptyTotal();
        const projectDeltas = new Map();
        const providerDeltas = new Map();

        for (const agent of this.world?.agents?.values?.() || []) {
            const tokens = newTokens(agent.tokens);
            const cacheRead = cacheReadTokens(agent.tokens);
            const cost = Number(agent.cost) || 0;
            const project = projectKey(agent);
            const provider = providerKey(agent);
            const previous = this._lastSeen.get(agent.id);
            this._lastSeen.set(agent.id, { tokens, cacheRead, cost, project, provider });
            if (!previous) continue;
            // Project and provider are session identity. If either changes under
            // a reused id, the interval cannot be attributed honestly.
            if (previous.project !== project || previous.provider !== provider) continue;
            // Counters only grow; a decrease means the session was replaced or
            // recounted, so re-baseline instead of banking a negative.
            const observed = {
                tokens: tokens > previous.tokens ? tokens - previous.tokens : 0,
                cacheRead: cacheRead > previous.cacheRead ? cacheRead - previous.cacheRead : 0,
                cost: cost > previous.cost ? cost - previous.cost : 0,
            };
            if (observed.tokens <= 0 && observed.cacheRead <= 0 && observed.cost <= 0) continue;
            addTo(projectDeltas, project, observed);
            addTo(providerDeltas, provider, observed);
            delta.tokens += observed.tokens;
            delta.cacheRead += observed.cacheRead;
            delta.cost += observed.cost;
        }

        if (delta.tokens > 0 || delta.cacheRead > 0 || delta.cost > 0) {
            this.today.tokens += delta.tokens;
            this.today.cacheRead += delta.cacheRead;
            this.today.cost += delta.cost;
            for (const [key, observed] of projectDeltas) {
                addTo(this._todayByProject, key, observed);
                this._samples.push({ ts: now, dimension: 'project', key, ...observed });
            }
            for (const [key, observed] of providerDeltas) {
                addTo(this._todayByProvider, key, observed);
                this._samples.push({ ts: now, dimension: 'provider', key, ...observed });
            }
            this._samples.push({ ts: now, dimension: 'total', key: 'total', ...delta });
            this._persist();
        }

        const cutoff = now - RATE_WINDOW_MS;
        while (this._samples.length && this._samples[0].ts < cutoff) this._samples.shift();
        return this.today;
    }

    /**
     * Spend rate over the trailing window, extrapolated to an hour. Null until
     * there is enough of a window to say anything honest.
     */
    burnRate(now = Date.now()) {
        return this._rateFor('total', 'total', now);
    }

    /**
     * Today's observed spend grouped by the domain's existing projectPath and
     * provider identities. Rows include active zero-spend groups so a newly
     * discovered project reads as "watching", not as missing telemetry.
     */
    rollups(now = Date.now()) {
        const activeProjects = new Map();
        const activeProviders = new Map();
        for (const agent of this.world?.agents?.values?.() || []) {
            const project = projectKey(agent);
            const provider = providerKey(agent);
            activeProjects.set(project, (activeProjects.get(project) || 0) + 1);
            activeProviders.set(provider, (activeProviders.get(provider) || 0) + 1);
        }
        return {
            projects: this._rollupRows('project', this._todayByProject, activeProjects, now),
            providers: this._rollupRows('provider', this._todayByProvider, activeProviders, now),
        };
    }

    _rateFor(dimension, key, now) {
        const samples = this._samples.filter(sample => sample.dimension === dimension && sample.key === key);
        if (samples.length < 2) return null;
        const span = now - samples[0].ts;
        if (span < RATE_MIN_WINDOW_MS) return null;
        const hours = span / 3_600_000;
        const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
        const cost = samples.reduce((sum, sample) => sum + sample.cost, 0);
        return { tokensPerHour: tokens / hours, costPerHour: cost / hours };
    }

    _rollupRows(dimension, totals, active, now) {
        const keys = new Set([...totals.keys(), ...active.keys()]);
        return [...keys].map((key) => {
            const total = totals.get(key) || emptyTotal();
            return {
                key,
                ...total,
                activeSessions: active.get(key) || 0,
                burnRate: this._rateFor(dimension, key, now),
            };
        }).sort((a, b) => {
            const aRate = a.burnRate?.costPerHour || 0;
            const bRate = b.burnRate?.costPerHour || 0;
            return bRate - aRate
                || (b.burnRate?.tokensPerHour || 0) - (a.burnRate?.tokensPerHour || 0)
                || b.cost - a.cost
                || b.tokens - a.tokens
                || a.key.localeCompare(b.key);
        });
    }

    _rollOver(date) {
        this.date = date;
        this.today = { tokens: 0, cacheRead: 0, cost: 0 };
        this._todayByProject.clear();
        this._todayByProvider.clear();
        this._samples = [];
        // Baselines survive the rollover: a session running across midnight
        // should contribute its post-midnight growth to the new day, not all of
        // its lifetime.
    }

    async _load() {
        if (!this.store || this._loaded) return;
        this._loaded = true;
        try {
            const record = await this.store.get('meta', `${LEDGER_KEY_PREFIX}${this.date}`);
            if (record?.value) {
                this.today = {
                    tokens: Number(record.value.tokens) || 0,
                    cacheRead: Number(record.value.cacheRead) || 0,
                    cost: Number(record.value.cost) || 0,
                };
                this._todayByProject = restoreTotals(record.value.projects);
                this._todayByProvider = restoreTotals(record.value.providers);
            }
        } catch { /* a missing ledger just starts the day at zero */ }
    }

    _persist() {
        if (!this.store) return;
        const key = `${LEDGER_KEY_PREFIX}${this.date}`;
        const serialize = (totals) => [...totals].map(([key, value]) => ({ key, ...value }));
        const value = {
            ...this.today,
            projects: serialize(this._todayByProject),
            providers: serialize(this._todayByProvider),
        };
        this._writeTail = this._writeTail
            .then(() => this.store.put('meta', { key, value }))
            .catch(() => { /* the ledger is best effort */ });
    }

    flush() {
        return this._writeTail;
    }
}
