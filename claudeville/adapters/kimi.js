/**
 * Kimi CLI adapter
 * Data sources: ~/.kimi/ (legacy) and ~/.kimi-code/ (Kimi Code, 2026 migration).
 * Both layouts are scanned; see the "Kimi Code" parsing section below for the new format.
 *
 * Session format:
 *   ~/.kimi/sessions/<project_hash_md5>/<session_uuid>/wire.jsonl
 *   ~/.kimi/sessions/<project_hash_md5>/<session_uuid>/state.json
 *
 * wire.jsonl events:
 *   {"timestamp": <unix_ts>, "message": {"type": "TurnBegin", ...}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ToolCall", "payload": {"function": {"name": "Shell", "arguments": "..."}}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ToolResult", "payload": {"return_value": {"output": "..."}}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "ContentPart", "payload": {"type": "text", "text": "..."}}}
 *   {"timestamp": <unix_ts>, "message": {"type": "StatusUpdate", "payload": {"token_usage": {"input_other": N, "output": N, "input_cache_read": N, "input_cache_creation": N}, "context_tokens": N, "max_context_tokens": N}}}
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState } = require('./turnState');
const { TOOL_RESULT_LIMIT, toolResultId } = require('./toolResults');
const {
  createDetailResponse,
  fileSignature,
  normalizeCacheTokens,
  readJsonLines: readSharedJsonLines,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');

const KIMI_DIR = path.join(os.homedir(), '.kimi');
const SESSIONS_DIR = path.join(KIMI_DIR, 'sessions');
const KIMI_JSON = path.join(KIMI_DIR, 'kimi.json');
const CONFIG_TOML = path.join(KIMI_DIR, 'config.toml');

// Kimi Code (2026 migration of the Kimi CLI) uses a new home dir and layout:
//   ~/.kimi-code/session_index.jsonl  → {sessionId, sessionDir, workDir} per line
//   ~/.kimi-code/sessions/<workspace>/<session_uuid>/state.json
//   ~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl
const KIMI_CODE_DIR = path.join(os.homedir(), '.kimi-code');
const KIMI_CODE_SESSIONS_DIR = path.join(KIMI_CODE_DIR, 'sessions');
const KIMI_CODE_INDEX = path.join(KIMI_CODE_DIR, 'session_index.jsonl');
const KIMI_CODE_CONFIG_TOML = path.join(KIMI_CODE_DIR, 'config.toml');

const GIT_EVENT_SCAN_LINES = 5000;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_BYTES = 512 * 1024;
const KIMI_CODE_INDEX_MAX_LINES = 4096;
const KIMI_CODE_INDEX_SCAN_CHUNK_BYTES = 64 * 1024;
const KIMI_CODE_INDEX_MAX_LINE_BYTES = KIMI_CODE_INDEX_SCAN_CHUNK_BYTES - 1;
const KIMI_CODE_INDEX_FALLBACK_MAX_BYTES = Math.max(
  KIMI_CODE_INDEX_SCAN_CHUNK_BYTES,
  Number(process.env.CLAUDEVILLE_KIMI_INDEX_FALLBACK_MAX_BYTES || 2 * 1024 * 1024)
    || 2 * 1024 * 1024,
);
const KIMI_CODE_INDEX_FALLBACK_MAX_LINES = Math.max(
  1,
  Number(process.env.CLAUDEVILLE_KIMI_INDEX_FALLBACK_MAX_LINES || 8192) || 8192,
);
const KIMI_CODE_INDEX_FALLBACK_MAX_MS = Math.max(
  1,
  Number(process.env.CLAUDEVILLE_KIMI_INDEX_FALLBACK_MAX_MS || 20) || 20,
);
const DISCOVERY_CACHE_MS = 5000;
const KIMI_TOOL_INPUT_FIELDS = Object.freeze([
  'command',
  'file_path',
  'pattern',
  'query',
  'target',
  'path',
  'description',
  'prompt',
  'url',
  'content',
  'task_id',
  'skill',
  'id',
]);
const KIMI_LEGACY_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: ['input_cache_read'],
  cacheCreate: ['input_cache_creation'],
});
const KIMI_CODE_CACHE_FIELD_MAP = Object.freeze({
  // Kimi Code skips null/empty aliases before trying the legacy spelling.
  cacheRead: [usage => kimiCodeUsageNumber(usage, 'inputCacheRead', 'input_cache_read')],
  cacheCreate: [usage => kimiCodeUsageNumber(usage, 'inputCacheCreation', 'input_cache_creation')],
});

const _configCache = { at: 0, value: null };
const _kimiJsonCache = { at: 0, value: null };
const _codeConfigCache = { at: 0, value: null };
const _codeIndexCache = {
  signature: null,
  value: null,
  fallbackMisses: new Set(),
  fallbackOffset: 0,
  fallbackDiscarding: false,
  fallbackTargetSignature: '',
};
const _projectPathMapCache = { at: 0, value: null };
const _legacyWirePathCache = { at: 0, value: null };
const _codeWirePathCache = { at: 0, value: null };
const _perf = {
  codeIndexHits: 0,
  codeIndexMisses: 0,
  codeIndexFallbackScans: 0,
  codeIndexFallbackBytes: 0,
  codeIndexFallbackMaxScanBytes: 0,
  codeIndexFallbackLines: 0,
  codeIndexFallbackMatches: 0,
  codeIndexFallbackBudgetStops: 0,
  codeIndexOversizedLines: 0,
  parsedActiveAgentWires: 0,
  skippedInactiveAgentWires: 0,
};

// ─── Utilities ─────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function stripKimiSessionPrefix(sessionId) {
  return String(sessionId || '').replace(/^kimi-/, '');
}

function isPathInside(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeExistingFile(candidatePath, rootPath) {
  try {
    if (!fs.existsSync(candidatePath)) return null;
    const rootReal = fs.realpathSync(rootPath);
    const fileReal = fs.realpathSync(candidatePath);
    return isPathInside(fileReal, rootReal) ? fileReal : null;
  } catch {
    return null;
  }
}

function safeExistingDirectory(candidatePath, rootPath) {
  try {
    if (!candidatePath || !fs.existsSync(candidatePath)) return null;
    const stat = fs.statSync(candidatePath);
    if (!stat.isDirectory()) return null;
    const rootReal = fs.realpathSync(rootPath);
    const dirReal = fs.realpathSync(candidatePath);
    return isPathInside(dirReal, rootReal) ? dirReal : null;
  } catch {
    return null;
  }
}

function readJsonLines(filePath, { from = 'end', count = 100 } = {}) {
  return readSharedJsonLines(filePath, {
    from,
    count,
    headMaxBytes: MAX_HEAD_BYTES,
    tailChunkBytes: TAIL_CHUNK_BYTES,
    tailMaxBytes: MAX_TAIL_BYTES,
    source: 'kimi',
  });
}

function tailEntries(entries, count) {
  return entries.length > count ? entries.slice(-count) : entries;
}

function readActiveWireTail(filePath) {
  return readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
}

function readKimiJson() {
  const now = Date.now();
  if (_kimiJsonCache.value && (now - _kimiJsonCache.at) < 5000) return _kimiJsonCache.value;
  try {
    const content = fs.readFileSync(KIMI_JSON, 'utf-8');
    const data = JSON.parse(content);
    _kimiJsonCache.value = data;
    _kimiJsonCache.at = now;
    return data;
  } catch {
    return { work_dirs: [] };
  }
}

function readConfigToml(filePath = CONFIG_TOML, cache = _configCache) {
  const now = Date.now();
  if (cache.value && (now - cache.at) < 5000) return cache.value;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = { defaultModel: 'kimi-for-coding', models: {} };

    // Extract default_model
    const defaultMatch = content.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    if (defaultMatch) config.defaultModel = defaultMatch[1];

    // Extract model blocks: [models."kimi-code/kimi-for-coding"]
    // Block body runs until the next section header (a line starting with `[`),
    // while still allowing inline arrays like `capabilities = [ ... ]`.
    const modelBlockRegex = /^\s*\[models\."([^"]+)"\]\s*\n((?:(?!\s*\[)[^\n]*\n?)*)/gm;
    let m;
    while ((m = modelBlockRegex.exec(content)) !== null) {
      const block = m[2];
      const modelMatch = block.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const displayMatch = block.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
      const providerMatch = block.match(/^\s*provider\s*=\s*"([^"]+)"/m);
      const maxCtxMatch = block.match(/^\s*max_context_size\s*=\s*(\d+)/m);
      config.models[m[1]] = {
        model: modelMatch ? modelMatch[1] : m[1],
        displayName: displayMatch ? displayMatch[1] : (modelMatch ? modelMatch[1] : m[1]),
        provider: providerMatch ? providerMatch[1] : 'kimi',
        maxContext: maxCtxMatch ? Number(maxCtxMatch[1]) : 0,
      };
    }

    cache.value = config;
    cache.at = now;
    return config;
  } catch {
    return { defaultModel: 'kimi-for-coding', models: {} };
  }
}

function resolveModelInfo(config) {
  const defaultModelKey = config.defaultModel || 'kimi-for-coding';
  const modelEntry = config.models[defaultModelKey];
  if (modelEntry) return modelEntry;
  return { model: 'kimi-for-coding', displayName: 'Kimi-k2.6', provider: 'kimi', maxContext: 0 };
}

function addKimiCodeIndexEntry(map, key, entry) {
  const normalized = String(key || '').trim();
  if (normalized && !map.has(normalized)) map.set(normalized, entry);
}

// Kimi Code session index: sessionId, sessionDir, and basename(sessionDir) → { sessionDir, workDir }
function readKimiCodeIndex() {
  const signature = fileSignature(KIMI_CODE_INDEX);
  if (_codeIndexCache.value && _codeIndexCache.signature === signature) {
    _perf.codeIndexHits++;
    return _codeIndexCache.value;
  }
  _perf.codeIndexMisses++;
  const map = new Map();
  try {
    const entries = readJsonLines(KIMI_CODE_INDEX, {
      from: 'end',
      count: KIMI_CODE_INDEX_MAX_LINES,
    });
    for (const entry of entries) {
      if (!entry?.sessionId) continue;
      const sessionDir = typeof entry.sessionDir === 'string'
        ? safeExistingDirectory(entry.sessionDir, KIMI_CODE_SESSIONS_DIR)
        : null;
      if (!sessionDir) continue;
      const indexed = { sessionDir, workDir: entry.workDir || null };
      addKimiCodeIndexEntry(map, entry.sessionId, indexed);
      addKimiCodeIndexEntry(map, sessionDir, indexed);
      addKimiCodeIndexEntry(map, path.basename(sessionDir), indexed);
    }
  } catch { /* ignore */ }
  _codeIndexCache.value = map;
  _codeIndexCache.signature = signature;
  _codeIndexCache.fallbackMisses.clear();
  _codeIndexCache.fallbackOffset = 0;
  _codeIndexCache.fallbackDiscarding = false;
  _codeIndexCache.fallbackTargetSignature = '';
  return map;
}

