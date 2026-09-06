# ClaudeVille improvement plan — Opus 5

**Status:** `executed` — this header previously read `proposed — not started`, which was stale. Evidence: this document's own execution record and research verdicts below, `scripts/tests/r1-*`, `r2-*`, `r3-*`, `r4-*`, `w4-*`, `w5-*` (66 test files), and `.github/workflows/ci.yml`. Corrected 2026-08-30.

**Source:** Five parallel research sweeps (visual/rendering, agent model/simulation, sound, features/UX, architecture/engineering health) run 2026-08-25 against the baseline below.

**Baseline:** `main` at `5f6ba42` (`v0.33.3` — *The Returning Tide*)

**Execution model:** Codex background agents (`~/.claude/skills/codex-agents/codex-agent`), fanned out in three rounds of ~20, ~13, and ~4 concurrent agents, partitioned by file ownership.

---

## Goal

Close the gap between what ClaudeVille has already built and what it actually delivers to the operator's eye and ear — then extend that machinery, without adding a build step or restructuring the GPU renderer.

## The organizing thesis

Five independent research sweeps found the same defect wearing five costumes. ClaudeVille repeatedly builds sophisticated machinery and stops one step before it reaches the operator:

| Already built | Never delivered |
| --- | --- |
| Material/emissive/occluder pipeline, atlas tooling, channel validation | 2 of ~20 agent classes use it; 2 of 6 terrain tiles |
| Cross-restart biography: nicknames, milestones, decaying relationships | The villager's face rerolls every session (`Agent.js:94`) |
| `PairAffinity` — decaying warmth, shared-commit history per identity pair | Drives only idle gossip clustering; invisible in the UI |
| `AttentionService` — precise "needs you" detection, badge, `A` hotkey | Notification click calls `window.focus()` and nothing else (`AttentionService.js:180-181`) |
| An audio system whose stated job is to "reach someone who is not looking at it" | Suspends the AudioContext the moment the tab hides |
| 151 passing unit tests + `validate:quick`, ~245ms total | Nothing runs them automatically; there is no CI |

This is not six unrelated bugs. It is one habit, and it is expensive precisely because the underlying work is good.

This also serves the stated north star — *atmosphere is the medium, information is the message*. The last mile is exactly where atmosphere becomes information.

## Guardrails

- **Zero-build is sacred.** No bundler, no transpiler, no runtime dependencies. Plain ES modules; vendor a single-file ESM only if genuinely unavoidable. `devDependencies` for tooling remain acceptable.
- **The GPU renderer is not restructured.** `gpu/GpuWorldRenderer.js`, `gpu/GpuSceneBuilder.js`, and `postfx/` accept *additive* changes only (new data tables, new authored assets). No pipeline redesign, no Canvas/GPU unification. Items requiring it are recorded under "Deferred — constraint-blocked" with trigger conditions.
- Desktop-only, ≥1280px. No media queries, no responsive shrinking.
- Adapters stay read-only against provider session files. ClaudeVille remains loopback-only; no LAN mode, no auth.
- English-only UI copy, docs, and comments.
- Preserve unrelated local modifications. `git status --short` before editing and before committing.
- Re-check every `file:line` anchor in this document before implementing — line numbers move.

---

## Execution model

### Why this is partitioned by territory, not by theme

**Codex agents share one working tree. There is no isolation.** The only real constraint on concurrency is therefore *file collisions* — not dependency order, and not thematic grouping. Once tasks are partitioned by which files they own, most of this plan turns out to be mutually disjoint and can run at once.

The territories:

| # | Territory | Paths |
| --- | --- | --- |
| 1 | Agent model | `src/domain/**`, `src/application/**` |
| 2 | Audio | `src/presentation/shared/audio/**`, `shared/AmbientAudioController.js` |
| 3 | Shared UI | `shared/ActivityPanel.js`, `TopBar.js`, `Sidebar.js`, `Toast.js`, `Modal.js`, `ChroniclePanel.js`, `Formatters.js` — **each file is its own sub-lane** |
| 4 | World renderer | `src/presentation/character-mode/**` — sub-lanes per module |
| 5 | Dashboard | `src/presentation/dashboard-mode/**` |
| 6 | Backend | `claudeville/server.js`, `adapters/**`, `services/**`, `src/infrastructure/**` |
| 7 | Assets | `claudeville/assets/sprites/**` incl. `manifest.yaml`, `scripts/sprites/**` |
| 8 | Tooling & docs | `scripts/tests/**`, `scripts/smoke/**`, `docs/**`, `.github/**`, `package.json`, `agents/**` |
| 9 | **Integration (reserved)** | `src/presentation/App.js`, `claudeville/index.html`, `claudeville/css/**` |

