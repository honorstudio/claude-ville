/**
 * Oh My Pi (OMP) agent-hub adapter.
 *
 * OMP persists one JSONL transcript for each session under
 * ~/.omp/agent/sessions/<project>/<session>.jsonl. Nested task agents are
 * stored below the parent transcript in <session>/<agent-name>.jsonl.
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDetailResponse,
  getJsonlDiagnostics,
  getTailCacheDiagnostics,
  normalizeCacheTokens,
  readJsonLines,
  summarizeToolInput,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState } = require('./turnState');

const OMP_HOME = path.join(os.homedir(), '.omp');
const DEFAULT_SESSIONS_DIR = path.join(OMP_HOME, 'agent', 'sessions');
const TRANSCRIPT_HEAD_LINES = 32;
const TRANSCRIPT_HEAD_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_LINES = 2500;
const DETAIL_TAIL_LINES = 5000;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPTS = 4096;
const TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'cmd',
  'path',
  'filePath',
  'file_path',
  'pattern',
  'query',
  'prompt',
  'content',
  'description',
  'target',
  'recipient',
]);
const OMP_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: [usage => usage?.cacheRead ?? usage?.cache_read],
  cacheCreate: [usage => usage?.cacheWrite ?? usage?.cacheCreate ?? usage?.cache_create],
});

function parseTimestamp(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function transcriptId(sessionId) {
  return sessionId ? `omp-${sessionId}` : '';
}

function rawSessionId(sessionId) {
  return String(sessionId || '').replace(/^omp-/, '');
}

function extractText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .filter(Boolean);
    const text = parts.join('').trim();
    return text || null;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim() || null;
  }
  return null;
}

function compactText(value, maxLength = 200) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
function projectPrompt(content) {
  const text = extractText(content)
    ?.replace(/<(system-reminder|advisory)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();
  return text ? text.slice(0, 200) : null;
}

function todoItems(argumentsValue) {
  const items = [];
  const append = (value, rawPhase = null) => {
    const phase = typeof rawPhase === 'string' && rawPhase.trim()
      ? rawPhase.trim().slice(0, 80)
      : null;
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const rawSubject = typeof item === 'string'
        ? item
        : (typeof item?.task === 'string' ? item.task : item?.subject);
      const key = typeof rawSubject === 'string' ? rawSubject.trim() : '';
      if (!key) continue;
      const rawStatus = typeof item?.status === 'string' ? item.status : 'pending';
      const status = ['pending', 'in_progress', 'completed'].includes(rawStatus)
        ? rawStatus
        : 'pending';
      items.push({ key, subject: key.slice(0, 200), status, phase });
    }
  };
  for (const group of Array.isArray(argumentsValue?.list) ? argumentsValue.list : []) {
    append(group?.items, typeof group?.phase === 'string' ? group.phase : null);
  }
  append(argumentsValue?.items, typeof argumentsValue?.phase === 'string' ? argumentsValue.phase : null);
  if (typeof argumentsValue?.task === 'string' && ['init', 'append'].includes(argumentsValue.op)) {
    append([argumentsValue.task], typeof argumentsValue?.phase === 'string' ? argumentsValue.phase : null);
  }
  return items;
}

function applyTodoOperation(todos, rawArguments) {
  let argumentsValue = rawArguments;
  if (typeof argumentsValue === 'string') {
    try { argumentsValue = JSON.parse(argumentsValue); } catch { return; }
  }
  if (!argumentsValue || typeof argumentsValue !== 'object') return;
  const op = argumentsValue.op;
  if (op === 'init') {
    todos.splice(0, todos.length, ...todoItems(argumentsValue));
    return;
  }
  if (op === 'append') {
    todos.push(...todoItems(argumentsValue));
    return;
  }
  if (!['done', 'start', 'drop'].includes(op)) return;
  const task = typeof argumentsValue.task === 'string' ? argumentsValue.task.trim() : null;
  const phase = typeof argumentsValue.phase === 'string' && argumentsValue.phase.trim()
    ? argumentsValue.phase.trim().slice(0, 80)
    : null;
  const matches = todo => (!task || todo.key === task) && (!phase || todo.phase === phase);
  if (!task && !phase) return;
  if (op === 'drop') {
    for (let index = todos.length - 1; index >= 0; index--) {
      if (matches(todos[index])) todos.splice(index, 1);
    }
    return;
  }
  const status = op === 'start' ? 'in_progress' : 'completed';
  for (const todo of todos) {
    if (matches(todo)) todo.status = status;
  }
}


function readUsage(rawUsage, total) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const input = number(rawUsage.input ?? rawUsage.totalInput ?? rawUsage.input_tokens);
  const output = number(rawUsage.output ?? rawUsage.totalOutput ?? rawUsage.output_tokens);
  const { cacheRead, cacheCreate } = normalizeCacheTokens(rawUsage, OMP_CACHE_FIELD_MAP);
  total.input += input;
  total.output += output;
  total.cacheRead += cacheRead;
  total.cacheCreate += cacheCreate;
  total.reasoningTokens += number(rawUsage.reasoningTokens ?? rawUsage.reasoning_tokens);
  total.turnCount += 1;
  return true;
}
function mergeRecords(head, tail) {
  const records = [];
  const seen = new Set();
  for (const record of [...head, ...tail]) {
    if (!record || typeof record !== 'object') continue;
    const key = record.id
      ? `id:${record.id}`
      : `record:${record.type || ''}:${record.timestamp || ''}:${record.parentId || ''}:${records.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return records;
}

function childParentId(filePath, sessionsDir) {
  const parentDir = path.basename(path.dirname(filePath));
  if (path.dirname(filePath) === sessionsDir) return null;
  const match = parentDir.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}

function childName(filePath, sessionsDir) {
  return childParentId(filePath, sessionsDir)
    ? path.basename(filePath, '.jsonl')
    : null;
}

function modelProvider(model) {
  const value = String(model || '');
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : null;
}

// Match Claude's bounded, newest-per-path transcript projection. Edit paths
// come from structured per-file results, never from patch or result prose.
function workingSetPath(value, project, readSelector = false) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  let filePath = value.trim().slice(0, 4096);
  if (readSelector) filePath = filePath.replace(/:(?:raw|img|conflicts|\d+(?:[-+]\d*)?|-\d+)(?:,\d+(?:-\d+)?)?(?=:|$)/g, '');
  if (!filePath || /[:?*]/.test(filePath) || filePath.includes(';')) return null;
  if (filePath.startsWith('~/')) filePath = path.join(os.homedir(), filePath.slice(2));
  let canonical = path.resolve(project || process.cwd(), filePath);
  try { if (fs.statSync(canonical).isDirectory()) return null; } catch { /* missing files are valid writes */ }
  let cursor = canonical;
  const suffix = [];
  while (cursor !== path.dirname(cursor)) {
    try {
      canonical = path.join(fs.realpathSync(cursor), ...suffix.reverse());
      break;
    } catch {
      suffix.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
  for (const [base, prefix] of [[project, ''], [os.homedir(), '~/']]) {
    if (!base) continue;
    let root = path.resolve(base);
    try { root = fs.realpathSync(root); } catch { /* keep resolved path */ }
    const relative = path.relative(root, canonical);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return prefix + relative.split(path.sep).join('/');
    }
  }
  return canonical.split(path.sep).join('/');
}

