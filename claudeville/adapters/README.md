# Provider Adapters

Read-only readers that pull active session data from local CLI provider stores (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.kimi-code/`, `~/.local/share/opencode/`, and `~/.omp/`) and normalize it into a single shape the rest of ClaudeVille consumes.

## Purpose

Each adapter wraps one provider's on-disk session format and exposes a small uniform contract. The server (`claudeville/server.js`) and the application layer never touch provider files directly; they go through `adapters/index.js`, which iterates available adapters and aggregates results.

Adapters never write. Provider session files are inputs; do not mutate them.

## Provider sources

- `claude.js`: `~/.claude/` history, projects, teams, tasks, subagents, and workflow subagents.
- `codex.js`: recent `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` transcripts and `session_index.jsonl` names.
- `gemini.js`: `~/.gemini/tmp/<project_hash>/chats/session-*.json`, with best-effort project-hash reversal.
- `grok.js`: `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` summaries, updates, and chat history; `active_sessions.json` is optional.
- `kimi.js`: legacy `~/.kimi/` wire/state data and Kimi Code indexes, transcripts, state, and config under `~/.kimi-code/`.
- `opencode.js`: read-only `~/.local/share/opencode/opencode.db`, including parent links and shell-derived git events.
- `omp.js`: `~/.omp/agent/sessions/` parent and nested-agent JSONL transcripts. `workingSet` uses observed `read`/`write` tool-call `arguments.path` and successful `edit` tool-result `details.perFileResults[].path` (not patch or result prose). Read selectors are removed; URI/device/archive targets and directories are excluded. Like Claude, it retains the latest 64 path observations and returns at most 16 distinct canonical paths, newest first, with `{ path, op, at, source: 'transcript' }`; the latest observation wins for repeated paths. Relative paths resolve against the recorded session cwd; paths inside the project are project-relative and other home paths use `~/`. Calls describe observed access intent, not proof of successful file I/O. The redacted local-store shape fixture is `scripts/adapters/fixtures/omp/working-set.jsonl`.
- `turnState.js`: provider-neutral `working`, `tool_pending`, `awaiting_input`, and `unknown` derivation plus pending-tool classification.
- `gitEvents.js`: best-effort commit/push extraction and repository-only `provider: 'git'` synthesis.

Adapter availability is automatic; empty provider output is not necessarily an error. `adapters/index.js` caches lists for 2000 ms and details for 5000 ms. A detail failure returns stale cached data when available, otherwise an empty detail shape.

Registration and runtime metadata live in `claudeville/adapters/index.js`:

```js
const adapters = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new GeminiAdapter(),
  new GrokAdapter(),
  new KimiAdapter(),
  new OpenCodeAdapter(),
  new OmpAdapter(),
];
```

`isAvailable()` is checked on every aggregation pass, so machines without a provider installed are silently skipped.
The registry also exposes provider metadata (`provider`, display `name`, `supportsDetail`, `supportsWatchPaths`) used by `server.js` for detail-route validation. Do not add a second provider allowlist in the server.

## Adapter registry behavior

`adapters/index.js` is the aggregation layer used by `server.js`; the server does not read provider files directly.

- `getAllSessions(activeThresholdMs)` skips unavailable adapters, isolates per-adapter failures, merges results, sorts by `lastActivity` descending, and caches the full list briefly.
- `getSessionDetailByProvider(provider, sessionId, project)` dispatches to the matching adapter, caches successful detail payloads briefly, and returns stale cached details after an adapter error when possible.
- `getAllWatchPaths()` merges active adapter watch paths and ignores adapter watch-path errors.
- `getActiveProviders()` surfaces provider display names and home directories for `/api/providers`.
- `normalizeSession(session)` and `normalizeDetail(detail, context)` are the final API-shape gate. Adapters should still return the documented shape, but the registry supplies safe defaults for nullable fields before data reaches `server.js`.

The short caches are intentional. The browser, activity panel, dashboard mode, and WebSocket loop all poll near-live state, so the registry absorbs repeated identical reads without making the UI feel stale.

### JSONL parse diagnostics

The shared JSONL parser (`shared.js` `parseJsonLines` / `readJsonLines`) counts lines per adapter source: `parsedLines`, `skippedLines` (malformed lines mid-window — potential silent data loss), and `trailingPartials` (the benign partial final line of an actively-written file). Parsed tail records share the existing byte-bounded tail state, so unchanged polls reuse objects and safe appends parse only new lines. Counts plus the most recent skip (file, byte offset relative to the read window, line size) are exposed via `/api/perf` as `jsonlDiagnostics`; parsed-tail hit/reuse counters are under `tailCache.parsed`. Set `CLAUDEVILLE_DEBUG_JSONL=1` before starting the server to additionally log every skipped line with its offset and a snippet.

## Contract

Each adapter class must expose the following getters and methods. Getters are JS class getters (no parentheses), not methods.

| Member | Kind | Returns | Consumer |
| --- | --- | --- | --- |
| `name` | getter | display string (e.g. `'Claude Code'`) | `getActiveProviders()`, surfaced via `/api/providers` |
| `provider` | getter | stable id (`'claude'` / `'codex'` / `'gemini'` / `'grok'` / `'kimi'` / `'opencode'` / `'omp'`) | Adapter dispatch and adapter-backed session objects |
| `homeDir` | getter | absolute path to the provider's source dir | `getActiveProviders()` |
| `isAvailable()` | method | `boolean` | Gates every registry iteration |
| `getActiveSessions(activeThresholdMs)` | method | `Session[]` (see below) | Called from `server.js` per request and per polling tick |
| `getSessionDetail(sessionId, project)` | method | `{ toolHistory, messages, tokenUsage?, sessionId }` | Served at `/api/session-detail` |
| `getWatchPaths()` | method | `WatchPath[]` (see below) | Consumed by `server.js` in `startFileWatcher()` |

Registry metadata treats adapter-backed providers as detail-capable when `getSessionDetail` exists. Synthetic providers must be declared in the registry metadata instead of hard-coded in `server.js`.

`toolHistory` items are `{ tool, detail, ts }` plus two optional failure fields where the provider payload carries them: `toolExitCode` (number; Codex `exec_command_end` events matched by `call_id`, Kimi Code `tool.result.result.isError` / `is_error` / exit fields, OpenCode `state.metadata.exit`) and `toolStderr` (string, truncated to 200 chars, only set on non-zero exits). The Activity Panel renders non-zero `toolExitCode` as a warning chip on the tool row.

### Claude-only optional methods

`ClaudeAdapter` additionally exposes:

| Member | Returns | Consumer |
| --- | --- | --- |
| `getTeams()` | array of team metadata from `~/.claude/teams/` | `/api/teams`, `AgentManager._buildTeamMembers` |
| `getTasks()` | array of task metadata from `~/.claude/tasks/` | `/api/tasks` |

`server.js` calls these only when `claudeAdapter` is present. Other adapters do not need to implement them.

## Normalized session object

`getActiveSessions(activeThresholdMs)` must return objects with these fields. `AgentManager` (`src/application/AgentManager.js`) consumes them.

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | Unique across providers. Codex, Gemini, Grok, Kimi, OpenCode, and OMP prefix with `codex-` / `gemini-` / `grok-` / `kimi-` / `opencode-` / `omp-`; Claude uses the raw uuid; subagents use `subagent-<agentId>`. Repository-only git sessions use `git-repo-<hash>`. |
| `provider` | `'claude' \| 'codex' \| 'gemini' \| 'grok' \| 'kimi' \| 'opencode' \| 'omp' \| 'git'` | Adapter-backed sessions use the CLI/source provider id. DeepSeek-backed OpenCode sessions still use `provider: 'opencode'` and expose DeepSeek through `model`. OMP sessions use `provider: 'omp'` and expose their underlying provider through `underlyingProvider` (z.AI GLM sessions carry `underlyingProvider: 'zai'` and `model` as either the prefixed `'zai/glm-5.3'` from `model_change` or the bare `'glm-5.3'` from later assistant messages; the registry resolves both). The registry can synthesize repository sessions with `provider: 'git'` for unpushed commit visibility. |
| `agentId` | string \| null | Provider-specific agent thread id; nullable for Gemini. |
| `agentType` | `'main' \| 'sub-agent' \| 'team-member' \| 'workflow-subagent' \| 'repository'` | Drives sprite/card grouping. Default `'main'`. Claude `Agent` launches always use `'sub-agent'`; their provider-specific kind is kept in `subagentKind`. Synthetic git sessions use `'repository'`. Workflow tool sub-agents use `'workflow-subagent'`. |
| `subagentKind` | string \| null | Claude-only kind supplied to an `Agent` launch (for example `'Explore'` or `'general-purpose'`). It never replaces an `agentType` enum value. |
| `agentName` | string \| null | Human label when the provider exposes one (Codex `session_index.jsonl` `thread_name` with `agent_nickname` fallback, Claude team launch name). |
| `project` | string \| null | Absolute working directory. Gemini may resolve this from a SHA-256 hash and return null on failure. |
| `model` | string | Free-form. UI strips `claude-` and `-2025…` suffixes for display. |
| `status` | `'active'` | Currently always `'active'`; idle/terminated transitions are inferred client-side by `AgentManager`. |
| `lastActivity` | number (ms epoch) | Latest of file mtime and any in-file timestamp. Sort key. |
| `lastTool` | string \| null | Most recent tool name. |
| `lastToolInput` | string \| null | Compact summary of the tool's argument; truncated to ~60 chars. |
| `lastMessage` | string \| null | Most recent assistant text; truncated. |
| `lastPrompt` | string \| null | Most recent user prompt, trimmed to 200 characters. Codex reads user rollout messages; OMP ignores system-reminder and advisory XML blocks. |
| `todos` | array | Current provider checklist, up to 64 `{ subject, status, phase }` items in declared order. Subjects are capped at 200 characters, statuses are `pending`, `in_progress`, or `completed`, and `phase` is either a label capped at 80 characters or `null`. Claude `TodoWrite` and Codex `update_plan` have no phase labels; OMP folds `todo` operations and preserves their phases. |
| `gitBranch` | string \| null | Provider-recorded git branch when present, capped at 256 characters. |
| `tokenUsage` | object \| null | See "Token normalization" below. Registry normalization sets this to null when adapters omit token data. |
| `parentSessionId` | string \| null | Set on subagent / spawned-thread sessions. |
| `reasoningEffort` | string \| null | Codex-only. Pulled from `turn_context` / `event_msg`. |
| `workflowId` | string \| null | Claude-only. Workflow run id (`wf_<id>`) for sub-agents spawned by the Workflow tool; null otherwise. |
| `workflowName` | string \| null | Claude-only. Human workflow name recovered from the persisted run-script filename; null otherwise. |
| `permissionMode` | string \| null | Claude-only. Latest `permissionMode` marker in the transcript tail window (`'default'` / `'plan'` / `'acceptEdits'` / `'bypassPermissions'`); `'plan'` means the session is in plan mode, anything else is act mode. Registry normalization sets this to null when adapters omit it. |
| `turnState` | string | What the session is doing, from its transcript: `'working'`, `'tool_pending'` (a tool call with no result yet), `'awaiting_input'` (the turn closed and the next move is the user's), or `'unknown'` when the adapter cannot tell. Derived via `turnState.js`; Claude, Codex, Kimi Code, OMP, and OpenCode populate it from their recorded lifecycle. Gemini tool calls/results and explicit finish markers, and Grok ACP tool calls/updates, provide narrower coverage; unrecognized records stay unknown. |
| `pendingTool` | string \| null | Name of the unanswered tool call, when `turnState` is `'tool_pending'`. |
| `pendingSince` | number \| null | ms epoch the pending call was issued. Orders unresolved calls; elapsed time never proves an approval prompt. |
| `waitReason` | string \| null | Why the session is blocked on a person: `'question'`, `'approval'`, or `'plan_review'`. Null when a pending tool is judged to be merely executing. |
| `awaitingSince` | number \| null | ms epoch the session started waiting on the user (or closed its turn). Orders the attention queue. |
| `resident` | boolean | True when the server is serving a frozen snapshot of a session that has left the active window (see `services/sessionResidency.js`). |
| `sendMessages` | array | Claude-only sender→recipient edges from `SendMessage` tool calls; the carrying session is the sender. Up to 10 most recent edges of `{ recipient, messageType, summary, ts }`: `recipient` is the raw alias from the tool input (match against `agentName`/`name`/`agentId`), `messageType` is the tool input `type` (default `'message'`), `summary` is truncated to 80 chars or null, `ts` is the transcript entry timestamp. Edges without a resolvable recipient (e.g. `shutdown_response` replies keyed by `request_id`) are skipped. Registry normalization sets this to `[]` when adapters omit it. |
| `gitEvents` | array | Backend-extracted git `commit` / `push` events from raw tool records. Registry normalization sets this to `[]` when adapters omit it. Dry-run events are omitted. Events include `id`, `type`, `project`, `provider`, `sessionId`, `sourceId`, `ts`, and `commandHash`; `command`, `targetRef`, `success`, `exitCode`, and `completedAt` are optional metadata when the adapter can derive them. |
| `lastResults` | array | Up to 5 most recent provider-reported outcomes of calls that already finished, newest first: `{ id, tool, detail, exitCode, durationMs, completedAt, source }`. See "Command results" below. Registry normalization sets this to `[]` when adapters omit it. |

### Command results

`lastResults` answers a question invocation cannot: how a call ended. A record
exists only where the provider wrote one down.

- **Codex** — `item_completed` records of type `CommandExecution` (`codex.js`). `exit_code` may be absent on an interrupted command; `exitCode` is then `null` and the outcome stays explicitly unknown.
- **Kimi Code** — `tool.result` loop events carrying an exit code, or an explicit `isError`/`is_error`/`error` flag (`kimi.js`). A result that only carries output is not an outcome and produces nothing.
- **OpenCode** — tool parts with a numeric `state.metadata.exit` (`opencode.js`).
- **Claude, Gemini, Grok, OMP** — no result record is published. Nothing downstream may synthesize one.

`id` is derived from provider, session, and call identity in `toolResults.js`, so
re-reading the same transcript yields the same id and consumers deduplicate
across polls instead of stamping a completion twice. Providers without a call id
fall back to the recorded completion time plus the call's own shape — still read
from the record, never from receipt time. `durationMs` is the provider's own
duration or the span between the call and its result in the same transcript;
`completedAt` is required and an entry without one is dropped. `detail` is the
existing bounded tool-input summary (≤ 80 chars) and carries the classification
the world uses to place the result at a building. The list is capped at
`TOOL_RESULT_LIMIT` (5) per session, deduplicated by id and sorted newest first
by `normalizeToolResults`, so a busy session cannot grow the list payload.

A tool disappearing from a transcript tail is not a result, and neither is a
session leaving the roster. The client mirrors this cap in `Agent.lastResults`
and emits one `tool:result` event per newly observed id
(`character-mode/AgentEventStream.js`).

### Observation and signal certainty

Public `sessionId` remains the filename-derived dashboard identity. Hooks are keyed by provider and source ID; matching also considers `sourceSessionId`, `agentId`, and the unprefixed public ID. Gemini supplies its JSON `sessionId` as `sourceSessionId`; Codex retains its actual thread ID in `agentId`. Identical raw IDs from different providers never share overlays.

Sessions and details expose `freshness: { state, observedAt, ageMs }`. A successful provider scan is `fresh`; an actual empty result removes that provider slice. Failed discovery/read keeps the last good slice `stale` for at most 60 seconds, without changing its observation time. Detail failures use the same bound and then return `state: 'unavailable'`. Dirty-cache invalidation preserves this backup. A missing provider is unavailable, and successful recovery clears staleness. Residency never extends degraded provider retention; ordinary unresolved residents carry stale observation metadata.

`signalCertainty` is `observed`, `inferred`, or `unavailable`; `signalObservedAt` gives its timestamp and `signalStale` marks a last observation. A pending ordinary tool remains work however long it runs. Explicit question/review tools and approval hooks supply waiting evidence. Exact unanswered hook approvals remain last-observed waits after the 10-second fresh window, until a resolving hook/newer recorded turn or a bounded 30-minute expiry. Other hook overlays stop merging after 10 seconds and expire after 30 seconds. Gemini text and Grok message chunks alone do not assert a completed turn.

Claude quota utilization is provider-qualified pressure, never evidence of enforcement. Session `rateLimit: { enforced: true }` carries an observed rejection (including Claude `stop_reason: 'rate_limited'`). Account-wide enforcement also requires matching provider and explicit account ID. An unanswered question/approval remains the primary status.

### Git event extraction

`gitEvents.js` extracts only high-signal repository events from raw tool commands:

- `git commit` and `git push` commands are included.
- Dry-runs are omitted.
- Push `targetRef` is inferred when a refspec is visible.
- Codex can sometimes attach completion metadata from command-end events (`success`, `exitCode`, `completedAt`).
- Parsing is best-effort and command-string based; do not treat events as an authoritative audit log.

Adapters attach `gitEvents` to active session objects. `/api/session-detail` and `POST /api/session-details` currently focus on tool history, messages, and tokens, so consumers that need git events should read them from the session list data.

Git enrichment diagnostics are exposed through `/api/perf` as `gitEnrichment`, including project counts, git command counts, elapsed time, cache hits, errors, and timeouts. Set `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1` before starting the server to disable inferred git enrichment for diagnosis without changing provider parsing.

### Token normalization

Token data may appear under any of three keys depending on the call site:

- `tokenUsage` — canonical, set by adapters on `getActiveSessions` and `getSessionDetail`.
- `tokens` — alternate alias used by some session fixtures.
- `usage` — the raw provider field, kept as a fallback when `tokenUsage` is absent.

Within any of those, the consumer reads sub-fields under multiple aliases:

- input: `input_tokens` / `inputTokens` / `prompt_tokens` / `promptTokens` / `total_input_tokens`
- output: `output_tokens` / `outputTokens` / `completion_tokens` / `completionTokens` / `total_output_tokens`
- cacheRead: `cached_input_tokens` / `cache_read_input_tokens` / `cacheReadInputTokens`
- cacheCreate: `cache_creation_input_tokens` / `cacheCreationInputTokens`
- reasoningTokens: `reasoning` / `reasoning_tokens` / `reasoning_output_tokens` / `reasoningOutputTokens` / `tokens_reasoning`

Reasoning-token semantics differ per provider, so usage objects carry a `reasoningInOutput` boolean alongside `reasoningTokens`:

- OpenCode stores `tokens_reasoning` separately from `tokens_output` (message totals sum input + output + reasoning + cache), so reasoning is extra billable spend and `estimateCost` prices it at the model's output rate.
- Codex `output_tokens` already includes `reasoning_output_tokens` (`total_tokens` = input + output), so the Codex adapter sets `reasoningInOutput: true` and cost estimation skips reasoning to avoid double pricing; the field remains available as an output breakdown.

The fallback chain exists because providers rename fields between releases (Codex switched to cumulative `token_count` events; Gemini varies between camelCase and snake_case; OpenCode stores cumulative totals in SQLite columns). Adapters absorb the variance so the UI does not need provider-specific conditionals.

Normalized browser usage and server cost carry `availability: 'observed' | 'partial' | 'unavailable'`. Input and output observations, including explicit zero, are billable coverage; a missing split is partial, and missing usage is unavailable. Numeric DTO slots may remain zero for arithmetic compatibility, so availability must accompany totals. Grok context occupancy explicitly has unavailable billable usage. Unavailable estimated cost is `usd: null` / `estimatedCost: null`, while observed zero remains zero. Mixed totals must disclose missing or partial coverage. Provider-reported cost remains an observed cost even if token coverage is unavailable.

### Model identity and pricing

Adapters pass provider model strings into the canonical registry at `../src/config/models.json`. The committed `models.generated.cjs` supplies synchronous server-side resolution; never edit it directly. Identity, pricing, context window, and mood belong in the registry, while effort/accessory rendering policy remains in `../src/presentation/shared/ModelVisualIdentity.js` keyed by `modelClass`. Probe a raw string with `npm run models:resolve -- <provider> <model>` before and after changing the registry.

## `getWatchPaths()` shape

Returns an array of:

```js
{ type: 'file' | 'directory', path: string, recursive?: boolean, filter?: string }
```

`server.js` consumes the array in `startFileWatcher()` as follows:

- `type === 'file'`: `fs.watch(path)` is attached; any `change` event triggers a debounced broadcast.
- `type === 'directory'`: `fs.watch(path, { recursive })` is attached; `filter` (if provided) requires the changed filename to end with that suffix (e.g. `.jsonl`, `.json`).
- Missing paths are silently skipped (`fs.existsSync` guard).
- Watch errors are swallowed so a single broken path does not prevent other watchers from registering.

The 2-second polling interval in `startFileWatcher` is independent of these watches and runs even if no path could be attached; the broadcast itself no-ops when no WebSocket clients are connected.

## How to add a provider

1. Create `claudeville/adapters/<name>.js` exporting a class that implements the contract above. Use the existing adapters as templates — they all follow the same module-private parser helpers + adapter class layout.
2. Register the new instance in `claudeville/adapters/index.js`. Add the require and append to the `adapters` array.
3. Confirm the registry metadata exposes the provider's detail/watch support. `server.js` derives valid detail providers from the registry.
4. Confirm `isAvailable()` returns `true` only when the provider's home directory exists. Do not throw on missing files — return `false` or an empty array.
5. Confirm `getWatchPaths()` returns valid `{ type, path, recursive?, filter? }` entries. Prefer `type: 'directory'` with a `filter` over watching every file individually.
6. Validate:
   - `node --check claudeville/adapters/<name>.js`
   - `npm run dev`
   - `curl http://localhost:4000/api/providers` — confirm the new provider appears.
   - `curl http://localhost:4000/api/sessions` — confirm normalized session objects come through.