**Territory 9 is never owned by a parallel agent.** It is the boot-wiring hotspot every task would otherwise touch. Agents expose their entry points and stop; a single serialized integration agent wires everything at the end of each round.

### Rules

1. **Disjoint ownership.** Two tasks may run concurrently if and only if no path appears in both *Owns* lists. Everything else in this document follows from that rule.
2. **Contract-first coupling.** Where task A emits an event task B consumes, the payload is specified in this plan *up front*, so both sides build in parallel against the spec instead of serializing. Contracts are listed below.
3. **One commit per task.** Each agent commits only its *Owns* paths. Never stage outside them.
4. **Per-task validation.** Each task carries its own smoke check. The integration agent runs `npm run validate:quick`.
5. **Test files are namespaced by task.** `scripts/tests/**` is owned exclusively by one task per round, but many tasks need to add cases. Resolve this by rule rather than by serializing: any task adding tests creates a **new** file named `<task-id>.<subject>.test.mjs` (e.g. `r1-01.appearance-identity.test.mjs`) and never edits an existing test file. The owning task must not restructure or rename existing test files while a round is in flight.
6. **Escape hatch for forced serialization.** If a same-file dependency is blocking a round, give the task its own worktree instead of waiting:
   ```bash
   git worktree add /tmp/cv-<task-id> -b task/<task-id>
   ~/.claude/skills/codex-agents/codex-agent luna high -C /tmp/cv-<task-id> - <<'PROMPT'
   ...
   PROMPT
   # then merge task/<task-id> and remove the worktree
   ```
   Use sparingly — the merge cost on hotspot files usually exceeds the wait.

### Agent assignment policy

| Pin | Used for |
| --- | --- |
| `sol medium` | Design-bearing and cross-cutting work: API shape, refactor strategy, subsystem changes — anything where the *approach* is the hard part. |
| `sol low` | Smaller changes that still turn on a judgment call (ordering, placement, contract choice). |
| `luna high` | Non-obvious but well-scoped multi-file code changes. |
| `luna medium` | Straightforward, well-specified changes; content production against an existing contract. |
| `luna low` | Purely mechanical: config, boilerplate, docs. |

Escalate a disappointing `luna high` by **resuming that session** at `luna xhigh`, not by re-launching. Never run Sol above `high`.

### Launching a round

Put every task in a round in a **single message** as parallel background Bash calls:

```bash
~/.claude/skills/codex-agents/codex-agent luna high -C /Users/ahirice/Documents/git/claude-ville - <<'PROMPT'
<goal · exact Owns paths · guardrails · acceptance · "your final message is the deliverable; end with a summary of changed files">
PROMPT
```

Codex starts blind — it sees none of this document unless the brief includes it. Every brief must restate the goal, the *Owns* list, the guardrails, and the acceptance criteria. Do not poll running tasks; wait for completion notifications. Read only the final message, never the log.

### Cross-task contracts (specify before Round 1 launches)

- **`attention:raised` enriched payload** — `{ agentId, agent, reason, waitingCount, oldestWaitMs }`. R1-02 emits, R1-03 consumes for urgency scaling. Existing consumers must tolerate added fields.
- **`audio:cue-played` event** — `{ kind, agentId|null, label, at }`. R1-03 emits on every cue that actually sounds; R1-19 consumes it for captions. Both build in parallel against this shape.

---

## Round 1 — 20 concurrent agents

Every task below owns a disjoint path set and can launch simultaneously. This round contains **all of the Last Mile work**, so the plan's core value lands in the first round rather than the last.

