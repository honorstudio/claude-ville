/**
 * OpenAI Codex CLI adapter
 * Data source: ~/.codex/
 *
 * Session rollout format (JSONL):
 *   {"type":"session_meta","payload":{"id":"...","cwd":"/path","cli_version":"..."}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"ls"}}
 *   {"type":"response_item","payload":{"type":"message","role":"assistant","content":[...]}}
 *   {"type":"event_msg","payload":{"type":"turn_complete","usage":{...}}}
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  clearTailCache,
  createDetailResponse,
  fileSignature,
  normalizeCacheTokens,
  parseJsonLines,
  readHeadText: readSharedHeadText,
  readJsonLineWindows: readSharedJsonLineWindows,
  readJsonLines: readSharedJsonLines,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');
const { deriveTurnState, toEpochMs } = require('./turnState');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { TOOL_RESULT_LIMIT, toolResultId } = require('./toolResults');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

// ─── Utilities ─────────────────────────────────────────────

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_METADATA_LINES = 24;
const METADATA_BACKSCAN_CHUNK_BYTES = 64 * 1024;
const MAX_METADATA_BACKSCAN_BYTES = 32 * 1024 * 1024;
const MAX_EARLY_METADATA_CACHE_ENTRIES = 256;
const MAX_TURN_METADATA_CACHE_ENTRIES = 256;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const SUMMARY_SCAN_LINES = 50;
const TOKEN_USAGE_SCAN_LINES = 500;
// The user's last real prompt and the latest update_plan can sit well behind
// the 50-line summary window on a busy turn; scan deeper for just those two.
const PROMPT_PLAN_SCAN_LINES = 600;
// Codex injects these as user-role messages; none of them is a prompt.
const INJECTED_USER_PREFIXES = /^\s*(<environment_context>|<recommended_plugins>|<INSTRUCTIONS|<image name=|# AGENTS\.md instructions)/;
const GIT_EVENT_SCAN_LINES = 5000;
const MAX_CURRENT_TOOL_INPUT_CHARS = 500;
const MAX_WORKING_SET_ITEMS = 16;
const MAX_ROLLOUT_DAY_DIRS = 8192;
const MAX_ROLLOUT_FILES = Math.max(
  1,
  Math.floor(Number(process.env.CLAUDEVILLE_CODEX_ROLLOUT_FILE_CAP || 100000) || 100000),
);
const MAX_WARM_ROLLOUT_DAY_DIRS = 4;
const ROLLOUT_DIR_MTIME_EPSILON_MS = 1;
const CODEX_TURN_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: ['cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens'],
  cacheCreate: ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
});
const CODEX_TOTAL_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: ['cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens'],
  // Cumulative Codex token_count payloads have no cache-create field.
  cacheCreate: [],
});

const _rolloutFileBySessionId = new Map();
const _sessionNamesCache = { signature: '', value: new Map() };
const _earlyMetadataCache = new Map();
const _turnMetadataCache = new Map();
// The bounded historical index is revisited during reconciliation. Ordinary
// polling stats only warm files plus a small newest-day discovery frontier.
const _rolloutDiscoveryCache = {
  initialized: false,
  filesByPath: new Map(),
  dayDirMtimes: new Map(),
  warmFilePaths: new Set(),
  reconcileRequested: true,
};
let _rolloutDiscoveryStats = {
  at: null,
  mode: null,
  activeThresholdMs: null,
  dayDirsScanned: 0,
  rolloutFilesScanned: 0,
  cachedFileStats: 0,
  resultCount: 0,
  capped: false,
  warning: null,
};

function readHeadText(filePath, maxBytes = MAX_METADATA_BYTES) {
  return readSharedHeadText(filePath, maxBytes);
}

function readJsonLines(filePath, { from = 'end', count = 50 } = {}) {
  return readSharedJsonLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'codex',
  });
}

function readJsonLineWindows(filePath, counts) {
  return readSharedJsonLineWindows(filePath, counts, {
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'codex',
  });
}

function parseTimestampMs(value) {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function readCodexSessionNames() {
  const signature = fileSignature(SESSION_INDEX_FILE);
  if (_sessionNamesCache.signature === signature) return _sessionNamesCache.value;

  const names = new Map();
  const seenAt = new Map();
  try {
    const lines = fs.readFileSync(SESSION_INDEX_FILE, 'utf-8').split('\n');
    for (const entry of parseJsonLines(lines, { source: 'codex', file: SESSION_INDEX_FILE })) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      if (!id || !name) continue;

      const updatedAt = parseTimestampMs(entry.updated_at);
      const previous = seenAt.get(id) || 0;
      if (names.has(id) && updatedAt && previous && updatedAt < previous) continue;
      names.set(id, name);
      seenAt.set(id, updatedAt || Date.now());
    }
  } catch { /* ignore malformed or missing session index */ }

  _sessionNamesCache.signature = signature;
  _sessionNamesCache.value = names;
  return names;
}

// ─── Rollout parsing ──────────────────────────────────────

function extractJsonString(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractSessionMetadataFromText(line) {
  const metadataPrefix = line.split('"base_instructions"')[0];
  const agentId = extractJsonString(metadataPrefix, 'id');
  const agentName = extractJsonString(metadataPrefix, 'agent_nickname');
  const agentRole = extractJsonString(metadataPrefix, 'agent_role');
  const agentPath = extractJsonString(metadataPrefix, 'agent_path');
  const parentThreadId = extractJsonString(metadataPrefix, 'parent_thread_id');
  const model = extractJsonString(metadataPrefix, 'model');
  const project = extractJsonString(metadataPrefix, 'cwd');

  return {
    agentId,
    agentName,
    agentType: agentRole || null,
    agentPath,
    parentThreadId,
    model,
    project,
  };
}

function extractTurnMetadataFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { model: null, reasoningEffort: null, project: null, permissionMode: null };
  }
  return {
    model: typeof payload.model === 'string'
      ? payload.model
      : (typeof payload.collaboration_mode?.settings?.model === 'string'
        ? payload.collaboration_mode.settings.model
        : null),
    reasoningEffort: typeof payload.effort === 'string'
      ? payload.effort
      : (typeof payload.reasoning_effort === 'string'
        ? payload.reasoning_effort
        : (typeof payload.collaboration_mode?.settings?.reasoning_effort === 'string'
          ? payload.collaboration_mode.settings.reasoning_effort
          : null)),
    project: typeof payload.cwd === 'string' ? payload.cwd : null,
    permissionMode: permissionModeFromApprovalPolicy(payload.approval_policy),
  };
}

function extractTurnMetadataFromText(line) {
  const metadataPrefix = line.split('"user_instructions"')[0];
  return {
    model: extractJsonString(metadataPrefix, 'model'),
    reasoningEffort: extractJsonString(metadataPrefix, 'effort') || extractJsonString(metadataPrefix, 'reasoning_effort'),
    project: extractJsonString(metadataPrefix, 'cwd'),
    permissionMode: permissionModeFromApprovalPolicy(extractJsonString(metadataPrefix, 'approval_policy')),
  };
}

function permissionModeFromApprovalPolicy(value) {
  if (typeof value !== 'string') return null;
  const policy = value.trim().toLowerCase().replace(/_/g, '-');
  return policy === 'full-auto' || policy === 'never-ask' || policy === 'never'
    ? 'bypassPermissions'
    : null;
}

function parseTurnMetadataLine(line) {
  // The top-level type is near the start of every rollout record. Restricting
  // the fallback check avoids matching quoted transcript content later in it.
  if (!/"type"\s*:\s*"turn_context"/.test(line.slice(0, 256))) return null;

  try {
    const entry = JSON.parse(line);
    if (entry?.type !== 'turn_context') return null;
    return extractTurnMetadataFromPayload(entry.payload);
  } catch {
    return extractTurnMetadataFromText(line);
  }
}

function cacheTurnMetadata(filePath, metadata, identity) {
  _turnMetadataCache.delete(filePath);
  _turnMetadataCache.set(filePath, { ...identity, metadata });
  while (_turnMetadataCache.size > MAX_TURN_METADATA_CACHE_ENTRIES) {
    _turnMetadataCache.delete(_turnMetadataCache.keys().next().value);
  }
  return metadata;
}

