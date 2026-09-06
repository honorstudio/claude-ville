# ClaudeVille Fable 5.1 enhancement plan — *The Commander's Map*

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan item by item. Each item is one reviewable unit with its own tests, owned paths, and acceptance. Re-check every `file:line` anchor before editing; line numbers move.

**Status:** `implemented and release-verified` — the 24 Waves 0-3 items shipped as `v0.38.0` (2026-09-02); the 5 Wave 4 items shipped as `v0.39.0` (2026-09-02), with 4.1's generated distant-shore band built, measured, and cut on maintainer review (the cliff reflection and dithered waterline shipped). Verification: `npm run gate:release` green each release, WebGL+Canvas render baselines at parity per **F4**, real-GPU ladder probe reaching `q=0` in 2 s, and manual browser passes over World, Dashboard, Chronicle, the mode round trip, and resize.

**Baseline:** `main` at `e7737d5` (`v0.37.0` *The Thaw*), clean tree, 2026-09-01. Node v24.16.0 locally; `package.json` still promises `>=18`.

**Goal:** turn a beautiful, honest visualisation of agent activity into an operator instrument, and deliver the lighting the project already paid for to the renderer that operators actually run.

**Architecture:** no new subsystems. Every item is additive inside the existing seams: the adapter normaliser (`adapters/index.js`), the session payload contract, the GPU record builder (`gpu/GpuSceneBuilder.js`), the pure PostFx ladder, `reset.css` tokens, and the Activity Panel / Dashboard renderers. One optional new server route (`POST /api/ingest/hook`) is the only new surface, and it is opt-in, loopback-only and overlay-only.

**Tech stack:** unchanged. Zero build, vanilla ES modules, Node built-ins only at runtime, Canvas 2D base with the WebGL2 GPU world and PostFx, `node:test` for pure logic, Playwright only for manual capture scripts.

**Spec / evidence:** this document plus the retained research under [`agents/research/claudeville-fable-5.1-review/`](../research/claudeville-fable-5.1-review/): four independent read-only reviews (rendering, DOM/UI, signal layer, and an outside review by a Codex Sol agent) and eight reference captures. Every claim below cites a `file:line` that a reviewer or the coordinator read in this checkout, or a live capture on the maintained server.

---

## Method

Five reviewers with disjoint territories, all read-only, all against `e7737d5` and the live server on `http://localhost:4000`:

| Reviewer | Territory | Artifact |
| --- | --- | --- |
| Coordinator (Fable 5.1) | product read, Playwright captures at 1920×1080 and 1440×900 @2×, live payload checks, cross-verification of every defect cited below | this plan |
| Fable reviewer A | World-mode rendering: Canvas 2D, WebGL2, PostFx, atmosphere, labels | [`rendering-review.md`](../research/claudeville-fable-5.1-review/rendering-review.md) |
| Fable reviewer B | DOM chrome: top bar, sidebar, Dashboard, Activity Panel, modals, CSS, typography, accessibility | [`ui-review.md`](../research/claudeville-fable-5.1-review/ui-review.md) |
| Fable reviewer C | server, adapters, services, domain and application layers, tests | [`signal-review.md`](../research/claudeville-fable-5.1-review/signal-review.md) |
| Codex Sol (outside opinion) | product direction, disagreement with prior plans, operator-context gaps | [`sol-outside-review.md`](../research/claudeville-fable-5.1-review/sol-outside-review.md) |

One capture caveat matters for anyone repeating this: headless Chromium with SwiftShader drives the GPU quality ladder to `disabled:gpuMs`, which still draws at MINIMAL and hides PostFx. Captures taken that way show the Canvas fallback, not what an operator sees. Real-GPU captures used `chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] })`; WebGL2 then reports `ANGLE Metal Renderer: Apple M5 Pro`, the village runs at the 120 Hz vsync ceiling with `appRenderMs` ≈ 3 ms and `gpuMs` 1–3 ms, and `navigator.gpu` is present.

---

## The organizing finding

Two previous plans closed two habits: *building machinery and stopping one step before the operator* (Opus 5 plan) and *six surfaces telling six truths* (Council of Six, landed as `v0.36.0` even though its header still reads `proposed — not started`). This review found a third habit, and all five reviewers hit it from different sides:

> **ClaudeVille now tells the truth about *state*, but it does not yet tell the operator *why*, *how much*, or *where the light went*.**

Concretely, three verified facts on the live server today:

1. **The cost ledger is wrong for every current Anthropic model.** `model-pricing.json` has rates only for the substrings `opus`, `sonnet`, `haiku` and a handful of OpenAI ids. `claude-fable-5-1` and `claude-fable-5` match nothing and silently fall to the Claude family default, which is the Sonnet-class `3 / 15` rate (`claudeville/adapters/sessionPresentation.js:109-127`). The `opus` row still carries `15 / 75`, and the `haiku` row `0.8 / 4`. Against Anthropic's published first-party rates (Fable 5.1 `$10 / $50` per MTok, Opus 5 `$5 / $25`, Sonnet 5 `$2 / $10`, Haiku 4.5 `$1 / $5`; cache multipliers must be re-verified against the live pricing page before the table is edited), a Fable session is displayed at roughly a third of its cost and an Opus 5 session at three times its cost, with no provenance field anywhere in the payload to say so. The session that produced this plan is one of the under-reported ones.
2. **The WebGL2 world that every operator runs never shows most of `v0.36.0`'s light and ground work.** Building sun shadows, cloud shadows, the geometry-derived haze field, every dynamic water pass, wetness marks and the whole fauna layer are gated with `if (!gpuWorldActive)` or drawn to the base canvas under the opaque GPU island (`WorldFrameRenderer.js:497-535,643`; fauna at `:515-522`). PostFx is constructed only when there is no GPU world (`IsometricRenderer.js:1533`). On top of that the quality ladder boots at MINIMAL (4 lights, no occlusion, no bloom), reaches REDUCED at about 11 s and FULL only at about 29 s on the reference machine (75-second probe, [`ladder-timeline.md`](../research/claudeville-fable-5.1-review/ladder-timeline.md)), because a single frame over `healthyMs = 2` resets the 5 s recovery probe (`postfx/PostFxLadder.js:22-27,181-197`). The "few lantern pools" in the night captures are the ladder shedding lights.
3. **The signal layer surfaces about a third of what the two dominant CLIs already write to disk.** Claude Code transcripts on this machine carry `cost-state` (`totalCostUSD`, `modelUsage`, `hasUnknownModelCost`, `totalLinesAdded/Removed`), `system/turn_duration`, `last-prompt`, `stop_hook_summary`, `gitBranch` and per-entry `model`/`effort`; `adapters/claude.js` references none of them. Codex rollouts carry `event_msg/item_completed` with `FileChange.changes`, `CommandExecution{exit_code,duration}` and `turn_context.approval_policy`; `adapters/codex.js` references none of them. Three of seven providers emit no turn state at all.

Sol's outside verdict states the consequence plainly: the village answers "five working, one needs me" better than any dashboard, and answers "what exactly is blocked, which files overlap, why did this turn take ninety seconds, what did it cost" worse than a terminal. This plan spends on the second question first, then on delivering the light, then on the chrome that carries both.

The World is not redesigned. The captures under `shots/` show a village that is already the best thing about the product; the isometric art, the harbour ships carrying pending commits, the plaques with occupancy chips and the attributed speech bubbles are all kept exactly as they are.

---

## Guardrails (binding on every item)

- **Zero build is sacred.** No bundler, transpiler, framework, TypeScript, CSS preprocessor, or runtime dependency. Plain ES modules; `devDependencies` for scripts only.
- **Read-only against provider files. Loopback-only server. No auth, no LAN, no CORS.** The one new route in item 1.6 is opt-in, capped, and never writes anything outside ClaudeVille's own memory.
- **Desktop-only, ≥1280 px, no `@media` queries.** English-only copy, docs and comments. No emoji in UI copy.
- **The WebGL2 renderer is not restructured.** `character-mode/gpu/**` and `postfx/**` take additive changes only: new records, new uniforms, new tables, new tests. **No WebGPU, no OffscreenCanvas worker, no radiance-cascade GI, no normal maps.** Measured GPU time on the reference machine is 1–3 ms for ~240 quads; the visible deficits are ladder policy and Canvas/GPU parity, not API ceilings. No reopen trigger in `open-followups.md` is met.
- **Motion budget holds** (`docs/motion-budget.md`): reduced motion allocates no continuous animation; every new pulse declares a band; every new effect ships a static fallback.
- **Palette contract holds.** The four quantised key-light bands and the stepped grammar stay; nothing smooth is added to a stepped scene.
- **No invented flavour.** Zero authored barks, no fake bonds, no mood adjectives. An empty section is hidden, not filled.
- **No raw model text, prompt content, permission payloads, secret-bearing commands or transcript prose is ever persisted by ClaudeVille.** Item 1.6 keeps its overlay in memory only and truncates everything it displays.
- **Counts, never percentages, in attention surfaces.** (`v0.36.0` rule; percentages erase the outlier.)
- **Shared checkout hygiene.** `git status --short` before editing and before committing; preserve unrelated modifications; never run destructive git commands.
- **`App.js`, `index.html`, `css/**` are the integration surface.** A parallel worker never owns them; one serialized integration pass wires each wave and runs `npm run validate:quick`.

### Design context (resolves the DOM typography question)

