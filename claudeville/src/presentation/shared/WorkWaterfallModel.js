// 5.4 — the causal-waterfall model, extracted from ActivityPanel so the
// spatial work score and the DOM waterfall read one builder. Pure: no DOM, no
// persistence, no provider access, no presentation imports beyond the shared
// secret redaction the panel and the blocked banner already share.
//
// Exact/inferred semantics are the panel's and must stay that way: a row is
// `exact` only when the provider reported a duration or an end timestamp, and
// silence after an event becomes a `stall` row instead of a longer bar.
import { redactSecrets } from './Formatters.js';

export const CAUSAL_WATERFALL_WINDOW_MS = 20 * 60_000;
const CAUSAL_WATERFALL_STALL_MIN_MS = 1_000;
const CAUSAL_WATERFALL_RETRY_WINDOW_MS = 20_000;

export function causalTimestamp(value) {
    if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
    }
    if (typeof value === 'string' && value.trim() && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function causalDuration(value) {
    if (value === null || value === undefined || value === '') return null;
    const duration = Number(value);
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function causalText(value, fallback = '') {
    const text = typeof value === 'string'
        ? value
        : value === null || value === undefined ? '' : String(value);
    const clean = redactSecrets(text)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return fallback;
    return clean.length <= 96 ? clean : `${clean.slice(0, 95).trimEnd()}…`;
}

function causalCollection(value) {
    return Array.isArray(value) ? value : [];
}

function causalFirstTimestamp(...values) {
    for (const value of values) {
        const timestamp = causalTimestamp(value);
        if (timestamp !== null) return timestamp;
    }
    return null;
}

function causalToolName(entry) {
    return causalText(entry?.tool || entry?.name || entry?.type, 'tool');
}

function causalRetryFlag(entry) {
    return entry?.retry === true
        || entry?.isRetry === true
        || entry?.retried === true
        || causalDuration(entry?.retryCount) > 0
        || causalDuration(entry?.attempt) > 1
        || String(entry?.kind || entry?.type || entry?.event || '').toLowerCase() === 'retry';
}

function causalExitCode(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const exitCode = Number(value);
    return Number.isFinite(exitCode) ? exitCode : undefined;
}

function causalToolHistory(session, options) {
    return causalCollection(
        options?.toolHistory
        || session?.toolHistory
        || session?.detail?.toolHistory
        || session?.sessionDetail?.toolHistory,
    );
}

function causalChildren(session, options) {
    return causalCollection(
        options?.children
        || session?.children
        || session?.childSessions
        || session?.subagents,
    );
}

function causalAddEvent(events, event) {
    const at = causalTimestamp(event.at);
    if (at === null) return;
    const durationMs = causalDuration(event.durationMs);
    const endAt = causalTimestamp(event.endAt);
    events.push({
        ...event,
        at,
        durationMs,
        endAt,
        durationReported: event.durationReported === true
            || durationMs !== null
            || endAt !== null,
        order: events.length,
    });
}

function causalBaseEvents(session, options) {
    const events = [];
    const boundaries = causalCollection(
        session?.turnBoundaries
        || session?.turns
        || session?.turnHistory,
    );
    if (boundaries.length) {
        for (const boundary of boundaries) {
            causalAddEvent(events, {
                kind: 'turn',
                at: causalFirstTimestamp(
                    boundary?.at,
                    boundary?.ts,
                    boundary?.startedAt,
                    boundary?.startAt,
                    boundary?.turnStartedAt,
                ),
                durationMs: boundary?.durationMs ?? boundary?.lastTurnDurationMs,
                endAt: causalFirstTimestamp(boundary?.endedAt, boundary?.endAt, boundary?.turnEndedAt),
                label: 'Turn',
                detail: causalText(boundary?.label || boundary?.status || session?.turnState),
            });
        }
    } else {
        causalAddEvent(events, {
            kind: 'turn',
            at: causalFirstTimestamp(session?.turnStartedAt),
            durationMs: session?.lastTurnDurationMs,
            endAt: causalFirstTimestamp(session?.turnEndedAt, session?.turnEndedAtMs),
            label: 'Turn',
            detail: causalText(session?.turnState),
        });
    }

    const permissionAt = causalFirstTimestamp(
        session?.awaitingSince,
        session?.waitReason ? session?.pendingSince : null,
    );
    if (permissionAt !== null) {
        causalAddEvent(events, {
            kind: 'permission',
            at: permissionAt,
            durationMs: session?.permissionDurationMs
                ?? session?.awaitingDurationMs
                ?? session?.waitDurationMs,
            endAt: causalFirstTimestamp(session?.permissionEndedAt, session?.awaitingEndedAt),
            label: 'Permission wait',
            detail: causalText(
                session?.pendingTool
                    ? `${session.waitReason || 'waiting'} · ${session.pendingTool}`
                    : session?.waitReason || 'waiting',
            ),
        });
    }

    const tools = causalToolHistory(session, options);
    const previousToolAt = new Map();
    tools.forEach((entry, index) => {
        const at = causalFirstTimestamp(
            entry?.ts,
            entry?.timestamp,
            entry?.startedAt,
            entry?.startAt,
            entry?.at,
        );
        const completedAt = causalFirstTimestamp(entry?.completedAt, entry?.endedAt, entry?.endAt);
        const durationMs = causalDuration(entry?.durationMs ?? entry?.duration_ms);
        const tool = causalToolName(entry);
        const detail = causalText(entry?.detail ?? entry?.input ?? entry?.command, tool);
        causalAddEvent(events, {
            kind: 'tool',
            at,
            durationMs,
            endAt: completedAt,
            label: tool,
            detail,
            toolExitCode: causalExitCode(entry?.toolExitCode),
            retry: causalRetryFlag(entry),
            id: `tool:${index}`,
        });

        const previous = previousToolAt.get(tool);
        const retryInferred = previous
            && at !== null
            && at - previous.at >= 0
            && at - previous.at <= CAUSAL_WATERFALL_RETRY_WINDOW_MS;
        if (causalRetryFlag(entry) || retryInferred) {
            causalAddEvent(events, {
                kind: 'retry',
                at,
                durationMs: causalDuration(entry?.retryDurationMs),
                label: 'Retry',
                detail: tool,
                durationReported: causalDuration(entry?.retryDurationMs) !== null,
                id: `retry:${index}`,
            });
        }
        if (at !== null) previousToolAt.set(tool, { at });
    });

    const retryEntries = [
        ...causalCollection(session?.retryHistory),
        ...causalCollection(session?.retryEvents),
        ...causalCollection(session?.retries),
    ];
    retryEntries.forEach((entry, index) => {
        causalAddEvent(events, {
            kind: 'retry',
            at: causalFirstTimestamp(entry?.at, entry?.ts, entry?.timestamp, entry?.retryAt),
            durationMs: entry?.durationMs,
            endAt: causalFirstTimestamp(entry?.endAt, entry?.endedAt),
            label: 'Retry',
            detail: causalText(entry?.tool || entry?.name, 'retry'),
            id: `retry-history:${index}`,
        });
    });
    const lastRetryAt = causalFirstTimestamp(session?.lastRetryAt, session?.retryAt);
    if (lastRetryAt !== null) {
        causalAddEvent(events, {
            kind: 'retry',
            at: lastRetryAt,
            durationMs: session?.lastRetryDurationMs,
            label: 'Retry',
            detail: causalText(session?.lastRetryTool, 'retry'),
            id: 'retry:last',
        });
    }

    causalChildren(session, options).forEach((child, index) => {
        const at = causalFirstTimestamp(
            child?.turnStartedAt,
            child?.startedAt,
            child?.startAt,
            child?.sessionStartedAt,
            child?.statusSince,
            child?.lastSessionActivity,
            child?.timestamp,
        );
        const name = causalText(child?.name || child?.agentName || child?.id, 'child');
        const explicitDuration = child?.durationMs ?? child?.lastTurnDurationMs;
        causalAddEvent(events, {
            kind: 'child',
            at,
            durationMs: explicitDuration,
            endAt: causalFirstTimestamp(child?.endedAt, child?.endAt, child?.completedAt),
            label: 'Child activity',
            detail: `${name}${child?.status ? ` · ${causalText(child.status)}` : ''}`,
            childId: child?.id ?? child?.sessionId ?? null,
            id: `child:${index}`,
        });
    });

    return events;
}

function causalEventPriority(kind) {
    return {
        turn: 0,
        permission: 1,
        tool: 2,
        retry: 3,
        child: 4,
        stall: 5,
    }[kind] ?? 9;
}

/**
 * Build a dependency-free, chronological waterfall model from the selected
 * session and its already-projected detail fields. No DOM, persistence, or
 * provider access is involved; callers may supply fetched tool/child arrays
 * through the options object without attaching them to the session payload.
 *
 * `width` is a 0..1 ratio against the longest elapsed row. `provenance` keeps
 * the panel's existing exact/inferred vocabulary while `source` and `derived`
 * make the timing distinction explicit to consumers.
 */
export function buildCausalWaterfall(session, { now = Date.now(), toolHistory, children } = {}) {
    const current = causalTimestamp(now) || Date.now();
    const cutoff = current - CAUSAL_WATERFALL_WINDOW_MS;
    const candidates = causalBaseEvents(session, { toolHistory, children })
        .filter(event => event.at >= cutoff && event.at <= current)
        .sort((a, b) => (
            (a.at - b.at)
            || (causalEventPriority(a.kind) - causalEventPriority(b.kind))
            || (a.order - b.order)
        ));
    if (!candidates.length) return [];

    const resolved = [];
    for (let index = 0; index < candidates.length; index++) {
        const event = candidates[index];
        const nextAt = candidates[index + 1]?.at ?? current;
        const inferredToNow = event.durationReported !== true
            && event.endAt === null
            && nextAt >= current;
        let endAt = event.endAt;
        if (endAt === null) {
            // An event with no reported end or duration must not absorb the
            // silence that follows it: stretching it to the next timestamp
            // would repaint a stall as a long tool bar. It ends where it
            // began (the stall pass owns the gap), except for the final
            // ongoing event, which honestly extends to now.
            endAt = event.durationMs !== null
                ? event.at + event.durationMs
                : (inferredToNow ? current : event.at);
        }
        endAt = Math.min(current, Math.max(event.at, endAt));
        const durationMs = Math.max(0, endAt - event.at);
        resolved.push({
            ...event,
            endAt,
            durationMs,
            ongoing: inferredToNow,
            provenance: event.durationReported ? 'exact' : 'inferred',
        });
    }

    const withStalls = [];
    let previousEnd = null;
    for (const event of resolved) {
        if (previousEnd !== null && event.at - previousEnd >= CAUSAL_WATERFALL_STALL_MIN_MS) {
            withStalls.push({
                kind: 'stall',
                at: previousEnd,
                endAt: event.at,
                durationMs: event.at - previousEnd,
                durationReported: false,
                provenance: 'inferred',
                label: 'Stall',
                detail: 'No recorded activity',
                order: event.order - 0.5,
            });
        }
        withStalls.push(event);
        previousEnd = previousEnd === null ? event.endAt : Math.max(previousEnd, event.endAt);
    }

    const maxDuration = Math.max(...withStalls.map(event => event.durationMs), 0);
    return withStalls
        .sort((a, b) => (
            (a.at - b.at)
            || (causalEventPriority(a.kind) - causalEventPriority(b.kind))
            || (a.order - b.order)
        ))
        .map((event, index) => {
            const width = maxDuration > 0 ? event.durationMs / maxDuration : 0;
            const row = {
                id: event.id || `${event.kind}:${event.at}:${index}`,
                kind: event.kind,
                at: event.at,
                ts: event.at,
                endAt: event.endAt,
                durationMs: event.durationMs,
                elapsedMs: event.durationMs,
                width,
                widthPercent: width * 100,
                label: event.label,
                detail: event.detail || event.label,
                provenance: event.provenance || (event.durationReported ? 'exact' : 'inferred'),
                source: event.durationReported ? 'reported' : 'derived',
                timingSource: event.durationReported ? 'reported' : 'derived',
                derived: event.durationReported !== true,
                providerReported: event.durationReported === true,
                ongoing: event.ongoing === true,
            };
            if (Number.isFinite(event.toolExitCode)) row.toolExitCode = event.toolExitCode;
            if (event.childId !== null && event.childId !== undefined) row.childId = String(event.childId);
            return row;
        });
}
