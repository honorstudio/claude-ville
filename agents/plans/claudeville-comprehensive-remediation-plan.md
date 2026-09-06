# ClaudeVille comprehensive remediation plan

**Status:** `implemented and verified`

**Open follow-ups:** See the [live open-followups checklist](open-followups.md)
for the deferred items and their measurement triggers.

**Source:** `agents/research/claudeville-comprehensive-verification/audit.md`

**Baseline:** `main` at `2d648cb` (`v0.28.1`)

## Goal

Fix the confirmed security, correctness, lifecycle, world, accessibility, and measured performance problems without adding frameworks or redesigning working subsystems.

## Guardrails

- Keep the zero-build vanilla JavaScript architecture.
- Add no runtime dependencies or new test framework.
- Keep changes local to each work package.
- Prefer existing helpers and validation scripts over new abstractions.
- Preserve desktop-only behavior at widths of 1280px and above.
- Do not add LAN mode or authentication in this pass. ClaudeVille remains loopback-only.
- Do not optimize async Git or asset loading unless the measurement gates in Package 9 are met.
- Recheck the audit's named source paths before implementation; line numbers may move.

## Execution order

| Order | Package | Priority | Depends on |
| ---: | --- | --- | --- |
| 1 | Secure the local server boundary | P0 | None |
| 2 | Fix session-detail and polling correctness | P1 | None |
| 3 | Make persisted history idempotent | P1 | None |
| 4 | Close teardown and retention leaks | P1 | None |
| 5 | Repair World visit/path correctness | P1 | None |
| 6 | Reduce the measured rain rendering cost | P2 | Package 5 |
| 7 | Fix visual identity and accessibility | P2 | Package 2 |
| 8 | Stop repeated JSONL parsing | P2 | Packages 1–4 |
| 9 | Apply small cleanup and explicit deferrals | P3 | Packages 1–8 |
| 10 | Run the release verification gate | P0 | All mandatory packages |

Packages 2–5 can be implemented independently if file ownership is kept separate. Package 10 is always last.

## Package 1 — Secure the local server boundary

**Findings:** CV-SEC-001, CV-NET-001

**Owned paths:** `claudeville/server.js`, `claudeville/src/infrastructure/WebSocketClient.js`, focused server smoke tests, relevant server docs

### Implementation checklist

- [x] Bind port 4000 to `127.0.0.1` explicitly.
- [x] Remove wildcard CORS headers and permissive universal preflight handling.
- [x] Allow browser API requests only when `Origin` is absent or exactly matches the accepted local dashboard origin/host.
- [x] Reject unsupported `Host` values.
- [x] Move the WebSocket client and upgrade route to one explicit path, such as `/ws`.
- [x] Validate WebSocket method, path, version 13, key, and local origin before upgrading.
- [x] Require masked client frames, reject RSV bits and unsupported fragmentation, and enforce control-frame limits.
- [x] Keep the existing browser client, ping/pong, deltas, and reconnect behavior unchanged.
- [x] Add one dependency-free server security smoke covering accepted and rejected HTTP/WebSocket requests.
- [x] Update server documentation to state that ClaudeVille is loopback-only.

### Acceptance

- [x] A fresh current-code runtime reports and exposes only a `127.0.0.1` listener. Verification used isolated port `44123` because the operator-maintained process on port 4000 predates this implementation.
- [x] Same-origin Dashboard/API/WebSocket behavior works.
- [x] A hostile `Origin` receives no session, detail, task, usage, or WebSocket data.
- [x] Malformed/unmasked WebSocket frames are closed cleanly.
- [x] Existing API error and oversized-body behavior remains intact.

## Package 2 — Fix session-detail and polling correctness

**Findings:** CV-DATA-001, CV-RUNTIME-001, CV-BOOT-001, CV-DATA-007, CV-PERF-005

**Owned paths:** `ClaudeDataSource.js`, `SessionWatcher.js`, `ActivityPanel.js`, `DashboardRenderer.js`, `Sidebar.js`, focused tests/smokes

### Implementation checklist

