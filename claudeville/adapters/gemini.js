/**
 * Google Gemini CLI adapter
 * Data source: ~/.gemini/
 *
 * Session format (JSON object):
 *   {
 *     "sessionId": "...",
 *     "projectHash": "...",      // cwd SHA-256 hash
 *     "messages": [
 *       {"type": "user", "content": "Hello"},
 *       {"type": "gemini", "content": "Hi!", "model": "gemini-2.5-flash", "tokens": {...}},
 *       {"type": "info", "content": "..."}
 *     ]
 *   }
 *
 * Restore project paths: projectHash is the SHA-256 hash of cwd
 * Hash known project paths to map them
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const { deriveTurnState } = require('./turnState');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const {
  createDetailResponse,
  normalizeCacheTokens,
  statCacheKey,
  summarizeToolInput: summarizeSharedToolInput,
  trimCache,
} = require('./shared');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const SESSION_CACHE_MAX = 256;
const SESSION_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const HASH_TO_PATH_CACHE_MAX = 512;
const GEMINI_TOOL_INPUT_FIELDS = Object.freeze(['command', 'file_path']);

const _parsedSessionCache = new Map();
const _sessionFileById = new Map();
let _parsedSessionCacheBytes = 0;
let _parsedSessionCacheRejected = 0;

function deleteParsedSessionCache(filePath) {
  const cached = _parsedSessionCache.get(filePath);
  if (!cached) return;
  _parsedSessionCache.delete(filePath);
  _parsedSessionCacheBytes = Math.max(0, _parsedSessionCacheBytes - cached.estimatedBytes);
}

function trimParsedSessionCache() {
  while (
    _parsedSessionCache.size > SESSION_CACHE_MAX
    || _parsedSessionCacheBytes > SESSION_CACHE_MAX_BYTES
  ) {
    const oldest = _parsedSessionCache.keys().next().value;
    if (oldest === undefined) break;
    deleteParsedSessionCache(oldest);
  }
}

// ─── Restore project paths ──────────────────────────────

/**
 * Reverse-map project paths from SHA-256 hashes
 * calculate hashes for known path candidates and match them
 */
const _hashToPathCache = new Map();

