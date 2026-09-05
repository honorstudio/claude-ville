## Territory and method

Read-only research into buildings, their grounds, water, Harbor traffic, and durable village memory. No renderer, asset, provider, or configuration changes were made. No server lifecycle, validation, test, formatter, or generation commands were run. Proposed costs below are engineering estimates, not measurements.

Files read (ranges relevant to this territory): `AGENTS.md`; `agents/README.md`; `claudeville/CLAUDE.md`; the character-mode, dashboard-mode, and shared `README.md` files; `docs/building-style-contract.md`; `docs/material-channel-contract.md`; `docs/motion-budget.md`; `docs/visual-experience-crafting.md`; `docs/world-visual-qa-checklist.md`; `docs/rendering-baselines.md`; `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md`; `agents/claudeville-astra-refinement-plan.md`; `claudeville/src/config/{buildings,townPlan,scenery}.js`; `claudeville/src/presentation/character-mode/{BuildingSprite,BuildingVisualRegistry,SceneryEngine,TerrainTileset,HarborTraffic,BridgeLanterns,LandmarkActivity,ChronicleMonuments,TaskboardBoardModel,VillageDirector,TrailRenderer,AtmosphereState,IsometricRenderer}.js`; `claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js`; `claudeville/src/application/{MonumentRules,VillageState}.js`; and token-count declarations in `claudeville/src/domain/value-objects/TokenUsage.js`. Narrow searches also checked `claudeville/adapters/gitEvents.js` and `claudeville/src/presentation/shared/GitEventIdentity.js` for diff-stat fields.

All eight retained JPEGs below were opened and visually inspected. Paths are relative to the repository root. Each capture used the maintained `http://localhost:4000` simulator, 1920×1080, clear weather, and 12,000 ms post-setup wait. Every helper result identified `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and returned an empty console-error list. Captures ran concurrently with other explorers: this is visual evidence, not a performance benchmark. The original helper reported null hour/quality diagnostics. After the coordinator corrected its camera and diagnostic fields, 07/08 were recaptured into their existing paths: both confirmed `worldRendererMode: webgl`, quality level 0, `within-budget`, zoom 2, hour 14 and clear weather. No claim about the first six quality levels is made.

| Capture | Scenario / requested hour | What it actually shows |
|---|---|---|
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-01.jpg` | building-inspection-replay / 14 | Command-selected fixture, three sessions, replay indication, broad southern village framing. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-02.jpg` | git-harbor / 14 | Harbor detail, Mariner doing `git pull --ff-only`, cranes, quay, water props; no pending commits in sidebar at this cut. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-03.jpg` | release-parade / 18 | Harbor detail with `PARADE V0.12.0` banner and Banneret's tag/push command. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-04.jpg` | quota-rate-limit / 14 | Mine-side rate-limit scenario; Gauge at the gateway, Mine visible, broad framing. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-05.jpg` | cache-ore / 14 | Three cache-mix agents clustered near Forge, not an isolated Mine cargo close-up. Useful evidence of discoverability, not proof of cargo animation parity. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-06.jpg` | no-agents / 12 | Empty eastern village: calm water, lit Forge, blank Tasks slate, `VILLAGE READY`, no agents. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-07.jpg` | building-inspection-replay / 14 | Explicit `villageDirector.setSelectedBuilding(world.buildings.get('command'))`; Command fills the center with readable tool annotations and visitors outside. Corrected helper confirmed zoom 2 and hour 14. |
| `agents/research/claudeville-frontier-visual/shots/living-buildings-and-terrain-08.jpg` | quota-rate-limit / 14 | Explicit Mine selection through the same API; close view of the mountain, cyan seams, cart/rails and rate-limited Gauge near the gateway. Corrected helper confirmed zoom 2 and hour 14. |

Selection is grounded in the fixture metadata (`WorldScenarios.js:799–801,914–917`) and explicit calls in 07/08. A transient syntax error during the coordinator's capture-helper edit produced no extra JPEG; retry succeeded. Initial 07/08 camera attempts were overridden by the opening glide; after the coordinator's correction, replacement captures held the requested pose and were visually inspected again. Browser inspection additionally confirmed real atmosphere clock fields; it did not exercise or change the operator's real session feed.

## Current state

The village already has considerably more semantic animation than a first still suggests. The frontier is **less additional decoration, more physically legible state and inspectable meaning**.

For compact anchors in the table, **B** means `claudeville/src/presentation/character-mode/BuildingSprite.js`, **V** means `.../BuildingVisualRegistry.js`, **L** means `.../LandmarkActivity.js`, **D** means `.../VillageDirector.js`, and **Defs** means `claudeville/src/config/buildings.js`. The prefixes expand to these exact paths throughout this note.

