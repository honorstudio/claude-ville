# Skills, hooks, commands, CI

**Status:** `ready` · read-only review · Codex `sol medium` · session `01a062b9-105e-7293-8800-dc89dd76e796` · 267s · 2026-09-02

Slice 3 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. **Both existing Claude skills should be rewritten, not retained as procedural checklists.** `verify-architecture` names only Claude, Codex, and Gemini adapters (`.claude/skills/verify-architecture/SKILL.md:44-54`), while the registry instantiates seven adapters (`claudeville/adapters/index.js:5-11,28-36`). Its `grep -rn` command conflicts with the repository’s `rg` convention (`.claude/skills/verify-architecture/SKILL.md:56-67`; `AGENTS.md:6`). Worse, it declares every fixed-position rule outside modal/toast code a failure, although intentional first-run, grammar, connection, and spend overlays use it (`claudeville/css/character.css:115-130,187-195`; `claudeville/css/topbar.css:293-304,762-773`). The suspected i18n and port claims are current: `claudeville/src/config/i18n.js:1-42`; `claudeville/server.js:41-42`. Most skill checks are prose and therefore cannot reliably prevent drift.

2. **`verify-server` contains a false security requirement and unsafe shared-port workflow.** It expects wildcard CORS (`.claude/skills/verify-server/SKILL.md:74-81`), but the server deliberately validates local Host/Origin and rejects cross-origin requests (`claudeville/server.js:99-123,2704-2712`). It also instructs agents to start `npm run dev`, sleep, and inspect port 4000 (`.claude/skills/verify-server/SKILL.md:17-28`) despite the maintained operator server (`AGENTS.md:47-49`). It promises WebSocket verification but contains no WebSocket check (`.claude/skills/verify-server/SKILL.md:3,38-81`). Existing isolated checks already test security, WebSockets, APIs, and ephemeral-port boot behavior (`scripts/smoke/README.md:28-32`; `package.json:43-45`).

3. **CI is materially weaker than the agent-facing release contract.** CI runs only `validate:quick` on Node 24 (`.github/workflows/ci.yml:7-21`), although the package promises Node ≥18 (`package.json:29-30`). The release gate additionally runs replay, server-security, server-fatal, and boot-contract smokes (`package.json:43-45`). CI also omits the adapter/relationship checks agents are explicitly told to run (`AGENTS.md:64`), world validators (`AGENTS.md:69`), full manifest validation (`AGENTS.md:68`; `package.json:47-49`), and docs parity (`AGENTS.md:70`). Browser/visual checks are correctly manual (`AGENTS.md:73`).

4. **The workflow portfolio does not reflect actual recurrence.** Keyword buckets over 778 commit subjects since March 1 found 197 sprite/asset, 143 docs/agent, 61 plan/wave, 59 release/version, 57 provider/adapter, 16 model, and 3 pricing commits; buckets overlap. Representative recurrence includes releases `67ce206`, `58c884e`, `c234663`; model/pricing work `38781e9`; plan execution `43864c5`; and sprite work `d271d55`. Yet only two verification skills exist, both originating in `63fe3a43` and last meaningfully refreshed in `d01f4009`.

5. **Claude and Codex receive unequal workflow affordances.** The tree has two `.claude/skills/*` files but no `.claude/settings.json`, `.claude/settings.local.json`, `.claude/commands/`, `.claude/agents/`, or `.mcp.json`. Codex has only the well-scoped PixelLab MCP definition (`.codex/config.toml:1-6`). Both receive core repository guidance through `AGENTS.md`, but Codex cannot automatically discover Claude-only skills. This matters while skills contain unique procedures; it matters much less if deterministic behavior moves into shared scripts.

6. **Hook ingestion exists but is not documented sufficiently to wire safely.** The nested guide says only that `/api/ingest/hook` accepts normalized lifecycle overlays (`claudeville/CLAUDE.md:18`). Code requires `provider`, `sessionId`, and a known `kind`, with optional `tool`, `input`, `cwd`, and `ts` (`claudeville/adapters/hooks.js:147-181,232-240`). It retains a redacted/truncated command, path, query, pattern, or description (`claudeville/adapters/hooks.js:71-99`). The endpoint is loopback-only, optionally token-protected, and returns 202 (`claudeville/server.js:497-545`). Without a documented Claude-input mapping, agents may leak unnecessary hook fields or post invalid payloads.