function parseOmpTranscript(records, {
  filePath = '',
  parentSessionId = null,
  childAgentName = null,
  now = Date.now(),
  activeThresholdMs = null,
  fallbackProject = null,
  detail = true,
  fileMtimeMs = null,
} = {}) {
  let session = null;
  let title = null;
  let model = null;
  let underlyingProvider = null;
  let latestActivity = 0;
  let latestAssistantText = null;
  let latestAssistantTs = 0;
  let lastPrompt = null;
  let gitBranch = null;
  let turnStartedAt = null;
  let turnEnded = false;
  let turnEndedAt = null;
  let latestTool = null;
  let latestToolInput = null;
  const pendingTools = new Map();
  const todos = [];
  const toolHistory = [];
  const messages = [];
  const workingSet = [];
  const rememberPath = (value, op, at, readSelector = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    workingSet.push({ path: value.trim().slice(0, 4096), op, at, readSelector });
    if (workingSet.length > 64) workingSet.shift();
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };
  const dialogueBuckets = new Map();
  const observedSources = emptyObservedSources();
  const rememberDialogue = ({ text, kind, source, observedAt, actionId = null, observedKey }) => {
    if (typeof text !== 'string' || !text.trim()) return;
    observedSources[observedKey] = true;
    let bucket = dialogueBuckets.get(kind);
    if (!bucket) {
      bucket = [];
      dialogueBuckets.set(kind, bucket);
    }
    bucket.unshift({ text, kind, source, observedAt, actionId });
    if (bucket.length > 8) bucket.pop();
  };

  for (const record of records || []) {
    const recordTs = parseTimestamp(record?.timestamp);
    const customTs = parseTimestamp(record?.data?.recordedAt);
    latestActivity = Math.max(latestActivity, recordTs, customTs);
    const branch = record?.gitBranch
      ?? record?.git_branch
      ?? record?.git?.branch
      ?? record?.data?.gitBranch
      ?? record?.data?.git_branch
      ?? record?.data?.git?.branch;
    if (typeof branch === 'string' && branch.trim()) gitBranch = branch.trim().slice(0, 256);

    if (record?.type === 'session') {
      session = record;
      title = record.title || title;
      latestActivity = Math.max(latestActivity, parseTimestamp(record.timestamp));
      continue;
    }
    if (record?.type === 'title' || record?.type === 'title_change') {
      const nextTitle = record.title || record.data?.title;
      if (nextTitle) title = String(nextTitle);
      latestActivity = Math.max(latestActivity, parseTimestamp(record.updatedAt));
      continue;
    }
    if (record?.type === 'model_change' && record.model) {
      model = String(record.model);
      underlyingProvider = modelProvider(model) || underlyingProvider;
      continue;
    }
    if (record?.type === 'custom' && record.customType === 'session_exit') {
      turnEnded = true;
      turnEndedAt = recordTs || customTs || turnEndedAt;
      continue;
    }

    const message = record?.type === 'message' ? record.message : null;
    if (!message || typeof message !== 'object') continue;
    const messageTs = parseTimestamp(message.timestamp) || recordTs;
    latestActivity = Math.max(latestActivity, messageTs);
    if (message.provider) underlyingProvider = String(message.provider);
    if (message.model) model = String(message.model);
    if (message.usage) readUsage(message.usage, usage);

    const role = String(message.role || '');
    if (role === 'assistant') {
      const text = extractText(message.content);
      if (text) {
        latestAssistantText = compactText(text);
        latestAssistantTs = messageTs;
        turnEnded = true;
        turnEndedAt = messageTs || turnEndedAt;
        rememberDialogue({
          text,
          kind: 'assistant',
          source: 'omp.message',
          observedAt: messageTs,
          observedKey: 'assistantText',
        });
        if (detail) messages.push({ role: 'assistant', text: compactText(text), ts: messageTs });
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'thinking') {
          rememberDialogue({
            text: part.thinking,
            kind: 'thinking',
            source: 'omp.thinking',
            observedAt: messageTs,
            observedKey: 'thinkingPlaintext',
          });
          continue;
        }
        if (part.type !== 'toolCall') continue;
        const tool = String(part.name || 'tool');
        const toolCallId = String(part.id || `${tool}:${messageTs}:${toolHistory.length}`);
        const args = part.arguments ?? null;
        if (tool === 'todo') applyTodoOperation(todos, args);
        if (tool === 'read' || tool === 'write') {
          rememberPath(args?.path, tool === 'read' ? 'read' : 'write', messageTs, tool === 'read');
        }
        if (args && typeof args === 'object') {
          rememberDialogue({
            text: args.i,
            kind: 'intent',
            source: 'omp.tool.i',
            observedAt: messageTs,
            actionId: part.id ?? null,
            observedKey: 'toolIntent',
          });
        }
        const entry = {
          tool,
          detail: summarizeToolInput(args, {
            fields: TOOL_INPUT_FIELDS,
            basenameFields: ['path', 'filePath', 'file_path'],
            maxLength: 80,
            missingValue: '',
            objectFallback: 'json',
            stringFallback: 'string',
            parseJsonStrings: true,
            compactWhitespace: true,
          }),
          ts: messageTs,
        };
        latestTool = tool;
        latestToolInput = entry.detail || null;
        if (detail) toolHistory.push(entry);
        pendingTools.set(toolCallId, { tool, ts: messageTs });
        turnEnded = false;
        turnEndedAt = null;
      }
      continue;
    }
    if (role === 'user') {
      const text = extractText(message.content);
      const prompt = projectPrompt(message.content);
      if (prompt) lastPrompt = prompt;
      if (detail && text) messages.push({ role: 'user', text: compactText(text), ts: messageTs });
      turnStartedAt = messageTs || turnStartedAt;
      turnEnded = false;
      turnEndedAt = null;
      continue;
    }
    if (role === 'toolResult' || role === 'tool') {
      if (message.toolCallId) pendingTools.delete(String(message.toolCallId));
      if (message.toolName === 'edit' && !message.isError && Array.isArray(message.details?.perFileResults)) {
        for (const result of message.details.perFileResults) rememberPath(result?.path, 'write', messageTs);
      }
    }
  }

  if (!session?.id) return null;
  const sessionId = transcriptId(String(session.id));
  const project = session.cwd || fallbackProject || null;
  const statActivity = fileMtimeMs != null && Number.isFinite(Number(fileMtimeMs))
    ? Number(fileMtimeMs)
    : (() => {
      try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
    })();
  latestActivity = Math.max(latestActivity, statActivity);
  if (activeThresholdMs != null && (now - latestActivity) > Number(activeThresholdMs)) return null;
  const dialogueCandidates = [];
  for (const bucket of dialogueBuckets.values()) {
    for (const raw of bucket) {
      const candidate = makeDialogue({
        text: raw.text,
        kind: raw.kind,
        source: raw.source,
        observedAt: raw.observedAt,
        actionId: raw.actionId,
        project,
      });
      if (candidate) dialogueCandidates.push(candidate);
    }
  }
  const dialogue = pickDialogue(dialogueCandidates, { now });

  const tokenUsage = usage.turnCount > 0 ? {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreate: usage.cacheCreate,
    cacheWrite: usage.cacheCreate,
    totalInput: usage.input,
    totalOutput: usage.output,
    reasoningTokens: usage.reasoningTokens,
    reasoningInOutput: false,
    turnCount: usage.turnCount,
  } : null;
  const pending = pendingTools.values().next().value || null;
  const turn = deriveTurnState({
    pendingTool: pending?.tool || null,
    pendingSince: pending?.ts || null,
    turnEnded,
    turnEndedAt,
    permissionMode: 'bypassPermissions',
  }, now);
  const resolvedModel = model || 'omp';
  const resolvedProvider = underlyingProvider || modelProvider(resolvedModel);
  const newestPaths = [];
  const seenPaths = new Set();
  for (let i = workingSet.length - 1; i >= 0 && newestPaths.length < 16; i--) {
    const item = workingSet[i];
    const canonical = workingSetPath(item.path, project, item.readSelector);
    if (!canonical || seenPaths.has(canonical)) continue;
    seenPaths.add(canonical);
    newestPaths.push({ path: canonical, op: item.op, at: item.at, source: 'transcript' });
  }

  return {
    session: {
      sessionId,
      provider: 'omp',
      underlyingProvider: resolvedProvider,
      agentId: String(session.id),
      agentType: parentSessionId ? 'sub-agent' : 'main',
      agentName: childAgentName || title || null,
      project,
      model: resolvedModel,
      status: 'active',
      lastActivity: latestActivity,
      lastTool: latestTool,
      lastToolInput: latestToolInput,
      lastMessage: latestAssistantText,
      dialogue,
      observedSources,
      tokenUsage,
      parentSessionId: parentSessionId ? transcriptId(parentSessionId) : null,
      lastPrompt,
      todos: todos.slice(0, 64).map(({ subject, status, phase }) => ({ subject, status, phase })),
      gitBranch,
      ...turn,
      signalSource: 'transcript',
      turnStartedAt,
      workingSet: newestPaths,
    },
    detail: createDetailResponse({
      provider: 'omp',
      sessionId,
      project,
      toolHistory: toolHistory.slice(-120),
      messages: messages.slice(-40),
      tokenUsage,
      agentName: childAgentName || title || null,
      underlyingProvider: resolvedProvider,
    }),
  };
}