`PRODUCT.md` and `DESIGN.md` are the design authorities for the chrome. `DESIGN.md` says "one pixel typeface, there should never be a second one", but the shipped code already admits a second face: `reset.css:17-22,75` loads Departure Mono as `--font-body`, and `topbar.css:450` calls it "the legible data face". This plan treats that shipped decision as the standard and keeps **two** faces (Press Start 2P for display, Departure Mono for data and body). It does **not** add a third, smooth face; that would be a brand decision for the maintainer, and it is listed under *Killed or deferred*. What the plan does fix is the broken type floor (display glyphs rendered at 7–9 px in fourteen places) and document-wide font smoothing disabled for body copy. `DESIGN.md` §3 must be updated to record the two-face system when item 3.1 lands.

---

## Cross-item contracts — specify before any work starts

**F1 — cost provenance on the session payload** (producer: 0.1 and 1.1; consumers: `TokenUsage.js`, `ActivityPanel`, `DashboardRenderer`, `TopBar`, `SpendLedger`, Settings/Health)
```
estimatedCost: number,                       // unchanged, for compatibility
cost: {
  usd: number,
  source: 'provider' | 'estimate',           // provider = CLI-reported (Claude cost-state, OpenCode session.cost)
  rateMatch: string | null,                  // e.g. 'claude-fable-5', 'opus-5', 'default:claude'
  rateRevision: string,                      // e.g. '2026-09-01', from model-pricing.json `revision`
  unknownModel: boolean                      // true when the default rate was used
}
```
Every surface that prints money prints `~` before an estimate and a `default rate` badge when `unknownModel` is true. Server (`sessionPresentation.js`) and browser (`TokenUsage.js`) stay parity-tested.

**F2 — signal provenance and time-in-state** (producer: 1.1–1.6; consumers: `StatusResolver`, `AttentionService`, Dashboard rows, Activity Panel header, permission inbox)
```
signalSource: 'transcript' | 'hook',         // which source produced turnState/pendingTool
turnStartedAt: number | null,                // ms epoch of the current turn's start, provider-derived
lastTurnDurationMs: number | null,
promptDetail: string | null,                 // ≤200 chars, hook-only, never persisted
```
`awaitingSince` / `pendingSince` are unchanged. A hook overlay may make a state *more* urgent or *fresher*; it may never suppress a transcript-derived `awaiting_input`.

**F3 — working set** (producer: 1.5; consumers: Dashboard rows, Activity Panel, collision advisory)
```
workingSet: [{ path, op: 'read'|'write', at, source: 'transcript'|'hook' }]   // ≤ 16, newest first, home dir stripped
```
Paths are canonicalised (realpath, project-relative when inside `projectPath`); traversal or symlink tricks cannot make two projects look like one.

**F4 — GPU parity for the ground-truth layer** (producer: 2.2; consumers: capture harness, visual QA checklist)
Any effect that carries signal (sun shadow, haze, cloud shadow, water state, wetness, fauna) is either present on **both** the Canvas and WebGL2 paths or documented as Canvas-only in `docs/rendering-baselines.md`. New GPU work is expressed as records in existing bands (`ground:`, overlay-safe scene categories) or as uniforms consumed inside `applyGrade`; never as a new pass before the ladder fix (2.1) has landed.

**F5 — one label scale policy** (producer: 2.4; consumers: `BuildingSprite.drawLabels`, `AgentSprite` name tags, `IsometricRenderer._assignAgentOverlaySlots`)
World labels counter-scale with zoom (`1 / zoom`), exactly as agent name tags already do (`AgentSprite.js:5331-5333`). No second scale policy may be introduced; plaque metrics caches must include the scale mode in their key.

---

## Ballot — how the items were chosen

Each reviewer ranked 8–12 candidates; the coordinator merged duplicates and scored the union by operator impact × feasibility under the guardrails, then verified every retained defect a second time in code or on the live server. Items landed in the plan when at least two reviewers proposed them independently **or** one reviewer proposed them with a verified live defect behind them. The full candidate lists, including the ones not taken, are in the research folder.

| Rank | Item | Proposed by | Live defect verified |
| ---: | --- | --- | --- |
| 1 | Correct pricing plus provenance (0.1) | signal, Sol, coordinator | yes — Fable at the Sonnet default on the live payload |
| 2 | Claude transcript projection: cost, duration, prompt, todos (1.1) | signal, Sol | yes — keys present on disk, unreferenced |
| 3 | Ladder hysteresis (2.1) | rendering, coordinator | yes — 26 s probe never reached FULL; 40 s capture did |
| 4 | GPU parity for the ground-truth layer (2.2) | rendering, coordinator | yes — fauna present in Canvas crop, absent in WebGL crop |
| 5 | Truth hotfixes: `team-member` mislabel, `agentType` leak, Codex abort, Grok cold scan, sync git (0.2–0.4) | signal | yes — all reproduced on the live payload or in code |
| 6 | Hook ingestion overlay and permission inbox (1.6) | signal, Sol | n/a — new capability |
| 7 | Codex `item_completed` and approval policy (1.2) | signal, Sol | yes — keys on disk, unreferenced |
| 8 | Overlay collisions, boot status line, single empty state, toast CSS (0.5) | UI, rendering, coordinator | yes — every capture with the panel open |
| 9 | Path and filename display (3.2) | UI, coordinator | yes — eleven rows of `/Users/…/shar…` in the live Dashboard |
| 10 | Activity Panel operations-first (3.3) | UI, Sol | yes — Tool History below the fold at 1080p |
| 11 | Attention lights and stepped night grade (2.3) | rendering | n/a |
| 12 | Plaque scale and nameplate folding (2.4) | rendering, Sol, coordinator | yes — 450 px plaque at zoom 3, ten-pill pile at the gate |
| 13 | Type floor and legibility (3.1) | UI | yes — 14 sub-floor sizes, `--font-pixel` undefined |
| 14 | Exception-first Dashboard and one place for detail (3.4) | Sol, UI | yes — same tool list rendered twice |
| 15 | Working set and collision advisory (1.5) | Sol, signal | n/a |
| 16 | Turn state for Kimi, OpenCode, OMP plus `turnStartedAt` (1.3, 1.4) | signal | yes — `unknown` on the live Codex row |
| 17 | Settings & Health surface (3.5) | UI, coordinator | yes — read-only inline-styled settings |
| 18 | Keyboard-first navigation, contrast, docs drift (3.6, 3.7, 0.6) | UI, Sol, signal | yes |

---

## Wave 0 — Truth hotfixes (ship as `v0.37.x` hotfixes; each item S)

Nothing in this wave adds behaviour. Each item corrects a verified lie or a verified collision and can ship on its own.

### 0.1 Current pricing with provenance
**Owner:** `claudeville/src/config/model-pricing.json`, `claudeville/adapters/sessionPresentation.js`, `claudeville/src/domain/value-objects/TokenUsage.js`, `scripts/tests/r2-02.pricing.test.mjs`, `docs/design-decisions.md` (Static pricing entry) · **Size:** S

**What the operator sees.** A Fable, Opus 5, Sonnet 5 or Haiku 4.5 session shows a cost that matches the provider's published rate. Every money figure carries `~` when estimated. A model the table does not know shows a small `default rate` badge instead of a confident number.

**Why it carries signal.** Cost is the one number in ClaudeVille an operator may act on financially. Today it is silently wrong by 3× in both directions.

**Evidence (verified).** `ratesForModel` falls to `pricing[tableKey].default` with no marker (`sessionPresentation.js:109-127`); `decorateSessionPresentation` emits a bare number (`:262-273`); `model-pricing.json` `claude.rates` = `opus 15/75`, `sonnet 3/15`, `haiku 0.8/4`, no `fable`; live `/api/sessions` shows `claude-fable-5-1` and `claude-fable-5` priced at `3/15`. The browser duplicate at `TokenUsage.js:16-73,175-211` is parity-tested at `r2-02.pricing.test.mjs:36` but only against fixture model names (`:24`).

**Work.**
1. Add a top-level `"revision": "2026-09-01"` and rewrite `claude.rates` as an ordered, most-specific-first list. Substring matching is `candidate.includes(match)`, so specific ids must precede family words:
   ```json
   "claude": {
     "default": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheCreate": 3.75 },
     "rates": [
       { "match": "fable-5",   "input": 10, "output": 50, "cacheRead": 1.0,  "cacheCreate": 12.5 },
       { "match": "mythos-5",  "input": 10, "output": 50, "cacheRead": 1.0,  "cacheCreate": 12.5 },
       { "match": "opus-5",    "input": 5,  "output": 25, "cacheRead": 0.5,  "cacheCreate": 6.25 },
       { "match": "opus-4-8",  "input": 5,  "output": 25, "cacheRead": 0.5,  "cacheCreate": 6.25 },
       { "match": "opus-4-7",  "input": 5,  "output": 25, "cacheRead": 0.5,  "cacheCreate": 6.25 },
       { "match": "opus-4-6",  "input": 5,  "output": 25, "cacheRead": 0.5,  "cacheCreate": 6.25 },
       { "match": "sonnet-5",  "input": 2,  "output": 10, "cacheRead": 0.2,  "cacheCreate": 2.5 },
       { "match": "sonnet-4-6","input": 3,  "output": 15, "cacheRead": 0.3,  "cacheCreate": 3.75 },
       { "match": "haiku-4-5", "input": 1,  "output": 5,  "cacheRead": 0.1,  "cacheCreate": 1.25 },
       { "match": "opus",      "input": 15, "output": 75, "cacheRead": 1.5,  "cacheCreate": 18.75 },
       { "match": "sonnet",    "input": 3,  "output": 15, "cacheRead": 0.3,  "cacheCreate": 3.75 },
       { "match": "haiku",     "input": 0.8,"output": 4,  "cacheRead": 0.08, "cacheCreate": 1 }
     ]
   }
   ```
   Input and output figures are Anthropic's first-party API rates as of the coordinator's reference (cached 2026-06-24). The cache columns above use the conventional multipliers (cache write 1.25× input, cache read 0.1× input) and **must be checked against the live Anthropic pricing page in the same commit**; Fable 5.1's cache-read rate is documented separately from the family rule and may differ. Do the same review for `openai.rates` (`gpt-5.6-*`) and for the Kimi, Grok, Gemini and DeepSeek tables, and record the source URL and date in `docs/design-decisions.md`.
