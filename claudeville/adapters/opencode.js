/**
 * OpenCode adapter
 * Data source: ~/.local/share/opencode/opencode.db
 *
 * OpenCode stores session metadata in SQLite:
 *   session: id, parent_id, directory, title, agent, model, token totals, time_updated
 *   part: structured tool/text/reasoning/step rows keyed by session_id
 *   message: role metadata keyed by session_id
 */
const { noteReadFailure } = require('./shared');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { MODEL_REVISION } = require('../src/config/models.generated.cjs');
const { dedupeGitEvents, extractGitEventsFromCommandSource, stableHash } = require('./gitEvents');
const {
  createDetailResponse,
  fileSignature,
  normalizeCacheTokens,
  summarizeToolInput: summarizeSharedToolInput,
} = require('./shared');
const { emptyObservedSources, makeDialogue, pickDialogue } = require('./dialogue');
const { deriveTurnState } = require('./turnState');
const { TOOL_RESULT_LIMIT, toolResultId } = require('./toolResults');

const OPENCODE_CONFIG_DIR = process.env.CLAUDEVILLE_OPENCODE_CONFIG_DIR
  || path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_STATE_DIR = process.env.CLAUDEVILLE_OPENCODE_STATE_DIR
  || path.join(os.homedir(), '.local', 'share', 'opencode');
const OPENCODE_DB = process.env.CLAUDEVILLE_OPENCODE_DB
  || path.join(OPENCODE_STATE_DIR, 'opencode.db');

const ACTIVE_SESSION_LIMIT = 256;
const RECENT_PART_LIMIT = 100;
const DETAIL_PART_LIMIT = 300;
const DETAIL_TOOL_LIMIT = 15;
const DETAIL_MESSAGE_OUTPUT_LIMIT = 5;
const SQL_TIMEOUT_MS = 3000;
const SQL_MAX_BUFFER = 4 * 1024 * 1024;
const DIALOGUE_CANDIDATE_LIMIT = 8;
const OPENCODE_TOOL_INPUT_FIELDS = Object.freeze([
  'description',
  'command',
  'cmd',
  'path',
  'filePath',
  'file_path',
  'pattern',
  'query',
  'prompt',
  'url',
]);
const OPENCODE_CACHE_FIELD_MAP = Object.freeze({
  cacheRead: ['tokens_cache_read'],
  cacheCreate: ['tokens_cache_write'],
});
const ACTIVE_SESSION_CANDIDATE_SQL = `
  SELECT s.id, s.parent_id, s.directory, s.title, s.version, s.agent, s.model, s.cost,
         s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
         s.tokens_cache_write, s.time_created, s.time_updated, p.worktree,
         MAX(s.time_updated, COALESCE((
           SELECT MAX(recent_part.time_updated)
           FROM part recent_part
           WHERE recent_part.session_id = s.id
             AND recent_part.time_updated >= :cutoff
         ), 0)) AS latestActivity
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  WHERE s.time_archived IS NULL
    AND s.time_updated >= :cutoff
  ORDER BY latestActivity DESC
  LIMIT :limit
`;

let _sqliteModule = undefined;
let _sqliteCliAvailable = undefined;
const _activeSessionsCache = {
  signature: null,
  threshold: null,
  sessions: [],
  expiresAt: 0,
  hits: 0,
  misses: 0,
};

function databaseSignature() {
  return `${fileSignature(OPENCODE_DB)}|${fileSignature(`${OPENCODE_DB}-wal`)}`;
}

function loadNodeSqlite() {
  if (process.env.CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY === 'cli') return null;
  if (_sqliteModule !== undefined) return _sqliteModule;
  try {
    _sqliteModule = require('node:sqlite');
  } catch {
    _sqliteModule = null;
  }
  return _sqliteModule;
}

