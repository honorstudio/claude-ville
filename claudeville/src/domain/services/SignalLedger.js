import { AgentStatus, normalizeAgentStatus } from '../value-objects/AgentStatus.js';

/**
 * C2 — the single attention/status vocabulary for ClaudeVille.
 *
 * Before this module, five surfaces disagreed about what a status means:
 * `World.getStats()` counted `errored` but excluded it from `attention`, the
 * Dashboard project header counted `rate_limited` and `waiting_on_user` as
 * errors, and the World live summary merged errors with quota. Every consumer
 * (TopBar, Sidebar, Dashboard, World summary, World marks, audio priority)
 * now reads its counts and ordered agent lists from here.
 *
 * This module owns *classification*, not urgency policy. Two orderings exist
 * and both are deliberate:
 *
 *   - `actionableAgents()` returns the union of the actionable buckets sorted
 *     longest-waiting first. That is the identical ordering already shipped in
 *     `AttentionService.list()`, which drives the `A` key, the title, and the
 *     favicon. `compareByWaitAge` is exported so there is exactly one
 *     definition of it in the codebase.
 *   - Each bucket array is sorted by the same comparator, so a rendered list
 *     is deterministic across polls.
 *
 * Bucket *declaration* order (`SIGNAL_BUCKETS`) is the display precedence
 * already shipped in `SemanticTriage.attentionRank()` — waiting_on_user,
 * errored, rate_limited, waiting. It orders segments and labels; it does not
 * reorder the `A` traversal.
 *
 * Pure: no DOM, no timers, no event bus, no mutation of inputs.
 */

/** Every bucket, in canonical display precedence. */
export const SIGNAL_BUCKETS = Object.freeze([
    'needsYou',
    'errors',
    'quota',
    'watchlist',
    'working',
    'quiet',
]);

/**
 * Buckets a person has to act on. `watchlist` is deliberately absent: a quiet
 * generic wait is not an emergency and never enters `A` traversal.
 */
export const ACTIONABLE_BUCKETS = Object.freeze(['needsYou', 'errors', 'quota']);

const BUCKET_BY_STATUS = Object.freeze({
    [AgentStatus.WAITING_ON_USER]: 'needsYou',
    [AgentStatus.ERRORED]: 'errors',
    [AgentStatus.RATE_LIMITED]: 'quota',
    [AgentStatus.WAITING]: 'watchlist',
    [AgentStatus.WORKING]: 'working',
});

/**
 * The bucket a single status belongs to. `idle`, `completed`, and anything
 * unrecognized fall to `quiet`.
 */
export function bucketForStatus(status) {
    return BUCKET_BY_STATUS[normalizeAgentStatus(status)] || 'quiet';
}

/** True when a bucket name requires operator action. */
export function isActionableBucket(name) {
    return ACTIONABLE_BUCKETS.includes(name);
}

/**
 * True when a status requires operator action. This is the same population as
 * `StatusResolver.isAttentionStatus()`; the parity is asserted by test.
 */
export function isActionableStatus(status) {
    return isActionableBucket(bucketForStatus(status));
}

/** When an agent started waiting, for urgency ordering. */
export function waitAnchor(agent) {
    return Number(agent?.awaitingSince || agent?.lastSessionActivity || 0) || 0;
}

/**
 * Longest-waiting first — the ordering `AttentionService.list()` has always
 * used. Ties break on id so a rendered list never reshuffles between polls.
 */
export function compareByWaitAge(a, b) {
    const delta = waitAnchor(a) - waitAnchor(b);
    if (delta !== 0) return delta;
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function emptyBuckets() {
    const out = {};
    for (const name of SIGNAL_BUCKETS) out[name] = [];
    return out;
}

function toAgentArray(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source.filter(Boolean);
    // A World instance.
    if (source.agents) return toAgentArray(source.agents);
    // A Map of agents.
    if (typeof source.values === 'function') return [...source.values()].filter(Boolean);
    if (typeof source[Symbol.iterator] === 'function') return [...source].filter(Boolean);
    return [];
}

function isBucketed(value) {
    return Boolean(value) && SIGNAL_BUCKETS.every(name => Array.isArray(value[name]));
}

/**
 * Sort every agent into its bucket, each bucket ordered longest-waiting first.
 *
 * @param {Iterable|Array|Map|{agents:Map}} source agents, a Map, or a World
 * @returns {{needsYou:Array,errors:Array,quota:Array,watchlist:Array,working:Array,quiet:Array}}
 */
export function bucketAgents(source) {
    const out = emptyBuckets();
    for (const agent of toAgentArray(source)) {
        out[bucketForStatus(agent?.status)].push(agent);
    }
    for (const name of SIGNAL_BUCKETS) out[name].sort(compareByWaitAge);
    return out;
}

/** C2 entry point: `SignalLedger.buckets(world)`. */
export function buckets(world) {
    return bucketAgents(world);
}

/** Integer counts per bucket, plus `total` and `actionable`. */
export function bucketCounts(source) {
    const bucketed = isBucketed(source) ? source : bucketAgents(source);
    const counts = {};
    let total = 0;
    let actionable = 0;
    for (const name of SIGNAL_BUCKETS) {
        const size = bucketed[name].length;
        counts[name] = size;
        total += size;
        if (isActionableBucket(name)) actionable += size;
    }
    counts.total = total;
    counts.actionable = actionable;
    return counts;
}

/**
 * Every agent needing action, longest-waiting first across all three
 * actionable buckets.
 *
 * This reproduces `AttentionService.list()` exactly — same membership, same
 * order — so routing the `A` key, the title count, or the favicon through
 * either one yields identical behaviour. It is deliberately *not* grouped by
 * bucket: urgency is wait age, and bucket precedence is a display concern.
 */
export function actionableAgents(source) {
    const bucketed = isBucketed(source) ? source : bucketAgents(source);
    const out = [];
    for (const name of ACTIONABLE_BUCKETS) out.push(...bucketed[name]);
    return out.sort(compareByWaitAge);
}