2. `ratesForModel` returns `{ rate, match, isDefault }` instead of the bare rate; `estimateCost` returns `{ usd, rateMatch, unknownModel }`; `decorateSessionPresentation` emits both `estimatedCost` (unchanged) and the **F1** `cost` object with `rateRevision` from the JSON.
3. `TokenUsage.js` mirrors the same shape; the parity test asserts both implementations agree on `usd`, `rateMatch` and `unknownModel`.
4. New test in `r2-02.pricing.test.mjs`: for every model id in `scripts/adapters/fixtures/**` **and** a maintained list of live ids (`claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `gpt-5.6-sol`, `gpt-5.6-luna`), `unknownModel === false`. Add a second assertion that an unknown id (`claude-zeta-9`) resolves with `unknownModel === true`.
5. Display: `ActivityPanel` (`:860,1380`), `DashboardRenderer` (`:984`) and `TopBar` (`:822,862`) print `~$4.28` for estimates and add a `title` naming the rate match and revision; a `default rate` chip when `unknownModel`.

**Acceptance.** `/api/sessions` for a Fable session reports `cost.rateMatch === 'fable-5'` and `usd` equals input×10 + output×50 per MTok plus the verified cache terms. No money figure on any surface is unlabelled. Unit tests pass under `npm run test:unit`.

**Risk.** None technical. Price drift is the ongoing risk; the `revision` string and the Settings row in 3.5 make staleness visible.

### 0.2 Claude session identity truth
**Owner:** `claudeville/adapters/claude.js`, `claudeville/adapters/README.md`, `scripts/tests/` (new `claude-identity.test.mjs`) · **Size:** S

**What the operator sees.** A main Claude session that has been running for more than ten minutes stays a main villager. Subagents show `sub-agent` as their type and their kind (`general-purpose`, `Explore`) as a separate field.

**Evidence (verified live).** `claude.js:1761-1773` drops history entries older than `HISTORY_SCAN_MS` (10 min); the orphan pass then tags every still-active transcript `agentType: 'team-member'` with `teamName: null` (`:2013`). On the live payload one Claude main session is reported `team-member` with `parentSessionId` absent and no `~/.claude/teams`. `claude.js:681-683` stores `input.subagent_type` verbatim as `agentType`; live payload shows `agentType: 'general-purpose'`, outside the five-value enum documented in `adapters/README.md`. `Agent.isSubagent` is `agentType !== 'main'` (`domain/entities/Agent.js:141`), so a long-running main session is treated as a subordinate everywhere.

**Work.** Keep a bounded identity cache keyed by session id (`sessionId → { agentType, project, firstSeenAt }`) populated whenever an entry *is* inside the history window, and consult it before the orphan pass labels a transcript. Only transcripts that were never seen in history and have no `teams/` membership may become `team-member`. For `Agent` launches emit `agentType: 'sub-agent'` and `subagentKind: input.subagent_type`. Update the README enum. Tests: fixture with a history entry older than 10 min plus a live transcript stays `main`; a launch with `subagent_type: 'Explore'` yields `sub-agent` + `subagentKind`.

**Acceptance.** No live main session reports `team-member`; `agentType` on `/api/sessions` is always one of the documented values; sidebar grouping and `Agent.isSubagent` behave accordingly.

### 0.3 Codex turn-state truth
**Owner:** `claudeville/adapters/codex.js`, `scripts/tests/turn-state.test.mjs` (extend) · **Size:** S

**Evidence (verified).** `turn_aborted` is never referenced in `codex.js` (0 matches); an Esc-aborted call keeps `pendingTool` set and, because `deriveTurnState` checks `pendingTool` before `turnEnded` (`turnState.js:146,163`), it outranks a later `task_complete` and becomes a false "needs you" at 240 s. When neither boundary event is inside the 50-line summary window (`SUMMARY_SCAN_LINES`, `codex.js:44`) the adapter returns `known:false` (`:683`); a live `gpt-5.6-sol` session 30 s old reported `turnState: 'unknown'` and fell back to mtime timing.

**Work.** Treat `turn_aborted` as clearing every pending call; remember the last boundary event per rollout in the existing identity cache (`codex.js:341-355`) so a long turn stays `working` when its `task_started` scrolls out of the window. Add fixtures: abort after a pending call; 60 `token_count` lines after `task_started`.

**Acceptance.** Both fixtures yield `working`/`idle` as appropriate and never `unknown` or a false `tool_pending`.

### 0.4 Cold-scan and hot-path hygiene
**Owner:** `claudeville/adapters/grok.js`, `claudeville/adapters/opencode.js`, `claudeville/adapters/omp.js`, `claudeville/adapters/gitEvents.js`, `claudeville/adapters/kimi.js` · **Size:** S each; may be split across workers by file

**Evidence (verified).** Grok reads and parses every historical `summary.json` before the age test (`grok.js:704-710`), the exact shape `v0.37.0` fixed for OMP. OpenCode's parts query has no time predicate (`opencode.js:360-374`) while its session query is cutoff-bounded (`:66-69`). OMP's detail path re-parses every transcript on an index miss with no mtime gate (`omp.js:536-542`). `createGitEvent` calls `currentBranch()` → synchronous `execFileSync` on a cache miss inside the session-list hot path even with the async worker enabled (`gitEvents.js:1446,1453 → 1806-1831`). Kimi Code walks every historical session per pass and reads each active wire three times (`kimi.js:1260-1291,1380-1411`).

**Work.** Grok: `statSync` the session directory and summary before opening, mirroring `omp.js:475-496`, and add `getPerfStats` like OMP. OpenCode: add `time_created >= cutoff` (or the schema's equivalent) to the parts query. OMP: gate the detail rescan on directory mtime. `gitEvents`: on a branch-cache miss return `branch: null` immediately and enqueue the worker refresh; never spawn on the list path. Kimi: one shared tail read per wire per pass and a cached project map (`buildProjectPathMap`, `kimi.js:502-531`).

**Acceptance.** With the activity threshold set to zero, Grok, OpenCode and OMP open no session files; `/api/perf` shows zero synchronous git commands during a warm list refresh; `scripts/smoke/adapters.mjs` and `validate:quick` pass.

### 0.5 Fixed overlays, the boot line, the double empty state, and unstyled toasts
**Owner:** `claudeville/css/character.css`, `claudeville/css/layout.css` (or new `css/toast.css`), `claudeville/css/modal.css`, `claudeville/index.html`, `claudeville/src/presentation/App.js`, `claudeville/src/presentation/character-mode/IsometricRenderer.js` (delete `_drawEmptyStateWorldCue` only), `claudeville/src/presentation/character-mode/WorldFrameRenderer.js` (its two call sites) · **Size:** S · integration-surface item, single owner

**What the operator sees.** The first-run hint and the World Controls popover never cover the Activity Panel. "WATCHING N AGENTS" disappears from the canvas once the village is live. The no-agents world shows one parchment card, in the DOM, with the building legend. The first toast is a framed toast, top-right, not raw yellow text bottom-left.

**Evidence (verified).** `.first-run-hint { position: fixed; top: 63px; right: 167px; width: 300px }` (`character.css:89-93`) and `.world-grammar { inset: 58px 174px auto auto; width: 310px }` (`:157`) both sit inside the 320 px panel (`activity-panel.css:4`); every capture with the panel open shows the hint covering the selected agent's name. `#bootStatusWrap` is created fixed at top 58 px (`App.js:768-800`), receives `WATCHING N AGENTS` from `VillageState.js:225-232`, and is only removed on destroy (`App.js:1694`); it overlaps the Command keep and the Portal and Mine plaques. Two empty cards: canvas `_drawEmptyStateWorldCue` (`IsometricRenderer.js:10011-10059`, called at `WorldFrameRenderer.js:670,741`, off-palette `#121822`/`#8bd7ff`) and DOM `#worldEmpty` (`index.html:148-152`, `App.js:871-881`). Toast rules live only in the lazily loaded `modal.css:86-165`; `Toast.js:330-339` renders before any modal is opened.

**Work.** `body.cv-panel-open .first-run-hint, body.cv-panel-open .world-grammar { right: calc(167px + 320px) }` following the precedent at `modal.css:99-101`. In `_renderVillageSurfaces`, set `wrap.hidden = true` when `phase === READY_LIVE` and keep a visually hidden `role="status"` for the announcement; the top bar already carries the count. Delete the canvas card and its call sites; add a `<dl class="world-empty__legend">` (Forge / Archive / Harbor / Mine) to `#worldEmpty`, painted from `EMPTY_SURFACE_COPY` (`App.js:62-93`) for `READY_EMPTY` only. Move `.toast*` rules into an always-loaded stylesheet.

**Acceptance.** With the panel open, no fixed overlay intersects `#activityPanel` (assert with `getBoundingClientRect` in a Playwright check). After the first live snapshot, no DOM text sits over the canvas except `#worldEmpty` when empty. The `no-agents` scenario shows exactly one card and no `#121822` pixels. A fresh load with no modal ever opened renders the first toast framed, top-right.

### 0.6 Layering and documentation drift
**Owner:** `claudeville/src/application/AgentManager.js`, new `claudeville/src/domain/services/VerifiedOutcome.js`, `claudeville/src/presentation/character-mode/ChronicleEvents.js` (re-export shim), `README.md`, `claudeville/CLAUDE.md`, `agents/README.md`, `agents/plans/open-followups.md`, `agents/plans/claudeville-council-enchantment-plan.md` (status line only) · **Size:** S

**Evidence (verified).** `AgentManager.js:7-13` imports `createVerifiedOutcome…VERIFIED_OUTCOME_EVENT` from `presentation/character-mode/ChronicleEvents.js`, the inversion `docs/design-decisions.md` forbids. `README.md:3,21` says `v0.30.0` and lists six providers with no OMP while `package.json` is `0.37.0` and `claudeville/CLAUDE.md:31` documents OMP. `claudeville/CLAUDE.md:28,44` and `README.md:205` say the list cache is 5 s; `adapters/index.js:51` is 2000 ms. `agents/README.md:20` and the council plan header read `proposed — not started` although `CHANGELOG.md` `v0.36.0` records its items as shipped. `open-followups.md` cites `adapters/index.js:147` for the sync git call (actual `:210-216`), says `agents/README.md` is absent (it exists), and dates itself at `v0.33.3`. `AGENTS.md:7` says there is no CI while `.github/workflows/ci.yml` exists; this plan does not resolve that policy contradiction and does not touch `.github/`, but the sentence must stop claiming there is none.

**Work.** Move the pure verified-outcome helpers to `src/domain/services/VerifiedOutcome.js`; `ChronicleEvents.js` re-exports them so presentation callers are untouched. Fix the numbers and statuses above. Keep the root `CLAUDE.md`/`AGENTS.md` parity diff empty.

**Acceptance.** `rg "presentation/" claudeville/src/application claudeville/src/domain` returns nothing. `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` is empty. README version equals `package.json`.

---

## Wave 1 — Signal the operator can act on

### 1.1 Claude transcript projection: authoritative cost, turn duration, prompt, plan
**Owner:** `claudeville/adapters/claude.js`, `claudeville/adapters/README.md`, `scripts/adapters/fixtures/claude/` (new fixture), `scripts/tests/claude-projection.test.mjs` (new) · **Size:** S/M · depends on 0.1 for **F1**

**What the operator sees.** For a Claude session: the CLI's own dollar figure (labelled `provider`), lines added and removed, exact duration of the last turn, the prompt the agent is answering (one truncated line), the current todo list with the active item, the git branch, and a hook-error count when hooks failed. Model or effort changes mid-session are visible in the panel history.

**Evidence (verified on disk, keys only).** Transcripts on this machine contain `type:"cost-state"` (`totalCostUSD`, `modelUsage`, `hasUnknownModelCost`, `totalLinesAdded`, `totalLinesRemoved`, `totalAPIDuration`, `totalToolDuration`), `type:"system", subtype:"turn_duration"` (`durationMs`), `type:"last-prompt"` (`lastPrompt`), `subtype:"stop_hook_summary"` (`hookCount`, `hookErrors`, `preventedContinuation`), per-entry `gitBranch`, `effort`, and `TodoWrite` inputs whose `todos` are read only for dialogue (`claude.js:1229-1237`). `rg` for those keys in `claude.js` returns only `thinking`/`isSidechain` (`:268,309,1171,1240,1338`). `contextWindow` is recomputed from the latest assistant entry (`:669`) and Claude has no `contextWindowMax`.

**Work.** In the tail projection that already walks entries (`claude.js:660-690`), capture the records above with `typeof` guards (their shapes are undocumented and may change). Emit session fields: `cost` per **F1** with `source: 'provider'` when `cost-state` is present, `linesAdded`, `linesRemoved`, `lastTurnDurationMs`, `lastPrompt` (≤200 chars, never persisted), `todos: [{ subject, status }]` (≤12), `gitBranch`, `hookErrors`, `modelHistory: [{ model, effort, at }]` (≤8), and `contextWindowMax` from a static model→window table beside the pricing table (1M for the Claude 5 family and Opus 4.6+, 200K for Haiku 4.5; verify). `sessionPresentation.js` prefers `cost.source === 'provider'` over the estimate. Fixture: a synthetic transcript with all record kinds; test that each projected field appears and that a transcript without them falls back to the estimate.

**Acceptance.** `/api/sessions` for a live Claude session shows `cost.source: 'provider'`, `lastTurnDurationMs > 0`, `gitBranch` and a non-empty `todos` array when the CLI has one. No prompt text longer than 200 chars leaves the adapter; nothing is written to `ChronicleStore`.

### 1.2 Codex `item_completed`, approval policy, and file changes
**Owner:** `claudeville/adapters/codex.js`, `scripts/adapters/fixtures/codex/` (extend), `scripts/tests/turn-state.test.mjs` (extend) · **Size:** M

**What the operator sees.** For a Codex session: exact tool durations and exit codes (a failing `npm test` shows the same warning chip Kimi and OpenCode already get), the files the agent changed this turn, and no false "needs approval" when Codex runs under full-auto.

**Evidence (verified on disk).** `event_msg/item_completed` carries `item.type ∈ {Reasoning, CommandExecution, AgentMessage, FileChange}`, `status`, `exit_code`, `duration`, `started_at_ms`, `completed_at_ms`, `changes`, `cwd`; `turn_context` carries `approval_policy`, `sandbox_policy`, `permission_profile`, `workspace_roots`. `codex.js` has zero references to any of these. Only Codex, Kimi and OpenCode carry `toolExitCode` today; Claude carries none (`toolUseResult` unread, see 1.5).

**Work.** In the summary walk (`codex.js:643-690` neighbourhood), handle `event_msg.item_completed`: `toolHistory` rows gain `durationMs` and `toolExitCode`; `FileChange.changes` feed **F3**. Map `approval_policy` full-auto / never-ask to `permissionMode: 'bypassPermissions'` so `classifyPendingTool` (`turnState.js:95-111`) suppresses prompts exactly as it does for Claude. Keep all fields optional; schema churn is expected.

**Acceptance.** A rollout fixture with an `exit_code: 1` command produces a `toolExitCode: 1` row and the Dashboard warning chip; a full-auto rollout with a 5-minute Bash never produces `waitReason: 'approval'`.

### 1.3 Turn state for Kimi Code, OpenCode and OMP through `turnState.js`
**Owner:** `claudeville/adapters/kimi.js`, `claudeville/adapters/opencode.js`, `claudeville/adapters/omp.js`, `scripts/tests/turn-state.test.mjs` · **Size:** S each; parallelisable by file

**Evidence (verified).** Kimi already pairs tool calls and results by `callId` (`kimi.js:1057-1075`) yet emits no `turnState`; OpenCode projects `$.state.status` including `'running'` (`opencode.js:343`) and emits none; OMP hand-rolls `tool_pending` / `awaiting_input` / `unknown` at `omp.js:325-327`, never `working`, never `waitReason`, bypassing `classifyPendingTool`. All three fall to mtime timing (`AgentStatus.js:26-29`) and flip to `waiting` at 30 s and `idle` at 120 s while generating.

**Work.** Each adapter builds the small descriptor `turnState.js` expects (`pendingTool`, `pendingSince`, `turnEnded`, `permissionMode`) and calls `deriveTurnState`. Providers that never prompt pass `permissionMode: 'bypassPermissions'`. OMP's inline branch is replaced.

**Acceptance.** Fixtures per provider: a pending tool yields `tool_pending`; a closed turn yields `awaiting_input`; no provider reports `unknown` while a tool is open.

### 1.4 Time in state everywhere
**Owner:** `claudeville/adapters/claude.js`, `claudeville/adapters/codex.js`, `claudeville/adapters/index.js` (normaliser), `claudeville/src/domain/entities/Agent.js`, `claudeville/src/presentation/shared/ActivityPanel.js`, `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`, `claudeville/src/presentation/shared/Sidebar.js` · **Size:** S

**What the operator sees.** "Working for 4m12s", "Waiting on you for 38s", "Idle 6m" next to every status pill, in the sidebar row, the Dashboard card and the panel header. The village's oldest wait is the loudest.

**Evidence.** No `workingSince`/`statusSince` exists anywhere in `src/` or the adapters (`rg` empty except `MarkGovernor` dwell timers); `awaitingSince`/`pendingSince` exist. Claude's turn start is the last non-tool-result user entry already located at `claude.js:1359-1370`; Codex's is `task_started` (`codex.js:660`).

**Work.** Emit `turnStartedAt` per **F2**; `Agent` exposes `statusSince` derived on the client from `turnStartedAt`, `awaitingSince`, `pendingSince` and `lastActive`; a shared `formatElapsed(ms)` in `Formatters.js`; one `setInterval` at 1 Hz shared by the three surfaces, patching text nodes only (the sidebar already patches instead of rebuilding since `v0.37.0`).

**Acceptance.** Elapsed text updates once per second with zero node creation; a `waiting_on_user` agent shows its wait age in all three surfaces and the `A` key still visits oldest-first.

### 1.5 Working set and collision advisory
**Owner:** `claudeville/adapters/claude.js`, `claudeville/adapters/codex.js`, `claudeville/adapters/index.js`, `claudeville/services/workingSet.js` (new, pure), `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`, `claudeville/src/presentation/shared/ActivityPanel.js`, `scripts/tests/working-set.test.mjs` (new) · **Size:** M · depends on 1.2 for Codex, on **F3**

**What the operator sees.** Each agent lists the last files it read or changed. When two live agents in the same project both *write* the same file, both rows show `OVERLAP: router.ts with Nova` and the Dashboard attention strip gets a `collision` entry. Read/write overlap is advisory (muted), read/read is silent.

**Why it carries signal.** Sol's finding: parallel agents most dangerously *succeed incompatibly*. The data already exists; Claude's `Edit`/`Write` `file_path` is projected only into a 60-character `lastToolInput` string (`CLAUDE_TOOL_INPUT_FIELDS`, `claude.js:63-89`), and Codex's `FileChange.changes` is unread.

**Work.** Adapters emit `workingSet` per **F3** from `Edit`/`Write`/`Read`/`apply_patch`/`FileChange` (≤16 entries, canonicalised, home-stripped, project-relative). `services/workingSet.js` exports `detectCollisions(sessions) → [{ path, project, agents: [id], kind: 'write-write'|'read-write' }]`, bounded per project, computed once per collection in `collectSessionsForClients()` and attached to the payload as `collisions`. Ended sessions age out with the departed grace. Dashboard rows and the panel render the set and the advisory; the World gets nothing new (a collision is not a status).

**Acceptance.** Fixture: two sessions writing the canonical same path yield one `write-write` collision; a symlinked path outside the project does not join it; unavailable data reads "no file activity recorded", never "0 files".

### 1.6 Hook ingestion overlay and the exact permission inbox
**Owner:** `claudeville/server.js` (route table `:2588-2598` and `readJsonBody`), new `claudeville/adapters/hooks.js`, `claudeville/adapters/index.js` (merge point after `normalizeSession`, `:342`), `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js` (attention queue rows), `claudeville/src/presentation/shared/ActivityPanel.js` (blocked banner), `docs/design-decisions.md`, `docs/troubleshooting.md`, `claudeville/CLAUDE.md` (API list), `scripts/tests/hook-overlay.test.mjs` (new), `scripts/smoke/server-security.mjs` (extend) · **Size:** M (route + overlay + inbox); the OTLP receiver is **deferred**, see the killed table

**What the operator sees.** With a one-line hook stanza in the CLI's settings, a blocked permission prompt appears within half a second as `Claude · pharos-watch needs Bash approval · npm test · 28 s`, with the command or path (sanitised, ≤200 chars) and a `HOOK` provenance chip. Without hooks, everything looks exactly as today except a `TRANSCRIPT · inferred` chip on wait states. No approve button; the terminal remains the only place to answer.

**Why it carries signal.** File tailing cannot see the prompt. `classifyPendingTool` is a dwell-time and tool-name heuristic (`turnState.js:9-10,64-68`): ASK/PLAN tools blocked instantly, INSTANT tools after 15 s, everything else after 240 s, so a `Bash npm test` that hangs for five minutes is reported as "needs approval" and a genuine prompt on a slow tool is reported late. Claude Code, Codex CLI and Gemini CLI all document lifecycle hooks in 2026; only their exact payload field names are **unverified** here and must be read from the current docs before coding.

**Work.**
1. `POST /api/ingest/hook`: body via the existing `readJsonBody` (256 KiB cap); guarded by `validateLocalRequest` with `requireOrigin: false` (hooks are local shell processes with no Origin header; loopback bind at `server.js:40` is the boundary); optional `CLAUDEVILLE_INGEST_TOKEN` env checked as a header; rejects unknown providers, oversized bodies, non-POST; never logs the body.
2. `adapters/hooks.js` is an **overlay**, not a provider: `ingest({ provider, sessionId, cwd, ts, kind, tool, input, decision })`, `overlayFor(sessionId) → { turnState, pendingTool, pendingSince, waitReason, promptDetail, signalSource: 'hook', lastHookAt } | null`, `prune(now)`. Bounded map (≤256 sessions), entries expire 30 s after the last event, in memory only.
3. Merge in `getAllSessions` after `normalizeSession`: an overlay younger than 10 s that is *more urgent or fresher* than the transcript state wins; it never suppresses a transcript-derived `awaiting_input`. Set **F2** fields. Ingestion calls `markProviderDataDirty` (`server.js:1310`) and `debouncedBroadcast()` (`:1660`) so the delta path ships it.
4. UI: the Dashboard attention queue rows (`DashboardRenderer.js:649-673`) and the panel header show `promptDetail` and the provenance chip; secrets are never rendered (strip tokens matching `[A-Za-z0-9_-]{32,}` and `key=`/`token=` pairs before display).
5. Docs: a `design-decisions.md` entry "Push ingestion is optional, loopback-only and overlay-only"; a sample hook stanza using `curl --max-time 1 -s -X POST http://127.0.0.1:4000/api/ingest/hook` so a stopped dashboard never blocks the CLI; ClaudeVille **never edits provider config**.
6. Tests: overlay precedence, expiry, size caps, unknown provider rejected, prompt truncation, secret stripping; smoke covers Host/Origin/size/method on the route.

**Acceptance.** With hooks configured, a permission prompt shows `waitReason: 'approval'`, `signalSource: 'hook'` and a `promptDetail` on `/api/sessions` within 500 ms of the hook firing. With hooks absent, `/api/sessions` is byte-identical to today apart from `signalSource: 'transcript'`. A malformed, oversized or non-loopback request is rejected without a stack trace in the response.

**Risk.** A second truth source can disagree with the transcript; the overlay expires fast and only escalates. A hook misconfiguration can slow the CLI; the documented stanza is fire-and-forget with a one-second timeout.

---

## Wave 2 — Light that reaches the screen

### 2.1 Make the quality ladder reach FULL on healthy hardware
**Owner:** `claudeville/src/presentation/character-mode/postfx/PostFxLadder.js`, `claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js` (reason vocabulary only), `scripts/tests/postfx-ladder.test.mjs` (new or extended), `scripts/smoke/world-fps-benchmark.mjs` (report the level timeline) · **Size:** S · **highest visual impact per line**

**What the operator sees.** Sixteen admitted lights instead of four, occlusion shadows, emissive bloom and wet materials from the first seconds after boot: the work `v0.36.0` shipped.

**Evidence (verified by probe on the reference machine, ANGLE Metal, dense-24, 1080p).** Boot at level 2 (MINIMAL: 4 lights, no occlusion pass, no bloom, weather zeroed) for the first 10 s, level 1 from 11 s, one `over-budget:gpuMs` excursion at 20 s (a single 4.66 ms frame), level 0 only from 29 s; the rendering reviewer's independent 26 s probe never saw level 0 at all. Full timeline in `ladder-timeline.md` in the research folder. `lastScore` 1.15–3.27 ms with driver `gpuMs`. Policy: `budgetMs 4, healthyMs 2, overBudgetFrames 60, probeMs 5000` (`PostFxLadder.js:22-27`); a single frame ≥ `healthyMs` sets `healthySinceMs = null` (`:181-197`). `overBudgetFrames` is counted in frames, so 60 frames is half a second at 120 Hz. Level 3 clamps to MINIMAL while reporting `disabled:*` (`GpuWorldRenderer.js:1177-1180`; `PostFxLadder.js:172-174`).

**Work (pure, unit-testable).** (a) Count over-budget by elapsed milliseconds, not frames. (b) Score on a rolling median of the last N frames, not the last frame. (c) Recovery threshold relative to budget (`healthyMs = budgetMs × 0.75`) and require K consecutive over-threshold frames before resetting `healthySinceMs`. (d) Ignore upload-driven scores for ~3 s after `show()` and after a texture `storageChanged` burst (boot sheets are ~6 MB each, `AgentSprite.js:3735-3746`), or snap back to FULL when `_frameUploadMs` has been 0 for 1 s. (e) Distinguish `minimal-resident` from `disabled` in `lastDecisionReason` so `frameHealth` stops saying the GPU is off while it is drawing. **Do not raise `budgetMs`**; the failure is hysteresis, and raising the budget would hide genuine overload on integrated GPUs.

**Acceptance.** On the reference machine, dense-24 at 1080p: `qualityLevel === 0` within 10 s of boot and at most one transition per minute afterwards; `lights === 16` at night. Ladder transition tests in `scripts/tests/`. The `frameHealth` fields cited by the capture harness are unchanged.

### 2.2 GPU parity for the ground-truth layer
**Owner:** `claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js`, `claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js` (one water branch, cloud-shadow uniform), `claudeville/src/presentation/character-mode/WorldFrameRenderer.js` (gating), `claudeville/src/presentation/character-mode/WildlifeRenderer.js` and `HarborTraffic.js` (scene-category pattern), `docs/rendering-baselines.md` · **Size:** M · depends on 2.1; per **F4**

**What the operator sees.** Buildings cast a sun shadow that turns through the day; mist lies on the river when you pan; cloud shadows cross the island; water shimmers and reflects at night; gulls and waterfalls exist. All of it on the WebGL2 path every operator runs.

**Evidence (verified).** `_drawTerrain`, `drawCloudShadows`, `drawGroundFog` inside `if (!gpuWorldActive)` (`WorldFrameRenderer.js:497-510`); `drawBuildingLightReflections` (`:532`); `drawShadows` (`:535`); wetness marks (`:643`); structure and tower shadows are Canvas 2D only (`BuildingSprite.js:611-660`); the GPU record list has terrain, buildings, props, agents and agent ground shadows and nothing else (`GpuSceneBuilder.js:992-1028`). Fauna is drawn to the base `ctx` with no GPU guard (`:515-522`, `WildlifeRenderer.js:38-46`) under the opaque GPU island; the rendering review's paired crops at one camera pose show waterfowl on the Observatory pond in `canvas` and none in `webgl`.

**Work, all additive.** (1) Building shadow records: one `ground:building:<id>` record per building from `recordForBuilding`, sourced from a stamped-ellipse texture like the agent ground-shadow bake (`GpuSceneBuilder.js:536-568`), offset by `lighting.shadowAngleRad` / `shadowLength` exactly as `_drawStructureShadow`; tower casts as 3–4 fading stamps; sorted into the existing `ground:` band (`:1018-1022`). (2) Haze: `ensureHazeField` already produces a quarter-resolution canvas; emit it as one `ground:haze` record with additive blend and alpha = field strength, after terrain and before buildings. (3) Cloud shadows: a `u_cloudShadow[3]` uniform evaluated in `applyGrade` on earth / foliage / cobble materials. (4) Water: a `material == 8.0` branch driven by the existing `u_time`, `u_motionScale`, `u_weather` uniforms: ordered-dither two-tone shimmer, phase tint from `u_gradeBase`, storm roughness from `u_weather.z`; static under reduced motion (`u_motionScale == 0` already yields a fixed phase). (5) Fauna and waterfalls: route through an overlay-safe scene category like `HARBOR_TRAFFIC_SCENE_CATEGORY` (`HarborTraffic.js:181-194`) so they draw on the overlay canvas above the island.

**Acceptance.** `npm run world:capture-render-baselines` records `webgl` and `canvas` for `north-star-clear-day` and `torchlit-night`; the two differ only in shader-grade tone, not in the presence of shadows, haze or fauna. Frame cost of items 1–3 is 3–12 quads; item 4 is a per-fragment branch on water pixels only; the total stays inside the 1.00 ms council reserve on the reference machine and is measured on an integrated GPU before release.

### 2.3 Lights that carry attention, and a stepped night
**Owner:** `claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js` (light admission and one exported grade table), `claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js` (`MAX_LIGHTS`, `applyGrade`), `claudeville/src/presentation/character-mode/IsometricRenderer.js` (light sources `:10184-10200`, grade table `:144-149`), `claudeville/src/presentation/character-mode/postfx/PostFx.js` (grade table `:17-22`), `claudeville/src/presentation/character-mode/MarkGovernor.js` (`PRESSURE_PROTECTED`) · **Size:** S + S · depends on 2.1

**What the operator sees.** At night the agent that needs you is the brightest warm pool in the village; an errored agent is a cold red pool; a quota stop a dim amber one. This survives at overview zoom where nameplates do not. Night reads darker at the ground and warmer at the pools, with dithered banding that matches the art instead of a flat blue multiply.

**Evidence.** Light admission is `priority → intensity → id` (`GpuWorldPolicy.js:234-244`) with `MAX_LIGHTS = 16` (`GpuWorldRenderer.js:18`); relationship, mote, arrival, gate and lantern lights already compete for those slots. Three duplicated grade tables (`GpuWorldRenderer.js:28-32`, `PostFx.js:17-22`, `IsometricRenderer.js:144-149`); night base `[0.50, 0.59, 0.77]` (luminance ≈ 0.58 of day) plus a smooth vignette; wetness already uses a 4-pixel ordered dither (`:121`).

**Work.** Add an `attention` light source per `SignalLedger` bucket (`needsYou`, `errors`, `quota`) with priority above every ambient source, colours from the existing attention palette; raise `MAX_LIGHTS` to 32 (the loop already early-exits); extend `PRESSURE_PROTECTED` so attention lights never shed. Then, and only then, quantise `applyGrade` output to three luminance bands with the wetness dither, lower the night base toward `[0.40, 0.48, 0.66]`, step `u_edgeAlpha`, and unify the three tables into one exported constant consumed by all three paths.

**Acceptance.** The `needs-user` night capture shows exactly one dominant amber pool; dense-100 keeps every attention light admitted; the torchlit-night north-star still is re-approved by the maintainer; primary marks (drawn post-grade on the overlay, `WorldFrameRenderer.js:733-737`) are untouched.

### 2.4 One label scale policy and quieter crowds
**Owner:** `claudeville/src/presentation/character-mode/BuildingSprite.js` (`drawLabels`, `_labelMetrics`), `claudeville/src/presentation/character-mode/WorldFrameRenderer.js:750-754`, `claudeville/src/presentation/character-mode/IsometricRenderer.js` (`_assignAgentOverlaySlots`, `_mergeIdenticalClusterBubbles`), `scripts/smoke/` overlay layout harness (extend) · **Size:** S + M · per **F5**

**What the operator sees.** Plaques stay a readable, constant screen size at zoom 2 and 3 instead of a 450-pixel "CODE FORGE" covering the villagers. At the gate or forge, twenty overlapping name pills become the building chip's `×12` plus names for agents that matter (selected, needs-you, errored, quota, recent event); hover or select expands.

**Evidence.** Plaques draw under `camera.applyTransform(overlayCtx)` with fixed 9 px / 7 px fonts and no inverse scale (`BuildingSprite.js:691-800,1089-1104`; `WorldFrameRenderer.js:750-754`), while name tags counter-scale (`AgentSprite.js:5331-5333`). Slot search caps at 3 (`IsometricRenderer.js:208`) and merge unifies only *identical head lines* (`:5226-5241`), so distinct names never merge; the Metal night and storm captures show eight to ten stacked pills at the forge. Plaques already carry occupancy chips (`shots/97-gpu-night-zoom3.jpg`: "9 agents"). `docs/visual-experience-crafting.md:76-91` says labels are sparse and reserved for landmarks or selected objects.

**Work.** `drawLabels` applies `ctx.scale(1 / zoom)` around the tag exactly like the name tag (keep the stalk in world space); `_labelMetrics` cache key includes the scale mode. In `_mergeIdenticalClusterBubbles`, when a slot-0 cluster exceeds five members and every member is ambient/working tier, fold the ambient names into the nearest building chip (`_buildingOccupancyInfo` already knows the count) and keep primary-tier names; deterministic representative order already exists. Keep the fold behind the existing pressure/annotation mode so calm scenes keep names. Search and the sidebar remain authoritative for folded agents.

**Acceptance.** Plaque tag height in CSS pixels is identical at zoom 1, 2 and 3. Dense-24 at zoom 1 shows at most six name pills per cluster; every `waiting_on_user` / `errored` / `rate_limited` agent keeps its name; the 200-layout randomised harness from `v0.37.0` gains a fold assertion.

### 2.5 GPU lane hygiene (optional, invisible on Apple silicon)
**Owner:** `claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js:178-207,236-243`, `GpuSceneBuilder.js:1017-1022`, `GpuWorldRenderer.js:794-797,887-920,955` · **Size:** S

**Evidence.** Per-frame `.map().filter()`, string joins and batch objects in `buildStableGpuBatches`; three `filter`s and a spread in `buildGpuWorldRecords`; `bufferData(DYNAMIC_DRAW)` per batch, ~197 batches for 240 records; `clampGpuLights` sorts per frame; `_trimTextureCache` walks every entry every frame. Resident textures measured at 104 MB against an advisory 48 MB cap (`GpuWorldRenderer.js:24,794-809`).

**Work.** One VBO sized for the frame, `bufferSubData` once, `drawArrays(first, count)` per batch; reuse batch objects; make the texture cap report honest (`resident` vs `cap`) in diagnostics. **Acceptance.** Zero allocations per frame in the GPU lane; identical pixels; `cpuMs` unchanged or lower.

---

## Wave 3 — Dashboard and panel as instruments

### 3.1 Type floor and legibility
**Owner:** `claudeville/css/reset.css`, `claudeville/css/character.css`, `claudeville/css/sidebar.css`, `claudeville/css/modal.css`, `claudeville/css/topbar.css`, inline `fontSize` in `App.js:768-830,897-907` and `TopBar.js:303-420`, `DESIGN.md` §3 · **Size:** M · integration-surface item, single owner

**What the operator sees.** Headings, banners and the wordmark stay Press Start 2P and never drop below 10 px. Every path, message, chronicle row and meta value is Departure Mono at 12–13 px with a 1.45 line height; `0/O` and `l/1` stop blurring.

**Evidence (verified).** `reset.css:74-79` declares a 10 px floor and "display ≥10 px only"; broken at `character.css:85,121,134,157` (9/9/8/7 px, the whole World Controls popover at 7 px), `sidebar.css:420` (7 px), `modal.css:187-190,387-391,424-428` (8/8/9 px), and inline at `App.js:793,808,825,905`, `TopBar.js:312,416,517,560,600`. `--font-pixel` is referenced five times (`topbar.css:755,785`; `TopBar.js:415,552,599`) and never defined. `-webkit-font-smoothing: none` is applied to `html, body` (`reset.css:105`) rather than to display selectors.

**Work.** Define `--font-pixel: var(--font-display)`; tokens `--fs-body: 13px; --fs-data: 12px; --fs-label: 10px; --lh-body: 1.45`; move smoothing-off to the display selectors only; replace every sub-10 px display usage with a 10 px eyebrow or a 12 px body line; delete inline `fontSize` and move those rules into the stylesheets. Record the two-face system in `DESIGN.md`.

**Acceptance.** `rg -n "font(-size)?:\s*[7-9]px" claudeville/css` returns no display-face hits; no inline `fontSize` remains in `App.js` or `TopBar.js`; the Dashboard tool list at 1920×1080 shows distinguishable filename glyphs; contrast unchanged or better.

### 3.2 Paths that keep the filename
**Owner:** `claudeville/src/presentation/shared/Formatters.js`, `claudeville/src/presentation/shared/AgentPresentation.js`, `claudeville/src/presentation/shared/ActivityPanel.js:1266`, `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:1055`, `scripts/tests/formatters.test.mjs` (new) · **Size:** S

**What the operator sees.** `Edit  …/shared/v4.ts` or, inside the agent's workdir, `shared/v4.ts`; the full path on hover; never a home directory.

**Evidence (verified).** The current tool uses `basenameFile: true` (`adapters/claude.js:1208`) but history uses `basenameFile: false` at 80 chars (`:1290`; same split in `gemini.js:390/441`, `kimi.js:666/715`); the client truncates from the head with `truncateText` (`AgentPresentation.js:260`, `Formatters.js:103-110`) at 45 and 60 chars; `shortenHomePath` (`Formatters.js:77-87`) is applied only to the workdir and project header; CSS end-clips (`dashboard.css:831-833`, `activity-panel.css:437-441`). The live Dashboard capture shows eleven rows of `/Users/ahirice/Documents/git/pharos-watch/shar…`.

**Work.** `export function formatToolDetail(detail, { max = 48, projectPath = '' } = {})`: if `detail` is path-shaped, apply `shortenHomePath`, strip the `projectPath` prefix, then truncate from the head keeping the last two segments; for commands, apply `shortenHomePath` to each absolute token; otherwise `truncateText`. `toolHistoryNodes` gains a `formatDetail` option and sets `title` to the raw detail. Optionally split into muted directory and gold filename spans.

**Acceptance.** Every path-shaped row ends with its filename; no string starting with `/Users/` or `/home/` reaches the DOM; unit tests over POSIX and Windows paths.

### 3.3 Activity Panel: operations first, village second
**Owner:** `claudeville/src/presentation/shared/ActivityPanel.js`, `claudeville/index.html` (panel sections `data-section` keys), `claudeville/css/activity-panel.css` · **Size:** M · consumes **F1**, **F2**, **F3**

**What the operator sees.** After the header: a blocked banner only when blocked (with `promptDetail` when a hook supplied it), then Current Tool, Tool History, Messages, Cost & Tokens (with provenance), the prompt being answered and the todo list (1.1), Working set (1.5), Journey; then a collapsed "IN THE VILLAGE" group with Scene Log, Chronicle / Book of Lives, Harbor Log, Narration and Village Bonds. `Mood` is hidden unless it has a value; `Level` becomes `Effort`; a bond row appears only with evidence.

**Evidence (verified).** Section order is an insertion artefact: each `_ensure*Section` calls `_insertAgentSectionAfterMeta()` (`ActivityPanel.js:2094-2103`), which inserts directly after the meta block, so constructor order `Journey, Narration, HarborLog, Chronicle, DirectorFeed, Relationships, MessageEdges` (`:417-423`) appears reversed; Bonds are spliced before Tool History (`:1919-1921`). `_formatMood` returns `-` unless non-neutral (`:1131-1135`); `_formatAgentLevel` maps reasoning effort (`:1118-1129`). `relationshipLoreLine` prints `Hearth-warm` for every bond (`:311-317`) while `_relationshipRow` labels the same bond `stranger` (`:1978-1993`). In the live capture with an agent selected, TOOL HISTORY and MESSAGES headings sit below y = 1040 at 1080p.

**Work.** Replace `_insertAgentSectionAfterMeta` with an ordered mount: a `SECTION_ORDER` array and `_mountSection(key, el)` inserting before the next present key; give static sections `data-section` keys. Wrap the village sections in `<details class="activity-panel__village">` with a display-face summary, open state persisted beside the pin list. Hide Mood when `-`; rename LEVEL to EFFORT; bonds render only when `tier !== 'strangers' || sharedCommits > 0`, otherwise "No shared work yet."; hide Narration when empty (pattern at `:1440-1445`).

**Acceptance.** At 1920×1080 with an agent selected, Current Tool, at least six Tool History rows and the cost line are visible without scrolling. Section order lives in one array. No bond row with zero evidence; no `Hearth-warm` beside `stranger`.

### 3.4 Exception-first Dashboard, one place for detail
**Owner:** `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`, `claudeville/css/dashboard.css`, `claudeville/src/presentation/shared/ActivityPanel.js` (`mode:changed` subscription only), `claudeville/src/presentation/shared/Sidebar.js` (shared filter) · **Size:** M · consumes **F1**, **F2**, **F3**

**What the operator sees.** Dashboard becomes dense project rows: status with age, provenance chip, model, phase or current tool, blocker (with prompt detail), working set and collisions, tokens, cost with provenance, child progress. One row expands to the full card. Needs-you rows are first and visible on load. In Dashboard mode the selected card expands *in place* and the side panel stays closed; switching back to World reopens the panel for the same selection.

**Evidence.** Every agent gets an avatar, a flat history and a usage block (`DashboardRenderer.js:526-580`), grouped and status-sorted only (`:236-278`); the sidebar already indexes tools and files for search (`Sidebar.js:210-252`); `#activityPanel` is a sibling of `.content` and has no `mode:changed` subscriber, so the live Dashboard capture shows the same tool history and token grid twice side by side; `dashboard.css:770` already says "selection is the explicit diagnostic expansion".

**Work.** Compact row renderer with one expansion, filter chips (needs you / errors / quota / working / provider), stable sorts, sticky project headers, shared search with the sidebar; collapsed off-screen rows do not fetch details. `ActivityPanel._bind()` subscribes to `mode:changed`: on `dashboard` close the panel but keep `currentAgent`; on `character` re-show it.

**Acceptance.** 24 agents across three projects at 1920×1080 need at most one viewport movement; needs-you rows are visible without scrolling; no tool row is rendered twice on screen; focus and selection survive a re-render.

### 3.5 Settings & Health surface
**Owner:** new `claudeville/src/presentation/shared/SettingsPanel.js`, `claudeville/src/presentation/shared/TopBar.js` (replace `_buildSettingsContent` `:303-420`), `claudeville/css/modal.css` (`.settings-*`), `claudeville/css/topbar.css` (meta line, FPS, quota) · **Size:** M · consumes **F1** and the provider health already on `/api/providers`

**What the operator sees.** One modal behind the existing `SET` button with: editable controls (sound, alerts, auto-camera, sidebar, reduced-motion override) driving the existing toggles; a Watchtowers roster per provider (`not installed`, `ready · n sessions`, `empty`, `degraded`, and `hook: live · 0.4 s` once 1.6 lands); a Storage ledger (what survives reload; chronicle degraded notice); a Pricing row showing the table revision and any `unknownModel` seen today; a Health row (link state, last snapshot age, frame p50/p95, event-loop delay) where the FPS number moves. The top-bar meta line grows to 11 px at full alpha, the FPS chip appears only in its danger band, and the quota chip shows `5h 12% · 7d 40%` only when a window has usage.

**Evidence.** `TopBar.js:303-420` renders read-only label/value pairs with inline grid styles and the undefined `--font-pixel`; `TopBar.js:919-940` unhides the quota chip whenever a window is finite, so a fresh session shows an empty bar and `0%`; FPS is always shown (`index.html:35`, `TopBar.js:1229-1244`) although `v0.37.0` records that the average "flattered itself"; `.topbar__uptime` and `.topbar__stat-rate` compute to 3.78:1 and 3.63:1 contrast (`topbar.css:715-723`).

**Work.** Build with `el()` from `DomSafe.js`; styles in `modal.css`; roster from `/api/providers`; perf rows from `window.__claudeVillePerf.frameHealth()` and `ClientPerfMetrics`; make `SET` an icon button with the shared class. **Acceptance.** Every persisted setting is changeable by keyboard from the modal; an unavailable provider is named; the pricing revision is visible; no inline `style:` blocks remain in the settings code; all top-bar text ≥4.5:1.

### 3.6 Keyboard-first navigation
**Owner:** `claudeville/src/presentation/shared/Sidebar.js:208-236`, `claudeville/src/presentation/App.js` (global keydown), `claudeville/index.html:158` (World Controls copy) · **Size:** M

**What the operator sees.** `/` or `Ctrl/Cmd+K` focuses the sidebar search; Up/Down move a highlight through the filtered list; Enter selects (and follows in World); Escape clears the filter, then closes the panel. `A` is unchanged.

**Evidence.** Enter acts only with exactly one match; no arrow handling; no focus shortcut (`IsometricRenderer.js:2855` only excludes modifier keys); `#agentList` is a plain `div` (`index.html:126`) of `<button aria-pressed>` rows (`Sidebar.js:791-797,876-886`); Dashboard has cyclic helpers (`DashboardKeyboardNavigation.js:5-11`).

**Work.** Roving `tabindex` over visible `.sidebar__agent-select`, `ArrowDown/ArrowUp/Home/End`, Enter → `emitAgentSelected`; global keydown guarded by `isKeyboardEditTarget` (`DashboardKeyboardNavigation.js:33-40`); document the keys in the popover. **Acceptance.** Select any agent, open its panel and close it with no pointer; a visible focus ring at every step.

### 3.7 Contrast, palette and non-colour encodings
**Owner:** `claudeville/css/reset.css:53-70`, `claudeville/css/layout.css:79`, `claudeville/css/topbar.css:537,715-723`, `claudeville/css/sidebar.css` (status dots), `scripts/smoke/theme-tokens.mjs` (extend with a contrast check) · **Size:** S

**Evidence (computed from tokens, alpha pre-blended on `#0d0a0c`).** `--cv-dash-detail #8d7659` is 3.66:1 on surface-2; `.topbar__uptime` 3.78:1; `.topbar__stat-rate` 3.63:1; idle mode button 4.20:1. The status and tool palette is Tailwind's default hex set verbatim (`#ef4444`, `#facc15`, `#eab308`, `#60a5fa`, `#a78bfa`, `#34d399`, `#f59e0b`, `#c084fc` at `reset.css:53-54,59-63,69-70`), the loudest generic-dashboard tell on a parchment chrome; `PRODUCT.md` lists that look as an anti-reference.

**Work.** `--cv-dash-detail → #a08a68`; uptime and rate alpha → 0.9; re-derive status and tool hues from the house ramp (errored `#e06c5b` is already the fallback at `activity-panel.css:120`; read `#7eb7d6`; task `#72d071`; search a desaturated violet), keeping `DESIGN.md`'s status-only colour rule; add glyph prefixes `!`, `?`, `~` to the sidebar dots for errored / needs-you / quota, matching `ChroniclePanel.js:16-26`. Turn the reviewer's contrast script into a `theme-tokens` smoke assertion.

**Acceptance.** Every text token ≥4.5:1 on every surface it is used on; no raw Tailwind hex in `reset.css`; the smoke fails on regression.

---

## Wave 4 — Composition and depth (after evidence; optional)

These carry less signal per hour and each needs an art or maintainer decision. They are retained because they were proposed by at least two reviewers, but they may not start before Waves 0–2 are release-verified.

| Item | Owner | Size | What and why | Gate |
| --- | --- | --- | --- | --- |
| 4.1 Island edge and ocean depth | `SkyRenderer.js` (cached distant-shore band at parallax ~0.15), `IsometricRenderer.js:9074-9130,9140-9190` (baked cliff reflection, dithered waterline) | M | The 40×40 diorama floats on a gradient plus four swell lines; a coastline and a baked, quantised reflection of the cliff give it a place without more tiles (terrain cache is at 6.56 M of a 7 M pixel reserve). | Authored shore asset via the sprite pipeline; north-star stills re-approved. |
| 4.2 Chronicle as a day ledger | `ChroniclePanel.js`, `modal.css` | M | Prev/next/today controls, `foldTimeline` grouping same-kind same-minute events, per-project subtotals, 10 px minimum labels. | After 3.1. |
| 4.3 Execution tree and task progress | adapters, `DashboardRenderer`, `ActivityPanel` | L | Primary → subagents / workflows → tasks with `3/5 children done`; Claude tasks are already served (`/api/tasks`) and not consumed. | After 1.1 and 1.6 so progress can be exact or marked inferred; never infer completion from disappearance. |
| 4.4 Causal waterfall | `ActivityPanel` | M | Turn / permission / tool / retry / child timeline for the last 20 minutes; long gaps dominate. | After 1.1, 1.2 and 1.4 supply real timestamps and correlation ids. |
| 4.5 `gh` PR / release events | `gitEvents.js:7,1202`, `ChronicleEvents` | M | `pr`, `issue`, `release` events with URLs from tool output where available; verified-outcome `release` already exists. | Best-effort parsing marked `inferred`. |

---

## Killed or deferred on the evidence

| Proposal | Ruling | Reason |
| --- | --- | --- |
| **WebGPU, OffscreenCanvas worker, radiance-cascade GI** | Remain rejected | `gpuMs` 1–3 ms and `appRenderMs` ≈ 3 ms at 120 Hz on the reference machine; the deficits are ladder policy (2.1) and parity (2.2). No reopen trigger in `open-followups.md` is met. |
| **Normal-mapped sprites, smooth per-pixel lighting, HDR or display-p3 canvas** | Killed | The four quantised bands are the palette-safe equivalent and are authored into the material contract; wider gamut would recolour authored pixels. |
| **A third, smooth body typeface** | Deferred to the maintainer | `DESIGN.md` forbids a second face; the code already ships two. Fixing the floor (3.1) is uncontroversial; adding a smooth face is a brand decision. |
| **OTLP / OpenTelemetry receiver** | Deferred behind 1.6 | Higher value for per-request cost and tool decisions, lower for turn state; exact metric names and JSON-over-HTTP support are unverified here. No hand-written gRPC or protobuf, ever. |
| **New provider adapters (Cursor, Copilot, Amp, Pi, Droid, Aider, Goose, Qwen Code…)** | Deferred | None of their stores exist on the reference machine; do not add adapters blind. Qwen Code is a Gemini-CLI fork and would be an S parametrisation of `gemini.js` once a corpus is available. |
| **Darker night before 2.1 and 2.3** | Killed | With four admitted lights the scene becomes unreadable; the bright flat night is compensating for the ladder. |
| **Raising `budgetMs` to fix the ladder** | Killed | Hides genuine overload on integrated GPUs; the defect is hysteresis. |
| **Map enlargement or re-chunking for depth** | Killed | Terrain cache margin is 6.3 %; 4.1 solves the floating look without tiles. |
| **An approve button on the permission inbox** | Killed permanently | ClaudeVille is read-only against the CLIs and must stay so. |
| **Persisting prompts, permission payloads, transcript prose** | Killed permanently | Existing retention contract. |
| **Brotli, a bundler, raising the Node floor for `node:sqlite`** | Killed | Loopback + strong ETag make byte savings irrelevant; the sqlite CLI fallback exists. |
| **Re-enabling `ENABLE_ERROR_HEURISTIC`** | Killed | Use real error records (hook errors from 1.1, exit codes from 1.2), not message regexes. |
| **Percentages in attention surfaces, canned barks, fake bonds, mood adjectives** | Killed | Existing rules from `v0.36.0` and `PRODUCT.md`. |
| **Any `.github/workflows/**` change** | Out of scope | The "no CI" contradiction is a maintainer policy decision; 0.6 only stops the docs from denying the workflow exists. |

---

## Sequencing, ownership and parallelism

File ownership is the only real constraint in a shared checkout. `App.js`, `index.html` and `css/**` are integration surfaces owned by one serialized pass per wave.

| Wave | Items | Concurrency | Integration owner touches |
| --- | --- | --- | --- |
| **W0 — truth hotfixes** | 0.1, 0.2, 0.3, 0.4, 0.5, 0.6 | 0.1 ∥ 0.2 ∥ 0.3 ∥ 0.4 (disjoint adapter files) ∥ 0.6; **0.5 is the integration pass** | `index.html`, `css/character.css`, `css/layout.css`, `App.js` |
| **W1 — signal** | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 | 1.1 ∥ 1.2 ∥ 1.3 (disjoint adapters); 1.4 after 1.1 + 1.2; 1.5 after 1.2; 1.6 after 1.4 (it writes **F2** fields) | none until surfaces consume the fields in W3 |
| **W2 — light** | 2.1, 2.2, 2.3, 2.4, 2.5 | 2.1 first and alone (pure ladder); then 2.2 ∥ 2.4; 2.3 after 2.1 and 2.2 (it spends the reserve); 2.5 any time | `WorldFrameRenderer.js` gating in 2.2 only |
| **W3 — instruments** | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 | 3.2 ∥ 3.6 ∥ 3.7 first (small, disjoint); 3.1 is an integration pass; 3.3 ∥ 3.4 after 3.1 (they consume the tokens); 3.5 last | `css/**`, `index.html`, `App.js`, `TopBar.js` |
| **W4 — composition** | 4.1–4.5 | after W0–W2 are release-verified | as listed |

**Release mapping (suggested).** W0 as `v0.37.1` hotfix(es); W1 + W2 as `v0.38.0` *The Commander's Map*; W3 as `v0.39.0`; W4 as named minor releases when each gate clears. Every push updates `CHANGELOG.md`, `claudeville/index.html` version chip and `package.json` per the root instructions, and gets a tag and GitHub release.

**Highest risk of regret.** 1.6 (a second truth source) and 2.3's night grade (art direction). Both have one-flag reverts written into their items: the hook overlay is opt-in and expires; the grade change is a single exported table.

---

## Verification matrix

| Change | Command | Expected |
| --- | --- | --- |
| Any adapter or service file | `find claudeville/adapters claudeville/services -name '*.js' -print0 \| xargs -0 -n1 node --check` | clean |
| Pricing, turn state, projections, working set, hook overlay, ladder | `npm run test:unit` | green; new tests present under `scripts/tests/` |
| Broad regression | `npm run validate:quick` | green |
| Adapter discovery and cold-scan gates | `node scripts/smoke/adapters.mjs`; `/api/perf` after a warm refresh with threshold 0 | no file opens, no sync git |
| New route | `node scripts/smoke/server-security.mjs` (extended) | non-loopback, oversized, non-POST rejected |
| Pre-push | `npm run gate:release` | green; note that the gate runs only on the developer's local Node |
| World rendering (2.x) | `npm run world:capture-render-baselines -- --only=north-star-clear-day` and `torchlit-night`, both `webgl` and `canvas`; `npm run world:benchmark-fps` | parity per **F4**; `qualityLevel 0` within 10 s; 1.00 ms reserve respected |
| Ladder timeline | `node agents/research/claudeville-fable-5.1-review/ladder-probe.mjs` against the running dev server (75 s `frameHealth()` sampler, real GPU via `--use-angle=metal`) | `q=0` within 10 s; ≤1 transition/min afterwards |
| DOM (3.x, 0.5) | open `http://localhost:4000`, World and Dashboard, select and deselect, open the panel, resize; Playwright bounding-box check for overlays | no overlap; one empty card; framed first toast |
| Docs (0.6) | `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)`; `git status --short` | empty; only intended files |

Browser and visual verification stay **manual**; there is no browser or component test runner and this plan does not add one.

---

## Definition of done

- Every money figure in the app is correct for the Claude 5 family and carries provenance; the pricing revision is visible in Settings.
- No live session is mislabelled `team-member`; `agentType` is always inside the documented enum; Codex never reports `unknown` mid-turn or a false approval after an abort.
- A Claude session shows provider-reported cost, lines changed, turn duration, prompt and todos; a Codex session shows exit codes, durations and changed files; every provider has a turn state.
- With hooks configured, a permission prompt is named within half a second; without hooks nothing changes.
- On the reference machine the GPU world is at FULL within 10 s and shows sun shadows, haze, cloud shadows, water motion and fauna; the agent that needs you is the brightest pool at night.
- Plaques do not grow with zoom; crowds fold into building chips; no fixed overlay covers the panel; one empty card; framed toasts.
- Display type never below 10 px; paths keep their filename; the panel opens on operations; the Dashboard is rows first; settings are editable; every text token ≥4.5:1.
- `README.md`, `claudeville/CLAUDE.md`, `agents/README.md`, the council plan status and `open-followups.md` say what the code does.