function sqliteCliAvailable() {
  if (process.env.CLAUDEVILLE_OPENCODE_SQLITE_STRATEGY === 'node') return false;
  if (_sqliteCliAvailable !== undefined) return _sqliteCliAvailable;
  try {
    execFileSync('sqlite3', ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SQL_TIMEOUT_MS,
    });
    _sqliteCliAvailable = true;
  } catch {
    _sqliteCliAvailable = false;
  }
  return _sqliteCliAvailable;
}

function hasReadStrategy() {
  return !!loadNodeSqlite()?.DatabaseSync || sqliteCliAvailable();
}

function sqlString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function queryRows(sql, params = {}) {
  const sqlite = loadNodeSqlite();
  if (sqlite?.DatabaseSync) {
    let db;
    try {
      db = new sqlite.DatabaseSync(OPENCODE_DB, { readOnly: true });
      return db.prepare(sql).all(params);
    } catch (error) {
      noteReadFailure(error);
      return [];
    } finally {
      try { db?.close(); } catch (error) { noteReadFailure(error); /* ignore */ }
    }
  }

  if (!sqliteCliAvailable()) return [];
  let cliSql = sql;
  for (const [key, value] of Object.entries(params)) {
    cliSql = cliSql.replaceAll(`:${key}`, Number.isFinite(Number(value)) ? String(Number(value)) : sqlString(value));
  }
  let out = '';
  try {
    out = execFileSync('sqlite3', ['-readonly', '-json', OPENCODE_DB, cliSql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SQL_TIMEOUT_MS,
      maxBuffer: SQL_MAX_BUFFER,
    });
  } catch (error) {
    noteReadFailure(error);
    return [];
  }
  if (!out.trim()) return [];
  return JSON.parse(out);
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseModel(rawModel) {
  const parsed = typeof rawModel === 'string' ? parseJson(rawModel, null) : rawModel;
  if (!parsed || typeof parsed !== 'object') {
    return {
      providerID: null,
      modelID: String(rawModel || 'opencode'),
      variant: null,
      label: String(rawModel || 'opencode'),
    };
  }

  const providerID = parsed.providerID || parsed.providerId || parsed.provider || null;
  const modelID = parsed.id || parsed.modelID || parsed.modelId || parsed.model || null;
  return {
    providerID,
    modelID,
    variant: parsed.variant || null,
    label: providerID && modelID ? `${providerID}/${modelID}` : (modelID || providerID || 'opencode'),
  };
}

function normalizeToolName(tool) {
  const raw = String(tool || '').trim();
  const key = raw.toLowerCase().replace(/[_-]/g, '');
  const map = {
    bash: 'Bash',
    shell: 'Bash',
    todowrite: 'TodoWrite',
    todoread: 'TaskList',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    grep: 'Grep',
    glob: 'Glob',
    list: 'LS',
    ls: 'LS',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    patch: 'apply_patch',
  };
  return map[key] || raw || 'unknown';
}

function compactText(value, maxLength = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function summarizeToolInput(input, { maxLength = 80 } = {}) {
  return summarizeSharedToolInput(input, {
    fields: OPENCODE_TOOL_INPUT_FIELDS,
    maxLength,
    missingValue: '',
    emptyObjectValue: '',
    requireTruthyField: false,
    compactWhitespace: true,
    ellipsis: true,
    falseyAsEmpty: true,
    stringFallback: 'string',
    objectFallback: 'json',
  });
}

function tokenUsageFromSession(row, parts = []) {
  const latestStep = latestStepFinish(parts);
  const contextWindow = Number(latestStep?.data?.tokens?.total) || 0;
  const turnCount = parts.filter(part => part.type === 'step-finish').length;
  const input = Number(row.tokens_input) || 0;
  const output = Number(row.tokens_output) || 0;
  const cacheTokens = normalizeCacheTokens(row, OPENCODE_CACHE_FIELD_MAP);
  const cacheRead = cacheTokens.cacheRead;
  const cacheWrite = cacheTokens.cacheCreate;

  return {
    availability: row.tokens_input != null && row.tokens_output != null ? 'observed'
      : row.tokens_input != null || row.tokens_output != null ? 'partial' : 'unavailable',
    input,
    output,
    cacheRead,
    cacheCreate: cacheWrite,
    cacheWrite,
    totalInput: input,
    totalOutput: output,
    contextWindow,
    contextWindowMax: contextLimitForModel(parseModel(row.model).label),
    turnCount,
    // OpenCode stores reasoning separately from output (message totals sum
    // input + output + reasoning + cache), so it is additional billable spend.
    reasoningTokens: Number(row.tokens_reasoning) || 0,
    reportedCost: Number(row.cost) || 0,
  };
}

function contextLimitForModel(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('deepseek-v4-pro')) return 1000000;
  if (normalized.includes('deepseek-v4-flash')) return 256000;
  if (normalized.includes('deepseek-reasoner')) return 128000;
  return 0;
}

function latestStepFinish(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === 'step-finish') return parts[i];
  }
  return null;
}

