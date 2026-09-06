# ClaudeVille comprehensive verification audit

**Status:** `ready`

**Purpose:** Basis for remediation planning

**Audit date:** July 26, 2026

**Audited baseline:** `main` at `2d648cb` (`v0.28.1`)

**Scope:** Server, APIs, WebSocket, provider adapters, services, browser application/domain/infrastructure, Dashboard mode, shared UI and audio, World/canvas mode, assets, configuration, validation scripts, documentation, and dependencies

**Change scope:** This audit is read-only apart from this retained report. It does not implement fixes.

## Executive verdict

ClaudeVille is not carrying a collection of wholly abandoned production subsystems. All 122 browser modules and all server/adapters/services runtime modules are reachable from the production boot graph. All manifest sprite assets are accounted for. The clearest product-orphaned surface is `/api/tasks`; `/api/providers` and `/api/perf` are deliberate diagnostic surfaces.

The codebase has strong bounded-cache, watcher, renderer, and ordinary teardown discipline. A 60-second forced-GC browser/server soak found stable listener, canvas, watcher, and cache counts. A short sample of the roughly 26.7-hour-old maintained server did not show monotonic heap or descriptor growth; it was not observed continuously for that full period or run with forced GC. This is evidence against an obvious steady-state leak, not proof that no leak exists.

The audit nevertheless confirmed important defects:

- **1 critical** local privacy/security exposure
- **8 high-severity** data-integrity, outage-handling, lifecycle, world-configuration, and performance defects
- **15 medium-severity** correctness, resilience, accessibility, protocol, and optimization issues
- **7 low-severity** correctness, accessibility, efficiency, copy, and dead-surface issues

The most urgent problem is the server boundary: it listens on every interface, exposes sensitive local session/account data without authentication, permits wildcard cross-origin API reads, and accepts WebSocket upgrades without origin or path validation. The most operationally dangerous UI bug is the Activity Panel showing agent A's command, message, token, cost, and biography data under agent B's heading. The most systemic correctness problems are non-idempotent biography/affinity accounting and treating failed polls as authoritative empty villages.

Two real retention defects were reproduced: the World offscreen-cue overlay retains a retired renderer across same-document application teardown, and destroyed Dashboard avatars remain queued indefinitely if the World compositor never mounts. The first already causes the repository's browser lifecycle smoke to fail.

## Evidence and severity conventions

- **Confirmed:** reproduced at runtime, established by a deterministic probe, or directly demonstrated by a complete source path.
- **Conditional:** the logic defect is certain, but its user-visible frequency depends on runtime event shapes or an uncommon failure path.
- **Optimization:** measured avoidable work or a blocking-risk architecture, not automatically a correctness defect.
- **Critical:** exposes sensitive local data outside the intended trust boundary.
- **High:** can materially corrupt displayed/persisted state, erase the village, leak retired application objects, invalidate authored world behavior, or put a core view below its own usable performance band.
- **Medium:** meaningful defect or risk with a narrower trigger, bounded impact, or viable fallback.
- **Low:** limited correctness/accessibility issue, redundant work, misleading copy, or maintainability debt.

## Findings index

| ID | Severity | Finding | Confidence |
| --- | --- | --- | --- |
| CV-SEC-001 | Critical | Unauthenticated server exposes private local data to LAN and cross-origin clients | Confirmed |
| CV-DATA-001 | High | Activity Panel can attribute one agent's private detail to another | Confirmed |
| CV-DATA-002 | High | Biography push totals and milestones inflate on reload | Confirmed |
| CV-DATA-003 | High | Relationship affinity is non-idempotent and misses most chats | Confirmed |
| CV-RUNTIME-001 | High | Transient poll failures idle and then remove every agent | Confirmed |
| CV-DATA-004 | High | Chronicle and spend writes can be lost during teardown | Confirmed |
| CV-LIFE-001 | High | Offscreen-cue overlay retains the first World renderer | Confirmed |
| CV-WORLD-001 | High | Eleven authored visit slots are not walkable | Confirmed |
| CV-PERF-001 | High | Heavy rain reduces deterministic World FPS by about 42% | Confirmed |
| CV-LIFE-002 | Medium | Failed World mount can retain destroyed Dashboard avatars without bound | Confirmed, degraded path |
| CV-BOOT-001 | Medium | A blocked `localStorage` read aborts application boot | Confirmed |
| CV-UI-001 | Medium | Gemini receives different avatars in World and Dashboard | Confirmed |
| CV-UI-002 | Medium | Dashboard avatars can keep stale appearance and team trim | Confirmed |
| CV-A11Y-001 | Medium | Sidebar agents and parent links are mouse-only | Confirmed |
| CV-A11Y-002 | Medium | Modal focus escapes behind an `aria-modal` dialog | Confirmed |
| CV-A11Y-003 | Medium | Dashboard cards contain nested interactive controls | Confirmed |
| CV-DATA-005 | Medium | Mood backfills historical Git events as current and retains unbounded keys | Confirmed |
| CV-DATA-006 | Medium | Chronicle labels pull/fetch events as commits | Confirmed, conditional |
| CV-PERF-002 | Medium | Unchanged JSONL tails are reparsed at very high volume | Measured optimization |
| CV-PERF-003 | Medium | Synchronous Git subprocesses can block the server event loop | Confirmed risk |
| CV-NET-001 | Medium | WebSocket frame parsing omits required protocol validation | Confirmed hardening gap |
| CV-WORLD-002 | Medium | Eight overflow visit entries duplicate base slots | Confirmed |
| CV-WORLD-003 | Medium | Blocked-target path fallback can stop 5–7 tiles away and report success | Confirmed algorithm defect |
| CV-PERF-004 | Medium | Boot eagerly fetches/decodes every sprite and loads the full module graph | Measured optimization |
| CV-COPY-001 | Low | `truncateText` exceeds its advertised maximum | Confirmed |
| CV-A11Y-004 | Low | Toast feedback is not announced to assistive technology | Confirmed |
| CV-PERF-005 | Low | Biography reads repeat on every selected-agent update | Confirmed optimization |
| CV-DATA-007 | Low | Dashboard can retain an obsolete usage footer | Confirmed edge case |
| CV-COPY-002 | Low | Empty-state copy understates multi-provider support | Confirmed |
| CV-DEAD-001 | Low | `/api/tasks` is not consumed by the product UI | Confirmed |
| CV-DEAD-002 | Low | A small set of exports and procedural helpers has no callers | Confirmed |

