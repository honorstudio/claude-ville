/**
 * AgentMood — pure telemetry → emotion mapping for villagers.
 *
 * Pure telemetry and presentation-temperament derivations live here:
 *   - `deriveAgentMood`: per-agent mood from errors, wait age, context
 *     pressure, commit/push streaks, and token spend.
 *   - `modelBehaviorProfile`: model/effort → stable presentation behavior.
 *   - `deriveWeatherInfluence`: village-level event-influence input for
 *     weather (error spikes raise storminess, commit streaks clear skies).
 *
 * The temporal bookkeeping (token-rate sampling, error/push timestamps)
 * is owned by `application/MoodService.js`; this module stays stateless
 * so moods are reproducible from inputs.
 */

import { findModelRow } from '../../config/models.generated.js';

export const Mood = {
    NEUTRAL: 'neutral',
    DISTRESSED: 'distressed',
    ANXIOUS: 'anxious',
    PROUD: 'proud',
    TIRED: 'tired',
};

const KNOWN_MOODS = new Set(Object.values(Mood));

export const ModelBehaviorTier = Object.freeze({
    QUICK: 'quick',
    BALANCED: 'balanced',
    DELIBERATE: 'deliberate',
});

// Presentation-only temperament. The narrow gait range keeps any one villager
// feeling normal; the wider fidget interval makes tier differences observable
// during long idle watches without turning the fast tier into visual noise.
export const MODEL_BEHAVIOR_PROFILES = Object.freeze({
    [ModelBehaviorTier.QUICK]: Object.freeze({
        tier: ModelBehaviorTier.QUICK,
        walkPace: 1.08,
        fidgetInterval: 0.78,
        thinkDuration: 0.84,
    }),
    [ModelBehaviorTier.BALANCED]: Object.freeze({
        tier: ModelBehaviorTier.BALANCED,
        walkPace: 1,
        fidgetInterval: 1,
        thinkDuration: 1,
    }),
    [ModelBehaviorTier.DELIBERATE]: Object.freeze({
        tier: ModelBehaviorTier.DELIBERATE,
        walkPace: 0.92,
        fidgetInterval: 1.28,
        thinkDuration: 1.18,
    }),
});

const EFFORT_WEIGHTS = Object.freeze({
    none: -0.6,
    low: -0.6,
    medium: 0,
    high: 0.6,
    xhigh: 1,
    max: 1,
    ultra: 1,
});

function normalizeBehaviorKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[._/\s]+/g, '-');
}

/** Resolve a stable behavior profile without allocating a per-frame object. */
export function modelBehaviorProfile(model = '', effort = null) {
    const effortKey = normalizeBehaviorKey(effort);
    const mood = findModelRow(model).row?.mood || ModelBehaviorTier.BALANCED;
    let weight = mood === ModelBehaviorTier.QUICK
        ? -1
        : mood === ModelBehaviorTier.DELIBERATE
            ? 1
            : 0;
    weight += EFFORT_WEIGHTS[effortKey] || 0;

    if (weight <= -0.5) return MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.QUICK];
    if (weight >= 0.5) return MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.DELIBERATE];
    return MODEL_BEHAVIOR_PROFILES[ModelBehaviorTier.BALANCED];
}

/**
 * Mood composes after model temperament so telemetry urgency remains visible.
 * Values are scalar-only to keep the draw/update hot paths allocation-free.
 */
export function moodBehaviorMultiplier(mood, cue) {
    const type = KNOWN_MOODS.has(mood?.type) ? mood.type : Mood.NEUTRAL;
    const intensity = clamp01(mood?.intensity);
    if (intensity <= 0) return 1;

    if (cue === 'walkPace') {
        if (type === Mood.TIRED) return 1 - 0.30 * intensity;
        if (type === Mood.DISTRESSED) return 1 - 0.18 * intensity;
        if (type === Mood.ANXIOUS) return 1 + 0.10 * intensity;
        if (type === Mood.PROUD) return 1 + 0.12 * intensity;
    }
    if (cue === 'fidgetInterval') {
        if (type === Mood.TIRED) return 1 + 0.25 * intensity;
        if (type === Mood.DISTRESSED) return 1 - 0.12 * intensity;
        if (type === Mood.ANXIOUS) return 1 - 0.28 * intensity;
    }
    if (cue === 'thinkDuration') {
        if (type === Mood.TIRED) return 1 + 0.12 * intensity;
        if (type === Mood.DISTRESSED) return 1 - 0.05 * intensity;
        if (type === Mood.ANXIOUS) return 1 - 0.12 * intensity;
    }
    return 1;
}