function normalizePartRow(row) {
  const data = row.data ? parseJson(row.data, {}) : normalizeProjectedPartData(row);
  return {
    id: row.id,
    messageId: row.message_id,
    sessionId: row.session_id,
    role: row.role || null,
    timeCreated: Number(row.time_created) || 0,
    timeUpdated: Number(row.time_updated) || 0,
    type: data?.type || null,
    data,
  };
}

function normalizeProjectedPartData(row) {
  const input = {};
  const inputFields = {
    description: row.input_description,
    command: row.input_command,
    cmd: row.input_cmd,
    path: row.input_path,
    filePath: row.input_file_path || row.input_file_path_legacy,
    file_path: row.input_file_path_legacy || row.input_file_path,
    pattern: row.input_pattern,
    query: row.input_query,
    prompt: row.input_prompt,
    url: row.input_url,
  };
  for (const [key, value] of Object.entries(inputFields)) {
    if (value != null && value !== '') input[key] = value;
  }
  const state = {};
  if (input && Object.keys(input).length) state.input = input;
  if (row.state_status) state.status = row.state_status;
  if (row.state_exit != null) state.metadata = { exit: Number(row.state_exit) };
  if (row.state_time_start != null || row.state_time_end != null) {
    state.time = {};
    if (row.state_time_start != null) state.time.start = Number(row.state_time_start);
    if (row.state_time_end != null) state.time.end = Number(row.state_time_end);
  }

  const data = {
    type: row.part_type || null,
    tool: row.tool || null,
    text: row.text || null,
    callID: row.call_id || null,
    reason: row.finish_reason || null,
  };
  if (Object.keys(state).length) data.state = state;
  if (row.tokens_total != null) data.tokens = { total: Number(row.tokens_total) || 0 };
  return data;
}

function partProjectionSelect() {
  return `
    p.id,
    p.message_id,
    p.session_id,
    p.time_created,
    p.time_updated,
    json_extract(m.data, '$.role') AS role,
    json_extract(p.data, '$.type') AS part_type,
    json_extract(p.data, '$.tool') AS tool,
    substr(json_extract(p.data, '$.text'), 1, 1200) AS text,
    json_extract(p.data, '$.callID') AS call_id,
    substr(json_extract(p.data, '$.state.input.description'), 1, 240) AS input_description,
    substr(json_extract(p.data, '$.state.input.command'), 1, 2400) AS input_command,
    substr(json_extract(p.data, '$.state.input.cmd'), 1, 2400) AS input_cmd,
    substr(json_extract(p.data, '$.state.input.path'), 1, 800) AS input_path,
    substr(json_extract(p.data, '$.state.input.filePath'), 1, 800) AS input_file_path,
    substr(json_extract(p.data, '$.state.input.file_path'), 1, 800) AS input_file_path_legacy,
    substr(json_extract(p.data, '$.state.input.pattern'), 1, 400) AS input_pattern,
    substr(json_extract(p.data, '$.state.input.query'), 1, 400) AS input_query,
    substr(json_extract(p.data, '$.state.input.prompt'), 1, 800) AS input_prompt,
    substr(json_extract(p.data, '$.state.input.url'), 1, 800) AS input_url,
    json_extract(p.data, '$.state.status') AS state_status,
    json_extract(p.data, '$.state.metadata.exit') AS state_exit,
    json_extract(p.data, '$.state.time.start') AS state_time_start,
    json_extract(p.data, '$.state.time.end') AS state_time_end,
    json_extract(p.data, '$.reason') AS finish_reason,
    json_extract(p.data, '$.tokens.total') AS tokens_total
  `;
}

