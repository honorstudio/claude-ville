/**
 * Grok CLI adapter (xAI)
 * Data source: ~/.grok/
 *
 * Session layout:
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json        — id, cwd, model, title, timestamps, reasoning_effort
 *     updates.jsonl       — ACP session updates (tool calls, message chunks)
 *     chat_history.jsonl  — raw model messages + tool_calls
 *     events.jsonl        — internal telemetry (tool_started/completed, phases)
 *     subagents/          — optional child sessions
 *
 * Active process index (optional hint, not required for discovery):
 *   ~/.grok/active_sessions.json → [{ session_id, pid, cwd, opened_at }]
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const { deriveTurnState } = require('./turnState');
const path = require('path');
const os = require('os');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  createDetailResponse,
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  normalizeCacheTokens,
  readJsonLines: readSharedJsonLines,
  summarizeToolInput: summarizeSharedToolInput,
  trimCache,
  statCacheKey,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');

const MAX_DIALOGUE_CANDIDATES_PER_KIND = 8;

const GROK_DIR = path.join(os.homedir(), '.grok');
const SESSIONS_DIR = path.join(GROK_DIR, 'sessions');
const ACTIVE_SESSIONS_FILE = path.join(GROK_DIR, 'active_sessions.json');

const MAX_HEAD_BYTES = 512 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const SESSION_CACHE_MAX = 256;
const DETAIL_SCAN_LINES = 400;
const GIT_EVENT_SCAN_LINES = 2000;
const GROK_CACHE_FIELD_MAP = Object.freeze({
  // Grok's ACP stream currently exposes only a cumulative context total.
  cacheRead: [],
  cacheCreate: [],
});

const GROK_TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'cmd',
  'file_path',
  'target_file',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
  'content',
]);

const _sessionIndex = new Map(); // sessionId (with prefix) -> { dir, summaryPath, updatesPath, chatPath }
const _summaryCache = new Map(); // summaryPath -> { key, summary }
const _tailParseCache = new Map(); // filePath -> { key, detail }
const _subagentMetaCache = new Map(); // meta.json path -> { key, childId, parentId }
const _projectSessionsCache = new Map(); // projectPath -> { mtimeMs, entries }
const _discoveryPerf = {
  activePasses: 0,
  filesDiscovered: 0,
  filesStatted: 0,
  filesSkippedBeforeRead: 0,
  filesOpened: 0,
  bytesRead: 0,
  linesParsed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  statErrors: 0,
  lastPassAt: null,
  lastPassDurationMs: 0,
  lastFilesDiscovered: 0,
  lastFilesStatted: 0,
  lastFilesSkippedBeforeRead: 0,
  lastFilesOpened: 0,
  lastBytesRead: 0,
  lastLinesParsed: 0,
  lastCacheHits: 0,
  lastCacheMisses: 0,
  lastStatErrors: 0,
  projectCacheHits: 0,
  projectCacheMisses: 0,
  lastDiscoveredSessions: 0,
  lastActiveSessions: 0,
};

const MAX_SUBAGENT_META_READS = 2000;

// ─── Helpers ────────────────────────────────────────────────

function stripGrokSessionPrefix(sessionId) {
  return String(sessionId || '').replace(/^grok-/, '');
}

function readJsonLines(filePath, { from = 'end', count = 100 } = {}) {
  return readSharedJsonLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'grok',
  });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

function parseTimestampMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs ms heuristic
    return value < 1e12 ? value * 1000 : value;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function decodeProjectDirName(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function getSummary(summaryPath, fileStat = null) {
  try {
    const stat = fileStat || fs.statSync(summaryPath);
    const key = statCacheKey(summaryPath, stat);
    const cached = _summaryCache.get(summaryPath);
    if (cached?.key === key) {
      _summaryCache.delete(summaryPath);
      _summaryCache.set(summaryPath, cached);
      return cached.summary;
    }
    const summary = readJsonFile(summaryPath);
    if (!summary) return null;
    _summaryCache.set(summaryPath, { key, summary });
    trimCache(_summaryCache, SESSION_CACHE_MAX);
    return summary;
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

function summarizeGrokToolInput(input, { maxLength = 60, missingValue = null } = {}) {
  return summarizeSharedToolInput(input, {
    fields: GROK_TOOL_INPUT_FIELDS,
    basenameFields: ['file_path', 'target_file', 'path'],
    maxLength,
    missingValue,
    objectFallback: 'json',
    stringFallback: 'string',
  });
}

function toolNameFromUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const metaTool = update._meta?.['x.ai/tool'] || update._meta?.xai_tool || null;
  return (
    metaTool?.name
    || update.title
    || update.toolName
    || update.tool_name
    || update.name
    || null
  );
}

function toolInputFromUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.rawInput && typeof update.rawInput === 'object') return update.rawInput;
  const metaTool = update._meta?.['x.ai/tool'] || null;
  if (metaTool?.input && typeof metaTool.input === 'object') return metaTool.input;
  return null;
}

function extractTextContent(content) {
  if (!content) return null;
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') parts.push(part.text);
        else if (part.type === 'text' && typeof part.content === 'string') parts.push(part.content);
      }
    }
    const joined = parts.join('').trim();
    return joined || null;
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim() || null;
  }
  return null;
}

function recordTimestampMs(record, { includeMeta = false } = {}) {
  const timestamp = parseTimestampMs(record?.timestamp);
  if (timestamp || !includeMeta) return timestamp;
  return parseTimestampMs(record?.params?._meta?.agentTimestampMs);
}

function actionIdFromRecord(record, update = null) {
  return record?.params?._meta?.eventId
    || record?._meta?.eventId
    || update?.toolCallId
    || update?.tool_call_id
    || update?.itemId
    || update?.item_id
    || update?.messageId
    || update?.message_id
    || record?.id
    || null;
}

// ─── Session scan ───────────────────────────────────────────

function listSessionDirs() {
  const results = [];
  if (!fs.existsSync(SESSIONS_DIR)) return results;

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  } catch (error) {
    noteReadFailure(error);
    return results;
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(SESSIONS_DIR, projectDir.name);
    const projectFromName = decodeProjectDirName(projectDir.name);
    let projectMtimeMs = 0;
    try {
      projectMtimeMs = fs.statSync(projectPath).mtimeMs;
    } catch (error) {
      noteReadFailure(error);
      continue;
    }
    const cached = _projectSessionsCache.get(projectPath);
    if (cached?.mtimeMs === projectMtimeMs) {
      _discoveryPerf.projectCacheHits++;
      results.push(...cached.entries);
      continue;
    }
    _discoveryPerf.projectCacheMisses++;

    let sessionDirs = [];
    try {
      sessionDirs = fs.readdirSync(projectPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
    } catch (error) {
      noteReadFailure(error);
      continue;
    }

    const projectEntries = [];
    for (const sessionDir of sessionDirs) {
      const dir = path.join(projectPath, sessionDir.name);
      const summaryPath = path.join(dir, 'summary.json');
      projectEntries.push({
        dir,
        sessionUuid: sessionDir.name,
        projectFromName,
        summaryPath,
        updatesPath: path.join(dir, 'updates.jsonl'),
        chatPath: path.join(dir, 'chat_history.jsonl'),
        eventsPath: path.join(dir, 'events.jsonl'),
      });
    }
    _projectSessionsCache.set(projectPath, { mtimeMs: projectMtimeMs, entries: projectEntries });
    results.push(...projectEntries);
  }
  const activeProjects = new Set(projectDirs.map(projectDir => path.join(SESSIONS_DIR, projectDir.name)));
  for (const projectPath of _projectSessionsCache.keys()) {
    if (!activeProjects.has(projectPath)) _projectSessionsCache.delete(projectPath);
  }
  _discoveryPerf.lastDiscoveredSessions = results.length;
  return results;
}

function readSubagentMeta(metaPath) {
  try {
    const stat = fs.statSync(metaPath);
    const key = statCacheKey(metaPath, stat);
    const cached = _subagentMetaCache.get(metaPath);
    if (cached?.key === key) {
      _subagentMetaCache.delete(metaPath);
      _subagentMetaCache.set(metaPath, cached);
      return cached;
    }
    const meta = readJsonFile(metaPath);
    if (!meta) return null;
    const record = {
      key,
      childId: meta.child_session_id || meta.subagent_id || null,
      parentId: meta.parent_session_id || null,
    };
    _subagentMetaCache.set(metaPath, record);
    trimCache(_subagentMetaCache, SESSION_CACHE_MAX);
    return record;
  } catch {
    return null;
  }
}

// Grok records the parent link under <parentDir>/subagents/<childId>/meta.json,
// not on the child's own summary. Build a child→parent map once per scan so
// subagent sessions can resolve their owner without rescanning per session.
function buildSubagentParentIndex(entries, wantedChildIds = null) {
  const childToParent = new Map();
  const wanted = wantedChildIds ? new Set(wantedChildIds) : null;
  let reads = 0;
  for (const entry of entries) {
    if (wanted && childToParent.size >= wanted.size) break;
    if (reads >= MAX_SUBAGENT_META_READS) break;
    const subagentsDir = path.join(entry.dir, 'subagents');
    let childDirs;
    try {
      childDirs = fs.readdirSync(subagentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const child of childDirs) {
      if (wanted && !wanted.has(child.name)) continue;
      if (reads >= MAX_SUBAGENT_META_READS) break;
      reads++;
      const meta = readSubagentMeta(path.join(subagentsDir, child.name, 'meta.json'));
      const childId = meta?.childId || child.name;
      const parentId = meta?.parentId || entry.sessionUuid;
      if (childId && parentId && (!wanted || wanted.has(childId))) {
        childToParent.set(childId, parentId);
      }
    }
  }
  return childToParent;
}

function sessionActivityMs(entry, summary, { sessionStat = null, summaryStat = null } = {}) {
  const candidates = [
    parseTimestampMs(summary?.last_active_at),
    parseTimestampMs(summary?.updated_at),
    parseTimestampMs(summary?.created_at),
  ];
  if (sessionStat) candidates.push(sessionStat.mtimeMs);
  for (const filePath of [entry.updatesPath, entry.chatPath, entry.eventsPath, entry.summaryPath]) {
    try {
      if (filePath === entry.summaryPath && summaryStat) {
        candidates.push(summaryStat.mtimeMs);
      } else if (fs.existsSync(filePath)) {
        candidates.push(fs.statSync(filePath).mtimeMs);
      }
    } catch { /* ignore */ }
  }
  return Math.max(0, ...candidates.filter((n) => Number.isFinite(n) && n > 0));
}

