// The village's shared cue score.
//
// `CueKit` publishes the ACTUAL scheduled note times of every admitted cue
// here; visual accents read the same score, so a mark lands on the note that
// carries it instead of on a pulse of its own. Both directions are honest and
// both are supported:
//
//   * sound leads — the recovery bracket closes on the first bell and its
//     diamond appears on the octave; one council notch lands per gathered
//     member on successive bells;
//   * the body leads — an arriving villager's foot rune is up to three seconds
//     after the scene event that admitted the cue, so the accent declares its
//     draw time with `scheduleAccent()` and the bells are scheduled to land on
//     it.
//
// Silence is not a special case. With no audio context the score is published
// on the monotonic clock immediately, so every accent still appears; nothing in
// the world ever waits for sound. Governor aggregation keeps the representative
// identity: the score belongs to the cue that actually sounded, never to the
// collapsed announcement.

import { eventBus } from '../../../domain/events/DomainEvent.js';

// P2 caps: eight admitted scores and forty note accents live at once. Expired
// beats are dropped, never replayed after a hidden tab.
const MAX_SCORES = 8;
const MAX_ACCENTS = 40;
const SCORE_TTL_MS = 4000;
const ACCENT_TTL_MS = 4000;
// How long a declared accent stays available to anchor a cue that has not been
// admitted yet. One event dispatch is enough; this is the safety margin.
const ANCHOR_TTL_MS = 400;
// An accent snaps onto a note only when the note is this close: a visual is
// never moved far enough to lie about when its fact happened.
const SNAP_WINDOW_MS = 200;
// The furthest ahead a body accent may pull a cue's notes.
const MAX_ANCHOR_LEAD_MS = 3500;
const MAX_LAG_SAMPLES = 16;

const MAX_SUMMONS_WAIT_MS = 20 * 60 * 1000;
const COUNCIL_NOTE_SPACING_MS = 280;
const SUMMONS_BASE_GAP_MS = 180;
const SUMMONS_URGENT_GAP_LIFT_MS = 35;

// Fixed note offsets, in milliseconds from the cue's first note. These are the
// offsets CueKit synthesises with — one table, so a published time can never
// disagree with the bell that plays.
const NOTE_OFFSETS_MS = Object.freeze({
    arrival: Object.freeze([0, 220]),
    departure: Object.freeze([0, 240]),
    distress: Object.freeze([0]),
    recovery: Object.freeze([0, 200]),
    hourBell: Object.freeze([0]),
    aurora: Object.freeze([0, 160, 320, 480]),
    thunder: Object.freeze([0]),
});

// The note a body-led accent claims, for cues whose visual mark belongs to a
// moving body rather than to the moment the cue was admitted.
export const CUE_ACCENT_NOTE = Object.freeze({
    arrival: 1,
    departure: 1,
});

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

export function summonsUrgency(waitingCount, oldestWaitMs) {
    const count = Number(waitingCount);
    const waitMs = Number(oldestWaitMs);
    const countLift = Number.isFinite(count)
        ? clamp01((Math.max(1, count) - 1) / 4)
        : 0;
    const waitLift = Number.isFinite(waitMs)
        ? clamp01(Math.max(0, waitMs) / MAX_SUMMONS_WAIT_MS)
        : 0;
    return clamp01(countLift * 0.55 + waitLift * 0.45);
}

export function councilBellCount(teamSize) {
    const size = Number(teamSize);
    if (!Number.isFinite(size)) return 3;
    return Math.max(2, Math.min(5, Math.round(size)));
}

// The note times of one cue kind, relative to its first note. Council length
// follows the real team size; the summons gap tightens with real urgency.
export function cueNoteOffsetsMs(kind, { teamSize, waitingCount, oldestWaitMs } = {}) {
    if (kind === 'council') {
        const count = councilBellCount(teamSize);
        const offsets = new Array(count);
        for (let i = 0; i < count; i++) offsets[i] = i * COUNCIL_NOTE_SPACING_MS;
        return offsets;
    }
    if (kind === 'summons') {
        const gap = SUMMONS_BASE_GAP_MS
            - summonsUrgency(waitingCount, oldestWaitMs) * SUMMONS_URGENT_GAP_LIFT_MS;
        return [0, gap];
    }
    const fixed = NOTE_OFFSETS_MS[kind];
    return fixed ? [...fixed] : null;
}

// One identity for a cue's score, kept through governor aggregation: the agent
// it belongs to, or the team a council gathering belongs to.
export function cueScoreKey(cue = {}) {
    return cue.agentId ?? cue.teamName ?? null;
}