function getRecentPartsForSession(sessionId, limit = RECENT_PART_LIMIT) {
  return getRecentPartsForSessions([sessionId], limit).get(sessionId) || [];
}

function recentPartsQuery(idList) {
  return `
    SELECT id, message_id, session_id, time_created, time_updated, role, part_type, tool, text,
           call_id, input_description, input_command, input_cmd, input_path, input_file_path,
           input_file_path_legacy, input_pattern, input_query, input_prompt, input_url,
           state_status, state_exit, state_time_start, state_time_end, finish_reason, tokens_total
    FROM (
      SELECT ${partProjectionSelect()},
             ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_created DESC, p.id DESC) AS rn
      FROM part p
      LEFT JOIN message m ON m.id = p.message_id
      WHERE p.session_id IN (${idList})
        AND p.time_created >= :cutoff
    )
    WHERE rn <= :limit
    ORDER BY session_id ASC, time_created ASC, id ASC
  `;
}

function getRecentPartsForSessions(sessionIds, limit = RECENT_PART_LIMIT, cutoff = 0) {
  const ids = [...new Set((sessionIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  const partsBySession = new Map(ids.map(id => [id, []]));
  if (!ids.length) return partsBySession;

  const idList = ids.map(sqlString).join(', ');
  const rows = queryRows(recentPartsQuery(idList), { limit, cutoff });

  for (const row of rows) {
    const part = normalizePartRow(row);
    if (!partsBySession.has(part.sessionId)) partsBySession.set(part.sessionId, []);
    partsBySession.get(part.sessionId).push(part);
  }
  return partsBySession;
}

function getAllRecentPartsForSession(sessionId, limit = RECENT_PART_LIMIT) {
  const rows = queryRows(`
    SELECT ${partProjectionSelect()}
    FROM part p
    LEFT JOIN message m ON m.id = p.message_id
    WHERE p.session_id = :sessionId
    ORDER BY p.time_created DESC, p.id DESC
    LIMIT :limit
  `, { sessionId, limit });
  return rows.map(normalizePartRow).reverse();
}

function getLastTool(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type !== 'tool') continue;
    const tool = normalizeToolName(part.data.tool);
    const stateInput = part.data.state?.input || part.data.input || {};
    return {
      lastTool: tool,
      lastToolInput: summarizeToolInput(stateInput, { maxLength: 60 }),
    };
  }
  return { lastTool: null, lastToolInput: null };
}

function getLastMessage(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type !== 'text') continue;
    const text = compactText(part.data.text, 80);
    if (text) return text;
  }
  return null;
}