function inactiveByAge(ageMs, threshold) {
  return threshold != null && (
    threshold <= 0
    || (Number.isFinite(threshold) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs > threshold)
  );
}

function parseLiveDetail(entry, project = null) {
  const detail = {
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
    contextTokens: 0,
    lifecycle: deriveTurnState({ known: false }),
    dialogueCandidates: [],
    observedSources: emptyObservedSources(),
  };
  const dialogueCounts = { thinking: 0, assistant: 0 };

  const addDialogue = ({ text, kind, source, record, update, actionId = undefined }) => {
    if (typeof text !== 'string' || !text.trim()) return;
    if (kind === 'thinking') detail.observedSources.thinkingPlaintext = true;
    else if (kind === 'assistant') detail.observedSources.assistantText = true;
    if (dialogueCounts[kind] >= MAX_DIALOGUE_CANDIDATES_PER_KIND) return;

    const candidate = makeDialogue({
      text,
      kind,
      source,
      observedAt: recordTimestampMs(record, { includeMeta: true }),
      actionId: actionId === undefined ? actionIdFromRecord(record, update) : actionId,
      project,
    });
    if (!candidate) return;
    detail.dialogueCandidates.push(candidate);
    dialogueCounts[kind] += 1;
  };

  const cacheKeyPath = fs.existsSync(entry.updatesPath) ? entry.updatesPath : entry.chatPath;
  if (!cacheKeyPath || !fs.existsSync(cacheKeyPath)) return detail;

  try {
    const stat = fs.statSync(cacheKeyPath);
    const key = statCacheKey(cacheKeyPath, stat);
    const cached = _tailParseCache.get(cacheKeyPath);
    if (cached?.key === key) {
      _tailParseCache.delete(cacheKeyPath);
      _tailParseCache.set(cacheKeyPath, cached);
      return cached.detail;
    }
  } catch { /* fall through */ }

  // Prefer updates.jsonl — authoritative live tool/message stream.
  // shared.readJsonLines already returns parsed objects.
  if (fs.existsSync(entry.updatesPath)) {
    const records = readJsonLines(entry.updatesPath, { from: 'end', count: DETAIL_SCAN_LINES });
    const pending = new Map();
    let known = false;
    for (const record of records) {
      const update = record?.params?.update || record?.update;
      const kind = update?.sessionUpdate;
      if (kind === 'user_message_chunk') { known = true; pending.clear(); }
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') known = true;
      if (kind === 'tool_call' && update.toolCallId) {
        known = true;
        pending.set(update.toolCallId, { pendingTool: toolNameFromUpdate(update) || 'tool', pendingSince: recordTimestampMs(record, { includeMeta: true }) });
      }
      if (kind === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) pending.delete(update.toolCallId);
    }
    detail.lifecycle = deriveTurnState({ known, ...[...pending.values()].at(-1) });
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (!record || typeof record !== 'object') continue;
      const update = record?.params?.update || record?.update || null;
      const meta = record?.params?._meta || record?._meta || {};
      if (Number.isFinite(Number(meta.totalTokens)) && !detail.contextTokens) {
        detail.contextTokens = Number(meta.totalTokens);
      }
      if (!update || typeof update !== 'object') continue;
      const kind = update.sessionUpdate;

      if (!detail.lastTool && (kind === 'tool_call' || kind === 'tool_call_update')) {
        const name = toolNameFromUpdate(update);
        if (name) {
          detail.lastTool = name;
          const input = toolInputFromUpdate(update);
          if (input) detail.lastToolInput = summarizeGrokToolInput(input, { maxLength: 60 });
        }
      }

      if (kind === 'agent_thought_chunk') {
        addDialogue({
          text: extractTextContent(update.content),
          kind: 'thinking',
          source: 'grok.thought.chunk',
          actionId: record?.params?._meta?.eventId || null,
          record,
          update,
        });
      } else if (kind === 'agent_message_chunk') {
        const text = extractTextContent(update.content);
        addDialogue({
          text,
          kind: 'assistant',
          source: 'grok.message',
          record,
          update,
        });
        if (!detail.lastMessage && text) detail.lastMessage = text.substring(0, 80);
      }

      if (
        detail.lastTool
        && detail.lastMessage
        && detail.contextTokens
        && dialogueCounts.thinking >= MAX_DIALOGUE_CANDIDATES_PER_KIND
        && dialogueCounts.assistant >= MAX_DIALOGUE_CANDIDATES_PER_KIND
      ) break;
    }

    // If no agent_message_chunk yet, fall back to the latest user chunk for a breadcrumb.
    if (!detail.lastMessage) {
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i];
        const update = record?.params?.update || null;
        if (update?.sessionUpdate === 'user_message_chunk') {
          const text = extractTextContent(update.content);
          if (text) {
            detail.lastMessage = text.substring(0, 80);
            break;
          }
        }
      }
    }
  }

  // chat_history fallback for last tool / assistant text when updates are sparse.
  if ((!detail.lastTool || !detail.lastMessage) && fs.existsSync(entry.chatPath)) {
    const records = readJsonLines(entry.chatPath, { from: 'end', count: 80 });
    if (detail.lifecycle.turnState === 'unknown') {
      const pending = new Map();
      let known = false;
      for (const record of records) {
        if (record?.type === 'user') { known = true; pending.clear(); }
        if (record?.type === 'assistant') {
          known = true;
          for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
            if (call.id) pending.set(call.id, { pendingTool: call.name || 'tool', pendingSince: recordTimestampMs(record, { includeMeta: true }) });
          }
        }
        if (record?.type === 'tool_result') pending.delete(record.tool_call_id);
      }
      detail.lifecycle = deriveTurnState({ known, ...[...pending.values()].at(-1) });
    }
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (!record || typeof record !== 'object') continue;
      if (!detail.lastTool && record.type === 'assistant' && Array.isArray(record.tool_calls) && record.tool_calls.length) {
        const tc = record.tool_calls[record.tool_calls.length - 1];
        detail.lastTool = tc.name || 'tool';
        let args = tc.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep string */ }
        }
        if (args) detail.lastToolInput = summarizeGrokToolInput(args, { maxLength: 60 });
      }
      if (!detail.lastMessage && record.type === 'assistant') {
        const text = extractTextContent(record.content);
        if (text) detail.lastMessage = text.substring(0, 80);
      }
      if (detail.lastTool && detail.lastMessage) break;
    }
  }

  try {
    const stat = fs.statSync(cacheKeyPath);
    _tailParseCache.set(cacheKeyPath, { key: statCacheKey(cacheKeyPath, stat), detail: { ...detail } });
    trimCache(_tailParseCache, SESSION_CACHE_MAX);
  } catch { /* ignore */ }

  return detail;
}