Shared across all nine buildings: occupancy is count/capacity with presence fallback (B:4180–4189), low-zoom status tally chips exist (B:58–62,1170–1173), windows have authored local rectangles (V:50–280), and activity combines occupancy, recency and ritual fade (B:4193–4232). Actual spatial visitors are counted against building visits, not simply all working sessions (L:612–631). Director signals include occupied/working/waiting/errored counts and the last four tool labels within 25 seconds (D:1006–1056); selected-building routes expose agent ID/name/status and endpoints (D:1059–1087). These Director signals are an inspection layer, not evidence that every field independently changes building art.

“Unused” below means a proposed unused *representation at that building*, not a claim that the field is unused everywhere in the application.

| Building / semantic meaning | Already-rendered real signals and physical responses | Potential signal not yet represented this way |
|---|---|---|
| Command — team status (Defs:72–82) | Fleet working count contributes activity; command rituals and details render together (B:2266–2269,3648–3651,3708–3711). Parent/child dispatch and SendMessage links exist (L:435–499). Occupancy pennant uses dominant repo color, not generic decoration (B:1790–1828; V:63–69). Manifest watchfire is an emissive source (V:14–17). Shared D counts/recentTools/routes apply. | Simultaneous occupant identities and tools in an inspectable, spatially stable interior rather than anonymous activity marks; D:1046–1050 and routes:1072–1080 provide the join. |
| Tasks — task status (Defs:105–115) | Selected/pinned-preferred agent's real `todos` wins; fallback is most recently changed/active list (`TaskboardBoardModel.js:29–67,77–89`). Full-list done/total and phase grouping already exist (:111–158). Papers track rituals (B:2318–2421), questPing emitter (V:307–309), two lantern windows/pennant (V:71–87). Shared D signals apply. | Other concurrent task-list owners are hidden by the single resolved agent; expose list ownership/counts, not another progress bar. |
| Forge — code work (Defs:138–148) | Ritual presence drives furnace heat with decay, not exact edit throughput (B:2300–2315). Occupancy/intensity drives activity marks (B:2886–2889). Ember, sparks, chimney smoke already exist (V:287–290), with presence/heat/beacon/wind modulation (B:3987–4019). Forge→Tasks handoff already exists (L:530–562). Shared D signals apply. | A bounded rolling count of observed edit invocations, distinguished from presence and from verified successful edits; no verified line-change magnitude is established here. |
| Mine — token usage (Defs:169–179) | Input/output/cache classes contribute token deltas (L:56–70). Delta >=256 emits `__token_delta` with cargo; smaller admitted deltas create token items (L:392–430). Fresh-input ore versus cache-read crystal mixing exists, including cumulative fallback provenance (L:89–113; B:3025–3075). Quota reserve is explicitly gated on availability (B:3157–3159,3929–3944); seam tint/rails/cart/dust exist (B:2159–2213; V:292–295). Shared D signals apply. | Exact recent input/cache counts retained long enough to inspect beside the Mine, rather than inferring a ratio from fleeting cargo. Reset/unavailable states need distinct appearance. |
| Archive — reading/search (Defs:200–210) | Read/Grep/Glob/LS increment a deduplicated decaying shelf-intensity counter (L:24–28,356–389). Door spill and motes follow read intensity (B:1566–1569,2752–2755,2821–2824,4003–4015). Authored window niches and repo pennant (V:135–152). Shared D signals apply. | Separate simultaneous reader/searcher occupancy and current tool at visible desks; exact recent invocation count rather than an intensity-only shelf. |
| Observatory — external research / skywatch (Defs:233–243) | Real clock hands (B:2507–2579), WebFetch/WebSearch/web.run ritual spin (B:118–122,586–604), night aperture and ritual-end burst (B:546–580; V:182–188), windows/pennant (V:154–170). Shared D signals apply. | The specific currently researching sessions/tools within the structure. Do not call the existing ritual disappearance burst a verified successful web result: B:546–560 observes ritual disappearance. |
| Portal — browser / remote tools (Defs:264–274) | Visitor and ritual boosts, rune aperture, rings (B:2215–2242); tool classification supplies portal reason (B:3448–3452), browser-like active screen exists (B:3462–3465); rune/sparkle emitters (V:296–298), violet window/door spill and pennant (V:191–220). Shared D signals apply. | Simultaneous local/remote tool identities rendered as stable inspection bays, not further anonymous orbiters or invented destinations. |
| Lighthouse (`watchtower`) — sea watch / beacon (Defs:295–305) | Working count and failed push brighten beacon (B:1496–1505). Fleet distress changes searchlight rotation/color; reduced motion keeps a wedge (B:610–632,3807–3811). Flame/mote and windows/pennant are authored (V:222–248,300–302). Shared D signals apply. | Exact distressed-session composition near the lighthouse rather than requiring an operator to decode beam speed; preserve rate-limited versus errored distinction instead of D's combined errored bucket (D:1015). |
| Harbor — commit ships / push departures (Defs:323–333) | Office activity/failed push marks (B:2631–2634,2703–2706), smoke/sparkle/windows (V:256–280,303–305). Real git-event traffic has lifecycle states, exact commit pack badges and per-repo home anchorages (`HarborTraffic.js:24–74,161–197,1563–1569`); label ledger sorts pending commits (B:4596–4599). Bridge lanterns already rank pending branches by oldest commit, capped six (`BridgeLanterns.js:74–105`). Shared D signals apply. | Exact selected branch age and ownership made visible in daylight on its physical lantern; manifest inspection of current real commit cargo, not a second ship system. Diff-sized cargo is not currently grounded by a discovered field. |