function getOpenCodeTurnState(parts, now = Date.now()) {
  const projectedParts = Array.isArray(parts) ? parts : [];
  if (!projectedParts.length) {
    return {
      ...deriveTurnState({ known: false }, now),
      turnStartedAt: null,
    };
  }

  let turnStartIndex = 0;
  let turnStartedAt = null;
  for (let i = projectedParts.length - 1; i >= 0; i--) {
    const part = projectedParts[i];
    if (String(part?.role || '').toLowerCase() !== 'user') continue;
    turnStartIndex = i;
    turnStartedAt = observedAtForPart(part);
    break;
  }

  const currentTurn = projectedParts.slice(turnStartIndex);
  let pendingTool = null;
  let pendingSince = null;
  for (const part of currentTurn) {
    if (part?.type !== 'tool') continue;
    const status = String(part.data?.state?.status || '').toLowerCase();
    if (status !== 'pending' && status !== 'running') continue;
    pendingTool = normalizeToolName(part.data?.tool);
    pendingSince = Number(part.data?.state?.time?.start) || observedAtForPart(part);
    break;
  }

  let lastFinish = null;
  let lastAssistantText = null;
  for (const part of currentTurn) {
    if (part?.type === 'step-finish') lastFinish = part;
    if (part?.type === 'text' && modelAuthoredRole(part.role) && compactText(part.data?.text)) {
      lastAssistantText = part;
    }
  }
  const finishReason = String(lastFinish?.data?.reason || '').toLowerCase();
  const turnEnded = !pendingTool && (
    (lastFinish && finishReason && finishReason !== 'tool-calls')
    || (!finishReason && !!lastAssistantText)
  );
  const turnEndedAt = observedAtForPart(lastFinish) || observedAtForPart(lastAssistantText);

  return {
    ...deriveTurnState({
      pendingTool,
      pendingSince,
      turnEnded,
      turnEndedAt,
      permissionMode: 'bypassPermissions',
    }, now),
    turnStartedAt,
  };
}

function providerCostFromRow(row) {
  if (row?.cost == null || row.cost === '') return null;
  const usd = Number(row.cost);
  if (!Number.isFinite(usd) || usd < 0) return null;
  return {
    usd,
    source: 'provider',
    rateMatch: null,
    rateRevision: MODEL_REVISION,
    unknownModel: false,
  };
}

function observedAtForPart(part) {
  if (!part || typeof part !== 'object') return null;
  for (const value of [part.timeCreated, part.timeUpdated]) {
    if (value == null || value === '') continue;
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return null;
}

function actionIdForPart(part) {
  if (!part || typeof part !== 'object') return null;
  const callId = part.data && typeof part.data === 'object' ? part.data.callID : null;
  if (callId != null && String(callId).trim()) return callId;
  if (part.id != null && String(part.id).trim()) return part.id;
  return null;
}

function modelAuthoredRole(role) {
  if (typeof role !== 'string') return false;
  const normalized = role.trim().toLowerCase();
  return normalized === 'assistant' || normalized === 'model';
}

function toolInputForPart(part) {
  if (!part || typeof part !== 'object' || !part.data || typeof part.data !== 'object') {
    return null;
  }
  const state = part.data.state;
  if (state && typeof state === 'object' && state.input && typeof state.input === 'object') {
    return state.input;
  }
  if (part.data.input && typeof part.data.input === 'object') return part.data.input;
  return null;
}

function getDialogue(parts, project) {
  const candidates = [];
  const observedSources = emptyObservedSources();
  const counts = { intent: 0, thinking: 0, assistant: 0 };
  const projectedParts = Array.isArray(parts) ? parts : [];

  for (let i = projectedParts.length - 1; i >= 0; i--) {
    const part = projectedParts[i];
    if (!part || typeof part !== 'object') continue;

    let text = '';
    let kind = null;
    let source = null;
    if (part.type === 'reasoning') {
      text = part.data && typeof part.data.text === 'string' ? part.data.text : '';
      if (!text.trim()) continue;
      observedSources.thinkingPlaintext = true;
      kind = 'thinking';
      source = 'opencode.reasoning';
    } else if (part.type === 'text') {
      if (!modelAuthoredRole(part.role)) continue;
      text = part.data && typeof part.data.text === 'string' ? part.data.text : '';
      if (!text.trim()) continue;
      observedSources.assistantText = true;
      kind = 'assistant';
      source = 'opencode.message';
    } else if (part.type === 'tool') {
      const input = toolInputForPart(part);
      const description = input && typeof input.description === 'string'
        ? input.description
        : '';
      if (!description.trim()) continue;
      observedSources.toolIntent = true;
      text = description;
      kind = 'intent';
      source = 'opencode.tool.description';
    } else {
      continue;
    }

    if (counts[kind] >= DIALOGUE_CANDIDATE_LIMIT) continue;
    const observedAt = observedAtForPart(part);
    if (!observedAt) continue;
    const candidate = makeDialogue({
      text,
      kind,
      source,
      observedAt,
      actionId: actionIdForPart(part),
      project,
    });
    if (candidate) {
      candidates.push(candidate);
      counts[kind]++;
    }

    if (
      counts.intent >= DIALOGUE_CANDIDATE_LIMIT
      && counts.thinking >= DIALOGUE_CANDIDATE_LIMIT
      && counts.assistant >= DIALOGUE_CANDIDATE_LIMIT
    ) {
      break;
    }
  }

  return {
    dialogue: pickDialogue(candidates, { now: Date.now() }),
    observedSources,
  };
}

function getTextMessages(parts, maxItems = DETAIL_MESSAGE_OUTPUT_LIMIT) {
  const messages = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    const text = compactText(part.data.text, 200);
    if (!text) continue;
    messages.push({
      role: part.role || 'assistant',
      text,
      ts: part.timeCreated,
    });
  }
  return messages.slice(-maxItems);
}

