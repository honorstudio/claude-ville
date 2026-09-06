import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import {
    MOOD_TUNING,
    deriveAgentMood,
    deriveWeatherInfluence,
    normalizeMood,
} from '../domain/value-objects/AgentMood.js';

// Token spend rate is measured over this rolling sample window.
const TOKEN_RATE_WINDOW_MS = 2 * 60_000;
// Mood updates are re-emitted only when the intensity moves at least this much.
const INTENSITY_EMIT_STEP = 0.15;
// District event arrays are pruned past the widest influence window.
const VILLAGE_EVENT_RETENTION_MS = 20 * 60_000;
const STREAK_EVENT_TYPES = new Set(['commit', 'push']);
const AGENT_STREAK_KEY_LIMIT = 256;
const VILLAGE_EVENT_LIMIT = 1024;

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    return (Number(tokens.input) || 0) + (Number(tokens.output) || 0);
}

function contextRatio(agent) {
    const tokens = agent?.tokens || {};
    const current = Number(tokens.contextWindow ?? 0) || 0;
    const max = Number(tokens.contextWindowMax ?? 0) || 0;
    if (current <= 0 || max <= 0) return 0;
    return Math.max(0, Math.min(1, current / max));
}

function isCountableStreakEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (!STREAK_EVENT_TYPES.has(String(event.type || '').toLowerCase())) return false;
    if (event.dryRun === true) return false;
    if (event.success === false) return false;
    const status = String(event.status || '').toLowerCase();
    if (status === 'failed' || status === 'rejected') return false;
    return true;
}