| ID | Task | Pin | Owns | Validation |
| --- | --- | --- | --- | --- |
| R1-01 | **Unify identity and appearance.** Seed `Appearance` from `AgentBiography.identityKeyFor(agent)` instead of the session id, so a returning villager keeps its face across restarts; persist generated names against `identityKey` too. **Design call the agent must resolve:** the identity key depends on the assigned name, which `AgentManager` assigns *after* `Agent` construction — decide whether appearance is assigned post-construction in `AgentManager` or the key derivation moves into the domain entity. `AgentBiography` is a domain value-object, so a same-layer import is legal; never import `application/` into `domain/`. | `sol low` | `src/domain/entities/Agent.js`, `src/domain/value-objects/Appearance.js`, `src/application/AgentManager.js` | `npm run test:unit` |
| R1-02 | **Close the "Needs You" loop.** Notification click must select the waiting agent and open its panel, not merely `window.focus()` (`AttentionService.js:180-181`). Emit the enriched `attention:raised` payload per contract. | `luna high` | `src/application/AttentionService.js`, `src/application/NotificationService.js` | Browser: force a waiting agent, click notification, confirm selection |
| R1-03 | **Make audio do its one job.** (a) Exempt `summons` from the tab-hidden AudioContext suspend — the one cue explicitly meant to reach someone not looking. (b) Deduplicate `distress:watchtower` and `attention:raised`→`summons` for the same agent on `ERRORED`/`RATE_LIMITED`; one event must not spend two cues from the same rate budget. (c) Scale summons urgency with `waitingCount`/`oldestWaitMs`. (d) Emit `audio:cue-played` per contract. | `luna high` | `shared/AmbientAudioController.js`, `shared/audio/AudioDirector.js`, `shared/audio/cues/CueKit.js`, `shared/audio/CueGovernor.js` | Browser: sound on, hide tab, force waiting agent, confirm exactly one cue |
| R1-04 | **Deepen mood with signals already collected.** Add `contextRatio` (already computed at `VisitIntentManager.js:66`) as an "anxious near context limit" input, and a long-wait signal from `awaitingSince` age — a session stuck on `WAITING_ON_USER` for 20 minutes currently shows no mood signal at all. Keep the state count small and legible. | `luna high` | `src/domain/value-objects/AgentMood.js`, `src/application/MoodService.js` | `npm run test:unit` |
| R1-05 | **Make the existing tests gate.** Add `.github/workflows/ci.yml` running `npm run validate:quick` on push and PR (Node 18+, no build step). Silence the `MODULE_TYPELESS_PACKAGE_JSON` warning from `test:unit`. | `luna low` | `.github/workflows/ci.yml`, `package.json` | `npm run validate:quick`; workflow parses |
| R1-06 | **Record the undocumented exceptions.** Add a `design-decisions.md` entry for the outbound `api.anthropic.com/api/oauth/usage` call at `services/usageQuota.js:304` — the only non-local network call in a system documented as local-only — covering TTL, 30-minute stale tolerance, 256KB cap, offline failure mode. Add a second entry documenting that BGM mode intentionally keeps event cues while dropping reactive weather/wildlife layers, so it is not "fixed" later. | `luna low` | `docs/design-decisions.md` | Diff review |
| R1-07 | **Give the operator something to act on.** Add a copy action in the Activity Panel exposing the working directory and a ready-to-paste `cd <path>`, modelled on the Dashboard copy-ID pattern (`DashboardRenderer.js:1028`) with its toast. Read-only; no new server endpoint, no OS handoff. | `luna high` | `shared/ActivityPanel.js`, `shared/Formatters.js` | Browser: select agent, copy, confirm toast and clipboard |
| R1-08 | **Extend material coverage to the full roster.** Author albedo/material/emissive/occluder companions for the ~18 agent classes and 4 land terrain tiles (grass-cobble, grass-dirt, grass-shore, cobble-square) now falling back to heuristic defaults. Roughly 90% of on-screen characters render with a two-bucket guess instead of the authored response v0.33.0 was built to deliver. Content production against an existing validated contract; **no renderer code changes**. | `luna medium` | `assets/sprites/characters/**`, `assets/sprites/terrain/**`, `assets/sprites/manifest.yaml`, `scripts/sprites/**` | `npm run sprites:audit-refresh`; channel validation; contact sheets |
| R1-09 | **Share cache-token normalization across 7 adapters.** Cache-token handling is reimplemented per provider (`claude.js:253-254`, `codex.js:317-349`, +5), so a fix in one is easy to miss in six. Extract `normalizeCacheTokens(usage, providerFieldMap)` into `adapters/shared.js` and migrate all seven. **Preserve per-adapter failure isolation** — a deliberate choice in `adapters/README.md`. Do not merge provider-specific parsing. | `sol medium` | `claudeville/adapters/**` | `xargs -0 -n1 node --check` over adapters; `node scripts/smoke/adapters.mjs` |
| R1-10 | **Summarize instead of dropping.** `VillageDirector` caps concurrent scenes at 8 with hard drop-and-count, so a busy session silently discards older incidents — "what happened while I wasn't looking" is lossy by design. Replace with summarized overflow ("+3 more incidents"). | `luna high` | `character-mode/VillageDirector.js`, `character-mode/VillageDirectorOverlay.js` | Browser: force >8 concurrent scenes |
| R1-11 | **Keyboard parity for Dashboard mode.** World has a full keyboard grammar; Dashboard is mouse-only. Add card traversal and a "next needing attention" shortcut consistent with World's `A`/`Tab`. | `luna high` | `dashboard-mode/**` | Browser: keyboard-only Dashboard navigation |
| R1-12 | **Unhandled-rejection telemetry.** `server.js:2335` logs and continues — right for a long-running local dashboard, but a persistently stuck promise degrades a subsystem silently forever. Surface a counter at `/api/perf`. | `luna medium` | `claudeville/server.js` | `node --check`; `curl localhost:4000/api/perf` |
| R1-13 | **Surface deferred follow-ups as tracked work.** Trigger conditions for still-open items sit buried in prose inside two plans marked "implemented", so a future agent scanning for open work must re-parse both. Extract into a live checklist. | `luna low` | `agents/plans/**` (excluding this file), `agents/README.md` | Diff review |
| R1-14 | **Replace the material heuristic with a profile table.** `GpuSceneBuilder.js:272` hardcodes `provider === 'codex' ? 'metal' : 'fabric'` — an undocumented visual rule baked into scene-building code. Replace with a per-provider profile table per `docs/visual-experience-crafting.md` §5. **Additive only — add a lookup and read from it; do not restructure the GPU pipeline.** | `luna medium` | `character-mode/gpu/GpuSceneBuilder.js` | Browser: World mode, no per-provider visual regression |
| R1-15 | **Break cost down by project.** The topbar shows one aggregate. With several CLIs running in parallel — the core use case — the operator cannot tell which project is burning budget. Add per-project and per-provider rollups. | `luna high` | `src/application/SpendLedger.js`, `shared/TopBar.js` | `npm run test:unit`; browser: multi-project |
| R1-16 | **Search across everything, not just names.** The only filter is a substring match on name/model/status over resident agents. Extend to tool names, file paths touched, and commit messages. | `sol medium` | `shared/Sidebar.js`, new `shared/SearchIndex.js` | `npm run test:unit`; browser |
| R1-17 | **Remember more than today.** The Chronicle is a same-day book with periodic pruning. Add multi-day retention and a date-picker view. | `sol medium` | `src/application/ChronicleLog.js`, `src/infrastructure/ChronicleStore.js`, `shared/ChroniclePanel.js` | `npm run test:unit`; browser: cross-day |
| R1-18 | **End-to-end replay harness.** 151 unit tests cover pure logic; the adapter → server → WebSocket pipeline and the 55k-line `character-mode/` tree have no automated coverage at all. Build a harness feeding synthetic multi-provider session fixtures through the real pipeline. The single biggest coverage gap relative to 89k LOC. | `sol medium` | `scripts/smoke/**`, `scripts/tests/**` | Harness runs green against fixtures |
| R1-19 | **Caption every cue.** Sound is off by default, so the informational channel reaches almost nobody. Consume `audio:cue-played` per contract and surface a caption independent of whether audio is enabled — the accessibility analog to `prefers-reduced-motion`, which visuals have and audio does not. | `luna medium` | `shared/Toast.js` | Browser: sound off, confirm captions |
| R1-20 | **Decompose `IsometricRenderer.js` (11,214 lines).** Extract wildlife and foliage — gull flight AI, fish schools, waterfowl, tree silhouette tracing — into `WildlifeRenderer.js` / `FoliageRenderer.js` siblings alongside the existing `SkyRenderer`/`WeatherRenderer`. Pure extraction along existing seams: no behaviour change, no bundler, no new network round-trips beyond the two modules. The largest single maintainability risk in the visual layer. | `sol medium` | `character-mode/IsometricRenderer.js` + new sibling modules | Browser: World mode parity; `npm run validate:quick` |

