/**
 * Display policy for provenance-tagged villager speech.
 *
 * Extraction, sanitation, the source gate, and candidate selection all happen
 * server-side in `claudeville/adapters/dialogue.js`. This module owns only the
 * questions the client must answer on its own: is the line still current, and
 * does it render as speech or as a status chip.
 *
 * `DIALOGUE_STALE_MS` intentionally mirrors `DIALOGUE_MAX_AGE_MS` in
 * `adapters/dialogue.js`. The two module systems (CommonJS server, ES modules
 * client) cannot share a constant without a build step, so the value is
 * duplicated deliberately — change both together.
 */

// A line older than this no longer describes what the agent is doing now, so
// the villager falls silent rather than presenting stale work as current.
export const DIALOGUE_STALE_MS = 90_000;

// A completed agent has stopped producing text. Its last line is a parting
// summary rather than current narration, so it fades faster than a working
// villager's line instead of lingering for the full window.
export const DIALOGUE_COMPLETED_STALE_MS = 30_000;

// The one status that means "stopped, and the next move is yours". Matched
// against the wire strings the server sends (see
// domain/value-objects/AgentStatus.js); config deliberately does not import the
// domain enum, since every other dependency runs domain -> config.
//
// Plain `waiting` is deliberately excluded. `statusFromSessionActivity` assigns
// it to any session whose file has merely been quiet for 30s to 2min, so it
// describes ordinary inactivity, not an outstanding prompt. Holding a line for
// it would let arbitrarily old prose reappear whenever an agent paused, which
// is the exact staleness this module exists to prevent. `StatusResolver`
// reserves `waiting_on_user` for a real question or blocked input.
const BLOCKED_STATUSES = new Set(['waiting_on_user']);

// An agent blocked on the operator is usually blocked *by its own question*,
// and that question stays true for as long as the wait lasts. Only assistant
// prose is held: interrupted reasoning and in-progress plan steps describe work
// that already stopped, so they still decay on the normal window.
const HELD_KINDS = new Set(['assistant']);

/**
 * How long a line of this kind may still be shown for an agent in this status.
 * `Infinity` means the line is held until the status or the dialogue changes —
 * only ever for a question the operator has not answered yet.
 */
export function dialogueWindowMs(status, kind) {
    const normalizedStatus = String(status || '');
    if (BLOCKED_STATUSES.has(normalizedStatus) && HELD_KINDS.has(String(kind))) {
        return Infinity;
    }
    if (normalizedStatus === 'completed') return DIALOGUE_COMPLETED_STALE_MS;
    return DIALOGUE_STALE_MS;
}

/**
 * Whether a line of this kind may be held in place for an agent in this status.
 *
 * The server drops every candidate older than its own max age, so retention has
 * to happen client-side (see `AgentManager._retainedDialogue`). Without it the
 * `Infinity` window above could never fire.
 */
export function dialogueIsHeldable(status, kind) {
    return BLOCKED_STATUSES.has(String(status || '')) && HELD_KINDS.has(String(kind));
}

// Long-form reasoning renders as a tailless chip, never as a speech bubble: an
// excerpt of a 200-character thought is not a quote, and quote styling would
// claim more fidelity than the text has.
const CHIP_KINDS = new Set(['thinking']);

export const DIALOGUE_SHAPE = Object.freeze({ BUBBLE: 'bubble', CHIP: 'chip' });

export function dialogueShape(kind) {
    return CHIP_KINDS.has(String(kind)) ? DIALOGUE_SHAPE.CHIP : DIALOGUE_SHAPE.BUBBLE;
}

const KIND_LABELS = Object.freeze({
    intent: 'Model-authored intent',
    plan: 'Model plan step',
    thinking: 'Model reasoning',
    assistant: 'Assistant message',
});

/**
 * Human-readable origin for the bubble tooltip, derived from the dotted
 * `source` id the adapter emitted, so it can never claim a source that was not
 * actually read. Trimming, redaction, and a line held past its normal window
 * are always disclosed.
 */
export function dialogueSourceLabel({ kind, source, fidelity, redacted, held } = {}) {
    const base = KIND_LABELS[String(kind)] || 'Session text';
    const origin = String(source || '').trim();
    const notes = [];
    if (fidelity === 'excerpt') notes.push('excerpt');
    if (redacted) notes.push('redacted');
    if (held) notes.push('awaiting reply');
    const suffix = notes.length ? ` (${notes.join(', ')})` : '';
    return origin ? `${base} — ${origin}${suffix}` : `${base}${suffix}`;
}