function kimiCodeIndexTargetKeys(record) {
  return [...new Set([
    record.sessionRealPath,
    record.sessionPath,
    record.sessionDirName,
  ].filter(Boolean))];
}

function hydrateKimiCodeIndexForSessions(index, sessionRecords) {
  if (!sessionRecords.length || !fs.existsSync(KIMI_CODE_INDEX)) return;

  const targetsByKey = new Map();
  const unresolved = new Set();
  for (const record of sessionRecords) {
    const keys = kimiCodeIndexTargetKeys(record);
    if (keys.some(key => index.has(key))) continue;
    const missKey = record.sessionRealPath || record.sessionPath;
    if (_codeIndexCache.fallbackMisses.has(missKey)) continue;

    const target = {
      keys,
      missKey,
      sessionRealPath: record.sessionRealPath,
      sessionPath: record.sessionPath,
      sessionDirName: record.sessionDirName,
    };
    unresolved.add(target);
    for (const key of keys) {
      const targets = targetsByKey.get(key) || new Set();
      targets.add(target);
      targetsByKey.set(key, targets);
    }
  }
  if (!unresolved.size) return;
  const targetSignature = [...unresolved]
    .map(target => target.missKey)
    .sort()
    .join('\0');
  if (_codeIndexCache.fallbackTargetSignature !== targetSignature) {
    _codeIndexCache.fallbackTargetSignature = targetSignature;
    _codeIndexCache.fallbackOffset = 0;
    _codeIndexCache.fallbackDiscarding = false;
  }

  const removeTarget = (target) => {
    unresolved.delete(target);
    for (const key of target.keys) {
      const targets = targetsByKey.get(key);
      if (!targets) continue;
      targets.delete(target);
      if (!targets.size) targetsByKey.delete(key);
    }
  };

  const processLine = (lineBuffer) => {
    _perf.codeIndexFallbackLines++;
    if (!lineBuffer.length || lineBuffer.length > KIMI_CODE_INDEX_MAX_LINE_BYTES) {
      if (lineBuffer.length > KIMI_CODE_INDEX_MAX_LINE_BYTES) _perf.codeIndexOversizedLines++;
      return;
    }

    let entry;
    try {
      entry = JSON.parse(lineBuffer.toString('utf8'));
    } catch {
      return;
    }
    if (!entry?.sessionId || typeof entry.sessionDir !== 'string') return;

    const rawSessionDir = entry.sessionDir;
    const rawBasename = path.basename(rawSessionDir);
    const possibleTargets = targetsByKey.get(rawSessionDir)
      || targetsByKey.get(entry.sessionId)
      || targetsByKey.get(rawBasename);
    if (!possibleTargets?.size) return;

    const sessionDir = safeExistingDirectory(rawSessionDir, KIMI_CODE_SESSIONS_DIR);
    if (!sessionDir) return;
    const exactTargets = targetsByKey.get(sessionDir) || targetsByKey.get(rawSessionDir);
    const matchedTargets = exactTargets
      || (possibleTargets.size === 1 ? possibleTargets : null);
    if (!matchedTargets?.size) return;

    const indexed = { sessionDir, workDir: entry.workDir || null };
    addKimiCodeIndexEntry(index, entry.sessionId, indexed);
    addKimiCodeIndexEntry(index, sessionDir, indexed);
    addKimiCodeIndexEntry(index, path.basename(sessionDir), indexed);
    for (const target of [...matchedTargets]) {
      if (
        target.sessionRealPath !== sessionDir
        && target.sessionPath !== rawSessionDir
        && target.sessionDirName !== entry.sessionId
        && target.sessionDirName !== rawBasename
      ) {
        continue;
      }
      for (const key of target.keys) addKimiCodeIndexEntry(index, key, indexed);
      _perf.codeIndexFallbackMatches++;
      removeTarget(target);
    }
  };

  _perf.codeIndexFallbackScans++;
  let fd;
  try {
    fd = fs.openSync(KIMI_CODE_INDEX, 'r');
    const fileSize = fs.fstatSync(fd).size;
    if (_codeIndexCache.fallbackOffset >= fileSize) {
      _codeIndexCache.fallbackOffset = 0;
      _codeIndexCache.fallbackDiscarding = false;
    }
    const chunk = Buffer.allocUnsafe(KIMI_CODE_INDEX_SCAN_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let discardingOversizedLine = _codeIndexCache.fallbackDiscarding;
    let position = _codeIndexCache.fallbackOffset;
    let nextOffset = position;
    let bytesScanned = 0;
    let linesScanned = 0;
    let reachedEof = false;
    let budgetStopped = false;
    let stopScan = false;
    const startedAt = Date.now();

    while (!stopScan && unresolved.size) {
      if (
        bytesScanned >= KIMI_CODE_INDEX_FALLBACK_MAX_BYTES
        || linesScanned >= KIMI_CODE_INDEX_FALLBACK_MAX_LINES
        || Date.now() - startedAt >= KIMI_CODE_INDEX_FALLBACK_MAX_MS
      ) {
        budgetStopped = true;
        break;
      }
      const readLength = Math.min(
        chunk.length,
        KIMI_CODE_INDEX_FALLBACK_MAX_BYTES - bytesScanned,
      );
      const readStart = position;
      const bytesRead = fs.readSync(fd, chunk, 0, readLength, position);
      if (!bytesRead) {
        reachedEof = true;
        break;
      }
      position += bytesRead;
      bytesScanned += bytesRead;
      const incoming = chunk.subarray(0, bytesRead);
      const buffer = pending.length ? Buffer.concat([pending, incoming]) : incoming;
      const bufferStart = readStart - pending.length;
      let lineStart = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 0x0a) continue;
        const lineEndOffset = bufferStart + index + 1;
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
        } else {
          if (
            linesScanned >= KIMI_CODE_INDEX_FALLBACK_MAX_LINES
            || Date.now() - startedAt >= KIMI_CODE_INDEX_FALLBACK_MAX_MS
          ) {
            budgetStopped = true;
            stopScan = true;
            break;
          }
          processLine(buffer.subarray(lineStart, index));
          linesScanned++;
        }
        nextOffset = lineEndOffset;
        lineStart = index + 1;
        if (!unresolved.size) {
          stopScan = true;
          break;
        }
      }
      if (stopScan) break;

      const remainder = buffer.subarray(lineStart);
      if (discardingOversizedLine) {
        pending = Buffer.alloc(0);
        nextOffset = position;
      } else if (remainder.length > KIMI_CODE_INDEX_MAX_LINE_BYTES) {
        _perf.codeIndexOversizedLines++;
        pending = Buffer.alloc(0);
        discardingOversizedLine = true;
        nextOffset = position;
      } else {
        pending = Buffer.from(remainder);
      }

      if (position >= fileSize) {
        reachedEof = true;
        break;
      }
    }
    if (reachedEof && unresolved.size && !discardingOversizedLine && pending.length) {
      if (
        linesScanned < KIMI_CODE_INDEX_FALLBACK_MAX_LINES
        && Date.now() - startedAt < KIMI_CODE_INDEX_FALLBACK_MAX_MS
      ) {
        processLine(pending);
        linesScanned++;
        nextOffset = position;
      } else {
        // Retry the unterminated final record from the last complete line on
        // the next bounded pass instead of memoizing an authoritative miss.
        reachedEof = false;
        budgetStopped = true;
      }
    }

    _perf.codeIndexFallbackBytes += bytesScanned;
    _perf.codeIndexFallbackMaxScanBytes = Math.max(
      _perf.codeIndexFallbackMaxScanBytes,
      bytesScanned,
    );
    if (reachedEof) {
      _codeIndexCache.fallbackOffset = 0;
      _codeIndexCache.fallbackDiscarding = false;
    } else {
      _codeIndexCache.fallbackOffset = nextOffset;
      _codeIndexCache.fallbackDiscarding = discardingOversizedLine;
      if (unresolved.size && budgetStopped) _perf.codeIndexFallbackBudgetStops++;
    }

    if (reachedEof) {
      for (const target of unresolved) {
        _codeIndexCache.fallbackMisses.add(target.missKey);
      }
    }
    _codeIndexCache.fallbackTargetSignature = [...unresolved]
      .map(target => target.missKey)
      .sort()
      .join('\0');
  } catch {
    // Ignore an index that disappears or changes while being scanned.
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function buildProjectPathMap() {
  const now = Date.now();
  if (_projectPathMapCache.value && now - _projectPathMapCache.at < DISCOVERY_CACHE_MS) {
    return _projectPathMapCache.value;
  }
  const map = new Map();
  const kimiJson = readKimiJson();
  if (Array.isArray(kimiJson.work_dirs)) {
    for (const entry of kimiJson.work_dirs) {
      if (entry.path) {
        map.set(md5(entry.path), entry.path);
      }
    }
  }
  // Also try common directories
  const home = os.homedir();
  const commonDirs = ['Desktop', 'Documents', 'Projects', 'Developer', 'dev', 'src', 'code', 'repos', 'workspace', 'work'];
  for (const dir of commonDirs) {
    const fullPath = path.join(home, dir);
    map.set(md5(fullPath), fullPath);
    try {
      if (fs.existsSync(fullPath)) {
        const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 50);
        for (const sub of subdirs) {
          const subPath = path.join(fullPath, sub.name);
          map.set(md5(subPath), subPath);
        }
      }
    } catch { /* ignore */ }
  }
  _projectPathMapCache.at = now;
  _projectPathMapCache.value = map;
  return map;
}