## Critical finding

### CV-SEC-001 — Unauthenticated server exposes private local data to LAN and cross-origin clients

**Evidence**

- `claudeville/server.js:86-95` sends `Access-Control-Allow-Origin: *` on API JSON.
- `claudeville/server.js:2010-2015` accepts permissive preflights for every path.
- `claudeville/server.js:2065-2069` calls `server.listen(PORT)` without a host. The live socket was `*:4000`.
- `claudeville/server.js:551-587` and `:2034-2039` accept WebSocket upgrades without checking request path, `Origin`, `Host`, WebSocket version, or an access credential.
- No authentication layer exists.

Live requests using `Origin: https://attacker.example` returned:

- `GET /api/sessions`: HTTP 200, wildcard CORS, approximately 47 KiB of session data.
- `OPTIONS /api/session-details`: HTTP 204 allowing `GET, POST, OPTIONS` and `Content-Type`.

The exposed surfaces include local project/home paths, active sessions, messages, tool inputs, Git events, task metadata, account email/subscription/quota information, and detailed runtime paths/counters. `/api/tasks` returned about 270 KiB in the audited environment. Cross-origin WebSockets are especially relevant because WebSocket handshakes do not use the browser's CORS enforcement and this server ignores `Origin`.

Browser mixed-content and Private Network Access policies block some public-HTTPS attack contexts, but they do not protect direct LAN clients, local HTTP origins, extensions, desktop clients, or every browser/network combination.

**Remediation direction**

Bind loopback only (`127.0.0.1`, with an intentional IPv6 choice) by default. Make LAN mode explicit and authenticated. Remove wildcard CORS or allow only the exact dashboard origin. Validate `Host`, HTTP `Origin`, WebSocket `Origin`, WebSocket path/version/method, and add negative integration tests for hostile origins and the actual listen address.

**Acceptance evidence**

- The default listener is loopback-only.
- Hostile-origin HTTP and WebSocket requests fail.
- The dashboard still boots and reconnects from its intended origin.
- An explicitly enabled LAN mode requires a secret not present in URLs or logs.

## High-severity findings

### CV-DATA-001 — Activity Panel can attribute one agent's private detail to another

`ActivityPanel.show()` changes the heading/current agent and resets render signatures, but it does not clear the existing tool history, messages, context/cost, or biography DOM (`shared/ActivityPanel.js:510-536`). A null, failed, or slow detail response returns without clearing it (`:749-767`). Even a successful response that omits usage leaves old token/context/cost data because `_renderTokenUsage()` returns without clearing (`:856-857`). Chronicle loading is independently asynchronous (`:1025-1048`), and `_showAgentSections()` makes old sections visible again (`:1715-1718`).

A runtime sentinel probe selected agent A and then agent B while B's detail was unavailable. The panel showed B's name with A's tool history, messages, context, and visible biography. If B's fetch never succeeds, the false attribution remains indefinitely.

This can misstate who ran a command, sent a message, consumed context, or incurred cost.

**Remediation direction:** synchronously clear or replace all fetched sections on session identity change, render keyed loading/unavailable states, and associate every committed render with the agent/session key that produced it. Add tests covering A success → B pending/failure and A-with-usage → B-success-without-usage.

### CV-DATA-002 — Biography push totals and milestones inflate on reload

`AgentBiographyService` correctly baselines cumulative tokens, but creates a new empty `countedPushKeys` set whenever a session is first seen (`application/AgentBiographyService.js:154-170`). It then counts every attached push that is not in that in-memory set (`:183-198`). Persisted biography records contain totals and milestones, but no event identities or watermark (`domain/value-objects/AgentBiography.js:145-157`).

Reloading while the same session and Git events remain visible counts those pushes again and can repeatedly advance lifetime milestones.

**Remediation direction:** persist a bounded recent-event identity set/watermark, or baseline all events present on first sight and count only later additions. Add reload-idempotence and bounded-history tests.