function streakEventKey(event) {
    const value = String(event.id || `${event.type}:${event.ts || 0}:${event.commandHash || event.command || ''}`);
    if (value.length <= 180) return value;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.slice(0, 120)}:${(hash >>> 0).toString(36)}`;
}

function eventTimestamp(event) {
    const raw = event?.completedAt ?? event?.ts ?? event?.timestamp;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function prune(timestamps, cutoff) {
    while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();
}

function pruneEventKeys(keys, cutoff) {
    for (const [key, timestamp] of keys) {
        if (timestamp < cutoff) keys.delete(key);
    }
    while (keys.size > AGENT_STREAK_KEY_LIMIT) keys.delete(keys.keys().next().value);
}

function capTimestamps(timestamps, limit = VILLAGE_EVENT_LIMIT) {
    timestamps.sort((a, b) => a - b);
    if (timestamps.length > limit) timestamps.splice(0, timestamps.length - limit);
}

function projectKey(agent) {
    const raw = agent?.projectPath
        || agent?.project
        || agent?.workspace
        || agent?.repository
        || agent?.teamName;
    const normalized = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized || `agent:${agent?.id || 'unknown'}`;
}

function districtEventRecord(records, key) {
    let record = records.get(key);
    if (!record) {
        record = { errorTimestamps: [], pushTimestamps: [] };
        records.set(key, record);
    }
    return record;
}

function sharedConsensusInfluence(districts, channel) {
    const occupied = districts.filter(district => district.signals.agentCount > 0);
    if (!occupied.length) return 0;
    const affected = occupied.filter(district => district[channel] >= MOOD_TUNING.minIntensity);
    const affectedShare = affected.length / occupied.length;
    // A shared sky should describe a broad village condition, not a single
    // project's incident. The influence fades in only beyond two-fifths of
    // occupied projects, while every district keeps its full local signal.
    const consensusWeight = Math.max(0, Math.min(1, (affectedShare - 0.4) / 0.6));
    if (consensusWeight <= 0) return 0;
    const affectedMean = affected.reduce((sum, district) => sum + district[channel], 0)
        / affected.length;
    return Math.round(affectedMean * consensusWeight * 1000) / 1000;
}

/**
 * Tracks per-agent telemetry over time (token spend rate, error episodes,
 * commit/push streaks), keeps each `Agent.mood` current, and aggregates
 * project-scoped atmosphere influences.
 *
 * Emits `mood:changed` with `{ agent, mood, previous }` when an agent's
 * mood type changes or its intensity shifts noticeably.
 *
 * Weather consumers (AtmosphereState lives in presentation) read
 * `getWeatherInfluence()` — a pure snapshot containing district signals and
 * a conservative shared-sky consensus, safe to call every frame.
 */
export class MoodService {
    constructor() {
        this._records = new Map(); // agent.id -> tracking record
        this._districtEvents = new Map(); // project key -> recent event timestamps
        this._unsubscribers = [];
    }

    start() {
        if (this._unsubscribers.length) return this;
        const seen = (agent) => this._handleAgentSeen(agent);
        this._unsubscribers.push(eventBus.on('agent:added', seen));
        this._unsubscribers.push(eventBus.on('agent:updated', seen));
        this._unsubscribers.push(eventBus.on('agent:removed', (agent) => {
            if (agent?.id) this._records.delete(agent.id);
        }));
        return this;
    }

    stop() {
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._unsubscribers = [];
        this._records.clear();
        this._districtEvents.clear();
    }

    /** Project influences plus a consensus-only shared-sky influence. */
    getWeatherInfluence(now = Date.now()) {
        const cutoff = now - VILLAGE_EVENT_RETENTION_MS;
        const districtInputs = new Map();
        for (const [key, events] of this._districtEvents) {
            prune(events.errorTimestamps, cutoff);
            prune(events.pushTimestamps, cutoff);
            if (!events.errorTimestamps.length && !events.pushTimestamps.length) {
                this._districtEvents.delete(key);
                continue;
            }
            districtInputs.set(key, {
                errorTimestamps: events.errorTimestamps,
                pushTimestamps: events.pushTimestamps,
                moods: [],
                agentIds: [],
            });
        }
        for (const [agentId, record] of this._records) {
            let input = districtInputs.get(record.projectKey);
            if (!input) {
                input = { errorTimestamps: [], pushTimestamps: [], moods: [], agentIds: [] };
                districtInputs.set(record.projectKey, input);
            }
            input.moods.push(record.mood);
            input.agentIds.push(agentId);
        }

        const districts = [...districtInputs.entries()]
            .map(([project, input]) => ({
                project,
                agentIds: input.agentIds,
                ...deriveWeatherInfluence(input, now),
            }))
            .sort((a, b) => a.project.localeCompare(b.project));
        const storminess = sharedConsensusInfluence(districts, 'storminess');
        const clearing = sharedConsensusInfluence(districts, 'clearing');
        return {
            storminess,
            clearing,
            bias: clearing - storminess,
            scope: 'district',
            districts,
            signals: {
                districtCount: districts.filter(district => district.signals.agentCount > 0).length,
                troubledDistricts: districts.filter(district => district.storminess >= MOOD_TUNING.minIntensity).length,
                clearingDistricts: districts.filter(district => district.clearing >= MOOD_TUNING.minIntensity).length,
            },
            updatedAt: now,
        };
    }

    getDistrictWeatherInfluence(now = Date.now()) {
        return this.getWeatherInfluence(now).districts;
    }

    getMood(agentId) {
        return this._records.get(agentId)?.mood || normalizeMood(null);
    }

    _handleAgentSeen(agent) {
        if (!agent?.id) return;
        const now = Date.now();
        let record = this._records.get(agent.id);
        if (!record) {
            record = {
                projectKey: projectKey(agent),
                tokenSamples: [{ at: now, total: tokenTotal(agent) }],
                wasErrored: false,
                lastErrorAt: 0,
                countedStreakKeys: new Map(),
                pushTimestamps: [],
                mood: normalizeMood(null),
            };
            this._records.set(agent.id, record);
        }
        record.projectKey = projectKey(agent);
        const districtEvents = districtEventRecord(this._districtEvents, record.projectKey);

        // Token spend rate over the rolling sample window.
        const total = tokenTotal(agent);
        record.tokenSamples.push({ at: now, total });
        while (record.tokenSamples.length > 1 && record.tokenSamples[0].at < now - TOKEN_RATE_WINDOW_MS) {
            record.tokenSamples.shift();
        }
        const oldest = record.tokenSamples[0];
        const elapsedMinutes = (now - oldest.at) / 60_000;
        const tokensPerMinute = elapsedMinutes > 0
            ? Math.max(0, total - oldest.total) / elapsedMinutes
            : 0;

        // Error episodes: count the transition into ERRORED, not every poll.
        const isErrored = agent.status === AgentStatus.ERRORED;
        if (isErrored && !record.wasErrored) {
            record.lastErrorAt = now;
            districtEvents.errorTimestamps.push(now);
            capTimestamps(districtEvents.errorTimestamps);
        }
        record.wasErrored = isErrored;

        // Commit/push streak from git events (deduped by event identity).
        const streakCutoff = now - MOOD_TUNING.streakWindowMs;
        pruneEventKeys(record.countedStreakKeys, streakCutoff);
        for (const event of agent.gitEvents || []) {
            if (!isCountableStreakEvent(event)) continue;
            const at = eventTimestamp(event);
            // Repository enrichment can surface old history in one batch. It
            // is useful context, but not a current mood or weather signal.
            if (!at || at < streakCutoff || at > now) continue;
            const key = streakEventKey(event);
            if (record.countedStreakKeys.has(key)) continue;
            record.countedStreakKeys.set(key, at);
            record.pushTimestamps.push(at);
            districtEvents.pushTimestamps.push(at);
        }
        pruneEventKeys(record.countedStreakKeys, streakCutoff);
        capTimestamps(record.pushTimestamps, AGENT_STREAK_KEY_LIMIT);
        capTimestamps(districtEvents.pushTimestamps);
        prune(record.pushTimestamps, streakCutoff);
        prune(districtEvents.pushTimestamps, now - VILLAGE_EVENT_RETENTION_MS);

        const mood = deriveAgentMood({
            isErrored,
            lastErrorAt: record.lastErrorAt,
            pushStreak: record.pushTimestamps.length,
            lastPushAt: record.pushTimestamps[record.pushTimestamps.length - 1] || 0,
            tokensPerMinute,
            sessionTokens: total,
            contextRatio: contextRatio(agent),
            isWaitingOnUser: agent.status === AgentStatus.WAITING_ON_USER,
            awaitingSince: agent.awaitingSince,
        }, now);

        const previous = record.mood;
        record.mood = mood;
        agent.mood = mood;
        if (mood.type !== previous.type
            || Math.abs(mood.intensity - previous.intensity) >= INTENSITY_EMIT_STEP) {
            eventBus.emit('mood:changed', { agent, mood, previous });
        }
    }
}
