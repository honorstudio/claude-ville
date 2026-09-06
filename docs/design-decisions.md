# Design Decisions

Short decision records for load-bearing constraints in ClaudeVille. Each entry states what was decided, why, the code reference, and what to update if the decision changes.

## Port 4000 is hardcoded

`claudeville/server.js` defines `const PORT = 4000;`. The README, both `CLAUDE.md` files, and `AGENTS.md` reference it as fixed.

The local-first design assumes one user, one machine, one server. Making the port configurable would force the docs and every local workflow to learn how to discover it. A constant is simpler and matches user muscle memory.

The server binds `127.0.0.1` rather than every interface. HTTP requests require a local `Host`; browser origins must match that host, and WebSocket upgrades use the explicit same-origin `/ws` path. ClaudeVille intentionally has no LAN mode, CORS surface, or authentication layer.

If you change this, update: `claudeville/server.js`, README, both `CLAUDE.md` files, `AGENTS.md`, and `docs/troubleshooting.md`.

## Push ingestion is optional, loopback-only and overlay-only

`POST /api/ingest/hook` accepts normalized lifecycle events from local CLI hooks. The server applies the same local Host/Origin validation as its other routes with `requireOrigin: false`, because a shell hook has no browser `Origin`; the `127.0.0.1` bind remains the network boundary. Set `CLAUDEVILLE_INGEST_TOKEN` to require the same value in `X-ClaudeVille-Ingest-Token`. Requests are capped at 256 KiB and their bodies are never logged.

The hook registry is not a provider and performs no discovery. It holds at most 256 sessions in process memory, expires records after 30 seconds, and only merges a signal during its first 10 seconds. A fresh hook can escalate or refresh transcript state, but cannot suppress transcript-derived `awaiting_input`. Prompt detail is secret-stripped and capped at 200 characters before it reaches the session payload; nothing from the hook overlay is persisted.

ClaudeVille never creates or edits Claude Code, Codex, or other provider configuration. Operators may opt in by copying the examples in `docs/troubleshooting.md`; stopping or restarting ClaudeVille immediately falls back to transcript inference. Approval stays in the terminal: the dashboard deliberately has no approve action. OTLP ingestion is outside this route's scope.

If you change this, update: `claudeville/server.js`, `claudeville/adapters/hooks.js`, `claudeville/adapters/index.js`, `claudeville/CLAUDE.md`, `docs/troubleshooting.md`, and the hook overlay/security tests.

## Dependency-free runtime, no build step

`package.json` declares no runtime `dependencies`. The server uses only Node built-ins (`http`, `fs`, `path`, `crypto`, `https`, `child_process`, `os`). The frontend is plain HTML, CSS, and ES modules served as-is.

This makes the dashboard clone-and-run on any machine with Node 18+. There is no install step for `npm run dev`, no bundler config to maintain, no JSX, no TypeScript, no module aliasing, and a typo in any browser module breaks page boot at runtime.

The repo does have `devDependencies` for sprite validation, screenshot capture, and visual diffs (`js-yaml`, `pngjs`, `pixelmatch`, `playwright`). Those are development tools, not runtime requirements.

If you change this, update: `claudeville/CLAUDE.md` (runtime/development dependency split), `docs/troubleshooting.md` (syntax-check and sprite-tool guidance), and add the relevant install/build steps to README.

## Vanilla ES modules in the browser

The frontend uses `<script type="module">` and relative-path `import`s. There is no bundler.

Same rationale as the previous entry. The constraint this places on the frontend: no JSX, no path aliases, no automatic vendoring of third-party libraries. If a third-party module is needed, vendor a single ES-module file under `claudeville/src/` and import it relatively.

If you change this, update: `claudeville/CLAUDE.md` and the boot path described in `src/presentation/App.js`.

## Read-only adapter contract