## Per-provider mini-fixtures

These show the minimal shape each adapter's parser reads. Real files are longer; only the documented fields are required.

### Claude — `~/.claude/history.jsonl` (one line per turn)

```jsonc
// shape only — fields the adapter reads
{
  "sessionId": "8c8a3b4e-1f29-4a6b-9d31-7e0b3a2f9cda",
  "agentId": null,
  "agentType": "main",
  "model": "claude-sonnet-4-5",
  "project": "/Users/me/Documents/git/claude-ville",
  "timestamp": 1737567890123,
  "display": "Refactor the build script."
}
```

Subagent files at `~/.claude/projects/<encoded-project>/<sessionId>/subagents/agent-<id>.jsonl` follow the standard Claude message-event JSONL schema; the adapter reads `message.role`, `message.content`, and `usage` blocks from each line.

Workflow tool sub-agents use the same JSONL schema but live one level deeper, grouped per run id: `~/.claude/projects/<encoded-project>/<sessionId>/subagents/workflows/<wfRunId>/agent-<id>.jsonl`, each with a `agent-<id>.meta.json` sidecar (`{"agentType":"workflow-subagent"}`). The per-agent TUI label/phase shown in the Workflow runner is not persisted; only the workflow name is recoverable, from the run script at `<sessionId>/workflows/scripts/<workflowName>-<wfRunId>.js`. The adapter tags these sessions `agentType: 'workflow-subagent'` with `workflowId` / `workflowName`, and keeps a quiet orchestrator parent "active" off its (possibly nested) children's mtimes.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (one line per record)