export function cueSourceEventId(cue = {}) {
    if (cue.sourceEventId) return String(cue.sourceEventId);
    const key = cueScoreKey(cue);
    return `${cue.kind}:${key ?? 'world'}`;
}

function nowMs() {
    return performance.now();
}

const state = {
    scores: [],
    accents: [],
    diagnostics: {
        published: 0,
        silent: 0,
        anchored: 0,
        snapped: 0,
        dropped: 0,
        notesDrawn: 0,
        lastLagMs: null,
        maxLagMs: 0,
        lags: [],
    },
};

// A score lives until its own last note is this far past: the notes are the
// contract, and one clock (the caller's) decides everything. A hidden tab
// therefore returns to dropped beats, never to a queue that replays.
function scoreExpired(score, now) {
    return now > score.notes[score.notes.length - 1].atMs + SCORE_TTL_MS;
}

function pruneScores(now) {
    for (let i = state.scores.length - 1; i >= 0; i--) {
        if (scoreExpired(state.scores[i], now)) state.scores.splice(i, 1);
    }
    while (state.scores.length > MAX_SCORES) {
        state.scores.shift();
        state.diagnostics.dropped++;
    }
}

function pruneAccents(now) {
    for (let i = state.accents.length - 1; i >= 0; i--) {
        if (now - state.accents[i].declaredAt > ACCENT_TTL_MS) state.accents.splice(i, 1);
    }
    while (state.accents.length > MAX_ACCENTS) {
        state.accents.shift();
        state.diagnostics.dropped++;
    }
}

function findScore(kind, key, now) {
    for (let i = state.scores.length - 1; i >= 0; i--) {
        const score = state.scores[i];
        if (score.kind !== kind) continue;
        if (key != null && score.key !== key) continue;
        if (scoreExpired(score, now)) continue;
        return score;
    }
    return null;
}

function recordLag(lagMs) {
    const diagnostics = state.diagnostics;
    diagnostics.notesDrawn++;
    diagnostics.lastLagMs = lagMs;
    if (lagMs > diagnostics.maxLagMs) diagnostics.maxLagMs = lagMs;
    diagnostics.lags.push(lagMs);
    if (diagnostics.lags.length > MAX_LAG_SAMPLES) diagnostics.lags.shift();
}

/**
 * Publish one admitted cue's real note times. `startMs` is the first note on
 * the monotonic (`performance.now`) clock; `silent` marks a score that will not
 * sound, whose notes are therefore already due.
 */
export function publishCueScore({
    kind,
    agentId = null,
    teamName = null,
    sourceEventId = null,
    startMs = nowMs(),
    offsetsMs = null,
    silent = false,
} = {}) {
    const offsets = Array.isArray(offsetsMs) ? offsetsMs : null;
    if (!kind || !offsets?.length) return null;
    const now = nowMs();
    const key = agentId ?? teamName ?? null;
    const score = {
        kind,
        key,
        agentId: agentId ?? null,
        sourceEventId: sourceEventId || cueSourceEventId({ kind, agentId, teamName }),
        notes: offsets.map(offset => ({ atMs: startMs + offset, drawnAtMs: null })),
        silent: Boolean(silent),
        publishedAt: now,
    };
    state.scores.push(score);
    pruneScores(now);
    state.diagnostics.published++;
    if (score.silent) state.diagnostics.silent++;

    eventBus.emit('audio:cue-scheduled', {
        kind: score.kind,
        agentId: score.agentId,
        sourceEventId: score.sourceEventId,
        notes: score.notes.map(note => ({ atMs: note.atMs })),
        silent: score.silent,
    });
    return score;
}

/**
 * Has note `index` of this cue's score arrived? With no admitted score the
 * accent is already due — a silent village draws the same marks at once. The
 * first frame a note reads due records its lag for the score diagnostics.
 */
export function cueNoteDue(kind, key, index, now = nowMs()) {
    const score = findScore(kind, key, now);
    if (!score) return true;
    const noteIndex = Math.max(0, Math.min(score.notes.length - 1, Math.trunc(Number(index) || 0)));
    const note = score.notes[noteIndex];
    if (now < note.atMs) return false;
    if (note.drawnAtMs == null) {
        note.drawnAtMs = now;
        recordLag(now - note.atMs);
    }
    return true;
}

/** How many notes the live score for this cue has, or 0 when none is admitted. */
export function cueNoteCount(kind, key, now = nowMs()) {
    return findScore(kind, key, now)?.notes.length || 0;
}