The provider session files in `~/.claude/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, `~/.grok/sessions/`, `~/.kimi/`, and `~/.local/share/opencode/opencode.db` are owned by the upstream CLIs. ClaudeVille adapters open them for reading only. OpenCode support uses read-only SQLite access through `node:sqlite` when available and falls back to `sqlite3 -readonly`; it does not write migrations, checkpoints, vacuums, or config changes. `claudeville/CLAUDE.md` states: "Treat all provider session files as read-only inputs" and "Do not mutate local CLI session files."

The CLIs append to these files concurrently and may change their format in any release. Writing back would create races and version drift. The dashboard's correctness depends on never being a second writer.

If you change this, update: every adapter under `claudeville/adapters/`, `claudeville/CLAUDE.md`, and add a clear ownership story in README.

## The quota API is the only outbound network exception

`claudeville/services/usageQuota.js` makes one deliberate outbound request: Node's `https.request` sends an authenticated `GET` to `api.anthropic.com/api/oauth/usage` when Claude OAuth credentials include both a subscription type and access token (`claudeville/services/usageQuota.js:282-304`). This is an exception to ClaudeVille's otherwise loopback-only serving and local-data model; it is not a hosted proxy or a general network surface.

The request is attempted at most once per `QUOTA_API_TTL` interval, which is `5 * 60_000` (5 minutes). Only an HTTP 200 response is parsed, and the production response accumulator destroys a body once it exceeds `QUOTA_RESPONSE_MAX_BYTES` (`256 * 1024`, or 256 KiB). The request timeout is 5 seconds (`claudeville/services/usageQuota.js:24-26`, `253-279`, `282-302`). A valid response with at least one usable quota window updates the snapshot; malformed, non-200, oversized, and network-failed requests do not. Network errors are intentionally ignored: a failed attempt does not clear an older successful snapshot, and the timestamp gate delays another attempt until the next 5-minute interval. An existing successful snapshot remains available while `Date.now() - lastSuccessTs <= QUOTA_MAX_STALE_MS`, which is `30 * 60_000` (30 minutes); after that, `fetchUsage()` reports `quotaAvailable: false` and null `fiveHour`/`sevenDay` values. Offline operation with no successful snapshot reports those quota values as unavailable immediately (`claudeville/services/usageQuota.js:304-320`, `332-356`).

This keeps quota telemetry useful without making the local dashboard depend on the remote service for its core operation. The retry interval limits background traffic, the response cap bounds remote input, and the stale cutoff prevents a frozen quota snapshot from looking current when the machine has been offline or the service is failing.

If you change this, update: `claudeville/services/usageQuota.js`, the local-only/proxy descriptions in `README.md` and `claudeville/CLAUDE.md`, the quota troubleshooting note in `docs/troubleshooting.md`, and this entry plus the loopback claim in the `Port 4000 is hardcoded` entry.

## 2-second polling on top of `fs.watch`

`claudeville/server.js` runs a dirty-driven 2-second scheduler. The scheduler attempts a broadcast when WebSocket clients are connected, but `broadcastUpdate` can no-op when no provider data is dirty and no heartbeat is due.

`fs.watch` events are unreliable across platforms (missing events, coalesced events, or no events at all on some filesystems). Polling is the backstop. Two seconds is short enough to feel live and long enough to avoid unnecessary work when the page is open but idle.

If you change this, update: `claudeville/CLAUDE.md` and `docs/troubleshooting.md`.

## `ACTIVE_THRESHOLD_MS` is 2 minutes

`claudeville/server.js` defines `const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;`. Sessions older than this are excluded from `/api/sessions`.

Two minutes makes the dashboard feel like "what is happening right now" rather than a session log. Longer windows fill the world with stale agents that no longer reflect anything the user is doing; shorter windows make the world flicker as the upstream CLI pauses between steps.

If you change this, update: `docs/troubleshooting.md` (the empty-sessions diagnosis).

## Static pricing estimates

The runtime pricing estimate is static. `claudeville/src/config/models.json` is the canonical model registry for pricing, context windows, mood tiers, and visual identity. `scripts/models/generate.mjs` commits matching ESM and CommonJS resolver modules so browser and server consumers keep synchronous helpers with no runtime build step; `npm run models:check` detects drift between the source registry and those committed outputs. The Claude table (revision 2026-09-01) was verified against the first-party pricing page (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-02): Fable 5.1 and Mythos 5.1 cache reads are $0.25/MTok (0.025x base input), unlike the 0.1x rule every other model uses, and Sonnet 5 is $2/$10 as the standard price (the page states the previously scheduled September 1, 2026 increase to $3/$15 "will not occur"). GLM 5.3 and GLM 5.3 Flash rates ($1.40/$4.40 and $0.15/$0.50 per MTok input/output, $0.26 and $0.03 cache reads) come from omp's bundled catalog cost table cross-checked against per-message `usage.cost` in real transcripts (verified 2026-09-02); both carry a 1M-token context window.

GPT-6 Astra uses the exact `gpt-6-astra` ID (including the registry's normalized and provider-qualified forms), a 1,050,000-token context window, and standard rates of $10 input, $50 output, $1 cache read, and $12.50 cache write per MTok, verified against [OpenAI's Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) on 2026-09-05. The static estimate does not apply long-context or service-tier multipliers. Bare `gpt-6` and `astra` remain unknown models. Its silver/violet star-knight sprite keeps `max` and `ultra` distinct: low uses a crescent saber, medium a runeblade, high a dawnblade, and xhigh/max/ultra a polearm with their respective crests. Missing effort uses the crescent saber without an effort marker.

The dashboard does not have a billing API key or an authoritative price feed. Hardcoded estimates are good enough for the "is this run getting expensive?" question this UI answers. Prices change rarely.

If model data changes, update `claudeville/src/config/models.json`, regenerate both committed modules, and validate `agent.cost`, Activity Panel rendering, and `/api/sessions`.

## Cache token normalization

Different providers report cache hits differently. The adapters normalize them into `cacheRead` and `cacheCreate` fields:

- Claude adapter (`claudeville/adapters/claude.js:253-254`) reads `cache_read_input_tokens` and `cache_creation_input_tokens` from each turn's `usage` and sums them.
- Codex adapter (`claudeville/adapters/codex.js:317-349`) reads `cache_read_input_tokens` / `cacheReadInputTokens` and `cache_creation_input_tokens`. Codex has no separate cache-create concept in some payloads, so `cacheCreate` is set to 0 in those branches.
- Gemini does not currently report cache tokens; the field is left at 0.
- Kimi reads cache token fields from legacy status updates and Kimi Code `usage.record` entries, then normalizes cache reads/creation into the same shape.
- OpenCode reads SQLite token totals for cache read/write; frontend token normalization treats cache write aliases as `cacheCreate`.

If a provider format changes, update only the relevant adapter. The frontend keeps using the normalized shape.

## English-only documentation and UI

The user-facing app exposes English UI strings only, and project policy keeps documentation and UI strings English. `claudeville/CLAUDE.md` defines the validation:

```bash
rg -n -P "[\\x{1100}-\\x{11FF}\\x{3130}-\\x{318F}\\x{AC00}-\\x{D7AF}]" $(rg --files -g '*.md' --glob '!node_modules')
```

The source-script scan exists because earlier revisions of the codebase mixed non-English copy with English. The rule is now uniform English. Run the scan after edits that touch user-visible copy.

If you change this, update: `claudeville/CLAUDE.md`, root `AGENTS.md`/`CLAUDE.md`, and `docs/README.md`.

## Hand-written WebSocket framing

`claudeville/server.js` implements RFC 6455 directly: the `/ws` handshake (`handleWebSocketUpgrade`), frame parser (`handleWebSocketFrame`), and frame builder (`createWebSocketFrame`). The handshake validates the local Host/Origin, version, and key; client frames must be masked, unfragmented, and free of RSV extensions.

The runtime no-dependencies rule rules out `ws` and similar packages. Browser clients only need text frames, ping/pong, and clean close, so a couple of hundred lines of framing code is cheaper than a runtime dependency.

If you change this, audit close handling, masking, and the 64-bit length path before swapping in a library.

## Multi-agent shared checkout

The repo is meant to be edited by several agents in parallel. Root `AGENTS.md`/`CLAUDE.md` define the workflow. The discipline:

- Run `git status --short` before and after edits.
- Do not revert or absorb unrelated changes.
- Do not run destructive git or shell commands without explicit approval.

This avoids accidental rollback when one agent integrates work and another is mid-edit.

If you change this, update: root `AGENTS.md`/`CLAUDE.md`, `claudeville/CLAUDE.md`, and `docs/README.md`.

## Polling cadence: 2s server scheduler, 2s panel

- Server scheduler: every 2 seconds; actual broadcasts are dirty-driven and no-op when there are no WebSocket clients.
- Activity panel detail fetch: every 2 seconds for the selected agent (`claudeville/src/presentation/shared/ActivityPanel.js:150`).

Server and panel stay near-live because both serve the active dashboard.

If you change any of these, also revisit `ACTIVE_THRESHOLD_MS` (the active-session window must stay strictly larger than the slowest poll, or sessions will visibly flicker in and out).

## BGM mode keeps event cues but drops reactive ambience

`BgmDirector` intentionally starts a `BgmPlayer` and `CueKit` instead of the `AudioDirector` layer set (`claudeville/src/presentation/shared/audio/BgmDirector.js:33-44`; `claudeville/src/presentation/shared/audio/AudioDirector.js:62-76`). BGM has no wind, rain, birds, crickets, village-hum, tonal-bed, or reactive music layers, and it does not subscribe to storm-flash thunder (`BgmDirector.js:1-6`; `AudioDirector.js:125-133`, `157-218`). It does retain event cues, including arrival, departure, distress, recovery, council, aurora, and the listener-focused summons (`BgmDirector.js:69-81`), along with the waking-hours hour bell (`BgmDirector.js:97-107`).

This is a deliberate mode distinction: continuous town music is the background in BGM mode, while discrete village and attention signals still need to ring over it. Weather and wildlife are reactive ambience layers, so restoring them in BGM mode would change the intended music-first soundscape rather than fix a missing event subscription.

If you change this, update: `claudeville/src/presentation/shared/audio/BgmDirector.js`, `claudeville/src/presentation/shared/audio/AudioDirector.js`, the mode description in `claudeville/src/presentation/shared/README.md`, and this entry.

## Domain layer must not import from presentation

`Agent.js` lives at `claudeville/src/domain/entities/`. It imports from `value-objects/` and `config/i18n.js` only. Shared logic used by both domain and presentation belongs under `src/domain/` or another lower layer, not under `src/presentation/`.

`TokenUsage.js` is the current example: the domain entity and Activity Panel can both import it without inverting the layering.

## Finished villagers linger after the active roster drops them

`claudeville/src/application/AgentManager.js` defines `DEPARTED_AGENT_GRACE_MS` as `90 * 1000` (90 seconds) and `MAX_DEPARTED_AGENTS` as `100`. When a session disappears from a WebSocket update, the manager projects it to `AgentStatus.COMPLETED`, stamps `departedAt`, clears live-work and attention fields, and keeps it in the World until the grace expires (`AgentManager._sweepDepartedAgents`). Overflow is sorted by `departedAt` and evicted oldest-first (`AgentManager._evictDepartedOverflow`). `Agent.isDeparted` is a separate presence marker, not a new execution status; its working, idle, waiting, and fresh-tool getters return false for departed villagers (`domain/entities/Agent.js:151-163`).

The grace runs on a wall clock, so `AgentManager.startDepartureSweep()` re-checks it every `DEPARTED_SWEEP_INTERVAL_MS` (15 seconds) instead of only when a WebSocket update arrives. This is load-bearing rather than defensive: `broadcastUpdate()` returns early when the payload signature is unchanged (`claudeville/server.js`), so broadcasts stop the moment the last session goes quiet — which is exactly when the last villagers depart. Driving eviction off updates alone left them standing frozen in the village until the page was reloaded. A timer sweep only expires villagers that are already departed; only a roster update can mark a live one as departed.

This exists alongside `ACTIVE_THRESHOLD_MS`, not instead of it. The server's `ACTIVE_THRESHOLD_MS` remains `2 * 60 * 1000` (2 minutes) and controls which sessions are fresh enough to enter the server's live collection (`claudeville/server.js`). The 90-second grace begins when a completed session leaves the client-facing roster and controls visual residency in the World; the two stack, so a finished agent walks out roughly three and a half minutes after its last activity. Completed turns are deliberately not admitted to the server's 45-minute `SessionResidency`: stacking both lifecycles kept finished sessions visible for nearly an hour. Unresolved `tool_pending` sessions still receive backend residency so slow tools and permission prompts do not disappear while silent. The motivating case for the frontend grace was a 20-agent parallel fan-out whose short-lived agents aged out before the operator could see the fleet; the manager explicitly sizes the 100-agent cap to keep that burst visible (`AgentManager.js:9-14`).

The `COMPLETED` projection keeps compatibility with presentation and status counters. `World.getStats()` therefore does not count a departed villager in working, idle, waiting, errored, or attention buckets, and `AttentionService` only considers `WAITING_ON_USER`, `RATE_LIMITED`, and `ERRORED` attention statuses (`domain/entities/World.js:63-83`; `domain/services/StatusResolver.js:108-115`). The retained villagers do still contribute to `World.getStats().total` and its token/cost totals until eviction; “excluded from counters” means the live status/attention buckets, not every aggregate.

When the grace expires the villager is removed from the World, and `agent:removed` starts the gate walk in `IsometricRenderer._beginAgentGateDeparture()` — the sprite walks to `VILLAGE_GATE.outside` and is disposed on arrival. Subagents merge back into their parent instead (`_beginRelationshipDeparture`). Departure is therefore a visible exit, not a fade in place; the grey, frozen `isDeparted` treatment in `AgentSprite` is only the brief pause before it.

If this changes, update: `claudeville/src/application/AgentManager.js`, `claudeville/src/presentation/App.js` (sweep start/stop), `claudeville/src/domain/entities/Agent.js`, `claudeville/src/domain/entities/World.js`, `claudeville/src/domain/services/StatusResolver.js`, `claudeville/server.js`, the `ACTIVE_THRESHOLD_MS` and empty-sessions guidance above and in `docs/troubleshooting.md`, and residency tests.

## Git enrichment uses a bounded asynchronous stale-while-revalidate worker

The normal server path enables the Git worker through `configureGitEnrichmentWorker({ enabled: true })` (`claudeville/server.js:2307-2319`). Session enrichment returns the cached per-project snapshot immediately, then requests a refresh when the snapshot is absent, stale, or invalidated (`claudeville/adapters/gitEvents.js:2186-2222`). A successful refresh publishes only a changed, generation-current snapshot; a Git-head change during the job marks the completion stale and requests a rerun (`gitEvents.js:772-848`).

The bounds are deliberate: at most 2 active jobs, a 32-deep queue, and shedding when that queue is full (`gitEvents.js:63-92`, `854-921`). Requests for a project already queued, running, or inside its retry delay coalesce; a change observed during a running job sets a rerun flag instead of adding an unbounded duplicate (`gitEvents.js:889-907`). Each `git` child process uses a 750 ms timeout and a 256 KiB stdout buffer cap (`gitEvents.js:470-518`). Failures retry with exponential backoff from 1 second up to 30 seconds by default (`gitEvents.js:418-438`); the environment variables in the constants block can change those defaults, so the effective values are exposed in worker diagnostics.

These limits respond to measured pressure, not theoretical neatness: the post-OOM performance audit recorded about 92,600 cumulative Git subprocess calls and 443 seconds of command time, including one nine-project refresh that launched 43 synchronous commands and blocked for about 151 ms (`agents/plans/claudeville-post-oom-reliability-performance-plan.md:129-138`). The worker keeps the hot server path asynchronous while retaining synchronous fallback helpers for worker-disabled or direct legacy paths (`claudeville/adapters/index.js:146-151`; `gitEvents.js:1651-1660`). Do not remove the bounds or mistake the fallback for the normal configured path.

Worker state and Git command rates are part of the manual performance surface at `/api/perf` (`claudeville/server.js:379-405`). The payload includes concurrency, queue depth, active subprocesses, refreshes, failures, retries, shed requests, coalesced requests, stale completions, and the last refresh/error fields (`gitEvents.js:952-991`).

If this changes, update: `claudeville/adapters/gitEvents.js`, `claudeville/adapters/index.js`, `claudeville/server.js`, `/api/perf` diagnostics, the Git performance evidence and live follow-up ledger under `agents/plans/`, and the related performance troubleshooting notes.

## Cross-task event contracts are load-bearing

The application, audio, and shared presentation layers communicate through string-keyed `eventBus` events. These payloads are contracts, not incidental object shapes:

- `attention:raised` is emitted by `AttentionService` as `{ agentId, agent, reason, waitingCount, oldestWaitMs }` (`claudeville/src/application/AttentionService.js:282-295`). The current payload also carries `status` and `label`. `AudioDirector` consumes the agent id and waiting summary to produce the listener-focused summons, while BGM mode listens to the same event (`shared/audio/AudioDirector.js:245-251`, `384-408`; `shared/audio/BgmDirector.js:80-82`).
- `audio:cue-played` is emitted by `CueKit` as `{ kind, agentId: null|value, label, at }` after the cue governor accepts a cue (`claudeville/src/presentation/shared/audio/cues/CueKit.js:75-93`, `172-180`). `Toast` consumes it for captions (`shared/Toast.js:93-105`). With an active AudioContext this is the cue that is synthesized; without one, the event still fires so accessibility captions do not depend on sound being enabled.
- `attention:digest` is emitted after an unattended return when Chronicle has a non-empty summary. Its top-level payload is `{ kind: 'unattended-digest', message, type, since, until, awayMs, summary }` (`claudeville/src/application/AttentionService.js:333-360`). `Toast` consumes it as a longer-lived summary so return-time cue traffic does not erase the account of what happened while the operator was away (`shared/Toast.js:100-125`).

The contracts keep the subsystems independently replaceable: attention detection does not know how sound or captions are rendered, CueKit does not know which UI presents a caption, and the digest producer does not depend on one Toast implementation. If a field is renamed, omitted, or changes meaning, update every emitter and consumer together, the event-focused unit tests, and this entry.

## The Mine states counts, never percentages

The token mine's cargo and assay bench report exact quantities — `8,192 input · 32,768 cache read · observed last 60s` — and never a share. The transient `NN% CACHE` label is gone (`LandmarkActivity.formatExactCount`, the assay-bench label builders, and `tokenItemTooltip` in `claudeville/src/presentation/character-mode/LandmarkActivity.js`; regression `scripts/tests/w11-cache-ore-ratio.test.mjs`). Spend on the bench is only ever a difference between two consecutive fresh, same-provenance observations of the same session; a counter reset or a provenance flip restarts coverage and the bench says so instead of computing across the gap.

A percentage hides both denominators this surface needs: a 90% cache share of 400 tokens and of 4,000,000 tokens are different facts, and provider-reported versus estimated cost are different provenance. The plan's guardrail ("counts, never percentages, in attention surfaces") became load-bearing here first; any new attention surface inherits it.

If you change this, update: `LandmarkActivity.js`, the mine cargo/assay drawing in `BuildingSprite.js`, `scripts/tests/w11-cache-ore-ratio.test.mjs`, and `docs/world-visual-qa-checklist.md`.

## A dashboard update is not a village release

The Harbor release parade answers only real release events. `VillageDirector.triggerReleaseParade` runs from `harbor:release-burst` and `chronicle:milestone` of kind `release` (`claudeville/src/presentation/character-mode/VillageDirector.js`); the former synthesized once-per-stored-version parade (`triggerReleaseParadeOnceForVersion`, which read the dashboard's own version string) was removed. Version discovery stays in the in-app changelog affordance; simulator release metadata and genuine tag-push milestones still parade.

The removed parade fired on every fresh headless context (`PARADE v0.44` on an empty island): a ClaudeVille update is shipped by the maintainer, not released by the operator's agents, and celebrating the former as the latter told a false story at the village's most visible landmark.

If you change this, update: `VillageDirector.js`, `docs/design-decisions.md` (this entry), and the `release-parade` QA scenario in `docs/world-visual-qa-checklist.md`.

## One instrument per fact

A signal gets exactly one visual encoding per surface: one on the body, one on the building, one in the DOM. When the frontier visual work replaced an existing cue it removed the old one in the same change — the authored `read` strip replaces the procedural book and wait question mark for characters that carry a strip (`AgentSprite._actionStripPose`), the C4 aperture is the only interior presentation (its identities and counts equal `BuildingInstrumentModel`'s, which renders each building fact once in the panel), and the exact-count mine trays replaced the percentage cargo label. `shared/BuildingInstrumentModel.js` is the canonical split: presence (visit test), signal (assigned WORKING sessions), queue, purpose — an unknown key on the payload is ignored rather than borrowed as a count or denominator.

Two encodings of one fact on one surface always drift apart, and the operator cannot tell which one is the truth when they disagree. The pure model files (`BuildingInstrumentModel.js`, `BuildingApertureModel.js`, `WorkWaterfallModel.js`, `ObservationCertainty.js`) exist so each fact has one derivable presentation instead of several re-derivations.

If you change this, update: the pure model, its consumers in `ActivityPanel.js`/`BuildingSprite.js`/`AgentSprite.js`, and the contract summaries in `claudeville/src/presentation/character-mode/README.md`.

## Ambient camera never re-arms on a timer

Ambient camera ownership is entered only through the explicit AMBIENT CAM control and, once revoked, is never re-acquired automatically (`CameraDirector.setAmbient` and the `_ambient` scheduler state in `claudeville/src/presentation/character-mode/CameraDirector.js`; the control's resume state in `App.js._initAmbientControl`). Any genuine input — pointer-down, wheel, navigation key, selection — releases the claim; the button then waits to be asked again. The pre-existing automatic (`auto`) timers are unchanged and never run while an Ambient claim stands.

Timed re-takeover after manual input is the one behaviour that makes a broadcast feel like camera theft: the operator pans away, the village pulls the frame back. Ambient is a mode the operator knowingly lends the frame to, and lending ends when they touch it.

If you change this, update: `CameraDirector.js`, `App.js` (`#worldAmbient` wiring), the C6 summary in `claudeville/src/presentation/character-mode/README.md`, and the Ambient checks in `docs/world-visual-qa-checklist.md`.