- [x] Return a distinct failure result from `ClaudeDataSource`; never convert a failed session request into authoritative `[]`.
- [x] Reconcile agents only after a successful session response.
- [x] Preserve the existing village through repeated poll failures and reconcile normally after recovery.
- [x] In `ActivityPanel.show()`, immediately clear all fetched agent-specific sections before rendering the new identity.
- [x] Show a minimal loading state, then either new data or an unavailable state.
- [x] Clear token/context/cost content when a successful detail response has no usage.
- [x] Keep sequence/key checks so late responses cannot overwrite the current agent.
- [x] Fetch biography on selection/identity change and `biography:updated`, not every generic agent update.
- [x] Clear a Dashboard usage footer when authoritative detail has no usage.
- [x] Wrap Sidebar storage reads/writes and default to expanded when storage is blocked.

### Tests

- [x] A success → B pending/failure never shows A data under B.
- [x] A with usage → B success without usage clears A usage.
- [x] Two failed polls do not idle/remove agents or emit false departures.
- [x] Recovery after failed polls reconciles once without false re-arrivals.
- [x] Throwing `localStorage` does not abort App boot.

### Acceptance

- [x] World and Dashboard selection/deselection still work.
- [x] Activity Panel never mixes identities.
- [x] Network failures leave current agents visible with existing reconnect behavior.

## Package 3 — Make persisted history idempotent

**Findings:** CV-DATA-002, CV-DATA-003, CV-DATA-005, CV-DATA-006

**Owned paths:** `AgentBiographyService.js`, `AgentBiography.js`, `RelationshipAffinityService.js`, `PairAffinity.js`, `MoodService.js`, `ChronicleLog.js`, pure unit tests

### Implementation checklist

- [x] Persist compact event watermarks/recent keys for biography pushes; do not retain unbounded history.
- [x] Baseline already-visible events on first observation so reload cannot recount them.
- [x] Persist enough pair interaction identity to prevent reload duplication of meetings and Git interactions.
- [x] Consume timestamped `agent.sendMessages` instead of relying only on the current `SendMessage` tool.
- [x] Deduplicate shared Git events by pair plus stable event identity.
- [x] Use Git event timestamps for mood and ignore events outside the mood window.
- [x] Bound mood's remembered event keys to the same window.
- [x] Chronicle only `commit` and `push`, or represent `pull`/`fetch` with their own correct kinds.
- [x] Keep persisted-record migration backward-compatible with safe defaults.

### Tests

- [x] Reloading the same sessions/events does not increment biography or affinity totals.
- [x] The same Git event attached to two agents counts once per pair.
- [x] Repeated identical messages at different timestamps count separately.
- [x] Completed `SendMessage` events count even when no longer the current tool.
- [x] Historical Git events do not create a current mood streak.
- [x] Pull/fetch events are never labeled as commits.

### Acceptance

- [x] All new state is bounded.
- [x] Existing IndexedDB records load without manual migration.
- [x] `npm run test:unit` covers the corrected behavior.

## Package 4 — Close teardown and retention leaks

**Findings:** CV-DATA-004, CV-LIFE-001, CV-LIFE-002

**Owned paths:** `ChronicleLog.js`, `SpendLedger.js`, `App.js`, `VillageDirectorOverlay.js`, `IsometricRenderer.js`, `Compositor.js`, `AvatarCanvas.js`, browser lifecycle smoke

### Implementation checklist

- [x] Make Chronicle and SpendLedger shutdown drain their existing write tails.
- [x] Await both drains before `ChronicleStore.close()`.
- [x] Make offscreen cue state renderer-owned rather than module-global.
- [x] Store and invoke both the event-bus unsubscribe and capture-click removal.
- [x] Clear cue/hit state when the renderer hides or is destroyed.
- [x] Make `Compositor.onSharedAvailable()` return an unsubscribe function.
- [x] Store that unsubscribe in each `AvatarCanvas` and invoke it from `destroy()`.
- [x] Avoid introducing a second lifecycle abstraction; use the repository's existing disposer patterns.

### Tests

- [x] Delayed Chronicle/Spend writes finish before store close.
- [x] App destroy restores event-bus and DOM-listener baselines.
- [x] Same-document App reboot wires cues to the new renderer only.
- [x] Creating/destroying avatars without a compositor leaves zero queued callbacks.