function cacheResolvedProjectPath(projectHash, projectPath) {
  _hashToPathCache.delete(projectHash);
  _hashToPathCache.set(projectHash, projectPath);
  trimCache(_hashToPathCache, HASH_TO_PATH_CACHE_MAX);
  return projectPath;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function resolveProjectPath(projectHash) {
  // Check cache
  if (_hashToPathCache.has(projectHash)) {
    const cached = _hashToPathCache.get(projectHash);
    _hashToPathCache.delete(projectHash);
    _hashToPathCache.set(projectHash, cached);
    return cached;
  }

  const homeDir = os.homedir();

  // Candidate 1: home directory itself
  if (sha256(homeDir) === projectHash) {
    return cacheResolvedProjectPath(projectHash, homeDir);
  }

  // Candidate 2: first-level children under the home directory (Desktop, Documents, Projects etc.)
  const commonDirs = ['Desktop', 'Documents', 'Projects', 'Developer', 'dev', 'src', 'code', 'repos', 'workspace', 'work'];
  for (const dir of commonDirs) {
    const fullPath = path.join(homeDir, dir);
    if (sha256(fullPath) === projectHash) {
      return cacheResolvedProjectPath(projectHash, fullPath);
    }
    // Search up to two levels deep
    try {
      if (fs.existsSync(fullPath)) {
        const subdirs = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .slice(0, 50); // Limit if there are too many
        for (const sub of subdirs) {
          const subPath = path.join(fullPath, sub.name);
          if (sha256(subPath) === projectHash) {
            return cacheResolvedProjectPath(projectHash, subPath);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Candidate 3: check hashes from Claude Code project paths
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projDirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of projDirs) {
        // Claude projects directory name: -Users-name-path format
        const projPath = '/' + dir.replace(/-/g, '/').replace(/^\//, '');
        if (sha256(projPath) === projectHash) {
          return cacheResolvedProjectPath(projectHash, projPath);
        }
      }
    }
  } catch { /* ignore */ }

  // Mapping failed; return null (do not show the hash directory name)
  return cacheResolvedProjectPath(projectHash, null);
}

function getParsedSession(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const key = statCacheKey(filePath, stat);
    const cached = _parsedSessionCache.get(filePath);
    if (cached?.key === key) {
      _parsedSessionCache.delete(filePath);
      _parsedSessionCache.set(filePath, cached);
      return cached.session;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const session = JSON.parse(content);
    deleteParsedSessionCache(filePath);
    const estimatedBytes = Math.max(stat.size * 2, content.length * 2);
    if (estimatedBytes <= SESSION_CACHE_MAX_BYTES) {
      _parsedSessionCache.set(filePath, { key, session, estimatedBytes });
      _parsedSessionCacheBytes += estimatedBytes;
      trimParsedSessionCache();
    } else {
      _parsedSessionCacheRejected++;
    }
    return session;
  } catch (error) {
    noteReadFailure(error);
    return null;
  }
}

function resolveParsedSession(filePath, parsedSession) {
  return parsedSession === undefined ? getParsedSession(filePath) : parsedSession;
}

function summarizeGeminiToolArgs(args, { maxLength = 60, basenameFile = true, missingValue = null } = {}) {
  return summarizeSharedToolInput(args, {
    fields: GEMINI_TOOL_INPUT_FIELDS,
    basenameFields: basenameFile ? ['file_path'] : [],
    maxLength,
    missingValue,
    objectFallback: 'json',
  });
}

function summarizeGeminiRawInput(input, { maxLength = 60, missingValue = null } = {}) {
  return summarizeSharedToolInput(input, {
    fields: [],
    maxLength,
    missingValue,
    stringFallback: 'string',
    objectFallback: 'json',
  });
}

const GEMINI_DIALOGUE_INTENT_FIELDS = Object.freeze(['description', 'activeForm', 'i']);
const DIALOGUE_CANDIDATE_LIMIT = 8;

function parseGeminiTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseGeminiToolArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readGeminiToolIntent(args) {
  const value = parseGeminiToolArgs(args);
  if (!value) return null;
  for (const field of GEMINI_DIALOGUE_INTENT_FIELDS) {
    if (typeof value[field] === 'string' && value[field].trim()) {
      return { field, text: value[field] };
    }
  }
  return null;
}

// ─── Token usage ────────────────────────────────────────────

const GEMINI_TOKEN_ALIASES = Object.freeze({
  input: ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'promptTokenCount', 'total_input_tokens', 'input'],
  output: ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidatesTokenCount', 'total_output_tokens', 'output'],
  cacheRead: ['cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cachedContentTokenCount', 'cached'],
  cacheCreate: ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write'],
  reasoning: ['reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning_tokens', 'thoughtsTokenCount', 'thoughts'],
  total: ['totalTokenCount', 'total_tokens', 'totalTokens', 'total'],
});
const GEMINI_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: GEMINI_TOKEN_ALIASES.cacheRead,
  cacheCreate: GEMINI_TOKEN_ALIASES.cacheCreate,
});

function readTokenNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const value = obj[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function geminiContextWindowMax(model) {
  const m = String(model || '').toLowerCase();
  // Gemini 1.5/2.x/3.x pro & flash families all expose a ~1M-token window.
  return /gemini-(?:1\.5|2|3)|flash|pro/.test(m) ? 1000000 : 0;
}

/**
 * Sum the per-message `tokens` objects the Gemini CLI records on 'gemini' turns.
 * The file header documents this field, but parseSession never read it, so cost
 * showed $0.00 for every Gemini session. Values are treated as per-turn deltas;
 * the largest turn total drives context-window occupancy.
 */
function getTokenUsage(filePath, parsedSession) {
  const tokenUsage = {
    availability: 'unavailable',
    totalInput: 0,
    totalOutput: 0,
    cacheRead: 0,
    cacheCreate: 0,
    contextWindow: 0,
    contextWindowMax: 0,
    turnCount: 0,
    reasoningTokens: 0,
    // Gemini reports thinking (thoughtsTokenCount) separately from output, so it
    // must be priced rather than treated as already counted inside output.
    reasoningInOutput: false,
  };

  try {
    const session = resolveParsedSession(filePath, parsedSession);
    const messages = session?.messages;
    if (!Array.isArray(messages)) return tokenUsage;

    let model = null;
    for (const msg of messages) {
      if (!model && msg?.type === 'gemini' && msg.model) model = msg.model;

      const tokens = msg?.tokens;
      if (!tokens || typeof tokens !== 'object') continue;

      tokenUsage.availability = 'observed';
      const input = readTokenNumber(tokens, GEMINI_TOKEN_ALIASES.input);
      const output = readTokenNumber(tokens, GEMINI_TOKEN_ALIASES.output);
      const { cacheRead, cacheCreate } = normalizeCacheTokens(tokens, GEMINI_CACHE_FIELD_MAP);

      tokenUsage.totalInput += input;
      tokenUsage.totalOutput += output;
      tokenUsage.cacheRead += cacheRead;
      tokenUsage.cacheCreate += cacheCreate;
      tokenUsage.reasoningTokens += readTokenNumber(tokens, GEMINI_TOKEN_ALIASES.reasoning);
      tokenUsage.turnCount++;

      const total = readTokenNumber(tokens, GEMINI_TOKEN_ALIASES.total) || (input + output + cacheRead);
      if (total > tokenUsage.contextWindow) tokenUsage.contextWindow = total;
    }

    tokenUsage.contextWindowMax = geminiContextWindowMax(model);
  } catch { /* ignore */ }

  return tokenUsage;
}

function geminiTurnState(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const last = messages.findLast(msg => msg?.type !== 'info');
  if (!last || !['user', 'gemini'].includes(last.type)) return deriveTurnState({ known: false });
  const pending = Array.isArray(last.toolCalls)
    ? last.toolCalls.findLast(tool => tool && tool.result == null && !['success', 'error', 'cancelled'].includes(tool.status))
    : null;
  if (pending) return deriveTurnState({ pendingTool: pending.name, pendingSince: parseGeminiTimestamp(last.timestamp) });
  // Text alone is not a recorded end-of-turn marker.
  return deriveTurnState({ turnEnded: last.finishReason === 'STOP', turnEndedAt: parseGeminiTimestamp(last.timestamp) });
}

// ─── Session parsing ────────────────────────────────────────

/**
 * Extract model/tools/messages from Gemini session JSON
 * Actual format: {sessionId, projectHash, messages: [{type, content, model, ...}]}
 */
function parseSession(filePath, parsedSession, project = null) {
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

  try {
    const session = resolveParsedSession(filePath, parsedSession);
    if (!session) return detail;

    const messages = session.messages;
    if (!Array.isArray(messages)) return detail;

    // Scan backward from the end
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Gemini response message
      if (msg.type === 'gemini') {
        // Model information
        if (!detail.model && msg.model) {
          detail.model = msg.model;
        }

        // Text message
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!detail.lastMessage && text.length > 0) {
          detail.lastMessage = text.substring(0, 80);
        }
        if (text.length > 0) {
          addDialogueCandidate({
            text: msg.content,
            kind: 'assistant',
            source: 'gemini.message',
            observedAt: parseGeminiTimestamp(msg.timestamp),
            actionId: msg.id || null,
          });
        }

        // Tool use (when functionCall is present)
        if (!detail.lastTool && msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            detail.lastTool = tc.name || 'function_call';
            if (tc.args) {
              detail.lastToolInput = summarizeGeminiToolArgs(tc.args, { maxLength: 60, basenameFile: true });
            }
            break;
          }
        }
        if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            const intent = readGeminiToolIntent(tc.args);
            if (!intent) continue;
            addDialogueCandidate({
              text: intent.text,
              kind: 'intent',
              source: `gemini.tool.${intent.field}`,
              observedAt: parseGeminiTimestamp(msg.timestamp),
              actionId: tc.id || msg.id || null,
            });
          }
        }
      }

      // Tool call result (tool_call type)
      if (!detail.lastTool && msg.type === 'tool_call') {
        detail.lastTool = msg.name || msg.toolName || 'tool';
        if (msg.input) {
          detail.lastToolInput = summarizeGeminiRawInput(msg.input, { maxLength: 60 });
        }
      }

      if (detail.lastMessage && detail.model) break;
    }
  } catch { /* ignore */ }

  return detail;
}

