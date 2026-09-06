// Transient lifecycle-hook overlay.
//
// Hooks complement provider transcripts; they never replace discovery and
// never write to disk. The registry owns one bounded, short-lived record per
// session and exposes only normalized turn-state fields.

const MAX_HOOK_SESSIONS = 256;
const HOOK_EXPIRY_MS = 30_000;
const HOOK_MERGE_WINDOW_MS = 10_000;
const HOOK_WAIT_RETENTION_MS = 30 * 60_000;
const PROMPT_DETAIL_MAX_LENGTH = 200;

const KNOWN_PROVIDERS = new Set([
  'claude',
  'codex',
  'gemini',
  'grok',
  'kimi',
  'opencode',
  'omp',
]);

const APPROVAL_KINDS = new Set([
  'permissionrequest',
  'approvalrequested',
  // Claude Code Notification hooks can be scoped with the
  // `permission_prompt` matcher. The normalized body intentionally retains
  // only hook_event_name, so a received Notification is that scoped signal.
  'notification',
]);
const TOOL_START_KINDS = new Set(['pretooluse']);
const TOOL_END_KINDS = new Set(['posttooluse']);
const TURN_START_KINDS = new Set([
  'sessionstart',
  'userpromptsubmit',
  'subagentstart',
]);
const TURN_END_KINDS = new Set([
  'stop',
  'agentturncomplete',
  'subagentstop',
  'sessionend',
]);

function normalizedKind(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizedProviderKind(value, provider) {
  const kind = normalizedKind(value);
  if (provider !== 'gemini') return kind;
  if (kind === 'beforetool') return 'pretooluse';
  if (kind === 'aftertool') return 'posttooluse';
  return kind;
}

function safeTimestamp(value, now) {
  let timestamp = null;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  } else if (value !== null && value !== undefined) {
    timestamp = Number(value);
  }
  if (!Number.isFinite(timestamp)) return now;
  if (timestamp > 0 && timestamp < 10_000_000_000) timestamp *= 1000;
  // Provider clocks are advisory. Reception time remains the freshness and
  // expiry authority so a future timestamp cannot pin an overlay forever.
  return Math.max(0, Math.min(timestamp, now + 5000));
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
}

function truncatePromptDetail(value) {
  const clean = redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  if (clean.length <= PROMPT_DETAIL_MAX_LENGTH) return clean;
  return `${clean.slice(0, PROMPT_DETAIL_MAX_LENGTH - 1).trimEnd()}…`;
}