### Acceptance

- [x] `node scripts/smoke/browser-lifecycle.mjs --count=250` passes completely.
- [x] The normal and renderer-failure Dashboard paths retain no destroyed avatars.

## Package 5 — Repair World visit/path correctness

**Findings:** CV-WORLD-001, CV-WORLD-002, CV-WORLD-003

**Owned paths:** `config/buildings.js`, overflow visit configuration, `Pathfinder.js`, `AgentSprite.js`, World validators/smokes

### Implementation checklist

- [x] Move the eleven known blocked base/overflow slots to distinct walkable coordinates.
- [x] Ensure each configured entrance is walkable and represented intentionally.
- [x] Replace the eight overflow entries that duplicate base slots.
- [x] Change blocked-target candidate selection to use only the nearest viable radius.
- [x] Apply the same endpoint rule to weighted and unweighted path search.
- [x] Mark a target unreachable if the returned endpoint exceeds a one-tile Chebyshev tolerance.
- [x] Extend building validation to cover overflow duplicates, other-building footprints, and walk exclusions.
- [x] Add one focused World smoke that uses the production scenery/pathfinder grid to verify walkability and gate reachability; do not duplicate grid math in the test.

### Acceptance

- [x] Every base and overflow visit slot is unique, walkable, and reachable from the gate.
- [x] Configured capacity matches usable capacity.
- [x] Blocked targets never report success more than one tile away.
- [x] Building, terrain, relationship, World-state, and harbor smokes pass.

## Package 6 — Reduce the measured rain rendering cost

**Finding:** CV-PERF-001

**Owned paths:** World frame profiling, the measured rain-heavy render passes, FPS benchmark

### Implementation checklist

- [x] Split the existing broad terrain profile into named sub-passes only while profiling is enabled.
- [x] Re-run paired clear/rain cases and identify the largest actual rain delta.
- [x] Optimize only the dominant one or two passes using cadence, bounded density, or a weather-stable cache.
- [x] Preserve reduced-motion behavior and the existing visual character.
- [x] Add a benchmark option that fails when rain regression exceeds 30% versus clear at the same agent count.
- [x] Keep absolute FPS informational because host hardware/load varies.

### Acceptance

- [x] At 25 and 50 agents, rain median FPS is no more than 30% below paired clear FPS.
- [x] No frame failures or new unbounded canvas/cache growth.
- [x] Clear/rain and day/night visual smoke checks show no obvious regression.

## Package 7 — Fix visual identity and accessibility

**Findings:** CV-UI-001, CV-UI-002, CV-A11Y-001, CV-A11Y-002, CV-A11Y-003, CV-A11Y-004, CV-COPY-001, CV-COPY-002

**Owned paths:** `ModelVisualIdentity.js`, Dashboard avatar/card code, Sidebar, Modal, Toast, formatters, `index.html`, relevant CSS

### Implementation checklist

- [x] Centralize provider-base sprite fallback so Gemini matches in World and Dashboard.
- [x] Include provider/model, appearance, and team trim inputs in Dashboard avatar invalidation.
- [x] Make Sidebar agent rows and parent links real keyboard-operable controls with selected/status text.
- [x] Keep focus inside an open modal and make the background inert; preserve focus restoration.
- [x] Replace the whole-card nested button pattern with one dedicated selection control and sibling actions.
- [x] Add a polite live region for normal toast feedback.
- [x] Fix `truncateText()` so returned length never exceeds `max`, including very small limits.
- [x] Change the empty-state text to “coding CLI session” or equivalent provider-neutral copy.
- [x] Add no accessibility dependency.

### Tests

- [x] Gemini, team join/leave, and appearance-only changes redraw correctly.
- [x] Sidebar, Dashboard cards, copy, parent selection, modal, and close actions work with keyboard only.
- [x] Tab/Shift+Tab cannot escape an open modal.
- [x] Formatter unit tests cover limits 0–8 and normal text.

### Acceptance

- [x] World and Dashboard retain their current desktop layout and visual identity.
- [x] No nested interactive controls remain in Dashboard cards.
- [x] Copy success/failure is announced.

