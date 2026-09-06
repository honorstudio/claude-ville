// Pure records and predicates for outcomes verified by provider evidence.

export const VERIFIED_OUTCOME_EVENT = 'outcome:verified';
export const VERIFIED_OUTCOME_KINDS = Object.freeze(['commit', 'push', 'release', 'milestone']);
export const VERIFIED_OUTCOME_LIVE_MS = 10_000;

const VERIFIED_OUTCOME_KIND_SET = new Set(VERIFIED_OUTCOME_KINDS);
const SUCCESS_STATES = new Set(['success', 'succeeded', 'ok', 'passed', 'pass', 'complete', 'completed', 'landed']);

function eventTime(event, fallback = Date.now()) {
    const raw = event?.completedAt
        ?? event?.completed_at
        ?? event?.ts
        ?? event?.timestamp
        ?? event?.time;
    if (Number.isFinite(Number(raw))) return Number(raw);
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function hasVerifiedSuccess(event) {
    if (!event || event.dryRun === true || event.inferredFailure === true) return false;
    if (typeof event.success === 'boolean') return event.success;
    const exitCode = event.exitCode
        ?? event.exit_code
        ?? event.code
        ?? event.returnCode
        ?? event.return_code;
    if (Number.isFinite(Number(exitCode))) return Number(exitCode) === 0;
    const state = String(
        event.status
        ?? event.outcome
        ?? event.conclusion
        ?? event.result
        ?? event.state
        ?? ''
    ).toLowerCase();
    return SUCCESS_STATES.has(state);
}

export function createVerifiedOutcome(kind, project, agentId = null, at = Date.now()) {
    if (!VERIFIED_OUTCOME_KIND_SET.has(kind)) return null;
    const timestamp = Number(at);
    return {
        kind,
        project: String(project || 'unknown'),
        agentId: agentId == null ? null : String(agentId),
        at: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
}

export function verifiedOutcomeFromGitEvent(event, context = {}) {
    const kind = String(event?.type || event?.kind || '').toLowerCase();
    if (!VERIFIED_OUTCOME_KIND_SET.has(kind) || kind === 'milestone') return null;
    if (!hasVerifiedSuccess(event)) return null;
    return createVerifiedOutcome(
        kind,
        event.project || event.projectPath || event.repository || event.repo || context.project,
        context.agentId ?? event.agentId ?? event.sessionId ?? null,
        eventTime(event, context.at)
    );
}

export function verifiedOutcomeKey(outcome, sourceId = '') {
    if (!outcome) return '';
    return [
        outcome.kind,
        outcome.project,
        outcome.agentId || '',
        outcome.at,
        sourceId,
    ].join(':');
}

export function verifiedOutcomeIsLive(outcome, now = Date.now()) {
    const timestamp = Number(outcome?.at);
    const current = Number(now);
    return Number.isFinite(timestamp)
        && Number.isFinite(current)
        && timestamp <= current
        && current - timestamp < VERIFIED_OUTCOME_LIVE_MS;
}
