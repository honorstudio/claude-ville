# ClaudeVille signal layer review — 2026-09-01 (read-only)

Scope: `claudeville/server.js`, `adapters/**`, `services/**`, `src/{domain,application,infrastructure,config}`, docs, `scripts/tests`. Baseline: `main` @ `e7737d5` (v0.37.0), clean tree, Node v24.16.0 local, `engines.node >=18`. Live server at :4000 was queried (GET only). No repo or `~/.*` file was modified.

Evidence policy: every claim below cites `file:line` I read myself, or a live payload shape. Items that depended on sub-audits that did not return are marked **UNVERIFIED**. Hook/OTel/statusline field names are **not asserted** — see §2.

---

## A. Verdict

**Truthful but thin.** After v0.36/v0.37 the layer no longer lies (turn state is transcript-derived, `LIVE` is earned, cost is labelled "est." in the TopBar), and the seven adapters are honest about what they cannot tell (`turnState: 'unknown'`). But the layer surfaces roughly a third of what the two dominant providers already write to disk:

- Claude Code transcripts on this machine carry `cost-state` records (`totalCostUSD`, `modelUsage`, `hasUnknownModelCost`, `totalLinesAdded/Removed`, `totalAPIDuration`, `totalToolDuration`), `system/turn_duration` (`durationMs`), `stop_hook_summary` (`hookCount`, `hookErrors`, `preventedContinuation`), per-message `effort`, `gitBranch`, `last-prompt`, `ai-title`/`custom-title`, `pendingBackgroundAgentCount`, `queue-operation` — **none of which `claude.js` references** (rg for those keys in `claude.js` returns only `thinking`/`isSidechain`: `claude.js:268,309,1171,1240,1338`).
- Codex rollouts now carry `event_msg/item_completed` with `FileChange{changes}` and `CommandExecution{exit_code,duration,started_at_ms,completed_at_ms,stdout,stderr}` and `turn_context{approval_policy,sandbox_policy,permission_profile,workspace_roots}` — **`codex.js` has zero references to `item_completed`/`FileChange`/`started_at_ms`** (rg empty).
- Three of seven providers (Kimi, OpenCode, Gemini) emit no turn state at all; OMP hand-rolls one that bypasses `classifyPendingTool`.
- Cost has no provenance: unknown models are silently priced at a family default (§4), and the session payload's `estimatedCost` is a bare number.

Two genuine truth defects remain (§C1, §C2): long-running Claude main sessions are relabelled `team-member`, and `agentType` leaks raw `subagent_type` strings (`general-purpose`) outside the documented enum.

---

## 1. Signal coverage per provider

### 1.1 Claude Code (`adapters/claude.js`)

Extracted (verified): `message.role/content/stop_reason/usage(input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens)` (`claude.js:660-672`), `model`, `tool_use{id,name,input}` / `tool_result{tool_use_id}` (`claude.js:1341-1347,1386-1392`), `thinking` blocks as dialogue (`:268,1240`), `permissionMode` marker (`:1427`), `isSidechain` skip (`:1338`), `Agent` tool launches → `subagent_type` (`:677-686`), `SendMessage` edges, history.jsonl `sessionId/agentId/agentType/model/project/timestamp/display` (`:1752-1793`), teams/tasks JSON (`/api/teams`, `/api/tasks` live), workflow subagent meta sidecars.

Turn descriptor (`turnStateFromEntries`, `claude.js:1337-1402`): resolves `tool_use.id` against every `tool_result.tool_use_id` in the tail window; a non-tool-result user entry after the last assistant entry forces `working`; earliest unanswered `tool_use` in the last ≤9 assistant entries becomes `pendingTool/pendingSince`; `turnEnded = !pendingTool && stop_reason === 'end_turn'`. Then `deriveTurnState` (`turnState.js:126-181`) and `classifyPendingTool` (`:95-111`) apply: ASK/PLAN tools blocked instantly, INSTANT tools blocked after 15 s (`:64`), everything else after 240 s (`:68`), `bypassPermissions`/`acceptEdits` suppress (`:103-107`).

**Known ambiguity (by design, documented in `turnState.js:9-10,65-68`):** `tool_pending` cannot distinguish "executing" from "permission prompt"; the classifier is dwell-time + tool-name heuristics. On the live payload right now a `WebFetch` sub-agent has been pending 36 s with `waitReason: null` — correct only because WebFetch is not in `INSTANT_TOOLS`; a Bash `npm test` that hangs for 5 minutes will be reported as "needs approval" at 240 s. Nothing on disk records the prompt itself; only a push signal (§2) fixes this.