### CV-DATA-003 — Relationship affinity is non-idempotent and misses most chats

Meeting and Git dedupe state exists only in memory (`RelationshipAffinityService.js:73-76,180-192`). On a reload, the same live session pair is counted as a new meeting (`:206-214`), and every attached countable Git event is fresh again (`:235-251`). A repository event attached to multiple agents can also be credited more than once. Persisted `PairAffinity` records store totals but no interaction identities (`PairAffinity.js:89-102`).

Chat counting examines only the currently running `SendMessage` tool and suppresses consecutive identical raw inputs for that roster entry until a different signature appears or the entry is recreated (`RelationshipAffinityService.js:217-231`). It does not consume the adapter's timestamped `agent.sendMessages`, so completed or short-lived messages are normally missed and repeated identical chats can be suppressed.

**Remediation direction:** consume stable `sendMessages` identities, persist bounded interaction IDs/watermarks, baseline pre-existing meeting/Git events, and dedupe shared commits by pair plus event identity. Tests should cover reload, two agents carrying the same Git event, repeated identical messages at different times, and a completed `SendMessage`.

### CV-RUNTIME-001 — Transient poll failures idle and then remove every agent

`ClaudeDataSource` catches fetch failures and returns the same `[]` used for a legitimate empty session list (`infrastructure/ClaudeDataSource.js:16-25`). `SessionWatcher` treats that fulfilled value as authoritative (`application/SessionWatcher.js:89-103`). `AgentManager` idles agents missing from one response and removes them if they are absent again (`application/AgentManager.js:72-88`).

Trigger: the WebSocket is disconnected and two HTTP polls fail. The result is a false empty village, departure notifications and biography/affinity churn, followed by false arrivals when connectivity returns.

**Remediation direction:** preserve failure as failure through a rejected promise, `null`, or result envelope; only reconcile a successfully obtained session list. Keep initial-load UI fallback separate from authoritative domain updates. Add two-consecutive-failure and recovery tests.

### CV-DATA-004 — Chronicle and spend writes can be lost during teardown

`ChronicleLog.stop()` and `SpendLedger.stop()` unsubscribe but do not drain their promise tails (`application/ChronicleLog.js:132-139,271-313`; `application/SpendLedger.js:72-79,162-173`). `App.destroy()` calls `stop()`, omits these tails from its store tasks, and then closes IndexedDB (`presentation/App.js:711-716,757-765`).

If several writes are queued at page hide/destroy, later chained writes can begin after `ChronicleStore.close()` and fail, losing the newest chronicle/spend state.

**Remediation direction:** make stop asynchronous and drain, or explicitly await both `flush()` calls before closing the store. Add a delayed-store teardown test that proves all pre-stop writes persist.

### CV-LIFE-001 — Offscreen-cue overlay retains the first World renderer

`VillageDirectorOverlay.js:625-627` stores cue state and `_edgeWired` at module scope. `wireEdgeCues()` registers anonymous event-bus and capture-phase canvas click handlers without retaining either disposer (`:636-671`). `_edgeWired` never resets.

`node scripts/smoke/browser-lifecycle.mjs --count=250` fails because one `village:camera-cue` listener remains after `App.destroy()`. A targeted listener probe also found the capture click handler still attached. The click closure retains the first renderer/camera, and same-document application reinitialization cannot wire the replacement because `_edgeWired` is already true.

**Remediation direction:** make edge cues instance-owned, retain both disposers, clear arrays on teardown, and call disposal from `IsometricRenderer.hide()`. The lifecycle smoke must pass through App reboot with baseline listener counts restored.

### CV-WORLD-001 — Eleven authored visit slots are not walkable

An exact browser probe against the generated `SceneryEngine`/`Pathfinder` grid found these unique authored slots blocked:

| Building | Blocked authored slots |
| --- | --- |
| Command | entrance/work `16,21`; queue `17,22` |
| Task Board | overflow `22,34`, `24,34` |
| Forge | queue `24,31`; scenic `30,28` |
| Watchtower | queue `28,15`; scenic `29,15` |
| Harbor | entrance/work `29,19`; queue `29,21`; scenic `28,21` |

Relevant definitions are in `config/buildings.js:54-55,85-97,151-161,308-315,336-346`. Causes include water, a non-walkable landmark bridge, own-building walk exclusions, and one Forge slot inside the Task Board footprint. Harbor's configured entrance is itself blocked.

`VisitTileAllocator` detects whether any candidate is walkable and silently skips blocked candidates (`VisitTileAllocator.js:243-260`), so these authored roles/capacity are never used while another valid slot exists. Capacity and diagnostics therefore overstate actual behavior.

**Remediation direction:** relocate or intentionally classify every slot, then add a validator built from the exact runtime walkability grid. It should check base and overflow uniqueness, cross-building footprints, water/bridge masks, walk exclusions, and reachability from the gate.

### CV-PERF-001 — Heavy rain reduces deterministic World FPS by about 42%

The repeat benchmark at 1600×1000, DPR 1, two eight-second repetitions per case produced:

| Agents | Clear median | Heavy-rain median | Change | Rain frame p95 |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 43 FPS | 25 FPS | -41.9% | 50.1 ms |
| 50 | 38 FPS | 22 FPS | -42.1% | 50.1 ms |

