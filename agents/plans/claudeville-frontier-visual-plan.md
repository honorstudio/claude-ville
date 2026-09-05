# ClaudeVille frontier visual plan — *The Open Door*

> **For agentic workers:** implement this plan item by item. Each item is one reviewable unit with owned paths, an acceptance statement, and named verification. Re-check every `file:line` anchor before editing; the anchors were read against `35ef417` and line numbers move. Every item cites the research note that proposed it; read that note's proposal section before starting the item.

**Status:** `proposed — not started`

**Baseline:** `main` at `35ef417` (`v0.44.0` *The Slatekeeper*), clean tree, 2026-09-05. Node v24.16.0. Maintained server on `http://localhost:4000`, resident WebGL2 on `ANGLE Metal Renderer: Apple M5 Pro`.

**Goal:** make ClaudeVille visibly more extraordinary *by* making it more truthful: bodies whose hands do the work, buildings that open to show who is inside, light that belongs to the architecture, and a calm frame that becomes an instrument when the operator asks. Nothing decorative is added that does not answer a real question from real data.

**Architecture:** no new subsystems and no platform change. Every item is additive inside existing seams: the sprite manifest and `SpriteSheet` lookup, `RitualConductor`/`AgentSprite` pose resolution, `BuildingSprite` split drawables and `BuildingVisualRegistry` profiles, `GpuSceneBuilder`/`GpuWorldRenderer` records and uniforms, the `PostFxLadder`, `CameraDirector`, `VillageDirector` snapshots, the shared upper Canvas overlay, and the Activity Panel/Dashboard DOM. The one new asset family (an optional per-character *action strip*) is an optional manifest entry with exact fallbacks.

**Spec / evidence:** this document plus [`agents/research/claudeville-frontier-visual/`](../research/claudeville-frontier-visual/): ten independent read-only explorations (light, characters, buildings, signals, camera, chrome, effects/audio, outside eye and 2025–2026 technique survey, performance envelope, asset pipeline) with 71 real-GPU captures. Every current-behaviour claim below cites a `file:line` an explorer read or a capture path an explorer looked at.

---

## Method

Ten explorers with disjoint territories, all read-only against `35ef417` and the maintained server, nine on Astra and one outside-eye on Sol, coordinated by Fable 5.1. Each wrote 6–12 proposals in a fixed format (real data source, files, sketch, cost, risk, wow/informative scores), a ranked top three, and a kill list. The coordinator merged duplicates, weighed independent convergence, checked the performance envelope against every GPU-touching proposal, and retained only items that either two explorers proposed independently **or** one explorer proposed with verified live evidence behind it.

Capture recipe and caveats are in the research README. Two facts govern the whole plan and were measured, not assumed:

| Fact | Evidence |
| --- | --- |
| On a **loaded shared host** (concurrent explorer captures, 1-minute loadavg 101), 40-second runs at FULL with 24 agents showed a serialized `appRender + gpu` upper bound with **no 120 Hz slack** and roughly **8 ms at 60 Hz**; with 100 agents the resident ladder did not reach FULL within 40 s and the worst checkpoint left no 60 Hz slack. This is admission evidence, not a hardware entitlement; 0.1 re-measures in isolation. | [`performance-envelope.md`](../research/claudeville-frontier-visual/performance-envelope.md) §Headroom, 32-row table |
| Character sheets carry **only walk and breathing-idle rows**; every read/edit/shell/think/wait gesture is a procedural overlay on an idle body, and the GPU overlay path invokes only the generic action overlay, not the nine building rituals. | [`character-life.md`](../research/claudeville-frontier-visual/character-life.md) pose table; `SpriteSheet.js:1–25`; `AgentGpuOverlayRenderer.js:53–57` vs `AgentSprite.js:6356–6416` |

---

## The organizing finding

The outside eye named the strongest frame of the whole round: the live village during this very review ([`outside-eye-and-state-of-the-art-04.jpg`](../research/claudeville-frontier-visual/shots/outside-eye-and-state-of-the-art-04.jpg)) — ten silver explorers at the Mine and Forge, the coordinator's plan chalked on the slate, real tool intents in the bubbles. Nobody can buy that frame with a shader. And its weakness is equally visible: annotation covers nearly every interesting patch, the bodies are upright cut-outs whose props do the acting, and the buildings are destinations agents stand in front of.

All ten explorers, from different sides, converged on the same diagnosis:

> **ClaudeVille now tells the truth about state on its DOM surfaces; the strongest next direction is *embodiment*: hands that do the work, doors that open, light that comes from somewhere, and a frame that steps back until asked — with the remaining un-embodied truths (observation certainty, turn age, wait subtype, working set) carried onto the body along the way.**

Three consequences drive the wave order:

1. **The frame budget is spent.** New light must substitute for existing light energy, and every optional GPU effect must carry a measured receipt before it is admitted. Wave 0 builds the instruments; Wave 3 spends only what they show.
2. **The bodies are the cheapest big win and the most expensive asset risk at once.** One authored four-frame strip across the roster is 192 PixelLab generations; a two-character pilot is 16. Wave 2 pilots before it rolls out.
3. **The world already carries most signals in the DOM, not on the body.** Freshness, turn age, wait subtype, working set, cost provenance, and lineage all reach the client and have no World embodiment. Wave 1 fixes that with S-size, asset-free items that make every later spectacle honest.

The village is not redesigned. The isometric art, the harbour, the plaques, the chalk slate, the attributed speech, and the two-face chrome stay exactly as they are.

---

## Guardrails (binding on every item)

Inherited from the Fable 5.1 plan and still binding: zero build, no dependency, no framework; desktop-only ≥1280 px; read-only against provider files, loopback-only server; the WebGL2 renderer is additive-only (no WebGPU, OffscreenCanvas, radiance-cascade GI, normal maps — no OF-007/OF-008 trigger was met in this round, see `performance-envelope.md` §Rejected); motion budget (`docs/motion-budget.md`); stepped palette (`docs/building-style-contract.md`, `docs/material-channel-contract.md`); no invented flavour; counts, never percentages, in attention surfaces; no persisted prompts or transcript prose; `App.js`, `index.html`, `css/**` are the integration surface owned by one serialized pass per wave.

New for this plan, each derived from a repeated finding:

- **One instrument per fact.** A signal gets one visual encoding on the body, one on the building, one in the DOM, never two on the same surface. Where an item replaces an existing cue (sweat/jitter for context pressure, square ellipsis marks for chat, radial halo for occupancy), it removes the old one in the same change.
- **Calm by default, revealed on demand.** Anything that adds text, lines, or interior detail to the World enters only through explicit inspection (selection, hold-to-read, Ambient mode) and leaves with it. The default frame gets *quieter* over this plan, not louder.
- **Tiers at distance, counts on inspection.** Physical tiers (three folio edges, three billets, three notches) are allowed at overview only when the exact count is one click or hover away.
- **Substitute, then add.** No GPU item may raise the ladder's `budgetMs`, the 32-light cap, or the resident texture footprint without a measured offset from the same wave.
- **Bodies never lie about outcome.** Invocation is not completion; completion is not success; `subagent:completed` is removal-derived (`AgentEventStream.js:304–314`). Only explicit result records (`toolExitCode`, verified git outcomes) earn a success mark.
- **Ambient never steals the camera.** Explicit mode choice grants ownership; any pointer-down, wheel, navigation key, or selection revokes it until an explicit Resume. Timed re-takeover after manual input is prohibited in Ambient (the existing Auto timers are unchanged).

---

## Cross-item contracts — specify before any work starts