function getToolHistory(entry, maxItems = 15) {
  const tools = [];
  if (fs.existsSync(entry.updatesPath)) {
    const records = readJsonLines(entry.updatesPath, { from: 'end', count: DETAIL_SCAN_LINES });
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const update = record?.params?.update;
      if (!update || update.sessionUpdate !== 'tool_call') continue;
      const name = toolNameFromUpdate(update) || 'tool';
      const input = toolInputFromUpdate(update);
      const ts = parseTimestampMs(record.timestamp)
        || parseTimestampMs(record?.params?._meta?.agentTimestampMs)
        || 0;
      tools.push({
        tool: name,
        detail: input ? summarizeGrokToolInput(input, { maxLength: 80, missingValue: '' }) : '',
        ts,
      });
    }
    if (tools.length) return tools.slice(-maxItems);
  }

  if (fs.existsSync(entry.chatPath)) {
    const records = readJsonLines(entry.chatPath, { from: 'end', count: 200 });
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (record.type !== 'assistant' || !Array.isArray(record.tool_calls)) continue;
      for (const tc of record.tool_calls) {
        let args = tc.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep */ }
        }
        tools.push({
          tool: tc.name || 'tool',
          detail: args ? summarizeGrokToolInput(args, { maxLength: 80, missingValue: '' }) : '',
          ts: 0,
        });
      }
    }
  }
  return tools.slice(-maxItems);
}