function getToolHistory(parts, maxItems = DETAIL_TOOL_LIMIT) {
  const tools = [];
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    const state = part.data.state || {};
    const stateInput = state.input || part.data.input || {};
    const item = {
      tool: normalizeToolName(part.data.tool),
      detail: summarizeToolInput(stateInput, { maxLength: 80 }),
      ts: part.timeCreated,
    };
    const exitCode = Number(state.metadata?.exit ?? state.exitCode ?? state.exit_code);
    if (Number.isFinite(exitCode)) {
      item.toolExitCode = exitCode;
      const stderr = typeof state.metadata?.stderr === 'string' ? state.metadata.stderr : '';
      if (exitCode !== 0 && stderr) item.toolStderr = stderr.trim().substring(0, 200);
    }
    tools.push(item);
  }
  return tools.slice(-maxItems);
}

// OpenCode records a command's process exit in the tool part's own state. That
// number is the only outcome evidence here: a part that merely finished, with
// no `metadata.exit`, produces no result record.
function getToolResults(parts, sessionId) {
  const results = [];
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    const state = part.data.state || {};
    const rawExit = state.metadata?.exit ?? state.exitCode ?? state.exit_code;
    if (rawExit === null || rawExit === undefined || rawExit === '' || !Number.isFinite(Number(rawExit))) continue;
    const completedAt = Number(state.time?.end || part.timeUpdated || part.timeCreated) || null;
    if (!completedAt) continue;
    const startedAt = Number(state.time?.start) || null;
    const tool = normalizeToolName(part.data.tool);
    if (!tool) continue;
    const detail = summarizeToolInput(state.input || part.data.input || {}, { maxLength: 80 }) || '';
    const callId = part.data.callID || part.data.callId || part.id || null;
    results.push({
      id: toolResultId({ provider: 'opencode', sessionId, callId, tool, detail, completedAt }),
      tool,
      detail,
      exitCode: Math.trunc(Number(rawExit)),
      durationMs: startedAt ? Math.max(0, completedAt - startedAt) : null,
      completedAt,
      source: 'transcript',
    });
  }
  return results.slice(-TOOL_RESULT_LIMIT).reverse();
}

function getSessionRow(sessionId) {
  const rows = queryRows(`
    SELECT s.id, s.parent_id, s.directory, s.title, s.version, s.agent, s.model, s.cost,
           s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
           s.tokens_cache_write, s.time_created, s.time_updated, p.worktree
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    WHERE s.id = :sessionId
    LIMIT 1
  `, { sessionId });
  return rows[0] || null;
}