## One dusk exposure contract, halos capped

Every consumer of motivated light reads one reviewed source-energy envelope — `SOURCE_ENERGY_ENVELOPE` in `claudeville/src/presentation/character-mode/AtmosphereState.js` with buckets `daylight → settling → lamplight → deep-night`, each allocating `core >= spill >= bloom` and a `halo` area cap enforced with the absolute cap in `BuildingSprite`. Before the contract, `lightBoost`, `emissivePhase`, `beaconIntensity`, and `buildingGlowScale` each applied their own continuous boost and the products stacked, so dusk brightened four times over and the Lighthouse/Harbor halos outgrew the work they were lighting. Feeds authored without an envelope keep the neutral response (`NEUTRAL_SOURCE_ENERGY`), and action-needed overlays are outside this budget. The maintainer decision to accept a reduced Lighthouse/Harbor halo radius (D4) is recorded in the plan's execution record.

Bloom energy that outranks the work it decorates inverts the scene's meaning: the busiest night looks like the emptiest one. One reviewed table with cores first is cheaper to reason about than four multiplied boosts, and it gives every Wave 3 effect a shared energy budget to substitute within rather than add to.

If you change this, update: `AtmosphereState.js` (`SOURCE_ENERGY_ENVELOPE`, `sourceEnergyFor`), the halo caps in `BuildingSprite.js`, `gpu/GpuWorldPolicy.js` (the `exposure-envelope` receipt prices saved time), `scripts/tests/dusk-exposure-contract.test.mjs`, and `docs/world-visual-qa-checklist.md`.
