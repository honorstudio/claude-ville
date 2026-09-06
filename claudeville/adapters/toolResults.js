/**
 * Bounded provider-reported command results.
 *
 * A result record exists only where a provider explicitly reported the outcome
 * of a call it already finished: Codex `item_completed.CommandExecution`, Kimi
 * Code `tool.result` with an exit code or an error flag, and OpenCode tool
 * state with a numeric `metadata.exit`. Invocation is not a result, and a tool
 * call disappearing from a transcript tail is not a result either. Providers
 * without such a record (Claude, Gemini, Grok, OMP) carry no `lastResults`, and
 * nothing downstream may synthesize one for them.
 *
 * The id is derived from provider, session, and call identity so the same
 * finished command keeps one identity across polls; consumers deduplicate on it
 * instead of on receipt time.
 */

const TOOL_RESULT_LIMIT = 5;
const TOOL_RESULT_ID_MAX_LENGTH = 256;
const TOOL_NAME_MAX_LENGTH = 64;
const TOOL_RESULT_DETAIL_MAX_LENGTH = 80;

function fingerprint(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable identity for one finished call. Provider call ids are preferred; when
 * a provider does not expose one, the observed completion time and the call's
 * own shape stand in, which is still stable across re-reads of the same
 * transcript because both are read from the record, never from receipt time.
 */
function toolResultId({ provider, sessionId, callId, tool, detail, completedAt }) {
  const scope = `${provider || ''}:${sessionId || ''}`;
  const call = String(callId || '').trim();
  if (call) return `${scope}:${call}`.slice(0, TOOL_RESULT_ID_MAX_LENGTH);
  const at = Number.isFinite(Number(completedAt)) ? Math.trunc(Number(completedAt)) : 0;
  return `${scope}:${at}:${fingerprint(`${tool || ''}\u001f${detail || ''}`)}`.slice(0, TOOL_RESULT_ID_MAX_LENGTH);
}

function boundedInteger(value, { nonnegative = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const truncated = Math.trunc(numeric);
  return nonnegative ? Math.max(0, truncated) : truncated;
}

/**
 * Validate, deduplicate and cap a producer's result list. Newest first, at most
 * `TOOL_RESULT_LIMIT` entries, so a busy session cannot grow the list payload.
 * An entry without an id, a tool name, an observation source, or an observed
 * completion time is dropped rather than repaired: an unattributable outcome is
 * worse than a missing one.
 */
function normalizeToolResults(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, TOOL_RESULT_ID_MAX_LENGTH) : '';
    const tool = typeof item.tool === 'string' ? item.tool.trim().slice(0, TOOL_NAME_MAX_LENGTH) : '';
    const source = item.source === 'hook' || item.source === 'transcript' ? item.source : null;
    const completedAt = boundedInteger(item.completedAt, { nonnegative: true });
    if (!id || !tool || !source || !completedAt) continue;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      tool,
      detail: typeof item.detail === 'string'
        ? item.detail.trim().slice(0, TOOL_RESULT_DETAIL_MAX_LENGTH)
        : '',
      exitCode: boundedInteger(item.exitCode),
      durationMs: boundedInteger(item.durationMs, { nonnegative: true }),
      completedAt,
      source,
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, TOOL_RESULT_LIMIT);
}

module.exports = {
  TOOL_RESULT_LIMIT,
  normalizeToolResults,
  toolResultId,
};