**Ground, memory and the existing town.** Town roads are authored semantic district connections, not generated from telemetry (`townPlan.js:44–99`). Scenery holds explicit water/deep-water/shore/bridge and foliage maps and building clearances (`SceneryEngine.js:29–49,106–128`). Terrain Wang masks have deterministic interior mirroring to reduce repetition (`TerrainTileset.js:18–62`). Real historic movement samples already exist with tile coordinates/time (`TrailRenderer.js:279–299`), but ordinary historical trails are intentionally invisible to avoid webbing over the village (:351–355). Chronicle monuments already persist repository milestones, classify conventional commit kinds, cap each district at six, and celebrate lifetime 1/10/100/1000 counts (`MonumentRules.js:1–32,123–160`; `ChronicleMonuments.js:159–203,613–647`). Adding generic milestone stones, repo pennants, cache ore, or pending-commit ships would therefore re-propose shipped work.

**Art-director judgment from the actual captures:**

- Harbor is the best miniature: piles, hanging crane, roof mass and warm timber create believable inhabitable scale (02/03). Water beside it is weaker: broad straight-edged turquoise/deep-blue tile changes read as a board-game boundary, and the large yellow oval over the quay reads more like an effect than a physical room. Keep the building; make semantics live *inside* its existing architecture.
- The blue-roof family, bridge timber and stone footings hold the place together beautifully (01/06). The repeated bright willow crowns, crates, cyan steles and dirt texture compete at almost every ground patch. A new garden everywhere would worsen this, not enrich it (06).
- Command inspection is intellectually rich but physically indirect: the tiny tool labels are easier to identify as annotations than as work happening in a place (07). Occupants still look like visitors outside the building. The opportunity is a selected building becoming a readable miniature workspace.
- The cache-ore still does not teach cache semantics: three agents occupy the Forge area, while Mine is outside the focal crop and its short-lived cargo cannot be compared (05). This is not proof the implementation is absent; the source shows it exists. The next step should make its meaning inspectable, not amplify another burst.
- The empty town is **not a broken product**: `VILLAGE READY`, intentional masonry, open water and coherent roads make it feel available (06). But it is not convincingly sleeping either: Forge is blazing, Harbor carries `PARADE V0.44`, decorative carts/crates remain, and there is little physical difference between quiet and occupied structures (compare 05/06). The scene currently says “elaborate display with nobody in it,” rather than “a workspace at rest.” The persisted-looking parade label in unrelated fixtures is an observation, not a diagnosed persistence bug.

## Proposals

All proposals retain zero build/dependencies, authored pixel edges, existing Canvas/GPU drawable seams, and the maintained >=1280px desktop target. Counts are exact where displayed; physical tiers are accompanied by counts on inspection. CPU/GPU estimates refer to incremental work at 1920×1080, not total frame time. No proposal requires WebGPU, OffscreenCanvas or a new full-screen effect pass.

### P1 — Open the workshop, not another panel

- **Pitch:** Selecting one landmark reveals a sharply cut miniature interior whose workstations identify the real sessions and tools currently assigned there.
- **What the operator sees:** Command's front wall switches to an authored sectional view: three desks, three existing session identity tokens, `spawn_agent`, `SendMessage`, `wait_agent`; the exterior remains intact elsewhere. At Harbor the same inspection grammar shows real branch cargo manifests instead of desks. No agents teleport or duplicate their world positions: the tokens are explicitly an inspection representation.
- **Real data it renders:** `selectedBuildingSignal.type`, `routes[].agentId/status`, `world.agents.get(id).currentTool`, and `recentTools[].label/ts` (D:1039–1087; L:134–136). Distinguish “assigned here” from physically visiting via existing visit counts (L:612–629).
- **Files touched:** B:1727–1776 (split drawable), B:2126–2273 (functional overlay); V:50–70 (authored sectional profile); D:1059–1087 (selected representation); new `assets/sprites/buildings/command/interior.png` plus its manifest entry; later other buildings only after a Command pilot.
- **Sketch:**
  1. Resolve one selected building and a stable, ID-sorted occupant snapshot on semantic updates.
  2. Author a true isometric floor/interior, preserving original sprite dimensions and footings.
  3. Replace only the selected front/roof slice with the sectional sprite; do not alpha-fade the whole landmark.
  4. Place at most six inspectable identity/tool tiles at calibrated desks; add an exact `+N assigned` count.
  5. Clicking a tile delegates to existing agent selection; deselection restores exterior.
  6. At low zoom keep exterior plus existing count; reveal only at explicit detail zoom.
  7. Static band; optional one-shot stepped reveal, never a continuous selection pulse.
  8. Reduced motion swaps immediately; Canvas and GPU use the same authored images and ordering.