7. **Peripheral contribution metadata has provider drift.** The provider issue template omits supported Grok and OMP options (`.github/ISSUE_TEMPLATE/provider_support.yml:10-20`) despite the canonical seven-provider list (`claudeville/CLAUDE.md:34-40`). This produces incomplete reports that agents later use as implementation inputs. The PR template otherwise asks for focused validation, screenshots, and release metadata (`.github/pull_request_template.md:9-18`).

8. **Agent docs contain a machine-specific stale cwd.** Root guidance names `/home/ahirice/Documents/git/claude-ville` (`AGENTS.md:3`), and nested guidance repeats it (`claudeville/CLAUDE.md:5`), while this checkout is under `/Users/ahirice/Documents/git/claude-ville`. Agents should be told to use the repository root discovered from the current working directory, not a maintainer-specific absolute path.

## Proposals

1. **Replace prose verification with shared executable contracts — M**

   Edit `package.json`; add `scripts/smoke/architecture.mjs` and a `verify:server` script composing the existing isolated server smokes. Rewrite both current skills as short routers that select and interpret these commands. Add architecture/server checks to CI.

   `architecture.mjs` should verify registered adapters dynamically, required layer directories, no runtime dependencies, port/bind constants, root-doc parity, and allowlisted fixed overlays. `verify-server` must never touch the maintained port.

   **Impact:** Every Claude and Codex change; removes stale duplicated truth.  
   **Acceptance:** Both commands pass from a clean checkout; deleting an adapter registration or changing the port makes the relevant check fail; server verification leaves port 4000 untouched.  
   **Risks:** Brittle source-text assertions; isolate pure constants or use narrow regexes.

2. **Bring CI up to the advertised compatibility/release floor — M**

   Edit `.github/workflows/ci.yml` and `package.json`. Run dependency-free validation on Node 18 and 24; add isolated server/replay smokes and docs parity. Add adapter/relationship smokes where deterministic. Keep Playwright visual checks manual unless CI deliberately installs dev dependencies.

   **Impact:** All contributors and agents before merge.  
   **Acceptance:** CI exercises every dependency-free command in `gate:release`; a parity mismatch and a Node-18 incompatibility each fail CI.  
   **Risks:** Longer CI and platform-sensitive smokes; retain temporary HOME and ephemeral-port isolation.

3. **Add minimal fast Claude safety hooks — M**

   Add `.claude/settings.json`, `scripts/agent-hooks/claude-hook.cjs`, and fixture tests. Exact settings:

   ```json
   {
     "hooks": {
       "SessionStart": [{
         "matcher": "startup|resume|clear|compact",
         "hooks": [{
           "type": "command",
           "command": "node scripts/agent-hooks/claude-hook.cjs session",
           "timeout": 1
         }]
       }],
       "PreToolUse": [{
         "matcher": "Bash",
         "hooks": [{
           "type": "command",
           "command": "node scripts/agent-hooks/claude-hook.cjs guard",
           "timeout": 1
         }]
       }],
       "PostToolUse": [{
         "matcher": "Edit|Write|MultiEdit",
         "hooks": [{
           "type": "command",
           "command": "node scripts/agent-hooks/claude-hook.cjs check-js",
           "timeout": 1
         }]
       }]
     }
   }
   ```

   Matchers are regular expressions over the event source/tool name: SessionStart reasons, Bash only, and file-edit tools respectively. The script reads hook JSON from stdin. `guard` rejects the destructive git operations and kill/port-kill patterns from `AGENTS.md:83-87`; `check-js` runs `node --check` only for the edited `.js/.cjs/.mjs` path; `session` prints `git status --short` plus `package.json` version and always exits cleanly.

   **Impact:** Every Claude session/edit; prevents high-cost mistakes and catches syntax errors immediately.  
   **Acceptance:** fixture tests cover allowed and denied commands, filenames with spaces, malformed stdin, and non-JS edits; each mode completes under 200 ms in ten local runs.  
   **Risks:** Regex command guards can false-positive or be bypassed; keep them narrow and defense-in-depth, not a security boundary.