```jsonc
// shape only — fields the adapter reads
{"type":"session_meta","payload":{"id":"thr_01J9X...","cwd":"/Users/me/code/proj","model":"gpt-5","agent_nickname":"plan-bot","agent_role":"main"}}
{"type":"turn_context","payload":{"model":"gpt-5","effort":"medium"}}
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12000,"output_tokens":340,"cached_input_tokens":8000},"last_token_usage":{"total_tokens":420},"model_context_window":200000}}}
```

Renamed Codex sessions are read from `~/.codex/session_index.jsonl`:

```jsonc
{"id":"thr_01J9X...","thread_name":"plan-bot","updated_at":"2026-05-19T11:30:51.337Z"}
```

The adapter reads `session_meta` from the first metadata lines, prefers `session_index.jsonl` names when available, and reads tools/messages/usage from the last 50–500 lines.

### Gemini — `~/.gemini/tmp/<projectHash>/chats/session-*.json` (one JSON object per file)

```jsonc
// shape only — fields the adapter reads
{
  "sessionId": "8b3e1c92-...",
  "projectHash": "1f2c…",
  "messages": [
    { "type": "user", "content": "hello" },
    {
      "type": "gemini",
      "model": "gemini-2.5-flash",
      "content": "hi!",
      "toolCalls": [{ "name": "run_shell_command", "args": { "command": "ls" } }],
      "tokens": { "input": 200, "output": 12 },
      "timestamp": "2025-01-22T10:30:00.000Z"
    },
    { "type": "info", "content": "context loaded" }
  ]
}
```