function resolveProjectPath(projectHash) {
  const map = buildProjectPathMap();
  return map.get(projectHash) || null;
}

function getSessionTitle(statePath) {
  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content);
    if (state.custom_title && typeof state.custom_title === 'string') {
      return state.custom_title.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function summarizeToolInput(argsStr, { maxLength = 60, basenameFile = true } = {}) {
  const summary = summarizeSharedToolInput(argsStr, {
    fields: KIMI_TOOL_INPUT_FIELDS,
    basenameFields: basenameFile ? ['file_path'] : [],
    maxLength,
    missingValue: null,
    parseJsonStrings: true,
    stringFallback: 'string',
    objectFallback: 'none',
  });
  if (summary != null) return summary;
  return summarizeQuestionPrompt(argsStr, maxLength);
}

// AskUserQuestion keeps its identifying text in questions[].question, which the
// shallow shared field scan cannot reach; surface it so captions and activity
// rows are not blank on question turns.
function summarizeQuestionPrompt(argsStr, maxLength) {
  let args = argsStr;
  if (typeof argsStr === 'string') {
    try { args = JSON.parse(argsStr); } catch { return null; }
  }
  if (!args || typeof args !== 'object' || !Array.isArray(args.questions)) return null;
  const entry = args.questions.find((item) => item && typeof item.question === 'string' && item.question.trim());
  return entry ? entry.question.trim().substring(0, maxLength) : null;
}

const KIMI_DIALOGUE_INTENT_FIELDS = Object.freeze(['description', 'activeForm', 'i']);
const DIALOGUE_CANDIDATE_LIMIT = 8;

function parseKimiTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseKimiCodeDialogueTimestamp(entry, event) {
  const eventAt = parseKimiTimestamp(event?.time);
  return eventAt || parseKimiTimestamp(entry?.time);
}

function parseKimiToolArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readKimiToolIntent(args) {
  const value = parseKimiToolArgs(args);
  if (!value) return null;
  for (const field of KIMI_DIALOGUE_INTENT_FIELDS) {
    if (typeof value[field] === 'string' && value[field].trim()) {
      return { field, text: value[field] };
    }
  }
  return null;
}

function parseWireDetail(filePath, project = null, wireEntries = null) {
  const detail = {
    model: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
    dialogueCandidates: [],
    observedSources: emptyObservedSources(),
  };
  const candidateCounts = { intent: 0, assistant: 0 };
  let collectDialogue = true;
  const addDialogueCandidate = ({ text, kind, source, observedAt, actionId = null }) => {
    if (typeof text !== 'string' || !text.trim()) return;
    if (kind === 'intent') detail.observedSources.toolIntent = true;
    if (kind === 'assistant') detail.observedSources.assistantText = true;
    if (!collectDialogue || candidateCounts[kind] >= DIALOGUE_CANDIDATE_LIMIT) return;
    const candidate = makeDialogue({
      text,
      kind,
      source,
      observedAt,
      actionId,
      project,
    });
    if (!candidate) return;
    detail.dialogueCandidates.push(candidate);
    candidateCounts[kind]++;
    if (
      candidateCounts.intent >= DIALOGUE_CANDIDATE_LIMIT
      && candidateCounts.assistant >= DIALOGUE_CANDIDATE_LIMIT
    ) {
      collectDialogue = false;
    }
  };

  const entries = wireEntries
    ? tailEntries(wireEntries, 100)
    : readJsonLines(filePath, { from: 'end', count: 100 });

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message;
    if (!msg) continue;

    const payload = msg.payload;
    if (!payload) continue;

    // ToolCall
    if (!detail.lastTool && msg.type === 'ToolCall' && payload.function) {
      detail.lastTool = payload.function.name || null;
      detail.lastToolInput = summarizeToolInput(payload.function.arguments, { maxLength: 60, basenameFile: true });
    }
    if (msg.type === 'ToolCall' && payload.function) {
      const intent = readKimiToolIntent(payload.function.arguments);
      if (intent) {
        addDialogueCandidate({
          text: intent.text,
          kind: 'intent',
          source: `kimi.tool.${intent.field}`,
          observedAt: parseKimiTimestamp(entry.timestamp),
          actionId: payload.function.id || payload.id || msg.id || entry.id || null,
        });
      }
    }

    // ContentPart text
    if (!detail.lastMessage && msg.type === 'ContentPart' && payload.type === 'text' && payload.text) {
      const text = payload.text.trim();
      if (text.length > 0) detail.lastMessage = text.substring(0, 80);
    }
    if (msg.type === 'ContentPart' && payload.type === 'text' && typeof payload.text === 'string') {
      const text = payload.text.trim();
      if (text.length > 0) {
        addDialogueCandidate({
          text: payload.text,
          kind: 'assistant',
          source: 'kimi.message',
          observedAt: parseKimiTimestamp(entry.timestamp),
          actionId: msg.id || payload.id || entry.id || null,
        });
      }
    }
  }

  return detail;
}

