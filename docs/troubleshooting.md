# Troubleshooting

This guide covers the failure modes a new contributor or first-time user is most likely to hit during the first hour with ClaudeVille. Each entry names the symptom, gives the underlying cause, and either points at a fix or notes that the behavior is expected.

The dashboard observes local AI CLI session files. It writes nothing back to those CLIs. Most "missing data" symptoms therefore come from the upstream CLI not having produced data yet, not from a ClaudeVille bug.

## "No providers detected" / `/api/providers` returns `[]`

At least one provider source must exist and be readable: `~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.kimi/`, or `~/.local/share/opencode/opencode.db`. Most adapters register by home-directory presence, not by whether session subdirectories already contain data. OpenCode is stricter: the database must exist and either Node's `node:sqlite` support or the `sqlite3` CLI must be available for read-only access. A fresh machine with none of these CLIs installed correctly returns an empty list.

Server log on startup will say:

```
[!] No active providers
    One of ~/.claude/, ~/.codex/, ~/.gemini/, ~/.grok/, ~/.kimi/, or ~/.local/share/opencode/ is required
```

Fix: install at least one supported CLI and run a session so the provider home and session files are created. Then restart the server.

## Providers detected, but `/api/sessions` is empty

Only sessions whose last activity is within `ACTIVE_THRESHOLD_MS` are returned. The constant is defined in `claudeville/server.js` and is currently `2 * 60 * 1000` (two minutes). If you have not used the CLI in the last two minutes, the dashboard correctly shows nothing active.

Confirm by running a CLI command in a real session, then refresh `/api/sessions` within two minutes.

Provider scan windows also matter:

- Claude uses recent `history.jsonl` entries to find active sessions, then checks recent project/session files.
- Codex scans recent date folders under `~/.codex/sessions/YYYY/MM/DD/` and filters by file activity.
- Gemini reads recent chat JSON files under `~/.gemini/tmp/<project_hash>/chats/`.
- Kimi reads recent legacy `~/.kimi/sessions/<project_hash>/<session_uuid>/wire.jsonl` data and resolves project hashes from Kimi config and common local work directories. Kimi Code sessions are read from `~/.kimi-code/sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl` and mapped back to projects through `~/.kimi-code/session_index.jsonl`.
- OpenCode reads recent rows from `~/.local/share/opencode/opencode.db` in read-only mode.
- Some detail lookups can search a wider window than the active-session list, so a detail URL may work for a session that no longer appears as active.

Repository-only `git` sessions can also appear when git enrichment detects unpushed or pushed GitHub repository activity outside a live provider session. That scan defaults to `~/Documents/git`, can be narrowed with `CLAUDEVILLE_REPOSITORY_SCAN_ROOT`, capped with `CLAUDEVILLE_REPOSITORY_SCAN_MAX`, and disabled with `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT=1`. Synthetic git session detail returns a reason string rather than a provider transcript.

## Permission prompts are inferred or arrive late

Transcript parsing remains the default and requires no configuration. An elapsed tool duration never proves a permission prompt: long builds remain work, while explicit question/review tools and approval hooks provide waiting evidence. The route accepts the normalized schema `{ provider, sessionId, cwd, ts, kind, tool, input, decision? }` at `POST /api/ingest/hook`, keeps at most 256 sessions in memory, and never persists or logs request bodies. `kind` must be a supported lifecycle event such as `PreToolUse`, `PostToolUse`, or `Stop`. `input` may contain only operator-facing command/path context; displayed detail is secret-stripped and capped at 200 characters. This is the canonical payload schema; other documentation should link here instead of duplicating it.

All examples use `curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook` and, where supported, an asynchronous hook so a stopped dashboard does not block the CLI. They require `jq`. If ClaudeVille runs with `CLAUDEVILLE_INGEST_TOKEN`, export the same value into the CLI environment; the helpers always send it in `X-ClaudeVille-Ingest-Token` (an empty value is harmless when the server token is unset).

This repository dogfoods Claude Code ingestion through the committed `.claude/settings.json`. It is inert unless Claude Code is launched with `CLAUDEVILLE_DOGFOOD_HOOKS=1`; if the server requires authentication, also export `CLAUDEVILLE_INGEST_TOKEN`. The hook maps `session_id` to `sessionId`, preserves the accepted `hook_event_name` as `kind`, and forwards only `tool_name`, `cwd`, a reception-time `ts`, and the first available `tool_input.command`, `file_path`, `pattern`, or `description`. Prompts, transcript paths, file contents, tool results, and all other input fields are discarded before the request. The built-in request times out after 150 ms and always fails open, so a stopped dashboard cannot block Claude Code.