**C1 — Observation certainty on the sprite** (producer: 1.1; consumers: 1.2, 1.4, 2.2, 3.2, 4.2, 4.3)
```
sprite.observation = {
  state: 'fresh' | 'stale' | 'unavailable',   // from agent.freshness.state, agent.signalStale
  observedAt: number | null,                    // agent.signalObservedAt ?? agent.freshness.observedAt
  ageMs: number | null,
}
```
Stale never converts to idle, dead, or provider-down. Stale sprites stop *claiming new work* (no fresh ritual motion, no new stamps, no new light gate changes); they keep every primary attention mark. Selected copy says `Last observed 25s ago`, never `Idle 25s`.

**C2 — Action strip manifest contract** (producer: 2.1; consumers: 2.2, 2.3, 4.1)
```yaml
# per character entry in manifest.yaml, optional
actionStrip:
  path: characters/<id>/actions.png      # 8 columns × N rows of the engine cell
  cell: 92
  groups:                                 # named, never identified by frame count
    read:  { rows: [0, 3], hold: 3 }      # hold = most legible static frame for reduced motion
    wait:  { rows: [4, 4], hold: 4 }      # single held row
  grip:   { hand: 'right' | 'left' | 'both', sheathe: true }
  provenance: { characterId: '<pixellab id>', animationGroupId: '<id>', generationSize: 76 }
```
`SpriteSheet` resolves a `(group, direction, frame)` from the strip or returns `null`; `AgentSprite` falls back to the existing procedural overlay on `null`. Strips are loaded lazily per resident model through the existing `AssetManager` character demand path and never widen the base sheet. Material companions for strips are optional and follow the existing sidecar rules.

**C3 — Effect budget receipt** (producer: 0.2, after 0.1 supplies the measurements; consumers: every Wave 3 and Wave 4 GPU item)
```js
{ id: 'window-spill', levels: { FULL: 'on', REDUCED: 'direct-only', MINIMAL: 'off' },
  cost: { gpuMsBand: [0.4, 1.2], cpuMsBand: [0.05, 0.25], bytes: 331776 },   // measured with 0.1 before landing
  staticFallback: 'cached-doorstep-stamp', canvas: 'cached-doorstep-stamp' }
```
A plain constant table in `GpuWorldPolicy.js`; no render graph. The ladder sheds by declared order; Shift-D names what was shed and why. An effect without a measured band is not admitted.

**C4 — Inspection aperture** (producer: 4.1; input: the presence/signal/queue field split from 1.8; consumers: 4.2, 4.5)
```js
{ buildingType, slots: [{ agentId, tool, status, observation }], overflow: number, source: 'signal' | 'visit' }
```
Slots are a *presentation* of assigned/visiting sessions, never the sprite's physical position; the exterior sprite is not duplicated; `overflow` is an exact count. Opens only on explicit building selection at resting zoom ≥ 2.

**C5 — Shape grammar** (producer: 1.5; consumers: particles, marks, DOM pixel icons)
One authored 8×8 or 16×16 silhouette per event family — edit strike, read page, shell slate, message scroll, incident bracket, child return, release crown, stale seal, turn sand — registered once in `AgentPresentation.js` pixel icons and mirrored as Canvas stamps. No family shares a shape; colour is never the only difference.

**C6 — Ambient ownership** (producer: 5.1; consumers: 5.2, 5.4; 1.6 supplies the framing primitive Ambient reuses and does not depend on C6)
`camera.owner ∈ { 'user', 'auto', 'ambient', 'replay' }`; `ambient` is entered only by the explicit control, revoked by any genuine input, and never re-acquired on a timer. `auto` keeps today's behaviour untouched.

---

## Ballot — how the items were chosen

| Theme | Explorers proposing it independently | Verdict |
| --- | --- | --- |
| Interior reveal / threshold theatre / occupied rooms | buildings P1+P7, outside-eye P6, assets P5, chrome P6 | **Wave 4 headline**, one-building pilot |
| Authored action poses (hands, held wait) | characters P1+P4, assets P1+P2, signals P6 | **Wave 2 headline**, two-character pilot then roster |
| Light that belongs to the place (spill, wet reflection, dusk contract, palette ramps) | light P1/P2/P6, outside-eye P7, perf P7 | **Wave 3**, gated on Wave 0 receipts |
| Truth on the body (last-observed seal, turn sand, stable signatures) | signals P1/P2, characters P3/P6 | seal and sand **Wave 1**, signatures **Wave 2**; carried folios deferred (see Killed or deferred) |
| Composition and legibility (hold-to-read, quiet room, complete attention frame, shape grammar) | outside-eye P1/P3, camera P2, effects P1 | **Wave 1** |
| Shared-file knot / loom / bench | signals P4, outside-eye P5, chrome P1 | **Wave 4**, after an OMP `workingSet` producer (prerequisite 0.5) |
| Mine assay (cost velocity, token classes) | signals P3, buildings P3 | **Wave 4** |
| Truthful empty state (no version parade, sleeping town) | outside-eye P2, buildings P8 | **Wave 4**, one maintainer decision |
| Audio-visual score (shared cue score, BGM working section) | effects P2/P3/P10 | **Wave 5** |
| Ambient broadcast, incident chapter, spatial score / contact sheet | camera P1/P3/P5, outside-eye P4 | **Wave 5** |
| Per-pass timing, effect receipt, atlas accounting | perf P1/P2/P4 | **Wave 0**, prerequisite |
| Portrait crop / busts, atmosphere clock, exception shelf, building instrument | chrome P3/P5/P2/P6, assets P3 | Waves 1–2, S/M |

Full candidate lists including the ones not taken are in the ten notes.

---

## Wave 0 — Instruments before spectacle (all S/M, no visible change except Shift-D)

Nothing in this wave changes the village. It makes every later admission decision defensible and removes two small defects the round found.

### 0.1 Name every millisecond
**Owner:** `claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js:952–1023,1366–1383,1430–1478`, `WorldFrameRenderer.js:1428–1463`, `DebugOverlay.js` · **Size:** S/M · [`performance-envelope.md` P1](../research/claudeville-frontier-visual/performance-envelope.md)

**What the operator sees.** Shift-D lists `upload`, `occlusion`, `scene`, `bloom`, `present` with recent milliseconds, draw counts and bytes. The village is unchanged.

**Change.** Opt-in per-pass `EXT_disjoint_timer_query_webgl2` sampling that brackets one named pass per chosen frame in rotation, fixed-capacity result rings, disjoint samples discarded explicitly; the whole-frame timer stays the ladder authority. Canvas fallback shows CPU segments and labels GPU `unavailable`, never zero.

**Acceptance.** With `?sim=1&scenario=dense-24-agents` and Shift-D, five named passes report non-zero milliseconds within 10 s on the Metal renderer; enabling sampling changes the measured whole-frame GPU EMA by less than 0.1 ms over 30 s.

### 0.2 A budget receipt for each optional effect
**Owner:** `gpu/GpuWorldPolicy.js` (new constant table), `gpu/GpuWorldRenderer.js:1163–1272,1323–1410`, `postfx/PostFxLadder.js:208–329`, `scripts/tests/postfx-ladder.test.mjs` · **Size:** S/M · contract **C3** · [`performance-envelope.md` P2](../research/claudeville-frontier-visual/performance-envelope.md)

**Evidence.** REDUCED lowers light count and intensity but still pays both bloom draws (`GpuWorldRenderer.js:1275–1294`); levels are not equal slices of free time.

**Change.** The C3 table with the currently shipped optional effects as its first rows (occlusion, bloom, weather amplitude, cloud courses) so it lands with real consumers; shedding order and named reasons in diagnostics. No second ladder.