`projectHash` is `sha256(cwd)`. The adapter attempts to reverse-map known candidate paths back to a real `project` string.

### Kimi legacy — `~/.kimi/sessions/<project_hash>/<session_uuid>/wire.jsonl`

```jsonc
// shape only — fields the adapter reads
{"timestamp":1737567890,"message":{"type":"ToolCall","payload":{"function":{"name":"Shell","arguments":"{\"command\":\"ls\"}"}}}}
{"timestamp":1737567891,"message":{"type":"ContentPart","payload":{"type":"text","text":"Done."}}}
{"timestamp":1737567892,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":100,"output":20,"input_cache_read":50,"input_cache_creation":0},"context_tokens":170,"max_context_tokens":262144}}}
```

The adapter resolves project hashes from `~/.kimi/kimi.json` and common local work directories, then reads `state.json` for a user-facing title when present.

### Kimi Code — `~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl`

```jsonc
// shape only — fields the adapter reads
{"type":"context.append_loop_event","time":1737567890000,"event":{"type":"tool.call","name":"Bash","toolCallId":"call_123","args":{"command":"ls"}}}
{"type":"context.append_loop_event","time":1737567890500,"event":{"type":"tool.result","toolCallId":"call_123","result":{"output":"ok"}}}
{"type":"context.append_loop_event","time":1737567891000,"event":{"type":"content.part","part":{"type":"text","text":"Done."}}}
{"type":"context.append_message","time":1737567891500,"message":{"role":"user","content":[{"type":"text","text":"Continue."}]}}
{"type":"config.update","time":1737567891750,"cwd":"/repo/path","modelAlias":"kimi-code/kimi-for-coding","thinkingLevel":"high"}
{"type":"usage.record","time":1737567892000,"model":"kimi-code/kimi-for-coding","usage":{"inputOther":100,"output":20,"inputCacheRead":50,"inputCacheCreation":0}}
```