function getToolHistory(filePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 200 });
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'ToolCall') continue;
      const payload = msg.payload;
      if (!payload || !payload.function) continue;
      const func = payload.function;
      let detail = '';
      if (func.arguments) {
        detail = summarizeToolInput(func.arguments, { maxLength: 80, basenameFile: false }) || '';
      }
      tools.push({
        tool: func.name || 'unknown',
        detail,
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function getRecentMessages(filePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 100 });
    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'ContentPart') continue;
      const payload = msg.payload;
      if (!payload || payload.type !== 'text' || !payload.text) continue;
      const text = payload.text.trim();
      if (text.length === 0) continue;
      messages.push({
        role: 'assistant',
        text: text.substring(0, 200),
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function getTokenUsage(filePath, wireEntries = null) {
  const emptyUsage = {
    availability: 'unavailable',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
  };

  try {
    const entries = wireEntries
      ? tailEntries(wireEntries, 500)
      : readJsonLines(filePath, { from: 'end', count: 500 });
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let lastContextTokens = 0;
    let lastMaxContext = 0;
    let turnCount = 0;

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg || msg.type !== 'StatusUpdate') continue;
      const payload = msg.payload;
      if (!payload) continue;

      const usage = payload.token_usage;
      if (usage && typeof usage === 'object') {
        totalInput += Number(usage.input_other) || 0;
        totalOutput += Number(usage.output) || 0;
        const cacheTokens = normalizeCacheTokens(usage, KIMI_LEGACY_CACHE_FIELD_MAP);
        totalCacheRead += cacheTokens.cacheRead;
        totalCacheCreate += cacheTokens.cacheCreate;
        turnCount++;
      }

      if (Number.isFinite(payload.context_tokens)) {
        lastContextTokens = payload.context_tokens;
      }
      if (Number.isFinite(payload.max_context_tokens)) {
        lastMaxContext = payload.max_context_tokens;
      }
    }

    return {
      availability: turnCount > 0 ? 'observed' : 'unavailable',
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      contextWindow: lastContextTokens,
      contextWindowMax: lastMaxContext,
      turnCount,
      totalInput,
      totalOutput,
    };
  } catch { /* ignore */ }

  return emptyUsage;
}

function getGitEvents(filePath, context, wireEntries = null) {
  const events = [];
  try {
    const entries = wireEntries || readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });

    entries.forEach((entry, entryIndex) => {
      const msg = entry.message;
      if (!msg || msg.type !== 'ToolCall' || !msg.payload || !msg.payload.function) return;
      const func = msg.payload.function;
      if (func.name !== 'Shell' || !func.arguments) return;

      let args = null;
      try { args = JSON.parse(func.arguments); } catch { return; }
      if (!args || !args.command) return;

      const command = args.command;
      events.push(...extractGitEventsFromCommandSource(command, {
        ...context,
        ts: entry.timestamp ? new Date(entry.timestamp * 1000).getTime() : 0,
        sourceId: func.id || msg.payload.id || `${stableHash(JSON.stringify(entry))}:0`,
      }));
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

// ─── Kimi Code (~/.kimi-code) parsing ─────────────────────
//
// New wire.jsonl events use a top-level `type` and `time` (ms), unlike the
// legacy `{timestamp(s), message:{type, payload}}` shape parsed above.
//   {"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{...},"time":...}}
//   {"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"..."}}}
//   {"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":N,"output":N,"inputCacheRead":N,"inputCacheCreation":N}}

function loopEvent(entry, eventType) {
  if (!entry || entry.type !== 'context.append_loop_event') return null;
  const e = entry.event;
  if (!e || e.type !== eventType) return null;
  return e;
}

function kimiCodeEventTime(entry, event = null) {
  return Number(event && event.time) || Number(entry && entry.time) || 0;
}

function kimiCodeToolCallId(event) {
  return String(
    event?.toolCallId
    || event?.tool_call_id
    || event?.callId
    || event?.call_id
    || event?.uuid
    || event?.id
    || '',
  ).trim();
}

function kimiCodeUsageNumber(usage, ...keys) {
  for (const key of keys) {
    if (!usage || !Object.prototype.hasOwnProperty.call(usage, key)) continue;
    const raw = usage[key];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function kimiCodeTextFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && block.text) {
      return String(block.text).trim();
    }
  }
  return '';
}

function kimiCodeModelAlias(entry) {
  if (!entry || entry.type !== 'config.update') return null;
  if (typeof entry.modelAlias === 'string' && entry.modelAlias.trim()) return entry.modelAlias.trim();
  if (entry.key === 'modelAlias' && typeof entry.value === 'string' && entry.value.trim()) return entry.value.trim();
  return null;
}

function readKimiCodeState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const agents = state.agents && typeof state.agents === 'object' && !Array.isArray(state.agents)
      ? state.agents
      : {};
    // Current Kimi Code builds persist the project root as top-level `workDir`.
    const workDir = typeof state.workDir === 'string' && state.workDir.trim()
      ? state.workDir.trim()
      : null;
    // Only surface user-set titles; auto-derived titles (the first prompt) make
    // noisy villager names, so leave them null for procedural naming (matches legacy).
    if (state.isCustomTitle && state.title && typeof state.title === 'string') {
      return { title: state.title.trim().substring(0, 80) || null, agents, workDir };
    }
    return { title: null, agents, workDir };
  } catch {
    return { title: null, agents: {}, workDir: null };
  }
}

function kimiCodeProjectFromState(stateMeta) {
  if (typeof stateMeta?.workDir === 'string' && stateMeta.workDir.trim()) {
    return stateMeta.workDir.trim();
  }
  // Last resort for older layouts. On current builds `agents.<id>.homedir` points
  // inside the session store (~/.kimi-code/sessions/...), not the project.
  const agents = stateMeta?.agents && typeof stateMeta.agents === 'object' ? stateMeta.agents : {};
  const orderedAgentIds = ['main', ...Object.keys(agents).filter(agentId => agentId !== 'main')];
  for (const agentId of orderedAgentIds) {
    const homedir = agents[agentId]?.homedir;
    if (typeof homedir === 'string' && homedir.trim()) return homedir.trim();
  }
  return null;
}

function kimiCodeParentSessionId(sessionDirName, agentName, agentsMeta = {}, activeAgentNames = new Set()) {
  if (agentName === 'main') return null;
  const parentAgentId = String(agentsMeta?.[agentName]?.parentAgentId || '').trim();
  if (
    parentAgentId
    && parentAgentId !== 'main'
    && parentAgentId !== agentName
    && activeAgentNames.has(parentAgentId)
  ) {
    return `kimi-${sessionDirName}::${parentAgentId}`;
  }
  return `kimi-${sessionDirName}`;
}

function kimiCodeSessionModelKey(detailsByAgentName, agentRecords, now, activeThresholdMs) {
  const mainModel = detailsByAgentName.get('main')?.model;
  if (mainModel) return mainModel;
  for (const record of agentRecords) {
    if (record.agentName === 'main' || now - record.stat.mtimeMs > activeThresholdMs) continue;
    const model = detailsByAgentName.get(record.agentName)?.model;
    if (model) return model;
  }
  return null;
}