function getGitEvents(parts, context) {
  const events = [];
  try {
    for (const part of parts) {
      if (part.type !== 'tool') continue;
      const tool = String(part.data.tool || '').toLowerCase();
      if (tool !== 'bash' && tool !== 'shell') continue;

      const state = part.data.state || {};
      const input = state.input || part.data.input || {};
      const command = input.command || input.cmd || '';
      if (!command) continue;

      const parsedEvents = extractGitEventsFromCommandSource(command, {
        ...context,
        ts: part.timeCreated,
        sourceId: part.data.callID || part.data.callId || part.id || `${stableHash(JSON.stringify(part.data))}:0`,
      });

      const exitCode = Number(state.metadata?.exit ?? state.exitCode ?? state.exit_code);
      const completedAt = Number(state.time?.end || part.timeUpdated || part.timeCreated) || null;
      for (const event of parsedEvents) {
        if (Number.isFinite(exitCode)) {
          event.exitCode = exitCode;
          event.success = exitCode === 0;
        } else if (state.status === 'completed') {
          event.success = true;
        } else if (state.status === 'error' || state.status === 'failed') {
          event.success = false;
        }
        if (completedAt) event.completedAt = completedAt;
      }
      events.push(...parsedEvents);
    }
  } catch { /* ignore */ }
  return dedupeGitEvents(events);
}

function rawSessionId(sessionId) {
  return String(sessionId || '').replace(/^opencode-/, '');
}

function buildOpenCodeSession(row, parts, now = Date.now()) {
  const model = parseModel(row.model);
  const sessionId = `opencode-${row.id}`;
  const tool = getLastTool(parts);
  const project = row.directory || row.worktree || null;
  const dialogue = getDialogue(parts, project);
  const title = compactText(row.title, 80) || null;
  const agentName = row.agent || title;
  const turn = getOpenCodeTurnState(parts, now);
  const cost = providerCostFromRow(row);
  return {
    sessionId,
    provider: 'opencode',
    agentId: row.id,
    agentName,
    name: agentName,
    agentType: row.parent_id ? 'sub-agent' : 'main',
    parentSessionId: row.parent_id ? `opencode-${row.parent_id}` : null,
    project,
    model: model.label,
    status: 'active',
    lastActivity: Number(row.latestActivity) || Number(row.time_updated) || 0,
    lastTool: tool.lastTool,
    lastToolInput: tool.lastToolInput,
    lastMessage: getLastMessage(parts),
    dialogue: dialogue.dialogue,
    observedSources: dialogue.observedSources,
    tokenUsage: tokenUsageFromSession(row, parts),
    ...(cost ? { cost } : {}),
    ...turn,
    signalSource: 'transcript',
    lastResults: getToolResults(parts, sessionId),
    gitEvents: getGitEvents(parts, { provider: 'opencode', sessionId, project }),
  };
}

class OpenCodeAdapter {
  get name() { return 'OpenCode'; }
  get provider() { return 'opencode'; }
  get homeDir() { return OPENCODE_STATE_DIR; }

  isAvailable() {
    return fs.existsSync(OPENCODE_DB) && hasReadStrategy();
  }