export const MOOD_TUNING = {
    // Distress holds at full strength while errored, then fades.
    errorDecayMs: 3 * 60_000,
    // Successful commits/pushes within this window count toward a streak.
    streakWindowMs: 30 * 60_000,
    // Streak length that starts feeling like pride.
    prideStreakMin: 2,
    // Pride fades this long after the latest streak event.
    prideDecayMs: 10 * 60_000,
    // Sustained spend rate considered heavy (tokens per minute).
    fatigueTokensPerMinute: 40_000,
    // Session lifetime spend that wears a villager down regardless of rate.
    fatigueSessionTokens: 4_000_000,
    // Match the context-pressure intent threshold used by the presentation.
    contextPressureRatio: 0.82,
    // A waiting-on-user session starts reading as distressed after this age.
    longWaitThresholdMs: 20 * 60_000,
    // Long-wait intensity ramps from the threshold to full strength over this span.
    longWaitRampMs: 20 * 60_000,
    // Candidate intensities below this floor fall through to neutral.
    minIntensity: 0.2,
};

export const INFLUENCE_TUNING = {
    // Rolling windows for village-level event counting.
    errorWindowMs: 10 * 60_000,
    pushWindowMs: 15 * 60_000,
    // Event counts that saturate the respective influence channel.
    errorsForFullStorm: 4,
    pushesForFullClearing: 5,
};

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function decay(sinceTs, windowMs, now) {
    const ts = Number(sinceTs) || 0;
    if (!ts || ts > now) return 0;
    return clamp01(1 - (now - ts) / windowMs);
}

export function normalizeMood(raw = null) {
    const type = KNOWN_MOODS.has(raw?.type) ? raw.type : Mood.NEUTRAL;
    return {
        type,
        intensity: type === Mood.NEUTRAL ? 0 : clamp01(raw?.intensity),
        since: Number(raw?.since) || 0,
    };
}

/**
 * Derive a mood from per-agent telemetry.
 *
 * @param {object} inputs
 * @param {boolean} inputs.isErrored        agent status is currently errored
 * @param {number}  inputs.lastErrorAt      ms timestamp of last error episode (0 = none)
 * @param {number}  inputs.pushStreak       successful commits/pushes inside the streak window
 * @param {number}  inputs.lastPushAt       ms timestamp of latest streak event (0 = none)
 * @param {number}  inputs.tokensPerMinute  recent token spend rate
 * @param {number}  inputs.sessionTokens    cumulative session input+output tokens
 * @param {number}  inputs.contextRatio     current context usage ratio (0..1)
 * @param {boolean} inputs.isWaitingOnUser  status is currently waiting for user input
 * @param {number}  inputs.awaitingSince    ms timestamp when user wait began (0 = none)
 * @param {number}  now
 * @returns {{ type: string, intensity: number, since: number }}
 */