class OmpAdapter {
  constructor({ sessionsDir = null, rootDir = null, now = () => Date.now() } = {}) {
    this.sessionsDir = path.resolve(sessionsDir || rootDir || DEFAULT_SESSIONS_DIR);
    this.home = path.resolve(this.sessionsDir, '..', '..');
    this.now = now;
    this._index = new Map();
    this._detailIndex = new Map();
    this._detailScanDirectoryMtimes = null;
    this._perf = {
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
    };
  }

  get name() { return 'Oh My Pi'; }
  get provider() { return 'omp'; }
  get homeDir() { return this.home; }

  isAvailable() {
    try { return fs.statSync(this.sessionsDir).isDirectory(); } catch (error) { noteReadFailure(error); return false; }
  }

  _listTranscriptFiles(directoryMtimes = null) {
    const files = [];
    const visit = (directory) => {
      if (files.length >= MAX_TRANSCRIPTS) return;
      if (directoryMtimes) {
        try { directoryMtimes.set(directory, fs.statSync(directory).mtimeMs); } catch (error) { noteReadFailure(error); return; }
      }
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { noteReadFailure(error); return; }
      for (const entry of entries) {
        if (files.length >= MAX_TRANSCRIPTS) break;
        const current = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(current);
        else if (entry.isDirectory() && !entry.name.startsWith('.')) visit(current);
      }
    };
    visit(this.sessionsDir);
    return files;
  }