The repository's top-bar performance bands classify below 25 FPS as struggling. At 50 agents/rain, render median was about 32 ms. The broad profiled `terrain` stage was about 22 ms median in rain versus roughly 10.5 ms in clear conditions. That segment spans `WorldFrameRenderer.js:84-111`, including terrain/water, cloud shadows, ground fog, sky canopy, fauna, trails, Director ground marks, and reflections. Dynamic water highlights and weather puddles (`IsometricRenderer.js:4532-4543`) are candidates, but the current segment timing does not isolate them as the cause.

The benchmark reports `"ok": true` regardless of measured FPS (`scripts/smoke/world-fps-benchmark.mjs:365-392`), so it cannot currently catch a regression.

**Remediation direction:** profile water highlights, puddles, ripples, and current bands separately; reduce cadence/density or cache weather-stable layers; then add a repeatable relative clear-vs-rain budget and a minimum crowded-rain threshold. Hardware variance makes paired relative thresholds preferable to one universal absolute number.

## Medium-severity findings

### CV-LIFE-002 — Failed World mount can retain destroyed Dashboard avatars without bound

When no shared `Compositor` exists, `Compositor.onSharedAvailable()` queues the supplied callback (`character-mode/Compositor.js:35-52`). Every `AvatarCanvas` supplies a closure capturing itself (`dashboard-mode/AvatarCanvas.js:78-85`), but `destroy()` only removes the avatar from a separate set (`:696-698`) and cannot unsubscribe.

A deterministic probe constructed and destroyed 100 avatars before compositor availability and found exactly 100 callbacks retained. `App.js:295-367` intentionally allows Dashboard mode to remain available after a World renderer mount failure, so the compositor may never arrive to drain the queue.

**Remediation direction:** return an unsubscribe function from `onSharedAvailable`, store it per avatar, and invoke it in `destroy()`. Verify both compositor-never-created and compositor-recreated paths.

### CV-BOOT-001 — A blocked `localStorage` read aborts application boot

`Sidebar` reads `claudeville.sidebarCollapsed` during construction and writes it on toggle without a guard (`shared/Sidebar.js:43,120-125`). Other storage-using components already degrade safely.

A runtime probe that made only this key throw `SecurityError` produced the application's boot-failure screen.

**Remediation direction:** route reads/writes through a safe helper and default to expanded when storage is unavailable. Add a browser lifecycle scenario with throwing storage.

### CV-UI-001 — Gemini receives different avatars in World and Dashboard

`getModelVisualIdentity()` has no Gemini branch and returns `spriteId: null` (`shared/ModelVisualIdentity.js:170-472`). World falls back to `agent.${provider}.base` (`character-mode/AgentSprite.js:2154-2158`), and `agent.gemini.base` exists in `manifest.yaml`. Dashboard's `AvatarCanvas` requires `identity.spriteId` and otherwise uses procedural art (`dashboard-mode/AvatarCanvas.js:215-218`).

A runtime probe for `gemini-2.5-pro` confirmed a null identity sprite while the manifest fallback exists.

**Remediation direction:** add a canonical Gemini identity or centralize provider-base fallback resolution for every renderer.

### CV-UI-002 — Dashboard avatars can keep stale appearance and team trim

Dashboard's avatar redraw signature excludes `teamName` and appearance (`dashboard-mode/DashboardRenderer.js:656-660`), even though team trim changes compositor output (`dashboard-mode/AvatarCanvas.js:323-329`). A team join/leave can update the card badge while leaving the old or missing sash on the avatar until some unrelated redraw trigger; appearance-only changes have the same stale-canvas risk.

**Remediation direction:** include team and appearance inputs in the avatar identity/signature, then test join, leave, team change, and appearance-only update without another model/status change.

### CV-A11Y-001 — Sidebar agents and parent links are mouse-only

Sidebar selection is delegated exclusively from click events (`shared/Sidebar.js:130-155`). Agent rows are plain `div` elements (`:473-485`), and parent navigation is a styled `span` (`:449-459`), with no native semantics, role, tabindex, Enter/Space behavior, or selected-state announcement. Important status is primarily encoded by color/dot.

**Remediation direction:** use native buttons/links where practical, or implement full list-option/button semantics, keyboard activation, `aria-selected`/current state, and a textual status name.

### CV-A11Y-002 — Modal focus escapes behind an `aria-modal` dialog

`Modal.open()` focuses the close button and handles Escape, but does not contain Tab/Shift+Tab or make the application shell inert (`shared/Modal.js:24-47`; `index.html:239-247`). A live Tab sequence escaped from the changelog dialog into `BODY` and top-bar controls.

**Remediation direction:** contain focus within the active dialog and make the background inert while open; preserve the already-correct focus restoration on close.

### CV-A11Y-003 — Dashboard cards contain nested interactive controls

Cards are `div role="button" tabindex="0"` while containing a native copy button and, for subagents, a second `role="button"` parent chip (`dashboard-mode/DashboardRenderer.js:408-513,675-702`). Propagation guards prevent accidental card activation, but the accessibility tree still has interactive descendants inside an interactive parent.

**Remediation direction:** make a dedicated title/action the selection control and keep copy/parent actions as siblings rather than descendants.