## Package 8 — Stop repeated JSONL parsing

**Finding:** CV-PERF-002

**Owned paths:** adapter shared tail/cache code, Claude/Codex adapter integration, cache diagnostics and smokes

### Implementation checklist

- [x] Cache parsed or presentation-ready tail results by the existing file signature.
- [x] Parse only appended content when the signature indicates a safe append.
- [x] Keep the cache byte-bounded and clear it through existing adapter teardown/invalidation.
- [x] Do not add a worker, database, or new cache layer.
- [x] Preserve malformed trailing-line and skipped-line diagnostics.
- [x] Add a smoke proving unchanged reads do not repeat `JSON.parse`.

### Acceptance

- [x] Tail-cache, aggregate, warm-discovery, watcher-runtime, and scoped-invalidation smokes pass.
- [x] Repeated unchanged broadcasts stop increasing parsed-line counters materially.
- [x] Session/detail output remains byte-for-byte equivalent for fixtures.

## Package 9 — Small cleanup and explicit deferrals

**Findings:** CV-PERF-003, CV-PERF-004, CV-DEAD-001, CV-DEAD-002

### Required cleanup

- [x] Keep `/api/tasks` as a documented loopback-only diagnostic endpoint; do not build a UI for it.
- [x] Keep `/api/providers` and `/api/perf` as diagnostic surfaces.
- [x] Re-run caller searches for the audit's dead exports/helpers.
- [x] Remove only confirmed unused exports and superseded procedural helpers; do not refactor neighboring hot files.

### Deferred by default

- [x] **CV-PERF-003:** Do not convert Git execution to a new async subsystem in this pass. Reconsider only if post-Package-8 runtime measurements show Git timeouts or sustained user-visible event-loop/broadcast stalls.
- [x] **CV-PERF-004:** Do not add lazy asset infrastructure while local cold readiness remains near the measured 1.23 seconds and caches remain bounded. Reconsider only if cold readiness exceeds 2 seconds or memory pressure is reproduced.

### Acceptance

- [x] Every removed symbol has zero callers before deletion.
- [x] Deferred items remain documented with their measurement trigger.
- [x] No behavior change is introduced solely for cleanup.

## Package 10 — Release verification gate

### Automated

- [x] `npm run validate:quick`
- [x] `npm run sprites:audit-refresh`
- [x] `npm run world:validate-buildings`
- [x] `npm run world:validate-terrain`
- [x] `node scripts/smoke/adapters.mjs`
- [x] `NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs`
- [x] Tail, aggregate, warm-discovery, watcher, residency, harbor, and World-state smokes
- [x] New server security smoke
- [x] `node scripts/smoke/browser-lifecycle.mjs --count=250`
- [x] Paired FPS benchmark at 25 and 50 agents, clear and rain, at least two repetitions
- [x] `npm audit --json`

### Live browser/API

- [x] Start a fresh current-code runtime. It was run on isolated port `44123` to avoid stopping the operator-maintained process on port 4000.
- [x] Confirm loopback-only HTTP and WebSocket listeners.
- [x] Exercise World and Dashboard, agent select/deselect, building selection, panel races, changelog, audio, and keyboard flows.
- [x] Confirm no unexpected console errors.
- [x] Confirm `/api/providers`, `/api/sessions`, `/api/teams`, `/api/tasks`, `/api/usage`, `/api/perf`, and changelog behavior.
- [x] Confirm hostile-origin HTTP/WebSocket requests fail.
- [x] Run a 60-second browser/server soak and compare listener, canvas, watcher, heap, RSS, and cache bounds with the audit baseline.

### Release hygiene

- [x] Re-run `git status --short` and review only owned changes.
- [x] `CHANGELOG.md` and version locations were intentionally left unchanged because no release push was requested.
- [x] Git tag/release flow is not applicable until a push is requested.

## Definition of done

- [x] Packages 1–8 and the required part of Package 9 are complete.
- [x] Every audit finding has either a passing fix or the explicit deferral recorded in Package 9.
- [x] Package 10 passes without exceptions.
- [x] The original audit remains the evidence record; this plan is updated with execution notes rather than rewritten into a new plan.