/**
 * Spawned Codex rollouts can place the child's first turn_context after a
 * large forked-parent transcript. The latest turn owns model and effort;
 * cache by file identity and scan only appended bytes on subsequent polls.
 */
function readLatestTurnMetadata(filePath) {
  const cached = _turnMetadataCache.get(filePath);
  const identity = earlyMetadataIdentity(filePath);
  if (!identity) return null;
  if (sameEarlyMetadataIdentity(cached, identity)) return cached.metadata;
  const appended = cached && cached.ino === identity.ino && identity.size > cached.size;

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    let position = stat.size;
    // Include the old final chunk so a formerly partial JSONL record can finish.
    const scanStart = appended ? Math.max(0, cached.size - METADATA_BACKSCAN_CHUNK_BYTES) : 0;
    let bytesScanned = 0;
    let carry = '';

    while (position > scanStart && bytesScanned < MAX_METADATA_BACKSCAN_BYTES) {
      const bytesToRead = Math.min(
        METADATA_BACKSCAN_CHUNK_BYTES,
        position - scanStart,
        MAX_METADATA_BACKSCAN_BYTES - bytesScanned,
      );
      position -= bytesToRead;

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      bytesScanned += bytesRead;

      const lines = `${buffer.toString('utf-8', 0, bytesRead)}${carry}`.split('\n');
      const leadingFragment = lines.shift() || '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const metadata = parseTurnMetadataLine(lines[i]);
        if (metadata) return cacheTurnMetadata(filePath, metadata, identity);
      }

      if (position === 0) {
        const metadata = parseTurnMetadataLine(leadingFragment);
        if (metadata) return cacheTurnMetadata(filePath, metadata, identity);
      } else {
        carry = leadingFragment;
      }
    }
  } catch { // Retry unreadable or concurrently rotated rollouts on the next poll.
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  return cacheTurnMetadata(filePath, appended ? cached.metadata : null, identity);
}

function applySessionMetadata(detail, metadata) {
  if (!metadata) return;
  if (!detail.agentId && metadata.agentId) detail.agentId = metadata.agentId;
  if (!detail.agentName && metadata.agentName) detail.agentName = metadata.agentName;
  if ((detail.agentType === 'main' || !detail.agentType) && metadata.agentType) detail.agentType = metadata.agentType;
  if (!detail.agentPath && metadata.agentPath) detail.agentPath = metadata.agentPath;
  if (!detail.parentThreadId && metadata.parentThreadId) detail.parentThreadId = metadata.parentThreadId;
  if (!detail.model && metadata.model) detail.model = metadata.model;
  if (!detail.project && metadata.project) detail.project = metadata.project;
  if (!detail.gitBranch && metadata.gitBranch) detail.gitBranch = metadata.gitBranch;
}

function applyTurnMetadata(detail, metadata, overwrite = false) {
  if (!metadata) return;
  if ((overwrite || !detail.model) && metadata.model) detail.model = metadata.model;
  if ((overwrite || !detail.reasoningEffort) && metadata.reasoningEffort) detail.reasoningEffort = metadata.reasoningEffort;
  if (!detail.project && metadata.project) detail.project = metadata.project;
  if (!detail.permissionMode && metadata.permissionMode) detail.permissionMode = metadata.permissionMode;
}

// Orchestration tools (spawn_agent/send_message) carry the routed prompt as a
// long encrypted `message` blob (gAAAA…). Drop it and keep only the routing
// identifier so the UI shows e.g. {"task_name":"…"} instead of ciphertext.
function orchestrationInputSummary(raw) {
  const parsed = typeof raw === 'string' ? tryParseJsonObject(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.message == null) return null;
  const compact = {};
  for (const key of ['task_name', 'target', 'recipient']) {
    if (parsed[key] != null) compact[key] = parsed[key];
  }
  return Object.keys(compact).length ? JSON.stringify(compact) : null;
}

function tryParseJsonObject(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function summarizeCodexToolPayload(payload, { maxLength = MAX_CURRENT_TOOL_INPUT_CHARS, missingValue = null } = {}) {
  // function_call → arguments; custom_tool_call → input (both JSON/string).
  const raw = payload.arguments || payload.input;
  if (raw) {
    const orchestration = orchestrationInputSummary(raw);
    if (orchestration) {
      return summarizeSharedToolInput(orchestration, { maxLength, missingValue, stringFallback: 'string' });
    }
    const input = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return summarizeSharedToolInput(input, {
      maxLength,
      missingValue,
      stringFallback: 'string',
    });
  }
  if (payload.command) {
    return summarizeSharedToolInput(payload.command, {
      maxLength,
      missingValue,
      stringFallback: 'string',
    });
  }
  return missingValue;
}

function earlyMetadataIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino || 0,
    };
  } catch {
    return null;
  }
}

function sameEarlyMetadataIdentity(cached, identity) {
  return cached
    && cached.size === identity.size
    && cached.mtimeMs === identity.mtimeMs
    && cached.ino === identity.ino;
}

function cacheEarlyMetadata(filePath, identity, metadata, boundary = undefined) {
  const previous = _earlyMetadataCache.get(filePath);
  const retainedBoundary = boundary === undefined ? previous?.boundary || null : boundary;
  _earlyMetadataCache.delete(filePath);
  _earlyMetadataCache.set(filePath, { ...identity, metadata, boundary: retainedBoundary });
  while (_earlyMetadataCache.size > MAX_EARLY_METADATA_CACHE_ENTRIES) {
    _earlyMetadataCache.delete(_earlyMetadataCache.keys().next().value);
  }
  return metadata;
}

function boundaryFromEntry(entry, previous = null) {
  const payload = entry?.payload;
  if (entry?.type !== 'event_msg' || !payload || typeof payload.type !== 'string') return previous;

  const at = toEpochMs(entry.timestamp);
  if (payload.type === 'task_started') {
    return {
      type: payload.type,
      at,
      turnStartedAt: at,
    };
  }
  if (payload.type === 'task_complete' || payload.type === 'turn_complete' || payload.type === 'turn_aborted') {
    return {
      type: payload.type,
      at,
      turnStartedAt: previous?.turnStartedAt || null,
    };
  }
  return previous;
}

function foldRolloutBoundary(entries, initial = null) {
  let boundary = initial;
  for (const entry of entries) {
    const candidate = boundaryFromEntry(entry, boundary);
    if (candidate === boundary) continue;
    if (
      boundary?.at
      && candidate?.at
      && candidate.at < boundary.at
    ) continue;
    boundary = candidate;
  }
  return boundary;
}

function cachedRolloutBoundary(filePath) {
  return _earlyMetadataCache.get(filePath)?.boundary || null;
}

function rememberRolloutBoundary(filePath, entries) {
  const cached = _earlyMetadataCache.get(filePath);
  if (!cached) return foldRolloutBoundary(entries);
  const boundary = foldRolloutBoundary(entries, cached.boundary || null);
  cacheEarlyMetadata(filePath, cached, cached.metadata, boundary);
  return boundary;
}

function readEarlyMetadata(filePath) {
  const identity = earlyMetadataIdentity(filePath);
  if (!identity) {
    _earlyMetadataCache.delete(filePath);
    return null;
  }

  const cached = _earlyMetadataCache.get(filePath);
  if (sameEarlyMetadataIdentity(cached, identity)) {
    return cacheEarlyMetadata(filePath, identity, cached.metadata, cached.boundary || null);
  }

  const headText = readHeadText(filePath);
  if (!headText && identity.size > 0) return null;

  const metadata = {
    agentId: null,
    agentName: null,
    agentType: 'main',
    agentPath: null,
    parentThreadId: null,
    model: null,
    reasoningEffort: null,
    permissionMode: null,
    project: null,
    gitBranch: null,
  };
  let boundary = cached?.boundary || null;

  const lines = headText.split('\n').slice(0, MAX_METADATA_LINES);
  for (const line of lines) {
    if (!line.trim()) continue;

    let entry = null;
    try { entry = JSON.parse(line); } catch { /* oversized early records may be truncated */ }

    if (entry?.type === 'session_meta' && entry.payload) {
      const subagent = entry.payload.source?.subagent?.thread_spawn;
      applySessionMetadata(metadata, {
        agentId: entry.payload.id || null,
        agentName: entry.payload.agent_nickname || subagent?.agent_nickname || null,
        agentType: entry.payload.agent_role || subagent?.agent_role || 'main',
        agentPath: entry.payload.agent_path || subagent?.agent_path || null,
        parentThreadId: subagent?.parent_thread_id || null,
        model: entry.payload.model || null,
        project: entry.payload.cwd || null,
        gitBranch: entry.payload.git?.branch || entry.payload.gitBranch || entry.payload.git_branch || null,
      });
    } else if (line.includes('"type":"session_meta"') || line.includes('"type": "session_meta"')) {
      applySessionMetadata(metadata, extractSessionMetadataFromText(line));
    }

    if (entry?.type === 'turn_context') {
      applyTurnMetadata(metadata, extractTurnMetadataFromPayload(entry.payload));
    } else if (line.includes('"type":"turn_context"') || line.includes('"type": "turn_context"')) {
      applyTurnMetadata(metadata, extractTurnMetadataFromText(line));
    }
    boundary = foldRolloutBoundary(entry ? [entry] : [], boundary);
  }

  return cacheEarlyMetadata(filePath, identity, metadata, boundary);
}