### CV-DATA-005 — Mood backfills historical Git events as current and retains unbounded keys

Every previously unseen Git event is recorded at `Date.now()` instead of using its event timestamp (`application/MoodService.js:131-139`). Provider enrichment can surface a batch of recent history, immediately creating a false proud streak and weather influence. `countedStreakKeys` grows for the lifetime of a resident agent and is only released when the agent is removed (`:98-108,131-139`).

**Remediation direction:** use the event's actual time, baseline/ignore events outside the mood retention window, and bound identity retention to that window.

### CV-DATA-006 — Chronicle labels pull/fetch events as commits

The Git subsystem emits `commit`, `push`, `pull`, and `fetch`, but `ChronicleLog.js:234-252` maps only exact `push` to PUSH and every other accepted event to COMMIT. A synthetic probe reproduced a pull/fetch being persisted as a commit.

**Remediation direction:** accept only commit/push for the current chronicle schema or add distinct pull/fetch kinds and presentation.

### CV-PERF-002 — Unchanged JSONL tails are reparsed at very high volume

`adapters/shared.js:345-374` executes `JSON.parse` for every returned line on every call even when the text-tail cache hits. Claude adds a parsed cache, but oversized records are rejected and repeatedly reparsed.

After about 26.7 hours, live diagnostics showed roughly 99.1 million Claude and 40.4 million Codex parsed-line operations, 22,680 Claude parsed-cache rejections, about 8.6% lifetime average server CPU, p99 event-loop delay around 161 ms, and a current broadcast session stage near 138 ms. This is not a demonstrated memory leak, but it is sustained avoidable CPU work.

**Remediation direction:** cache parsed/summarized results by file signature, parse appends incrementally, retain only fields required by session-list presentation, and avoid repeatedly reparsing oversized rejected tails.

### CV-PERF-003 — Synchronous Git subprocesses can block the server event loop

Repository discovery and Git enrichment use `execFileSync` (`adapters/index.js:141-146`; `adapters/gitEvents.js:850-875`). Discovery permits up to 80 projects. Each command has a 750 ms timeout, but commands execute serially on the same Node event loop that serves HTTP, WebSocket heartbeats, and broadcasts.

The live server recorded roughly 63,000 Git commands and 472 seconds aggregate Git time with no timeouts; warm-cache smoke results were good. This establishes blocking architecture, not a current outage.

**Remediation direction:** use asynchronous subprocesses with bounded concurrency, or move enrichment into a separately scheduled/worker-backed cache refresh.

### CV-NET-001 — WebSocket frame parsing omits required protocol validation

`server.js:628-684` does not require client masking and does not fully validate FIN/RSV or control-frame constraints. The browser client sends compliant, small frames, so current product behavior is unaffected, but malformed clients are not handled to RFC expectations.

**Remediation direction:** validate mask, fragmentation/control limits, upgrade method/version/key, and close invalid peers with protocol errors.

### CV-WORLD-002 — Eight overflow visit entries duplicate base slots

`VISIT_OVERFLOW_TILES` repeats base coordinates:

- Command: `15,22`, `17,22`
- Archive: `8,19`, `9,16`, `10,17`, `10,18`
- Watchtower: `28,15`, `27,15`

`VisitTileAllocator._candidateTiles()` de-duplicates coordinates (`VisitTileAllocator.js:601-618`), so these entries add no overflow capacity.

**Remediation direction:** replace them with distinct walkable locations and extend validation to overflow data.

### CV-WORLD-003 — Blocked-target path fallback can stop 5–7 tiles away and report success

`Pathfinder._walkableCandidates()` collects all walkable candidates from radii 1 through 5 instead of stopping at the nearest viable radius (`character-mode/Pathfinder.js:209-223`). Both search paths then optimize from the source across that over-broad target set instead of first constraining target proximity (`Pathfinder.js:137-143,160-193,226-277`). The reproduced routes used the weighted path because bridge tiles were supplied; the unweighted BFS has the same conceptual target-selection flaw. `AgentSprite._assignTarget()` treats any non-empty path as reachable (`AgentSprite.js:1155-1175`).

A runtime probe from the village gate to blocked authored targets returned non-empty paths with endpoints 5.0–7.07 tiles from the requested target. Current activation is reduced because the visit allocator skips known blocked slots, but future/direct blocked targets can silently succeed far away.

**Remediation direction:** stop candidate expansion at the first radius with viable cells or rank by target distance, and reject endpoints outside an explicit tolerance.

### CV-PERF-004 — Boot eagerly fetches/decodes every sprite and loads the full module graph

`AssetManager.load()` loads every manifest entry concurrently (`character-mode/AssetManager.js:30-47`). The cold local load at 1600×1000 completed application readiness in about 1.23 seconds, but required 293 responses: 121 scripts, 153 images, 8 CSS files, 8 fetches, 2 fonts, and the document. Known raw payload was roughly 8.4 MiB.

The asset cache contained 154 bitmaps and 15,717,856 decoded pixels, approximately 60 MiB RGBA. Character sheets were about 90% of those pixels. The cache is bounded and `AssetManager.dispose()` clears it (`:402-428`), so this is not a leak. Additional compositor/sheet/live-canvas counters were within their explicit caps and may share backing references, so they must not be naively summed.