function promptCandidate(input) {
  if (typeof input === 'string' || typeof input === 'number') return String(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  // Commands and paths answer the operator's question without retaining file
  // contents, arbitrary permission payloads, or model prose.
  for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  return '';
}

function promptDetailFrom(input) {
  return truncatePromptDetail(promptCandidate(input));
}

function stateTimestamp(session = {}) {
  return Math.max(
    Number(session.pendingSince) || 0,
    Number(session.awaitingSince) || 0,
    Number(session.turnStartedAt) || 0,
    Number(session.lastActivity) || 0,
  );
}

function urgency(value = {}) {
  if (value.turnState === 'tool_pending' && value.waitReason) return 3;
  if (value.turnState === 'awaiting_input') return 2;
  if (value.turnState === 'tool_pending') return 1;
  if (value.turnState === 'working') return 0;
  return -1;
}

function shouldMergeOverlay(session, overlay, now = Date.now()) {
  if (!overlay || now - overlay.lastHookAt >= (overlay.waitReason ? HOOK_WAIT_RETENTION_MS : HOOK_MERGE_WINDOW_MS)) return false;
  if (session?.provider && overlay.provider && session.provider !== overlay.provider) return false;
  // A recorded resolution newer than the hook closes the unanswered wait.
  if (session?.turnState === 'awaiting_input' && Number(session.awaitingSince) >= overlay.eventAt) return false;
  if (Math.max(Number(session?.turnStartedAt) || 0, Number(session?.pendingSince) || 0) > overlay.eventAt) return false;
  return urgency(overlay) > urgency(session)
    || overlay.lastHookAt >= stateTimestamp(session);
}

function mergeOverlay(session, overlay, now = Date.now()) {
  if (!shouldMergeOverlay(session, overlay, now)) return session;
  const promptDetail = overlay.promptDetail || null;
  return {
    ...session,
    turnState: overlay.turnState,
    pendingTool: overlay.pendingTool,
    pendingSince: overlay.pendingSince,
    awaitingSince: overlay.awaitingSince,
    waitReason: overlay.waitReason,
    promptDetail,
    signalSource: 'hook',
    signalCertainty: 'observed',
    signalObservedAt: overlay.eventAt,
    signalStale: now - overlay.lastHookAt >= HOOK_MERGE_WINDOW_MS,
    // These existing client fields carry the ephemeral detail through the
    // current Agent projection; /api/sessions still exposes promptDetail as F2.
    lastTool: overlay.pendingTool || session.lastTool || null,
    lastToolInput: promptDetail || session.lastToolInput || null,
  };
}

class HookOverlay {
  constructor({ now = () => Date.now() } = {}) {
    this._entries = new Map();
    this._now = now;
  }

  ingest(event = {}) {
    const now = this._now();
    this.prune(now);
    const provider = String(event.provider || '').trim().toLowerCase();
    const sessionId = String(event.sessionId || '').trim();
    const kind = normalizedProviderKind(event.kind, provider);
    if (!KNOWN_PROVIDERS.has(provider)) {
      const error = new Error('unknown provider');
      error.code = 'UNKNOWN_PROVIDER';
      throw error;
    }
    if (!sessionId || sessionId.length > 512) {
      const error = new Error('invalid sessionId');
      error.code = 'INVALID_SESSION_ID';
      throw error;
    }
    if (![...APPROVAL_KINDS, ...TOOL_START_KINDS, ...TOOL_END_KINDS, ...TURN_START_KINDS, ...TURN_END_KINDS].includes(kind)) {
      const error = new Error('unknown hook event');
      error.code = 'UNKNOWN_HOOK_EVENT';
      throw error;
    }

    const key = `${provider}::${sessionId}`;
    const previous = this._entries.get(key) || null;
    const eventAt = safeTimestamp(event.ts, now);
    const safeTool = typeof event.tool === 'string'
      ? truncatePromptDetail(event.tool)?.slice(0, 128) || null
      : null;
    const tool = safeTool || previous?.pendingTool || null;
    const detail = promptDetailFrom(event.input) || previous?.promptDetail || null;
    let next;

    if (APPROVAL_KINDS.has(kind)) {
      next = {
        turnState: 'tool_pending',
        pendingTool: tool,
        pendingSince: eventAt,
        awaitingSince: eventAt,
        waitReason: 'approval',
        promptDetail: detail,
      };
    } else if (TOOL_START_KINDS.has(kind)) {
      next = {
        turnState: 'tool_pending',
        pendingTool: tool,
        pendingSince: eventAt,
        awaitingSince: null,
        waitReason: null,
        promptDetail: detail,
      };
    } else if (TURN_END_KINDS.has(kind)) {
      next = {
        turnState: 'awaiting_input',
        pendingTool: null,
        pendingSince: null,
        awaitingSince: eventAt,
        waitReason: null,
        promptDetail: null,
      };
    } else {
      next = {
        turnState: 'working',
        pendingTool: null,
        pendingSince: null,
        awaitingSince: null,
        waitReason: null,
        promptDetail: null,
      };
    }

    if (previous && eventAt < previous.eventAt) {
      return this.overlayFor(sessionId, now, provider);
    }

    if (this._entries.has(key)) this._entries.delete(key);
    while (this._entries.size >= MAX_HOOK_SESSIONS) {
      const oldest = this._entries.keys().next().value;
      if (oldest === undefined) break;
      this._entries.delete(oldest);
    }
    this._entries.set(key, {
      ...next,
      provider,
      sessionId,
      cwd: typeof event.cwd === 'string' ? event.cwd.slice(0, 4096) : '',
      eventAt,
      signalSource: 'hook',
      lastHookAt: now,
    });
    return this.overlayFor(sessionId, now, provider);
  }

  overlayFor(sessionId, now = this._now(), provider = null) {
    const matches = provider ? [] : [...this._entries.values()].filter(entry => entry.sessionId === sessionId);
    if (!provider && matches.length !== 1) return null;
    const key = `${provider || matches[0].provider}::${sessionId}`;
    const entry = this._entries.get(key);
    if (!entry) return null;
    if (now - entry.lastHookAt >= (entry.waitReason ? HOOK_WAIT_RETENTION_MS : HOOK_EXPIRY_MS)) {
      this._entries.delete(key);
      return null;
    }
    return { ...entry };
  }

  prune(now = this._now()) {
    for (const [sessionId, entry] of this._entries) {
      if (now - entry.lastHookAt >= (entry.waitReason ? HOOK_WAIT_RETENTION_MS : HOOK_EXPIRY_MS)) this._entries.delete(sessionId);
    }
  }

  nextMergeExpiryAt(now = this._now()) {
    let next = null;
    for (const entry of this._entries.values()) {
      const at = entry.lastHookAt + HOOK_MERGE_WINDOW_MS;
      if (at <= now) continue;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  nextExpiryAt(now = this._now()) {
    let next = null;
    for (const entry of this._entries.values()) {
      const at = entry.lastHookAt + (entry.waitReason ? HOOK_WAIT_RETENTION_MS : HOOK_EXPIRY_MS);
      if (at <= now) continue;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  get size() {
    return this._entries.size;
  }
}

const hookOverlay = new HookOverlay();

module.exports = {
  HOOK_WAIT_RETENTION_MS,
  HOOK_EXPIRY_MS,
  HOOK_MERGE_WINDOW_MS,
  HookOverlay,
  KNOWN_PROVIDERS,
  MAX_HOOK_SESSIONS,
  PROMPT_DETAIL_MAX_LENGTH,
  hookOverlay,
  mergeOverlay,
  promptDetailFrom,
  redactSecrets,
  shouldMergeOverlay,
  truncatePromptDetail,
};