4. **Create a deliberately small, cross-tool workflow portfolio — M**

   Use `name` and trigger-rich `description` frontmatter on all skills; keep each under roughly 100 lines and point to canonical docs/scripts.

   - **Accept `add-provider` and `add-model`** as separate thin skills because their scopes and validation differ (`docs/agent-provider-addition.md:26-51`). Detailed model mechanics remain with the other reviewer.
   - **Accept `release` as manual-only** (`disable-model-invocation: true`), because pushing/tagging/releasing is externally mutating. It should verify clean status, version trio, changelog section, `gate:release`, tag, and matching GitHub release (`AGENTS.md:89-115`).
   - **Accept `sprite-generate`** as a router to manifest planning, PixelLab guidance, validation, and visual review (`scripts/sprites/generate.md:67-94,172-199`).
   - **Accept `verify-ui`** for judgment-heavy browser review, using maintained port 4000 and existing capture scripts (`AGENTS.md:65-73`; `package.json:56-58`).
   - **Reject `pricing-refresh` as a standalone skill:** prices explicitly change rarely and already have a two-file contract (`docs/design-decisions.md:77-83`). Add a parity test/checklist to `add-model`.
   - **Reject `plan-execute`:** plan status and retained-artifact rules are already explicit (`agents/README.md:3-25`), while execution varies by plan.
   - **Reject `docs-parity` as a skill:** make it a script/CI check because the result is deterministic (`AGENTS.md:70`).

   **Impact:** Frequent Claude workflows, with scripts/docs equally usable by Codex.  
   **Acceptance:** every accepted skill identifies authoritative files, prerequisites, mutation boundaries, and exact validation; no deterministic check exists only in prose.  
   **Risks:** Trigger overlap between add-model/add-provider; descriptions must distinguish “new CLI source” from “identity within an existing provider.”

5. **Dogfood lifecycle ingestion as explicit opt-in — M**

   Extend `scripts/agent-hooks/claude-hook.cjs` with `ingest`, gated by `CLAUDEVILLE_DOGFOOD_HOOKS=1`. Map only:

   ```json
   {
     "provider": "claude",
     "sessionId": "<session_id>",
     "kind": "<hook_event_name>",
     "tool": "<tool_name>",
     "input": "<tool_input>",
     "cwd": "<cwd>",
     "ts": 0
   }
   ```

   Document this schema in `claudeville/CLAUDE.md` and `docs/troubleshooting.md`. Use a short localhost timeout, optional token header, no prompt/transcript forwarding, and fail open if the dashboard is absent.

   **Impact:** Maintainers testing ClaudeVille with Claude Code; improves live state precision.  
   **Acceptance:** unit fixture transforms Claude hook input correctly; enabled hook receives 202; disabled or unavailable server adds negligible latency and never blocks tools.  
   **Risks:** privacy and event-volume overhead; hence opt-in rather than committed-on-by-default.

6. **Clean up agent-facing drift — S**

   Edit `AGENTS.md`, root `CLAUDE.md`, `claudeville/CLAUDE.md`, and `.github/ISSUE_TEMPLATE/provider_support.yml`. Replace absolute cwd with “repository root,” preserve root-doc parity, and add Grok/OMP choices.

   **Impact:** Every onboarding session and provider bug report.  
   **Acceptance:** parity check passes; no `/home/ahirice` remains in active agent docs; issue template lists all seven registered adapters.  
   **Risks:** None beyond keeping duplicated root documents synchronized.

## Open questions

1. Should the project’s minimum supported Node version remain 18, or should `package.json:29-30` be raised to match the current Node-24-only CI policy?

2. Should dogfood hook events be enabled for all maintainers who set the environment flag, or only through an uncommitted `.claude/settings.local.json` to minimize privacy and latency exposure?