Present in the transcript, NOT extracted (keys observed on this machine's most recent three transcripts, keys only):
| Record / key | Operator value | Rank |
|---|---|---|
| `type:"cost-state"` → `totalCostUSD`, `modelUsage`, `hasUnknownModelCost`, `totalLinesAdded`, `totalLinesRemoved`, `totalAPIDuration`, `totalToolDuration`, `totalDuration`, `startTime` | CLI's own authoritative cost + diff size; replaces the static-pricing estimate for Claude and flags unknown models | **1** |
| `type:"system", subtype:"turn_duration"` → `durationMs` | exact elapsed turn duration | 2 |
| `type:"last-prompt"` → `lastPrompt`; `type:"ai-title"/"custom-title"` | "what did the user ask" / session title | 3 |
| `type:"system", subtype:"stop_hook_summary"` → `hookCount`, `hookErrors`, `preventedContinuation` | hook failures are an error class today invisible | 4 |
| `message.model` per assistant entry (only latest kept, `:660`) and `effort` per entry | model switches / effort changes mid-session | 5 |
| `gitBranch` (on every entry) | branch the agent is on, no git subprocess needed | 6 |
| `pendingBackgroundAgentCount`, `queue-operation` | fan-out size, queued prompts | 7 |
| `usage.service_tier`, `speed`, `iterations`, `stop_details` | tier / throttling telemetry | 8 |
| `TodoWrite` inputs (tool is named in `turnState.js:53` but its `todos` payload is not projected; `activeForm`/`subject` are read only for dialogue at `claude.js:1229-1237`) | current plan/todo list | 3 (tied) |

`contextWindow` is recomputed as `input + cacheRead + cacheCreate` of the **latest** assistant entry (`claude.js:669`) — correct for occupancy, but there is no `contextWindowMax` for Claude (live payload: Claude has `contextWindow` only; Codex has both).

### 1.2 Codex (`adapters/codex.js`)

Extracted (verified): `session_meta.payload{id,cwd,model,...}`, `turn_context{model,effort|reasoning_effort,collaboration_mode.settings.*}` (`codex.js:179-194`), `function_call`/`custom_tool_call` + `_output` paired by `call_id` (`:645-650,676-680`), `update_plan` (`:534`), `reasoning` summaries/text as dialogue (`:593-617`), `token_count.info{total_token_usage,last_token_usage,model_context_window}` → `contextWindow`/`contextWindowMax`/`reasoningInOutput:true` (`:794-863`), `exec_command_end` exit codes (`:906`), `task_started`/`task_complete`/`turn_complete` (`:660-669`), `session_index.jsonl` `thread_name` (`:118-135`).

Turn descriptor (`deriveCodexTurnState`, `codex.js:643-690`) runs over the 50-line summary window (`SUMMARY_SCAN_LINES`, `:44`). Two ambiguities verified:
- **`turn_aborted` is not handled** (rg: no match). An Esc-aborted call has no `_output`, so `pendingTool` stays set and, because `deriveTurnState` checks `pendingTool` before `turnEnded` (`turnState.js:146,163`), it outranks a later `task_complete`; after 240 s it becomes a false "needs you".
- **`unknown` mid-turn**: when neither boundary event is in the last 50 lines and no call is pending, the adapter returns `known:false` (`:683`). Live right now: a `gpt-5.6-sol` session 30 s old reports `turnState: 'unknown'` and falls back to mtime timing (`AgentStatus.js:26-29`), so it will flip to `waiting` at 30 s and `idle` at 120 s while the model is still generating.

Present, NOT extracted: `event_msg/item_completed` (`item.type ∈ {Reasoning, CommandExecution, AgentMessage, FileChange}`, `status`, `exit_code`, `duration`, `started_at_ms`, `completed_at_ms`, `changes`, `cwd`, `parsed_cmd`) — **exact tool timing, exit codes and the working set**; `turn_context.approval_policy/sandbox_policy/permission_profile/workspace_roots` (the Codex analogue of `permissionMode`, which would let `classifyPendingTool` suppress prompts under full-auto exactly as it does for `bypassPermissions`); `context_compacted`; `web_search_call`; `session_meta.git`, `cli_version`. Reasoning effort is extracted; "review mode" has no on-disk marker I could find (UNVERIFIED).

### 1.3 Gemini (`adapters/gemini.js`)
Reads whole `session-*.json` (`gemini.js:151-152`, cached ≤32 MiB `:36`), after an mtime gate (`:553-558`). No turn state (falls to `index.js:164`). Only `type:'gemini'` message fields are read. UNVERIFIED beyond this (no Gemini corpus on this machine; provider reports `unavailable`).

### 1.4 Grok (`adapters/grok.js`)
`summary.json` (`info.id/cwd`, titles, `current_model_id`, `agent_name`, `reasoning_effort`, timestamps), `updates.jsonl` ACP `tool_call`/`agent_message_chunk`, `chat_history.jsonl` fallback (bounded tails, `:394,463,496`). `totalTokens` → `contextWindow` only. No turn state.

### 1.5 Kimi / OpenCode / OMP (sub-audit returned; spot-checked)
- **Kimi** (`kimi.js`): rich extraction (tool call/result paired by `callId` `:1057-1075`, exit/isError `:1088-1105`, usage `:1163-1173`, `config.update.cwd/modelAlias` `:998-1001,891`), **but `thinkingLevel` is never read (0 occurrences), legacy `ToolResult`/`TurnBegin` documented at `:11-13` and never handled, and no `turnState` emitted** although the pairing needed for the descriptor already exists.
- **OpenCode** (`opencode.js`): `node:sqlite` read-only (`:91,127`) with `sqlite3` CLI fallback (`:102`); projects `$.state.status` incl. `'running'` (`:343`) yet never emits `turnState`; `tokens_reasoning`/`cost` columns read (`:251-254`); `contextWindowMax` is a hardcoded 3-model table returning 0 otherwise (`:258-264`); `s.version` selected and unused (`:55,566`).
- **OMP** (`omp.js`): inline turn state at `:325-327` (`tool_pending` / `awaiting_input` / `unknown`, never `working`, never `waitReason`, bypasses `classifyPendingTool`); no context window, no exit codes, no `gitEvents` attachment.

### 1.6 Cross-provider gaps ranked by operator value
1. **Authoritative cost + lines changed** (Claude `cost-state`; OpenCode `cost` column already read at `opencode.js:254` but not surfaced as provenance).
2. **Working set / file being edited** (Codex `FileChange.changes`; Claude `Edit/Write.file_path` is projected only into `lastToolInput` 60-char string — no per-session set; `CLAUDE_TOOL_INPUT_FIELDS` `claude.js:63-89` has `file_path` but no aggregation).
3. **Tool duration / exit code / test pass-fail** (Codex `item_completed`; Claude `toolUseResult` — 266 occurrences in one transcript, unread; `Bash` results with non-zero exit are not surfaced for Claude at all — only Codex/Kimi/OpenCode carry `toolExitCode`, README §toolHistory).
4. **Elapsed turn duration / time-in-state**: no `workingSince`/`statusSince` anywhere in `src/` or adapters (rg empty except `MarkGovernor` dwell timers). `awaitingSince`/`pendingSince` exist; a `turnStartedAt` (Claude: last non-tool-result user entry timestamp; Codex: `task_started`) is one field away.
5. **Permission prompt content** — not on disk for any provider; §2.
6. **User's last prompt / current plan** (Claude `last-prompt`, `TodoWrite.todos`; Codex `update_plan` is read at `codex.js:534` only for dialogue).
7. **Context occupancy %**: Codex has max; Claude/Kimi-Code/OMP/Grok lack a max, so "% of window" cannot be shown; Claude could use `model` → known window table (static, like pricing).
8. **Model switches / effort changes** (Claude per-entry `model`/`effort`; only latest kept).
9. **Error classes**: only failed git events (`StatusResolver.js:34-49`) and a disabled lastMessage regex (`:24`); API errors / hook errors / rate-limit entries not parsed.
10. **MCP calls / web fetches**: `mcp__*` names pass through as tool names; no classification (0 hits for `mcp` in kimi/opencode/omp/gitEvents; `ToolIdentity.js` UNVERIFIED).
11. **PR/issue URLs**: zero `gh` support — `GIT_EVENT_TYPES = commit|push|pull|fetch` (`gitEvents.js:7`), parser requires literal `git` token (`:1202`).
12. **Subagent fan-out tree**: `parentSessionId` exists; `Agent` launches are hashed (`claude.js:679-686`) but the tree is not emitted as a structure (`pendingBackgroundAgentCount` unread).

---

## 2. Ingestion tech: push endpoint

### Current
File tail + `fs.watch` + 2 s scheduler: `server.js:1276` `BROADCAST_POLL_INTERVAL = 2000`, `:1277` debounce 100 ms, `:87` 30 s reconciliation, `:80-85` recursive-watch fallback scanner with caps, `:2329-2352` Linux watcher sampling. Adapter list cache 2 s (`index.js:51`). Latency floor for a state change is therefore ~100 ms–2 s plus tail parse, and turn state is *inferred* (§1.1).

### Proposal: optional push ingestion, file adapters remain baseline
What the operator gets: sub-second, exact `tool start/stop`, `stop`, `subagent stop`, `session start/end`, `user prompt submitted`, and — the one thing files cannot give — **the pending permission prompt** (which tool, which command/path) via a pre-tool hook, plus `Notification`-class events (Claude Code emits a notification when it is waiting for permission/input; **verify the exact payload field names against current Claude Code hooks docs before coding** — I did not get a docs verification back and will not assert `tool_name`/`tool_input`/`session_id`/`hook_event_name`/`permission_mode`/`notification_type`/`stop_hook_active` as exact; those are my recollection only).

Concrete work:
1. **Route** `POST /api/ingest/hook` in `server.js` route table (`:2588-2598`), body via existing `readJsonBody` (256 KiB cap, `:52,187-204`), guarded by existing `validateLocalRequest` (`:106-125`, Host allowlist + Origin check — note hooks run as local shell commands with **no Origin header**, which `validateLocalRequest` already accepts when `requireOrigin` is false; keep `requireOrigin:false` for this route and rely on loopback bind `:40`). Add an optional shared secret env (`CLAUDEVILLE_INGEST_TOKEN`) checked as a header; document it as opt-in.
2. **Adapter** `adapters/hooks.js` registered as a *non-discovery overlay*, not a provider: `class HookOverlay { ingest(event: {provider, sessionId, cwd, ts, kind, tool, input, decision?}): void; overlayFor(sessionId): {turnState, pendingTool, pendingSince, waitReason, promptDetail, lastHookAt} | null; prune(now): void }`. Merge point: `index.js:getAllSessions` after `normalizeSession` (`:342`) — if an overlay is fresher than the transcript-derived `pendingSince` and younger than e.g. 10 s, it wins; else transcript state stands. Add session fields: `signalSource: 'transcript' | 'hook'`, `promptDetail: string | null` (truncated 200 chars), `hookAgeMs`.
3. **Dirty wiring**: ingestion calls `markProviderDataDirty({provider, kind:'transcript', sessionId})` (`server.js:1310`) + `debouncedBroadcast()` (`:1660`) so the existing delta path (`:1478-1513`) ships it.
4. **OTLP/HTTP receiver** (`POST /api/ingest/otlp/v1/logs` + `/v1/metrics`, JSON encoding only): lower value than hooks for turn state; high value for **per-request model/tokens/cost** and **tool decision (allow/deny)** events. Do this second, and only after confirming the current metric/event names and JSON-over-HTTP support in the Claude Code monitoring docs (UNVERIFIED here). Same for Codex notify / Gemini telemetry — verify formats before committing.
5. **Config docs**: `docs/design-decisions.md` new entry ("Push ingestion is optional and loopback-only"), `claudeville/CLAUDE.md` API list, `adapters/README.md` overlay contract; sample `settings.json` hook stanza using `curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook` (fire-and-forget so a down dashboard never blocks the CLI).
6. **Tests** (`scripts/tests/hook-overlay.test.mjs`): overlay precedence vs transcript state, staleness expiry, size caps, unknown provider rejected, prompt text truncated; extend `scripts/smoke/server-security.mjs` for the new route (Host/Origin/size/method).

Acceptance: with hooks configured, a permission prompt appears in `/api/sessions` as `waitReason:'approval'` + `promptDetail` within 500 ms; with hooks absent, payload is byte-identical to today except `signalSource:'transcript'`.

Risks: (a) hook misconfiguration can slow the CLI — mitigate with `--max-time 1` and docs; (b) a second truth source can disagree with the transcript — overlay must expire fast and never *suppress* a transcript-derived `awaiting_input`; (c) this is the first write-ish surface; keep it opt-in, loopback, capped. Size: **M** (route + overlay + tests ≈ 300 lines), OTLP **L**.

---

## 3. Provider landscape (Sept 2026)

Present on this machine: `~/.claude`, `~/.codex`, `~/.grok`, `~/.kimi`, `~/.kimi-code`, `~/.omp`. Absent: `~/.cursor`, `~/.copilot`, `~/.amp`, `~/.pi`, `~/.factory`, `~/.qwen`, `~/.aider*`, `~/.cline`, `~/.goose`, `~/.vibe`; no `cursor-agent/amp/pi/droid/qwen/aider/cline/goose/copilot` binaries; only `gh` is installed. So I could not inspect any candidate's real store; confidence below is from format familiarity, not files.

| Candidate | Local store I am reasonably confident exists | Effort vs contract (`docs/agent-provider-addition.md` Track A) |
|---|---|---|
| Qwen Code | Gemini-CLI fork; `~/.qwen/tmp/<hash>/chats/*.json` — same shape as Gemini | **S**: parametrise `gemini.js` home dir |
| Goose | SQLite session store under `~/.local/share/goose/` | **M**: reuse `opencode.js` node:sqlite pattern |
| Aider | `.aider.chat.history.md` per repo (markdown, not JSON) | **M**, low signal (no tokens per turn) |
| Cursor CLI / agent | store format unknown to me | UNSURE |
| GitHub Copilot CLI | unknown | UNSURE |
| Amp, Pi, Factory Droid, Cline/Roo CLI, Mistral Vibe, Warp, Junie, Devin CLI | unknown / hosted-first | UNSURE |

Recommendation: do not add providers blind; the runbook step 3 ("normalize at adapter boundary") plus the 2 s cache means each adapter is ~700 lines. Add a fixture-driven `scripts/adapters/fixtures/<provider>/` first (§6).

---

## 4. Cost / pricing

- Resolution: `sessionPresentation.js:109-127` — provider/model family → rate list matched by substring, **else `pricing[family].default`**. No zero pricing, but also **no signal that a default was used**. `estimateCost` (`:129-141`) returns a number; `normalizeSession` decorates `estimatedCost` with no `costSource`/`isEstimate`/`rateMatched` field (`index.js:139-172`, live payload shape confirms).
- Live models: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-haiku-4-5-20251001`, `gpt-5.6-sol`. `model-pricing.json` rates: `opus|sonnet|haiku` (`:11-30`), `gpt-5.6-sol` (`:42`). So **`claude-fable-*` silently gets the Claude `default` = sonnet-class 3/15** (`:3-8`); `claude-opus-5` matches the `opus` rate (15/75) whether or not that is Opus 5's real price. Codex `gpt-5.6-sol` matches explicitly.
- Labelling: TopBar says "estimated API pricing"/"est." (`TopBar.js:822,862`); ActivityPanel/Dashboard call `TokenUsage.estimateCost` (`ActivityPanel.js:860,1380`, `DashboardRenderer.js:984`) — per-agent figures are not labelled at the point of display (UNVERIFIED for every surface).
- Two parallel pricing implementations (server `sessionPresentation.js`, browser `TokenUsage.js:108-215`) kept equal by `r2-02.pricing.test.mjs:36`; the test at `:24` asserts *fixture* models hit a concrete rate — it does not assert that models seen in real sessions do.
- Authoritative alternatives unused: Claude `cost-state.totalCostUSD`/`modelUsage`/`hasUnknownModelCost` (§1.1), OpenCode `session.cost` (read as `reportedCost`, `opencode.js:254`, not surfaced).

---

## 5. Server tech

- **Node floor**: `>=18` (`package.json:30`) but the code already uses `node:sqlite` optionally (`opencode.js:91`, Node ≥22.5) with CLI fallback, `readBigUInt64BE`, `structuredClone`-free JSON patching. Nothing else in the audited files needs 22+; raising the floor to 20 would let `fs.watch({recursive})` on Linux replace the fallback scanner (`server.js:1761-1935`, 175 lines + 4 constants) — but the fallback also covers coalesced/missing events, so keep it. `fetch`/`WebSocket` client are unused (server uses `https.request` in `usageQuota.js:282-304`, no outbound WS). `fs.promises.glob`: not needed.
- **gzip vs brotli**: gzip only (`server.js:141-165`), strong SHA-256 ETag + `If-None-Match` (`:240-283,727-746`). Brotli would save bytes on the 141-module boot but costs CPU on a loopback link; not worth it. Fine as is.
- **2 s poll**: scheduler `:2571-2580`, dirty-driven, no-op without clients; adapter TTL matched at `index.js:49-51`. OK.
- **Heap bounds**: tail cache 32 MiB (`shared.js:6-7`), Gemini parsed cache 32 MiB, detail cache 256 entries (`index.js:53`), ETag cache 16 MiB (`server.js:236-237`), residency 24 (`sessionResidency.js:20`). No `--max-old-space-size`; `/api/perf` reports rss/heap (`:2363-2368`). Live `tailCache.parsed.bytesRead` = 94 GB cumulative — sustained tail re-reading is still the dominant I/O.
- **Cold-scan hazards remaining** (stat-and-cutoff *before* open/parse?):
  - Claude: history tail 1000 lines (`claude.js:1752`), orphan files `statSync` then mtime gate before `getSubAgentDetail` (`:1985-1996`), subagent dirs stat-gated (`:1659-1671`). ✔
  - Codex: identity cache keyed by mtime (`codex.js:341-355`), fixed windows 50/5000 (`:44-46`); discovery in `scanRecentRollouts` (`:1171`) — **UNVERIFIED** whether every candidate is statted before `readJsonLines`.
  - Gemini: mtime gate at `:558` before whole-file `readFileSync` (`:151`). ✔ (whole-file read, size-unbounded, but only for active files)
  - **Grok: ✘** — `getSummary()` reads+parses **every** `summary.json` under `~/.grok/sessions` *before* the age test (`grok.js:704-710`, `readJsonFile` `:93-99`). Same shape as the v0.37 OMP bug, one file per historical session.
  - **Kimi Code: ✘ partial** — full 3-level `readdirSync` walk of every historical session each pass (`kimi.js:1260-1291`), gate at `:1295` is after stat but the walk scales with total history; legacy `resolveProjectPath` rebuilds an uncached 10-dir probe per project hash before the gate (`:1523→502-531`); active wire read 3× per session (`:1380-1411`).
  - **OpenCode: ✘ partial** — session query is cutoff-bounded (`opencode.js:66-69`) but the parts query has no time predicate, only a window-function LIMIT (`:360-374`).
  - **OMP: ✔ list path** (`omp.js:475-496`), **✘ detail path** — index miss re-parses every transcript with no gate (`:536-542`).
  - `index.js:211` sync `execFileSync('git')` (ledger said `:147`, actual `:210-216`) once per 5-min TTL (`:57,276`); `gitEvents.js:1446/1453` `currentBranch()` → sync `execFileSync` (`:1806-1831`) on a cache miss inside `createGitEvent`, on the session-list hot path, even with the async worker enabled.

---

## 6. Tests

Well covered (unit, `scripts/tests`): `turn-state` (14 cases incl. thresholds and permission modes), `status-resolver` (10), `session-residency` (7), `spend-ledger` (8), `usage-quota` body bounds (3), `r2-02.pricing` parity (2), `r2-02.adapter-parity` (shared optional fields), `w1-f.provider-health`, `omp-adapter` discovery, `claude-orphan-cache`, `r2-12.git-worker` (4), `r1-18.pipeline-replay` (full WS delta+snapshot replay on a real multi-provider fixture).

Load-bearing and **untested or thinly tested**:
- WebSocket framing: server parser `server.js:890-960` is exercised only by smokes (`server-security.mjs:298` one unmasked frame; `r1-18.e2e-replay.mjs` happy path). No unit test for 126/127 length paths, control-frame >125, reserved bits, fragmented (`!isFinal`) rejection, or the `-1009` size path.
- `turnStateFromEntries` (`claude.js:1337`) and `deriveCodexTurnState` (`codex.js:643`) — the *descriptor builders* — have no direct fixtures; only `deriveTurnState` is unit-tested. The `turn_aborted` and "boundary scrolled out of 50 lines" cases (§1.2) would both be caught by a 20-line fixture.
- Grok, Gemini, Kimi legacy: no fixture tests at all (`validate-fixtures.cjs` covers Kimi Code, Codex, OpenCode).
- `sessionPresentation.ratesForModel` against **live** model strings (only fixture models asserted).
- `normalizeSession` agentType enum (§C2) — nothing asserts the documented set.
- Residency: covered; but `sessionResidency.merge` + `collectSessionSnapshot` generation logic (`server.js:1410-1447`) is untested.

---

## 7. Architecture / drift

- **Layering violation (proven):** `src/application/AgentManager.js:7-13` imports `createVerifiedOutcome…VERIFIED_OUTCOME_EVENT` from `src/presentation/character-mode/ChronicleEvents.js`. `docs/design-decisions.md:136-140` states the rule for the domain layer and says shared logic "belongs under `src/domain/` or another lower layer, not under `src/presentation/`". Application → presentation is the same inversion.
- **Docs vs code drift (proven):** `claudeville/CLAUDE.md:28,44` and `README.md:205` say the registry caches lists "for 5 s"; actual `SESSION_LIST_CACHE_TTL_MS = 2000` (`index.js:51`, comment says aligned to the 2 s poll). Detail TTL is 5 s (`:52`). `claudeville/CLAUDE.md:28`'s invariant ("never lower client poll under server cache TTL/2") is now stated against the wrong number.
- `agents/plans/open-followups.md` cites `claudeville/adapters/index.js:147` for the sync git call; actual is `:210-216`.
- `adapters/README.md` documents `agentType` as a 5-value enum; live payload emits `general-purpose` (§C2).
- Duplicated constants by design and documented (`StatusResolver.js:3-11` mirrors `turnState.js` ids; `TokenUsage.js` mirrors `sessionPresentation.js` pricing, parity-tested). `ASK_TOOLS` is duplicated a third time in `StatusResolver.js:15-19`.
- Endpoints: all 9 handlers (`server.js:2588-2598`) are documented in `claudeville/CLAUDE.md`; `/api/tasks` and `/api/perf` have no frontend consumer (rg `'/api/` in `src`), which is fine for diagnostics but `/api/tasks` is effectively dead UI-wise.

---

## B. Candidate improvements (ranked impact × feasibility)

1. **Claude `cost-state` + `turn_duration` + `last-prompt` projection** — S. Operator sees CLI-authoritative `$`, lines +/−, exact turn duration, and the prompt being answered. Work: in the tail projection that already walks entries (`claude.js:660-690`), capture `type==='cost-state'` (`totalCostUSD`, `totalLinesAdded/Removed`, `hasUnknownModelCost`), `system/turn_duration.durationMs`, `last-prompt.lastPrompt` (truncate 200). Session fields: `reportedCost`, `costSource:'provider'|'estimate'`, `linesAdded`, `linesRemoved`, `lastTurnDurationMs`, `lastPrompt`. `sessionPresentation.js` uses `reportedCost` when present. Tests: fixture with those records; `r2-02.pricing` asserts `costSource`. Acceptance: `/api/sessions` for a Claude session shows `costSource:'provider'` and `$` equal to the transcript figure. Risk: record shapes are undocumented and may change → guard with `typeof` checks and fall back to estimate.
2. **Cost provenance for every provider** — S. Add `costSource` and `pricingRate` (`'opus'|'default'…`) to `estimateCost` output (`sessionPresentation.js:129-141`), label per-agent figures "est." where `TokenUsage.estimateCost` is rendered. Add a unit test that every model string in `scripts/adapters/fixtures` **and** a small list of current live names (`claude-fable-5-1`, `claude-opus-5`, `gpt-5.6-sol`) resolves to a non-default rate or is explicitly listed as default. Risk: none.
3. **Codex `item_completed` ingestion** — M. Operator sees exact tool durations, exit codes (test pass/fail), and a per-session working set (`FileChange.changes` paths). Work: in `deriveCodexTurnState`/summary walk, handle `event_msg.item_completed` → `toolHistory` rows get `durationMs`, `toolExitCode`; new session field `workingSet: string[]` (last 8 changed paths). Also read `turn_context.approval_policy` → map full-auto to `permissionMode:'bypassPermissions'` so `classifyPendingTool` stops false-flagging. Tests: rollout fixture with `item_completed`. Acceptance: a Codex session with an `exit_code: 1` command shows the warning chip already used for Kimi/OpenCode. Risk: Codex schema churn; keep fields optional.
4. **Push ingestion `POST /api/ingest/hook`** — M (see §2). The only path to exact permission-prompt content.
5. **`turnStartedAt` / time-in-state** — S. Claude: timestamp of the last non-tool-result user entry (already located at `claude.js:1359-1370`); Codex: `task_started` timestamp (`:660`). Emit `turnStartedAt`; client derives "working for 4m12s". Tests: extend `turn-state` descriptor tests. Risk: none.
6. **Turn state for Kimi Code / OpenCode / OMP via `turnState.js`** — S each. Kimi: pairing exists (`kimi.js:1057-1075`); OpenCode: `$.state.status==='running'` (`opencode.js:343`); OMP: replace `:325-327` with `deriveTurnState`. Acceptance: those providers stop reporting `unknown` and gain `waitReason`. Risk: false "needs you" for slow tools on providers that never prompt — pass a provider-level "never prompts" flag through `permissionMode:'bypassPermissions'` where true.
7. **Fix Claude `team-member` mislabel + agentType enum** — S (§C1, C2).
8. **Codex `turn_aborted` + boundary carry-over** — S. Handle `turn_aborted` as clearing `pendingTool`; remember the last boundary seen per file in the existing identity cache (`codex.js:341-355`) so a long turn stays `working` instead of `unknown`. Test: fixture with 60 `token_count` lines after `task_started`.
9. **Grok stat-first discovery** — S. Move `statSync(summaryPath).mtimeMs` / dir mtime gate before `getSummary()` (`grok.js:704-710`), mirroring `omp.js:475-496`; add `getPerfStats` like OMP. Acceptance: threshold 0 opens no files.
10. **Kimi Code single-pass wire read + cached project map** — M. Share one tail read across detail/usage/git (`kimi.js:1380-1411`) as v0.37 did for Codex; cache `buildProjectPathMap` (`:502-531`). Add OMP-style pass counters.
11. **`gh pr create` / PR URL events** — M. Extend `gitEvents.js` tokenizer to accept `gh` (`:1202`) with subcommands `pr create|merge`, `issue create`, `release create`; capture `https://github.com/.../pull/N` from tool results where available (Codex `item_completed.stdout`, Kimi `tool.result`). New event types `pr`, `release`; wire into `ChronicleEvents` verified outcomes (`release` kind already exists). Risk: parsing stdout is best-effort; mark `inferred`.
12. **Move `ChronicleEvents` verified-outcome helpers to `src/domain/services/`** — S. Fixes the layering violation; pure functions, no DOM.

---

## C. Verified defects

1. **Long-running Claude main sessions are relabelled `team-member`.** `claude.js:1761-1773` drops any history entry older than `HISTORY_SCAN_MS = 10 min`; the orphan pass then tags every still-active transcript `agentType:'team-member'` (`:2013`) with `teamName:null`. Live: two sessions with 3–4 entries in `history.jsonl` and no `~/.claude/teams` are reported `team-member` (`/api/sessions`). Effect: sprite/card grouping and `Agent.isSubagent` (`Agent.js:141`: `agentType !== 'main'` → true) treat a main session as a subordinate.
2. **`agentType` leaks raw `subagent_type`.** `claude.js:681-683` stores `input.subagent_type` (e.g. `general-purpose`, `Explore`) as `agentType`; live payload shows `agentType:'general-purpose'`. `adapters/README.md` documents a 5-value enum; consumers only special-case `workflow-subagent`/`main`/`repository` (`Sidebar.js:443,511,893`, `ChronicleLog.js:232`). Should be `agentType:'sub-agent'` + new `subagentKind`.
3. **Codex `turn_aborted` unhandled → stale `tool_pending` → false approval after 240 s** (`codex.js:643-690`, no `turn_aborted` reference; `turnState.js:146` pending outranks ended).
4. **Codex `unknown` mid-turn** when boundaries scroll out of the 50-line window (`codex.js:44,683`); live example present. Falls to mtime timing and shows `waiting`/`idle` while generating.
5. **Grok parses every historical `summary.json` before the age gate** (`grok.js:704-710`) — the v0.37 OMP shape.
6. **OpenCode parts query has no time predicate** (`opencode.js:360-374`) vs the cutoff-bounded session query (`:66-69`).
7. **OMP detail-path cold rescan** without mtime gate (`omp.js:536-542`).
8. **Sync `execFileSync` inside `createGitEvent` on the session-list path** (`gitEvents.js:1446,1453 → 1806-1831`) even with the async worker on; ledger cites the wrong line for the `index.js` call (`:210-216`, not `:147`).
9. **Layering:** `AgentManager.js:7-13` → `presentation/character-mode/ChronicleEvents.js`.
10. **Docs:** cache TTL "5 s" in `claudeville/CLAUDE.md:28,44` / `README.md:205` vs `index.js:51` = 2000 ms.
11. **Silent default pricing** for `claude-fable-*` (`sessionPresentation.js:126` → `pricing.claude.default`), no provenance field.
12. **Kimi legacy `ToolResult`/`TurnBegin` documented but never parsed** (`kimi.js:11-13`); `thinkingLevel` never read (0 occurrences); OpenCode `contextWindowMax` hardcoded to 3 models (`opencode.js:258-264`); OpenCode git events mutated post-construction so `confidence` stays 0.92 despite a known exit code (`opencode.js:598-608` vs `gitEvents.js:1428-1443`).

---

## D. Do not do

- Do **not** re-propose v0.37 work: stat-first OMP, shared Codex scan context, gzip/ETag, git-event wire compaction, delta broadcasts, the frame counters.
- Do **not** replace file tailing with hooks/OTel. Files are the only source that works with zero CLI configuration and for every provider; push is an overlay.
- Do **not** raise the Node floor just for `node:sqlite` — the CLI fallback exists (`opencode.js:102-115`); only raise it if a second feature needs it.
- Do **not** switch to brotli or add a bundler; loopback + ETag makes byte savings irrelevant.
- Do **not** re-enable `ENABLE_ERROR_HEURISTIC` (`StatusResolver.js:24`) — use real error records (hook errors, API errors) instead.
- Do **not** price unknown models at zero "to be safe"; keep the default but label it (§B2).
- Do **not** widen `ACTIVE_THRESHOLD_MS` to hide the Codex `unknown` problem; fix the boundary carry-over (§B8).
- Do **not** add a second provider allowlist in `server.js` (README rule) when adding the hooks overlay — register through `index.js` metadata.
- Do **not** add providers whose store format is unverified (§3 UNSURE rows).
- Do **not** treat LAN/CORS as part of the ingestion design; keep loopback + Host check + optional token.

---

### UNVERIFIED (sub-audits did not return; not asserted above)
- Full Claude adapter key inventory beyond the rg-checked keys; `getTeams()/getTasks()` field lists (live payloads seen: `teams[]`, `taskGroups[{groupName,tasks[{id,subject,description,activeForm,status,blocks,blockedBy}]}]`).
- Codex discovery stat-before-read in `scanRecentRollouts`; Codex "review mode" markers.
- Gemini adapter beyond `:148-162,553-560`; Grok `updates.jsonl` `sessionUpdate` kinds beyond `tool_call`/`agent_message_chunk`.
- Exact Claude Code hook/OTel/statusline field names and HTTP-hook support — verify against current docs before implementing §2/§B4.
