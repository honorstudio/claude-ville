import { AgentStatus, statusFromSessionActivity } from '../value-objects/AgentStatus.js';

// Turn-state ids mirror `adapters/turnState.js`. Duplicated as literals rather
// than imported because that module is CommonJS server code and this one runs
// in the browser; the contract is the normalized session payload, not the file.
export const TurnState = Object.freeze({
    WORKING: 'working',
    TOOL_PENDING: 'tool_pending',
    AWAITING_INPUT: 'awaiting_input',
    UNKNOWN: 'unknown',
});

// Tools that are a request to the user by name. Retained as a fallback for
// providers whose adapters do not derive a turn state.
const WAITING_ON_USER_TOOLS = new Set([
    'AskUserQuestion',
    'request_user_input',
    'functions.request_user_input',
]);

// Heuristic gate: lastMessage text-match for ERRORED is loud (false positives
// from agents echoing user prose). Keep off by default; flip when paired with
// a stricter classifier.
export const ENABLE_ERROR_HEURISTIC = false;
const ERROR_MESSAGE_PATTERN = /^FAIL[: ]|error:|exception\b|timeout/i;
const GIT_FAIL_WINDOW_MS = 60_000;
export const RATE_LIMIT_THRESHOLD = 0.95;

export function quotaPressure(session, usage) {
    const quota = usage?.quota;
    if (!quota || (quota.provider || usage.provider) !== session.provider) return null;
    if (quota.accountId !== session.accountId) return null;
    const value = quota.fiveHour;
    return typeof value === 'number' && Number.isFinite(value) && value > RATE_LIMIT_THRESHOLD ? value : null;
}

function isRateLimited(session, usage) {
    if (session.rateLimit?.enforced === true) return true;
    const quota = usage?.quota;
    return quota?.enforced === true && (quota.provider || usage.provider) === session.provider
        && !!quota.accountId && quota.accountId === session.accountId;
}

function isErrored(session, now) {
    const events = Array.isArray(session.gitEvents) ? session.gitEvents : [];
    if (events.length) {
        const cutoff = now - GIT_FAIL_WINDOW_MS;
        for (const event of events) {
            const ts = Number(event?.completedAt || event?.ts || 0);
            if (!ts || ts < cutoff) continue;
            if (event?.status === 'failed' || event?.success === false) return true;
        }
    }
    if (ENABLE_ERROR_HEURISTIC) {
        const msg = String(session.lastMessage || '').trim();
        if (msg && ERROR_MESSAGE_PATTERN.test(msg)) return true;
    }
    return false;
}

// Fallback for providers with no turn state: the old name-and-punctuation
// guess. Weak, but better than reporting nothing for Gemini/Grok/Kimi.
function looksLikeAskWithoutTurnState(session, baseStatus) {
    const tool = session.lastTool || null;
    if (tool && WAITING_ON_USER_TOOLS.has(tool)) return true;
    if (baseStatus === AgentStatus.WAITING) {
        const msg = String(session.lastMessage || '').trim();
        if (msg && msg.endsWith('?')) return true;
    }
    return false;
}

/**
 * Resolve the status a session should render as.
 *
 * Turn state is authoritative when the adapter derived one: a closed turn is
 * COMPLETED (the agent is done and the next move is the user's), a tool call
 * the adapter judged blocked is WAITING_ON_USER, and a tool that is merely
 * running keeps the session WORKING however long it takes. Only sessions with
 * no turn state fall back to timing the file's mtime.
 *
 * Priority: explicit WAITING_ON_USER > observed RATE_LIMITED > ERRORED > COMPLETED > base.
 *
 * @param {object} session normalized session payload
 * @param {object} options
 * @param {object} options.usage  latest /api/usage payload, for quota pressure
 * @param {number} options.now
 * @returns {string} AgentStatus
 */
export function resolveAgentStatus(session = {}, { usage = null, now = Date.now() } = {}) {
    const base = statusFromSessionActivity(session, now);
    const turnState = session.turnState || TurnState.UNKNOWN;
    const known = turnState !== TurnState.UNKNOWN;

    // A pending tool call is live work even when the file has been quiet — a
    // four-minute build writes nothing while it runs.
    const busy = known
        ? (turnState === TurnState.WORKING || turnState === TurnState.TOOL_PENDING)
        : base === AgentStatus.WORKING;

    if (turnState === TurnState.TOOL_PENDING && session.waitReason) return AgentStatus.WAITING_ON_USER;
    if (busy && isRateLimited(session, usage)) return AgentStatus.RATE_LIMITED;
    if (isErrored(session, now)) return AgentStatus.ERRORED;

    if (known) {
        if (turnState === TurnState.TOOL_PENDING && session.waitReason) {
            return AgentStatus.WAITING_ON_USER;
        }
        if (turnState === TurnState.AWAITING_INPUT) return AgentStatus.COMPLETED;
        if (turnState === TurnState.TOOL_PENDING || turnState === TurnState.WORKING) {
            return AgentStatus.WORKING;
        }
    }

    if (looksLikeAskWithoutTurnState(session, base)) return AgentStatus.WAITING_ON_USER;
    return base;
}

/**
 * Whether a status is one a person has to act on. Drives the attention badge,
 * the alert cue, and the title/favicon marks.
 */
export function isAttentionStatus(status) {
    return status === AgentStatus.WAITING_ON_USER
        || status === AgentStatus.RATE_LIMITED
        || status === AgentStatus.ERRORED;
}
