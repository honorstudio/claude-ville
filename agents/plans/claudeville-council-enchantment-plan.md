# ClaudeVille enchantment plan — the Council of Six

**Status:** `shipped as v0.36.0`

**Baseline:** `main` at `v0.35.0.1` (*The Whetstone* + js-yaml hotfix), clean tree at plan time.

**Method:** Six Opus council members with disjoint territories and deliberately opposed temperaments ran an independent, read-only research round against current source, then a second cross-examination round in which each read all five rival proposals and cast a whole-village ballot of 15. 48 proposals were reduced to 15 by ranked tally plus explicit merges and kills. Round-1 proposals and round-2 debates are transient scratch artifacts (`/tmp/cv-council/*.md`); everything load-bearing is restated here.

| Member | Territory | Temperament |
| --- | --- | --- |
| Aurelia | light, colour, materials, weather, composition | art director; contemptuous of "add a glow" |
| Bram | frame budget, GPU health, memory, smoothness | engine engineer; measures before believing |
| Nocturne | ambience, generative music, cues, mixing, silence | sound designer; treats silence as an instrument |
| Vera | legibility, attention truth, keyboard, honesty | information designer; kills beauty that carries no signal |
| Isolde | identity, memory, chronicle, behaviour truth | narrative designer; hates manufactured emotion |
| Halvard | boot, failure honesty, provider health, release quality | head of craft; professionalism is the first 90 seconds |

---

## The organizing finding

The previous plan (`claudeville-opus5-improvement-plan.md`, whose header still wrongly reads `proposed — not started`) diagnosed a habit: ClaudeVille builds sophisticated machinery and stops one step before the operator. That plan then *executed* and largely closed those gaps — 66 test files, CI at `.github/workflows/ci.yml`, persistent appearance, wired notifications, relationship panel, per-provider agent materials.

The council found a different defect, and all six territories found the same one independently:

> **The village is beautiful and instrumented, but it does not yet share one truth about its own state.**

Six surfaces answer "what is happening?" with six different vocabularies, and several of them are provably wrong:

| Surface | What it says | Verified |
| --- | --- | --- |
| Boot shell | `LIVE`, hardcoded, before any server result | `claudeville/index.html:28` |
| `World.getStats()` | counts `errored` but excludes it from `attention` | `claudeville/src/domain/entities/World.js:63-83` |
| `StatusResolver` | errored **does** need a person | `claudeville/src/domain/services/StatusResolver.js:108-115` |
| Dashboard health strip | counts `rate_limited` and `waiting_on_user` as **errors** | `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:398-406` |
| World Canvas at `zoom < 1` | draws only the waiting beacon; error and quota marks are skipped | `claudeville/src/presentation/character-mode/AgentSprite.js:2376-2388` |
| Provider registry | unavailable and failing adapters are silently skipped | `claudeville/adapters/index.js:239-266, 399-418` |

Two further findings are about *earned* versus *performed* life:

- Idle proximity is rendered as conversation. `_rebuildGossipClusters()` forms a "gossip knot" from nothing but `IDLE` status and a 30 px radius around a scenic point — no message, no affinity record, no event — and the sprite then sets `chatting = true` and reuses the speech-bubble effect (`claudeville/src/presentation/character-mode/RelationshipState.js:206-242`; `AgentSprite.js:2153-2186`). The project's dialogue contract deliberately invents **zero** words (`claudeville/src/config/dialogue.js`, `claudeville/adapters/dialogue.js:1-19`); the presentation layer reintroduced invented *social meaning* through a bubble-shaped effect.
- Every `COMPLETED` agent raises its arms (`ActionVocabulary.js:3-12`, verified), including the ten-minute departed projection that `AgentManager` documents as a *presence* lifecycle rather than an execution result (`claudeville/src/application/AgentManager.js:259-282`).

And one is about physics: the village's motion is refresh-rate dependent. Camera follow uses a fixed per-frame coefficient (`Camera.js:513-514`, verified), the water clock advances by a constant `0.03` per update while `_loop` already computes a clamped `dt` (`IsometricRenderer.js:85-89, 3489-3507`), and idle stride pauses are counted in update calls (`AgentSprite.js:1904-1922`). The same village runs at a different speed on a 120 Hz display than on a 60 Hz one.

Meanwhile the sun already has a continuous trajectory (`AtmosphereState.js:796-809`) that is thrown away: the physical shadow direction collapses to three constants — `-0.68` at dawn, `0.72` at dusk, `0.28` otherwise (`AtmosphereState.js:1007`, verified).

**Thesis of this plan:** establish one shared truth, one shared clock, and one shared measurement; then spend the resulting headroom on light, material, memory, and sound that carry that truth. In that order. Every ballot but none reversed this ordering — the three unanimous first items are state truth, the clock, and the attention ledger.

---

## Guardrails

- **Zero build is sacred.** No bundler, transpiler, framework, or runtime dependency. Plain ES modules. `devDependencies` for scripts only.
- **The WebGL2 renderer is not restructured.** `character-mode/gpu/**` and `postfx/**` take *additive* changes only: new data tables, new uniforms, new authored assets, new records. No WebGPU, no OffscreenCanvas worker, no Canvas/GPU unification. All three were rejected on evidence by the prior plan and no reopen trigger is met (`agents/plans/open-followups.md:73-83`).
- **No browser or component test runner enters CI.** `AGENTS.md` is explicit that none exists; the council's release-gate item is therefore restricted to isolated Node child-server and replay smokes. **Browser verification remains manual** against `http://localhost:4000` and the visual QA checklist.
- Desktop-only, ≥1280 px. No media queries.
- Adapters remain read-only against provider session files. Loopback-only server; no auth, no LAN.
- English-only UI copy, docs, comments. No emoji.
- Motion policy holds: reduced motion allocates **no** continuous animation, and no repeating motion may exist without a named signal band (`docs/motion-budget.md`).
- No raw model text, prompt content, or transcript prose is ever persisted by ClaudeVille.
- `git status --short` before editing and before committing; preserve unrelated local modifications.
- **Every `file:line` anchor in this document must be re-checked before implementing.** Line numbers move.

### Bram's frame budget — binding on every item

A proposed p95 allocation for a 60 Hz frame with 20 villagers. It is a *contract*, not a measurement of today.

| Bucket | p95 (ms) | Rule |
| --- | ---: | --- |
| Input, camera, simulation update | 1.25 | time-based only |
| Scene collect, sort, cull, GPU records | 1.50 | no per-frame derived art |
| Canvas semantic overlays, labels | 3.00 | primary marks are never sacrificed |
| GPU submission and uploads (CPU lane) | 0.85 | uploads are event-driven |
| GPU shader / post-effect execution | 4.00 | existing ladder ceiling |
| Browser composite, layout, input | 1.50 | measured separately from app code |
| Unattributed GC / driver jitter | 0.50 | must be visible in the capture |
| **Reserve for one new council effect** | **1.00** | spend only with before/after evidence |
| Safety margin | 3.07 | never pre-spent on decoration |
| **Frame wall** | **16.67** | |

Council ruling: **items 11–13 draw on the single 1.00 ms reserve and may not all be enabled at full strength simultaneously.** Item 7 (Pressure) is what makes that survivable, which is why it precedes them.

---

## Cross-item contracts — specify before any work starts