  getActiveSessions(activeThresholdMs) {
    if (!this.isAvailable()) return [];

    const signature = databaseSignature();
    if (
      _activeSessionsCache.signature === signature
      && _activeSessionsCache.threshold === activeThresholdMs
      && Date.now() < _activeSessionsCache.expiresAt
    ) {
      _activeSessionsCache.hits++;
      return _activeSessionsCache.sessions;
    }
    _activeSessionsCache.misses++;

    const cutoff = Date.now() - activeThresholdMs;
    // OpenCode updates session.time_updated with session activity. Use it to
    // bound candidates before probing each candidate's indexed part rows.
    const candidateRows = queryRows(ACTIVE_SESSION_CANDIDATE_SQL, {
      cutoff,
      limit: ACTIVE_SESSION_LIMIT,
    });

    const rows = candidateRows
      .map(row => ({
        ...row,
        latestActivity: Number(row.latestActivity) || Number(row.time_updated) || 0,
      }))
      .sort((a, b) => b.latestActivity - a.latestActivity);
    const partsBySession = getRecentPartsForSessions(rows.map(row => row.id), RECENT_PART_LIMIT, cutoff);
    const sessions = rows.map(row => buildOpenCodeSession(row, partsBySession.get(row.id) || []));
    _activeSessionsCache.signature = signature;
    _activeSessionsCache.threshold = activeThresholdMs;
    _activeSessionsCache.sessions = sessions;
    _activeSessionsCache.expiresAt = sessions.length
      ? Math.min(...sessions.map(session => session.lastActivity + activeThresholdMs))
      : Infinity;
    return sessions;
  }

  getSessionDetail(sessionId, project) {
    if (!this.isAvailable()) {
      return createDetailResponse({ provider: 'opencode', sessionId, project });
    }

    const cleanId = rawSessionId(sessionId);
    const row = getSessionRow(cleanId);
    if (!row) {
      return createDetailResponse({ provider: 'opencode', sessionId, project });
    }

    const parts = getAllRecentPartsForSession(cleanId, DETAIL_PART_LIMIT);
    return createDetailResponse({
      provider: 'opencode',
      sessionId,
      project: row.directory || row.worktree || project || '',
      agentName: row.agent || row.title || null,
      toolHistory: getToolHistory(parts),
      messages: getTextMessages(parts),
      tokenUsage: tokenUsageFromSession(row, parts),
      gitEvents: getGitEvents(parts, {
        provider: 'opencode',
        sessionId,
        project: row.directory || row.worktree || project || null,
      }),
    });
  }

  getWatchPaths() {
    const paths = [];
    if (fs.existsSync(OPENCODE_STATE_DIR)) {
      paths.push({
        type: 'directory',
        path: OPENCODE_STATE_DIR,
        // SQLite readers update shared-memory lock state. Watching -shm makes
        // ClaudeVille's own read trigger another read in a tight feedback loop.
        filters: ['.db', '.db-wal'],
        scope: 'discovery',
        probe: true,
      });
      for (const filePath of [OPENCODE_DB, `${OPENCODE_DB}-wal`]) {
        if (fs.existsSync(filePath)) {
          paths.push({ type: 'file', path: filePath, scope: 'discovery', probe: true });
        }
      }
    }
    if (fs.existsSync(OPENCODE_CONFIG_DIR)) {
      paths.push({ type: 'directory', path: OPENCODE_CONFIG_DIR, filters: ['.json', 'agents'], scope: 'discovery' });
      const agentsDir = path.join(OPENCODE_CONFIG_DIR, 'agents');
      if (fs.existsSync(agentsDir)) {
        paths.push({ type: 'directory', path: agentsDir, filters: ['.md'], scope: 'discovery' });
      }
    }
    return paths;
  }

  invalidateCaches() {
    _activeSessionsCache.signature = null;
    _activeSessionsCache.threshold = null;
    _activeSessionsCache.sessions = [];
    _activeSessionsCache.expiresAt = 0;
  }

  getPerfStats() {
    return {
      activeSessionCacheHits: _activeSessionsCache.hits,
      activeSessionCacheMisses: _activeSessionsCache.misses,
      activeSessionCacheEntries: _activeSessionsCache.sessions.length,
    };
  }
}

module.exports = {
  OpenCodeAdapter,
  _test: {
    ACTIVE_SESSION_CANDIDATE_SQL,
    buildOpenCodeSession,
    getOpenCodeTurnState,
    providerCostFromRow,
    recentPartsQuery,
  },
};
