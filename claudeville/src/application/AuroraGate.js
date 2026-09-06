const QUOTA_DROP_THRESHOLD = 0.5;
const MILESTONE_WINDOW_MS = 5 * 60 * 1000;

function localDateKey(now = Date.now()) {
    const date = now instanceof Date ? now : new Date(now);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function quotaNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function quotaNumbers(usage = {}) {
    const quota = usage.quota || usage;
    return {
        fiveHour: quotaNumber(quota.fiveHour ?? quota.five_hour ?? quota.fiveHourRemaining),
        sevenDay: quotaNumber(quota.sevenDay ?? quota.seven_day ?? quota.sevenDayRemaining),
    };
}

function hasLargeQuotaDrop(previous, next) {
    if (!previous || !next) return false;
    return ['fiveHour', 'sevenDay'].some((key) => {
        const before = Number(previous[key]);
        const after = Number(next[key]);
        if (previous[key] == null || next[key] == null || !Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
            return false;
        }
        return after < before && (before - after) / before >= QUOTA_DROP_THRESHOLD;
    });
}

export class AuroraGate {
    constructor({ store = null } = {}) {
        this.store = store;
        this.recentMilestones = [];
    }

    recordMilestone(monument, now = Date.now()) {
        if (!monument) return;
        this.recentMilestones.push({
            kind: monument.kind,
            weight: monument.weight,
            ts: Number(monument.plantedAt || monument.ts || now),
        });
        this._trimMilestones(now);
    }

    async handleUsageUpdate(usage, now = Date.now()) {
        const next = quotaNumbers(usage);
        const previous = await this._getLastQuotaSnapshot();
        await this._setLastQuotaSnapshot({ ...next, ts: now });
        if (hasLargeQuotaDrop(previous, next)) {
            return this.evaluate(now, { quotaRollover: true });
        }
        return 'skip';
    }

    async evaluate(now = Date.now(), signals = {}) {
        const localDate = localDateKey(now);
        const force = Boolean(signals.force);
        if (!force && await this._hasFired(localDate)) return 'skip';
        this._trimMilestones(now);

        const release = this.recentMilestones.some(item => item.kind === 'release');
        const majorVerified = this.recentMilestones.some(item => (
            item.kind === 'verified' && (item.weight === 'major' || Number(item.weight) >= 3)
        ));
        const shouldFire = force || Boolean(signals.release || signals.quotaRollover || signals.majorVerified || release || majorVerified);
        if (!shouldFire) return 'skip';

        await this._markFired(localDate, now, signals);
        return 'fire';
    }

    async forceTrigger(reason = 'milestone', now = Date.now()) {
        return this.evaluate(now, { force: true, reason });
    }

    _trimMilestones(now) {
        const cutoff = now - MILESTONE_WINDOW_MS;
        this.recentMilestones = this.recentMilestones.filter(item => Number(item.ts || 0) >= cutoff);
    }

    async _hasFired(localDate) {
        if (!this.store) return false;
        try {
            return Boolean(await this.store.get('auroraLog', localDate));
        } catch {
            return false;
        }
    }

    async _markFired(localDate, now, signals) {
        if (!this.store) return;
        try {
            await this.store.put('auroraLog', { localDate, ts: now, signals });
        } catch { /* chronicle is a cache; failed gates degrade to visual-only */ }
    }

    async _getLastQuotaSnapshot() {
        if (!this.store) return null;
        try {
            return await this.store.getMeta('lastQuotaSnapshot', null);
        } catch {
            return null;
        }
    }

    async _setLastQuotaSnapshot(value) {
        if (!this.store) return;
        try {
            await this.store.setMeta('lastQuotaSnapshot', value);
        } catch { /* ignore */ }
    }

    static evaluate(now, signals) {
        const gate = new AuroraGate();
        gate.recentMilestones = signals?.recentMilestones || [];
        return gate.evaluate(now, signals);
    }
}

export { localDateKey, quotaNumbers, hasLargeQuotaDrop };