Kimi Code also writes `~/.kimi-code/session_index.jsonl` entries shaped like `{ "sessionId", "sessionDir", "workDir" }`. The adapter uses both the persisted id and root-validated `sessionDir`/basename keys so project mapping survives if Kimi's stored id differs from the folder name, and falls back to `state.json` top-level `workDir`, then agent `homedir`, then `config.update.cwd`, when the index is missing. Current Kimi Code builds persist the project root as `workDir`; on those builds agent `homedir` points inside the session store, so it only remains a last-resort fallback for older layouts. Detail responses use the same project resolution. The adapter scans every `agents/<agent>/wire.jsonl`: `main` remains a primary session, while numbered or named agent dirs become `sub-agent` sessions. `config.update.modelAlias` is used as an early model/context signal before `usage.record` lines exist, and usage token fields accept both camelCase and snake_case spellings. `tool.result.result.isError` / `is_error` and exit fields are paired back to shell tool calls by `toolCallId` / `uuid` / related call-id aliases, so git events and tool-history rows can distinguish successful and failed pushes/commits. Child rows use persisted `state.json` `agents.<agent>.parentAgentId` metadata for nested child-to-child lineage when that parent row is active, and otherwise fall back to the main Kimi session. If child wires are active while `main` is stale or absent, the parent stays visible with child-derived activity; parent detail lookups also fall back to the newest child wire when no `main` wire exists, so UI lineage is not orphaned.