**Round 1 integration (serialized, after all 20 report):**

| ID | Task | Pin | Owns |
| --- | --- | --- | --- |
| R1-INT | Wire everything from Round 1. Add the **World-mode empty state** mirroring the Dashboard's copy (`index.html:157-158`) — today World mode shows an unexplained empty diorama on first run — plus a one-time dismissible first-run hint pointing at the World-controls popover and the `A` hotkey, `localStorage`-gated. Then `npm run validate:quick` and a full browser pass. | `sol low` | `src/presentation/App.js`, `claudeville/index.html`, `claudeville/css/**` |

---

## Round 2 — 13 concurrent agents

Each task here was blocked in Round 1 only by same-file contention. All are disjoint from each other.

| ID | Task | Pin | Owns | Unblocked by |
| --- | --- | --- | --- | --- |
| R2-01 | **Retire the legacy building art.** Archive, Task Board, Forge, Mine, and Observatory still ship pre-contract art patched at load time by five hand-drawn `structureMask` polygon cutouts erasing baked ground slabs. Regenerate in the native structure-only style used by Command, Harbor, and Portal; delete the masks. A currently-visible inconsistency that `docs/building-style-contract.md` already names as the priority. | `luna medium` | `assets/sprites/buildings/**`, `assets/sprites/manifest.yaml`, `docs/building-style-contract.md` | R1-08 |
| R2-02 | **Make silent pricing and parity failures loud.** Assert every model in adapter fixtures resolves a non-`default` pricing rate, so a new model falling back to generic rates fails instead of quietly producing wrong costs. Add fixture-driven adapter parity assertions for shared optional fields. | `luna medium` | `scripts/tests/**`, `src/config/model-pricing.json` | R1-09, R1-18 |
| R2-03 | **Give sound a sense of place and identity.** Pan arrival/departure/distress cues by the agent's normalized screen X (World mode; centre in Dashboard) — `StereoPanner` is already used throughout but its pan values are *random*, tied to nothing. Give each provider a distinct bell voicing so identity becomes learnable by ear. Scale the council-gather cue's bell count to team size. All synthesis; ship no audio files. | `luna high` | `shared/audio/cues/**`, `shared/audio/AudioDirector.js`, `shared/audio/MusicalScale.js` | R1-03 |
| R2-04 | **Say why, not what.** Bubble text is mostly a tool-name echo ("Editing forge.js"); flavour lore fires only 25% of the time. Source it from the active `VisitIntentManager` intent's `reason`/`phase` so it reads as intent ("Validating after edit"). Also audit whether `goal`/`itinerary` in `VisitIntentSemantics.js` are consumed downstream or are unused scaffolding, and report the finding. | `sol medium` | `character-mode/VisitIntentManager.js`, `character-mode/VisitIntentSemantics.js`, `src/domain/entities/Agent.js` | R1-01 |
| R2-05 | **Show the relationships already being computed.** `PairAffinity` accumulates meetings, chats, and shared commits per identity pair with a 48h decay half-life, and the operator sees none of it. Surface tiers and shared-commit counts in the Activity Panel. | `luna high` | `shared/ActivityPanel.js`, `src/application/RelationshipAffinityService.js` | R1-07 |
| R2-06 | **Make model choice legible as behaviour.** An Opus session and a Haiku session are behaviourally identical villagers; model and effort feed only sprite tint and cost math. Add a behaviour tier — walk pace, idle-fidget frequency, think-animation duration. Respect `docs/motion-budget.md` and `PulsePolicy.js`; every cue needs a reduced-motion static fallback. | `sol medium` | `character-mode/AgentSprite.js`, `src/domain/value-objects/AgentMood.js` | R1-04 |
| R2-07 | **Weather per district, not per village.** Mood aggregates village-wide, so one failing repo among five healthy ones fogs the entire sky. Scope weather influence per project/district. | `sol medium` | `src/application/MoodService.js`, `character-mode/AtmosphereState.js` | R1-04 |
| R2-08 | **Per-layer audio mixer.** Expose wind/rain/wildlife/hum/music sliders — the plumbing already exists via `AudioDirector.forceLayer`/`layer.setLevel`; only a master volume is surfaced. | `luna high` | `shared/AmbientAudioController.js`, `shared/TopBar.js` | R1-03, R1-15 |
| R2-09 | **Milestone banner moments.** Biography nicknames and milestones are earned silently. Give the first earning a one-time in-world moment, mirroring the existing release-parade pattern. | `luna high` | `src/domain/value-objects/AgentBiography.js`, `character-mode/VillageDirector.js` | R1-01, R1-10 |
| R2-10 | **Unattended digest.** On regaining focus after the tab was hidden, summarize what happened while away, reusing Chronicle data. | `luna high` | `src/application/AttentionService.js`, `src/application/ChronicleLog.js` | R1-02, R1-17 |
| R2-11 | **Chronicle export.** Markdown/CSV export for standups. | `luna medium` | `shared/ChroniclePanel.js` | R1-17 |
| R2-12 | **Async stale-while-revalidate git worker.** Pre-build the bounded `execFile` queue flagged as a deferred follow-up in the OOM plan, while the pressure is still well understood. | `sol medium` | `adapters/gitEvents.js`, `claudeville/server.js` | R1-09, R1-12 |
| R2-13 | **Decompose `AgentSprite.js` (6,354 lines).** Split GPU-overlay annotation drawing from Canvas identity/animation logic. | `sol medium` | `character-mode/AgentSprite.js` companion module | **Serialize after R2-06** — same file. Run in a worktree if you want it concurrent. |