- **Cost:** L; approximately 0.05–0.20 ms CPU and 0.05–0.15 ms GPU for one open building; one 346×230 RGBA layer about 0.30 MiB before atlas overhead, under 1 MiB for a pilot. Asset generation yes: one sectioned Command interior, manually reviewed against the exterior.
- **Risk:** This deliberately revisits the prior no-roof-fade decision (B:7), but is a selected-only mode rather than passive transparency. Authoring believable interiors is expensive; at 100 agents cap six tiles and expose overflow, never six actors per building. Must not imply semantic assignments are actual physical positions or that ritual expiry proves success.
- **Wow 1–5 / Informative 1–5:** **5 / 5.** Wow: the miniature opens as a real instrument. Informative: it answers who is doing what here without moving the operator away from the place.

### P2 — The Forge has a workload, not just a heartbeat

- **Pitch:** Replace presence-like furnace modulation with a legible, bounded rolling count of observed edit activity.
- **What the operator sees:** A short burst of edits leaves three bright stepped billets beside the anvil and a briefly fuller chimney; a long idle keeps a small banked hearth, not the same busy orange mouth. Inspection reads `12 edit calls · last 60s`.
- **Real data it renders:** Deduplicated `tool:invoked` events routed to Forge, using tool name, `agentId`, event timestamp and invocation identity; Director already retains recent tool events (D:1026–1050). These are **observed edit calls**, not successful edits, lines changed, productivity, or code quality. Existing Forge ritual heat is B:2300–2315.
- **Files touched:** L:509–525 (observed work), B:2300–2315 (heat target), B:2886–2889 and 3987–4019 (marks/emitter density), V:287–290 (existing anchors).
- **Sketch:**
  1. Count actual classified edit/write invocations in a fixed 60-bucket one-second ring.
  2. Use stable source invocation identity where available; do not count every held snapshot.
  3. Derive three palette tiers at documented count thresholds; exact count is inspectable.
  4. Reuse existing smoke/ember emitters with a hard particle admission cap.
  5. Replace, rather than stack with, the old heat-driven billet cue.
  6. Keep error/approval signals separate; high throughput never overrides them.
  7. Claim one-shot fast burst only on a new count tier; steady heat is static.
  8. Reduced motion shows banked/medium/hot sprite marks; Canvas gets identical marks.
- **Cost:** M; <0.05 ms CPU per frame with event-driven accumulation; capped existing particle GPU cost, target <0.10 ms incremental; <8 KiB counters/state. Asset generation no, optional three hand-authored billet stamps.
- **Risk:** Invocation duplication is the primary correctness risk. No inferred completion. At 100 agents aggregate counts at one Forge, not one smoke column per session. Restrict thresholds from turning a busy workload into a permanent visual alarm.
- **Wow 1–5 / Informative 1–5:** **4 / 4.** Wow: the workshop visibly cools after a real flurry. Informative: distinguishes an occupied building from one seeing sustained observed edits.

### P3 — A Mine assay bench with a readable memory

- **Pitch:** Give the existing cache-ore cargo an inspection bench showing the actual recent token classes after its cart has passed.
- **What the operator sees:** Two shallow trays beside the selected Mine hold dark fresh-input ore and pale cache-read crystals; attached slate reads `8,192 input` and `32,768 cache read`, with a small `observed last 60s` label. A missing class is marked unknown, never an empty tray labeled zero.
- **Real data it renders:** `tokens.input`, `tokens.cacheRead`, `tokens.availability`; positive, non-reset deltas and cargo provenance already computed in L:65–113,392–412. Other token classes remain in the total ledger but are not mislabeled as input/cache.
- **Files touched:** L:392–430 (retain bounded exact class sums); B:3025–3075 and 3157–3159 (reuse cargo shapes, availability discipline); V:105–134 (bench anchor).
- **Sketch:**
  1. Retain rolling exact deltas for input/cache-read in 60 one-second buckets.
  2. Exclude first observations and counter resets; record coverage start separately.
  3. Never convert the cumulative-ratio fallback into a claimed recent delta.
  4. On Mine selection, draw two small trays with quantized fill and exact count text.
  5. Reuse current ore/crystal colors and cargo stamps; do not recolor the whole mountain.
  6. Give each selected session its own ledger row; otherwise show explicitly labeled aggregate.
  7. Static band; reduced motion identical. Canvas uses the same tray draw function.
  8. Keep bench inside the authored yard, outside walkway and visitor slots.