Static responses were not compressed and omitted `Content-Length`; JavaScript/CSS used `no-cache`, while versioned sprites used immutable caching. In a local zero-build application this is a tradeoff, but decoding provider/model variants that are not present in the village is avoidable.

**Remediation direction:** eagerly load terrain/buildings/common effects, lazy-load character variants based on observed providers/models, cap concurrent decoding, and measure cold/reload behavior before considering static transfer changes.

## Low-severity findings

### CV-COPY-001 — `truncateText` exceeds its advertised maximum

`shared/Formatters.js:97-100` appends three dots after slicing to `max - 1`. For example, `truncateText(value, 8)` returns ten characters.

Reserve the ellipsis width, define behavior for maximums below three, and add pure unit tests.

### CV-A11Y-004 — Toast feedback is not announced

The toast container and messages have no live-region/status semantics (`index.html:250-251`; `shared/Toast.js:19-30`), so copy success/failure is visual-only.

Use a polite live region for normal feedback and reserve assertive treatment for errors.

### CV-PERF-005 — Biography reads repeat on every selected-agent update

`ActivityPanel` initiates biography reads from its general selected-agent update path (`shared/ActivityPanel.js:184-199`) despite having a dedicated `biography:updated` subscription (`:257-260`). Sequence checks prevent stale rendering but do not cancel the underlying asynchronous work.

Fetch on identity change and biography events, or memoize/cancel in-flight reads.

### CV-DATA-007 — Dashboard can retain an obsolete usage footer

When a newly fetched detail lacks usable token data, `DashboardRenderer.js:870-899` does not remove the previous `usageFooters` entry, leaving old token/cost data visible.

Clear and hide the footer when an authoritative detail result contains no usage.

### CV-COPY-002 — Empty-state copy understates multi-provider support

`index.html:122-125` says “Start a Claude Code session,” while the Dashboard later lists Codex, Gemini, OpenCode, and Kimi (`DashboardRenderer.js:1010-1024`).

Use provider-neutral “coding CLI session” copy.

### CV-DEAD-001 — `/api/tasks` is not consumed by the product UI

Only the server route and Claude adapter implement this endpoint (`server.js:267-274,1998`; `adapters/claude.js:1840-1865`). No frontend or production runtime-script caller was found. It does work only when requested, so it is not background dead-compute overhead, but it widens the private-data surface and returned about 270 KiB live.

Explicitly document it as a diagnostic/external API, integrate it, or remove it.

### CV-DEAD-002 — A small set of exports and procedural helpers has no callers

No whole production module or sprite subsystem was orphaned. The confirmed caller-free surface is limited to:

- `AGENT_SPEED` in `config/constants.js`
- `TOWN_DISTRICTS` in `config/townPlan.js`
- `tileVectorToWorld` in `character-mode/Projection.js`
- `getPulseBands` in `character-mode/PulsePolicy.js`
- `safeDisconnect` in `shared/audio/AudioEngine.js`
- The external `append` export in `shared/DomSafe.js`; the helper itself is used internally by `el()` and `replaceChildren()`
- `AssetManager.entryFor()`; active code uses `getEntry()`
- Superseded procedural Forge helpers in `BuildingSprite.js`
- Superseded procedural prop helpers in `IsometricRenderer.js`

These do not execute in hot paths, but they enlarge already substantial parsing/review surface. Remove only after a final external/debug API check.

## Subsystem utilization and verification

| Subsystem | Production use | Verification | Verdict |
| --- | --- | --- | --- |
| HTTP/static server | Core boot and API delivery | Syntax, live routes, malformed input, traversal, oversized body, long-running process | Used; robust request bounds, but CV-SEC-001 is critical |
| WebSocket/delta transport | Primary live update path | Live connection, heartbeat/backpressure source review, lifecycle soak | Used; bounded, with origin/protocol hardening gaps |
| Claude adapter | Live session/detail/task source | Live sessions plus fixtures, aggregation/tail/runtime smokes | Used; high parse churn |
| Codex adapter | Live session/detail source | Live sessions plus fixtures and warm-discovery smoke | Used; high parse churn |
| Gemini/Grok/Kimi/OpenCode adapters | Registered production providers | Import/reachability, generic fixtures/static review; provider directories active for some, no representative live sessions | Used paths exist; current transcript schema behavior not fully live-verified |
| Git event enrichment | Session presentation, harbor, chronicle, mood, affinity | Fixture tests, live counters, watcher/runtime smokes | Used; synchronous execution and downstream idempotency issues |
| Usage/quota service | Top bar/account state | Live `/api/usage`, bounds/source review | Used and bounded |
| Session residency | Keeps recently active sessions resident | 53 unit tests, perf diagnostics | Used and bounded |
| Browser domain/application | Agent reconciliation, status, biography, affinity, mood, chronicle, spend, modes | Static graph, unit tests, runtime selection/lifecycle probes | Used; several uncovered state/idempotency defects |
| Browser infrastructure | Fetch, WebSocket/poll fallback, IndexedDB | Live boot/reconnect paths, teardown review | Used; failed-poll semantics and write draining need correction |
| Dashboard mode | DOM session overview | Live World↔Dashboard switching, selection/close flow, source/lifecycle probes | Used; no orphan component |
| Shared UI | Sidebar, Activity Panel, TopBar, modal, toast, formatting | Live interactions and targeted DOM probes | Used; data-attribution and accessibility findings |
| Ambient/BGM audio | Optional user-enabled sound | Lifecycle smoke exercised unlock/teardown before later World assertion | Used optional subsystem; no ordinary-path leak found |
| World/canvas | Primary village visualization | Live rendering, validators, state/traffic smokes, FPS/profile, context/lifecycle probes | Used; one leak, visit/path defects, rain bottleneck |
| Assets/sprite manifest | World and Dashboard visuals | 252 references, 151 manifest IDs, 153 expected files, zero missing/orphan/duplicate/invalid/warnings | Fully accounted for; eager decode opportunity |
| Configuration/world building | Buildings, terrain, pricing, theme, model identity | Theme, building, terrain, sprite validators; exact runtime walkability probe | Used; validators miss runtime slot walkability |
| Validation/smoke scripts | Developer/release safety | 53 unit tests and 12 deterministic smokes executed | Valuable; lifecycle/FPS/world-grid gaps are material |
| Documentation/versioning | Onboarding and in-app changelog | Root doc parity, version/changelog consistency, diff review | Current baseline consistent |
| Dev dependencies | Validation/capture only | Caller search and `npm audit` | All four used; zero reported vulnerabilities |