**Round 2 integration:** same reserved territory, `sol low`, `npm run validate:quick` + full browser pass.

---

## Round 3 — 4 concurrent agents

| ID | Task | Pin | Owns |
| --- | --- | --- | --- |
| R3-01 | **Settings consolidation.** Toggles are scattered across the topbar with no single place to review or reset them. | `luna medium` | `shared/TopBar.js`, `shared/Modal.js` |
| R3-02 | **`PulsePolicy` adoption audit.** Confirm no feature still runs local sine math outside `pulseValue()`/`pulseAlpha()`; the doc admits migration was gradual, so stragglers likely remain. | `luna medium` | `character-mode/PulsePolicy.js` + reported call sites |
| R3-03 | **Release preparation.** `CHANGELOG.md` entry, version bump in `claudeville/index.html` and `package.json`, tag, GitHub release. | `luna low` | `CHANGELOG.md`, `claudeville/index.html`, `package.json` |
| R3-04 | **Escalations and review follow-ups** from Rounds 1–2. | varies | varies |

---

## Deferred — constraint-blocked

Recorded rather than dropped. Both are the *correct* fix for a real recurring cost, and both collide with the "GPU renderer is not restructured" guardrail.

| Item | Why it matters | Trigger to revisit |
| --- | --- | --- |
| **Harbor traffic gets a GPU scene-builder path.** Ships are Canvas-only, replayed as a bespoke overlay on top of the opaque GPU frame, so they miss the bloom, reflection, and atmosphere grading the rest of the village receives. | v0.33.3 exists *specifically* because GPU adoption dropped the fleet. The overlay is a patch, not a pipeline. | The next time a Canvas-only visual category needs GPU compositing — the second instance of the same tax, and the point where the general fix becomes cheaper than another patch. |
| **`GpuSceneCategory` registration contract.** Any new Canvas-only feature requires a hand-threaded overlay-replay path through `WorldFrameRenderer.js` rather than being picked up by both renderers automatically. | Recurring integration tax, already paid once. | Same trigger. Do it together with the item above; separately neither is worth the risk. |