## Execution record — July 26, 2026

Implementation started from `main` at `2d648cb` (`v0.28.1`). No dependency, framework, build-system, version, or release change was introduced. The original audit remains unchanged.

### Package outcome

| Package | Outcome |
| --- | --- |
| 1. Server boundary | Explicit loopback binding, same-local-origin HTTP policy, `/ws` validation, RFC frame rejection, shutdown cleanup, documentation, and security smoke coverage. |
| 2. Polling and detail correctness | Failed session requests no longer reconcile an empty village; identity-bound detail and usage are cleared correctly; biography reads are scoped; blocked storage cannot abort boot. |
| 3. Persisted history | Biography, affinity, and mood event identities are persisted and bounded; reload/shared-event duplication is prevented; Chronicle records only commit/push. |
| 4. Lifecycle | Chronicle and spend writes drain before store close; renderer cue/listener ownership and avatar compositor subscriptions are disposed. |
| 5. World correctness | All 83 authored visit slots are unique, walkable, and reachable; blocked path endpoints are constrained to one tile. |
| 6. Rain performance | Profiling is opt-in and granular; rain/water/fog work is bounded; the paired 30% regression gate passes at 25 and 50 agents. |
| 7. Identity and accessibility | Provider/avatar identity is consistent; controls are native and non-nested; modal focus is trapped/restored; toast feedback is announced; copy and truncation are corrected. |
| 8. JSONL parsing | Claude/Codex reuse parsed tails, parse safe appends incrementally, expose diagnostics, and keep cache memory bounded. |
| 9. Cleanup/deferrals | Diagnostic APIs are documented; confirmed dead exports/procedural helpers are removed. Async Git and lazy asset loading remain explicitly deferred by measurement. |
| 10. Verification | Syntax, 73 unit tests, focused smokes, sprite/world validation, browser lifecycle, UI flows, FPS, API/security, dependency audit, and the final soak pass. |

Release-gate profiling also found a repeated Claude orphan-session scan outside the original finding list. A bounded per-parent child-activity cache now rechecks active child files while avoiding roughly 14,600 cold child-file stats on every broadcast. On the live store, warm Claude collection fell from roughly 95–154 ms to 25–38 ms. `claude-orphan-cache.test.mjs` covers output parity, warm scan bounds, active-child refresh, and cache bounds.

### Finding disposition