function parseWireDetailV2(filePath, project = null, wireEntries = null) {
  const detail = {
    model: null,
    project: null,
    lastTool: null,
    lastToolInput: null,
    lastMessage: null,
    dialogueCandidates: [],
    observedSources: emptyObservedSources(),
  };
  const candidateCounts = { intent: 0, assistant: 0 };
  let collectDialogue = true;
  const addDialogueCandidate = ({ text, kind, source, observedAt, actionId = null }) => {
    if (typeof text !== 'string' || !text.trim()) return;
    if (kind === 'intent') detail.observedSources.toolIntent = true;
    if (kind === 'assistant') detail.observedSources.assistantText = true;
    if (!collectDialogue || candidateCounts[kind] >= DIALOGUE_CANDIDATE_LIMIT) return;
    const candidate = makeDialogue({
      text,
      kind,
      source,
      observedAt,
      actionId,
      project: project || detail.project || null,
    });
    if (!candidate) return;
    detail.dialogueCandidates.push(candidate);
    candidateCounts[kind]++;
    if (
      candidateCounts.intent >= DIALOGUE_CANDIDATE_LIMIT
      && candidateCounts.assistant >= DIALOGUE_CANDIDATE_LIMIT
    ) {
      collectDialogue = false;
    }
  };
  const entries = wireEntries
    ? tailEntries(wireEntries, 100)
    : readJsonLines(filePath, { from: 'end', count: 100 });

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || !entry.type) continue;

    if (!detail.project && entry.type === 'config.update' && typeof entry.cwd === 'string') {
      const cwd = entry.cwd.trim();
      if (cwd) detail.project = cwd;
    }

    if (!detail.model && entry.type === 'usage.record' && entry.model) {
      detail.model = entry.model;
    }
    if (!detail.model) {
      const modelAlias = kimiCodeModelAlias(entry);
      if (modelAlias) detail.model = modelAlias;
    }

    const call = loopEvent(entry, 'tool.call');
    if (!detail.lastTool && call && call.name) {
      detail.lastTool = call.name;
      detail.lastToolInput = summarizeToolInput(call.args, { maxLength: 60, basenameFile: true });
    }
    if (call) {
      const intent = readKimiToolIntent(call.args);
      if (intent) {
        addDialogueCandidate({
          text: intent.text,
          kind: 'intent',
          source: `kimi.tool.${intent.field}`,
          observedAt: parseKimiCodeDialogueTimestamp(entry, call),
          actionId: kimiCodeToolCallId(call) || entry.event?.id || entry.id || null,
        });
      }
    }

    const part = loopEvent(entry, 'content.part');
    if (!detail.lastMessage && part && part.part && part.part.type === 'text' && part.part.text) {
      const text = part.part.text.trim();
      if (text.length > 0) detail.lastMessage = text.substring(0, 80);
    }
    if (part && part.part && part.part.type === 'text' && typeof part.part.text === 'string') {
      const text = part.part.text.trim();
      if (text.length > 0) {
        addDialogueCandidate({
          text: part.part.text,
          kind: 'assistant',
          source: 'kimi.message',
          observedAt: parseKimiCodeDialogueTimestamp(entry, part),
          actionId: part.part.id || part.id || entry.event?.id || entry.id || null,
        });
      }
    }

    if (detail.project && detail.model && detail.lastTool && detail.lastMessage) break;
  }

  return detail;
}

function deriveKimiCodeTurnState(wireEntries, now) {
  const entries = wireEntries;
  let turnStartIndex = -1;
  let turnStartedAt = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'context.append_message' || entry.message?.role !== 'user') continue;
    turnStartIndex = i;
    turnStartedAt = kimiCodeEventTime(entry) || null;
    break;
  }

  if (turnStartIndex === -1) {
    const latestTurnId = [...entries].reverse()
      .map(entry => entry?.event?.turnId)
      .find(turnId => turnId != null);
    if (latestTurnId != null) {
      turnStartIndex = entries.findIndex(entry => entry?.event?.turnId === latestTurnId);
      const startEntry = entries[turnStartIndex];
      turnStartedAt = kimiCodeEventTime(startEntry, startEntry?.event) || null;
    }
  }

  const pendingCalls = new Map();
  let turnEnded = false;
  let turnEndedAt = null;
  const scopedEntries = turnStartIndex >= 0 ? entries.slice(turnStartIndex) : entries;

  for (const entry of scopedEntries) {
    const call = loopEvent(entry, 'tool.call');
    if (call) {
      const callId = kimiCodeToolCallId(call);
      if (callId) {
        pendingCalls.set(callId, {
          tool: call.name || 'unknown',
          at: kimiCodeEventTime(entry, call) || null,
        });
      }
      turnEnded = false;
      turnEndedAt = null;
      continue;
    }

    const result = loopEvent(entry, 'tool.result');
    if (result) {
      const callId = kimiCodeToolCallId(result);
      if (callId) pendingCalls.delete(callId);
      continue;
    }

    const event = entry?.event;
    if (event?.type === 'step.begin' || event?.type === 'turn.begin') {
      turnEnded = false;
      turnEndedAt = null;
      continue;
    }
    if (event?.type === 'turn.end') {
      turnEnded = true;
      turnEndedAt = kimiCodeEventTime(entry, event) || null;
      continue;
    }
    if (event?.type === 'step.end') {
      const finishReason = String(event.finishReason || event.finish_reason || '').toLowerCase();
      if (finishReason && !['tool_use', 'tool_calls', 'function_call'].includes(finishReason)) {
        turnEnded = true;
        turnEndedAt = kimiCodeEventTime(entry, event) || null;
      }
    }
  }

  const pending = [...pendingCalls.values()].sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  return {
    ...deriveTurnState({
      pendingTool: pending?.tool || null,
      pendingSince: pending?.at || null,
      turnEnded,
      turnEndedAt,
      permissionMode: 'bypassPermissions',
    }, now),
    signalSource: 'transcript',
    turnStartedAt,
  };
}