function parseEarlyMetadata(filePath, detail) {
  const metadata = readEarlyMetadata(filePath);
  applySessionMetadata(detail, metadata);
  applyTurnMetadata(detail, metadata);
}

/**
 * Codex multi-agent v2 spawn rollouts inherit the parent's model in every
 * on-disk record (rollout, state DB); the child's variant survives only in
 * the orchestrator's task naming, e.g. agent_path "/root/luna_nav_responsive".
 * Infer the GPT-5.6 variant from that leaf prefix.
 */
function inferCodexModel(detail) {
  const model = detail.model;
  if (!model || !detail.agentPath || !/^gpt-5\.6/i.test(model)) return model;
  const leaf = String(detail.agentPath).split('/').filter(Boolean).pop() || '';
  const match = leaf.match(/^(sol|terra|luna)[-_]/i);
  if (!match) return model;
  return `gpt-5.6-${match[1].toLowerCase()}`;
}

function realpathWithMissingTail(value) {
  const resolved = path.resolve(value);
  let cursor = resolved;
  const missing = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    const canonicalParent = fs.realpathSync.native
      ? fs.realpathSync.native(cursor)
      : fs.realpathSync(cursor);
    return path.resolve(canonicalParent, ...missing);
  } catch {
    return resolved;
  }
}

function relativeWithin(basePath, targetPath) {
  if (!basePath) return null;
  const relative = path.relative(basePath, targetPath);
  if (relative === '') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative;
}

function canonicalWorkingSetPath(rawPath, { cwd = null, project = null } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return null;
  const base = typeof cwd === 'string' && cwd.trim()
    ? cwd
    : (typeof project === 'string' && project.trim() ? project : process.cwd());
  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(base, rawPath);
  const canonical = realpathWithMissingTail(absolute);
  const canonicalProject = typeof project === 'string' && project.trim()
    ? realpathWithMissingTail(project)
    : null;
  const projectRelative = relativeWithin(canonicalProject, canonical);
  if (projectRelative !== null) return projectRelative;

  const canonicalHome = realpathWithMissingTail(path.dirname(CODEX_DIR));
  const homeRelative = relativeWithin(canonicalHome, canonical);
  return homeRelative === null ? canonical : homeRelative;
}

function fileChangeRecords(changes) {
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      if (typeof change === 'string') return [{ path: change, change: null }];
      if (!change || typeof change !== 'object') return [];
      const changePath = typeof change.path === 'string'
        ? change.path
        : (typeof change.file_path === 'string' ? change.file_path : null);
      return changePath ? [{ path: changePath, change }] : [];
    });
  }
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([changePath, change]) => ({ path: changePath, change }));
}

function appendFileChanges(workingSet, seenPaths, entry, project) {
  const payload = entry?.payload;
  const item = payload?.item;
  if (
    entry?.type !== 'event_msg'
    || payload?.type !== 'item_completed'
    || !item
    || typeof item !== 'object'
    || item.type !== 'FileChange'
  ) return;

  const at = toEpochMs(payload.completed_at_ms)
    || toEpochMs(payload.started_at_ms)
    || toEpochMs(entry.timestamp)
    || 0;
  const cwd = typeof item.cwd === 'string'
    ? item.cwd
    : (typeof payload.cwd === 'string' ? payload.cwd : project);

  for (const record of fileChangeRecords(item.changes)) {
    if (workingSet.length >= MAX_WORKING_SET_ITEMS) return;
    const canonicalPath = canonicalWorkingSetPath(record.path, { cwd, project });
    if (!canonicalPath || seenPaths.has(canonicalPath)) continue;
    seenPaths.add(canonicalPath);
    workingSet.push({
      path: canonicalPath,
      op: 'write',
      at,
      source: 'transcript',
    });
  }
}

/**
 * Extract session metadata/tools/messages from Codex rollout JSONL
 * Actual format: all data is inside entry.payload
 */
function createActiveRolloutScanContext(filePath) {
  const windows = readJsonLineWindows(filePath, [
    SUMMARY_SCAN_LINES,
    TOKEN_USAGE_SCAN_LINES,
    GIT_EVENT_SCAN_LINES,
  ]);
  return {
    summaryEntries: windows.get(SUMMARY_SCAN_LINES) || [],
    tokenEntries: windows.get(TOKEN_USAGE_SCAN_LINES) || [],
    gitEntries: windows.get(GIT_EVENT_SCAN_LINES) || [],
  };
}
function projectCodexTodos(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 64).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const subject = typeof item.step === 'string' ? item.step.trim().slice(0, 200) : '';
    const status = ['pending', 'in_progress', 'completed'].includes(item.status)
      ? item.status
      : null;
    return subject && status ? [{ subject, status, phase: null }] : [];
  });
}

function planFromUpdatePlanPayload(payload) {
  let argumentsValue = payload.arguments;
  if (typeof argumentsValue === 'string') {
    try {
      argumentsValue = JSON.parse(argumentsValue);
    } catch {
      argumentsValue = null;
    }
  }
  return argumentsValue && Array.isArray(argumentsValue.plan) ? argumentsValue.plan : [];
}

function projectCodexPrompt(content) {
  const parts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap(block => (
        block
        && ['input_text', 'text'].includes(block.type)
        && typeof block.text === 'string'
          ? [block.text]
          : []
      ))
      : [];
  const text = parts
    .filter(part => !INJECTED_USER_PREFIXES.test(part))
    .map(part => part.replace(/<(system-reminder|advisory)\b[^>]*>[\s\S]*?<\/\1>/gi, ''))
    .join('\n')
    .trim();
  return text.slice(0, 200) || null;
}

// Second, narrower pass behind the summary window: latest genuine user prompt
// and latest update_plan only. Entries already covered by the summary window
// are skipped so a prompt found there is never overwritten by an older one.
function backfillPromptAndPlan(filePath, detail, coveredCount, foundPlan) {
  if (detail.lastPrompt && foundPlan) return;
  const entries = readJsonLines(filePath, { from: 'end', count: PROMPT_PLAN_SCAN_LINES });
  for (let i = entries.length - 1 - coveredCount; i >= 0; i--) {
    const entry = entries[i];
    const payload = entry?.payload;
    if (!payload) continue;
    if (!detail.lastPrompt) {
      if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        detail.lastPrompt = projectCodexPrompt(payload.content);
      } else if (entry.type === 'event_msg' && payload.type === 'user_message') {
        detail.lastPrompt = projectCodexPrompt(payload.message ?? payload.text ?? payload.content);
      }
    }
    if (!foundPlan && entry.type === 'response_item' && payload.type === 'function_call' && payload.name === 'update_plan') {
      detail.todos = projectCodexTodos(planFromUpdatePlanPayload(payload)) || [];
      foundPlan = true;
    }
    if (detail.lastPrompt && foundPlan) return;
  }
}