**Acceptance.** Forcing `setOverride(1)` and `(2)` sheds effects in the declared order; Shift-D prints the shed list; the unit test covers order and the MINIMAL default of no optional pass.

### 0.3 Atlas admission priced by active channels
**Owner:** `gpu/GpuWorldRenderer.js:844–949,1481–1497`, `gpu/GpuSceneBuilder.js:878–927,1128–1171`, `CanvasBudget.js:142–159` · **Size:** S · [`performance-envelope.md` P4](../research/claudeville-frontier-visual/performance-envelope.md)

**Evidence.** The 48 MiB cached-source cap excludes textures used this frame (`GpuWorldRenderer.js:928–949`); measured resident textures were 122–153 MiB with the four 2048² `world-pilot` channels alone at 64 MiB.

**Change.** Diagnostics separate pinned (this-frame) bytes from evictable bytes, price each uploaded channel by real texture dimensions, and list atlas pages and live body atlas size. No eviction policy change.

**Acceptance.** Shift-D shows pinned/evictable/total and the four `world-pilot` pages at 16 MiB each at 24 and at 100 agents.

### 0.4 Asset provenance ledger and PixelLab access
**Owner:** `claudeville/assets/sprites/manifest.yaml:60–577` (character entries, optional `provenance` fields), `scripts/sprites/generate-character-mcp.mjs`, `scripts/sprites/plan.mjs`, `scripts/sprites/manifest-validator.mjs`, `scripts/sprites/generate.md:83–97` · **Size:** S/M · [`asset-pipeline-and-pixellab.md` P7](../research/claudeville-frontier-visual/asset-pipeline-and-pixellab.md)

**Evidence.** Eleven of 24 character entries carry an unverified inherited 92 px generation size; PixelLab IDs live in comments (`manifest.yaml:513–515,568–570`); animations are identified by frame count (`generate.md:92`). During the round every MCP call returned `401 Missing Authorization` because this harness mounts the PixelLab MCP server without the bearer header (`.codex/config.toml` expects `PIXELLAB_TOKEN`); REST with the `.dev.vars` token works and reported **Tier 1: Pixel Apprentice, 1,403 / 2,000 generations remaining, resets Sep 9** (2026-09-05). `docs/pixellab-reference.md:14` still says Tier 3 / 10,000 and is stale.

**Change.** Named animation groups and optional provenance (`characterId`, `animationGroupId`, `generationSize`) in the manifest; validator accepts them; `plan.mjs` emits a production plan with exact direction jobs and generation counts against the **live** `GET /v2/balance`; `docs/pixellab-reference.md` tier paragraph corrected. **Prerequisite for Wave 2:** either add the bearer header to the omp MCP mount or run pilots through `scripts/sprites/pixellab-rest.mjs` (already token-aware); then a read-only inventory of the 24 source character records.

**Acceptance.** `npm run sprites:validate` passes with provenance on at least the three Wave 2 pilot characters; `node scripts/sprites/plan.mjs --ids=agent.claude.sonnet` prints direction jobs and generation cost for a named 4-frame group.