- **Cost:** M; <0.05 ms CPU/frame, <0.05 ms GPU; <16 KiB aggregate state, under 0.1 MiB optional cached tray image. Asset generation no.
- **Risk:** Token fields vary by provider and may reset; no savings/cost inference from cache count. Avoid duplicate existing percent cargo labels (L:427): this is counts-first inspection, not a second world percentage display. At 100 sessions store aggregate buckets and at most the selected breakdown, not 100 trays.
- **Wow 1–5 / Informative 1–5:** **4 / 5.** Wow: previously fleeting resources become tactile and comparable. Informative: exact cache/fresh-input provenance remains readable after motion ends.

### P4 — Task board as a rack of real plans

- **Pitch:** Preserve the excellent phase-aware slate, but give concurrent plan owners visible, selectable tabs on its wooden frame.
- **What the operator sees:** Three small vertical project-colored slate tabs occupy the frame edge, each bearing an owner token and `2/7`; selecting a tab reveals that session's existing phase plan. The frame says `+9 plans` when crowded, not nine more sheets.
- **Real data it renders:** `agent.id`, `agent.todos[].subject/status/phase`, `projectPath`, and the existing candidate preference/change timestamp (`TaskboardBoardModel.js:20–67,77–89,111–158`; B:4148–4150).
- **Files touched:** `TaskboardBoardModel.js:29–67,77–109` (list candidate summaries while preserving explicit selection precedence); B:3505–3508 (slate), B:433–447 (candidate preferences); V:71–87 (frame anchors).
- **Sketch:**
  1. Derive one compact plan summary per nondeparted agent with nonempty todos.
  2. Preserve selected/pinned ownership precedence; never rotate plans on a timer.
  3. Deduplicate identical team-shared plans only if a real shared identity exists.
  4. Draw at most three tabs plus exact overflow at detail zoom.
  5. Clicking a tab selects the corresponding agent using existing selection flow.
  6. Render the existing phase-aware slate unchanged for that chosen owner.
  7. Static band; no fluttering paper and no new particles.
  8. Reduced motion and Canvas have the same tabs and hit targets.
- **Cost:** M; event-driven O(agents + todos), <0.10 ms steady-frame CPU/GPU; <32 KiB summaries, optional 0.1 MiB atlas. Asset generation no.
- **Risk:** A task list is a session plan, not a verified project backlog. Never silently merge duplicate subjects across owners. At 100 agents exact overflow and stable ordering must prevent tab churn. Existing body text limitations mean this should be detail-only.
- **Wow 1–5 / Informative 1–5:** **3 / 5.** Wow: the board becomes a manipulable object rather than a billboard. Informative: solves the hidden concurrent-plan owner problem without replacing the shipped slate.

### P5 — Chronicle masonry you can actually read

- **Pitch:** Selecting a district monument opens a compact, physically attached chronological inscription, rather than planting more anonymous glowing stones.
- **What the operator sees:** The selected Forge monument exposes a low stone ledger with the last three real recorded milestones, dates and repository crest; its existing gem remains the anchor. `+14 recorded` is an exact count, not more masonry.
- **Real data it renders:** Persisted monument records `id`, `kind`, `label`, `project`, `plantedAt`; existing Chronicle hydration and planted records (`ChronicleMonuments.js:159–203`) and real milestone counts (:613–647). Labels originate from classified conventional commits/release refs (`MonumentRules.js:123–160`).
- **Files touched:** `ChronicleMonuments.js:159–203` (retained records and selection view); `MonumentRules.js:25,123–160` (retain cap/classification, no extra milestones); existing monument drawables; new small ledger drawable only if existing inscription geometry cannot fit it.
- **Sketch:**
  1. Reuse existing monument IDs and persistence; introduce no parallel history store.
  2. On selection, group actual retained records by project/district and chronological order.
  3. Expose three concise inscriptions plus exact available-record count.
  4. Mark the period covered; never call month-retained records all-time history.
  5. Keep the physical district cap of six and reuse an existing plinth footprint.
  6. Do not show raw commands or persist new transcript text.
  7. Static band, immediate reveal under reduced motion, identical Canvas fallback.
  8. Only selected stone expands; closing returns all secondary ink to silence.
- **Cost:** M; negligible idle work, <0.10 ms selected draw; <64 KiB derived rows and <0.2 MiB cached inscription surface. Asset generation optional: one shared low stone tablet, not a new monument roster.
- **Risk:** Existing labels may be clipped; reveal must stay within safe display policy. Conventional `perf:` is not measured performance improvement. At 100 agents history must be grouped by repository and existing IDs, never one monument per agent.
- **Wow 1–5 / Informative 1–5:** **4 / 4.** Wow: the town becomes a legible archaeological record. Informative: explains why a real monument exists instead of adding another milestone effect.