function parseRollout(filePath, scanContext = null) {
  const detail = {
    agentId: null,
    agentName: null,
    agentType: 'main',
    agentPath: null,
    parentThreadId: null,
    model: null,
    reasoningEffort: null,
    permissionMode: null,
    project: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
  };
  detail.lastPrompt = null;
  detail.todos = [];
  detail.gitBranch = null;

  parseEarlyMetadata(filePath, detail);

  applyTurnMetadata(detail, readLatestTurnMetadata(filePath), true);

  // Read recent tools/messages from the end of the file
  const entries = scanContext?.summaryEntries
    || readJsonLines(filePath, { from: 'end', count: SUMMARY_SCAN_LINES });
  const candidates = [];
  const observedSources = emptyObservedSources();
  const candidateCounts = { plan: 0, thinking: 0, assistant: 0 };
  const workingSet = [];
  const workingSetPaths = new Set();
  const lastResults = [];
  const sessionId = rolloutSessionId(path.basename(filePath));
  let tailPermissionMode = null;
  let collectDialogue = true;
  let foundPlan = false;

  const addDialogue = (text, kind, source, entry, payload) => {
    if (typeof text !== 'string' || !text.trim()) return;

    if (kind === 'plan') observedSources.planStep = true;
    if (kind === 'thinking') observedSources.thinkingPlaintext = true;
    if (kind === 'assistant') observedSources.assistantText = true;

    if (!collectDialogue || candidateCounts[kind] >= 8) return;

    const candidate = makeDialogue({
      text,
      kind,
      source,
      observedAt: parseTimestamp(entry?.timestamp),
      actionId: payload?.call_id || payload?.id || null,
      project: detail.project,
    });
    if (!candidate) return;

    candidates.push(candidate);
    candidateCounts[kind] += 1;
    if (candidateCounts.plan >= 8 && candidateCounts.thinking >= 8 && candidateCounts.assistant >= 8) {
      collectDialogue = false;
    }
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const payload = entry.payload;
    if (!payload) continue;

    // response_item
    if (entry.type === 'response_item') {
      // Tool use (function_call / custom_tool_call)
      if (!detail.lastTool && (payload.type === 'function_call' || payload.type === 'command_execution' || payload.type === 'custom_tool_call')) {
        detail.lastTool = payload.name || payload.type;
        detail.lastToolInput = summarizeCodexToolPayload(payload);
      }

      if (payload.type === 'function_call' && payload.name === 'update_plan') {
        const plan = planFromUpdatePlanPayload(payload);
        if (!foundPlan) {
          const todos = projectCodexTodos(plan);
          detail.todos = todos || [];
          foundPlan = true;
        }
        const currentStep = plan.find((step) => (
          step
          && step.status === 'in_progress'
          && typeof step.step === 'string'
          && step.step.trim()
        ));
        if (currentStep) {
          addDialogue(currentStep.step, 'plan', 'codex.plan.step', entry, payload);
        }
      }

      // Text message (assistant)
      if (!detail.lastMessage && payload.type === 'message' && payload.role === 'assistant') {
        const content = payload.content;
        if (typeof content === 'string') {
          detail.lastMessage = content.substring(0, 80);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'output_text' && block.text) {
              detail.lastMessage = block.text.trim().substring(0, 80);
              break;
            }
            if (block.type === 'text' && block.text) {
              detail.lastMessage = block.text.trim().substring(0, 80);
              break;
            }
          }
        }
      }

      if (payload.type === 'message' && payload.role === 'assistant') {
        const content = payload.content;
        if (typeof content === 'string') {
          addDialogue(content, 'assistant', 'codex.message', entry, payload);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block
              && (block.type === 'output_text' || block.type === 'text')
              && typeof block.text === 'string'
            ) {
              addDialogue(block.text, 'assistant', 'codex.message', entry, payload);
            }
          }
        }
      }

      if (!detail.lastPrompt && payload.type === 'message' && payload.role === 'user') {
        detail.lastPrompt = projectCodexPrompt(payload.content);
      }
    }

    if (entry.type === 'event_msg') {
      appendFileChanges(workingSet, workingSetPaths, entry, detail.project);
      if (!detail.lastPrompt && payload.type === 'user_message') {
        detail.lastPrompt = projectCodexPrompt(payload.message ?? payload.text ?? payload.content);
      }

      const item = payload.type === 'item_completed' && payload.item && typeof payload.item === 'object'
        ? payload.item
        : null;
      if (!detail.lastTool && item?.type === 'CommandExecution') {
        detail.lastTool = typeof item.name === 'string' ? item.name : 'Bash';
        detail.lastToolInput = summarizeCodexToolPayload(item);
      }
      if (lastResults.length < TOOL_RESULT_LIMIT) {
        appendToolResult(lastResults, entry, sessionId);
      }

      if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content') {
        addDialogue(
          payload.text,
          'thinking',
          payload.type === 'agent_reasoning_raw_content'
            ? 'codex.reasoning.raw'
            : 'codex.reasoning.summary',
          entry,
          payload,
        );
      }
    }

    if (entry.type === 'response_item' && payload.type === 'reasoning') {
      if (Array.isArray(payload.summary)) {
        for (const part of payload.summary) {
          if (part?.type === 'summary_text') {
            addDialogue(part.text, 'thinking', 'codex.reasoning.summary', entry, payload);
          }
        }
      }
      if (Array.isArray(payload.content)) {
        for (const part of payload.content) {
          if (part?.type === 'reasoning_text') {
            addDialogue(part.text, 'thinking', 'codex.reasoning.text', entry, payload);
          }
        }
      }
    }

    // If model is missing, try extracting it from turn_context or event_msg
    if (entry.type === 'turn_context') {
      const metadata = extractTurnMetadataFromPayload(payload);
      applyTurnMetadata(detail, metadata);
      if (!tailPermissionMode && metadata.permissionMode) tailPermissionMode = metadata.permissionMode;
    }
    if (!detail.model && entry.type === 'event_msg' && payload.model) {
      detail.model = payload.model;
    }
    if (!detail.reasoningEffort && entry.type === 'event_msg') {
      detail.reasoningEffort = payload.effort || payload.reasoning_effort || null;
    }

    if (!detail.gitBranch) {
      const branch = payload.gitBranch ?? payload.git_branch;
      if (typeof branch === 'string' && branch.trim()) {
        detail.gitBranch = branch.trim().slice(0, 256);
      }
    }
  }

  backfillPromptAndPlan(filePath, detail, entries.length, foundPlan);
  if (tailPermissionMode) detail.permissionMode = tailPermissionMode;
  const priorBoundary = cachedRolloutBoundary(filePath);
  Object.assign(detail, deriveCodexTurnState(entries, Date.now(), priorBoundary, detail.permissionMode));
  rememberRolloutBoundary(filePath, entries);
  detail.signalSource = 'transcript';
  detail.workingSet = workingSet;
  detail.lastResults = lastResults;
  detail.dialogue = pickDialogue(candidates, { now: Date.now() });
  detail.observedSources = observedSources;

  return detail;
}


// Codex states its turn boundaries outright: `task_started` opens a turn and
// `task_complete` closes it, while tool calls pair by `call_id`. The summary
// tail is folded over the cached last boundary, so it costs no extra read.
function deriveCodexTurnState(
  entries,
  now = Date.now(),
  priorBoundary = null,
  permissionMode = null,
) {
  const pendingCalls = new Map();
  let turnEnded = priorBoundary?.type === 'task_complete'
    || priorBoundary?.type === 'turn_complete'
    || priorBoundary?.type === 'turn_aborted';
  let turnEndedAt = turnEnded ? priorBoundary?.at || null : null;
  let turnStartedAt = priorBoundary?.turnStartedAt || null;
  let sawTurnBoundary = Boolean(priorBoundary);

  for (const entry of entries) {
    const payload = entry?.payload;
    if (!payload) continue;

    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      sawTurnBoundary = true;
      turnEnded = false;
      turnEndedAt = null;
      turnStartedAt = toEpochMs(entry.timestamp);
      pendingCalls.clear();
    }
    if (
      entry.type === 'event_msg'
      && (payload.type === 'task_complete' || payload.type === 'turn_complete' || payload.type === 'turn_aborted')
    ) {
      sawTurnBoundary = true;
      turnEnded = true;
      turnEndedAt = toEpochMs(entry.timestamp);
      pendingCalls.clear();
    }

    if (entry.type !== 'response_item') continue;
    if (
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
      && typeof payload.call_id === 'string'
    ) {
      pendingCalls.delete(payload.call_id);
      continue;
    }
    const isCall = payload.type === 'function_call' || payload.type === 'custom_tool_call';
    if (isCall && typeof payload.call_id === 'string') {
      pendingCalls.set(payload.call_id, {
        tool: typeof payload.name === 'string' ? payload.name : payload.type,
        since: toEpochMs(entry.timestamp),
      });
    }
  }

  const pending = pendingCalls.values().next().value || null;
  const pendingTool = pending?.tool || null;
  const pendingSince = pending?.since || null;
  if (!sawTurnBoundary && !pendingTool) {
    return { ...deriveTurnState({ known: false }, now), turnStartedAt: null };
  }

  return {
    ...deriveTurnState({
      turnEnded,
      turnEndedAt,
      pendingTool,
      pendingSince,
      permissionMode,
    }, now),
    turnStartedAt,
  };
}