All 122 browser JavaScript modules were statically reachable from `presentation/App.js` (including dynamic World/simulator entry points). All server/adapters/services JavaScript was reachable from `server.js`. This establishes production reachability, not that every provider-specific branch was activated during this audit.

## Memory, resource, and lifecycle assessment

### What was healthy

- A 60-second forced-GC soak kept DOM listeners at 59, event-bus listeners at 115, and canvas elements at 1 throughout.
- Browser forced-GC heap was approximately 19.6 MiB at the first checkpoint, 30.2 MiB at the last, and 31.7 MiB maximum while the live agent population changed from 19 to 21. The harness's plateau assertions passed.
- Server RSS was approximately 347.3 MiB initially and 354.3 MiB at the last checkpoint; heap fell from about 80.2 MiB to 68.7 MiB.
- The maintained process had roughly 26.7 hours uptime, 27–32 file descriptors across samples, one inotify descriptor, and 69 installed watch entries matching runtime diagnostics.
- Current RSS samples were roughly 350 MiB, while `/proc` reported a `VmHWM` of 692,008 KiB (about 676 MiB). The short sample did not establish when or why that peak occurred.
- Watch counts, session residency, transcript/detail caches, Git state, broadcast histories, path caches, particles, harbor maps, light colors, compositor sheets, processed sheets, and volatile canvas pixels all remained within declared caps.
- The tail cache stayed under its 32 MiB limit.
- Shutdown code clears timers, watchers/retries, adapter streams/caches, event-loop monitoring, sockets, and renderer resources.
- Context loss/recovery, frame-failure circuit breaking, asset disposal, trail teardown, audio teardown, and 250 mode switches passed before the lifecycle smoke reached CV-LIFE-001.

### What was not healthy

- CV-LIFE-001 retains a retired World renderer and leaves a stale application listener after same-document teardown.
- CV-LIFE-002 can retain destroyed avatar/canvas/agent closures indefinitely when the compositor never mounts.
- Mood's per-resident Git key set is unbounded for a resident lifetime, although this is lower impact than the confirmed object-retention defects.
- Current server RSS and decoded canvas/image footprint are substantial, and JSON/Git work is expensive, even though the samples do not show unbounded growth.

### Conclusion

There is no evidence of a general steady-state memory leak across the audited soak and long-running server, but “no leak” cannot be claimed. Two concrete lifecycle leaks exist, one unbounded resident-lifetime set exists, and no heap-retainer snapshot or full-duration release soak was performed.

## Performance evidence

### Browser boot

- Viewport: 1600×1000, DPR 1, local maintained server
- DOMContentLoaded: about 176 ms
- Application ready: about 1.23 s
- Cold response count: 293
- Known raw transfer footprint: approximately 8.4 MiB
- Decoded asset cache: 154 bitmaps / 15.7 million pixels / roughly 60 MiB RGBA

The local boot time is acceptable on the audited machine, but the response/decode fan-out is unnecessarily tied to every possible model/provider asset.

### World rendering

The paired two-repetition benchmark consistently reproduced the rain regression:

```text
25 agents: clear 43 FPS, rain 25 FPS (-41.9%)
50 agents: clear 38 FPS, rain 22 FPS (-42.1%)
```

The broad profiled terrain-stage work was the dominant rain delta, but current instrumentation does not identify the responsible pass within that stage. No frame-failure circuit breaker was triggered; this is sustained slowness, not a crash.

### Server

The long-running server showed no watcher failures, transcript scan errors, malformed record counts, or fallback directory scans. Avoidable costs remain:

- approximately 139.5 million cumulative JSONL parse operations across Claude/Codex diagnostics
- approximately 63,000 synchronous Git commands
- approximately 472 seconds aggregate Git subprocess time
- p99 event-loop delay around 161 ms in the sampled long-running process