/**
 * Extract tool history from Gemini sessions
 */
function getToolHistory(filePath, maxItems = 15, parsedSession) {
  const tools = [];
  try {
    const session = resolveParsedSession(filePath, parsedSession);
    if (!session) return tools;
    const messages = session.messages;
    if (!Array.isArray(messages)) return tools;

    for (const msg of messages) {
      // gemini type: check toolCalls
      if (msg.type === 'gemini' && msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const detail = tc.args
            ? summarizeGeminiToolArgs(tc.args, { maxLength: 80, basenameFile: false, missingValue: '' })
            : '';
          tools.push({
            tool: tc.name || 'function_call',
            detail,
            ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
          });
        }
      }

      // tool_call type
      if (msg.type === 'tool_call') {
        const detail = msg.input
          ? summarizeGeminiRawInput(msg.input, { maxLength: 80, missingValue: '' })
          : '';
        tools.push({
          tool: msg.name || msg.toolName || 'tool',
          detail,
          ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
        });
      }
    }
  } catch { /* ignore */ }
  return tools.slice(-maxItems);
}

/**
 * Extract recent messages from Gemini sessions
 */
function getRecentMessages(filePath, maxItems = 5, parsedSession) {
  const msgList = [];
  try {
    const session = resolveParsedSession(filePath, parsedSession);
    if (!session) return msgList;
    const messages = session.messages;
    if (!Array.isArray(messages)) return msgList;

    for (const msg of messages) {
      if (msg.type === 'info') continue; // skip info messages

      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text.length === 0) continue;

      msgList.push({
        role: msg.type === 'gemini' ? 'assistant' : msg.type === 'user' ? 'user' : 'system',
        text: text.substring(0, 200),
        ts: msg.timestamp ? new Date(msg.timestamp).getTime() : 0,
      });
    }
  } catch { /* ignore */ }
  return msgList.slice(-maxItems);
}