export function deriveAgentMood(inputs = {}, now = Date.now()) {
    const {
        isErrored = false,
        lastErrorAt = 0,
        pushStreak = 0,
        lastPushAt = 0,
        tokensPerMinute = 0,
        sessionTokens = 0,
        contextRatio = 0,
        isWaitingOnUser = false,
        awaitingSince = 0,
    } = inputs;

    const errorDistress = isErrored ? 1 : decay(lastErrorAt, MOOD_TUNING.errorDecayMs, now);
    const waitingTimestamp = Number(awaitingSince);
    const waitingAgeMs = isWaitingOnUser && Number.isFinite(waitingTimestamp) && waitingTimestamp > 0
        ? Math.max(0, now - waitingTimestamp)
        : 0;
    const longWait = waitingAgeMs >= MOOD_TUNING.longWaitThresholdMs
        ? clamp01(
            MOOD_TUNING.minIntensity
            + (waitingAgeMs - MOOD_TUNING.longWaitThresholdMs) / MOOD_TUNING.longWaitRampMs,
        )
        : 0;
    const distress = Math.max(errorDistress, longWait);
    const distressSince = longWait > errorDistress
        ? waitingTimestamp
        : (Number(lastErrorAt) || now);

    const ratio = clamp01(contextRatio);
    const contextPressure = ratio >= MOOD_TUNING.contextPressureRatio
        ? clamp01(
            MOOD_TUNING.minIntensity
            + (ratio - MOOD_TUNING.contextPressureRatio)
                / Math.max(1 - MOOD_TUNING.contextPressureRatio, Number.EPSILON),
        )
        : 0;

    let pride = 0;
    if (pushStreak >= MOOD_TUNING.prideStreakMin) {
        const streakStrength = clamp01(0.5 + (pushStreak - MOOD_TUNING.prideStreakMin) * 0.15);
        pride = streakStrength * decay(lastPushAt, MOOD_TUNING.prideDecayMs, now);
    }

    const fatigue = clamp01(Math.max(
        (Number(tokensPerMinute) || 0) / MOOD_TUNING.fatigueTokensPerMinute,
        (Number(sessionTokens) || 0) / MOOD_TUNING.fatigueSessionTokens,
    ));

    const candidates = [
        { type: Mood.DISTRESSED, intensity: distress, since: distressSince },
        { type: Mood.ANXIOUS, intensity: contextPressure, since: now },
        { type: Mood.PROUD, intensity: pride, since: lastPushAt || now },
        { type: Mood.TIRED, intensity: fatigue, since: now },
    ];
    for (const candidate of candidates) {
        if (candidate.intensity >= MOOD_TUNING.minIntensity) {
            return normalizeMood(candidate);
        }
    }
    return normalizeMood(null);
}

/**
 * Derive the village-level event influence on weather.
 *
 * @param {object} inputs
 * @param {number[]} inputs.errorTimestamps  ms timestamps of recent error episodes
 * @param {number[]} inputs.pushTimestamps   ms timestamps of recent successful commits/pushes
 * @param {Array<{type: string}>} inputs.moods  current per-agent moods
 * @param {number} now
 * @returns {{
 *   storminess: number,  // 0..1, raises cloud cover / precipitation
 *   clearing: number,    // 0..1, pulls weather toward clear skies
 *   bias: number,        // clearing - storminess, -1..1
 *   signals: { recentErrors: number, recentPushes: number,
 *              distressedAgents: number, proudAgents: number, agentCount: number },
 *   updatedAt: number,
 * }}
 */
export function deriveWeatherInfluence(inputs = {}, now = Date.now()) {
    const errorTimestamps = Array.isArray(inputs.errorTimestamps) ? inputs.errorTimestamps : [];
    const pushTimestamps = Array.isArray(inputs.pushTimestamps) ? inputs.pushTimestamps : [];
    const moods = Array.isArray(inputs.moods) ? inputs.moods : [];

    const errorCutoff = now - INFLUENCE_TUNING.errorWindowMs;
    const pushCutoff = now - INFLUENCE_TUNING.pushWindowMs;
    const recentErrors = errorTimestamps.filter(ts => ts >= errorCutoff && ts <= now).length;
    const recentPushes = pushTimestamps.filter(ts => ts >= pushCutoff && ts <= now).length;

    const agentCount = moods.length;
    const distressedAgents = moods.filter(mood => mood?.type === Mood.DISTRESSED).length;
    const proudAgents = moods.filter(mood => mood?.type === Mood.PROUD).length;
    const distressedShare = agentCount ? distressedAgents / agentCount : 0;
    const proudShare = agentCount ? proudAgents / agentCount : 0;

    const storminess = clamp01(
        recentErrors / INFLUENCE_TUNING.errorsForFullStorm * 0.7 + distressedShare * 0.5,
    );
    const clearing = clamp01(
        recentPushes / INFLUENCE_TUNING.pushesForFullClearing * 0.7 + proudShare * 0.5,
    );

    return {
        storminess,
        clearing,
        bias: clearing - storminess,
        signals: { recentErrors, recentPushes, distressedAgents, proudAgents, agentCount },
        updatedAt: now,
    };
}