### P6 — Desire paths as an optional work-history lens

- **Pitch:** An explicit ground-history inspection turns real traversed routes into restrained worn cobble, not permanent glowing trails.
- **What the operator sees:** While inspecting the town's recent activity, three already-authored roads acquire sparse pale worn centers where observed crossings accumulated; selecting a worn segment shows `23 observed crossings · last hour`. Closing the lens restores ordinary terrain.
- **Real data it renders:** Existing trail samples `agentId`, `tileX`, `tileY`, `ts` (`TrailRenderer.js:279–299`). This is the visualization's rendered travel history, not the agent's filesystem activity or human travel.
- **Files touched:** `TrailRenderer.js:279–300` (sample-derived accumulator, not another sampler), `townPlan.js:44–99` (road mask), `SceneryEngine.js:29–49` (terrain metadata), `TerrainTileset.js:18–62` (existing tile grammar); ground semantic drawable seam documented in character-mode README:66.
- **Sketch:**
  1. Quantize existing samples to authored road segments; count transitions, not stationary samples.
  2. Maintain a 40×40 bounded count grid with bucketed expiry.
  3. Never fill missing movement with straight-line interpolation across buildings/water.
  4. Activate only by explicit history inspection; ordinary historical trails remain hidden.
  5. Replace a few cobble pixels with one of three authored wear levels inside the road mask.
  6. Cache only changed overlay chunks at <=1 Hz; do not rebake the whole terrain.
  7. Static band. Reduced motion uses the already accumulated snapshot, no new walkers.
  8. Canvas composites the same bounded wear mask beneath agents/buildings.
- **Cost:** M/L; <0.10 ms steady-frame draw, update target <0.25 ms at 100 sessions per sample tick; approximately 0.1 MiB counters plus capped <=1 MiB overlay. Asset generation no, manual stepped cobble accents.
- **Risk:** This intentionally avoids reversing the no-ambient-history decision (`TrailRenderer.js:351–355`). Sparse capture undercounts crossings; copy must say observed. At 100 sessions saturation cannot erase count distinctions; use selected numeric detail, not increasingly bright roads. It must not compete with selected routes.
- **Wow 1–5 / Informative 1–5:** **4 / 3.** Wow: the town physically remembers its traffic. Informative: helps explain which districts the observed sessions moved between, but is less useful than exact tool inspection.

### P7 — Occupied rooms, not uniformly glowing buildings

- **Pitch:** For Command and Archive, selected night inspection assigns a stable small window/desk light to each real working occupant.
- **What the operator sees:** Two warm room windows and one dark room read as two active workers, while an exact `2 working · 1 waiting` count sits on the selected building; leaving work extinguishes only the corresponding room. A waiting user is not represented as a failed light bulb.
- **Real data it renders:** Spatial visitor identities/statuses (B:4059–4062,4135–4145; L:612–629), actual `WORKING` state and existing night occupancy gate (B:362–377), not Director's aggregate errored bucket.
- **Files touched:** V:63–66 and 148–151 (semantic room slots distinct from lanterns), B:2005–2008 (warmth-window draw), B:4135–4145 (night gate); pair with P1's authored desks only if approved.
- **Sketch:**
  1. Author room-only slots for two pilot buildings; exclude Task lanterns, Mine mouth and Portal aperture.
  2. Keep agent-to-slot assignment stable while a visitor remains; never shuffle by status each frame.
  3. Draw actual WORKING occupancy as a static warm core, with exact overflow counts.
  4. Preserve building safety/ambient lights independently, so zero workers is not a blackout.
  5. Show the mapping on selection only; ordinary view retains a coarse night occupancy cue.
  6. Reuse night gate timing; do not add another pulsing cadence.
  7. Reduced motion snaps the state; static band otherwise.
  8. Canvas and GPU must share the same room mask/state, with nonemissive cores at low quality.
- **Cost:** M with existing slots, L with authored room revision; <0.05 ms CPU/GPU; <16 KiB mapping and <0.1 MiB room masks. Asset generation optional manual room apertures only.
- **Risk:** Existing art has fewer windows than building capacities, and some are not rooms. Literal one-window-per-agent must be capped and disclosed, not faked by dividing a count across arbitrary windows. At 100 agents counts, not 100 windows, carry overflow. No new lighting pipeline work is proposed.
- **Wow 1–5 / Informative 1–5:** **4 / 4.** Wow: a castle begins to feel inhabited at room scale. Informative: stable active-room occupancy communicates concurrency while preserving explicit counts.

### P8 — Between shifts: a truthful sleeping town