### Grok — `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`

```jsonc
// summary.json — fields the adapter reads
{
  "info": { "id": "019f46ac-...", "cwd": "/Users/me/code/proj" },
  "session_summary": "Implement the feature",
  "generated_title": "Implement the feature",
  "current_model_id": "grok-4.5",
  "agent_name": "grok-build-plan",
  "reasoning_effort": "high",
  "created_at": "2026-07-09T11:38:44.476Z",
  "updated_at": "2026-07-09T11:42:08.151Z",
  "last_active_at": "2026-07-09T11:42:08.151Z"
}

// updates.jsonl — ACP session update stream (one line per event)
{"timestamp":1783597308,"method":"session/update","params":{"sessionId":"019f46ac-...","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"run_terminal_command","rawInput":{"command":"ls"}},"_meta":{"totalTokens":12000}}}
{"timestamp":1783597309,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done."}}}}

// chat_history.jsonl — raw model messages
{"type":"user","content":[{"type":"text","text":"Hello"}]}
{"type":"assistant","tool_calls":[{"id":"call-1","name":"run_terminal_command","arguments":"{\"command\":\"ls\"}"}],"model_id":"grok-4.5","reasoning_effort":"high"}
{"type":"tool_result","tool_call_id":"call-1","content":"..."}
```