function getRecentMessages(entry, maxItems = 5) {
  const messages = [];

  // Prefer chat_history — full turns rather than streaming chunks.
  if (fs.existsSync(entry.chatPath)) {
    const records = readJsonLines(entry.chatPath, { from: 'end', count: 120 });
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (record.type === 'system' || record.type === 'tool_result' || record.type === 'reasoning') continue;
      const role = record.type === 'assistant' ? 'assistant'
        : record.type === 'user' ? 'user'
          : null;
      if (!role) continue;
      const text = extractTextContent(record.content);
      if (!text) continue;
      messages.push({ role, text: text.substring(0, 200), ts: 0 });
    }
    if (messages.length) return messages.slice(-maxItems);
  }

  if (fs.existsSync(entry.updatesPath)) {
    const records = readJsonLines(entry.updatesPath, { from: 'end', count: DETAIL_SCAN_LINES });
    let assistantBuf = '';
    let userBuf = '';
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const update = record?.params?.update;
      if (!update) continue;
      const text = extractTextContent(update.content);
      if (!text) continue;
      if (update.sessionUpdate === 'agent_message_chunk') assistantBuf += text;
      else if (update.sessionUpdate === 'user_message_chunk') userBuf += text;
    }
    if (userBuf.trim()) messages.push({ role: 'user', text: userBuf.trim().substring(0, 200), ts: 0 });
    if (assistantBuf.trim()) messages.push({ role: 'assistant', text: assistantBuf.trim().substring(0, 200), ts: 0 });
  }
  return messages.slice(-maxItems);
}