/**
 * Extract tool history from Codex rollouts
 */
function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 100 });
    const itemsByCallId = new Map();

    for (const entry of entries) {
      const itemCompletion = completionFromItemCompleted(entry);
      if (itemCompletion) {
        let item = itemCompletion.callId ? itemsByCallId.get(itemCompletion.callId) : null;
        if (!item) {
          item = {
            tool: itemCompletion.tool,
            detail: itemCompletion.detail,
            ts: itemCompletion.startedAt || itemCompletion.completedAt || 0,
          };
          tools.push(item);
          if (itemCompletion.callId) itemsByCallId.set(itemCompletion.callId, item);
        }
        applyToolCompletion(item, itemCompletion);
        continue;
      }

      const completion = completionFromExecEvent(entry);
      if (completion) {
        const item = completion.callId ? itemsByCallId.get(completion.callId) : null;
        if (item) applyToolCompletion(item, completion);
        continue;
      }

      if (entry.type !== 'response_item' || !entry.payload) continue;
      const payload = entry.payload;

      if (payload.type === 'function_call' || payload.type === 'command_execution' || payload.type === 'custom_tool_call') {
        const detail = summarizeCodexToolPayload(payload, { maxLength: 80, missingValue: '' });
        const item = {
          tool: payload.name || payload.type,
          detail,
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
        };
        const callId = payload.call_id || payload.id || null;
        if (callId) itemsByCallId.set(callId, item);
        tools.push(item);
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

/**
 * Extract recent messages from Codex rollouts
 */
function getRecentMessages(filePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 60 });

    for (const entry of entries) {
      if (entry.type !== 'response_item' || !entry.payload) continue;
      const payload = entry.payload;
      if (payload.type !== 'message') continue;

      const role = payload.role || 'assistant';
      let text = '';
      if (typeof payload.content === 'string') {
        text = payload.content;
      } else if (Array.isArray(payload.content)) {
        for (const block of payload.content) {
          if ((block.type === 'output_text' || block.type === 'text') && block.text) {
            text = block.text;
            break;
          }
          if (block.type === 'input_text' && block.text && !block.text.startsWith('<environment_context>')) {
            text = block.text;
            break;
          }
        }
      }
      if (text.trim().length > 0) {
        messages.push({
          role,
          text: text.trim().substring(0, 200),
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : 0,
        });
      }
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function readUsageNumber(usage, keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * Codex rollout usage is usually emitted as cumulative token_count events.
 * Older formats may attach per-turn usage directly, so keep that fallback too.
 */
function getTokenUsage(filePath, entries = null) {
  const tokenUsage = {
    availability: 'unavailable',
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
    // Codex output_tokens already includes reasoning_output_tokens
    // (total_tokens = input + output), so reasoning is a breakdown of
    // output and must not be priced again.
    reasoningTokens: 0,
    reasoningInOutput: true,
  };

  try {
    entries = entries || readJsonLines(filePath, { from: 'end', count: TOKEN_USAGE_SCAN_LINES });
    let lastInput = 0;
    let latestTokenCount = null;

    for (const entry of entries) {
      if (entry.payload?.type === 'token_count' && entry.payload.info?.total_token_usage) {
        latestTokenCount = entry.payload.info;
        continue;
      }

      const usage = entry.payload?.usage || entry.usage;
      if (!usage) continue;

      const input = readUsageNumber(usage, [
        'input_tokens',
        'inputTokens',
        'prompt_tokens',
        'promptTokens',
        'total_input_tokens',
      ]);
      const output = readUsageNumber(usage, [
        'output_tokens',
        'outputTokens',
        'completion_tokens',
        'completionTokens',
        'total_output_tokens',
      ]);
      const { cacheRead, cacheCreate } = normalizeCacheTokens(usage, CODEX_TURN_CACHE_FIELD_MAP);

      tokenUsage.availability = 'observed';
      tokenUsage.totalInput += input;
      tokenUsage.totalOutput += output;
      tokenUsage.cacheRead += cacheRead;
      tokenUsage.cacheCreate += cacheCreate;
      tokenUsage.reasoningTokens += readUsageNumber(usage, [
        'reasoning_output_tokens',
        'reasoningOutputTokens',
        'reasoning_tokens',
      ]);
      tokenUsage.turnCount++;
      lastInput = input + cacheRead + cacheCreate;
    }

    if (latestTokenCount) {
      tokenUsage.availability = 'observed';
      const total = latestTokenCount.total_token_usage || {};
      const last = latestTokenCount.last_token_usage || {};
      const totalInput = readUsageNumber(total, ['input_tokens', 'inputTokens']);
      const totalCacheTokens = normalizeCacheTokens(total, CODEX_TOTAL_CACHE_FIELD_MAP);
      const cachedInput = totalCacheTokens.cacheRead;
      const lastTotal = readUsageNumber(last, ['total_tokens', 'totalTokens', 'input_tokens', 'inputTokens']);

      tokenUsage.totalInput = Math.max(0, totalInput - cachedInput);
      tokenUsage.totalOutput = readUsageNumber(total, ['output_tokens', 'outputTokens']);
      tokenUsage.cacheRead = cachedInput;
      tokenUsage.cacheCreate = totalCacheTokens.cacheCreate;
      tokenUsage.reasoningTokens = readUsageNumber(total, [
        'reasoning_output_tokens',
        'reasoningOutputTokens',
      ]);
      tokenUsage.contextWindow = latestTokenCount.model_context_window
        ? Math.min(lastTotal, latestTokenCount.model_context_window)
        : lastTotal;
      tokenUsage.contextWindowMax = latestTokenCount.model_context_window || 0;
      tokenUsage.turnCount = entries.filter(entry => entry.payload?.type === 'token_count').length || tokenUsage.turnCount;
    } else {
      tokenUsage.contextWindow = lastInput;
    }
  } catch { /* ignore */ }

  return tokenUsage;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function parseTimestamp(value) {
  if (value == null) return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function commandFromExecPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.command === 'string') return payload.command;

  if (Array.isArray(payload.command)) {
    const shellFlagIndex = payload.command.findIndex(part => part === '-lc' || part === '-ic' || part === '-c');
    if (shellFlagIndex >= 0 && typeof payload.command[shellFlagIndex + 1] === 'string') {
      return payload.command[shellFlagIndex + 1];
    }
    if (payload.command.every(part => typeof part === 'string')) return payload.command.join(' ');
  }

  if (Array.isArray(payload.parsed_cmd) && payload.parsed_cmd.length === 1) {
    const parsed = payload.parsed_cmd[0];
    if (parsed && typeof parsed.cmd === 'string') return parsed.cmd;
  }

  return null;
}

function completionFromExecEvent(entry) {
  const payload = entry?.payload;
  if (entry?.type !== 'event_msg' || payload?.type !== 'exec_command_end') return null;

  const rawExitCode = payload.exit_code ?? payload.exitCode ?? payload.code;
  const exitCode = Number.isFinite(Number(rawExitCode)) ? Number(rawExitCode) : null;
  const completedAt = parseTimestamp(entry.timestamp || payload.timestamp || payload.completedAt || payload.completed_at);
  let success = null;
  if (typeof payload.success === 'boolean') {
    success = payload.success;
  } else if (exitCode !== null) {
    success = exitCode === 0;
  } else if (payload.status === 'failed' || payload.status === 'error') {
    success = false;
  }

  const stderrParts = [];
  if (typeof payload.stderr === 'string') stderrParts.push(payload.stderr);
  if (typeof payload.stdout === 'string') stderrParts.push(payload.stdout);
  if (!stderrParts.length && typeof payload.aggregated_output === 'string') stderrParts.push(payload.aggregated_output);

  return {
    callId: payload.call_id || payload.callId || payload.id || null,
    command: commandFromExecPayload(payload),
    success,
    exitCode,
    completedAt,
    stderr: stderrParts.join('\n'),
  };
}

function durationObjectToMs(value) {
  if (Number.isFinite(value)) return Math.max(0, value);
  if (!value || typeof value !== 'object') return null;
  const hasSeconds = Number.isFinite(value.secs) || Number.isFinite(value.seconds);
  const hasNanos = Number.isFinite(value.nanos) || Number.isFinite(value.nanoseconds);
  if (!hasSeconds && !hasNanos) return null;
  const seconds = Number.isFinite(value.secs) ? value.secs : (value.seconds || 0);
  const nanos = Number.isFinite(value.nanos) ? value.nanos : (value.nanoseconds || 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  return Math.max(0, (seconds * 1000) + (nanos / 1_000_000));
}

function completionFromItemCompleted(entry) {
  const payload = entry?.payload;
  const item = payload?.item;
  if (
    entry?.type !== 'event_msg'
    || payload?.type !== 'item_completed'
    || !item
    || typeof item !== 'object'
    || item.type !== 'CommandExecution'
  ) return null;

  const rawExitCode = item.exit_code ?? item.exitCode;
  const exitCode = Number.isFinite(rawExitCode) ? rawExitCode : null;
  const startedAt = Number.isFinite(payload.started_at_ms)
    ? payload.started_at_ms
    : toEpochMs(item.started_at_ms ?? item.startedAt ?? entry.timestamp);
  const completedAt = Number.isFinite(payload.completed_at_ms)
    ? payload.completed_at_ms
    : toEpochMs(item.completed_at_ms ?? item.completedAt ?? entry.timestamp);
  let durationMs = Number.isFinite(item.duration_ms)
    ? Math.max(0, item.duration_ms)
    : (Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs) : null);
  if (durationMs === null) durationMs = durationObjectToMs(item.duration);
  if (durationMs === null && startedAt !== null && completedAt !== null) {
    durationMs = Math.max(0, completedAt - startedAt);
  }

  const stderr = typeof item.stderr === 'string' ? item.stderr : '';
  return {
    callId: typeof item.call_id === 'string'
      ? item.call_id
      : (typeof item.id === 'string' ? item.id : null),
    tool: typeof item.name === 'string' ? item.name : 'Bash',
    detail: summarizeCodexToolPayload(item, { maxLength: 80, missingValue: '' }),
    exitCode,
    durationMs,
    startedAt,
    completedAt,
    stderr,
  };
}

function applyToolCompletion(item, completion) {
  if (!item || !completion) return;
  if (Number.isFinite(completion.exitCode)) {
    item.toolExitCode = completion.exitCode;
    if (completion.exitCode !== 0 && typeof completion.stderr === 'string' && completion.stderr.trim()) {
      item.toolStderr = completion.stderr.trim().substring(0, 200);
    }
  }
  if (Number.isFinite(completion.durationMs)) item.durationMs = completion.durationMs;
}

// `rollout-<id>.jsonl` names the session; the public id prefixes it. Both the
// list build and the result records below derive from this one place so a
// result id keeps naming the session that produced it.
function rolloutSessionId(fileName) {
  return `codex-${String(fileName || '').replace('rollout-', '').replace('.jsonl', '')}`;
}

// Codex reports a finished command as its own `item_completed` record with an
// exit code and a duration. That record — never a `function_call`, never a call
// vanishing from the tail — is what earns a result. `exit_code` may be absent
// on an interrupted command; the outcome then stays explicitly unknown.
function appendToolResult(results, entry, sessionId) {
  const completion = completionFromItemCompleted(entry);
  if (!completion || !completion.completedAt) return;
  const detail = typeof completion.detail === 'string' ? completion.detail : '';
  results.push({
    id: toolResultId({
      provider: 'codex',
      sessionId,
      callId: completion.callId,
      tool: completion.tool,
      detail,
      completedAt: completion.completedAt,
    }),
    tool: completion.tool,
    detail,
    exitCode: completion.exitCode,
    durationMs: completion.durationMs,
    completedAt: completion.completedAt,
    source: 'transcript',
  });
}

function rememberGitEvents(events, bySourceId, byCommandHash) {
  for (const event of events) {
    if (event.sourceId) {
      if (!bySourceId.has(event.sourceId)) bySourceId.set(event.sourceId, new Map());
      bySourceId.get(event.sourceId).set(event.id, event);
    }

    if (event.commandHash) {
      if (!byCommandHash.has(event.commandHash)) byCommandHash.set(event.commandHash, new Map());
      byCommandHash.get(event.commandHash).set(event.id, event);
    }
  }
}

function applyCompletionMetadata(eventsById, completion) {
  if (!eventsById || !completion) return;
  for (const event of eventsById.values()) {
    if (typeof completion.success === 'boolean') event.success = completion.success;
    if (completion.exitCode !== null) event.exitCode = completion.exitCode;
    if (completion.completedAt) event.completedAt = completion.completedAt;
    if (completion.stderr) event.stderr = completion.stderr;
  }
}

function getGitEvents(filePath, context, entries = null) {
  const events = [];
  try {
    entries = entries || readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    const eventsBySourceId = new Map();
    const eventsByCommandHash = new Map();

    entries.forEach((entry, entryIndex) => {
      const completion = completionFromExecEvent(entry);
      if (completion) {
        if (completion.callId && eventsBySourceId.has(completion.callId)) {
          applyCompletionMetadata(eventsBySourceId.get(completion.callId), completion);
          return;
        }

        const command = normalizeCommand(completion.command);
        const eventsById = command ? eventsByCommandHash.get(stableHash(command)) : null;
        if (eventsById && eventsById.size === 1) applyCompletionMetadata(eventsById, completion);
        return;
      }

      if (entry.type !== 'response_item' || !entry.payload) return;
      const payload = entry.payload;
      if (payload.type !== 'function_call' && payload.type !== 'command_execution') return;

      const commandSources = [];
      if (payload.command) commandSources.push(payload.command);
      if (payload.arguments) commandSources.push(payload.arguments);

      commandSources.forEach((source, sourceIndex) => {
        const parsedEvents = extractGitEventsFromCommandSource(source, {
          ...context,
          ts: entry.timestamp || payload.timestamp || 0,
          sourceId: payload.call_id || payload.id || entry.id || `${stableHash(JSON.stringify(entry))}:${sourceIndex}`,
        });
        events.push(...parsedEvents);
        rememberGitEvents(parsedEvents, eventsBySourceId, eventsByCommandHash);
      });
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

/**
 * Scan rollout files by file mtime, not date-directory recency.
 * Long-running sessions keep appending to their original day folder.
 */
function readSortedChildDirs(parentDir) {
  try {
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
  } catch (error) {
    noteReadFailure(error);
    return [];
  }
}

function readRolloutFileNames(dayDir) {
  try {
    return fs.readdirSync(dayDir)
      .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch (error) {
    noteReadFailure(error);
    return [];
  }
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

function rememberRolloutFile(filePath, fileName, mtime, dayDir) {
  _rolloutDiscoveryCache.filesByPath.set(filePath, { fileName, mtime, dayDir });
}

function pruneRolloutDiscoveryCache({ validateDayDirs = false } = {}) {
  if (validateDayDirs) {
    const missingDayDirs = new Set();
    for (const dayDir of _rolloutDiscoveryCache.dayDirMtimes.keys()) {
      if (!fs.existsSync(dayDir)) missingDayDirs.add(dayDir);
    }
    for (const dayDir of missingDayDirs) {
      _rolloutDiscoveryCache.dayDirMtimes.delete(dayDir);
    }
    if (missingDayDirs.size > 0) {
      for (const [filePath, cached] of _rolloutDiscoveryCache.filesByPath) {
        if (missingDayDirs.has(cached.dayDir)) _rolloutDiscoveryCache.filesByPath.delete(filePath);
      }
      for (const filePath of _rolloutDiscoveryCache.warmFilePaths) {
        if (missingDayDirs.has(path.dirname(filePath))) {
          _rolloutDiscoveryCache.warmFilePaths.delete(filePath);
        }
      }
    }
  }

  if (_rolloutDiscoveryCache.filesByPath.size > MAX_ROLLOUT_FILES) {
    const victims = Array.from(_rolloutDiscoveryCache.filesByPath.entries())
      .sort((left, right) => {
        const leftWarm = _rolloutDiscoveryCache.warmFilePaths.has(left[0]) ? 1 : 0;
        const rightWarm = _rolloutDiscoveryCache.warmFilePaths.has(right[0]) ? 1 : 0;
        return leftWarm - rightWarm || (left[1].mtime || 0) - (right[1].mtime || 0);
      });
    const removeCount = _rolloutDiscoveryCache.filesByPath.size - MAX_ROLLOUT_FILES;
    for (let index = 0; index < removeCount; index++) {
      const [filePath] = victims[index];
      _rolloutDiscoveryCache.filesByPath.delete(filePath);
    }
  }

  const warmDayDirs = new Set(
    Array.from(_rolloutDiscoveryCache.warmFilePaths, filePath => path.dirname(filePath)),
  );
  while (_rolloutDiscoveryCache.dayDirMtimes.size > MAX_ROLLOUT_DAY_DIRS) {
    const dayDirs = Array.from(_rolloutDiscoveryCache.dayDirMtimes.keys());
    const victim = dayDirs.find(dayDir => !warmDayDirs.has(dayDir)) || dayDirs[0];
    _rolloutDiscoveryCache.dayDirMtimes.delete(victim);
  }
}

function collectWarmRollouts(activeCutoffMs, recentCutoffMs, counters) {
  const results = [];

  for (const filePath of _rolloutDiscoveryCache.warmFilePaths) {
    counters.cachedFileStats++;
    const mtime = statMtimeMs(filePath);
    if (mtime === null) {
      _rolloutDiscoveryCache.filesByPath.delete(filePath);
      _rolloutDiscoveryCache.warmFilePaths.delete(filePath);
      continue;
    }

    const cached = _rolloutDiscoveryCache.filesByPath.get(filePath);
    if (cached) cached.mtime = mtime;
    if (mtime < recentCutoffMs) {
      _rolloutDiscoveryCache.warmFilePaths.delete(filePath);
    }
    if (mtime < activeCutoffMs) continue;

    results.push({
      filePath,
      mtime,
      fileName: cached?.fileName || path.basename(filePath),
    });
  }

  return results;
}

function scanRolloutDayDir(dayDir, activeCutoffMs, recentCutoffMs, resultsByPath, counters) {
  const fileNames = readRolloutFileNames(dayDir);

  for (const fileName of fileNames) {
    if (counters.files >= MAX_ROLLOUT_FILES) {
      counters.limited = true;
      return;
    }

    const filePath = path.join(dayDir, fileName);
    const mtime = statMtimeMs(filePath);
    counters.files++;
    if (mtime === null) continue;

    rememberRolloutFile(filePath, fileName, mtime, dayDir);
    if (mtime >= recentCutoffMs) {
      _rolloutDiscoveryCache.warmFilePaths.add(filePath);
    } else {
      _rolloutDiscoveryCache.warmFilePaths.delete(filePath);
    }
    if (mtime < activeCutoffMs) continue;

    resultsByPath.set(filePath, { filePath, mtime, fileName });
  }
}

function readNewestRolloutDayDirs(limit = MAX_WARM_ROLLOUT_DAY_DIRS) {
  const dayDirs = [];
  const years = readSortedChildDirs(SESSIONS_DIR);

  outer:
  for (const year of years) {
    const yearDir = path.join(SESSIONS_DIR, year);
    const months = readSortedChildDirs(yearDir);
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const days = readSortedChildDirs(monthDir);
      for (const day of days) {
        dayDirs.push(path.join(monthDir, day));
        if (dayDirs.length >= limit) break outer;
      }
    }
  }

  return dayDirs;
}

function collectWarmRolloutDayDirs() {
  const dayDirs = new Set();
  for (const filePath of _rolloutDiscoveryCache.warmFilePaths) {
    dayDirs.add(path.dirname(filePath));
  }
  for (const dayDir of readNewestRolloutDayDirs()) dayDirs.add(dayDir);
  return dayDirs;
}

function scanRecentRollouts(activeThresholdMs, { force = false } = {}) {
  const startedAt = Date.now();
  const normalizedThresholdMs = Number.isFinite(activeThresholdMs)
    ? Math.max(0, activeThresholdMs)
    : 0;
  const activeCutoffMs = startedAt - normalizedThresholdMs;
  const recentCutoffMs = activeCutoffMs - Math.max(normalizedThresholdMs, 60 * 1000);
  const resultsByPath = new Map();
  const counters = { dayDirs: 0, files: 0, cachedFileStats: 0, limited: false };
  const reconcile = force
    || !_rolloutDiscoveryCache.initialized
    || _rolloutDiscoveryCache.reconcileRequested;

  if (!fs.existsSync(SESSIONS_DIR)) {
    _rolloutDiscoveryCache.initialized = false;
    _rolloutDiscoveryCache.filesByPath.clear();
    _rolloutDiscoveryCache.dayDirMtimes.clear();
    _rolloutDiscoveryCache.warmFilePaths.clear();
    _rolloutDiscoveryCache.reconcileRequested = true;
    recordRolloutDiscoveryStats(startedAt, activeThresholdMs, counters, 0, 'reconcile');
    return [];
  }

  if (!reconcile) {
    for (const rollout of collectWarmRollouts(activeCutoffMs, recentCutoffMs, counters)) {
      resultsByPath.set(rollout.filePath, rollout);
    }
  }

  try {
    if (!reconcile) {
      for (const dayDir of collectWarmRolloutDayDirs()) {
        if (counters.dayDirs >= MAX_ROLLOUT_DAY_DIRS) {
          counters.limited = true;
          break;
        }

        const dayDirMtime = statMtimeMs(dayDir);
        if (dayDirMtime === null) continue;

        counters.dayDirs++;
        const previousDayDirMtime = _rolloutDiscoveryCache.dayDirMtimes.get(dayDir);
        _rolloutDiscoveryCache.dayDirMtimes.set(dayDir, dayDirMtime);
        if (
          previousDayDirMtime !== undefined
          && Math.abs(dayDirMtime - previousDayDirMtime) <= ROLLOUT_DIR_MTIME_EPSILON_MS
        ) {
          continue;
        }

        scanRolloutDayDir(dayDir, activeCutoffMs, recentCutoffMs, resultsByPath, counters);
        if (counters.limited) break;
      }
    } else {
      const years = readSortedChildDirs(SESSIONS_DIR);

      yearLoop:
      for (const year of years) {
        const yearDir = path.join(SESSIONS_DIR, year);
        const months = readSortedChildDirs(yearDir);

        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          const days = readSortedChildDirs(monthDir);

          for (const day of days) {
            const dayDir = path.join(monthDir, day);

            if (counters.dayDirs >= MAX_ROLLOUT_DAY_DIRS) {
              counters.limited = true;
              break yearLoop;
            }

            const dayDirMtime = statMtimeMs(dayDir);
            if (dayDirMtime === null) continue;

            counters.dayDirs++;
            _rolloutDiscoveryCache.dayDirMtimes.set(dayDir, dayDirMtime);

            scanRolloutDayDir(dayDir, activeCutoffMs, recentCutoffMs, resultsByPath, counters);
            if (counters.limited) break yearLoop;
          }
        }
      }
    }
  } catch { /* ignore */ }

  _rolloutDiscoveryCache.initialized = true;
  _rolloutDiscoveryCache.reconcileRequested = false;
  pruneRolloutDiscoveryCache({ validateDayDirs: reconcile });
  const rollouts = Array.from(resultsByPath.values()).sort((a, b) => b.mtime - a.mtime);
  recordRolloutDiscoveryStats(
    startedAt,
    activeThresholdMs,
    counters,
    rollouts.length,
    reconcile ? 'reconcile' : 'warm',
  );
  return rollouts;
}

function recordRolloutDiscoveryStats(startedAt, activeThresholdMs, counters, resultCount, mode) {
  const capped = Boolean(counters.limited);
  _rolloutDiscoveryStats = {
    at: Date.now(),
    durationMs: Date.now() - startedAt,
    mode,
    activeThresholdMs,
    dayDirsScanned: counters.dayDirs,
    rolloutFilesScanned: counters.files,
    cachedFileStats: counters.cachedFileStats,
    resultCount,
    capped,
    caps: {
      dayDirs: MAX_ROLLOUT_DAY_DIRS,
      rolloutFiles: MAX_ROLLOUT_FILES,
    },
    warning: capped
      ? `Codex rollout discovery hit scan cap after ${counters.dayDirs} day directories and ${counters.files} rollout files`
      : null,
  };
}

// ─── Adapter class ────────────────────────────────────

class CodexAdapter {
  get name() { return 'Codex CLI'; }
  get provider() { return 'codex'; }
  get homeDir() { return CODEX_DIR; }

  isAvailable() {
    return fs.existsSync(CODEX_DIR);
  }

  getActiveSessions(activeThresholdMs, { force = false } = {}) {
    const rollouts = scanRecentRollouts(activeThresholdMs, { force });
    const sessionNames = readCodexSessionNames();
    const sessions = [];
    const parsedRollouts = [];
    const sessionIdByThreadId = new Map();

    for (const { filePath, mtime, fileName } of rollouts) {
      const scanContext = createActiveRolloutScanContext(filePath);
      const detail = parseRollout(filePath, scanContext);
      // Extract session ID from the filename: rollout-2025-01-22T10-30-00-abc123.jsonl
      const fullSessionId = rolloutSessionId(fileName);
      const sessionId = fullSessionId.slice('codex-'.length);
      _rolloutFileBySessionId.set(fullSessionId, filePath);
      const threadId = detail.agentId || sessionId;
      sessionIdByThreadId.set(threadId, fullSessionId);
      parsedRollouts.push({ filePath, mtime, detail, scanContext, sessionId, fullSessionId, threadId });
    }
    const activeSessionIds = new Set(parsedRollouts.map((rollout) => rollout.fullSessionId));
    for (const sessionId of _rolloutFileBySessionId.keys()) {
      if (!activeSessionIds.has(sessionId)) _rolloutFileBySessionId.delete(sessionId);
    }

    for (const { filePath, mtime, detail, scanContext, sessionId, fullSessionId, threadId } of parsedRollouts) {
      const sessionName = sessionNames.get(threadId) || sessionNames.get(sessionId) || detail.agentName || null;
      sessions.push({
        sessionId: fullSessionId,
        provider: 'codex',
        agentId: threadId,
        name: sessionName,
        agentName: sessionName,
        agentType: detail.agentType || 'main',
        model: inferCodexModel(detail) || 'codex',
        reasoningEffort: detail.reasoningEffort,
        permissionMode: detail.permissionMode,
        turnState: detail.turnState,
        signalSource: detail.signalSource,
        signalCertainty: detail.signalCertainty,
        turnStartedAt: detail.turnStartedAt,
        pendingTool: detail.pendingTool,
        pendingSince: detail.pendingSince,
        awaitingSince: detail.awaitingSince,
        waitReason: detail.waitReason,
        status: 'active',
        lastActivity: mtime,
        project: detail.project || null,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        dialogue: detail.dialogue,
        observedSources: detail.observedSources,
        workingSet: detail.workingSet,
        lastResults: detail.lastResults,
        lastPrompt: detail.lastPrompt,
        todos: detail.todos,
        gitBranch: detail.gitBranch,
        tokenUsage: getTokenUsage(filePath, scanContext.tokenEntries),
        gitEvents: getGitEvents(filePath, {
          provider: 'codex',
          sessionId: fullSessionId,
          project: detail.project || null,
        }, scanContext.gitEntries),
        parentSessionId: detail.parentThreadId
          ? sessionIdByThreadId.get(detail.parentThreadId) || `codex-${detail.parentThreadId}`
          : null,
      });
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    // sessionIdto find the file
    const cleanId = sessionId.replace('codex-', '');
    const indexedPath = _rolloutFileBySessionId.get(sessionId);
    if (indexedPath && fs.existsSync(indexedPath)) {
      return createDetailResponse({
        toolHistory: getToolHistory(indexedPath),
        messages: getRecentMessages(indexedPath),
        tokenUsage: getTokenUsage(indexedPath),
        sessionId,
      });
    }

    const rollouts = scanRecentRollouts(30 * 60 * 1000); // expand to a 30-minute range

    for (const { filePath, fileName } of rollouts) {
      const fileId = fileName.replace('rollout-', '').replace('.jsonl', '');
      if (fileId === cleanId) {
        _rolloutFileBySessionId.set(sessionId, filePath);
        return createDetailResponse({
          toolHistory: getToolHistory(filePath),
          messages: getRecentMessages(filePath),
          tokenUsage: getTokenUsage(filePath),
          sessionId,
        });
      }
    }

    return createDetailResponse({ sessionId });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(CODEX_DIR)) {
      paths.push({ type: 'directory', path: CODEX_DIR, filters: ['sessions', 'session_index.jsonl'], scope: 'discovery', kind: 'discovery' });
    }
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, scope: 'discovery', kind: 'discovery' });
    }
    if (fs.existsSync(SESSION_INDEX_FILE)) {
      paths.push({ type: 'file', path: SESSION_INDEX_FILE, scope: 'discovery', kind: 'metadata', probe: true });
    }
    for (const session of sessions) {
      const filePath = _rolloutFileBySessionId.get(session.sessionId);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const dayDir = path.dirname(filePath);
      const monthDir = path.dirname(dayDir);
      const yearDir = path.dirname(monthDir);
      const dirtyTarget = {
        sessionId: session.sessionId,
        project: session.project,
      };
      paths.push({ type: 'directory', path: yearDir, scope: 'recent', kind: 'discovery', activity: session.lastActivity });
      paths.push({ type: 'directory', path: monthDir, scope: 'recent', kind: 'discovery', activity: session.lastActivity });
      paths.push({
        type: 'directory',
        path: dayDir,
        filters: ['.jsonl'],
        scope: 'active',
        kind: 'transcript',
        probe: true,
        activity: session.lastActivity,
        ...dirtyTarget,
      });
      paths.push({
        type: 'file',
        path: filePath,
        scope: 'active',
        kind: 'transcript',
        probe: true,
        activity: session.lastActivity,
        ...dirtyTarget,
      });
    }
    return paths;
  }

  invalidateCaches() {
    clearTailCache('codex');
    _rolloutFileBySessionId.clear();
    _sessionNamesCache.signature = '';
    _sessionNamesCache.value = new Map();
    _earlyMetadataCache.clear();
    // Keep rollout discovery metadata across ordinary provider invalidations.
    // Watch events usually mean one file changed; dropping this cache would turn
    // every active-session refresh back into a full historical scan.
  }

  invalidateCachesForDirty(dirty = {}) {
    if (dirty.path) {
      const cached = _earlyMetadataCache.get(dirty.path);
      if (cached) {
        // Force a metadata refresh while retaining the last transcript
        // boundary across append notifications.
        _earlyMetadataCache.set(dirty.path, { ...cached, size: -1, mtimeMs: -1 });
      }
      _turnMetadataCache.delete(dirty.path);
    }
    if (dirty.kind === 'metadata') {
      _sessionNamesCache.signature = '';
      _sessionNamesCache.value = new Map();
    }
    if (
      dirty.kind === 'transcript'
      && dirty.path
      && path.basename(dirty.path).startsWith('rollout-')
      && dirty.path.endsWith('.jsonl')
    ) {
      _rolloutDiscoveryCache.warmFilePaths.add(dirty.path);
    }
    if (dirty.kind === 'reconcile') {
      _rolloutDiscoveryCache.reconcileRequested = true;
    }
  }

  getPerfStats() {
    return {
      rolloutDiscovery: {
        ..._rolloutDiscoveryStats,
        cachedFiles: _rolloutDiscoveryCache.filesByPath.size,
        cachedDayDirectories: _rolloutDiscoveryCache.dayDirMtimes.size,
        warmFiles: _rolloutDiscoveryCache.warmFilePaths.size,
        indexedSessions: _rolloutFileBySessionId.size,
        earlyMetadataEntries: _earlyMetadataCache.size,
        turnMetadataEntries: _turnMetadataCache.size,
      },
    };
  }
}

module.exports = { CodexAdapter };