  _directoryMtimesChanged(current) {
    const previous = this._detailScanDirectoryMtimes;
    if (!previous || previous.size !== current.size) return true;
    for (const [directory, mtimeMs] of current) {
      if (previous.get(directory) !== mtimeMs) return true;
    }
    return false;
  }

  _readRecords(filePath, lines = TRANSCRIPT_TAIL_LINES) {
    const head = readJsonLines(filePath, {
      from: 'start',
      count: TRANSCRIPT_HEAD_LINES,
      headMaxBytes: TRANSCRIPT_HEAD_MAX_BYTES,
      source: this.provider,
    });
    const tail = readJsonLines(filePath, {
      from: 'end',
      count: lines,
      tailMaxBytes: MAX_TAIL_BYTES,
      source: this.provider,
    });
    return mergeRecords(head, tail);
  }

  _parseFile(filePath, { activeThresholdMs = null, detail = false, fileStat = null } = {}) {
    const records = this._readRecords(filePath, detail ? DETAIL_TAIL_LINES : TRANSCRIPT_TAIL_LINES);
    return parseOmpTranscript(records, {
      filePath,
      parentSessionId: childParentId(filePath, this.sessionsDir),
      childAgentName: childName(filePath, this.sessionsDir),
      now: this.now(),
      activeThresholdMs,
      detail,
      fileMtimeMs: fileStat?.mtimeMs,
    });
  }