For Codex CLI lifecycle hooks, save the analogous executable helper as `~/.config/claudeville/ingest-codex-hook`:

```sh
#!/bin/sh
jq -c '{
  provider: "codex",
  sessionId: .session_id,
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .hook_event_name,
  tool: (.tool_name // null),
  input: ((.tool_input.command? // .tool_input.file_path? // .tool_input.path? // .tool_input.description? // null) | if type == "string" then .[0:200] else . end),
  decision: (.permission_mode // null)
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Add these Bash lifecycle entries to your own `~/.codex/hooks.json`; Codex only emits `PreToolUse`/`PostToolUse` for Bash in the verified CLI payload, while `PermissionRequest` is the exact approval signal.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "PermissionRequest": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-codex-hook", "async": true, "timeout": 1 }]
    }]
  }
}
```

Codex's legacy `notify` setting is a different interface: it passes one argv JSON object with kebab-case keys. Save this executable helper as `~/.config/claudeville/ingest-codex-notify`; it maps `thread-id` to `sessionId` and `type` to `kind` without sending `input-messages` or assistant text:

```sh
#!/bin/sh
printf '%s' "$1" | jq -c '{
  provider: "codex",
  sessionId: ."thread-id",
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .type,
  tool: null,
  input: null,
  decision: null
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Point the legacy `notify` array in your own `~/.codex/config.toml` at that helper, using its absolute path (Codex appends the one JSON argument):

```toml
notify = ["/bin/sh", "/home/YOU/.config/claudeville/ingest-codex-notify"]
```

Its verified `approval-requested` type produces an exact wait signal, but it has no verified tool input, so it cannot add command/path detail by itself.

Gemini CLI's verified [`BeforeTool` and `AfterTool` hooks](https://geminicli.com/docs/hooks/reference/) carry `session_id`, `cwd`, `hook_event_name`, `tool_name`, and `tool_input`. Save this executable helper as `~/.config/claudeville/ingest-gemini-hook`:

```sh
#!/bin/sh
jq -c '{
  provider: "gemini",
  sessionId: .session_id,
  cwd: .cwd,
  ts: (now * 1000 | floor),
  kind: .hook_event_name,
  tool: (.tool_name // null),
  input: ((.tool_input.command? // .tool_input.file_path? // .tool_input.path? // .tool_input.query? // .tool_input.pattern? // .tool_input.description? // null) | if type == "string" then .[0:200] else . end),
  decision: null
}' | curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook \
  -H 'Content-Type: application/json' \
  -H "X-ClaudeVille-Ingest-Token: ${CLAUDEVILLE_INGEST_TOKEN:-}" \
  --data-binary @- >/dev/null 2>&1 || true
```

Add both events to your own Gemini CLI `settings.json`. Gemini hook timeouts are milliseconds, so `1000` matches the curl cap:

```json
{
  "hooks": {
    "BeforeTool": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-gemini-hook", "timeout": 1000 }]
    }],
    "AfterTool": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.config/claudeville/ingest-gemini-hook", "timeout": 1000 }]
    }]
  }
}
```

`BeforeTool` maps to a transient `tool_pending` overlay with the sanitized command/path detail. `AfterTool` clears that pending state back to working.

If the overlay does not appear, POST one normalized fixture with `curl`, confirm a `202` response, and fetch `/api/sessions` immediately. A `401` means the token header does not match; `403`/`421` means the Origin/Host is not local; `400` means the provider, event, session id, or JSON is invalid. Match the returned public session, not just the HTTP acceptance: Codex hook thread IDs and Gemini payload session IDs can differ from dashboard filename IDs, and matching is provider-qualified. Ordinary overlays stop merging after 10 seconds and expire after 30 seconds. Exact unanswered approvals instead become last-observed waits after 10 seconds; a resolving hook/newer recorded turn clears them, and a 30-minute bound prevents indefinite retention.

## WebSocket never connects / port 4000 collision (`EADDRINUSE`)

The port is hardcoded at `claudeville/server.js` (`const PORT = 4000;`). On startup, `server.on('error', ...)` prints `Port 4000 is already in use.` and the process stays up but cannot serve.

Find and stop the other process holding port 4000:

```bash
lsof -i :4000
# or
ss -ltnp | grep 4000
```

The README and both `CLAUDE.md` files assume port 4000. See `docs/design-decisions.md` for why it is hardcoded.

If the browser shows a blank page but the port is open, first confirm there is only one listener:

```bash
ss -ltnp '( sport = :4000 )'
```

Stale `node claudeville/server.js` processes can make repeated curl/browser tests disagree. Do not kill a listener in a shared checkout unless ownership is clear and the user has approved process cleanup.

## Port is open, but `/` or `/api/sessions` hangs

Treat zero-byte HTTP timeouts as backend evidence before debugging canvas rendering:

```bash
curl -v -m 3 http://127.0.0.1:4000/
curl -v -m 3 http://127.0.0.1:4000/api/sessions
curl -v -m 3 http://127.0.0.1:4000/api/providers
```

If `/api/sessions` hangs, time adapter aggregation. The previous expensive path was Claude subagent discovery scanning broad `~/.claude/projects/*` trees. Benchmark `getAllSessions(120000)` and each adapter before changing frontend code.

If `/` hangs while `claudeville/index.html` is readable and `/api/providers` eventually returns JSON, inspect the static route handler in `server.js`. The root route should strip query strings, map `/` to `index.html`, stay inside the `claudeville/` static directory, and avoid stalled response streams.

## `/api/usage` returns nulls or partial data

`claudeville/services/usageQuota.js` pulls data from four sources:

1. `~/.claude/.credentials.json` for subscription metadata.
2. `~/.claude/stats-cache.json` and `~/.claude/history.jsonl` for activity counts.
3. `claude auth status` (run once at server startup) for the account email.
4. `https://api.anthropic.com/api/oauth/usage` for the 5h/7d quota figures.

Source 4 is documented as "currently unavailable; retry periodically" (`claudeville/services/usageQuota.js:8`). When it fails, the response still returns with `quota: { fiveHour: null, sevenDay: null }` and `quotaAvailable: false`. The other fields keep working. This is expected and non-fatal.

Credential and activity sources are cached briefly, and quota checks are best-effort. Missing local files, failed `claude auth status`, or failed Anthropic quota calls should return partial/null fields rather than breaking `/api/usage`.

## Cost numbers look wrong

Cost is computed locally from token counts in session files multiplied by static per-million-token rates. `claudeville/src/config/models.json` is the canonical source for pricing, model aliases, and provider defaults; generated ESM and CommonJS resolvers keep browser and server estimates aligned. The numbers are estimates, not billing truth. DeepSeek-backed OpenCode sessions still use `provider: "opencode"` but resolve DeepSeek rates from the model string. OMP sessions backed by z.AI keep `provider: "omp"` but resolve GLM 5.3 / GLM 5.3 Flash rates and the `zai` identity from the model string, which surfaces as `zai/glm-*` from the `model_change` record or as the bare `glm-*` id once assistant messages arrive. Grok sessions currently surface cumulative `contextWindow` occupancy from ACP metadata rather than a full input/output split, so estimated cost often stays near zero until richer usage is written on disk. An unmatched model uses its provider's `defaults` entry.

If a model is missing or its price has changed, update one row in `claudeville/src/config/models.json`, run `npm run models:generate`, inspect it with `npm run models:resolve <provider> <model>`, and run the model registry and pricing tests before verifying browser and `/api/sessions` cost displays.

## Desktop graphics reset or compositor crash while ClaudeVille is open

First distinguish an app crash from a system graphics-stack reset. On Linux/KWin/amdgpu systems, collect recent warning-level evidence:

```bash
journalctl -b --no-pager -p warning..alert | rg -i 'amdgpu|drm|gpu|reset|GL_CONTEXT|kwin|Xwayland|chrome|chromium|oom|killed process'
watch -n 1 'free -h; ps -eo pid,comm,%cpu,%mem,rss --sort=-rss | head -n 15'
```

ClaudeVille exposes lightweight browser/server counters for manual checks:

```js
window.__claudeVillePerf.canvasBudget()
```

```bash
curl http://localhost:4000/api/perf
```

If the journal shows GPU ring timeouts, compositor `GL_CONTEXT_LOST`, or Xwayland/browser core dumps without OOM-killer entries, treat it as a graphics-stack reset. ClaudeVille should reduce load by pausing World mode in Dashboard, releasing renderer-owned canvas caches, and capping canvas backing-store pixels, but driver/compositor resets can still originate below the app.

## Linux reports an out-of-memory kill

Do not infer the victim from the notification text or virtual-memory size. Match ClaudeVille's current PID to the kernel OOM table and compare resident/anonymous memory:

```bash
curl -fsS http://localhost:4000/api/perf
journalctl -k -b --no-pager | rg -i 'out of memory|oom-kill|killed process'
RUNTIME_PID=12345 # replace with runtime.pid from /api/perf
ps -o pid,ppid,comm,rss,vsz,etime -p "$RUNTIME_PID"
rg '^(Rss|Pss|Pss_Anon|Private_Dirty|Swap):' "/proc/$RUNTIME_PID/smaps_rollup"
```

`/api/perf.runtime.memory.rss` covers the Node server. Browser canvas, decoded-image, compositor, and GPU allocations belong to the browser process and must be recorded separately with `window.__claudeVillePerf.canvasBudget()` and the browser task manager. A kernel table showing another process with materially larger anonymous RSS is evidence against attributing the system OOM to ClaudeVille.

## Browser console errors after editing

There is no transpiler, bundler, or app test runner. A typo in any module aborts page startup with a console error pointing at the failing module. Run a server-side syntax check first:

```bash
node --check claudeville/server.js
find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check
```

For frontend modules, open the browser devtools console. There is no build step that would catch the error earlier.

## Sprite validation scripts fail with missing packages

Runtime does not require installed npm packages, but sprite validation and visual-diff scripts do. If `npm run sprites:validate`, `sprites:capture-*`, or `sprites:visual-diff` fails with `ERR_MODULE_NOT_FOUND`, run `npm install` when dependency installation is in scope.

If installing dependencies is out of scope, fall back to:

- Inspect `claudeville/assets/sprites/manifest.yaml` and `AssetManager._pathFor()`.
- Use `file` on touched PNGs to confirm dimensions and file type.
- Check for checkerboard placeholders in the browser, which indicate a missing/invalid sprite path.

`AssetManager` also loads `claudeville/assets/sprites/palettes.yaml`; keep it aligned with the `palettes` block in `manifest.yaml`. Bump `style.assetVersion` after changing PNGs if browser cache is suspected.

## Agent display name keeps changing

Names are deterministic from the agent ID hash via `Agent.generateNameForLang` (`claudeville/src/domain/entities/Agent.js:284`). Names assigned by a team are preserved because `_customName` is set when the agent is constructed with an explicit name (`claudeville/src/domain/entities/Agent.js:103`, honored in `claudeville/src/presentation/App.js` and `claudeville/src/application/AgentManager.js`).

If you renamed an agent in code and the rename was overwritten, check that the constructor received `name` and `_customName` is true on that instance.

## Server starts but the page fails to load static assets

`server.js` resolves the request URL inside `STATIC_DIR` and rejects anything outside that directory with `403 Forbidden`. Do not add symlinks pointing outside `claudeville/`; they will be refused.

## Required runtime: Node 18+, no Windows path support in adapters

The server uses `fs.watch({ recursive: true })`, `Buffer.readBigUInt64BE`, and built-in `URL`. Node 18+ is the practical floor.

The adapters target POSIX path conventions and have no `process.platform === 'win32'` branches. Linux and macOS are tested. Windows path normalization is not implemented today.

## Checkerboard placeholders in World mode

A checkerboard pattern means `AssetManager` could not load a sprite and fell back to the placeholder.

Common causes:

1. **Missing PNG** - the manifest references an ID with no file on disk.
2. **Wrong path** - the manifest ID does not map to the path `AssetManager._pathFor()` expects.
3. **Stale cache** - the browser cached an old 404 response. Bump `style.assetVersion` in `manifest.yaml` and hard-refresh.
4. **Orphan PNG** - a file exists but has no manifest entry.

Diagnosis:

```bash
npm run sprites:validate
file claudeville/assets/sprites/path/to/suspect.png
```

Inspect `manifest.yaml`, `AssetManager._pathFor()`, and the browser devtools Network tab for 404s.

## "Empty array of providers" but `~/.claude/` exists

Provider activation is decided by directory existence, not by file content. If `~/.claude/` is present but empty, the Claude adapter still registers, and `/api/providers` will list it. `/api/sessions` will be empty because there are no JSONL files to read. Generate a session in the upstream CLI to populate it.