function getGitEvents(filePath, context, parsedSession) {
  const events = [];
  try {
    const session = resolveParsedSession(filePath, parsedSession);
    if (!session) return events;
    const messages = session.messages;
    if (!Array.isArray(messages)) return events;

    messages.forEach((msg, msgIndex) => {
      const ts = msg.timestamp || 0;
      if (msg.type === 'gemini' && Array.isArray(msg.toolCalls)) {
        msg.toolCalls.forEach((tc, callIndex) => {
          if (!tc.args) return;
          events.push(...extractGitEventsFromCommandSource(tc.args, {
            ...context,
            ts,
            sourceId: tc.id || msg.id || `${stableHash(JSON.stringify(msg))}:${callIndex}`,
            stderr: '',
          }));
        });
      }

      if (msg.type === 'tool_call' && msg.input) {
        events.push(...extractGitEventsFromCommandSource(msg.input, {
          ...context,
          ts,
          sourceId: msg.id || `${stableHash(JSON.stringify(msg))}:input`,
          stderr: '',
        }));
      }
    });
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

/**
 * Scan active session files
 * ~/.gemini/tmp/<project_hash>/chats/session-*.json
 */
function scanActiveSessions(activeThresholdMs) {
  const results = [];
  if (!fs.existsSync(TMP_DIR)) return results;

  const now = Date.now();

  try {
    const projectDirs = fs.readdirSync(TMP_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const projDir of projectDirs) {
      const chatsDir = path.join(TMP_DIR, projDir.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      let sessionFiles;
      try {
        sessionFiles = fs.readdirSync(chatsDir)
          .filter(f => f.startsWith('session-') && f.endsWith('.json'));
      } catch (error) { noteReadFailure(error); continue; }

      for (const file of sessionFiles) {
        const filePath = path.join(chatsDir, file);
        let stat;
        try { stat = fs.statSync(filePath); } catch (error) { noteReadFailure(error); continue; }

        if (now - stat.mtimeMs > activeThresholdMs) continue;

        results.push({
          filePath,
          mtime: stat.mtimeMs,
          fileName: file,
          projectHash: projDir.name,
        });
      }
    }
  } catch (error) { noteReadFailure(error); /* ignore */ }

  return results;
}

// ─── Adapter class ────────────────────────────────────

class GeminiAdapter {
  get name() { return 'Gemini CLI'; }
  get provider() { return 'gemini'; }
  get homeDir() { return GEMINI_DIR; }

  isAvailable() {
    return fs.existsSync(GEMINI_DIR);
  }

  getActiveSessions(activeThresholdMs) {
    const sessionFiles = scanActiveSessions(activeThresholdMs);
    const sessions = [];
    const activeSessionIds = new Set();

    for (const { filePath, mtime, fileName, projectHash } of sessionFiles) {
      const parsedSession = getParsedSession(filePath);
      const project = resolveProjectPath(projectHash);
      const detail = parseSession(filePath, parsedSession, project);
      const sessionId = fileName.replace('session-', '').replace('.json', '');
      const fullSessionId = `gemini-${sessionId}`;
      activeSessionIds.add(fullSessionId);
      _sessionFileById.set(fullSessionId, filePath);
      sessions.push({
        sessionId: fullSessionId,
        provider: 'gemini',
        sourceSessionId: parsedSession?.sessionId || null,
        ...geminiTurnState(parsedSession),
        agentId: null,
        agentType: 'main',
        model: detail.model || 'gemini',
        status: 'active',
        lastActivity: mtime,
        project: project,
        lastMessage: detail.lastMessage,
        lastTool: detail.lastTool,
        lastToolInput: detail.lastToolInput,
        dialogue: pickDialogue(detail.dialogueCandidates, { now: Date.now() }),
        observedSources: detail.observedSources,
        tokenUsage: getTokenUsage(filePath, parsedSession),
        gitEvents: getGitEvents(filePath, {
          provider: 'gemini',
          sessionId: fullSessionId,
          project,
        }, parsedSession),
        parentSessionId: null,
      });
    }
    for (const sessionId of _sessionFileById.keys()) {
      if (!activeSessionIds.has(sessionId)) _sessionFileById.delete(sessionId);
    }

    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  getSessionDetail(sessionId, project) {
    const cleanId = sessionId.replace('gemini-', '');
    const indexedPath = _sessionFileById.get(sessionId);
    if (indexedPath && fs.existsSync(indexedPath)) {
      const parsedSession = getParsedSession(indexedPath);
      return createDetailResponse({
        toolHistory: getToolHistory(indexedPath, 15, parsedSession),
        messages: getRecentMessages(indexedPath, 5, parsedSession),
        tokenUsage: getTokenUsage(indexedPath, parsedSession),
        sessionId,
      });
    }

    const sessionFiles = scanActiveSessions(30 * 60 * 1000);
    for (const { filePath, fileName } of sessionFiles) {
      const fileId = fileName.replace('session-', '').replace('.json', '');
      if (fileId === cleanId) {
        _sessionFileById.set(sessionId, filePath);
        const parsedSession = getParsedSession(filePath);
        return createDetailResponse({
          toolHistory: getToolHistory(filePath, 15, parsedSession),
          messages: getRecentMessages(filePath, 5, parsedSession),
          tokenUsage: getTokenUsage(filePath, parsedSession),
          sessionId,
        });
      }
    }

    return createDetailResponse({ sessionId });
  }

  getWatchPaths({ sessions = [] } = {}) {
    const paths = [];
    if (fs.existsSync(GEMINI_DIR)) {
      paths.push({ type: 'directory', path: GEMINI_DIR, filters: ['tmp'], scope: 'discovery', kind: 'discovery' });
    }
    if (fs.existsSync(TMP_DIR)) {
      paths.push({ type: 'directory', path: TMP_DIR, scope: 'discovery', kind: 'discovery' });
    }
    for (const session of sessions) {
      const filePath = _sessionFileById.get(session.sessionId);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const chatsDir = path.dirname(filePath);
      const dirtyTarget = {
        sessionId: session.sessionId,
        project: session.project,
      };
      paths.push({ type: 'directory', path: path.dirname(chatsDir), scope: 'recent', kind: 'discovery', activity: session.lastActivity });
      paths.push({
        type: 'directory',
        path: chatsDir,
        filters: ['.json'],
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
    _parsedSessionCache.clear();
    _parsedSessionCacheBytes = 0;
    _sessionFileById.clear();
  }

  invalidateCachesForDirty(dirty = {}) {
    if (dirty.kind === 'transcript' && dirty.path) {
      deleteParsedSessionCache(dirty.path);
      return;
    }
    if (dirty.kind === 'discovery' || dirty.kind === 'reconcile') {
      for (const [projectHash, projectPath] of _hashToPathCache) {
        if (projectPath && fs.existsSync(projectPath)) continue;
        _hashToPathCache.delete(projectHash);
      }
      for (const [sessionId, filePath] of _sessionFileById) {
        if (!fs.existsSync(filePath)) _sessionFileById.delete(sessionId);
      }
    }
  }

  getPerfStats() {
    return {
      parsedSessionEntries: _parsedSessionCache.size,
      parsedSessionBytes: _parsedSessionCacheBytes,
      parsedSessionByteLimit: SESSION_CACHE_MAX_BYTES,
      parsedSessionRejected: _parsedSessionCacheRejected,
      indexedSessions: _sessionFileById.size,
      hashToPathEntries: _hashToPathCache.size,
    };
  }
}

module.exports = { GeminiAdapter };