function getGitEvents(entry, context) {
  const events = [];
  const sources = [];

  if (fs.existsSync(entry.updatesPath)) {
    const records = readJsonLines(entry.updatesPath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      const update = record?.params?.update;
      if (!update) return;
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
      const name = toolNameFromUpdate(update) || '';
      const input = toolInputFromUpdate(update);
      if (!input) return;
      if (!/terminal|bash|shell|run_terminal/i.test(name) && update.kind !== 'execute') {
        if (input.command == null && input.cmd == null) return;
      }
      const ts = parseTimestampMs(record.timestamp)
        || parseTimestampMs(record?.params?._meta?.agentTimestampMs)
        || 0;
      sources.push({
        input,
        ts,
        sourceId: update.toolCallId || `${stableHash(JSON.stringify(record))}:${index}`,
      });
    });
  }

  if (!sources.length && fs.existsSync(entry.chatPath)) {
    const records = readJsonLines(entry.chatPath, { from: 'end', count: 500 });
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      if (record.type !== 'assistant' || !Array.isArray(record.tool_calls)) return;
      record.tool_calls.forEach((tc, callIndex) => {
        if (!/terminal|bash|shell|run_terminal/i.test(tc.name || '')) return;
        let args = tc.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { return; }
        }
        if (!args) return;
        sources.push({
          input: args,
          ts: 0,
          sourceId: tc.id || `${stableHash(JSON.stringify(record))}:${callIndex}`,
        });
      });
    });
  }

  for (const source of sources) {
    events.push(...extractGitEventsFromCommandSource(source.input, {
      ...context,
      ts: source.ts,
      sourceId: source.sourceId,
      stderr: '',
    }));
  }
  return dedupeGitEvents(events);
}