Smaller deferrals: an in-app `legacyArt` debug flag (obsolete once R2-01 lands); ESLint as a dev-only `validate:quick` step (worth it only if the CI from R1-05 proves insufficient).

---

## Recommended stopping points

- **After Round 1** — the plan's core thesis is realized and the bulk of the value has landed. Six built-but-undelivered systems now reach the operator, plus search, cost attribution, history, keyboard parity, and CI. If only one round ships, ship this one.
- **After Round 2** — the village looks finished (no placeholder materials, no legacy building art) and reads as a daily driver.
- **Round 3** is polish and release mechanics.

## Release framing

Round 1 is a named minor release, and the theme writes itself: work that was already done, finally arriving. Round 2 is a second named release once the visual gate passes. Per `CLAUDE.md`, prepend a `CHANGELOG.md` entry and update the version in `claudeville/index.html` and `package.json` before pushing; every pushed version gets a matching tag and GitHub release.

---

## Execution record — 2026-08-25

**Status:** Rounds 1–3 complete and committed. Wave 4 (frontier research + defect remediation) complete. Wave 5 (review remediation) in progress.

**Baseline → outcome:** `5f6ba42` (v0.33.3) → 17+ commits, ~215 files, +14.5k/−2.2k. Unit suite 151 → 283+, plus a new end-to-end replay harness covering the adapter → server → WebSocket path that previously had zero automated coverage.