These numbers are cumulative diagnostics rather than per-request latency. They justify focused profiling and cache design, not a blanket rewrite.

## Validation ledger

### Passed

- `npm run validate:quick`
  - server/adapters/services/frontend/scripts syntax
  - Git-event fixtures
  - adapter fixtures
  - theme tokens
  - 53/53 dependency-free unit tests
  - sprite ID audit
- `npm run sprites:audit-refresh`
  - 153 expected assets, 0 missing, 0 orphan, 0 duplicate, 0 invalid, 0 warnings
- `npm run world:validate-buildings`
- `npm run world:validate-terrain`
- `npm audit --json` — 0 reported vulnerabilities
- Root `AGENTS.md`/`CLAUDE.md` parity
- Version consistency: package `0.28.1`, changelog `v0.28.1`, top-bar minor chip `v0.28`
- Deterministic smokes:
  - `adapters.mjs`
  - `relationship.mjs`
  - `claude-transcript-aggregate.mjs`
  - `codex-warm-discovery.mjs`
  - `harbor-traffic-bounds.mjs`
  - `scoped-invalidation.mjs`
  - `server-fatal.mjs`
  - `tail-cache.mjs`
  - `usage-history-bounds.mjs`
  - `watcher-runtime.mjs`
  - `watcher-topology.mjs`
  - `world-state-bounds.mjs`
- 60-second browser/server performance soak
- Live `/api/providers`, `/api/sessions`, `/api/teams`, `/api/tasks`, `/api/usage`, `/api/perf`, and changelog requests
- Live API error cases:
  - unknown route
  - missing identifiers
  - invalid provider
  - malformed JSON
  - path traversal
  - invalid URL encoding
  - approximately 270 KiB oversized POST rejected with 413
- Live World/Dashboard mode switch, agent selection, Activity Panel close, changelog open/close
- Browser console: no unexpected errors during normal boot and mode/selection flows

### Failed

- `node scripts/smoke/browser-lifecycle.mjs --count=250`
  - All preceding cache, audio, mode-switch, canvas, context-recovery, and ordinary cleanup assertions passed.
  - Final App teardown failed because `village:camera-cue` retained one listener (CV-LIFE-001).

### Performance result requiring a budget

- `node scripts/smoke/world-fps-benchmark.mjs --duration-seconds=8 --warmup-seconds=2 --repetitions=2 --counts=25,50 --weather=clear,rain --profile`
  - Script returned success because it has no thresholds.
  - Measurements confirmed CV-PERF-001.

## Important audit limitations

- Chrome DevTools performance-trace tooling was not available in this environment, so there is no formal Core Web Vitals trace or heap-retainer snapshot. Existing Playwright and repository performance harnesses were used instead.
- The full 10-minute browser and 30-minute server release soaks were not run. The completed soak was 60 seconds per side, supplemented by observation of the approximately 26.7-hour maintained server.
- No representative current live sessions were available for Gemini, Grok, Kimi, or OpenCode. Those adapters were checked through reachability, fixtures where available, and static schema/error-path review.
- The 53 unit tests do not directly cover `AgentBiographyService`, `RelationshipAffinityService`, `MoodService`, `AuroraGate`, datasource failure semantics, or Chronicle/SpendLedger teardown draining.
- The audit ran on Linux/Chromium. Platform-specific filesystem and browser behavior on macOS or other browsers was not exercised.
- Sprite integrity was audited, but a fresh capture/visual-diff suite was not run.
- The checkout began with unrelated deleted `/agents` artifacts and three untracked `scripts/world/capture-marketing*.mjs` files. They were preserved and excluded from product conclusions. Documentation links broken only because of those pre-existing deletions were not counted as codebase defects.

## Remediation-planning inputs

This is a findings document, not the remediation plan, but the dependencies suggest five workstreams:

1. **Trust boundary:** CV-SEC-001 and CV-NET-001, with negative network tests before any other release work.
2. **Identity and persistence correctness:** CV-DATA-001 through CV-DATA-007 plus CV-RUNTIME-001, backed by pure unit tests for reload/failure/teardown semantics.
3. **Lifecycle resilience:** CV-LIFE-001, CV-LIFE-002, and CV-BOOT-001, then promote the existing browser lifecycle smoke to a required release gate.
4. **World correctness and performance:** CV-WORLD-001 through CV-WORLD-003 and CV-PERF-001/CV-PERF-004, with an exact runtime-grid validator and a paired FPS regression budget.
5. **Accessibility and cleanup:** CV-A11Y-001 through CV-A11Y-004, Gemini parity, formatting/copy, and confirmed dead surfaces.

The strongest regression gates to add are:

- hostile-origin/listen-address HTTP and WebSocket tests
- biography/affinity reload idempotence
- failed-poll non-reconciliation
- delayed IndexedDB write-tail teardown
- Activity Panel A→B pending/failure race
- exact base/overflow visit-slot walkability and reachability
- blocked-target endpoint tolerance
- same-document App destroy/reboot listener parity
- Dashboard-without-Compositor avatar disposal
- Dashboard avatar redraw on provider, team, and appearance changes
- paired clear/rain FPS thresholds