- **Pitch:** Healthy empty state becomes a deliberate architectural rest state, distinct from both active work and broken observation.
- **What the operator sees:** The Forge banks to a small ember behind its open mouth, the crane rests with no motion, the task slate displays a tiny empty rack rather than phantom papers, and Command's work rooms are dark while the gate's safety lantern stays visible. First actual work restores only the corresponding place. The town remains beautiful at noon without pretending to work.
- **Real data it renders:** Canonical `VillagePhase.READY_EMPTY`, not merely zero agent sprites; `READY_NO_PROVIDERS`, `DEGRADED` and live states already differ in `claudeville/src/application/VillageState.js:17–22,108–116`. `village:population` exists (B:539–543) but alone is insufficient to distinguish empty from blind.
- **Files touched:** B:2126–2273 and 3987–4019 (bank idle work effects); V:50–280 (work/ambient art classification); `HarborTraffic.js:161–197` (keep real pending ships even without agents); `VillageState.js:108–116` (consume existing canonical phase, do not rewrite reducer); optional Forge `banked.png` companion and manifest entry.
- **Sketch:**
  1. Consume healthy-empty phase through the existing application/presentation bridge.
  2. Separate functional activity from safety/architectural light; keep the latter restrained.
  3. Use a banked Forge mouth mask because orange fire is partly in the art, not just the emitter.
  4. Stop activity-only ambient emission when no live work/recent real ritual exists.
  5. Do not hide pending commits, real retained monuments, or known completed releases merely because agents departed.
  6. First real building activity swaps only its local state; no mass welcome fireworks.
  7. Static band, reduced motion immediate, same state images in Canvas and GPU.
  8. Keep existing healthy-empty copy; no new DOM card, tutorial tour, invented caretaker or mood.
- **Cost:** M; likely lower idle CPU/GPU cost; under 0.05 ms for state selection, <=0.3 MiB extra authored Forge mask. Asset generation yes only if existing orange mouth cannot be safely masked with a hand-authored stepped patch.
- **Risk:** Zero residents is not zero pending work. Healthy-empty and disconnected must never share reassuring rest semantics. At 100 agents this mode is inactive; work-to-empty transitions should wait for truthful canonical state, not arbitrary inactivity timers. Existing empty-tour/population behavior and shipped empty banner are not re-proposed (B:328–331,539–543; refinement plan:316).
- **Wow 1–5 / Informative 1–5:** **4 / 4.** Wow: restraint makes the first authentic spark meaningful. Informative: clearly differentiates ready-but-empty from busy and from failed observation.

### P9 — Bridge lanterns readable at noon

- **Pitch:** Extend existing age-ranked branch lanterns with a stepped physical age marker and selected project connection that still work in daylight.
- **What the operator sees:** The oldest pending branch's lantern has three small weathered timber notches, not merely a brighter halo; selecting it reveals `7 commits · oldest 9d` and briefly highlights its already-existing repo anchorage. Younger branches have fewer notches, while age remains exact in the inspection text.
- **Real data it renders:** `pendingRepoSummaries[].pendingCommits`, `oldestCommitTime`, `branch`, `repoName`, `profile.accent`; already derived and capped in `BridgeLanterns.js:74–105`. Matching repository home anchorage exists in `HarborTraffic.js:161–197,772–810`.
- **Files touched:** `BridgeLanterns.js:49–53,74–114` (same age tiers, static daylight body); `HarborTraffic.js:772–810` (read selected anchorage identity); existing hover/selection integration, no new traffic reducer.
- **Sketch:**
  1. Reuse the existing age cutoffs, oldest-first order and six-lantern cap.
  2. Draw one to four crisp timber notches beside the glass; no new hue vocabulary.
  3. Show exact count and oldest age on selection; include branch/repo label.
  4. Resolve the existing home anchorage from repository identity, not label matching.
  5. Give that buoy a static selected outline; no laser across the entire town.
  6. Preserve `overflowCount`; never silently omit the seventh branch.
  7. Static band; reduced motion identical; Canvas shares lantern body drawing.
  8. Retain night lights as optional atmosphere, not the only carrier of age.
- **Cost:** S/M; <0.03 ms CPU/GPU for six lanterns, <4 KiB state, no additional texture needed. Asset generation no.
- **Risk:** Age is not severity or an instruction to push; avoid alarm-red. Counts must not become notch counts without units. At 100 agents branch aggregation remains capped six with exact overflow. This is explicitly an extension of shipped lantern ranking, not new lanterns or new pending-commit ships.
- **Wow 1–5 / Informative 1–5:** **3 / 4.** Wow: subtle daylight craftsmanship replaces an invisible effect. Informative: links branch age to the physical fleet without adding a new ledger.

## Top three

1. **Open the workshop, not another panel.** This changes the fundamental relationship between the village metaphor and the instrument. Buildings stop being destinations in front of which sprites idle, and become selected, spatial explanations of current work. Command is the right pilot: its existing selected routes and tool labels provide grounded data, its architectural mass can support a section, and a single active interior bounds both authoring and rendering risk. Success should be judged at actual gameplay size, not a close-up contact sheet.