| Finding | Disposition |
| --- | --- |
| CV-SEC-001 | Fixed — loopback-only listener and local Host/Origin policy; private APIs and WebSocket reject hostile origins. |
| CV-NET-001 | Fixed — upgrade and frame validation covers method/path/version/key/origin, masking, RSV/fragmentation, control size, and close codes. |
| CV-DATA-001 | Fixed — Activity Panel clears identity-bound content before pending/failure responses. |
| CV-DATA-002 | Fixed — biography push identities/watermark are persisted, idempotent, and bounded. |
| CV-DATA-003 | Fixed — meeting/chat/Git affinity identities persist with category-preserving bounds and shared-event dedupe. |
| CV-DATA-004 | Fixed — Chronicle and SpendLedger writes drain before store closure. |
| CV-DATA-005 | Fixed — mood uses source timestamps, ignores historical events, and bounds remembered identities. |
| CV-DATA-006 | Fixed — Chronicle accepts commit/push only. |
| CV-DATA-007 | Fixed — Dashboard removes obsolete usage footers. |
| CV-RUNTIME-001 | Fixed — failed polling is not treated as an authoritative empty session list. |
| CV-BOOT-001 | Fixed — Sidebar storage access is guarded. |
| CV-LIFE-001 | Fixed — offscreen cue state/listeners are renderer-owned and disposed. |
| CV-LIFE-002 | Fixed — compositor availability subscriptions are removable and avatars release them. |
| CV-WORLD-001 | Fixed — blocked authored visit slots and the harbor entrance/dock grid are corrected. |
| CV-WORLD-002 | Fixed — overflow slots no longer duplicate base capacity. |
| CV-WORLD-003 | Fixed — weighted and unweighted fallbacks cannot succeed beyond one tile. |
| CV-PERF-001 | Fixed — paired rain regressions are 28.6% at 25 agents and 21.4% at 50 agents. |
| CV-PERF-002 | Fixed — parsed-tail reuse and append parsing stop unchanged JSONL reparse churn. |
| CV-PERF-003 | Deferred architecture change — the existing synchronous Git path remains, but active/base cache expiry is unified at 30 seconds and ref probes invalidate real changes. Isolated profiling showed no timeout or sustained stall; the final steady rate was 2.50 commands/second (at the gate) with event-loop p95 at 22.9 ms or below. Reconsider bounded async refresh only if isolated timeouts or user-visible stalls reproduce. |
| CV-PERF-004 | Deferred — cold readiness remains below the 2-second trigger and decoded/canvas caches remain bounded. Reconsider provider/model lazy loading only if that trigger or memory pressure is reproduced. |
| CV-PERF-005 | Fixed — biographies are read on identity/biography events, not generic agent updates. |
| CV-UI-001 | Fixed — Gemini and unknown-model provider fallback is shared across modes. |
| CV-UI-002 | Fixed — Dashboard avatar invalidation includes team and appearance inputs. |
| CV-A11Y-001 | Fixed — Sidebar selection and parent actions use keyboard-operable native controls. |
| CV-A11Y-002 | Fixed — modal focus is trapped, background is inert, and prior focus is restored. |
| CV-A11Y-003 | Fixed — Dashboard selection and sibling actions are no longer nested interactives. |
| CV-A11Y-004 | Fixed — normal toast feedback uses a polite status live region. |
| CV-COPY-001 | Fixed — truncation never exceeds the requested maximum, including limits 0–8. |
| CV-COPY-002 | Fixed — empty-state copy is provider-neutral. |
| CV-DEAD-001 | Resolved — `/api/tasks`, `/api/providers`, and `/api/perf` are retained and documented as loopback diagnostic APIs. |
| CV-DEAD-002 | Fixed — only zero-caller exports and superseded Forge/prop procedural helpers were removed. |

### Verification ledger

- `npm run validate:quick` — passed; 73 unit tests, all syntax/fixture/theme checks, and sprite ID audit.
- `npm run sprites:audit-refresh` — passed; 153 expected assets, zero missing/orphan/invalid entries or warnings.
- World validators and `world-visit-paths.mjs` — passed; 83 unique reachable slots from the gate.
- Adapter, relationship, tail-cache, Claude aggregate, Codex warm-discovery, watcher runtime/topology, scoped invalidation, residency, harbor, usage-history, and World-state checks — passed.
- `server-security.mjs` — passed, including hostile Host/Origin, malformed WebSocket, invalid JSON, and oversized body cases.
- `browser-lifecycle.mjs --count=250` and `ui-remediation.mjs` — passed; listeners, compositor callbacks, avatars, store drains, App reboot/failure, storage, panel races, semantics, and invalidation returned to bounded state.
- Paired FPS benchmark, two repetitions — passed: 25 agents clear/rain `35/25` FPS (`-28.6%`); 50 agents `28/22` FPS (`-21.4%`); zero frame failures.
- Final 180-streak rain capture at 1600×1000 and prior day/night checks showed no console or obvious visual regression.
- Fresh isolated current runtime — `ss` showed `127.0.0.1:44123`; every listed API returned HTTP 200; World/Dashboard, agent select/deselect, building selection, changelog, audio, and keyboard flows passed with zero console errors.
- Final 60-second browser/server soak — passed with stable `59` DOM listeners, `115` event-bus listeners, one canvas, bounded caches/watchers, zero frame failures, server RSS growth of about 20 MiB (under the 64 MiB gate), maximum broadcast time `267 ms`, and event-loop p95 no higher than `22.9 ms`.
- `npm audit --json` — zero vulnerabilities.
- `git diff --check` — passed.

The operator-maintained process still listening on `*:4000` was started before these source changes and was not stopped, per repository safety policy. The current implementation itself was verified on a fresh isolated listener and will bind `127.0.0.1:4000` on the next normal operator restart.