function buildTokenUsage(summary, liveDetail) {
  const contextWindow = Number(liveDetail?.contextTokens) || 0;
  const cacheTokens = normalizeCacheTokens(null, GROK_CACHE_FIELD_MAP);
  const model = String(summary?.current_model_id || '').toLowerCase();
  let contextWindowMax = 500000;
  if (model.includes('composer')) contextWindowMax = 256000;
  else if (model.includes('4.3') || model.includes('4.20')) contextWindowMax = 1000000;

  if (!contextWindow) {
    return {
      availability: 'unavailable',
      input: 0,
      output: 0,
      cacheRead: cacheTokens.cacheRead,
      cacheCreate: cacheTokens.cacheCreate,
      contextWindow: 0,
      contextWindowMax,
    };
  }
  // Grok currently surfaces a single cumulative totalTokens figure in the
  // ACP update stream, not a full input/output split. Treat it as context
  // window occupancy so the UI can show a meter without inventing costs.
  return {
    availability: 'unavailable',
    input: 0,
    output: 0,
    cacheRead: cacheTokens.cacheRead,
    cacheCreate: cacheTokens.cacheCreate,
    contextWindow,
    contextWindowMax,
  };
}

function registerSession(prefixedId, entry) {
  _sessionIndex.set(prefixedId, entry);
}

function resolveEntry(sessionId) {
  const prefixed = String(sessionId || '').startsWith('grok-')
    ? String(sessionId)
    : `grok-${sessionId}`;
  const cached = _sessionIndex.get(prefixed);
  if (cached && fs.existsSync(cached.summaryPath)) return { prefixed, entry: cached };

  const cleanId = stripGrokSessionPrefix(sessionId);
  for (const entry of listSessionDirs()) {
    if (entry.sessionUuid === cleanId) {
      registerSession(prefixed, entry);
      return { prefixed, entry };
    }
  }
  return { prefixed, entry: null };
}