The prior plan's own retrospective recorded that three subsystems were built with nothing rendering them. Each contract below therefore names **both** the producer and the consumer, and no producer is considered done without its consumer.

**C1 — `village:state`** (producer: item 1; consumers: item 1's own surfaces — `TopBar`, `#worldEmpty`, `#dashboardEmpty` — plus item 10 audio lifecycle and item 15 boot-contract smoke)
```
{ phase: 'starting'|'syncing'|'ready-live'|'ready-empty'|'ready-no-providers'|'degraded'|'failed',
  link:  { state: 'syncing'|'live'|'polling'|'reconnecting'|'stale', attempts, nextRetryAt,
           lastSnapshotAt, lastErrorCode },          // normalized codes only; never paths or stacks
  providers: [ { id, name, health: 'unavailable'|'empty'|'healthy'|'degraded',
                 sessions, lastSuccessAt, skippedLines } ] }
```

**C2 — `SignalLedger.buckets(world)`** (producer: item 3; consumers: items 9, 10, 14, plus `TopBar`, `DashboardRenderer`, World summary)
```
{ needsYou[], errors[], quota[], watchlist[], working[], quiet[] }   // ordered, stable, agent refs
```
`needsYou` = `waiting_on_user`. `errors` = `errored`. `quota` = `rate_limited`. `watchlist` = generic `waiting`. `working` = `working`. `quiet` = everything else, including `idle` and `completed`.

**Ordering — corrected against shipped code.** Display and traversal order is `needsYou → errors → quota → watchlist`, which is exactly the precedence already shipped in `SemanticTriage.attentionRank()` (`waiting_on_user: 0, errored: 1, rate_limited: 2, waiting: 3`). An earlier draft of this plan said `errors → quota → needsYou`; that contradicted shipped behaviour and existing tests, and is withdrawn. `AttentionService.focusNext()` keeps its round-robin cursor over `list()` — the actionable population it cycles is unchanged in *membership* by this contract, only made consistent across surfaces. `watchlist` is never an emergency and never enters `A` traversal. This single helper replaces the five disagreeing implementations named in the finding table.

**C3 — `motionTimeMs`** (producer: item 2; consumers: every animated subsystem)
One elapsed millisecond clock exposed at the renderer seam. A virtual 60 Hz frame counter may be *derived* from it for compatibility, but no subsystem may keep a private frame counter or a second `waterFrame`. Reduced motion freezes the derived value; it does not create a second clock.

**C4 — `FramePressureSnapshot`** (producer: items 4+7; consumers: WeatherRenderer, ParticleSystem, MarkGovernor, PostFx policy, AudioDirector)
```
{ appUpdateP95, appRenderP95, uploadP95, gpuMs|null, hostGapP95, level: 0..3, dwellMs }
```
Degradation order is fixed and testable: ambient weather embellishment and fauna cadence → ambient particles → secondary glyphs and glows → postfx ladder. **Primary marks, selected state, and the Canvas fallback never degrade.** Frame gap alone may not trigger degradation when app-owned attribution is available.

**C5 — `resolveMaterialChannels(id, frameKey)`** (producer: item 8; consumers: `GpuSceneBuilder`, `AgentGpuOverlayRenderer`)
Sidecar first, atlas second, deterministic fallback third. Keyed by asset version + atlas key + frame key. Never called from a draw path. Never infers emission from albedo luminance.

**C6 — durable identity** (producer: item 6; consumers: item 6's panel, and the deferred patina/home-port work)
Chronicle event records gain the biography `identityKey`. Bounded `lifeEpisodes` ring (≤32 per identity) under `AgentBiography.extensions`, typed fields only, no prose. **An uncertain or anonymous key must refuse to join histories.**

**C7 — `outcome:verified`** (producer: item 13; consumers: `ActionVocabulary`, monuments, audio cadence)
`{ kind: 'commit'|'push'|'release'|'milestone', project, agentId|null, at }`. Only this event may produce a celebration, visually or sonically.

---

## Ballot tally

Borda score over six whole-village ballots (15 points for a first place). Merged names are the council's, not the chair's.

| Rank | Item | Score | Merged from |
| ---: | --- | ---: | --- |
| 1 | Truthful boot, connection and provider health | 90 | Halvard 1+2+3 |
| 2 | One Clock for the Village | 81 | Bram 1 |
| 3 | Canonical attention and status ledger | 78 | Vera 1+3 |
| 4 | Flight recorder that tells the truth | 57 | Bram 2 |
| 5 | No more false gossip | 56 | Isolde 3 |
| 6 | Book of Lives with a retention charter | 55 | Isolde 1 + Halvard 5 |
| 7 | Semantic pressure and silence budget | 48 | Bram 4 + Nocturne 2 + Aurelia 8 |
| 8 | Resident authored material packet | 64 | Aurelia 2 + Bram 3+5+6+7 |
| 9 | World incident marks at overview LOD | 31 | Vera 2 |
| 10 | Semantic audio conductor, staged | 34 | Nocturne 1+3+4 |
| 11 | The sun must cast a moving shadow | 26 | Aurelia 1 |
| 12 | Ground and surface weather truth | 28 | Aurelia 3+4+5 |
| 13 | Verified outcomes and the Chronicler's errand | 28 | Isolde 8+6 + Nocturne 6 |
| 14 | Selection, focus and deselect as one lifecycle | 13 | Vera 7+6 |
| 15 | Release charter, local gate | 13 | Halvard 6 (browser runner and CI changes removed) |

Item order below is *execution* order, which follows the council's sequencing ruling rather than raw score: 8 outranks 7 on points but depends on 4 and 6 for its budget evidence.

---

## Package 1 — The truth contracts (must land first)

### 1. Truthful boot, connection, and provider health
**Owner:** Halvard territory · **Size:** M · **Consensus rank 1, unanimous**

**What the operator sees.** The first frame no longer claims `LIVE`. A warm status line moves through `OPENING THE VILLAGE` → `LISTENING FOR LOCAL SESSIONS` → one of three honest endings: `WATCHING 3 AGENTS`, `PROVIDERS FOUND · NOTHING ACTIVE`, `NO PROVIDERS FOUND`. The connection chip becomes an instrument: `SYNCING`, `LIVE`, `POLLING`, `RECONNECTING 2`, `STALE · last seen 18s ago`, with a lazy popover naming the last good snapshot and the plain reason. A Settings/Health roster shows each provider watchtower as `not installed`, `ready · 4 sessions`, `empty`, `watch degraded`, or `partial transcript`. A boot failure keeps the branded shell and offers `TRY AGAIN`, not a `BOOT FAILED` tombstone over `document.body`.

**Why it carries signal.** "Nothing is happening" and "I cannot read the source" are opposite operational facts that the app currently renders identically. A stale picture that still looks live is the one failure mode that poisons every other item in this plan: beauty reacting to a lie is worse than no beauty.

**Evidence.** Hardcoded `LIVE` chip (`claudeville/index.html:28`, verified) and zero-valued counts before any result (`index.html:51-67, 114-124`). Boot marks readiness only after the entire asynchronous chain (`src/presentation/App.js:205-257, 264-270`), while a failed session read is caught and logged with no visible distinction (`src/application/AgentManager.js:223-241`). Boot failure replaces `document.body` (`App.js:271-281, 704-730`). `TopBar` accepts only boolean `ws:connected`/`ws:disconnected` (`shared/TopBar.js:113-127, 862-868`); `WebSocketClient` keeps attempts and backoff private (`infrastructure/WebSocketClient.js:69-85, 282-305`). The registry silently skips unavailable adapters and swallows watch-path failures (`adapters/index.js:239-266, 399-418`); JSONL `parsedLines`/`skippedLines`/`trailingPartials` diagnostics exist but only behind `/api/perf` (`server.js:380-413`).

**Work.** A readiness reducer owned by `App.js` (no new store, no framework) emitting **C1**. `getProviders()` on `ClaudeDataSource`; bounded per-adapter health records recorded at the existing aggregation/watch seams — no extra scan. `/api/providers` returns names, count and safe health summaries; absolute paths and parser snippets stay in `/api/perf`. `WebSocketClient` gains a bounded state record and `ws:state`; `SessionWatcher` publishes `polling`/`poll-succeeded`/`poll-failed`. `#bootStatus` live region plus `#bootAction`; `#worldEmpty` and `#dashboardEmpty` consume C1 instead of guessing from `world.agents.size`. `chronicle:status` is wired from the `ChronicleStore` callback that already exists but is never passed (`infrastructure/ChronicleStore.js:65-81, 231-250`; constructed without it at `App.js:136-151`), plus a static "what survives a reload?" retention ledger in Settings.

**Acceptance.** `LIVE` is unreachable before a successful `init` or fulfilled poll. Five terminal boot states are individually reachable and accessible. One failing adapter never erases the others. A failed poll never publishes an authoritative empty roster. Stale threshold exceeds one poll interval. No home-directory paths in operator-facing copy.

**Verification.** Pure reducer tests for all state boundaries; fake-socket tests for open-without-init, close/retry, delta mismatch/resync, recovery; `SessionWatcher` failure→success without roster loss; temporary HOME fixtures for no-directory, empty-directory, valid transcript, malformed middle line, trailing partial, watch error. Manual browser pass over the five states, plus taking the WebSocket down while the page stays up.

**Risk.** Declaring `ready` early and hiding a later renderer failure; treating an empty provider store as an error; red chrome noise on every retry. Mitigate with an explicit transition table, `degraded` only after a *failed read*, and one-shot recovery styling.

### 2. One Clock for the Village
**Owner:** Bram territory · **Size:** M · **Consensus rank 2, on every ballot in the top three**

**What the operator sees.** Following a villager is one continuous glide at 30, 60, or 120 Hz instead of a different spring per monitor. Tide, shimmer, idle footfalls, and pulses keep the same real-world tempo when the laptop is busy; a dropped frame becomes a larger step, never a slower village.

**Why it carries signal.** A waiting beacon must stay an intentional beacon while the camera tracks it. Cadence is the substrate every later item borrows — sun position, wetness release, cue cooldowns, silence windows, quiet hysteresis all become frame-rate-dependent lies without it.

**Evidence (verified).** `this.x += (targetX - this.x) * this.followSmoothing` per update (`character-mode/Camera.js:512-513`). Fixed `0.03` world clock despite a computed clamped `dt` (`IsometricRenderer.js:85-89, 3281-3293, 3489-3507`), consumed by dozens of water and atmosphere phases (`:5295-5303, 6425-6447`). Idle stride pauses for six of twelve **update calls** (`AgentSprite.js:1904-1922`). The millisecond-domain twin already exists (`PulsePolicy.js:30-70`) and `WeatherRenderer` already advances from `dt` (`:129-138`) — this is a migration to an existing precedent, not an invention.

**Work.** `Camera`: `1 - Math.exp(-dt / tau)` with `tau` chosen to preserve today's 60 Hz feel; keep the timed follow ease, bounds clamp, and integer pixel snap. `IsometricRenderer`: publish **C3**, derive `waterFrame` as a virtual 60 Hz frame. `AgentSprite`: elapsed stride accumulator preserving the authored six-on/six-off cadence in milliseconds. Migrate touched sine cues to `pulseValueMs()`/`pulseBand01()`.

**Acceptance.** Deterministic simulation at 30/60/120 Hz dt sequences produces matching position, pulse phase, and stride phase within tolerance after 1 s and 10 s. Reduced motion still allocates nothing. **Pixel snapping is not removed** — fractional nearest-neighbour transforms are an art regression, not a smoothness win.

**Risk.** Double conversion where a caller treats virtual frames as milliseconds; authored cadence drift. Land this before items 7, 10, 11, 12, 13 so no effect ships against the old clock.

### 3. Canonical attention and status ledger
**Owner:** Vera territory · **Size:** M · **Consensus rank 3**

**What the operator sees.** Attention stops being one ambiguous number. Distinct counts for **Needs you**, **Errors**, **Quota**, and **Watchlist**, in the same nouns and order across top bar, sidebar, World live summary, Dashboard queue, project health strip, title, favicon, and toast. A blocked approval reads urgent; a rate limit reads as capacity; an ordinary quiet wait stays visible without pretending someone must answer it. Project headers say "1 error · 1 blocked · 1 quota · 4 working · 2 idle" and the red edge flash fires only for a genuine error.

**Why it carries signal.** Four operationally different states currently share two encodings, and two surfaces encode them *wrongly*. Every later visual and sonic improvement amplifies whichever taxonomy it consumes; there must be one.

**Evidence (verified).** Seven statuses exist (`domain/value-objects/AgentStatus.js:1-9`). `StatusResolver` says blocked, errored, **and** rate-limited all need a person (`domain/services/StatusResolver.js:108-115`) and `AttentionService.list()` uses that predicate (`:250-259`) — but `World.getStats()` increments `attention` only for `RATE_LIMITED` and `WAITING_ON_USER` (`domain/entities/World.js:80`), so an errored agent is in the attention service and absent from the `NEEDS YOU` number that `TopBar` renders from `stats.attention` (`shared/TopBar.js:623-635`; badges at `index.html:63-67`). The Dashboard queue includes generic `waiting` beside the three canonical states (`dashboard-mode/DashboardRenderer.js:572-590`), while `_updateSectionHealth()` increments `counts.errored` for `rate_limited` and `waiting_on_user` (`:398-406`) and sizes three segments from that conflated total (`:424-435`; CSS `css/dashboard.css:142-171`). The World summary reports only waiting-on-user as "need you" and merges errors with quota (`IsometricRenderer.js:4258-4267`).

**Work.** One pure bucketing helper emitting **C2**, consumed by `World.getStats()`, `AttentionService`, `TopBar`, `DashboardRenderer`, and `_syncSemanticSummary()`. Segmented top-bar treatment with text and ARIA labels rather than one count carrying four meanings. Six health buckets with matching CSS segments, zero-count segments hidden, stable order error → blocked → quota → working → waiting → idle. `ERRORED` becomes reachable rather than a dead `span`. Rename the flash state to true-error.

**Acceptance.** A fixture with one agent in each of the seven statuses produces identical bucket counts in every consumer. `A` visits error → quota → blocked in documented order. Generic `waiting` appears only in Watchlist. Blocked and quota rows never increment an error count. No percentage replaces a count — percentages erase the outlier the operator came to find.

**Budget.** A few integer comparisons per render, event-driven and cached; **zero** frame or GPU cost. Fits without touching the 1.00 ms reserve.

---

## Package 2 — Measurement, honesty, and subtraction

### 4. The flight recorder that tells the truth
**Owner:** Bram territory · **Size:** M · **Consensus rank 4**

**What it produces.** "The frame was late" resolves into world update, Canvas labels, GPU upload, GPU execution, browser/host gap, or unknown. When a storm quiets itself, the record says which measured budget caused it.

**Why it matters.** Without attribution, every visual proposal in Package 3 is anecdote and every pressure cut risks destroying the wrong signal. Bram's own local stress captures at 20 agents measured frame p95 34.3 ms against render p95 7.5 ms on a loaded host — the app currently cannot tell those apart, and `PostFxLadder` can score an over-35 ms frame gap as its own driver (`postfx/PostFxLadder.js:40-83`) while renderer CPU sits near 2.6 ms.

**Evidence.** `ClientPerfMetrics` has `beginRenderStage`/`endRenderStage` (`shared/ClientPerfMetrics.js:319-335`) but live code wires only its message/delta hooks (`infrastructure/WebSocketClient.js:112-125`). World timing starts only with the debug overlay, and its profiler copies, shifts, maps and sorts *while finishing a frame* (`WorldFrameRenderer.js:936-980`). `/api/perf` exposes server data only (`server.js:379-425`).

**Work.** An always-available scalar frame envelope in `IsometricRenderer._loop` (update, render, total, rAF gap, failure stage), EMA/counters only when diagnostics are off, bounded rings otherwise with percentiles computed at snapshot time. Bridge the existing `ClientPerfMetrics` render stages. Publish `frameHealth()` beside `window.__claudeVillePerf`. Extend `scripts/smoke/world-fps-benchmark.mjs` output. Close the pixel ledger: add byte estimates and ownership classes for GPU-equipped sheets and agent material/emissive atlases to `AssetManager.cacheStats()` and `AgentSprite.sharedCacheStats()`, and add named CPU-decoded / CPU-derived / Canvas-visible / GPU-owned leaves to `unifiedRendererResourceAccounting()` — today foliage is the only retained-pixel provider (`IsometricRenderer.js:10002-10049`; `AssetManager.js:770-812`; `AgentSprite.js:352-368`).

**Acceptance.** A synthetic long task *outside* the renderer is labelled a host gap, not a GPU-world regression. Quality decisions prefer app-owned measurement when attribution exists. CPU backing and GL texture bytes are never double-counted. The disabled path allocates nothing.

### 5. No more false gossip
**Owner:** Isolde territory · **Size:** M, mostly deletion · **Consensus rank 5; Halvard ranked it 3rd, Vera 4th**

**What the operator sees.** Two idle villagers resting near the bridge face the water in silence. They do not sprout a chat bubble. A real `SendMessage` still brings two people together, faces them, and draws the existing talk mark; if the model supplied words, those words carry provenance.

**Why it carries signal.** ClaudeVille's dialogue contract invents zero words — and then a presentation layer reintroduced invented *social meaning* through a bubble-shaped effect. A positional knot teaches the operator that idle proximity means communication, which is false. Silence is not a missing feature; it is an accurate statement that nothing attributable happened. This is the council's clearest example of beauty that carries a lie, and deleting it makes every real conversation matter more.

**Evidence (verified).** `_rebuildGossipClusters()` groups 2–3 `IDLE` sprites within `GOSSIP_RADIUS_PX` of a scenic point, checking no affinity record, message, or event (`RelationshipState.js:206-242`). `CouncilRing` applies the knots and draws a warm chat triangle (`:110-127, 579-602`). `AgentSprite.enterGossip()` sets `chatting = true`, reuses the speech-bubble effect, and starts a 4–8 s timer (`:2153-2186`) — and `chatting` is the *first* branch of `resolveAgentAction()`, so fake proximity also produces a `TALK` action (`ActionVocabulary.js:6`, verified).

**Work.** Remove `gossipClusters`, `applyGossipClusters`, the gossip triangle, and the `enterGossip()`/cooldown path. Keep scenic destinations and place-specific idle posture as silent rest. `resolveAgentAction()` receives `chatting = true` only for actual pairwise chat. Preserve all real talk arcs, affinity accounting, and the model-text provenance path.

**Acceptance.** Two unrelated idle agents at one scenic point produce no cluster, no `chatting`, no `TALK`, no triangle. A real `SendMessage` fixture still produces the pair arc and bubble. Timers and a random cooldown are removed, not replaced. **The gap is not filled with barks** — there are zero authored bark lines by design and that stays true.

### 6. Book of Lives, with a retention charter
**Owner:** Isolde territory, with Halvard's storage contract · **Size:** M/L · **Consensus rank 6**

**What the operator sees.** Selecting a villager opens a quiet chaptered book beneath the dossier: "First seen 4 Mar", "last returned 9m ago", then a short chronological stack of real chapters — arrived, waited for you, recovered, committed, pushed, departed — each naming its project. It says "history retained as a summary" rather than pretending to quote a vanished transcript. Clicking a row opens the corresponding Chronicle date. Settings states plainly what survives a reload and what does not, and says so honestly when browser storage is degraded.

**Why it carries signal.** `AgentBiography.toRecord()` persists ten top-level fields; the panel shows four counters plus the latest milestone (`domain/value-objects/AgentBiography.js:119-145, 183-201`; `shared/ActivityPanel.js:1470-1523`). "8 recovered" proves a life exists without letting the operator feel its shape. A bounded chapter turns it into "recovered from the rate limit on Tuesday, then pushed on Wednesday" — memory as atmosphere *and* as operational history.

**Evidence.** Chronicle rows carry session `agentId`/name but no `identityKey` and prune at 14 days (`application/ChronicleLog.js:352-374`; `infrastructure/ChronicleStore.js:384-407`). The Chronicle modal is date-browsing, not per-villager. `ChronicleStore` already has `idle`/`opening`/`ready`/`degraded` state and a status listener that `App.js` never passes (`App.js:136-151`).

**Work.** Add the resolved `identityKey` to Chronicle records with a store migration. A pure reducer folds expiring day-book rows into the bounded `lifeEpisodes` ring of **C6** — event kind, timestamp, project label, wait duration, sanitized short label. Raw retention stays 14 days. Collapsible timeline renderer in `ActivityPanel`. Wire `chronicle:status`; add the Settings retention matrix and a `persistenceNotice` raised only on an actual read/write failure.

**Acceptance.** One named identity fed arrival, wait/resolution, error/recovery and push across simulated restarts yields one ordered deduped ring while the raw 14-day row may expire. **Two distinct anonymous session ids never share a chapter** — the anonymous key is name/session-derived (`AgentBiography.js:148-166`) and must refuse to join. No raw assistant or reasoning text is ever written. Live monitoring continues when storage is degraded, and the Settings ledger names exactly which capability is missing.

**Risk.** False identity is the serious one, and it is why home-port continuity and district patina are *deferred* below rather than shipped here.

### 7. Semantic pressure and silence budget
**Owner:** Bram territory, with Nocturne and Aurelia adapters · **Size:** M/L · **Consensus rank 7**

**What the operator sees and hears.** In a crowded storm the air thins before meaning does: rain density, fauna, secondary glows, ambient meteors, water shimmer and bloom soften first; the selected villager, the waiting/error/quota marks, provider identity and primary route stay crisp. When pressure passes, atmosphere returns slowly rather than blinking. On a genuinely calm clear night the village becomes still enough that the next real event lands — and the soundscape has a real resting floor instead of a permanent bed.

**Why it carries signal.** Negative space is an information channel. A meteor, twinkle, sea glitter, sky flare, grade, particle and relationship mark cannot all be the loudest thing. `docs/visual-experience-crafting.md:192-207` already instructs removal when an effect does not aid understanding; this is the mechanism that obeys it. It is also the only item whose first implementation is *subtraction*.

**Evidence.** `MarkGovernor` gives primary marks infinite limits but scene pressure only selects an annotation mode (`MarkGovernor.js:1-32`). The postfx ladder governs only its own levels (`PostFxLadder.js:40-83`); GPU weather, light caps and bloom shedding are local to the GPU renderer (`gpu/GpuWorldRenderer.js:926-1015`). Good actuators already exist and lack a shared attributed input: rain's 180-streak ceiling (`WeatherRenderer.js:503-548`) and the 240-particle cap (`ParticleSystem.js:1-2`). On the ornament side, `SkyRenderer` budgets 12 live-twinkle stars plus ambient meteors every ~90–180 s (`:20-35, 181-200`) and one water pass runs phase tint, ripples, fog edge, wakes, night reflections, sea glitter, light reflections, surf, river flow, currents and shimmer together (`IsometricRenderer.js:6393-6438`).

**Work.** Produce **C4** from the recorder; feed state plus a normalized ambient budget to `WeatherRenderer`, `ParticleSystem`, fauna, `MarkGovernor`, and the existing postfx policy. Reuse the existing 12-frame hysteresis with a minimum dwell per rung — do not add a competing oscillator. A calm-scene gate suppresses ambient meteors, sparsens live twinkle and quiets low-value sea glitter in clear, no-attention, no-recent-event frames while retaining stars, lanterns, weather, and every explicit event or attention cue. On the audio side, a hysteretic quiet floor gives silence a state, and a mix/headroom policy with role buses ducks routine ambience under any urgent cue.

**Acceptance.** Primary marks and Canvas fallback survive every rung. Degradation follows C4's declared order and is hysteretic, not oscillating. Attachment byte budgets are never a visual-quality trigger. A/B captures of clear night with no agents / one working / a completion show the waiting and completion reads becoming *stronger*, not weaker. Reduced motion output remains static and semantically identical.

**Risk.** A sterile village that reads as idle, or shedding too early. Gate only effects proven ornamental in A/B review; keep static stars, lanterns, material state and all weather signals.

---

## Package 3 — What the headroom buys

### 8. The resident authored material packet
**Owner:** Bram territory with Aurelia art sign-off · **Size:** L · **Highest visual score, 64**

**What the operator sees.** Atlas-only Opus and Sol villagers stop looking generically profile-lit: cloth, metal and their actual rune pixels respond to the authored channel sheet. Shore and road respond as their materials; a lantern glows from its painted pixels rather than an ID heuristic. Stone, timber, metal, foliage and water become different substances. And the first nightfall stops producing a procession of texture uploads — a new villager appears immediately with a correct base pose while weapon sheets and sidecars settle in behind it at a revision boundary.

**Why it carries signal.** A material map is not decoration: it says what is solid, wettable, elevated, occluding, or actively emitting. The project already paid for the four-channel contract, the pilot atlas and channel-aware packing; the remaining consumers simply do not reach it. This is the highest signal-per-byte opportunity in the renderer — and it must not be paid for with a hitch at the exact moment a new agent needs attention.

**Evidence.** The manifest declares the four-channel contract and an 18-ID reviewed pilot atlas (`assets/sprites/manifest.yaml:8-44`), including atlas-only `agent.claude.opus` (`:88-107`) and `agent.codex.gpt56sol` (`:225-244`). `AgentGpuOverlayRenderer` looks only for individual sidecars (`:126-133`) although `AssetManager` already implements companion-first/atlas-second (`:705-713`). `GpuSceneBuilder` crops and caches atlas channels correctly for landmarks (`:107-159`) but paints a procedural class map over terrain (`:161-200`) and gives props heuristic materials (`:290-337`), while terrain manifest entries already declare semantic material classes (`manifest.yaml:1497-1569`). Separately, `recordForBuilding()` keys textures per building despite authored atlas frames (`GpuSceneBuilder.js:235-265`; `manifest.yaml:680-687`), a live 20-agent capture recorded 110 uploads / ~113.8 MB uploaded, `packedLandmarkChannels()` performs up to three `getImageData()` readbacks inside record assembly (`:107-158`), and `AgentSprite.draw()` calls `_syncGpuEquippedSheet()` in the visible draw path with cold composition of every cell (`:2296-2320, 3367-3424`).

**Work, strictly staged.** (a) Land **C5** as the single resolver and cache key. (b) Route atlas-only agents, manifest terrain and high-salience pilot props through it, retaining the procedural fallback as the explicit safe path. (c) Route static building and authored-prop GPU records to atlas frames with rect-based sources, preserving front/back horizon splitting and the individual-source fallback. (d) Add a bounded derived-art queue — `requestIdleCallback` with `setTimeout` fallback, ~2 ms slices, visible-selected/waiting first — that builds candidates offscreen and publishes cache entry plus texture revision atomically; no readback or sheet composition may run from a draw that has not already found a ready artifact. (e) Renderer-owned scratch arrays for records, batches, occlusion indices and uniforms; clear lengths, not identities; grow typed buffers geometrically and upload a subarray (today each batch allocates a fresh `Float32Array` and uniforms allocate two 64-float arrays per frame — `gpu/GpuWorldRenderer.js:825-995`).

**Acceptance.** Canvas pixels stay byte-stable. WebGL overlay census unchanged. GPU source bytes and batch count lower or equal. A missing atlas frame still renders. Atlas rects verified against anchors, split horizons and nearest sampling — a one-pixel UV error is an invisible-until-shipped defect. No derived-art readback overlaps the first visible frame. Forced-GC snapshot after dense-100 churn shows no unbounded packet growth. Dashboard suspension still drives World-owned leaves to zero.

**Risk.** Mutation bugs are more dangerous than allocation bugs: never share a scratch packet with diagnostics after the frame. Uploading one large atlas can be worse than a few small sources when a single landmark is visible — measure resident bytes per manifest category before enabling each.

### 9. World incident marks at overview LOD
**Owner:** Vera territory · **Size:** M

**What the operator sees.** Zoomed out to a constellation, a blocked prompt keeps its amber beacon, an error carries a static red alert mark, a quota stop carries an hourglass. They stay legible when the agent is too small for a name, and they do not pulse under reduced motion. A small World-controls legend states the three marks.

**Why it carries signal.** This is the project's own LOD contract — far distance gets silhouette, medium gets status, close gets text (`docs/visual-experience-crafting.md:93-112`). Today the Canvas low-zoom path returns after drawing the impostor, the waiting beacon and the tool glyph (`AgentSprite.js:2376-2388`), so the error and rate-limit emotes defined at `:5519-5555` and drawn at `:2508-2565` are simply skipped, and the impostor's status dot has no shape distinction (`:6140-6169`). The GPU overlay already admits primary annotations (`AgentGpuOverlayRenderer.js:32-65`), so this closes a Canvas-fallback gap rather than restructuring GPU rendering.

**Work.** Extract the status-emote primitives into a static compact helper callable from the low-zoom branch, consuming **C2** buckets. One fixed slot, shape-primary and colour-secondary, at most one static primitive per primary state. Static when `motionScale <= 0`.

**Acceptance.** The `waiting-on-user`, `quota-rate-limit` and `failed-push` simulator scenarios are distinguishable below zoom 1 without opening the panel, in both Canvas and GPU paths, with reduced motion on. No mark soup: no text labels on every villager, and actionable marks never compete with the selected agent.

### 10. Semantic audio conductor, staged
**Owner:** Nocturne territory · **Size:** L, three stages · **Highest-regret item; stage gates are mandatory**

**What the operator hears.** Stage one: routine events coalesce — six arrivals in a burst become one intelligible answer, while a summons or a distress cue is never queued behind thunder, and role buses give urgent cues headroom by ducking ambience instead of shouting over it. Stage two: a long calm interval becomes real perceptible rest with hysteresis, so the next summons is heard rather than habituated away. Stage three, and only if the first two land: pressure, waiting and verified resolution share one harmonic grammar — the score modulates at safe bar boundaries instead of crossfading between unrelated loops, with an immediate urgent lane that bypasses the boundary.

**Why it carries signal.** Sound's stated job here is to reach an operator who is not looking. That only works if the ear can rank what it hears. Nocturne's inventory found seven ambient voices plus BGM whose gains ignore most world state, cues with no shared priority arbiter, no sidechain or master headroom discipline, and meaningful events (verified push, milestone, recovery) that are silent.

**Work and gates.** Stage one consumes **C2** and **C4**; a priority arbiter and a headroom/role-bus policy in `CueGovernor`/`AudioDirector`, with captions matching the existing `audio:cue-played` contract. Stage two adds the hysteretic quiet floor and lifecycle thresholds (tab hide/blur, mode switch, first gesture, long idle). Stage three touches `BgmDirector`/`BgmPlayer`/`MusicalScale` and **may not start until stages one and two are verified in a real listening session with a documented fallback to current behaviour.**

**Acceptance.** Six simultaneous events produce one intelligible, prioritized result and never a pile-up. A tab-hidden urgent cue still reaches the operator. Silence is reachable and stable, not a stalled engine. No stuck notes, no accidental key jumps, and one flag reverts to today's behaviour.

**Risk — stated plainly.** Three of six members named the full conductor the likeliest "started and never finished" item: it spans two authored music books, a generative scheduler, cue voicings, bar-boundary transitions and subjective listening, and a pure reducer can pass while the audible result is worse. Stages one and two carry most of the value; stage three is optional in this plan.

### 11. The sun must cast a moving shadow
**Owner:** Aurelia territory · **Size:** M · Depends on item 2

**What the operator sees.** Scrub from morning into afternoon and the key light *turns* rather than changing costume at four boundaries. A watchtower shadow lengthens and rotates across the quay; the forge roof catches a warmer, longer rim at dusk; stone settles back to a cool short noon shadow. The sky stays a stepped pixel painting — the ground now agrees with it.

**Why it carries signal.** Time is already a durable signal, and the machinery is already paid for and thrown away: `AtmosphereState` computes a continuous sun position (`:796-809`) and then collapses the physical shadow direction to three constants (`:1007`, verified), which every structural and tower-cast shadow consumes (`BuildingSprite.js:597-649`). The GPU seam already receives `lighting.sunDirIso` (`gpu/GpuWorldRenderer.js:948-955`). Contact shadow, roof glint and water reflection currently disagree about where the sun is.

**Work.** One pure deterministic solar-vector helper in `AtmosphereState` from minute-of-day and the season-adjusted phase table, easing toward the horizon at dawn/dusk and clamped against the authored upper-left noon convention. Return it as the canonical `sunDirIso` and `shadowAngleRad`; let `drawShadows()`, roof glint and water reflection share it; pass it through the GPU scene and postfx feed as an additive uniform.

**Acceptance.** Continuous angle across dawn/day and day/dusk boundaries; monotonic daylight elevation; different winter and summer sunrise placement. Shadow direction, roof glint and `sunDirIso` agree in Canvas, postfx and WebGL2. The four response bands (`0.72, 0.86, 1.0, 1.12`) and stepped grammar are retained — this is directional light, not smooth PBR. Reduced motion holds a fixed pose with no new allocation.

### 12. Ground and surface weather truth
**Owner:** Aurelia territory · **Size:** M · Draws on the 1.00 ms reserve; gated behind items 4 and 7

**What the operator sees.** At dawn, mist gathers where the river, harbour and low flanks actually are — thin clipped ribbons between feet and foundations, opening along the roads, thinning toward the rim, never touching a label or a selected agent. In rain, cobbles darken without going black, timber takes a restrained cool sheen, metal catches a small hard glint, earth stays damp matte, and puddles remain rare and confined to paths, squares and shore; as it clears, the sheen releases gradually. At dusk the mine's cave mouth and the portal's rune aperture read as intentional openings rather than a generic orange pool, with a narrow doorstep spill scaled by real occupancy.

**Why it carries signal.** A screen-wide grey wash makes a mood; ground-bound haze carries weather *and* landform *and* depth. A damp road says weather, a dry path beside a wet shore says geography, and an unchanged warm rune says activity rather than rain. Occupancy light answers "where is work actually happening?" more honestly than a radial blob.

**Evidence.** Fog is currently a canvas-wide vertical gradient (`SkyRenderer.js:470-513`) plus screen-space bands (`WeatherRenderer.js:854-899`), with ground fog limited to up to ten cached wisp anchors (`WorldFrameRenderer.js:586-704`). `MaterialRegistry` already authors wetness and reflection coefficients for ten classes (`:47-59`), but `applyMaterialWeather` treats only stone, metal, cobble and water as wettable — timber and earth have authored profiles and no branch (`gpu/GpuWorldRenderer.js:112-127`). `BuildingVisualRegistry` has calibrated `windowRects` for command, taskboard, forge, archive, observatory, watchtower and harbour but **not** mine (`:104-115`) or portal (`:172-184`), and explicitly falls back to legacy radial warmth (`:331-335`).

**Work.** A deterministic `hazeField` from existing `waterTiles`/`waterMeta`/lowland anchors and authored road geometry, stored as a compact quarter-resolution mask keyed by camera pose and atmosphere bucket — reusing the existing `PostFxFeed` quarter-resolution water-mask budget discipline, not a new full-resolution texture. A pure material-response table derived from `MaterialRegistry`, plus a small `surfaceWetness` attack/release scalar carried as one uniform. Authored mine and portal window rects and an optional `doorSpill` anchor drawn in the existing split-aware reaction pass. **No blur kernel** — feathering must respect the authored edge language.

**Acceptance.** Haze follows water when the camera pans and does not stick to the screen. `selected-behind-building`, dense-24 and dense-100 keep agents, footings, roads and labels legible. Clear → rain → clear at one seed and hour behaves identically across all three render paths, with fire and emissive runes unchanged. No light rectangle leaks through the wrong half of a split building. Reduced motion is a fixed damp state, not a pulsing highlight. Camera-pose rebuilds are the expensive case and must not run per frame.

### 13. Verified outcomes and the Chronicler's errand
**Owner:** Isolde territory, with Nocturne's cadence · **Size:** M

**What the operator sees and hears.** A villager raises its arms only when something actually landed: a countable commit, push, release or provider-reported success, with one quiet cadence to match. A session that merely vanished settles quietly at the Archive with "departed" as the signal. And the Chronicler stops tracing an invisible circuit: it sits at the Archive with a book open, and when a real milestone arrives it closes the book, walks to that monument, pauses, and returns.

**Why it carries signal.** Celebration is a strong emotional claim, and spending it on evidence makes it a reward rather than noise. `ActionVocabulary` maps every `COMPLETED` to `CELEBRATE` before considering tools (`:7`, verified) while `AgentManager` deliberately projects any missing live session onto `COMPLETED` for a ten-minute grace period, documenting it as presence rather than execution state (`:259-282`) — so today the village celebrates disappearances. Likewise a named observer walking four fixed waypoints every update with a six-second pause (`Chronicler.js:4-62`) is the purest case of atmosphere detached from signal, and the event-driven seam already exists (`:121-131`).

**Work.** Emit **C7**. Replace unconditional `CELEBRATE` with a neutral `SETTLED`/`DEPARTED` action for `agent.isDeparted`; only C7 may return `CELEBRATE`, expiring after the one-shot effect. Replace the Chronicler's `WAYPOINTS` loop with an Archive home tile plus a bounded coalescing event queue; after it drains, the figure returns home and stays there. One deduped audio cadence consumes C7.

**Acceptance.** A live completed agent with an explicit successful result celebrates; a departed projection with no result does not; a failed push never celebrates. With no Chronicle events, the Chronicler stays at the Archive for a long simulated interval; a burst coalesces rather than queueing unboundedly. Reduced motion yields zero movement and a stable drawable. Providers whose adapters cannot report success get neutral settlement — **do not guess.**

### 14. Selection, focus and deselect as one lifecycle
**Owner:** Vera territory · **Size:** M

**What the operator sees.** Clicking empty World truly clears the panel instead of leaving a stale report beside an unselected village. Keyboard selection puts focus on the panel's labelled heading or close control; `Escape` closes and returns focus to the initiating control. With reduce-motion on, the sidebar becomes still but not mute.

**Why it carries signal.** The panel is the proof surface; if selection and focus disagree the interface tells two stories. The World miss path already calls `onAgentSelect(null)` (`IsometricRenderer.js:3193-3215`) but App always calls `emitAgentSelected(agent)`, and that helper intentionally emits nothing for null (`App.js:392-394`; `shared/AgentSelection.js:6-12`) — so the stale panel is a wiring gap, not a design. The panel is an unlabelled `aside` with no `role` or Escape handler (`index.html:174-180`; `ActivityPanel.js:272-400`), while `Modal.js:9-99` already demonstrates the correct focus/restore precedent. Separately, the sidebar applies `sidebar-pulse-dot` to five status dots and its reduced-motion blocks never override them (`css/sidebar.css:231-286, 327-343`), although Dashboard does exactly that (`css/dashboard.css:912-925`) — a direct violation of `docs/motion-budget.md:39-45`.

**Work.** Wire the null callback to `emitAgentDeselected()`. Add `role="region"` and `aria-labelledby`. Track keyboard-origin versus pointer-origin selection so keyboard selection moves focus and a canvas click does not steal it. Panel-scoped `Escape` with modal/popover precedence and trigger restore. Narrow reduced-motion rule for the sidebar status dots.

**Acceptance.** Canvas click then empty click closes the panel. Keyboard selection then `Escape` returns focus to the trigger. An open modal still gets `Escape` first. The panel does **not** become a focus trap — it needs a return path, not modal semantics. Computed `animation-name` is `none` for all five sidebar dot states under reduce-motion, with colours, rails and text intact and no replacement shimmer.

### 15. Release charter — a local, documented release gate
**Owner:** Halvard territory · **Size:** M

**What it produces.** Nothing on a calm day; that is the point. A release stops being called professional because pure logic is green. One command starts an isolated child server on port 0 with a temporary HOME and proves `/`, `/api/providers`, `/api/sessions`, `/api/usage`, a WebSocket 101 and initial snapshot, a delta, and a resync. A stale listener on 4000 becomes a failed child with a useful diagnosis instead of a green process serving nothing — which is exactly what happened during this council's own research: both documented browser smokes failed at `page.goto`, `curl` to `/api/providers` timed out, and `npm run dev` printed `Port 4000 is already in use.`

**Scope ruling — two things are explicitly out.** First, no browser or component test runner is added; `AGENTS.md` states none exists, so **Halvard's proposed Playwright job is removed** and browser and visual verification remain manual against the maintained dev server and `docs/world-visual-qa-checklist.md`. Second, **this item does not touch `.github/workflows/ci.yml`.** `AGENTS.md` states the project has no CI, while `.github/workflows/ci.yml` exists — landed by the prior plan as R1-05. That contradiction is a maintainer decision about project policy, not something an implementation plan should widen by adding jobs. The charter is therefore a **local gate**: an npm script plus a documented pre-push checklist. If the maintainer later resolves the contradiction in favour of keeping CI, wiring the same script into the existing workflow is a one-line follow-up.

**Work.** Add `scripts/smoke/boot-contract.mjs` using the existing port-redirection seam (`scripts/smoke/r1-18.server-bootstrap.cjs:1-20`). Add one `npm run gate:release` script that runs, in order: `validate:quick`, `test:e2e:replay`, `scripts/smoke/server-security.mjs`, `scripts/smoke/server-fatal.mjs`, and the new boot-contract smoke — all already deterministic and dependency-free. Fixtures contain synthetic paths and tokens only.

**Owned paths.** `package.json` (scripts only), `scripts/smoke/boot-contract.mjs`, `scripts/smoke/README.md`, and **both root agent docs — `AGENTS.md` *and* `CLAUDE.md`.** The two are parity-locked: `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` must stay empty (verified empty at plan time), so the validation-matrix row for `gate:release` must be written identically into both files in the same commit. Editing only `AGENTS.md` breaks the documented gate. Add the row beside the existing manual browser rows, and note there that `package.json` promises Node `>=18` while the gate runs only on the developer's local version — a maintainer who keeps CI should exercise both 18 and 24 there.

**Acceptance.** `npm run gate:release` passes with 4000 free, and reports the collision without claiming readiness when 4000 is occupied. The parity diff is empty after the docs edit. `validate:quick` and `test:unit` remain the cheap everyday gates. The full visual baseline matrix stays review-oriented and hardware-labelled — it does not become a per-commit gate. No workflow file is modified by this item.

---

## Sequencing and parallelism

Territories are partitioned by **file ownership**, which is the only real constraint in a shared checkout. `App.js`, `index.html` and `css/**` are the integration surface and are **never** owned by a parallel agent; a serialized integration pass wires each wave and runs `npm run validate:quick`.

| Wave | Items | Why here | Concurrency |
| --- | --- | --- | --- |
| **W1 — truth and time** | 1, 2, 3 | Every other item consumes C1, C2 or C3. Item 5 is a pure deletion with no dependency, so it rides along. | 1 ∥ 2 ∥ 3 ∥ 5 — disjoint files; 1 and 3 must agree on the C1/C2 seam up front and hand `TopBar`/`index.html` edits to integration |
| **W2 — evidence and honesty** | 4, 6, 14, 15 | 4 must precede any budget claim. 6 needs storage/identity settled before panel content. 14 lands the ARIA/focus scaffold *before* item 6 adds panel rows. | 4 ∥ 6 ∥ 15; 14 lands its scaffold before 6's renderer |
| **W3 — restraint and residency** | 7, 8, 9 | 7 needs 4's attribution; 8 needs 4's ledger and 7's shedding contract; 9 needs C2. 8 is internally staged (a)→(e) and must not be parallelized across its own stages. | 7 ∥ 9; 8 serial internally, one integration owner for `GpuSceneBuilder`/`AssetManager`/`AgentGpuOverlayRenderer` |
| **W4 — light, memory, sound** | 11, 12, 13, 10 | These spend the 1.00 ms reserve and the audio budget, which only now have a measured ceiling. 10 stages 1–2 first; stage 3 optional. | 11 → 12 (shared `BuildingSprite`/`AtmosphereState` anchors); 13 ∥ 10 |

**Three items must land first, in this order:** (1) the truth contracts, (2) One Clock, (3) the flight recorder. Nothing in Package 3 may begin before all three, because each Package 3 item either reacts to state, animates against the clock, or spends a budget.

**Highest risk of regret:** item 10 stage 3, the harmonic conductor. Three of six members flagged it as the likeliest thing to be half-built. Its mitigation is written into the item: stages, a listening session, and a one-flag revert.

**Second-highest:** item 8's atlas rect work, where a one-pixel UV error is invisible until it ships. Its mitigation is Canvas byte-stability plus per-category resident-byte measurement before enabling.

---

## Killed on the evidence

Recorded so they are not resurrected without new facts.

| Proposal | Ruling | Reason |
| --- | --- | --- |
| **Camera as audio listener** (Nocturne 8) | Killed, 5 ballots | The prettiest idea on the table with no new information: the eye already says what is focused, while continuous camera-coupled panning risks pumping on a still scene. Its own author ranked it not worth the cost. |
| **GPU pass lanterns** (Bram 8) | Killed for this plan | Four asynchronous query boundaries are instrumentation cargo cult until the flight recorder proves a repeated GPU-owned culprit the existing whole-pipeline timer cannot explain. Keep as a test-only hook. |
| **Compose an aperture around what matters** (Aurelia 7) | Killed as a release feature | Selection ring, status mark, camera follow and panel already answer "look here". Admission-controlled foreground can make a screenshot feel composed while *hiding* a route or a villager. Retain the authored-clearance table as a constraint on future marks. |
| **Nine-workshop "work becomes texture"** (Nocturne 5, full breadth) | Killed at proposed scope | Nine simultaneous building voices is nine status LEDs rendered as noise. At most one quiet building-family pilot may follow the priority bus. |
| **Standalone "label dollars as estimates"** (Vera 8) | Merged away | Subsumed by pricing provenance below; a wording-only patch would create a duplicate `TopBar`/`ActivityPanel` owner. |
| **Playwright job, and any `.github/workflows/**` change** (Halvard 6, part) | Removed | `AGENTS.md` states there is neither a browser/component test runner nor CI, while `ci.yml` exists from the prior plan. Browser verification stays manual, and item 15 ships a local `gate:release` script rather than widening an already-contradicted CI policy. |
| **Persistent renderer / motion wardrobe settings** (Halvard 8) | Killed as a feature | URL parameters and the system reduced-motion preference already cover it; a persisted fidelity control multiplies support combinations. A narrow tested escape hatch lives inside item 7. |
| **Canned barks, ambient social choreography, per-tool sound** | Killed permanently | Zero authored bark lines is a deliberate contract. Per-tool audio is a log file with reverb. |
| **WebGPU, OffscreenCanvas worker, radiance-cascade GI, a height channel** | Remain rejected | No reopen trigger is met (`open-followups.md:73-83`); occluder R already carries height; smooth GI fights the authored palette contract. |

## Deferred with explicit triggers

| Item | Trigger to reopen |
| --- | --- |
| **Home port / spatial arrival continuity** (Isolde 7) | Only after item 6 proves the identity key is trustworthy. A wrongly remembered station turns an identity bug into a cherished false memory — worse than a deterministic gate arrival. |
| **Permanent district patina** (Isolde 2) | After item 6's durable verified aggregates exist. Thresholds must stay few, documented and tied to verified commit/push/recovery totals, with the source shown on hover, or it becomes a game skin. |
| **Seasonal canopy palettes** (Aurelia 6) | After the pixel ledger shows one old-season cache release is sufficient, and after visual QA confirms the existing ground season decals are genuinely insufficient. |
| **Pricing provenance and quota clock** (Halvard 4 + Vera 8) | Just below the line at score 9. Ship as a small follow-up: `matched` / `provider-default` / `unavailable` plus `pricingRevision` carried through `decorateSessionPresentation()`, and `quotaLastSuccessAt` on `/api/usage`. Extend the existing parity test to assert provenance as well as number. |
| **Search that explains its evidence** (Vera 5) | Score 5. Worth doing after item 3, since bucket nouns and scope prefixes should agree. |
| **Signals belong to systems, not random deputies** (Isolde 4) | Score 6–9. `VisitIntentManager._deriveGlobalIntents()` conscripts the first two non-working agents as Watchtower sentries and the first idle agent as quota sentinel (`:693-733`), which fabricates biography. Fold into a later behaviour pass. |

---

## How this plan avoids the previous plan's failure mode

The prior execution record names four recurrences of the same defect: machinery built with no consumer, and strict file ownership manufacturing last-mile gaps. This plan answers each specifically.

1. **Every contract names its consumers** (C1–C7 above). A producer without its named consumer is not done, and is not counted toward acceptance.
2. **The integration surface is reserved.** `App.js`, `index.html`, `css/**` are wired by a serialized pass per wave, not by whichever agent got there first.
3. **A wiring pass is budgeted per wave**, not discovered at the end.
4. **Independent review is scheduled, not optional.** The prior round found 20 confirmed defects *after* every agent reported success with a green suite — including two HIGH-severity issues introduced by that plan's own work.
5. **Three items are deletions or subtractions** (5, 7's calm gate, 13's false celebration). A plan that only adds is a plan that will not finish.

## Definition of done

- Items 1–9 and 11–15 implemented with their stated acceptance criteria met; item 10 stages 1–2 implemented, stage 3 explicitly shipped or explicitly deferred with a recorded reason.
- `npm run test:unit` and `npm run validate:quick` green; new pure tests added per item as `<item>.<subject>.test.mjs` without editing existing test files.
- `npm run gate:release` green locally before any push: `validate:quick`, replay, security, fatal, and the new boot-contract smoke. No workflow file is modified by this plan.
- Manual browser verification recorded against `docs/world-visual-qa-checklist.md` for World and Dashboard, including reduced motion, dense-24 and dense-100, and all five boot states.
- `CHANGELOG.md` prepended with a named release entry, and the version updated in `claudeville/index.html` (`.topbar__version`) and `package.json`.
- Root agent doc parity holds: `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` is empty. Any item that documents itself in one root doc must write the identical text into the other in the same commit.
- This document's status updated to an execution record, and `agents/plans/open-followups.md` amended with anything genuinely retained.