  getActiveSessions(activeThresholdMs) {
    const startedAt = Date.now();
    this._index.clear();
    const sessions = [];
    const files = this._listTranscriptFiles();
    const pass = {
      filesDiscovered: files.length,
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
    const now = this.now();

    for (const filePath of files) {
      let fileStat;
      pass.filesStatted += 1;
      try {
        fileStat = fs.statSync(filePath);
      } catch {
        pass.statErrors += 1;
        pass.filesSkippedBeforeRead += 1;
        continue;
      }

      const ageMs = now - fileStat.mtimeMs;
      const inactive = threshold != null && (
        threshold <= 0
        || (Number.isFinite(threshold) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs > threshold)
      );
      if (inactive) {
        pass.filesSkippedBeforeRead += 1;
        continue;
      }

      pass.filesOpened += 1;
      pass.bytesRead += Math.min(fileStat.size, TRANSCRIPT_HEAD_MAX_BYTES);
      const parsed = this._parseFile(filePath, { activeThresholdMs, fileStat });
      if (!parsed) continue;
      const rawId = rawSessionId(parsed.session.sessionId);
      const entry = { filePath, parentSessionId: parsed.session.parentSessionId };
      this._index.set(rawId, entry);
      this._detailIndex.set(rawId, entry);
      sessions.push(parsed.session);
    }

    const diagnosticsAfter = getJsonlDiagnostics()[this.provider]?.parsedLines || 0;
    const tailAfter = getTailCacheDiagnostics().parsed;
    pass.bytesRead += Math.max(0, tailAfter.bytesRead - tailBefore.bytesRead);
    pass.linesParsed = Math.max(0, diagnosticsAfter - diagnosticsBefore);
    pass.cacheHits = Math.max(0, tailAfter.hits - tailBefore.hits);
    pass.cacheMisses = Math.max(0, tailAfter.misses - tailBefore.misses);
    this._recordActivePass(startedAt, pass);
    return sessions;
  }

  _recordActivePass(startedAt, pass) {
    this._perf.activePasses += 1;
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
      this._perf[field] += pass[field];
      this._perf[`last${field[0].toUpperCase()}${field.slice(1)}`] = pass[field];
    }
    this._perf.lastPassAt = Date.now();
    this._perf.lastPassDurationMs = this._perf.lastPassAt - startedAt;
  }