// ─── Adapter ────────────────────────────────────────────────

class GrokAdapter {
  get name() { return 'Grok CLI'; }
  get provider() { return 'grok'; }
  get homeDir() { return GROK_DIR; }

  isAvailable() {
    return fs.existsSync(GROK_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const startedAt = Date.now();
    const now = Date.now();
    const sessions = [];

    const entries = listSessionDirs();
    const pass = {
      filesDiscovered: entries.length,
      filesStatted: 0,
      filesSkippedBeforeRead: 0,
      filesOpened: 0,
      bytesRead: 0,
      linesParsed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statErrors: 0,
    };
    const diagnosticsBefore = getJsonlDiagnostics()[this.provider]?.parsedLines || 0;
    const tailBefore = getTailCacheDiagnostics().parsed;
    const threshold = activeThresholdMs == null ? null : Number(activeThresholdMs);
    const activeEntries = [];

    for (const entry of entries) {
      let sessionStat;
      let summaryStat;
      pass.filesStatted += 1;
      try {
        sessionStat = fs.statSync(entry.dir);
        summaryStat = fs.statSync(entry.summaryPath);
      } catch (error) {
        noteReadFailure(error);
        pass.statErrors += 1;
        pass.filesSkippedBeforeRead += 1;
        continue;
      }

      const ageMs = now - sessionActivityMs(entry, null, { sessionStat, summaryStat });
      if (inactiveByAge(ageMs, threshold)) {
        pass.filesSkippedBeforeRead += 1;
        continue;
      }

      pass.filesOpened += 1;
      pass.bytesRead += Math.min(summaryStat.size, MAX_HEAD_BYTES);
      const summary = getSummary(entry.summaryPath, summaryStat);
      if (!summary) continue;

      const lastActivity = sessionActivityMs(entry, summary, { sessionStat, summaryStat });
      if (!lastActivity || inactiveByAge(now - lastActivity, threshold)) continue;
      activeEntries.push({ entry, summary, lastActivity });
    }
    const unresolvedChildIds = activeEntries
      .filter(({ summary }) => (
        summary.session_kind === 'subagent'
        && !summary.parent_session_id
        && !summary.parentSessionId
      ))
      .map(({ entry, summary }) => summary?.info?.id || entry.sessionUuid);
    const subagentParents = buildSubagentParentIndex(entries, unresolvedChildIds);
    _discoveryPerf.lastActiveSessions = activeEntries.length;

    for (const { entry, summary, lastActivity } of activeEntries) {
      const info = summary.info || {};
      const sessionUuid = info.id || entry.sessionUuid;
      const prefixedId = `grok-${sessionUuid}`;
      registerSession(prefixedId, entry);

      const project = info.cwd || summary.git_root_dir || entry.projectFromName || null;
      const projectClean = project ? String(project).replace(/\/$/, '') : null;
      const live = parseLiveDetail(entry, projectClean);
      const model = summary.current_model_id || 'grok';
      const agentName = summary.agent_name || summary.generated_title || summary.session_summary || null;
      const isSubagent = summary.session_kind === 'subagent';
      const parentUuid = subagentParents.get(sessionUuid)
        || summary.parent_session_id
        || summary.parentSessionId
        || null;

      sessions.push({
        sessionId: prefixedId,
        provider: 'grok',
        agentId: sessionUuid,
        agentType: isSubagent ? 'sub-agent' : 'main',
        agentName,
        project: projectClean,
        model,
        status: 'active',
        lastActivity,
        lastTool: live.lastTool,
        lastToolInput: live.lastToolInput,
        lastMessage: live.lastMessage,
        dialogue: pickDialogue(live.dialogueCandidates, { now: Date.now() }),
        observedSources: live.observedSources,
        ...live.lifecycle,
        tokenUsage: buildTokenUsage(summary, live),
        parentSessionId: parentUuid ? `grok-${parentUuid}` : null,
        reasoningEffort: summary.reasoning_effort || null,
        gitEvents: getGitEvents(entry, {
          provider: 'grok',
          sessionId: prefixedId,
          project: projectClean,
        }),
      });
    }

    const diagnosticsAfter = getJsonlDiagnostics()[this.provider]?.parsedLines || 0;
    const tailAfter = getTailCacheDiagnostics().parsed;
    pass.bytesRead += Math.max(0, tailAfter.bytesRead - tailBefore.bytesRead);
    pass.linesParsed = Math.max(0, diagnosticsAfter - diagnosticsBefore);
    pass.cacheHits = Math.max(0, tailAfter.hits - tailBefore.hits);
    pass.cacheMisses = Math.max(0, tailAfter.misses - tailBefore.misses);
    this._recordActivePass(startedAt, pass);
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  _recordActivePass(startedAt, pass) {
    _discoveryPerf.activePasses += 1;
    for (const field of [
      'filesDiscovered',
      'filesStatted',
      'filesSkippedBeforeRead',
      'filesOpened',
      'bytesRead',
      'linesParsed',
      'cacheHits',
      'cacheMisses',
      'statErrors',
    ]) {
      _discoveryPerf[field] += pass[field];
      _discoveryPerf[`last${field[0].toUpperCase()}${field.slice(1)}`] = pass[field];
    }
    _discoveryPerf.lastPassAt = Date.now();
    _discoveryPerf.lastPassDurationMs = _discoveryPerf.lastPassAt - startedAt;
  }

  getSessionDetail(sessionId) {
    const { prefixed, entry } = resolveEntry(sessionId);
    if (!entry) return createDetailResponse({ sessionId: prefixed });

    const summary = getSummary(entry.summaryPath);
    const project = summary?.info?.cwd || summary?.git_root_dir || entry.projectFromName || null;
    const projectClean = project ? String(project).replace(/\/$/, '') : null;
    const live = parseLiveDetail(entry, projectClean);
    return createDetailResponse({
      toolHistory: getToolHistory(entry),
      messages: getRecentMessages(entry),
      tokenUsage: buildTokenUsage(summary, live),
      sessionId: prefixed,
      agentName: summary?.agent_name || summary?.generated_title || null,
    });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(GROK_DIR)) {
      paths.push({ type: 'directory', path: GROK_DIR, filters: ['sessions', 'active_sessions.json'], scope: 'discovery' });
    }
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, scope: 'discovery' });
    }
    if (fs.existsSync(ACTIVE_SESSIONS_FILE)) {
      paths.push({ type: 'file', path: ACTIVE_SESSIONS_FILE, scope: 'discovery', probe: true });
    }
    for (const session of sessions) {
      const entry = _sessionIndex.get(session.sessionId);
      if (!entry?.dir || !fs.existsSync(entry.dir)) continue;
      paths.push({ type: 'directory', path: path.dirname(entry.dir), scope: 'recent', activity: session.lastActivity });
      paths.push({
        type: 'directory',
        path: entry.dir,
        filters: ['summary.json', '.jsonl'],
        scope: 'active',
        probe: true,
        activity: session.lastActivity,
      });
      for (const filePath of [entry.summaryPath, entry.updatesPath, entry.chatPath, entry.eventsPath]) {
        if (filePath && fs.existsSync(filePath)) {
          paths.push({ type: 'file', path: filePath, scope: 'active', probe: true, activity: session.lastActivity });
        }
      }
    }
    return paths;
  }

  invalidateCaches() {
    _sessionIndex.clear();
    _summaryCache.clear();
    _tailParseCache.clear();
    _subagentMetaCache.clear();
    _projectSessionsCache.clear();
  }

  getPerfStats() {
    return {
      ..._discoveryPerf,
      projectCacheEntries: _projectSessionsCache.size,
    };
  }
}

module.exports = { GrokAdapter };