2. **A Mine assay bench with a readable memory.** Cache cargo is already an excellent idea, but 05 demonstrates how easily the meaning disappears outside the instant and location of the event. Retaining exact, provenance-aware input/cache counts in two physical trays transforms an attractive transient into an operator explanation. It has a high informative return with minimal asset work and no new emission pipeline.

3. **Between shifts: a truthful sleeping town.** The empty capture is not ugly; it is too continuously active-looking. Banked work structures make the quiet town a designed state, and make returning work more dramatic without increasing the effect budget. The canonical health phase is essential: a sleeping town must be earned by confirmed emptiness, never used to conceal an unreadable provider.

## Rejected

- **More repo flags on every building:** dominant-repo occupancy pennants already ship (B:1790–1828; V:69,87,152,170,220,240). Forge/Harbor lack configured pennant anchors, but filling every omission would be visual repetition, not frontier value.
- **Cache-colored Mine carts as a new feature:** already implemented (L:89–113,392–412; B:3025–3075). Improve inspectability, not duplicate it.
- **Ships for pending commits / larger hulls for larger fleets:** already shipped with exact pack counts and repo anchorages (`HarborTraffic.js:70–74,161–197,1563–1569`).
- **Cargo sized by changed lines:** no grounded additions/deletions/diff-stat field was found in the inspected domain, git identity or adapter event source. Commit count is not diff size. Do not silently substitute one for the other; add a verified data contract first if this becomes a requirement.
- **A flower per completed turn:** `tokens.turnCount` exists (`TokenUsage.js:20,32,82,105`), but this read did not establish cross-provider completed-turn semantics. It risks rewarding churn, adds clutter to already busy ground (06), and would duplicate existing milestone memory in a less useful form.
- **Another milestone monument system:** real git-based monuments, district cap and lifetime tiers already exist (`MonumentRules.js:25–32,123–160`). Read the stones instead.
- **Permanent ambient desire paths:** ordinary historical trails were intentionally hidden (`TrailRenderer.js:351–355`). P6 is an explicit optional lens with stepped wear, not a reversal that fills the map with history.
- **Calendar seasons as automatic terrain recoloring:** real calendar data is real but adds little operational understanding; northern/southern-hemisphere assumptions make it arbitrary. It also destabilizes the authored palette without answering a coding question.
- **A simulated tidal cycle:** local clock hour does not imply real tides; claiming it as real state would be false. Restrict any shoreline motion to existing real time/weather atmosphere, with no route/walkability changes. The flat shore could use art-direction work, but a fake tide is not the answer.
- **Generic smoke-rate enhancement:** presence, Forge heat, beacon and wind already modulate smoke (B:3987–4019). P2 must introduce an actual observed event count and replace competing signals, not merely turn the existing knobs up.
- **All buildings opening automatically under crowds:** a 100-agent field of cutaways destroys landmarks and creates implied physical occupancy. One explicit selection only.
- **Generated distant scenery / decorative harbor population:** no semantic value; 06 already has abundant scenery. More gulls, anonymous sailors, market customers or a caretaker would introduce invented life rather than evidence.

## Open questions for the coordinator

- The final 07/08 replacements verify selected-building detail framing, not proposed cutaway geometry, room readability or cargo motion; none was implemented. Initial fixture metadata still did not yield the declared close framing in retained 01/04/05, so use the corrected helper's explicit pose for implementation acceptance.
- Original helper hour diagnostics were null for 01–06. Final 07/08 verify hour 14 explicitly; the requested noon/14:00 states in 01–06 are visually daylight but not independently timestamp-asserted stills.
- Why does `PARADE V0.44` appear in both no-agents and git-harbor captures (06/02), while release-parade correctly shows `V0.12.0` (03)? It may be fixture or retained-history setup; I did not diagnose persistence. Avoid treating unrelated decorative-looking history as evidence of current work.
- How do tool invocation IDs and result certainty differ across providers? P2 should count observed calls until an explicitly verified completed-edit contract exists. A ritual finishing is not sufficient.
- Does the coordinator accept a selected architectural section despite the explicit historical roof-fade rejection (B:7)? The distinction matters: opaque alternate sectional art versus generalized alpha roof fade.
- P3 needs exact per-class availability, not only whole-token availability, to avoid a partially reported class appearing as zero. Current `cargoFromTokenBeat` gating is useful but not proof of every provider's class coverage (L:65–113).
- P5 needs a confirmed existing monument hit-test/selection interaction before adding another gesture. I read storage/classification and render structure, not the full input route for monument selection.
- Any subsequent implementation must judge the 100-agent and reduced-motion cases on the actual scene. This investigation proposes bounded behavior but did not capture those scenarios; its eight-image allowance was spent on the six requested cases plus explicit building-selection retries.