The adapter discovers sessions under `~/.grok/sessions/`, uses `summary.json` for model/title/activity, prefers `updates.jsonl` for live tools and message chunks, and falls back to `chat_history.jsonl`. Session ids are prefixed `grok-`. `totalTokens` from ACP update metadata is mapped to `tokenUsage.contextWindow` when present (Grok does not yet expose a full input/output split on disk). Optional `~/.grok/active_sessions.json` is watched but not required for discovery.

### OpenCode — `~/.local/share/opencode/opencode.db` (SQLite)

```jsonc
// session row shape only — fields the adapter reads
{
  "id": "ses_123",
  "parent_id": null,
  "directory": "/Users/me/code/proj",
  "title": "Review data",
  "agent": "build",
  "model": "{\"id\":\"deepseek-v4-pro\",\"providerID\":\"deepseek\"}",
  "tokens_input": 1200,
  "tokens_output": 300,
  "tokens_cache_read": 40000,
  "tokens_cache_write": 0,
  "time_updated": 1737567890123
}

// part.data examples
{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"git commit -m init"},"metadata":{"exit":0}}}
{"type":"text","text":"Done.","time":{"start":1737567890123,"end":1737567891123}}
```

OpenCode support is SQLite read-only. It uses `node:sqlite` with read-only mode when available and falls back to `sqlite3 -readonly` when the CLI is present. It never mutates provider config files and does not issue writes, migrations, checkpoints, or vacuum commands against OpenCode's database. DeepSeek-backed sessions are represented as `provider: 'opencode'` with `model: 'deepseek/<model-id>'`, which lets the UI keep the source CLI distinct from the model family.