  getSessionDetail(sessionId, project) {
    const rawId = rawSessionId(sessionId);
    let entry = this._index.get(rawId) || this._detailIndex.get(rawId);
    if (!entry) {
      const directoryMtimes = new Map();
      const files = this._listTranscriptFiles(directoryMtimes);
      if (this._directoryMtimesChanged(directoryMtimes)) {
        for (const filePath of files) {
          const parsed = this._parseFile(filePath);
          if (!parsed) continue;
          const parsedRawId = rawSessionId(parsed.session.sessionId);
          const parsedEntry = { filePath, parentSessionId: parsed.session.parentSessionId };
          this._detailIndex.set(parsedRawId, parsedEntry);
          if (parsedRawId === rawId) entry = parsedEntry;
        }
        this._detailScanDirectoryMtimes = directoryMtimes;
      }
    }
    if (!entry) return createDetailResponse({ provider: this.provider, sessionId, project: project || '' });
    const parsed = this._parseFile(entry.filePath, { detail: true });
    if (!parsed) return createDetailResponse({ provider: this.provider, sessionId, project: project || '' });
    if (project && !parsed.detail.project) parsed.detail.project = project;
    return parsed.detail;
  }

  getWatchPaths() {
    return [{ type: 'directory', path: this.sessionsDir, recursive: true, filter: '.jsonl' }];
  }

  invalidateCachesForDirty() {
    this._index.clear();
    this._detailIndex.clear();
    this._detailScanDirectoryMtimes = null;
  }

  getPerfStats() {
    return { ...this._perf };
  }

  shutdown() {
    this._index.clear();
    this._detailIndex.clear();
    this._detailScanDirectoryMtimes = null;
  }
}

module.exports = {
  OmpAdapter,
  parseOmpTranscript,
};