### What the thesis predicted, and what it found

The plan's organizing claim was that ClaudeVille repeatedly builds machinery and stops one step before delivering it. That held, and kept holding — including inside this plan's own execution:

- Appearance rerolled every session despite a full cross-restart biography system. Fixed (R1-01).
- The notification click stopped at `window.focus()`. Fixed (R1-02).
- Audio suspended the one cue meant to reach an absent operator. Fixed (R1-03).
- `PairAffinity` computed relationships nothing displayed. Fixed (R2-05).
- 151 tests with no CI to run them. Fixed (R1-05).
- **Recurred during execution:** intent bubbles, district atmosphere, and the unattended digest were each built with nothing rendering them (fixed by R2-WIRE and integration).
- **Recurred again, found only by review:** the per-provider material table and 84 authored companion PNGs never reached agent shading, because the GPU overlay kept its own `codex ? metal : fabric` conditional and atlas packing discarded agent material/emissive sources (W5-C).

### Method notes worth keeping

- **Partition by file ownership, not by theme.** Most of the plan turned out mutually disjoint; Round 1 ran 20 agents concurrently in one shared tree with zero collisions.
- **Reserve the integration surface.** `App.js`, `index.html`, `css/**` were never owned by a parallel agent. A serialized integration pass caught a real defect (duplicate Toast subscriptions) that no individual agent could see.
- **Contract-first coupling works.** `audio:cue-played` was built by two agents that never saw each other's code and the seam fit. But contracts need a *renderer* named up front — three were built with no consumer.
- **Strict ownership manufactures last-mile gaps.** The cost of preventing collisions is that agents stop at their boundary and report rather than wire. Budget an explicit wiring pass per round.
- **Review is not optional.** Independent `sol high` review found 20 confirmed defects across three domains after every agent reported success and the suite was green — including two HIGH-severity issues introduced by this plan's own work (git cache eviction disabled; departed agents never expiring).

### Research verdicts (Wave 4)

Four frontier proposals were researched; three were rejected or deferred on evidence:

| Proposal | Verdict |
| --- | --- |
| HDR / Display-P3 emissive | Viable, larger than assumed. `drawingBufferColorSpace` (not a `getContext` option); P3 is wide-gamut, not HDR; needs `RGBA16F` via draft `drawingBufferStorage`. Unblocked now that authored emissive RGB survives packing. |
| Normal + height channels | **Do not add a height channel** — `occluder` already carries height in R and strength in G; a packing bug destroyed it (fixed, W4-F). Normals only as an indexed 8–12 orientation map quantized into existing bands. |
| Radiance cascades 2D GI | Feasible in WebGL2 fragment passes; ~4–6 engineer-weeks. **Gated on an art decision, not engineering:** quantizing to the palette turns smooth penumbrae into discrete contours. If the appeal is the smooth look, it is contract-incompatible and should be killed. |
| WebGPU renderer | **Not justified.** No measured WebGL2 blocker (12.6 ms rAF p95, 100% FULL, 58.8 MB of a 64 MiB gate). Attachment/buffer budgets are diagnostic only, never degradation triggers. Do the scene-category contract first — done (W4-C). |
| OffscreenCanvas / worker | **Not justified, and unmeasurable.** No client-side instrumentation existed. Built the measurement instead (W4-B); the one credible mechanism it identified was then fixed directly (W4-E). |
