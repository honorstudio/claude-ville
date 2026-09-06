// Turn state: what a session is actually doing, read from its transcript.
//
// The old model inferred everything from file mtime age, which cannot tell
// "thinking" from "blocked on you" from "finished" — the three states the
// village exists to communicate. Provider transcripts carry the real signal:
//
//   - an assistant turn that ended (`stop_reason: 'end_turn'`, Codex
//     `task_complete`) means the ball is in the user's court;
//   - a tool call with no matching result means a tool is pending, which is
//     either executing or sitting on a permission prompt;
//   - anything else is live work.
//
// This module is pure and provider-agnostic: adapters extract a small
// descriptor from their own format and hand it here. Kept CommonJS to match
// the rest of `adapters/`.

const TurnState = Object.freeze({
  WORKING: 'working',
  TOOL_PENDING: 'tool_pending',
  AWAITING_INPUT: 'awaiting_input',
  UNKNOWN: 'unknown',
});

const WaitReason = Object.freeze({
  QUESTION: 'question',
  APPROVAL: 'approval',
  PLAN_REVIEW: 'plan_review',
});

// Tools that are a request to the user by definition — pending at all means
// waiting, with no dwell time needed.
const ASK_TOOLS = new Set([
  'AskUserQuestion',
  'request_user_input',
  'functions.request_user_input',
]);

const PLAN_TOOLS = new Set([
  'ExitPlanMode',
  'EnterPlanMode',
]);

/**
 * Decide whether a pending tool call is blocked on the user or just running.
 *
 * Only explicit question/review tool names identify a wait. An approval
 * requires a provider event or hook; duration supplies no such evidence.
 *
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function classifyPendingTool({ tool = null } = {}) {
  const name = typeof tool === 'string' && tool ? tool : null;

  if (name && ASK_TOOLS.has(name)) return { blocked: true, reason: WaitReason.QUESTION };
  if (name && PLAN_TOOLS.has(name)) return { blocked: true, reason: WaitReason.PLAN_REVIEW };

  // Elapsed time alone cannot distinguish a build from an approval prompt.
  return { blocked: false, reason: null };
}

/**
 * Fold a transcript descriptor into a turn state.
 *
 * @param {object} descriptor
 * @param {boolean} descriptor.turnEnded    last assistant turn closed cleanly
 * @param {number}  descriptor.turnEndedAt  ms epoch of that close
 * @param {string}  descriptor.pendingTool  name of an unanswered tool call
 * @param {number}  descriptor.pendingSince ms epoch the call was issued
 * @returns {{ turnState: string, pendingTool: string|null, pendingSince: number|null,
 *             awaitingSince: number|null, waitReason: string|null }}
 */
function deriveTurnState(descriptor = {}) {
  const {
    turnEnded = false,
    turnEndedAt = null,
    pendingTool = null,
    pendingSince = null,
    known = true,
  } = descriptor;

  const empty = {
    signalCertainty: 'unavailable',
    turnState: TurnState.UNKNOWN,
    pendingTool: null,
    pendingSince: null,
    awaitingSince: null,
    waitReason: null,
  };

  if (!known) return empty;

  if (pendingTool) {
    const since = pendingSince != null && Number.isFinite(Number(pendingSince)) ? Number(pendingSince) : null;
    const { blocked, reason } = classifyPendingTool({
      tool: pendingTool,
    });
    return {
      signalCertainty: 'observed',
      turnState: TurnState.TOOL_PENDING,
      pendingTool,
      pendingSince: since,
      awaitingSince: blocked ? since : null,
      waitReason: blocked ? reason : null,
    };
  }

  if (turnEnded) {
    const at = turnEndedAt != null && Number.isFinite(Number(turnEndedAt)) ? Number(turnEndedAt) : null;
    return {
      signalCertainty: 'observed',
      turnState: TurnState.AWAITING_INPUT,
      pendingTool: null,
      pendingSince: null,
      awaitingSince: at,
      waitReason: null,
    };
  }

  return {
    signalCertainty: 'inferred',
    turnState: TurnState.WORKING,
    pendingTool: null,
    pendingSince: null,
    awaitingSince: null,
    waitReason: null,
  };
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  TurnState,
  WaitReason,
  ASK_TOOLS,
  classifyPendingTool,
  deriveTurnState,
  toEpochMs,
};