function getToolHistoryV2(filePath, maxItems = 15) {
  const tools = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 200 });
    const completionsByCallId = new Map();
    for (const entry of entries) {
      const result = loopEvent(entry, 'tool.result');
      const callId = kimiCodeToolCallId(result);
      const completion = callId ? kimiCodeResultCompletion(entry) : null;
      if (completion) completionsByCallId.set(callId, completion);
    }

    for (const entry of entries) {
      const call = loopEvent(entry, 'tool.call');
      if (!call) continue;
      const detail = call.args ? (summarizeToolInput(call.args, { maxLength: 80, basenameFile: false }) || '') : '';
      const item = {
        tool: call.name || 'unknown',
        detail,
        ts: kimiCodeEventTime(entry, call),
      };
      const callId = kimiCodeToolCallId(call);
      const completion = callId ? completionsByCallId.get(callId) : null;
      if (completion && Number.isFinite(completion.exitCode)) {
        item.toolExitCode = completion.exitCode;
        if (completion.exitCode !== 0 && completion.stderr) {
          item.toolStderr = completion.stderr.trim().substring(0, 200);
        }
      }
      tools.push(item);
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

function kimiCodeResultCompletion(entry) {
  const result = entry?.event?.result;
  if (!result || typeof result !== 'object') return null;
  const output = [result.stderr, result.error, result.message, result.output]
    .find(value => typeof value === 'string' && value.trim());
  const isError = result.isError === true
    || result.is_error === true
    || result.error === true
    || (typeof result.error === 'string' && result.error.trim().length > 0);
  const rawExitCode = result.exitCode ?? result.exit_code ?? result.code;
  const exitCode = Number.isFinite(Number(rawExitCode)) ? Number(rawExitCode) : (isError ? 1 : 0);
  return {
    success: !isError && exitCode === 0,
    exitCode,
    completedAt: kimiCodeEventTime(entry, entry.event),
    stderr: (isError || exitCode !== 0) && output ? output.trim().substring(0, 2000) : '',
  };
}

// Only an explicitly reported outcome earns a result record. A `tool.result`
// that merely carries output says the call returned, not that it succeeded, so
// it produces nothing rather than an invented `exit 0`.
function kimiCodeExplicitExitCode(result) {
  if (!result || typeof result !== 'object') return undefined;
  const rawExitCode = result.exitCode ?? result.exit_code ?? result.code;
  if (rawExitCode !== null && rawExitCode !== undefined && rawExitCode !== '' && Number.isFinite(Number(rawExitCode))) {
    return Math.trunc(Number(rawExitCode));
  }
  const rawError = result.isError ?? result.is_error ?? result.error;
  if (rawError === true || (typeof rawError === 'string' && rawError.trim())) return 1;
  if (rawError === false) return 0;
  return undefined;
}

// Newest-first bounded result records for one Kimi Code wire. Duration is the
// span between the call and its own result in the same transcript, never a
// difference of event-bus receipt times.
function kimiCodeToolResults(wireEntries, sessionId) {
  const entries = Array.isArray(wireEntries) ? wireEntries : [];
  const callsById = new Map();
  for (const entry of entries) {
    const call = loopEvent(entry, 'tool.call');
    if (!call) continue;
    const callId = kimiCodeToolCallId(call);
    if (!callId) continue;
    callsById.set(callId, { name: call.name, args: call.args, at: kimiCodeEventTime(entry, call) });
  }

  const results = [];
  for (let i = entries.length - 1; i >= 0 && results.length < TOOL_RESULT_LIMIT; i--) {
    const entry = entries[i];
    const event = loopEvent(entry, 'tool.result');
    if (!event) continue;
    const exitCode = kimiCodeExplicitExitCode(event.result);
    if (exitCode === undefined) continue;
    const completedAt = kimiCodeEventTime(entry, event);
    if (!completedAt) continue;
    const callId = kimiCodeToolCallId(event);
    const call = callId ? callsById.get(callId) : null;
    const tool = call?.name || event.name || null;
    if (!tool) continue;
    const detail = call ? (summarizeToolInput(call.args, { maxLength: 80, basenameFile: false }) || '') : '';
    results.push({
      id: toolResultId({ provider: 'kimi', sessionId, callId, tool, detail, completedAt }),
      tool,
      detail,
      exitCode,
      durationMs: call?.at ? Math.max(0, completedAt - call.at) : null,
      completedAt,
      source: 'transcript',
    });
  }
  return results;
}

function getRecentMessagesV2(filePath, maxItems = 5) {
  const messages = [];
  try {
    const entries = readJsonLines(filePath, { from: 'end', count: 100 });
    for (const entry of entries) {
      if (entry && entry.type === 'context.append_message' && entry.message) {
        const text = kimiCodeTextFromContent(entry.message.content);
        if (text) {
          messages.push({
            role: entry.message.role || 'user',
            text: text.substring(0, 200),
            ts: kimiCodeEventTime(entry),
          });
        }
        continue;
      }

      const part = loopEvent(entry, 'content.part');
      if (!part || !part.part || part.part.type !== 'text' || !part.part.text) continue;
      const text = part.part.text.trim();
      if (text.length === 0) continue;
      messages.push({
        role: 'assistant',
        text: text.substring(0, 200),
        ts: kimiCodeEventTime(entry, part),
      });
    }
  } catch { /* ignore */ }
  return messages.slice(-maxItems);
}

function emptyKimiCodeUsage(contextWindowMax = 0) {
  return {
    availability: 'unavailable',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax,
    turnCount: 0,
  };
}

function getTokenUsageV2(filePath, contextWindowMax = 0, wireEntries = null) {
  const emptyUsage = emptyKimiCodeUsage(contextWindowMax);

  try {
    const entries = wireEntries
      ? tailEntries(wireEntries, 500)
      : readJsonLines(filePath, { from: 'end', count: 500 });
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let lastContextTokens = 0;
    let turnCount = 0;

    for (const entry of entries) {
      if (!entry || entry.type !== 'usage.record' || !entry.usage) continue;
      const u = entry.usage;
      const inputOther = kimiCodeUsageNumber(u, 'inputOther', 'input_other');
      const { cacheRead, cacheCreate } = normalizeCacheTokens(u, KIMI_CODE_CACHE_FIELD_MAP);
      totalInput += inputOther;
      totalOutput += kimiCodeUsageNumber(u, 'output', 'output_tokens');
      totalCacheRead += cacheRead;
      totalCacheCreate += cacheCreate;
      turnCount++;
      // Most recent turn's input tokens ≈ current context occupancy
      lastContextTokens = inputOther + cacheRead + cacheCreate;
    }

    return {
      availability: turnCount > 0 ? 'observed' : 'unavailable',
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreate: totalCacheCreate,
      contextWindow: lastContextTokens,
      contextWindowMax,
      turnCount,
      totalInput,
      totalOutput,
    };
  } catch { /* ignore */ }

  return emptyUsage;
}

function kimiCodeSessionDirFromWire(wirePath) {
  return safeExistingDirectory(path.dirname(path.dirname(path.dirname(wirePath))), KIMI_CODE_SESSIONS_DIR);
}

function getKimiCodeWireContext(wirePath, fallbackProject = null) {
  const detail = parseWireDetailV2(wirePath);
  const config = readConfigToml(KIMI_CODE_CONFIG_TOML, _codeConfigCache);
  const modelInfo = resolveModelInfo(config);
  const modelEntry = detail.model ? config.models[detail.model] : null;
  const sessionDir = kimiCodeSessionDirFromWire(wirePath);
  const index = readKimiCodeIndex();
  const indexEntry = sessionDir ? (index.get(sessionDir) || index.get(path.basename(sessionDir))) : null;
  const statePath = sessionDir ? path.join(sessionDir, 'state.json') : null;
  const stateMeta = statePath && fs.existsSync(statePath)
    ? readKimiCodeState(statePath)
    : { title: null, agents: {} };
  return {
    project: indexEntry?.workDir || kimiCodeProjectFromState(stateMeta) || detail.project || fallbackProject || null,
    contextWindowMax: (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0,
  };
}

function getGitEventsV2(filePath, context, wireEntries = null) {
  const events = [];
  try {
    const entries = wireEntries || readJsonLines(filePath, { from: 'end', count: GIT_EVENT_SCAN_LINES });
    const completionsByCallId = new Map();
    for (const entry of entries) {
      const result = loopEvent(entry, 'tool.result');
      const callId = kimiCodeToolCallId(result);
      const completion = callId ? kimiCodeResultCompletion(entry) : null;
      if (completion) completionsByCallId.set(callId, completion);
    }

    entries.forEach((entry, entryIndex) => {
      const call = loopEvent(entry, 'tool.call');
      if (!call || (call.name !== 'Bash' && call.name !== 'Shell')) return;
      const command = call.args && call.args.command;
      if (!command) return;
      const callId = kimiCodeToolCallId(call);
      const completion = callId ? completionsByCallId.get(callId) : null;
      events.push(...extractGitEventsFromCommandSource(command, {
        ...context,
        ts: kimiCodeEventTime(entry, call),
        sourceId: callId || `${stableHash(JSON.stringify(entry))}:${entryIndex}`,
        success: completion ? completion.success : undefined,
        exitCode: completion ? completion.exitCode : undefined,
        completedAt: completion ? completion.completedAt : undefined,
        stderr: completion ? completion.stderr : undefined,
      }));
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

// Walk ~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl.
// The `main` agent is the user-facing session; subagents become child sessions.
function discoverKimiCodeWires() {
  const now = Date.now();
  if (_codeWirePathCache.value && now - _codeWirePathCache.at < DISCOVERY_CACHE_MS) {
    return _codeWirePathCache.value;
  }
  const records = [];
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
  } catch (error) {
    noteReadFailure(error);
    return records;
  }

  for (const wsDir of workspaceDirs) {
    const wsPath = path.join(KIMI_CODE_SESSIONS_DIR, wsDir.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch (error) { noteReadFailure(error); continue; }

    for (const sDir of sessionDirs) {
      const sessionDirName = sDir.name;
      const sessionPath = path.join(wsPath, sessionDirName);
      const agentsDir = path.join(sessionPath, 'agents');
      let agentDirs;
      try {
        agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory());
      } catch (error) { noteReadFailure(error); continue; }
      records.push({
        sessionDirName,
        sessionPath,
        sessionRealPath: safeExistingDirectory(sessionPath, KIMI_CODE_SESSIONS_DIR),
        agents: agentDirs.flatMap(aDir => {
          const wirePath = path.join(agentsDir, aDir.name, 'wire.jsonl');
          try {
            return [{ agentName: aDir.name, wirePath, stat: fs.statSync(wirePath) }];
          } catch (error) {
            noteReadFailure(error);
            return [];
          }
        }),
      });
    }
  }

  _codeWirePathCache.at = now;
  _codeWirePathCache.value = records;
  return records;
}

function getActiveSessionsV2(activeThresholdMs, now) {
  if (!fs.existsSync(KIMI_CODE_SESSIONS_DIR)) return [];

  const index = readKimiCodeIndex();
  const config = readConfigToml(KIMI_CODE_CONFIG_TOML, _codeConfigCache);
  const modelInfo = resolveModelInfo(config);
  const sessions = [];
  const sessionRecords = [];

  for (const discovered of discoverKimiCodeWires()) {
    const { sessionDirName, sessionPath, sessionRealPath } = discovered;
    const agentRecords = [];
    let latestAgentActivity = 0;
    for (const { agentName, wirePath, stat } of discovered.agents) {
      latestAgentActivity = Math.max(latestAgentActivity, stat.mtimeMs);
      agentRecords.push({ agentName, wirePath, stat });
    }
    if (!agentRecords.length || now - latestAgentActivity > activeThresholdMs) continue;

    sessionRecords.push({
      sessionDirName,
      sessionPath,
      sessionRealPath,
      agentRecords,
      latestAgentActivity,
    });
  }

  hydrateKimiCodeIndexForSessions(index, sessionRecords);

  for (const record of sessionRecords) {
    const {
      sessionDirName,
      sessionPath,
      sessionRealPath,
      agentRecords,
      latestAgentActivity,
    } = record;
    const indexEntry = (sessionRealPath ? index.get(sessionRealPath) : null)
      || index.get(sessionPath)
      || index.get(sessionDirName);
    const statePath = path.join(sessionPath, 'state.json');
    const stateMeta = fs.existsSync(statePath)
      ? readKimiCodeState(statePath)
      : { title: null, agents: {} };
    const title = stateMeta.title;
    const activeAgentNames = new Set(agentRecords
      .filter(record => record.agentName === 'main' || now - record.stat.mtimeMs <= activeThresholdMs)
      .map(record => record.agentName));
    const hasMainRecord = agentRecords.some(record => record.agentName === 'main');
    const detailsByAgentName = new Map();
    const wireEntriesByAgentName = new Map();
    const projectHint = indexEntry?.workDir || kimiCodeProjectFromState(stateMeta) || null;
    let wireProject = null;
    for (const record of agentRecords) {
      if (!activeAgentNames.has(record.agentName)) {
        _perf.skippedInactiveAgentWires++;
        continue;
      }
      _perf.parsedActiveAgentWires++;
      const wireEntries = readActiveWireTail(record.wirePath);
      const detail = parseWireDetailV2(record.wirePath, projectHint, wireEntries);
      wireEntriesByAgentName.set(record.agentName, wireEntries);
      detailsByAgentName.set(record.agentName, detail);
      if (!wireProject && detail.project) wireProject = detail.project;
    }
    const project = projectHint || wireProject;

    if (!hasMainRecord) {
      const modelKey = kimiCodeSessionModelKey(detailsByAgentName, agentRecords, now, activeThresholdMs)
        || config.defaultModel;
      const modelEntry = modelKey ? config.models[modelKey] : null;
      const model = (modelEntry && modelEntry.displayName) || modelInfo.displayName || modelInfo.model || 'kimi';
      const ctxMax = (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0;
      const sessionId = `kimi-${sessionDirName}`;
      sessions.push({
        sessionId,
        provider: 'kimi',
        agentId: 'main',
        name: title,
        agentName: title,
        agentType: 'main',
        model,
        status: 'active',
        lastActivity: latestAgentActivity,
        project,
        lastMessage: null,
        lastTool: null,
        lastToolInput: null,
        dialogue: null,
        observedSources: emptyObservedSources(),
        tokenUsage: emptyKimiCodeUsage(ctxMax),
        gitEvents: [],
        parentSessionId: null,
      });
    }

    for (const { agentName, wirePath, stat } of agentRecords) {
      const isMain = agentName === 'main';
      // Child agents can keep writing after the main wire goes quiet; keep the
      // main session visible so parent/child lineage remains intact in the UI.
      const lastActivity = isMain ? Math.max(stat.mtimeMs, latestAgentActivity) : stat.mtimeMs;
      if (now - lastActivity > activeThresholdMs) continue;

      let wireEntries = wireEntriesByAgentName.get(agentName);
      if (!wireEntries) {
        wireEntries = readActiveWireTail(wirePath);
        wireEntriesByAgentName.set(agentName, wireEntries);
      }
      const detail = detailsByAgentName.get(agentName) || parseWireDetailV2(wirePath, project, wireEntries);
      const sessionId = isMain ? `kimi-${sessionDirName}` : `kimi-${sessionDirName}::${agentName}`;

      const modelKey = detail.model || config.defaultModel;
      const modelEntry = modelKey ? config.models[modelKey] : null;
      const model = (modelEntry && modelEntry.displayName) || modelInfo.displayName || modelInfo.model || 'kimi';
      const ctxMax = (modelEntry && modelEntry.maxContext) || modelInfo.maxContext || 0;
      const agentLabel = isMain ? title : agentName;
      const turnState = deriveKimiCodeTurnState(wireEntries, now);

      sessions.push({
        sessionId,
        provider: 'kimi',
        agentId: agentName,
        name: agentLabel,
        agentName: agentLabel,
        agentType: isMain ? 'main' : 'sub-agent',
        model,
        status: 'active',
        lastActivity,
        project,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        dialogue: pickDialogue(detail.dialogueCandidates, { now: Date.now() }),
        observedSources: detail.observedSources,
        tokenUsage: getTokenUsageV2(wirePath, ctxMax, wireEntries),
        gitEvents: getGitEventsV2(wirePath, {
          provider: 'kimi',
          sessionId,
          project,
        }, wireEntries),
        lastResults: kimiCodeToolResults(wireEntries, sessionId),
        ...turnState,
        parentSessionId: kimiCodeParentSessionId(sessionDirName, agentName, stateMeta.agents, activeAgentNames),
      });
    }
  }

  return sessions;
}

// Resolve the wire.jsonl path for a Kimi Code session id ("<sessionDir>" or "<sessionDir>::<agent>").
function findKimiCodeWire(cleanId) {
  if (!fs.existsSync(KIMI_CODE_SESSIONS_DIR)) return null;
  let dirName = cleanId;
  let agentName = 'main';
  let explicitAgent = false;
  const sep = cleanId.indexOf('::');
  if (sep !== -1) {
    dirName = cleanId.slice(0, sep);
    agentName = cleanId.slice(sep + 2);
    explicitAgent = true;
  }

  const entry = readKimiCodeIndex().get(dirName);
  if (entry && entry.sessionDir) {
    const wire = safeExistingFile(
      path.join(entry.sessionDir, 'agents', agentName, 'wire.jsonl'),
      KIMI_CODE_SESSIONS_DIR,
    );
    if (wire) return wire;
  }

  // Fallback: scan workspaces for the session dir (e.g. brand-new, not yet indexed)
  try {
    const wsDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const wire = safeExistingFile(
        path.join(KIMI_CODE_SESSIONS_DIR, ws.name, dirName, 'agents', agentName, 'wire.jsonl'),
        KIMI_CODE_SESSIONS_DIR,
      );
      if (wire) return wire;
    }
  } catch { /* ignore */ }

  if (!explicitAgent) {
    const childWire = findNewestKimiCodeChildWire(dirName, entry?.sessionDir || null);
    if (childWire) return childWire;
  }

  return null;
}

function newestKimiCodeChildWireInSession(sessionPath) {
  const sessionDir = safeExistingDirectory(sessionPath, KIMI_CODE_SESSIONS_DIR);
  if (!sessionDir) return null;
  const agentsDir = path.join(sessionDir, 'agents');
  let best = null;
  try {
    const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'main');
    for (const agentDir of agentDirs) {
      const wire = safeExistingFile(path.join(agentsDir, agentDir.name, 'wire.jsonl'), KIMI_CODE_SESSIONS_DIR);
      if (!wire) continue;
      let stat;
      try { stat = fs.statSync(wire); } catch { continue; }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { wire, mtimeMs: stat.mtimeMs };
    }
  } catch { /* ignore */ }
  return best?.wire || null;
}

function findNewestKimiCodeChildWire(dirName, indexedSessionDir = null) {
  if (indexedSessionDir) {
    const wire = newestKimiCodeChildWireInSession(indexedSessionDir);
    if (wire) return wire;
  }

  try {
    const wsDirs = fs.readdirSync(KIMI_CODE_SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ws of wsDirs) {
      const sessionPath = path.join(KIMI_CODE_SESSIONS_DIR, ws.name, dirName);
      const wire = newestKimiCodeChildWireInSession(sessionPath);
      if (wire) return wire;
    }
  } catch { /* ignore */ }

  return null;
}

// ─── Adapter class ────────────────────────────────────

function discoverLegacyKimiWires() {
  const now = Date.now();
  if (_legacyWirePathCache.value && now - _legacyWirePathCache.at < DISCOVERY_CACHE_MS) {
    return _legacyWirePathCache.value;
  }
  const records = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
  } catch (error) {
    noteReadFailure(error);
    return records;
  }

  for (const projDir of projectDirs) {
    const projectHash = projDir.name;
    const projPath = path.join(SESSIONS_DIR, projectHash);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(projPath, { withFileTypes: true })
        .filter(d => d.isDirectory());
    } catch (error) { noteReadFailure(error); continue; }

    for (const sessionDir of sessionDirs) {
      const sessionId = sessionDir.name;
      const sessionPath = path.join(projPath, sessionId);
      const wirePath = path.join(sessionPath, 'wire.jsonl');
      let stat;
      try { stat = fs.statSync(wirePath); } catch (error) { noteReadFailure(error); continue; }
      records.push({
        projectHash,
        sessionId,
        wirePath,
        stat,
        statePath: path.join(sessionPath, 'state.json'),
      });
    }
  }

  _legacyWirePathCache.at = now;
  _legacyWirePathCache.value = records;
  return records;
}

class KimiAdapter {
  get name() { return 'Kimi CLI'; }
  get provider() { return 'kimi'; }
  get homeDir() { return fs.existsSync(KIMI_CODE_DIR) ? KIMI_CODE_DIR : KIMI_DIR; }

  isAvailable() {
    return fs.existsSync(KIMI_DIR) || fs.existsSync(KIMI_CODE_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const now = Date.now();
    const sessions = [];

    if (fs.existsSync(SESSIONS_DIR)) {
      const config = readConfigToml();
      const modelInfo = resolveModelInfo(config);

      try {
        for (const { projectHash, sessionId, wirePath, stat, statePath } of discoverLegacyKimiWires()) {
          const project = resolveProjectPath(projectHash);
          if (now - stat.mtimeMs > activeThresholdMs) continue;

          const title = fs.existsSync(statePath) ? getSessionTitle(statePath) : null;
          const wireEntries = readActiveWireTail(wirePath);
          const detail = parseWireDetail(wirePath, project, wireEntries);

          sessions.push({
            sessionId: `kimi-${sessionId}`,
            provider: 'kimi',
            agentId: sessionId,
            name: title,
            agentName: title,
            agentType: 'main',
            model: detail.model || modelInfo.displayName || modelInfo.model || 'kimi',
            status: 'active',
            lastActivity: stat.mtimeMs,
            project,
            lastMessage: detail.lastMessage,
            lastTool: detail.lastTool,
            lastToolInput: detail.lastToolInput,
            dialogue: pickDialogue(detail.dialogueCandidates, { now: Date.now() }),
            observedSources: detail.observedSources,
            tokenUsage: getTokenUsage(wirePath, wireEntries),
            gitEvents: getGitEvents(wirePath, {
              provider: 'kimi',
              sessionId: `kimi-${sessionId}`,
              project,
            }, wireEntries),
            parentSessionId: null,
          });
        }
      } catch (error) { noteReadFailure(error); /* ignore */ }
    }

    sessions.push(...getActiveSessionsV2(activeThresholdMs, now));

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = stripKimiSessionPrefix(sessionId);

    // Kimi Code (~/.kimi-code) layout takes priority
    const codeWire = findKimiCodeWire(cleanId);
    if (codeWire) {
      const codeContext = getKimiCodeWireContext(codeWire, project);
      return createDetailResponse({
        project: codeContext.project,
        toolHistory: getToolHistoryV2(codeWire),
        messages: getRecentMessagesV2(codeWire),
        tokenUsage: getTokenUsageV2(codeWire, codeContext.contextWindowMax),
        sessionId,
      });
    }

    // Legacy ~/.kimi layout: find the wire file across all project directories
    if (!fs.existsSync(SESSIONS_DIR)) {
      return createDetailResponse({ sessionId });
    }

    try {
      const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projectDirs) {
        const wirePath = safeExistingFile(
          path.join(SESSIONS_DIR, projDir.name, cleanId, 'wire.jsonl'),
          SESSIONS_DIR,
        );
        if (wirePath) {
          return createDetailResponse({
            toolHistory: getToolHistory(wirePath),
            messages: getRecentMessages(wirePath),
            tokenUsage: getTokenUsage(wirePath),
            sessionId,
          });
        }
      }
    } catch (error) { noteReadFailure(error); /* ignore */ }

    return createDetailResponse({ sessionId });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(KIMI_DIR)) {
      paths.push({ type: 'directory', path: KIMI_DIR, filters: ['sessions', 'kimi.json', 'config.toml'], scope: 'discovery' });
    }
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: SESSIONS_DIR, scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_JSON)) {
      paths.push({ type: 'file', path: KIMI_JSON, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(CONFIG_TOML)) {
      paths.push({ type: 'file', path: CONFIG_TOML, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(KIMI_CODE_DIR)) {
      paths.push({ type: 'directory', path: KIMI_CODE_DIR, filters: ['sessions', 'session_index.jsonl', 'config.toml'], scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_CODE_SESSIONS_DIR)) {
      paths.push({ type: 'directory', path: KIMI_CODE_SESSIONS_DIR, scope: 'discovery' });
    }
    if (fs.existsSync(KIMI_CODE_INDEX)) {
      paths.push({ type: 'file', path: KIMI_CODE_INDEX, scope: 'discovery', probe: true });
    }
    if (fs.existsSync(KIMI_CODE_CONFIG_TOML)) {
      paths.push({ type: 'file', path: KIMI_CODE_CONFIG_TOML, scope: 'discovery', probe: true });
    }

    for (const session of sessions) {
      const cleanId = stripKimiSessionPrefix(session.sessionId);
      const baseId = cleanId.split('::', 1)[0];
      let sourcePath = null;

      if (session.project && !cleanId.includes('::')) {
        const legacySessionDir = path.join(SESSIONS_DIR, md5(session.project), baseId);
        const legacyWire = path.join(legacySessionDir, 'wire.jsonl');
        if (fs.existsSync(legacyWire)) {
          sourcePath = legacyWire;
          paths.push({ type: 'directory', path: path.dirname(legacySessionDir), scope: 'recent', activity: session.lastActivity });
          paths.push({ type: 'directory', path: legacySessionDir, filters: ['.jsonl', '.json'], scope: 'active', probe: true, activity: session.lastActivity });
        }
      }

      if (!sourcePath) {
        sourcePath = findKimiCodeWire(cleanId);
        if (sourcePath) {
          const agentDir = path.dirname(sourcePath);
          const agentsDir = path.dirname(agentDir);
          const sessionDir = path.dirname(agentsDir);
          paths.push({ type: 'directory', path: path.dirname(sessionDir), scope: 'recent', activity: session.lastActivity });
          paths.push({ type: 'directory', path: sessionDir, filters: ['.json'], scope: 'active', probe: true, activity: session.lastActivity });
          paths.push({ type: 'directory', path: agentsDir, scope: 'active', probe: true, activity: session.lastActivity });
          paths.push({ type: 'directory', path: agentDir, filters: ['.jsonl'], scope: 'active', probe: true, activity: session.lastActivity });
        }
      }

      if (sourcePath && fs.existsSync(sourcePath)) {
        paths.push({ type: 'file', path: sourcePath, scope: 'active', probe: true, activity: session.lastActivity });
      }
    }
    return paths;
  }

  invalidateCaches() {
    _configCache.at = 0;
    _configCache.value = null;
    _kimiJsonCache.at = 0;
    _kimiJsonCache.value = null;
    _codeConfigCache.at = 0;
    _codeConfigCache.value = null;
    _codeIndexCache.signature = null;
    _codeIndexCache.value = null;
    _codeIndexCache.fallbackMisses.clear();
    _codeIndexCache.fallbackOffset = 0;
    _codeIndexCache.fallbackDiscarding = false;
    _codeIndexCache.fallbackTargetSignature = '';
    _projectPathMapCache.value = null;
    _projectPathMapCache.at = 0;
    _legacyWirePathCache.value = null;
    _legacyWirePathCache.at = 0;
    _codeWirePathCache.value = null;
    _codeWirePathCache.at = 0;
  }

  getPerfStats() {
    return {
      ..._perf,
      codeIndexEntries: _codeIndexCache.value?.size || 0,
      codeIndexMaxLines: KIMI_CODE_INDEX_MAX_LINES,
      codeIndexFallbackOffset: _codeIndexCache.fallbackOffset,
      codeIndexFallbackMaxBytes: KIMI_CODE_INDEX_FALLBACK_MAX_BYTES,
      codeIndexFallbackMaxLines: KIMI_CODE_INDEX_FALLBACK_MAX_LINES,
      codeIndexFallbackMaxMs: KIMI_CODE_INDEX_FALLBACK_MAX_MS,
    };
  }
}

module.exports = { KimiAdapter };