/** The scheduled time of one note, or null when no score is admitted. */
export function cueNoteTime(kind, key, index, now = nowMs()) {
    const score = findScore(kind, key, now);
    if (!score) return null;
    const noteIndex = Math.max(0, Math.min(score.notes.length - 1, Math.trunc(Number(index) || 0)));
    return score.notes[noteIndex].atMs;
}

/**
 * Declare when a visual accent will be drawn and get the frame time to draw it.
 *
 * When the cue already sounds, the accent snaps onto the nearest note within
 * `SNAP_WINDOW_MS`. When the cue has not been admitted yet, the declaration
 * anchors it: `anchoredCueDelayMs` schedules the carrying note to sound at the
 * accent's own time. Either way the returned time is never later than the one
 * asked for by more than the snap window, and never waits on sound.
 *
 * @param {string|null} agentId the accent's agent (or team) identity
 * @param {number} atMs monotonic time the accent would otherwise be drawn
 * @param {string} kind cue kind the accent belongs to
 * @param {number} [now] the declaring frame's monotonic clock
 * @returns {number} monotonic time to draw the accent
 */
export function scheduleAccent(agentId, atMs, kind, now = nowMs()) {
    const requested = Number.isFinite(Number(atMs)) ? Number(atMs) : now;
    pruneAccents(now);
    if (state.accents.length >= MAX_ACCENTS) {
        state.diagnostics.dropped++;
        return requested;
    }

    const noteIndex = CUE_ACCENT_NOTE[kind] ?? 0;
    const score = findScore(kind, agentId ?? null, now);
    let at = requested;
    if (score) {
        let best = null;
        for (const note of score.notes) {
            const distance = Math.abs(note.atMs - requested);
            if (distance <= SNAP_WINDOW_MS && (best == null || distance < Math.abs(best - requested))) {
                best = note.atMs;
            }
        }
        if (best != null) {
            at = best;
            state.diagnostics.snapped++;
        }
    }

    state.accents.push({
        kind,
        key: agentId ?? null,
        noteIndex,
        atMs: at,
        declaredAt: now,
        anchored: !score,
    });
    return at;
}

/**
 * The delay a cue's synthesis needs so its carrying note lands on an accent
 * already declared for the same body. Returns `baseDelayMs` when no accent is
 * waiting, when the accent is sooner than the base delay, or when it is beyond
 * `MAX_ANCHOR_LEAD_MS` — the sound follows the body, never the reverse.
 */
export function anchoredCueDelayMs(kind, key, offsetsMs, baseDelayMs = 0, leadMs = 0, now = nowMs()) {
    const base = Math.max(0, Number(baseDelayMs) || 0);
    const noteIndex = CUE_ACCENT_NOTE[kind];
    if (noteIndex == null || !Array.isArray(offsetsMs) || !offsetsMs.length) return base;
    pruneAccents(now);
    for (let i = state.accents.length - 1; i >= 0; i--) {
        const accent = state.accents[i];
        if (accent.kind !== kind || accent.key !== (key ?? null)) continue;
        if (!accent.anchored || now - accent.declaredAt > ANCHOR_TTL_MS) continue;
        const offset = offsetsMs[Math.min(noteIndex, offsetsMs.length - 1)] || 0;
        const wanted = accent.atMs - now - Math.max(0, Number(leadMs) || 0) - offset;
        if (wanted <= base || wanted > MAX_ANCHOR_LEAD_MS) return base;
        state.diagnostics.anchored++;
        return wanted;
    }
    return base;
}

/**
 * Live score state for the audio debug readout: how many scores and accents are
 * resident, and how far behind their scheduled notes the drawn accents landed.
 */
export function cueScoreDiagnostics() {
    const now = nowMs();
    pruneScores(now);
    pruneAccents(now);
    const diagnostics = state.diagnostics;
    return {
        scores: state.scores.length,
        accents: state.accents.length,
        published: diagnostics.published,
        silent: diagnostics.silent,
        anchored: diagnostics.anchored,
        snapped: diagnostics.snapped,
        dropped: diagnostics.dropped,
        notesDrawn: diagnostics.notesDrawn,
        lastLagMs: diagnostics.lastLagMs,
        maxLagMs: diagnostics.maxLagMs,
        lags: [...diagnostics.lags],
        caps: { scores: MAX_SCORES, accents: MAX_ACCENTS },
    };
}

export function resetCueScore() {
    state.scores = [];
    state.accents = [];
    state.diagnostics = {
        published: 0,
        silent: 0,
        anchored: 0,
        snapped: 0,
        dropped: 0,
        notesDrawn: 0,
        lastLagMs: null,
        maxLagMs: 0,
        lags: [],
    };
}