### 0.5 OMP working set and two chrome defects
**Owner:** `claudeville/adapters/omp.js` (new `workingSet` producer from real tool argument/result paths, verified against fixtures), new `scripts/adapters/fixtures/omp/`, `scripts/tests/working-set.test.mjs`; `claudeville/src/presentation/App.js` first-run World Controls tip (dismiss on `mode:changed`); `claudeville/src/presentation/character-mode/VillageDirector.js:221–248` · **Size:** S each · [`signal-to-visual-mapping.md`](../research/claudeville-frontier-visual/signal-to-visual-mapping.md) open questions; [`outside-eye` P2](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md); [`chrome` §Territory](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**Evidence.** The live roster during the round was 14 OMP / 2 Codex and OMP has no `workingSet` producer, so the Wave 4 shared-file items would be empty for this maintainer. The World Controls tip stays over Dashboard (`chrome-and-dom-instrument-08.jpg`, `outside-eye-07.jpg`). `triggerReleaseParadeOnceForVersion` synthesizes a Harbor *release* parade from the *dashboard's own* version, once per stored version key (`VillageDirector.js:221–235`); every fresh headless context therefore shows `PARADE v0.44` on an empty island, and the outside eye's point stands regardless of frequency: a dashboard update is not a repository release made by the operator's agents.

**Change.** OMP `workingSet` with `{path, op, at, source}` from verified fixture shapes; tip dismissal on mode switch; the version parade becomes **maintainer decision D1** below (default in this plan: remove the synthesized Harbor parade and keep version discovery in the existing changelog affordance; real release events and explicit simulator release metadata are untouched).

**Acceptance.** `node --test scripts/tests/working-set.test.mjs` covers an OMP fixture producing read/write entries; Dashboard capture shows no World tip; a fresh-context `no-agents` capture at hour 12 shows no `PARADE v0.44` unless D1 keeps it; `release-parade` still parades.

---

## Wave 1 — Read the village (no assets, S/M, every item asset-free and reduced-motion-static)

The default frame gets quieter; the truth already in the payload reaches the body.

### 1.1 The last-observed seal
**Owner:** `AgentSprite.js:6356–6364` (ritual gate), new pure resolver beside it, `IsometricRenderer.js:1697–1700`, `MarkGovernor.js:55–67`, `Agent.js:148–157` (read only) · **Size:** S/M · produces **C1** · [`signal-to-visual-mapping.md` P1](../research/claudeville-frontier-visual/signal-to-visual-mapping.md)

**Evidence.** `multi-provider-showcase` has an explicitly stale Ember (`WorldScenarios.js:1034`) that is embodied with the same confidence as fresh workers (`signal-to-visual-mapping-02.jpg`); freshness and `signalStale` reach `Agent.js:148–157` and nothing in the World consumes them.

**What the operator sees.** A stale worker keeps identity and every primary mark but stops fresh ritual motion and carries a small cut-corner slate seal (C5 shape); selected copy reads `Last observed 25s ago`. At dense load routine stale residents fold into a per-building `6 stale` count.

**Acceptance.** In `multi-provider-showcase` Ember carries the seal and no ritual motion; fresh agents do not; the selected panel header never says `Idle` for a stale observation. Canvas and GPU upper overlay match.

### 1.2 Turn sand, not a progress bar
**Owner:** `AgentSprite.js:6356–6364` (prop slot), `Agent.js:202–221` (read only), `VillageDirector.js:852–870` (optional age cohort) · **Size:** S · consumes **C1** · [`signal-to-visual-mapping.md` P2](../research/claudeville-frontier-visual/signal-to-visual-mapping.md)

**What the operator sees.** Beside the selected worker's tool prop a three-notch sand timer with `2m 18s`; unusually long current turns elsewhere get one static elapsed notch; a completed turn briefly leaves `Last turn 38s` only when `lastTurnDurationMs` was explicitly reported. Never an estimate of remaining time. Text updates on the shared 1 Hz cadence.

**Acceptance.** `one-working-agent` shows the timer on the selected agent within one second of `turnStartedAt`; an agent without `turnStartedAt` shows nothing; stale observation freezes the displayed value and adds the 1.1 seal.

### 1.3 Hold to read the village
**Owner:** `BuildingSprite.js:833` (label policy), `WorldFrameRenderer.js:710–714`, `IsometricRenderer.js:1836–1843` (key routing), one new World control in the existing controls cluster (integration pass) · **Size:** S · [`outside-eye-and-state-of-the-art.md` P1](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md)

**What the operator sees.** While the READ control is held (or its key, chosen after the key map is checked), `FORGE` reads `WRITING · 8`, `ARCHIVE` reads `READING · 3`, routine nameplates yield to short tool verbs from the canonical tool-to-building classifier; selected and action-needed agents keep names and reasons. Release restores everything without changing selection.

**Acceptance.** In the live capture recipe (`--live --eval "…hold…"`) the plaque text swaps for every building with occupants and the total of verb counts equals the working count in the top bar; no camera move; reduced motion identical.

### 1.4 A quiet room around the next decision
**Owner:** `WorldFrameRenderer.js:710–714` (overlay assembly), existing per-agent annotation governor, `VillageDirector.js:334` · **Size:** S · [`outside-eye-and-state-of-the-art.md` P3](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md)

**What the operator sees.** Entering decision focus via the existing attention command (`A`) or an explicit inspect keeps the chosen agent's body, name, reason and route, suppresses ordinary speech rectangles and duplicate routine names, and keeps building emblems, counts, and every unresolved primary mark. Leaving selection restores captions. No dimming of the screen.

**Acceptance.** In `waiting-on-user` after `A`, speech rectangles for non-selected agents are absent and every primary mark is present; in `dense-100-agents` the DOM counts are unchanged.

### 1.5 One event, one visible instrument
**Owner:** `AgentPresentation.js:220–242` (pixel icons), `ParticleSystem.js:128–171,500–545`, `AgentSprite.js:65–74`, `VillageDirectorOverlay.js:305–378`, `RitualConductor.js:434–455` · **Size:** M · produces **C5** · [`effects-particles-and-audio-sync.md` P1](../research/claudeville-frontier-visual/effects-particles-and-audio-sync.md); [`chrome` P8](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**Evidence.** Semantic presets default to AMBIENT admission (`ParticleSystem.js:520–524`); square sparkles and square ellipsis marks carry several meanings (`character-life-03.jpg`); Command/Tasks and Observatory/Watchtower share DOM silhouettes (`AgentPresentation.js:231`).

**What the operator sees.** A hammer's three slashes, a Mine's stair-step chip, a message scroll, an incident bracket, a child-return mote, and the 1.1 seal are distinct in monochrome; the same silhouettes appear as DOM icons; each district gets a unique 16 px seal.

**Acceptance.** A contact sheet (throwaway script) renders every C5 shape at 1× and 2×; no two families share a silhouette; `mixed-tools` capture at zoom 3 shows no square-sparkle mark on any event.

### 1.6 The complete attention frame
**Owner:** `CameraDirector.js:106–124,209–226,335–445`, `Camera.js:799–838`, `VillageDirector.js:374–388`, `VillageDirectorOverlay.js:717–727` · **Size:** M · [`camera-and-cinematography.md` P2](../research/claudeville-frontier-visual/camera-and-cinematography.md)

**Evidence.** Scene incidents are capped at six and cue deduplication keys on incident *count* (`VillageDirector.js:384,923–962`), so a seventh waiting agent or a same-count change can be silently omitted from the attention frame.

**What the operator sees.** The `A` frame is built from the *complete* live action-needed set ranked by real `awaitingSince`, fits padded sprite bounds against the usable viewport with a one-third bias only when inclusion survives, and says `3 waiting outside view →` when geometry cannot include them. Moves only on the explicit command; 5.1 later reuses this fit function under Ambient ownership.

**Acceptance.** A throwaway scenario with nine waiting agents spread across the island either frames all nine or reports the exact excluded count; the unit test for the fit function covers the no-fit case.

### 1.7 The atmosphere witness clock and the exception shelf
**Owner:** `TopBar.js:135–153,277–306`, `Sidebar.js:87`, `index.html:72–103`, `topbar.css:122–127`, `sidebar.css:41–56`, `AtmosphereState.js:1185–1204` (read only) · **Size:** S + M · integration-surface item, single owner · [`chrome-and-dom-instrument.md` P5, P2](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**What the operator sees.** `22:14 NIGHT` with a stepped weather glyph in the top bar, `SIM`/`FIXED` when overridden, so the light outside the window has a stated cause. A brass drawer on the Sidebar header: `2 NEED YOU · 1 ERROR` with the two oldest names and ages; click selects; hidden at zero.

**Acceptance.** Fixed-hour capture shows the matching clock and `FIXED`; `quota-rate-limit` shows the drawer with exact counts; no percentages; the top bar still fits at 1280 px.

### 1.8 One building instrument
**Owner:** `ActivityPanel.js:1060–1064,1146–1149,1631–1638`, `AgentPresentation.js:201–208`, `activity-panel.css` · **Size:** M · supplies the field split that **C4** formalizes in 4.1 · [`chrome-and-dom-instrument.md` P6](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**Evidence.** The selected Command panel shows `Occupants: none`, Purpose `0/11`, and Signal `2/5` at once (`chrome-and-dom-instrument-07.jpg`); these are different concepts presented as competing fractions.

**Change.** Inventory every displayed building field, assign each to presence, signal, queue, or purpose, render each once: a static seat row `VISITING 0 / 11`, a separate labelled `WORK SIGNAL 2 / 5`, one queue list. Unknown denominators are text-only.

**Acceptance.** No fact appears twice in the building panel; the same numbers appear in the 4.1 aperture header.

---

## Wave 2 — Bodies that work (the asset wave; pilot first, roster second)

### 2.1 Action strip pilot: reading hands and the held wait
**Owner:** `manifest.yaml` (two pilot entries + C2 schema), new `assets/sprites/characters/agent.claude.sonnet/actions.png` and `.../agent.codex.gpt6astra/actions.png`, `SpriteSheet.js:16–20`, `AssetManager.js:510–612,860–873`, `scripts/sprites/generate-character-mcp.mjs`, `scripts/sprites/author-roster-channels.mjs` · **Size:** M (pipeline) + 16 + 16 generations · produces **C2** · [`asset-pipeline-and-pixellab.md` P1, P2](../research/claudeville-frontier-visual/asset-pipeline-and-pixellab.md); [`character-life.md` P1, P4](../research/claudeville-frontier-visual/character-life.md)

**Change.** Two contrasting bodies (long-robed mage, compact armored engineer): a 4-frame `read` group (book into silhouette, glance, page turn, hold) and a single held `wait` row (one empty palm, tool parked), all eight directions, `keep_first_frame:false`, v3 custom animation, reviewed per direction for hand/hat occlusion. Material companions authored with the existing script. Strips are optional per C2.

**Acceptance.** `npm run sprites:audit-refresh` and `sprites:channels-validate` pass; a contact sheet shows both groups × 8 directions; missing strip on any other character leaves today's rendering byte-identical.

### 2.2 Hands that actually do the work
**Owner:** `ActionVocabulary.js:45`, `AgentSprite.js:2725–2821,6422`, `RitualConductor.js:27,478–486`, `AgentGpuOverlayRenderer.js:53–57`, `gpu/GpuSceneBuilder.js` body record (atlas slot for strip frames) · **Size:** L · consumes **C1, C2** · [`character-life.md` P1](../research/claudeville-frontier-visual/character-life.md)

**Evidence.** The final draw overwrites `animState` to idle/walk only (`AgentSprite.js:2725–2730`); the GPU overlay calls the generic action overlay and never the nine rituals (`AgentGpuOverlayRenderer.js:53–57`) — verify in a controlled live ritual cut in both backends before calling it a parity defect.

**What the operator sees.** A reading Sonnet opens the book between both hands; a waiting agent stops its work gesture and holds the palm out under the existing beacon; unsupported characters keep today's procedural prop. The procedural book and the wait question mark are removed for characters with a strip (one instrument per fact). Stale observation (C1) selects the hold frame.

**Acceptance.** `waiting-on-user` with Bellkeep on a strip character shows the held frame and no hammer/book; `one-working-agent` on Archive shows the read group; GPU and Canvas captures at zoom 3 match frame choice; `dense-100-agents` keeps compact bodies static.

### 2.3 Three things a waiting hand can hold
**Owner:** `Agent.js:141–154` (read only), `AgentSprite.js:6356–6373`, `VillageDirector.js:502–517` · **Size:** S · consumes **C2** hold row · [`signal-to-visual-mapping.md` P6](../research/claudeville-frontier-visual/signal-to-visual-mapping.md)

**What the operator sees.** The held palm carries an open letter (`question`), a closed command slip still awaiting its seal (`approval`), or an unrolled plan (`plan_review`) from `waitReason`; the slip is sealed only on an observed resolving lifecycle event, never while the wait is pending; unknown reason keeps the generic mark; never derived from elapsed time. Exact prompt text stays in the panel.

**Acceptance.** `multi-provider-showcase` Astra approval shows the slip; a question-wait fixture shows the letter; hook-less providers with null `waitReason` show the generic mark.

### 2.4 A hundred stable signatures
**Owner:** `AgentSprite.js:786–792,2671–2685,2732–2738,5038–5056,6584,6616`, `Compositor.js:59–112`, `ModelVisualIdentity.js:201` · **Size:** M · [`character-life.md` P3](../research/claudeville-frontier-visual/character-life.md)

**Evidence.** Four id-hashed palette variants and seeded animation phases already exist; compact GPU bodies at 28 px and Canvas impostor diamonds drop them (`character-life-06.jpg`).

**What the operator sees.** A bounded signature (four trims × eight clasp patterns, subordinate to model silhouette and team trim) that survives hero body → compact body → impostor diamond → selection, so the operator can follow one individual through zoom. Names remain authoritative; no random bits become mood or rank.

**Acceptance.** Zooming from 3 to 1 in `dense-100-agents` keeps a chosen agent's mark visible in compact mode and in the Canvas diamond; a unit test proves the signature index is a pure function of `id + family`.

### 2.5 The child returns as itself
**Owner:** `ArrivalDeparture.js:140–204,279–286`, `AgentSprite.js:6740–6751`, `Compositor.js:32,59` · **Size:** M · [`character-life.md` P5](../research/claudeville-frontier-visual/character-life.md)

**What the operator sees.** Dispatch and merge wisps carry a 12–16 px crop of the child's idle frame plus its 2.4 signature; on completion the same miniature returns to the parent, who takes one static receive beat; bursts fold to an exact child count under the existing max-eight admission. Neutral completion vocabulary — returned is not succeeded.

**Acceptance.** `parent-subagents` shows Scout's miniature on dispatch and return; eight simultaneous completions show one count, not eight portraits.

### 2.6 Portraits that look like the same person
**Owner:** `manifest.yaml` (optional `portrait` path), `AvatarCanvas.js:69–79,221–240`, `ActivityPanel.js:1775–1792`, `DashboardRenderer.js:990–995,1324–1341`, `activity-panel.css:82–123` · **Size:** M + 60 generations (pilot Astra, Sonnet, GLM at 64 px) · [`asset-pipeline-and-pixellab.md` P3](../research/claudeville-frontier-visual/asset-pipeline-and-pixellab.md); [`chrome` P3](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**Change.** Authored head-and-shoulders crop metadata for eligible sheets first (zero generations); PixelLab 64 px busts only for the three pilots after crop review; the existing full-body avatar stays as the small witness beside the name and as the fallback.

**Acceptance.** Selected Astra shows the same star-helm and violet collar at portrait scale; a look-alike bust is rejected in review; reduced motion identical (static).

### 2.7 Roster rollout decision
After 2.1–2.3 ship, the maintainer decides (**D2**) whether to roll the `read` and `wait` groups to all 24 sheets: 192 + 192 generations at four-frame v3, incremental albedo ≈ 1.0 MiB per strip, loaded lazily per resident model, memory priced by 0.3. Not automatic.

---

## Wave 3 — Light that belongs to the place (GPU; every item carries a C3 receipt)

Order within the wave is fixed: 3.1 frees energy before 3.2 and 3.3 spend it.

### 3.1 One dusk exposure contract
**Owner:** `AtmosphereState.js:1055–1118`, `BuildingSprite.js:1510–1542`, `NightOccupancyGate.js:8–38`, `gpu/GpuWorldRenderer.js:253–257,1203–1240,1296–1313`, `postfx/PostFx.js:149–167,801–849`, `IsometricRenderer.js:10292–10313` · **Size:** M · [`light-and-atmosphere.md` P6](../research/claudeville-frontier-visual/light-and-atmosphere.md)

**Evidence.** At dawn FULL the Lighthouse and Harbor become large soft yellow masses that rival the work (`light-and-atmosphere-02.jpg`); on the live night a roof halo outranks the clustered live work (`-05.jpg`, `-08.jpg`); dusk stacks several independently brightening boosts.

**What the operator sees.** As the sky cools, window cores read first, then a small spill and reflection; empty places settle; the Lighthouse stops being a diffuse competitor. Sunset reads as one deliberate scene. Bloom energy moves from broad halo to core and near receivers.

**Acceptance.** Forced-FULL captures at hours 17, 19, 21, 23 show monotonic core-first lighting; the 32-light cap, ladder budget, and resident texture bytes are unchanged; a Canvas time series shows the same envelope.

### 3.2 Rain borrows the lantern's color
**Owner:** `WorldFrameRenderer.js:464–479,626–630`, `gpu/GpuWorldRenderer.js:160–172,271–286`, `postfx/PostFxFeed.js:706–724`, `IsometricRenderer.js:10292–10313` · **Size:** M · receipt via **C3** · [`light-and-atmosphere.md` P2](../research/claudeville-frontier-visual/light-and-atmosphere.md)

**What the operator sees.** In rain, broken amber pixels of the real source colour lie below each admitted lantern or window on approved cobble/quay material, ending at dry timber, contracting with `_surfaceWetness` as rain stops. FULL eight reflected sources, REDUCED four, MINIMAL static wet darkening only. World-grid dither, no shimmer on pan.

**Acceptance.** `storm-night-reduced-motion` forced FULL shows reflections under Harbor lights only; measured 0.1 receipt under 0.45 ms GPU on the reference machine; Canvas shows the capped cached stamps.

### 3.3 Window light that reaches the street (pilot, conditional)
**Owner:** `gpu/GpuSceneBuilder.js:532–584`, `gpu/GpuWorldRenderer.js:134–150,271–295`, `LightSourceRegistry.js:3–35` (optional aperture descriptor), `IsometricRenderer.js:10292–10313` · **Size:** L · receipt via **C3**; gated on 0.1 evidence · [`light-and-atmosphere.md` P1](../research/claudeville-frontier-visual/light-and-atmosphere.md); [`performance-envelope.md` §Effect classes](../research/claudeville-frontier-visual/performance-envelope.md)

**What the operator sees.** One named window (Command pilot) throws a narrow amber patch across its doorstep that breaks at a low wall and steps onto the next cobble course; it goes dark when the last real worker leaves.

**Change.** A bounded 256×144 ground-receiver field (two RGBA8 targets ≈ 0.3 MiB), direct estimate plus **one** neighborhood hop, quantized to three warmth courses with world-locked ordered dither, cached until source/gate/occluder/camera bucket changes. FULL on; REDUCED direct-only; MINIMAL off. This is explicitly not radiance cascades and does not reopen that ruling.

**Acceptance.** Measured 0.1 receipt within `[0.4, 1.2]` ms GPU at FULL on the reference machine or the item is cut; `midnight-oil` forced FULL shows the patch only for the working building; A/B still against 3.1 judged by the maintainer.

### 3.4 The moon changes the night
**Owner:** `AtmosphereState.js:1085–1118,1237–1275`, `gpu/GpuWorldRenderer.js:189–215`, `gpu/GpuWorldPolicy.js:10–39,366–374`, `IsometricRenderer.js:10251–10278` · **Size:** S · [`light-and-atmosphere.md` P3](../research/claudeville-frontier-visual/light-and-atmosphere.md)

**Change.** One `moonFill` scalar from the already computed lunar illumination and cloud transmission selects two or three reviewed night ambient states, identical in resident, hybrid and Canvas; strictly night-only; minimum ground readability preserved.

**Acceptance.** Captures at hour 1 on a full-moon and a new-moon date differ by one reviewed palette course and both keep the waiting beacon as the brightest pool.

### 3.5 Light that stays inside its palette (pilot)
**Owner:** `gpu/GpuWorldRenderer.js:189–202,271–286`, `gpu/GpuSceneBuilder.js:113–143`, `MaterialRegistry.js` (optional lookup metadata), one authored ramp PNG · **Size:** M · receipt via **C3** · [`outside-eye-and-state-of-the-art.md` P7](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md)

**Change.** For Command's reviewed pilot masks, quantize admitted local-light contribution to authored dark/mid/light ramps per base colour via a nearest-sampled LUT instead of multiplying toward white; labels, identity, and attention marks excluded; absent table keeps today's response.

**Acceptance.** Side-by-side forced-FULL night stills at unchanged emitter intensity show slate staying slate and gold reaching an authored highlight; 0.1 receipt under 0.4 ms GPU.

---

## Wave 4 — The open door (buildings as instruments; the headline)

### 4.1 Open the workshop
**Owner:** `BuildingSprite.js:1727–1785` (split drawable), `:2126–2273` (functional overlay), `BuildingVisualRegistry.js:50–70`, `VillageDirector.js:1039–1087`, `gpu/GpuSceneBuilder.js:484–590`, new `assets/sprites/buildings/command/{aperture,interior,foreground}.png` + manifest entries, six `prop.interior.*` map objects · **Size:** L + ≈6 generations for the props + three hand-authored, reviewed Command layers (aperture, interior, foreground) at the existing sprite scale, which are artist labour, not API arithmetic · produces **C4** · [`living-buildings-and-terrain.md` P1](../research/claudeville-frontier-visual/living-buildings-and-terrain.md); [`outside-eye` P6](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md); [`asset-pipeline` P5](../research/claudeville-frontier-visual/asset-pipeline-and-pixellab.md)

**Evidence.** Roof fading was deliberately removed (`BuildingSprite.js:7`); selected-building routes and tool labels already exist for Command (`VillageDirector.js:1039–1087`, `building-inspection-replay`); the interior kit is cheap to generate and expensive to make truthful.

**What the operator sees.** Selecting Command at resting zoom ≥ 2 swaps its front wall for an authored sectional view: three desks, the real assigned sessions as identity tokens with their current tool (`spawn_agent`, `SendMessage`, `wait_agent`), a 2.2 action pose where the strip exists, and `+N more` for overflow. The exterior silhouette, footprint, door anchor, hit target, and pathfinding are unchanged; no sprite teleports or is duplicated; closing restores the exterior instantly. Reduced motion swaps immediately.

**Change.** Command pilot only. Forge second only after the pilot is judged at 2× and 3×; if it only reads at 3× it is cut (outside-eye's explicit kill criterion).

**Acceptance.** `building-inspection-replay` at zoom 2 and 3 shows the aperture with the same identities and counts as the 1.8 panel; `dense-100-agents` shows at most three slots and an exact overflow; GPU and Canvas render the same layers in the same order.

### 4.2 Occupied rooms, not uniformly glowing buildings
**Owner:** `BuildingVisualRegistry.js:63–66,148–151` (room slots), `BuildingSprite.js:2005–2008,4135–4145`, `NightOccupancyGate.js` (read only) · **Size:** M · consumes **C1, C4** · [`living-buildings-and-terrain.md` P7](../research/claudeville-frontier-visual/living-buildings-and-terrain.md)

**What the operator sees.** At night a selected Command or Archive assigns a stable window light per real working occupant; leaving work extinguishes only that room; a waiting agent is not a failed bulb; `2 working · 1 waiting` sits on the building. Never more lit windows than rooms in the art; overflow is the count.

**Acceptance.** `midnight-oil` shows exactly one lit room per working occupant on the selected building; unselected buildings keep the shipped aggregate gate.

### 4.3 The Mine assay bench
**Owner:** `LandmarkActivity.js:56–71,392–430`, `sessionPresentation.js:230–250` (read only), `Agent.js:116–118` (read only), `BuildingSprite.js:3025–3075,3157–3159`, `BuildingVisualRegistry.js:105–134` · **Size:** M · [`signal-to-visual-mapping.md` P3](../research/claudeville-frontier-visual/signal-to-visual-mapping.md); [`living-buildings` P3](../research/claudeville-frontier-visual/living-buildings-and-terrain.md)

**What the operator sees.** Beside the selected Mine, two shallow trays keep the last 60 s of dark fresh-input ore and pale cache-read crystal with `8,192 input · 32,768 cache read · observed last 60s`, and an assay rack of coin stamps — solid for provider-reported cost, hollow for estimate — with `~$0.42 / last min` for the selected project. Deltas only between consecutive fresh, same-provenance observations; discontinuities show `insufficient coverage`; Grok's context-only usage is excluded. This replaces the transient percent cargo label (one instrument per fact).

**Acceptance.** `cache-ore` shows two trays with counts matching the fixture deltas; a provenance flip from estimate to provider resets the window and shows the gap; no percentage anywhere.

### 4.4 The Forge has a workload and a result shelf
**Owner:** `LandmarkActivity.js:509–525`, `BuildingSprite.js:2300–2315,2886–2889,3987–4019`, `BuildingVisualRegistry.js:287–290`; result shelf: `codex.js:1296–1328`, `kimi.js:1189–1192`, `opencode.js:644–647`, `adapters/index.js:243–255` (bounded last-result summary on the list payload), `AgentEventStream.js:320–327` (new result family) · **Size:** M + M/L · [`living-buildings` P2](../research/claudeville-frontier-visual/living-buildings-and-terrain.md); [`signals` P5](../research/claudeville-frontier-visual/signal-to-visual-mapping.md); [`effects` P4](../research/claudeville-frontier-visual/effects-particles-and-audio-sync.md)

**What the operator sees.** A flurry of edit calls leaves three stepped billets by the anvil and a briefly fuller chimney; a long idle banks the hearth; inspection reads `12 edit calls · last 60s` (calls, not successful edits). Commands with a known exit place a stamped tile on a result shelf: intact `exit 0`, cracked `exit 1`, blank while unknown; selecting a tile opens the existing detail record. Never a stamp at invocation or at disappearance.

**Acceptance.** `mixed-tools` shows billets scaling with fixture edit calls; a Codex fixture with `toolExitCode: 1` shows a cracked tile and a Claude fixture (no exit data) shows none; particle bundles carry exact coalesced counts under the 240-particle pool.

### 4.5 The shared-file knot
**Owner:** `services/workingSet.js:37–96` (per-edge observation time), `RelationshipState.js:131–165` (overlap snapshot), `VillageDirector.js:852–870`, ground-cue seam per `character-mode/README.md:66`, `ActivityPanel.js:2229–2266` (bench tiles) · **Size:** M/L · depends on **0.5** · [`signals` P4](../research/claudeville-frontier-visual/signal-to-visual-mapping.md); [`outside-eye` P5](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md); [`chrome` P1](../research/claudeville-frontier-visual/chrome-and-dom-instrument.md)

**What the operator sees.** Selecting a writer reveals one short angular ground thread to one other writer and a double-pencil knot `2 writers · router.js`; read/write overlap is a single-pencil advisory; read/read stays silent; a dense project's Forge says `3 shared files`. The panel's working set becomes four file tiles with READ/WRITE and the overlap named on its tile. Copy says *recent shared file* unless explicit time overlap is established.

**Acceptance.** Two fixture agents writing the same path show the knot and the tile overlap; 100 agents never draw pairwise lines; OMP live sessions populate tiles after 0.5.

### 4.6 Between shifts: a truthful sleeping town
**Owner:** `VillageState.js:108–116` (read only), `BuildingSprite.js:2126–2273,3987–4019`, `BuildingVisualRegistry.js:50–280`, `HarborTraffic.js:161–197`, optional Forge `banked.png` · **Size:** M · [`living-buildings` P8](../research/claudeville-frontier-visual/living-buildings-and-terrain.md)

**What the operator sees.** On canonical `READY_EMPTY` only: the Forge banks to an ember, the crane rests, the slate shows an empty rack, work rooms are dark, the gate lantern stays. Real pending ships remain. `READY_NO_PROVIDERS` and `DEGRADED` never share this rest state.

**Acceptance.** `no-agents` capture at noon shows banked Forge and no work effects; a degraded-provider fixture shows the existing degraded treatment, not rest.

### 4.7 Task board tabs and readable masonry (S/M, optional in the wave)
`TaskboardBoardModel.js:29–109` + `BuildingSprite.js:3505–3508` for project-coloured plan tabs with `2/7` and `+9 plans`; `ChronicleMonuments.js:159–203` for a selected monument's low stone ledger with its last three real milestones and `+14 recorded`. [`living-buildings` P4, P5](../research/claudeville-frontier-visual/living-buildings-and-terrain.md). Acceptance: `team-gather` shows one tab per plan owner; selecting a Forge monument lists real `plantedAt` labels.

---

## Wave 5 — The village as broadcast (camera and score; after Waves 1–4 are release-verified)

### 5.1 Ambient mode: the working-village broadcast
**Owner:** `CameraDirector.js:270–304,335–445`, `Camera.js:273–334`, `VillageDirector.js:307–356`, `WorldFrameRenderer.js:744–755` (caption), one World control (integration pass) · **Size:** M · produces **C6** · [`camera-and-cinematography.md` P1](../research/claudeville-frontier-visual/camera-and-cinematography.md)

**What the operator sees.** An explicit Ambient control: wide shot of active districts → patient lateral move to the busiest real work cohort → an earned incident or handoff chapter → return to the wide; a factual caption `Forge · 4 working`; 18–30 s holds; never an empty building to fill time; any input revokes until Resume. Reduced motion holds one static overview with counts.

**Acceptance.** In `dense-24-agents` Ambient produces at most one move per 18 s and returns to the same wide within two chapters; a wheel event stops it and shows Resume; Auto mode behaviour is byte-identical to today.

### 5.2 A truthful incident chapter
**Owner:** `VillageDirector.js:370–418` (cue identity + caption), `CameraDirector.js:306–332`, `Camera.js:456–471`, `WorldFrameRenderer.js:937–960` (letterbox hold) · **Size:** M · consumes **C6** · [`camera` P3](../research/claudeville-frontier-visual/camera-and-cinematography.md)

**What the operator sees.** In Ambient only, a rejected push earns one Harbor/Watchtower shot, a 3 s held `Push failed · pharos-watch` caption after settling, and a return to the saved wide if the input epoch is unchanged; active operators see only the existing edge cue. Concurrent incidents coalesce to one chapter with an exact count.

**Acceptance.** `failed-push` in Ambient shows exactly one chapter and returns; outside Ambient the camera never moves.

### 5.3 Shared cue score and the working section
**Owner:** `shared/audio/cues/CueKit.js:121–228,244–252`, `CueGovernor.js:180–221`, `ArrivalDeparture.js:200–202`, `VillageDirectorOverlay.js:353–378`, `BgmDirector.js:32–47,145–149`, `bgm/BgmPlayer.js:119–207`, `AmbientAudioController.js:134–136,551–562` · **Size:** M + M · [`effects` P2, P3, P10](../research/claudeville-frontier-visual/effects-particles-and-audio-sync.md)

**What the operator sees / hears.** Visual accents land on the cue's actual scheduled note times (recovery bracket on the first bell, foot rune on the second arrival note, council notches per gathered member); silent users get the same static end marks. BGM arrangement thins at the next four-bar boundary when the village rests and adds the counter-line when work resumes, with a static `Working 7 · Waiting 2` label beside the music control. Music never replaces visible counts.

**Acceptance.** A throwaway harness logs cue scheduled time vs accent draw frame within one frame; `team-gather` shows one notch per member; with sound off every accent still appears.

### 5.4 Work as a spatial score
**Owner:** extract the pure waterfall builder from `shared/ActivityPanel.js:418–469` into a shared pure model and migrate its consumer; `VillageDirector.js:206–218,323–343`; `WorldFrameRenderer.js:764–770` (insertion seam at the start of `drawGroundSemantics`); new `character-mode/SpatialWorkScore.js` + a small DOM timeline · **Size:** L · consumes **C6** (`replay` owner) · [`outside-eye` P4](../research/claudeville-frontier-visual/outside-eye-and-state-of-the-art.md); [`camera` P5, P8](../research/claudeville-frontier-visual/camera-and-cinematography.md)

**What the operator sees.** On request the selected run's last 20 minutes become a badged historical diagram: capped tool glyphs at their semantic buildings, a scrubbable cursor, long approval intervals as long empty brackets, children beside their real parent, unknown time as gaps. `REPLAY` is unmistakable, `LIVE` is one action away, and physical positions are drawn only where real replay samples exist.

**Acceptance.** Scrubbing never mutates domain state; exact/inferred labels match the panel waterfall; at most 24 visible nodes with an exact overflow count.

---

## Killed or deferred on the evidence

| Proposal | Ruling | Reason |
| --- | --- | --- |
| **WebGPU, OffscreenCanvas worker, radiance cascades, per-sprite normal maps** | Remain rejected | No OF-007/OF-008 trigger measured; no normal channel in the contract; 3.3 is a bounded one-hop field, not a GI engine. |
| **CRT/phosphor pass, optical tilt-shift/DOF, stepped blur "loophole"** | Killed | Recolour authored pixels or erase sprite/text information exactly where the outlier sits (outside-eye §survey 6–7; camera §Rejected). |
| **Distant shore, parallax skyline, bigger island, seasonal terrain rebake** | Killed | Maintainer cut the shore; no data behind it; terrain reserve margin is 440 k pixels. |
| **Sleep on idle, celebrate on tool stop, test-pass dance, fake fatigue, barks, moods** | Killed | Invented flavour; completion ≠ success; mood is already telemetry-derived. |
| **Umbrellas, lanterns, rain-soaked or seasonal outfits for the roster** | Killed | 480–1,344 generations for decoration that hides identity silhouettes. |
| **Token throughput as walking speed; idle-since as personal dusk; provider outage as local rain; red sky on error** | Killed | Promote observer artefacts or local state to false world conditions. |
| **Camera shake, automatic smash cuts, constant tours, World→Dashboard morph, permanent minimap** | Killed | Camera theft, disorientation, or resurrected chrome without new meaning; 5.1/5.2 are explicit-mode only. |
| **Third typeface, PixelLab font, bright parchment skins, UI panel packs** | Killed | Two-face rule; decoration without information. |
| **All-roster pro animations by default** | Killed | 3,840–7,680 generations per sequence; v3 four-frame is 192. |
| **Whole-day time-lapse from Chronicle** | Killed | No historical positions or environment; 5.4 is an event diagram, never a movie. |
| **Ladder retuning from this round's captures** | Deferred | Loaded-host evidence only; measure isolated after 0.1 before any policy change. |
| **Context-window backpack / second pressure ring; token heat plume as a shader** | Deferred | One instrument per fact: pressure has a gauge; a plume is admissible only as the C5 stepped mark replacing token motes. |
| **Desire-path road wear, bridge-lantern notches, chronicle index margin, observation tape** | Deferred (S/M, after Wave 4) | Valid, lower value per hour; retained in the notes. |
| **Working set as carried folios on the body** | Deferred (M, after 4.5) | Valid ([`character-life` P2](../research/claudeville-frontier-visual/character-life.md)); the same fact already gets a DOM bench and a ground knot in 4.5, and the belt slot is reserved for the 2.2 grip policy first. |

---

## Maintainer decisions requested

- **D1** Remove or keep the dashboard-version Harbor parade (0.5). Current behaviour already fires it once per stored version; the question is whether a ClaudeVille update should look like a repository release at all. Default in this plan: remove and rely on the changelog affordance.
- **D2** Roll the `read` (four rows) and `wait` (one held row) groups to the full roster after the 2.1 pilot: 192 + 192 generations (fits the verified 1,403 remaining Tier 1 generations alongside the 32-generation pilot); retained albedo ≈ 31 MiB (24.8 read + 6.2 wait), ≈ 124 MiB with all four channels; residency is bounded per resident model by lazy loading and must be priced by 0.3 before approval.
- **D3** Interior pilot building: Command (this plan's default; richest selected-building data) or Forge (strongest Moonlighter/Eastward read).
- **D4** Accept a reduced Lighthouse/Harbor halo radius under 3.1 while keeping their semantics.
- **D5** Ambient as a separate explicit mode beside Auto (this plan's default) rather than a change to Auto's timers.

---

## Sequencing, ownership and parallelism

File ownership is the only real constraint in a shared checkout. Parallel groups below are disjoint by file; anything sharing `GpuWorldRenderer.js`, `AgentSprite.js`, `BuildingSprite.js`/`BuildingVisualRegistry.js`, `WorldFrameRenderer.js`, `CameraDirector.js`, or `VillageDirector.js` is serialized under one named owner per wave. `App.js`, `index.html`, `css/**` get one integration pass per wave.

- **Wave 0** — one GPU-diagnostics owner runs 0.1 → 0.2 → 0.3 serially (all touch `GpuWorldRenderer.js`; 0.2's measured bands come from 0.1). In parallel: 0.4 (sprite scripts/manifest) and 0.5 as three workers (`omp.js` + fixtures; `App.js` tip; `VillageDirector.js` parade per D1).
- **Wave 1** — 1.5 first (C5 shape table), then 1.1 (C1, adds its seal row to the table). Then in parallel: 1.2 (`AgentSprite` prop slot), one `WorldFrameRenderer`/`BuildingSprite` label owner running 1.3 → 1.4 serially, 1.6 (`CameraDirector`/`Camera`), 1.7 (integration owner for `TopBar`/`Sidebar`/`index.html`/`css`), 1.8 (`ActivityPanel`).
- **Wave 2** — 2.1 alone (asset + C2). Then one `AgentSprite` owner runs 2.2 → 2.3 → 2.4 → 2.5 serially (2.3 needs the hold row; 2.5 needs 2.4's signature); 2.6 (DOM avatar/portrait) in parallel.
- **Wave 3** — one renderer owner, strictly serial: 3.1 → 3.4 → 3.2 → 3.5 → 3.3; every item lands its C3 row and its 0.1 measurement before the next starts. 3.3 starts only if the 3.2 and 3.5 receipts leave its declared band available.
- **Wave 4** — 4.1 first (C4, owns `BuildingSprite`/`BuildingVisualRegistry`/`GpuSceneBuilder` building records). Then the same building owner runs 4.2 → 4.6 → 4.3 → 4.4-building → 4.7 serially; in parallel and file-disjoint: 4.4-adapters (`codex.js`, `kimi.js`, `opencode.js`, `adapters/index.js`, `AgentEventStream.js`) and 4.5 (`workingSet.js`, `RelationshipState.js`, ground-cue seam, `ActivityPanel` bench) which also waits on 0.5.
- **Wave 5** — 5.1 first (C6). Then one camera/director owner runs 5.2 → 5.4 serially (both touch `VillageDirector.js`; 5.4 also touches `WorldFrameRenderer.js`); 5.3 (audio) in parallel.
- Each wave ends with one serialized integration pass and `npm run validate:quick`; release names are the maintainer's, hotfix tiers per `AGENTS.md`.

---

## Verification matrix

| Change | Command / evidence | Expected |
| --- | --- | --- |
| Any World item | `node agents/research/claudeville-frontier-visual/tools/capture.mjs …` at the scenario named in the item's acceptance, forced FULL where light matters | The stated frame; GPU and `?renderer=canvas` parity for meaning |
| Any `src/` change | `npm run verify:render` | exit 0, artifact directory, no console errors |
| Pure models (C1 resolver, fit function, signature index, budget table, cost window) | `node --test scripts/tests/<item>.test.mjs` | behaviour, boundaries, and the no-data cases |
| GPU items | 0.1 Shift-D pass timings on an isolated foreground run at 60 Hz and 120 Hz | within the item's C3 band; 32-light cap and texture bytes unchanged unless offset |
| Assets | `npm run sprites:audit-refresh`, `sprites:channels-validate`, contact sheet, `sprites:capture-fresh` + `sprites:visual-diff` | manifest parity; missing strip byte-identical |
| Adapters (0.5, 4.4) | `npm run verify:server`, fixture tests | OMP working set and exit codes from fixtures only |
| Buildings/config | `npm run world:validate-buildings`, `world:validate-terrain` | unchanged footprints |
| Structure/docs | `npm run verify:architecture`, `npm run check:artifacts` | root-doc parity, artifact index consistent |
| Each wave | `npm run validate:quick`; release: `npm run gate:release` and the OF-006 soak | green |

---

## Definition of done

- A stale worker, a waiting worker, a reading worker, and a working worker are distinguishable by body alone at zoom 2 with labels hidden; none of them lies about outcome.
- Selecting Command opens a truthful interior whose identities and counts equal the panel's; closing restores the exterior exactly.
- At night, light is motivated: cores first, spill and wet reflection only from admitted real sources, halos no longer outrank work; every optional effect has a measured receipt and a named shed reason.
- Hold-to-read turns the village into a work map and releases to the same calm frame; the attention frame never silently omits a waiting agent.
- Ambient mode never takes the camera from an operator who touched it.
- 120 Hz slack at FULL with 24 agents is not worse than baseline and 100 agents still reach MINIMAL within 5 s on the reference machine; resident texture bytes do not grow without an offset.
- `README.md`, `claudeville/CLAUDE.md`, `character-mode/README.md`, `docs/material-channel-contract.md` (C2/C3), `agents/README.md`, and `open-followups.md` say what the code does.
